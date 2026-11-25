/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudePermissionPreset } from './claudeConfiguration.js';
import { AgentMode } from './claudeContext.js';
import { CommandRisk, ToolCategory } from './claudeProtocol.js';

/**
 * The per-session switches the user turns on from a permission card or the
 * mode menu (Phase 27). They live only as long as the session and are never
 * written to disk, so a restart always starts with both off.
 */
export interface ClaudeSessionPermissions {
	/**
	 * Allow All Commands: shell commands run without a card. Destructive
	 * commands still ask unless Allow Everything is on too.
	 */
	readonly allowAllCommands: boolean;
	/**
	 * Allow Everything: every tool call the host would ask about is approved,
	 * destructive commands, network, MCP and writes outside the workspace included.
	 */
	readonly allowEverything: boolean;
	/**
	 * With Allow Everything, credential files and commands that touch
	 * credentials are approved too (the Allow Everything level, issue 453).
	 * Without it, they still ask.
	 */
	readonly allowCredentials?: boolean;
	/**
	 * The Auto level (issue 510): a request that would ask goes to the classifier
	 * first, and runs without a card when it says allow. See `claudeAutoReviewApplies`
	 * for what always keeps its card.
	 */
	readonly autoReview?: boolean;
	/**
	 * The confirmed Allow Everything level runs Claude Code without its own
	 * permission checks in Agent mode (issue 694). Only `withClaudePermissionLevel`
	 * sets it, and only for that level; see `claudeRunsUnasked` for when it applies.
	 */
	readonly unasked?: boolean;
}

export const NO_SESSION_PERMISSIONS: ClaudeSessionPermissions = Object.freeze({ allowAllCommands: false, allowEverything: false });

/** Which switch approved a request. */
export type ClaudeSessionSwitch = 'allow-all-commands' | 'allow-everything';

/** The parts of a request the switches look at. All of them are set by the host, never by the model. */
export interface SessionSwitchSubject {
	readonly category?: ToolCategory;
	readonly risk?: CommandRisk;
	readonly publishes?: boolean;
}

/**
 * Returns the switch that approves a request the host would otherwise ask
 * about, or undefined when the request must still ask. Rails that hold even
 * under Allow Everything:
 * - nothing is approved in an untrusted workspace;
 * - a push, publish or deploy command (`publishes`) always asks (issue 1167);
 * - a credential file or a command that touches credentials (`risk: 'credentials'`)
 *   asks unless Allow Everything covers credentials too (`allowCredentials`).
 * A request the host denies is never passed here: a setting that refuses wins.
 */
export function sessionSwitchFor(subject: SessionSwitchSubject, permissions: ClaudeSessionPermissions | undefined, trusted: boolean): ClaudeSessionSwitch | undefined {
	if (!permissions || !trusted) {
		return undefined;
	}
	if (subject.publishes) {
		return undefined;
	}
	if (subject.risk === 'credentials') {
		return permissions.allowEverything && permissions.allowCredentials === true ? 'allow-everything' : undefined;
	}
	if (permissions.allowEverything) {
		return 'allow-everything';
	}
	if (permissions.allowAllCommands && subject.category === 'shell' && subject.risk !== 'destructive') {
		return 'allow-all-commands';
	}
	return undefined;
}

/** True when the card for this request may offer Allow All Commands. */
export function canOfferAllowAllCommands(subject: SessionSwitchSubject, trusted: boolean): boolean {
	return trusted && subject.category === 'shell' && subject.risk !== 'credentials';
}

/** Reads a value that crossed IPC. Anything that is not exactly `true` is off. */
export function readClaudeSessionPermissions(value: unknown): ClaudeSessionPermissions {
	if (typeof value !== 'object' || value === null) {
		return NO_SESSION_PERMISSIONS;
	}
	const record = value as { allowAllCommands?: unknown; allowEverything?: unknown; allowCredentials?: unknown; autoReview?: unknown; unasked?: unknown };
	const permissions: ClaudeSessionPermissions = { allowAllCommands: record.allowAllCommands === true, allowEverything: record.allowEverything === true };
	const credentials = record.allowEverything === true && record.allowCredentials === true ? { ...permissions, allowCredentials: true, ...record.unasked === true ? { unasked: true } : {} } : permissions;
	return record.autoReview === true ? { ...credentials, autoReview: true } : credentials;
}

/**
 * The permission level that applies to every session (`claude.agent.defaultPermissionMode`,
 * issue 453). The two Allow Everything levels apply only in a trusted workspace and
 * only after the user confirmed their one-time warning; until then they work as
 * Ask Before Edits (`prompt`), which is also how the host policy reads them.
 * Allow Everything runs Claude Code unasked (issue 694), so it is held back the same
 * way when a managed policy turns that off (`unaskedBlocked`).
 */
export function effectiveClaudePermissionLevel(level: ClaudePermissionPreset, trusted: boolean, acknowledged: boolean, unaskedBlocked = false): ClaudePermissionPreset {
	if (isAllowEverythingLevel(level) && (!trusted || !acknowledged)) {
		return 'prompt';
	}
	if (level === 'allowEverything' && unaskedBlocked) {
		return 'prompt';
	}
	// Auto needs a trusted workspace too; it has no warning to confirm (issue 510).
	if (level === 'auto' && !trusted) {
		return 'prompt';
	}
	return level;
}

