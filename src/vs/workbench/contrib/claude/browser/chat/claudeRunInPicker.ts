/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { CLAUDE_CLOUD_START_COMMAND_ID, ClaudeRunTarget } from '../../../../../platform/claude/common/claudeCloud.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ClaudeExecutionTarget, ClaudeExecutionTargetKind, claudeExecutionTargetInfo, isClaudeRemotePath, isClaudeSshHost, LOCAL_CLAUDE_EXECUTION_TARGET, readClaudeExecutionTarget } from '../../../../../platform/claude/common/claudeExecutionTarget.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceTrustRequestService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { ClaudeAgentSession, IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudeCloudSessionsService } from '../claudeCloudSessions.js';

/** The workspace's last Run in choice, so the next new agent starts there too. */
const RUN_IN_STORAGE_KEY = 'klawly.agent.runIn';
/** SSH hosts picked in this workspace, newest first. */
const RUN_IN_HOSTS_STORAGE_KEY = 'klawly.agent.runIn.sshHosts';
const RECENT_HOST_LIMIT = 5;

interface RunInItem extends IQuickPickItem {
	readonly target?: ClaudeExecutionTarget;
	readonly addHost?: true;
	/** Starts a Claude Code cloud session instead of setting a target (issue 516). */
	readonly cloud?: true;
	/** Why Cloud cannot start here; the row shows it and does nothing when picked (issue 532). */
	readonly unavailable?: string;
}

/** The icon for a target, in the pill and in the picker. */
export function claudeExecutionTargetIcon(kind: ClaudeExecutionTargetKind): ThemeIcon {
	switch (kind) {
		case 'worktree':
			return Codicon.worktree;
		case 'devcontainer':
			return Codicon.package;
		case 'ssh':
			return Codicon.remote;
		default:
			return Codicon.deviceDesktop;
	}
}

/** The icon for where an agent runs (issue 532): the cloud variant for a Claude Code cloud session. */
export function claudeRunTargetIcon(target: ClaudeRunTarget): ThemeIcon {
	return target === 'cloud' ? Codicon.cloud : Codicon.deviceDesktop;
}

/** Two targets that run Claude Code in the same place. */
function sameTarget(a: ClaudeExecutionTarget, b: ClaudeExecutionTarget): boolean {
	if (a.kind === 'ssh' && b.kind === 'ssh') {
		return a.host === b.host && (a.remotePath ?? '') === (b.remotePath ?? '');
	}
	return a.kind === b.kind;
}

/**
 * The Run in pill in the composer toolbar (issue 425): where a new agent's
 * Claude Code runs. It opens a quick pick (DL-21) of Local, New Worktree, Dev
 * Container, Cloud (issue 516: starts a Claude Code cloud session; issue 532:
 * disabled with its reason when Claude Code cannot) and SSH hosts. The choice is remembered per workspace and applied
 * to each new agent; once Claude Code has a conversation, the pill shows where
 * it runs and is locked.
 */
export class ClaudeRunInPicker extends Disposable {

	private readonly _button: HTMLButtonElement;
	private readonly _icon: HTMLElement;
	private readonly _label: HTMLElement;
	private _session: ClaudeAgentSession | undefined;
	/** Sessions the remembered target was already offered to, so a choice of Local is not overwritten. */
	private readonly _seeded = new Set<string>();

	constructor(
		toolbar: HTMLElement,
		private readonly _report: (error: unknown) => void,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@IStorageService private readonly _storage: IStorageService,
		@IWorkspaceTrustRequestService private readonly _trust: IWorkspaceTrustRequestService,
		@IHoverService hovers: IHoverService,
		@ICommandService private readonly _commands: ICommandService,
		@IClaudeCloudSessionsService private readonly _cloudSessions: IClaudeCloudSessionsService,
	) {
		super();
		this._button = append(toolbar, $<HTMLButtonElement>('button.claude-pill.is-quiet.claude-run-in-pill'));
		this._button.type = 'button';
		this._icon = append(this._button, $('span'));
		this._label = append(this._button, $('span.label'));
		this._register(addDisposableListener(this._button, EventType.CLICK, () => void this.pick()));
		this._register(hovers.setupDelayedHover(this._button, () => ({ content: this.hoverText(), additionalClasses: ['claude-root'] })));
		this.render();
	}

