/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentMode } from './claudeContext.js';
import { CLAUDE_DEBUG_ENDPOINT_TOOL_ID, CLAUDE_REPRODUCE_TOOL_ID } from './claudeDebugMode.js';
import { AGENT_POLICY, ASK_POLICY, PLAN_POLICY, PermissionDenial, SessionPolicy } from './claudePermissions.js';
import { classifyTool } from './claudeProtocol.js';
import { CLAUDE_SETTINGS_FIND_TOOL_ID } from './claudeSettingsTool.js';
import { CLAUDE_CANVAS_TOOL_ID } from './claudeCanvas.js';
import { CLAUDE_DELEGATE_TOOL_ID, CLAUDE_MESSAGE_HELPER_TOOL_ID } from './claudeDelegate.js';
import { CLAUDE_MODE_TOOL_ID } from './claudeModeTool.js';
import { CLAUDE_STATUS_TOOL_ID } from './claudeStatusTool.js';
import { CLAUDE_FEEDBACK_TOOL_ID } from './claudeFeedbackTool.js';
import { CLAUDE_REVIEW_FINDINGS_TOOL_ID, CLAUDE_REVIEW_MARK_TOOL_ID } from './claudeReviewTools.js';
import { CLAUDE_CI_WAIT_TOOL_ID, CLAUDE_MERGE_GATE_TOOL_ID } from './claudeNoModelTools.js';

export function policyForMode(mode: AgentMode): Readonly<SessionPolicy> {
	switch (mode) {
		case 'ask': return ASK_POLICY;
		case 'plan': return PLAN_POLICY;
		case 'agent': return AGENT_POLICY;
		// Debug mode edits files like Agent: it adds instrumentation and a fix (issue 484).
		case 'debug': return AGENT_POLICY;
	}
}

/** True for the modes that must not change project files (Plan may still write plan files). */
export function isReadOnlyMode(mode: AgentMode): boolean {
	return policyForMode(mode).allowWorkspaceWrites !== 'prompt-or-auto';
}

/**
 * Tools the SDK refuses itself in Ask, below `canUseTool`. `Bash` is not listed:
 * commands ask in every mode (Phase 27).
 */
export const READ_ONLY_DISALLOWED_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/**
 * Tools the SDK refuses itself in `mode`. Plan keeps Write and Edit for plan
 * files, which the host policy checks path by path. Agent refuses nothing here.
 */
export function disallowedToolsForMode(mode: AgentMode): readonly string[] | undefined {
	switch (policyForMode(mode).allowWorkspaceWrites) {
		case false: return READ_ONLY_DISALLOWED_TOOLS;
		case 'plan-files': return ['NotebookEdit'];
		default: return undefined;
	}
}

/**
 * The SDK auto-approves `allowedTools` without calling `canUseTool`, so Plan and
 * Ask keep only entries that read, search, fetch, or load a skill. The
 * PreToolUse screen still checks every call.
 */
export function allowedToolsForMode(mode: AgentMode, allowedTools: readonly string[] | undefined): readonly string[] | undefined {
	if (!allowedTools || !isReadOnlyMode(mode)) {
		return allowedTools;
	}
	return allowedTools.filter(entry => {
		const category = classifyTool(entry.replace(/\(.*$/, '').trim());
		return category === 'read' || category === 'search' || category === 'web' || category === 'skill';
	});
}

/**
 * The mode filter runs in the permission bridge before any other check.
 * `defer` means the mode allows the request to reach the host policy. It does
 * not mean the request is approved: path guards, risk rules, plan-file checks
 * and the user prompt still decide.
 */
export type ModePolicyResult =
	| { readonly behavior: 'defer' }
	| { readonly behavior: 'deny'; readonly message: string; readonly denial: PermissionDenial };

/**
 * Tools that only organise the agent's own work and never touch the project.
 * The host policy allows them without a card. Any other tool it does not know
 * asks, so an unknown tool fails closed.
 */
// Debug mode's tools change no file: one starts a loopback log sink, one shows the Reproduce card (issue 484).
// Klawly's settings find tool only reads (issue 525).
// Canvas writes only into Klawly's own canvases folder, never the project (issue 493).
// ci_wait only reads GitHub and posts one message into this chat (issue 844). verify and merge_gate ask like a command.
// klawly_mode only reads this chat's modes (issue 1169). klawly_status only shows one line on the chat tab (issue 1171). klawly_feedback only opens the Send Feedback form; the user sends it (issue 1174).
// Delegation starts a chat with the same mode and permissions, which asks for its own tools, like Task (issue 693).
export const NON_MUTATING_TOOLS: ReadonlySet<string> = new Set(['TodoWrite', 'Task', 'Agent', 'NotebookRead', 'BashOutput',
	CLAUDE_DEBUG_ENDPOINT_TOOL_ID, CLAUDE_REPRODUCE_TOOL_ID, CLAUDE_SETTINGS_FIND_TOOL_ID, CLAUDE_CANVAS_TOOL_ID, CLAUDE_DELEGATE_TOOL_ID, CLAUDE_MESSAGE_HELPER_TOOL_ID, CLAUDE_CI_WAIT_TOOL_ID, CLAUDE_MODE_TOOL_ID, CLAUDE_STATUS_TOOL_ID, CLAUDE_FEEDBACK_TOOL_ID,
	// Reading and marking review findings only touches the review store; apply_suggestion and run_review ask first (issue 1376).
	CLAUDE_REVIEW_FINDINGS_TOOL_ID, CLAUDE_REVIEW_MARK_TOOL_ID]);

const READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set([
	'cat', 'ls', 'dir', 'pwd', 'echo', 'head', 'tail', 'wc', 'grep', 'rg', 'which', 'where', 'whoami',
	'tree', 'stat', 'file', 'type', 'diff', 'basename', 'dirname', 'realpath',
]);

const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
	'status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'ls-files', 'shortlog', 'describe',
]);

