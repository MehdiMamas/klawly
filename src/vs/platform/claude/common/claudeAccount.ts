/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeCommandInfo, ClaudeSubagentInfo } from './claudeCommands.js';
import { ClaudeMcpAppTool } from './claudeMcpApps.js';

/** Who Claude Code is signed in as. Every field is optional: third-party providers report none. */
export interface ClaudeAccountDetails {
	readonly email?: string;
	readonly organization?: string;
	/** The Claude plan, such as `pro` or `max`, as Claude Code names it. */
	readonly plan?: string;
	/** Where requests go: `firstParty` for Anthropic, otherwise a cloud or gateway name. */
	readonly provider?: string;
}

/**
 * One plan rate-limit window.
 * - `session`: the rolling five-hour window.
 * - `week`: the seven-day window.
 * - `weekOpus`, `weekSonnet`: the seven-day windows of one model family.
 * - `model`: a window Claude Code scopes to the model named in `label`.
 */
export type ClaudeUsageWindowKind = 'session' | 'week' | 'weekOpus' | 'weekSonnet' | 'model';

export interface ClaudeUsageWindow {
	readonly kind: ClaudeUsageWindowKind;
	readonly label?: string;
	/** How much of the window is used, 0 to 100. */
	readonly percent: number;
	/** When the window resets, in epoch milliseconds. */
	readonly resetsAt?: number;
}

export type ClaudeMcpServerState = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';

/** One tool of an MCP server: its name and the `readOnly` hint it declares, when it declares one (issue 1378). */
export interface ClaudeMcpToolInfo {
	readonly name: string;
	readonly readOnlyHint?: boolean;
}

/** An MCP server the session loaded, with its state as Claude Code reports it. */
export interface ClaudeMcpServerInfo {
	readonly name: string;
	readonly state: ClaudeMcpServerState;
	/** Where it is configured, such as `project`, `user` or `local`. */
	readonly scope?: string;
	readonly version?: string;
	readonly toolCount: number;
	readonly error?: string;
	/** The configured URL of an http or SSE server. Absent for stdio and in-process servers. */
	readonly url?: string;
	/** Its tools that draw an MCP App (issue 513). Absent when it has none. */
	readonly apps?: readonly ClaudeMcpAppTool[];
	/** Its tools by name. Absent when Claude Code lists none. */
	readonly tools?: readonly ClaudeMcpToolInfo[];
}

/**
 * What the Klawly Settings Plan & Usage and Customize pages show. A runtime asks a
 * running session; with none it answers with what the last session reported.
 * A missing field means the runtime never reported it, an empty list that it
 * reported none. `live` says the answer came from a running session just now.
 */
export interface ClaudeAccountOverview {
	readonly live: boolean;
	readonly account?: ClaudeAccountDetails;
	readonly usage?: readonly ClaudeUsageWindow[];
	/** When Claude Code last reported `usage`, in epoch milliseconds, so a page can say how old it is (issue 704). */
	readonly usageCheckedAt?: number;
	/** The last ask for `usage` failed, so a missing or old list is "could not load", not "none" (issue 942). */
	readonly usageFailed?: boolean;
	readonly mcpServers?: readonly ClaudeMcpServerInfo[];
	readonly commands?: readonly ClaudeCommandInfo[];
	readonly agents?: readonly ClaudeSubagentInfo[];
}

/**
 * How fresh the plan limits in an account overview must be (issue 704).
 * `'stale'` asks Claude Code again when the last answer is older than a minute,
 * even with no session running; `'now'` asks again unless it answered a few
 * seconds ago, for a Refresh button. Left out, the last answer is reused.
 */
export type ClaudeUsageRefresh = 'stale' | 'now';

/** One rate-limit window as Claude Code's usage report has it: a 0-100 percentage and an ISO reset time. */
export interface ClaudeRawUsageWindow {
	readonly utilization: number | null;
	readonly resets_at: string | null;
}

/** The parts of Claude Code's usage report that {@link claudeUsageWindows} reads. */
export interface ClaudeRawRateLimits {
	readonly five_hour?: ClaudeRawUsageWindow | null;
	readonly seven_day?: ClaudeRawUsageWindow | null;
	readonly seven_day_opus?: ClaudeRawUsageWindow | null;
	readonly seven_day_sonnet?: ClaudeRawUsageWindow | null;
	readonly model_scoped?: readonly (ClaudeRawUsageWindow & { readonly display_name: string })[];
}

function usageWindow(kind: ClaudeUsageWindowKind, raw: ClaudeRawUsageWindow | null | undefined, label?: string): ClaudeUsageWindow | undefined {
	if (!raw || typeof raw.utilization !== 'number' || !Number.isFinite(raw.utilization)) {
		return undefined;
	}
	const resetsAt = raw.resets_at ? Date.parse(raw.resets_at) : NaN;
	return {
		kind,
		label,
		percent: Math.min(100, Math.max(0, raw.utilization)),
		resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
	};
}

/**
 * Turns Claude Code's plan rate limits into our windows, session first. Windows
 * without a number are left out; `undefined` limits mean the plan reports none.
 */
export function claudeUsageWindows(limits: ClaudeRawRateLimits | null | undefined): ClaudeUsageWindow[] {
	if (!limits) {
		return [];
	}
	const windows = [
		usageWindow('session', limits.five_hour),
		usageWindow('week', limits.seven_day),
		usageWindow('weekOpus', limits.seven_day_opus),
		usageWindow('weekSonnet', limits.seven_day_sonnet),
		...(limits.model_scoped ?? []).map(raw => usageWindow('model', raw, raw.display_name)),
	];
	return windows.filter((window): window is ClaudeUsageWindow => window !== undefined);
}

const MCP_STATES: readonly ClaudeMcpServerState[] = ['connected', 'failed', 'needs-auth', 'pending', 'disabled'];

/** Reads a server state, treating anything new as still starting. */
export function claudeMcpServerState(value: string): ClaudeMcpServerState {
	return (MCP_STATES as readonly string[]).includes(value) ? value as ClaudeMcpServerState : 'pending';
}
