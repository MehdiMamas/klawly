/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { CLAUDE_AGENT_ALLOW_EVERYTHING_CONFIRM_SETTING, CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, ClaudePermissionPreset, readClaudeAllowEverythingConfirm, readClaudePermissionPreset } from '../../../../platform/claude/common/claudeConfiguration.js';
import { PermissionChoice } from '../../../../platform/claude/common/claudeProtocol.js';
import { ClaudeSessionPermissions, isAllowEverythingLevel, sessionSwitchFor } from '../../../../platform/claude/common/claudeSessionPermissions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IClaudeAgentService } from './claudeAgentService.js';
import { PermissionEntry, permissionsForTimeline } from './claudeAgentState.js';

export const IClaudePermissionService = createDecorator<IClaudePermissionService>('claudePermissionService');

/**
 * What a permission card can answer. Besides the runtime choices, a shell card
 * offers Allow All Commands (Phase 27), which approves the request on screen and
 * turns on that session switch. Allow Everything is a permission level in
 * Settings, not a card choice (issue 453).
 */
export type ClaudePermissionCardChoice = PermissionChoice | 'allow-all-commands';

/**
 * The workbench side of the permission bridge. The host decides and asks; this
 * service carries the user's answer back and shows what was decided. It never
 * approves anything itself: a card that is not answered stays denied.
 */
export interface IClaudePermissionService {
	readonly _serviceBrand: undefined;

	/** Requests the host is waiting on for this pane session. */
	getPending(sessionId: string): readonly PermissionEntry[];
	/**
	 * Every permission decision in this pane session, oldest first: the cards the
	 * user answered, and the requests the host settled by policy or from a grant.
	 */
	getHistory(sessionId: string): readonly PermissionEntry[];
	/**
	 * Answers a pending request. Rejects when the request is not pending or the
	 * runtime session is gone, so a late click cannot approve something stale.
	 * `allow-all-commands` also turns on that switch.
	 */
	respond(sessionId: string, requestId: string, choice: ClaudePermissionCardChoice): Promise<void>;
	/** Allow All Commands and Allow Everything for a pane session, the permission level included. */
	getSessionPermissions(sessionId: string): ClaudeSessionPermissions;
	/**
	 * Turns Allow All Commands on or off for a pane session. Turning it on also
	 * approves the waiting command cards it covers. Rejects in an untrusted workspace.
	 */
	setAllowAllCommands(sessionId: string, on: boolean): Promise<void>;
	/** The permission level in Settings (`claude.agent.defaultPermissionMode`), for every session. */
	getPermissionLevel(): ClaudePermissionPreset;
}

export class ClaudePermissionService extends Disposable implements IClaudePermissionService {
	declare readonly _serviceBrand: undefined;

	/** The level before the last change, to go back to when the user cancels the warning. */
	private _level: ClaudePermissionPreset;
	private _warning = false;