const FORBIDDEN_FRAGMENTS: readonly RegExp[] = [/>/, /</, /`/, /\$\(/, /\$\{/, /\r/];

/**
 * True when every part of `command` is a known program that cannot change the
 * project. The check is a closed allowlist: anything it does not recognise is
 * treated as mutating. Phase 10 owns the full command risk classifier.
 */
export function isReadOnlyShellCommand(command: string): boolean {
	const text = command.trim();
	if (!text || FORBIDDEN_FRAGMENTS.some(pattern => pattern.test(text))) {
		return false;
	}
	const segments = text.split(/&&|\|\||[;|\n]/).map(segment => segment.trim());
	return segments.length > 0 && segments.every(isReadOnlySegment);
}

function isReadOnlySegment(segment: string): boolean {
	if (!segment || segment.includes('&')) {
		// A single & (or |&) starts a background job or a second command.
		return false;
	}
	const words = segment.split(/\s+/);
	const program = words[0];
	if (program === 'git') {
		return isReadOnlyGit(words.slice(1));
	}
	if (program === 'find') {
		return !words.some(word => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(word));
	}
	if (!READ_ONLY_PROGRAMS.has(program)) {
		return false;
	}
	// `rg --pre` and `--hostname-bin` run a program.
	if (words.some(word => /^--(pre|hostname-bin)(=|$)/.test(word))) {
		return false;
	}
	// `tree` and `sort` write a file with -o / --output.
	if ((program === 'tree' || program === 'sort') && words.some(word => word === '--output' || word.startsWith('--output=') || /^-[A-Za-z]*o/.test(word))) {
		return false;
	}
	return true;
}

function isReadOnlyGit(args: readonly string[]): boolean {
	const subcommand = args[0];
	if (!subcommand || subcommand.startsWith('-')) {
		return false;
	}
	if (args.some(arg => arg === '--ext-diff' || arg === '--output' || arg.startsWith('--output=') || arg === '--textconv')) {
		return false;
	}
	if (subcommand === 'branch') {
		return args.slice(1).every(arg => ['-a', '-r', '-v', '-vv', '--list', '--all', '--remotes', '--show-current'].includes(arg));
	}
	if (subcommand === 'remote') {
		return args.length === 1 || (args.length === 2 && args[1] === '-v');
	}
	return READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
}

/**
 * Decides whether `mode` lets a tool request reach the host policy (Phase 27).
 * - Agent and Plan defer everything. The host policy denies a Plan write to a
 *   file that is not a plan file, because that needs the canonical path.
 * - Ask denies every file write before the host is asked. Commands, web, MCP
 *   and every other tool defer: they ask or run as in the other modes.
 * The mode is never switched on the user's behalf.
 */
export function evaluateModePolicy(mode: AgentMode, toolName: string, _input: unknown): ModePolicyResult {
	if (policyForMode(mode).allowWorkspaceWrites !== false) {
		return { behavior: 'defer' };
	}
	const category = classifyTool(toolName);
	// A merge changes the repository's history, which Ask never does; its dry run only reads (issue 844).
	const merges = toolName === CLAUDE_MERGE_GATE_TOOL_ID && !(typeof _input === 'object' && _input !== null && (_input as { dry_run?: unknown }).dry_run === true);
	if (merges || category === 'write' || READ_ONLY_DISALLOWED_TOOLS.includes(toolName)) {
		return {
			behavior: 'deny',
			message: `Denied by the IDE: Ask mode never changes files (${toolName}). Nothing was changed and the mode was not switched. Answer by reading, searching and running commands only. The user can switch the mode to Agent to allow changes.`,
			denial: { code: 'mode-read-only', mode, tool: toolName, category },
		};
	}
	return { behavior: 'defer' };
}
