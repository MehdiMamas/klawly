/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The agent tools that wait on CI, run tests and merge with no model call (issue 844). */

import { CLAUDE_KLAWLY_MCP_SERVER } from './claudeTerminalRun.js';

/** Tool names, without the MCP server prefix. */
export const CLAUDE_CI_WAIT_TOOL = 'ci_wait';
export const CLAUDE_VERIFY_TOOL = 'verify';
export const CLAUDE_MERGE_GATE_TOOL = 'merge_gate';

/** The names the permission policy sees. */
export const CLAUDE_CI_WAIT_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_CI_WAIT_TOOL}`;
export const CLAUDE_VERIFY_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_VERIFY_TOOL}`;
export const CLAUDE_MERGE_GATE_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_MERGE_GATE_TOOL}`;

/**
 * The session-manager plugin's copies of these tools, plus its delegate. Klawly's own
 * tools do the same job inside the window, so the SDK refuses these copies and the
 * model has one tool per job (issue 1170).
 */
export const CLAUDE_DUPLICATE_SESSION_MANAGER_TOOLS: readonly string[] = ['ci_wait', 'verify', 'merge_gate', 'delegate'].map(name => `mcp__session-manager__${name}`);

/** GitHub is asked at most this often while a watch runs. */
export const CLAUDE_CI_WAIT_POLL_MS = 30_000;

/** A failed run's message carries this many log lines. */
export const CLAUDE_CI_WAIT_LOG_LINES = 40;

export interface ClaudeCiWaitArgs {
	readonly repo: string;
	readonly pr?: number;
	readonly run?: number;
	readonly grace_minutes?: number;
}

export interface ClaudeVerifyArgs {
	readonly cwd: string;
	readonly base?: string;
}

export interface ClaudeMergeGateArgs {
	readonly repo: string;
	readonly pr: number;
	readonly dry_run?: boolean;
}

/** A sentence saying why `repo` is not an `owner/name`, or undefined when it is. */
export function claudeNoModelRepoProblem(repo: string): string | undefined {
	return /^[\w.-]+\/[\w.-]+$/.test(repo) ? undefined : `The repo must be owner/name, for example MehdiMamas/klawly-ide. Got: ${repo}`;
}

/**
 * A sleep that waits for something else: `sleep 60 && gh run view`, `while ...; do sleep 30; done`,
 * `until ...; do sleep 5; done`. A plain `sleep` on its own line, a short one, is not polling.
 */
const SLEEP_POLLING = /\b(?:while|until|for)\b[^\n]*\bsleep\b|\bsleep\s+\d+(?:\.\d+)?[smhd]?\s*(?:&&|;|\|\|)\s*\S/;

/**
 * In Auto, a `sleep` polling loop in Bash is refused: Watch CI (ci_wait) waits for CI without the model
 * and without tokens (issue 1110). Returns the sentence that goes back to Claude, or undefined when the
 * call is fine.
 */
export function claudeSleepPollingProblem(toolName: string, input: unknown): string | undefined {
	if (toolName !== 'Bash' || typeof input !== 'object' || input === null) {
		return undefined;
	}
	const command = (input as { command?: unknown }).command;
	if (typeof command !== 'string' || !SLEEP_POLLING.test(command)) {
		return undefined;
	}
	return `Do not poll with sleep in Auto. To wait for CI call ${CLAUDE_CI_WAIT_TOOL} (shown as Watch CI): it costs no tokens and one message arrives when the checks end. For tests call ${CLAUDE_VERIFY_TOOL} (Run Tests).`;
}