	constructor(
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IDialogService private readonly _dialogs: IDialogService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IWorkspaceTrustManagementService private readonly _trust: IWorkspaceTrustManagementService,
	) {
		super();
		this._level = this.getPermissionLevel();
		this._register(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING) || event.affectsConfiguration(CLAUDE_AGENT_ALLOW_EVERYTHING_CONFIRM_SETTING)) {
				this.onDidChangeLevel().catch(onUnexpectedError);
			}
		}));
	}

	getHistory(sessionId: string): readonly PermissionEntry[] {
		// A subagent's requests live in its own chat, so they are read from there too.
		const state = this._agent.getViewState(sessionId);
		return state.turns.flatMap(turn => permissionsForTimeline(turn, state.subagents, undefined));
	}

	getPending(sessionId: string): readonly PermissionEntry[] {
		return this.getHistory(sessionId).filter(entry => entry.state === 'pending');
	}

	getSessionPermissions(sessionId: string): ClaudeSessionPermissions {
		return this._agent.getSessionPermissions(sessionId);
	}

	getPermissionLevel(): ClaudePermissionPreset {
		return readClaudePermissionPreset(this._configuration.getValue(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING));
	}

	async respond(sessionId: string, requestId: string, choice: ClaudePermissionCardChoice): Promise<void> {
		const entry = this.getPending(sessionId).find(candidate => candidate.id === requestId);
		if (!entry) {
			throw new Error(localize('claudePermissionNotPending', "That request was already answered or has ended."));
		}
		const runtimeId = this._agent.getRuntimeSessionId(sessionId);
		if (!runtimeId) {
			throw new Error(localize('claudePermissionNoSession', "The agent session has ended, so the request was denied."));
		}
		if (choice === 'allow-all-commands') {
			if (entry.workspaceTrusted === false) {
				// The card was asked while the workspace was untrusted, so it never offered a switch.
				this.requireTrust();
				throw new Error(localize('claudeSwitchAskedUntrusted', "This request was asked before this workspace was trusted. Answer it on its own."));
			}
			if (!entry.canAllowAllCommands) {
				throw new Error(localize('claudeAllowAllCommandsNotOffered', "Allow All Commands is only offered for a command in a trusted workspace."));
			}
			await this.setAllowAllCommands(sessionId, true);
			// The switch does not cover a destructive command, but the user approved this one.
			await this.allowIfPending(sessionId, requestId);
			return;
		}
		// A choice the request did not offer is only ever a single use.
		const allowed: PermissionChoice = !entry.canRemember && (choice === 'allow-session' || choice === 'allow-workspace') ? 'allow-once' : choice;
		await this._runtime.resolvePermission(runtimeId, requestId, allowed);
	}

	async setAllowAllCommands(sessionId: string, on: boolean): Promise<void> {
		if (on) {
			this.requireTrust();
		}
		// Allow Everything comes from the level now, so the session keeps only its own switch.
		this._agent.setSessionPermissions(sessionId, { allowAllCommands: on, allowEverything: false });
		if (on) {
			await this.approveCovered(sessionId);
		}
	}

	/**
	 * The level changed in Settings, the mode menu or settings.json. The first
	 * time it becomes one of the Allow Everything levels, one warning says what
	 * that means; cancelling puts the previous level back. Until the user
	 * confirms, the agent service holds the level back to Ask Before Edits.
	 * Then the cards already waiting that the new level covers are approved.
	 */
	private async onDidChangeLevel(): Promise<void> {
		if (this._warning) {
			// Confirming the warning writes a setting too. The change that showed it finishes the job.
			return;
		}
		const level = this.getPermissionLevel();
		const previous = this._level;
		this._level = level;
		if (isAllowEverythingLevel(level) && readClaudeAllowEverythingConfirm(this._configuration.getValue(CLAUDE_AGENT_ALLOW_EVERYTHING_CONFIRM_SETTING))) {
			this._warning = true;
			let confirmed: boolean;
			try {
				confirmed = await this.warnAllowEverything(level);
			} finally {
				this._warning = false;
			}
			if (!confirmed) {
				if (this.getPermissionLevel() === level) {
					await this._configuration.updateValue(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, isAllowEverythingLevel(previous) ? 'prompt' : previous, ConfigurationTarget.USER);
				}
				return;
			}
		}
		for (const session of this._agent.getSessions()) {
			await this.approveCovered(session.id);
		}
	}

	/** The one-time warning. Confirming it sets `claude.agent.allowEverythingConfirm` to false for good. */
	private async warnAllowEverything(level: ClaudePermissionPreset): Promise<boolean> {
		const credentials = level === 'allowEverything';
		const answer = await this._dialogs.confirm({
			type: 'warning',
			message: credentials
				? localize('claudeAllowEverythingWarnTitle', "Allow everything in every chat?")
				: localize('claudeAllowEverythingExceptWarnTitle', "Allow everything except credentials in every chat?"),
			detail: credentials
				? localize('claudeAllowEverythingWarnDetail', "In Agent mode, Claude Code will run in bypass permissions mode: every tool call in every chat runs without asking and without any check, including commands that delete data, wipe folders or rewrite git history, network access, MCP tools, writes outside the workspace, and reading or changing credential files such as .env and ~/.ssh. Klawly's refuse rules do not apply. Plan and Ask keep their file limits, untrusted workspaces still ask, and checkpoints still let you undo file changes. You will not see this warning again.")
				: localize('claudeAllowEverythingExceptWarnDetail', "Claude will run every tool call in every chat without asking: any command, including ones that delete data, wipe folders or rewrite git history, network access, MCP tools, and writes anywhere on disk. Credential files such as .env and ~/.ssh still ask. Plan and Ask keep their file limits, settings that refuse still refuse, and untrusted workspaces still ask. You will not see this warning again."),
			primaryButton: credentials
				? localize({ key: 'claudeAllowEverythingWarnButton', comment: ['&& denotes a mnemonic'] }, "&&Allow Everything")
				: localize({ key: 'claudeAllowEverythingExceptWarnButton', comment: ['&& denotes a mnemonic'] }, "&&Allow Everything Except Credentials"),
		});
		if (!answer.confirmed) {
			return false;
		}
		await this._configuration.updateValue(CLAUDE_AGENT_ALLOW_EVERYTHING_CONFIRM_SETTING, false, ConfigurationTarget.USER);
		return true;
	}

	private requireTrust(): void {
		if (!this._trust.isWorkspaceTrusted()) {
			throw new Error(localize('claudeSwitchUntrusted', "Trust this workspace first. Allow All Commands and Allow Everything are not available in an untrusted workspace."));
		}
	}

	private async allowIfPending(sessionId: string, requestId: string): Promise<void> {
		const runtimeId = this._agent.getRuntimeSessionId(sessionId);
		if (runtimeId && this.getPending(sessionId).some(candidate => candidate.id === requestId)) {
			await this._runtime.resolvePermission(runtimeId, requestId, 'allow-once');
		}
	}

	/**
	 * Cards already on screen asked before the switch turned on. Approve the
	 * ones it covers, with the same rails the host applies to later requests.
	 */
	private async approveCovered(sessionId: string): Promise<void> {
		const runtimeId = this._agent.getRuntimeSessionId(sessionId);
		if (!runtimeId) {
			return;
		}
		const permissions = this.getSessionPermissions(sessionId);
		const trusted = this._trust.isWorkspaceTrusted();
		for (const entry of this.getPending(sessionId)) {
			if (entry.workspaceTrusted !== false && sessionSwitchFor(entry, permissions, trusted)) {
				await this._runtime.resolvePermission(runtimeId, entry.id, 'allow-once');
			}
		}
	}
}
