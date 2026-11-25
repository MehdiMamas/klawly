/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getActiveElement, isHTMLButtonElement } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { relativePath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { describePermissionPrompt, PermissionEntry } from '../../../../services/claude/common/claudeAgentState.js';
import { redactSecrets } from '../../../../services/claude/common/claudeAgentLog.js';
import { ClaudePermissionCardChoice } from '../../../../services/claude/common/claudePermissionService.js';
import { CLAUDE_OPEN_SETTINGS_COMMAND_ID } from '../../common/claudeViews.js';
import { describeMode } from './claudeModes.js';
import '../media/claudePermissions.css';

/** Sends the user's answer for one card. Rejects when the request has ended. */
export type ClaudePermissionResponder = (requestId: string, choice: ClaudePermissionCardChoice) => Promise<void>;

/**
 * Permission cards, their one-line records, and the blocked-by-policy banner
 * (Phase 27 redesign). A pending card shows the tool, the exact command or
 * path, and one line on why it asks. Buttons, in order: Allow Once (primary),
 * Allow for Session, Allow All Commands (shell only), Deny, then a link to the
 * permission level in Settings. Keys: Enter allows once, Alt+A allows all commands, Escape
 * denies, and Tab stays inside the card.
 */
export class ClaudePermissionCards {

	constructor(
		@IHoverService private readonly _hover: IHoverService,
		@INotificationService private readonly _notifications: INotificationService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@ICommandService private readonly _commands: ICommandService,
	) { }

	/** Paints a pending card. Returns the function that focuses its starting control. */
	renderCard(parent: HTMLElement, entry: PermissionEntry, store: DisposableStore, respond: ClaudePermissionResponder): () => void {
		const danger = entry.risk === 'destructive' || entry.risk === 'credentials';
		const title = describePermissionPrompt(entry);
		const card = append(parent, $('.claude-permission' + (danger ? '.is-danger' : '')));
		card.setAttribute('role', 'alertdialog');
		card.setAttribute('aria-label', localize('claudePermissionLabel', "Permission required: {0}", title));
		card.tabIndex = -1;
		const subjectId = `claude-permission-${entry.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
		const whyId = `${subjectId}-why`;
		card.setAttribute('aria-describedby', `${subjectId} ${whyId}`);

		const head = append(card, $('.claude-permission-head'));
		append(head, $(ThemeIcon.asCSSSelector(danger ? Codicon.warning : Codicon.shield)));
		append(head, $('span.claude-permission-title')).textContent = title;
		if (entry.category !== 'shell') {
			// A command card's title already says it runs a command.
			const tool = append(head, $('span.claude-permission-tool'));
			tool.textContent = entry.toolName;
			tool.setAttribute('aria-label', localize('claudePermissionToolLabel', "Tool: {0}", entry.toolName));
		}

		// The exact command or absolute path, never a summary of it.
		const subject = append(card, $('.claude-permission-cmd'));
		subject.id = subjectId;
		subject.textContent = entry.command ?? entry.targetPath ?? entry.toolName;

		const why = append(card, $('.claude-permission-why'));
		why.id = whyId;
		why.textContent = permissionWhyLine(entry);

		const meta = append(card, $<HTMLDListElement>('dl.claude-permission-meta'));
		const row = (label: string, value: string | undefined, full?: string) => {
			if (value) {
				append(meta, $('dt')).textContent = label;
				const cell = append(meta, $('dd'));
				cell.textContent = value;
				if (full && full !== value) {
					cell.setAttribute('aria-label', full);
					store.add(this._hover.setupDelayedHover(cell, { content: full }));
				}
			}
		};
		row(localize('claudePermissionDirectory', "Directory"), entry.cwd === undefined ? undefined : this.workspaceRelative(entry.cwd), entry.cwd);
		row(localize('claudePermissionTarget', "Target"), entry.command !== undefined ? entry.targetPath : undefined);
		row(localize('claudePermissionReason', "Reason"), entry.reason);
		if (!meta.firstChild) {
			meta.remove();
		}

		const answer = (choice: ClaudePermissionCardChoice) => this.answer(card, entry.id, choice, respond);
		const actions = append(card, $('.claude-permission-actions'));
		const button = (className: string, label: string, choice: ClaudePermissionCardChoice, keys?: readonly string[], ariaKeys?: string): HTMLButtonElement => {
			const element = append(actions, $<HTMLButtonElement>('button.claude-btn' + className));
			element.type = 'button';
			element.dataset.choice = choice;
			append(element, $('span.label')).textContent = label;
			if (keys) {
				const hint = append(element, $('span.claude-kbd'));
				hint.setAttribute('aria-hidden', 'true');
				for (const key of keys) {
					append(hint, $('kbd')).textContent = key;
				}
			}
			if (ariaKeys) {
				element.setAttribute('aria-keyshortcuts', ariaKeys);
			}
			store.add(addDisposableListener(element, EventType.CLICK, () => answer(choice)));
			return element;
		};
		// allow-any-unicode-next-line
		const allowOnce = button(danger ? '.is-danger' : '.is-primary', localize('claudeAllowOnce', "Allow Once"), 'allow-once', danger ? undefined : ['↵'], danger ? undefined : 'Enter');
		if (entry.canRemember) {
			button('.is-secondary', localize('claudeAllowSession', "Allow for Session"), 'allow-session');
		}
		if (entry.canAllowAllCommands) {
			const all = button('.is-secondary.claude-permission-all', localize('claudeAllowAllCommands', "Allow All Commands"), 'allow-all-commands', [localize('claudeAltKey', "Alt"), 'A'], 'Alt+A');
			store.add(this._hover.setupDelayedHover(all, {
				content: danger
					? localize('claudeAllowAllCommandsDangerHover', "Run this command once, then run later commands in this session without asking (Alt+A). Later commands that can delete data or rewrite history still ask unless Allow Everything is on. Commands that touch credentials always ask.")
					: localize('claudeAllowAllCommandsHover', "Run this command and every later command in this session without asking (Alt+A). Commands that can delete data or rewrite history still ask unless Allow Everything is on. Commands that touch credentials always ask."),
			}));
		}
		const deny = button(danger ? '.is-primary' : '.is-ghost', localize('claudeDeny', "Deny"), 'deny', ['esc'], 'Escape');

		// Permission levels live in Settings and apply to every chat (issue 453).
		const footer = append(card, $('.claude-permission-footer'));
		const hint = append(footer, $('span.claude-permission-hint'));
		hint.textContent = localize('claudePermissionLevelHint', "Tired of approving?");
		const level = append(footer, $<HTMLButtonElement>('button.claude-permission-level'));
		level.type = 'button';
		append(level, $(ThemeIcon.asCSSSelector(Codicon.settingsGear)));
		append(level, $('span.label')).textContent = localize('claudePermissionLevelLink', "Change your permission level in Settings");
		store.add(addDisposableListener(level, EventType.CLICK, () => {
			this._commands.executeCommand(CLAUDE_OPEN_SETTINGS_COMMAND_ID, 'agents').catch(error => this._notifications.error(redactSecrets(error instanceof Error ? error.message : String(error))));
		}));

		store.add(addDisposableListener(card, EventType.KEY_DOWN, event => {
			if (event.key === 'Tab') {
				// Keep keyboard focus inside the card while the agent waits on it.
				// eslint-disable-next-line no-restricted-syntax
				const enabled = Array.from(card.querySelectorAll('button')).filter(element => !element.disabled);
				const current = enabled.indexOf(getActiveElement() as HTMLButtonElement);
				if (enabled.length > 0 && (event.shiftKey ? current <= 0 : current === enabled.length - 1)) {
					event.preventDefault();
					enabled[event.shiftKey ? enabled.length - 1 : 0].focus();
				}
			} else if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				answer('deny');
			} else if (event.altKey && !event.ctrlKey && !event.metaKey && (event.code === 'KeyA' || event.key.toLowerCase() === 'a')) {
				if (entry.canAllowAllCommands) {
					event.preventDefault();
					event.stopPropagation();
					answer('allow-all-commands');
				}
			} else if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !danger) {
				// Enter on another button runs that button. Anywhere else in the card it allows once.
				const target = event.target;
				const onOtherButton = isHTMLButtonElement(target) && target !== allowOnce;
				if (!onOtherButton || event.ctrlKey || event.metaKey) {
					event.preventDefault();
					event.stopPropagation();
					answer('allow-once');
				}
			}
		}));
		// A risky action starts on Deny, so a stray Enter cannot approve it.
		return () => (danger ? deny : allowOnce).focus();
	}

	/**
	 * A request the policy refused: no prompt, just a record. A file write that
	 * Plan or Ask refused offers Switch to Agent and Retry when `retry` is given.
	 */
	renderBlocked(parent: HTMLElement, entry: PermissionEntry, store: DisposableStore, retry?: () => Promise<void>): void {
		const banner = append(parent, $('.claude-banner.is-info'));
		append(banner, $(ThemeIcon.asCSSSelector(Codicon.lock)));
		const body = append(banner, $('.body'));
		append(body, $('.title')).textContent = entry.blockedByMode
			? localize('claudePermissionBlockedByMode', "{0} blocked: {1} mode does not change this file", entry.toolName, describeMode(entry.blockedByMode).label)
			: localize('claudePermissionBlocked', "{0} blocked", entry.toolName);
		const detail = entry.message ?? entry.subject;
		if (detail) {
			append(body, $('.desc')).textContent = detail;
		}
		if (entry.blockedByMode && retry) {
			const actions = append(body, $('.actions'));
			const button = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.claude-switch-retry'));
			button.type = 'button';
			button.textContent = localize('claudeSwitchToAgentRetry', "Switch to Agent and Retry");
			store.add(addDisposableListener(button, EventType.CLICK, () => {
				button.disabled = true;
				retry().catch(error => {
					button.disabled = false;
					this._notifications.error(redactSecrets(error instanceof Error ? error.message : String(error)));
				});
			}));
		}
	}

	/**
	 * Calls that an earlier Allow for Session, Allow All Commands or Allow
	 * Everything let through, as one quiet collapsed line for the whole turn.
	 */
	renderAutoApproved(parent: HTMLElement, entries: readonly PermissionEntry[]): void {
		if (entries.length === 0) {
			return;
		}
		const details = append(parent, $<HTMLDetailsElement>('details.claude-permission-auto'));
		const summary = append(details, $('summary'));
		append(summary, $(ThemeIcon.asCSSSelector(Codicon.passFilled)));
		append(summary, $('span')).textContent = entries.length === 1
			? localize('claudeAutoApprovedOne', "1 call ran without asking")
			: localize('claudeAutoApprovedMany', "{0} calls ran without asking", entries.length);
		const list = append(details, $('ul'));
		for (const entry of entries) {
			const item = append(list, $('li'));
			append(item, $('span.subject')).textContent = entry.command ?? entry.targetPath ?? entry.subject ?? entry.toolName;
			append(item, $('span.outcome')).textContent = describePermissionOutcome(entry);
		}
	}

	/** A path inside a workspace folder as a relative path, or the folder name for the folder itself. */
	private workspaceRelative(path: string): string {
		const uri = URI.file(path);
		const folder = this._workspace.getWorkspaceFolder(uri);
		if (!folder) {
			return path;
		}
		const relative = relativePath(folder.uri, uri);
		if (!relative) {
			return folder.name;
		}
		return this._workspace.getWorkspace().folders.length > 1 ? `${folder.name}/${relative}` : relative;
	}

	/** A settled request as one line. */
	renderRecord(parent: HTMLElement, entry: PermissionEntry): void {
		const allowed = entry.state === 'allowed';
		const record = append(parent, $('.claude-permission-record'));
		append(record, $(ThemeIcon.asCSSSelector(allowed ? Codicon.pass : Codicon.circleSlash) + (allowed ? '.is-allowed' : '.is-denied')));
		append(record, $('span.subject')).textContent = entry.command ?? entry.targetPath ?? entry.subject ?? entry.toolName;
		append(record, $('span.outcome')).textContent = describePermissionOutcome(entry);
	}

	private answer(card: HTMLElement, requestId: string, choice: ClaudePermissionCardChoice, respond: ClaudePermissionResponder): void {
		// eslint-disable-next-line no-restricted-syntax
		const buttons = [...card.querySelectorAll('button')].filter(element => !element.disabled);
		if (buttons.length === 0) {
			return;
		}
		buttons.forEach(element => element.disabled = true);
		const enable = () => buttons.forEach(element => element.disabled = false);
		respond(requestId, choice).then(undefined, error => {
			enable();
			this._notifications.error(redactSecrets(error instanceof Error ? error.message : String(error)));
		});
	}
}

/** True for a call that ran because of an earlier approval or a session switch, without a card. */
export function isAutoApproved(entry: PermissionEntry): boolean {
	return entry.state === 'allowed' && (entry.source === 'grant' || entry.source === 'allow-all-commands' || entry.source === 'allow-everything' || entry.source === 'auto');
}

/** The one short line under the command or path that says why the card asks. */
export function permissionWhyLine(entry: PermissionEntry): string {
	if (entry.workspaceTrusted === false) {
		return localize('claudeWhyUntrusted', "This workspace is not trusted, so every change asks once.");
	}
	const plainCommand = entry.category === 'shell' && (entry.risk === 'mutating' || entry.risk === 'network' || entry.risk === 'safe') && !entry.outsideWorkspace;
	if (plainCommand && entry.mode) {
		return localize('claudeWhyCommandMode', "Commands ask in {0} mode.", describeMode(entry.mode).label);
	}
	if (entry.category === 'mcp' && entry.mode) {
		return localize('claudeWhyMcpMode', "MCP tools ask in {0} mode.", describeMode(entry.mode).label);
	}
	if (entry.category === 'web' && entry.mode) {
		return localize('claudeWhyWebMode', "Web access asks in {0} mode.", describeMode(entry.mode).label);
	}
	return entry.why ?? localize('claudeWhyDefault', "The IDE asks before this action runs.");
}

/** The outcome text of a settled request's record. */
export function describePermissionOutcome(entry: PermissionEntry): string {
	if (entry.state === 'allowed') {
		switch (entry.source) {
			case 'grant': return localize('claudePermissionAllowedGrant', "allowed by earlier approval");
			case 'allow-all-commands': return localize('claudePermissionAllowedAllCommands', "allowed by Allow All Commands");
			case 'allow-everything': return localize('claudePermissionAllowedEverything', "allowed by Allow Everything");
			case 'auto': return localize('claudePermissionAllowedAuto', "allowed by Auto");
		}
		switch (entry.scope) {
			case 'session': return localize('claudePermissionAllowedSession', "allowed for session");
			case 'workspace': return localize('claudePermissionAllowedWorkspace', "allowed for workspace");
			default: return localize('claudePermissionAllowedOnce', "allowed once");
		}
	}
	return entry.source === 'session-stopped'
		? localize('claudePermissionDeniedStopped', "denied, session stopped")
		: localize('claudePermissionDenied', "denied");
}