/** True for Allow Everything and Allow Everything Except Credentials. */
export function isAllowEverythingLevel(level: ClaudePermissionPreset): boolean {
	return level === 'allowEverything' || level === 'allowEverythingExceptCredentials';
}

/**
 * A session's own switches plus what its (effective) permission level turns on.
 * Allow All Commands stays per session; Allow Everything comes from the level.
 */
export function withClaudePermissionLevel(own: ClaudeSessionPermissions, level: ClaudePermissionPreset): ClaudeSessionPermissions {
	switch (level) {
		case 'allowEverything': return { allowAllCommands: own.allowAllCommands, allowEverything: true, allowCredentials: true, unasked: true };
		case 'allowEverythingExceptCredentials': return { allowAllCommands: own.allowAllCommands, allowEverything: true };
		case 'auto': return { ...own, autoReview: true };
		default: return own;
	}
}

/**
 * True when Claude Code runs without its own permission checks (issue 694): the
 * confirmed Allow Everything level, in a trusted workspace, in Agent mode. Ask and
 * Plan stay read-only and every other mode keeps the host's cards, so a mode switch
 * drops back. A setting value alone never gets here: `unasked` comes only from
 * `withClaudePermissionLevel`, after the warning was confirmed.
 */
export function claudeRunsUnasked(permissions: ClaudeSessionPermissions | undefined, mode: AgentMode, trusted: boolean): boolean {
	return trusted && mode === 'agent' && permissions?.unasked === true && permissions.allowEverything && permissions.allowCredentials === true;
}

/**
 * Why a request the host would ask about still asks, for the agent log (issue 741):
 * the logs alone could not tell an untrusted workspace from a missing switch.
 */
export function claudeSessionAskReason(subject: SessionSwitchSubject, permissions: ClaudeSessionPermissions | undefined, trusted: boolean): string {
	if (!trusted) {
		return 'workspace not trusted';
	}
	if (!permissions || (!permissions.allowEverything && !permissions.allowAllCommands)) {
		return permissions?.autoReview ? 'Auto left it to the user' : 'no session switch is on';
	}
	if (subject.publishes) {
		return 'it pushes, publishes or deploys';
	}
	if (subject.risk === 'credentials') {
		return 'it touches credentials';
	}
	if (subject.category !== 'shell') {
		return 'Allow All Commands covers only commands';
	}
	return 'Allow All Commands leaves destructive commands asking';
}

/**
 * Allow Everything means the user may not be watching (issue 741): the agent runs its own
 * checks and finishes routine follow-ups instead of handing them back. An instruction to
 * Claude, not UI text, so it is not localized.
 */
export const CLAUDE_ALLOW_EVERYTHING_INSTRUCTIONS = [
	'# Working on your own: Allow Everything',
	'The user turned on Allow Everything in Klawly: your tool calls run without asking, and the user may not be watching. Carry the task through to the end. The user\'s CLAUDE.md rules take precedence over these defaults:',
	'- Run the checks that cover your change yourself (build, lint, tests). Never ask the user to run them, and never end with "run X again".',
	'- When a check fails because of your change, fix it and run it again.',
	'- Take routine follow-up steps yourself instead of offering them. Never end with "say so if you want me to ..." for something you can just do.',
	'- Commit only when the user or the project instructions ask for commits; otherwise leave the changes uncommitted and say so in one line, without asking.',
	'- Make small choices yourself with sensible defaults, and name them in your reply.',
	'- Stop to ask only for a decision only the user can make, or for something you cannot reach (a password, an account, a device). Ask once, with your recommendation.',
].join('\n');

/**
 * Allow Everything text for Ask and Plan chats (issue 1168): those modes still have the user
 * approve each command, so the text must not say calls run without asking.
 */
export const CLAUDE_ALLOW_EVERYTHING_READ_ONLY_INSTRUCTIONS = [
	'# Working on your own: Allow Everything',
	'The user turned on Allow Everything in Klawly, but this chat is read-only, so the user still approves each command. The user\'s CLAUDE.md rules take precedence over these defaults:',
	'- Run the read-only checks you need yourself; never ask the user to run them.',
	'- Take routine follow-up steps yourself instead of offering them. Never end with "say so if you want me to ..." for something you can just do.',
	'- Make small choices yourself with sensible defaults, and name them in your reply.',
	'- Stop to ask only for a decision only the user can make, or for something you cannot reach. Ask once, with your recommendation.',
].join('\n');

/** The system prompt addition for a session's switches, or undefined when Claude works as usual. */
export function claudeAutonomyInstructions(permissions: ClaudeSessionPermissions | undefined, trusted: boolean, mode?: AgentMode): string | undefined {
	if (!trusted || !permissions?.allowEverything) {
		return undefined;
	}
	return mode === 'ask' || mode === 'plan' ? CLAUDE_ALLOW_EVERYTHING_READ_ONLY_INSTRUCTIONS : CLAUDE_ALLOW_EVERYTHING_INSTRUCTIONS;
}