	/** Follows the composer's current session; a new one starts where the workspace last ran agents. */
	update(session: ClaudeAgentSession | undefined): void {
		this._session = session;
		if (session && !this._seeded.has(session.id)) {
			this._seeded.add(session.id);
			const remembered = this.remembered();
			if (this.canChange(session) && !session.executionTarget && remembered.kind !== 'local') {
				try {
					this._agent.setExecutionTarget(session.id, remembered);
					return; // The service fires a change that renders.
				} catch {
					// The session started meanwhile; it stays where it is.
				}
			}
		}
		this.render();
	}

	private canChange(session: ClaudeAgentSession): boolean {
		return !session.claudeSessionId && this._agent.getViewState(session.id).turns.at(-1)?.status !== 'running';
	}

	/** Where the session runs: what Claude Code reported, else the pick for its first turn. */
	private current(): { readonly kind: ClaudeExecutionTargetKind; readonly label: string } {
		const session = this._session;
		if (session?.targetInfo) {
			return session.targetInfo;
		}
		if (session?.claudeSessionId) {
			return claudeExecutionTargetInfo(LOCAL_CLAUDE_EXECUTION_TARGET);
		}
		return claudeExecutionTargetInfo(session?.executionTarget ?? LOCAL_CLAUDE_EXECUTION_TARGET);
	}

	private render(): void {
		const current = this.current();
		this._icon.className = ThemeIcon.asClassName(claudeExecutionTargetIcon(current.kind));
		this._label.textContent = current.label;
		const locked = !!this._session && !this.canChange(this._session);
		this._button.disabled = locked;
		this._button.setAttribute('aria-label', localize('claudeRunInLabel', "Run In: {0}", current.label));
	}

	private hoverText(): string {
		const current = this.current();
		if (this._session && !this.canChange(this._session)) {
			return localize('claudeRunInLocked', "Claude Code runs in {0} for this agent. Start a new agent to run it somewhere else.", current.label);
		}
		return localize('claudeRunInHover', "Where Claude Code runs this agent: {0}", current.label);
	}

	private remembered(): ClaudeExecutionTarget {
		return this.readStored(RUN_IN_STORAGE_KEY) ?? LOCAL_CLAUDE_EXECUTION_TARGET;
	}

	private readStored(key: string): ClaudeExecutionTarget | undefined {
		try {
			return readClaudeExecutionTarget(JSON.parse(this._storage.get(key, StorageScope.WORKSPACE, 'null')));
		} catch {
			return undefined;
		}
	}

	private recentHosts(): Extract<ClaudeExecutionTarget, { kind: 'ssh' }>[] {
		let stored: unknown;
		try {
			stored = JSON.parse(this._storage.get(RUN_IN_HOSTS_STORAGE_KEY, StorageScope.WORKSPACE, '[]'));
		} catch {
			return [];
		}
		const hosts: Extract<ClaudeExecutionTarget, { kind: 'ssh' }>[] = [];
		for (const value of Array.isArray(stored) ? stored : []) {
			const target = readClaudeExecutionTarget(value);
			if (target?.kind === 'ssh') {
				hosts.push(target);
			}
		}
		return hosts.slice(0, RECENT_HOST_LIMIT);
	}

	private async pick(): Promise<void> {
		const session = this._session;
		if (!session || !this.canChange(session)) {
			return;
		}
		const items = await this.items(session.executionTarget ?? LOCAL_CLAUDE_EXECUTION_TARGET);
		const chosen = await this._quickInput.pick(items, {
			placeHolder: localize('claudeRunInPlaceholder', "Where should Claude Code run this agent?"),
			activeItem: items.find((item): item is RunInItem => item.type !== 'separator' && !!(item as RunInItem).picked),
		});
		if (!chosen || chosen.unavailable) {
			return;
		}
		if (chosen.cloud) {
			// Claude Code runs a cloud session itself; this agent's target stays as it is.
			await this._commands.executeCommand(CLAUDE_CLOUD_START_COMMAND_ID);
			return;
		}
		const target = chosen.addHost ? await this.askHost() : chosen.target;
		if (!target) {
			return;
		}
		// Building a dev container runs the workspace's own configuration: ask for Workspace Trust first.
		if (target.kind === 'devcontainer' && !await this._trust.requestWorkspaceTrust({ message: localize('claudeRunInTrust', "Klawly builds the dev container from this workspace's .devcontainer configuration, which can run commands on this machine. Trust the workspace to run agents in it.") })) {
			return;
		}
		try {
			this._agent.setExecutionTarget(session.id, target);
		} catch (error) {
			this._report(error);
			return;
		}
		this._storage.store(RUN_IN_STORAGE_KEY, JSON.stringify(target), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		if (target.kind === 'ssh') {
			const hosts = [target, ...this.recentHosts().filter(host => !sameTarget(host, target))].slice(0, RECENT_HOST_LIMIT);
			this._storage.store(RUN_IN_HOSTS_STORAGE_KEY, JSON.stringify(hosts), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
	}

	/**
	 * The targets, Local first. Cloud is disabled with its reason when this
	 * Claude Code or its sign-in cannot start cloud sessions (issue 532), so the
	 * reason shows before a click instead of an error after it.
	 */
	private async items(selected: ClaudeExecutionTarget): Promise<(RunInItem | IQuickPickSeparator)[]> {
		// DL-14: Cloud stays listed when this Claude Code cannot run it, and its description says why (issue 532).
		const unavailable = await this._cloudSessions.unavailableReason();
		const row = (target: ClaudeExecutionTarget, description: string): RunInItem => ({
			target,
			label: claudeExecutionTargetInfo(target).label,
			description,
			iconClass: ThemeIcon.asClassName(claudeExecutionTargetIcon(target.kind)),
			picked: sameTarget(target, selected),
		});
		const items: (RunInItem | IQuickPickSeparator)[] = [
			row(LOCAL_CLAUDE_EXECUTION_TARGET, localize('claudeRunInLocalDetail', "this machine, in the workspace folder")),
			row({ kind: 'worktree' }, localize('claudeRunInWorktreeDetail', "a background agent on its own branch")),
			row({ kind: 'devcontainer' }, localize('claudeRunInDevContainerDetail', ".devcontainer/devcontainer.json, built with Docker")),
			{
				cloud: true,
				unavailable,
				label: localize('claudeRunInCloud', "Cloud..."),
				description: unavailable ?? localize('claudeRunInCloudDetail', "Claude Code's cloud session on your Claude account; keeps going when Klawly closes"),
				iconClass: ThemeIcon.asClassName(claudeRunTargetIcon('cloud')),
				pickable: !unavailable,
			},
			{ type: 'separator', label: localize('claudeRunInSshHosts', "ssh hosts") },
			...this.recentHosts().map(host => row(host, host.remotePath ?? '~')),
			{
				addHost: true,
				label: localize('claudeRunInAddHost', "SSH Host..."),
				description: localize('claudeRunInAddHostDetail', "a host from your SSH config; Claude Code must be installed and logged in there"),
				iconClass: ThemeIcon.asClassName(Codicon.add),
			},
		];
		return items;
	}

	/** Asks for a host from the user's SSH config, then for the project folder on it. */
	private async askHost(): Promise<ClaudeExecutionTarget | undefined> {
		const host = (await this._quickInput.input({
			prompt: localize('claudeRunInHostPrompt', "A host from your SSH config, or user@host. Klawly runs ssh with your own config and keys."),
			placeHolder: localize('claudeRunInHostPlaceholder', "build-box"),
			validateInput: async value => value.trim() && !isClaudeSshHost(value.trim()) ? localize('claudeRunInHostInvalid', "Use a host alias or user@host, without spaces.") : undefined,
		}))?.trim();
		if (!host) {
			return undefined;
		}
		const folder = await this._quickInput.input({
			prompt: localize('claudeRunInFolderPrompt', "The project folder on {0}. Leave it empty to start in the home folder.", host),
			placeHolder: localize('claudeRunInFolderPlaceholder', "~/src/project"),
			validateInput: async value => value.trim() && !isClaudeRemotePath(value.trim()) ? localize('claudeRunInFolderInvalid', "Use an absolute path or one under ~.") : undefined,
		});
		if (folder === undefined) {
			return undefined;
		}
		return readClaudeExecutionTarget({ kind: 'ssh', host, remotePath: folder.trim() });
	}
}
