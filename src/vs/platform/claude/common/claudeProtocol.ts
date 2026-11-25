/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeUsageWindow } from './claudeAccount.js';
import { ClaudeUsageLimit } from './claudeAccounts.js';
import { ClaudeInstructionSource } from './claudeAgentsFiles.js';
import { ClaudeCommandInfo, ClaudeSubagentInfo } from './claudeCommands.js';
import { AgentMode } from './claudeContext.js';
import { ClaudeElicitationOutcome, ClaudeElicitationRequest } from './claudeElicitation.js';
import { ClaudeExecutionTargetInfo, ClaudeTargetInstall } from './claudeExecutionTarget.js';
import { ClaudeFastModeStatus } from './claudeFastMode.js';
import { ClaudeReviewFinding, ClaudeReviewSummary } from './claudeReviewLoop.js';
import { ClaudeReviewReadiness } from './claudeReviewReadiness.js';
import { ClaudeEffortLevel, ClaudeSessionSettings } from './claudeSessionSettings.js';
import { CLAUDE_TERMINAL_TOOL_ID } from './claudeTerminalRun.js';

/**
 * Bump when a normalized event shape changes in a way old readers cannot ignore.
 * Help → About shows this value in Phase 5.
 */
export const CLAUDE_PROTOCOL_VERSION = 1;

export type ToolCategory = 'read' | 'write' | 'search' | 'shell' | 'web' | 'skill' | 'mcp' | 'other';

export interface ToolDisplayModel {
	label: string;
	file?: string;
	query?: string;
	command?: string;
}

export interface ToolCall {
	id: string;
	name: string;
	category: ToolCategory;
	input: unknown;
	display: ToolDisplayModel;
}

/** A raster image in a tool result, such as one an MCP image server made (issues 494, 897). */
export interface ToolResultImage {
	readonly mimeType: string;
	/** Base64, without the `data:` prefix. */
	readonly data: string;
}

export interface ToolResult {
	ok: boolean;
	output?: string;
	error?: string;
	/** Images in the result (MCP tools). */
	images?: readonly ToolResultImage[];
	/** The MCP tool's `structuredContent`, when it sent one. */
	structuredContent?: Readonly<Record<string, unknown>>;
}

/** How risky the host judged a shell command. See `classifyCommand`. */
export type CommandRisk = 'safe' | 'mutating' | 'network' | 'destructive' | 'credentials';

/** What the user can answer on a permission card. */
export type PermissionChoice = 'allow-once' | 'allow-session' | 'allow-workspace' | 'deny';

/**
 * A request the host could not decide by itself. Every field except `id`,
 * `toolName`, and `input` is set by the host policy, never by the model.
 */
export interface PermissionRequest {
	id: string;
	toolName: string;
	input: unknown;
	reason?: string;
	category?: ToolCategory;
	/** The exact command, for shell tools. */
	command?: string;
	/** Directory the command runs in. */
	cwd?: string;
	/** Absolute path the tool touches, after canonicalization. */
	targetPath?: string;
	/** True when the target is outside every workspace folder, or a symlink leads outside. */
	outsideWorkspace?: boolean;
	/** True when the request opens a page outside this machine in the Agent Browser (issue 990). */
	agentBrowser?: boolean;
	risk?: CommandRisk;
	/** True for a command that pushes, publishes or deploys: the session switches never approve it (issue 1167). */
	publishes?: boolean;
	/** Why the host is asking, in a sentence. */
	why?: string;
	/** False when only "Allow once" may be offered (risky, credential, or untrusted). */
	canRemember?: boolean;
	/** Mode of the turn that asked, so the card can say why it asks. */
	mode?: AgentMode;
	/** True when the card may offer Allow All Commands (a shell command in a trusted workspace). */
	canAllowAllCommands?: boolean;
	/** Workspace Trust when the host asked. Allow Everything needs a trusted workspace. */
	workspaceTrusted?: boolean;
}

/**
 * Who settled a permission request. `allow-all-commands` and `allow-everything`
 * are the per-session switches the user turned on (Phase 27). `auto` is the Auto
 * level's classifier (issue 510).
 */
export type PermissionSource = 'user' | 'policy' | 'grant' | 'session-stopped' | 'allow-all-commands' | 'allow-everything' | 'auto';

export interface PermissionOutcome {
	requestId: string;
	toolName: string;
	decision: 'allow' | 'deny';
	scope?: 'once' | 'session' | 'workspace';
	source: PermissionSource;
	/** The command or absolute path the decision covered. */
	subject?: string;
	message?: string;
	/** Set when the mode (Plan or Ask) refused a file write, so the record can offer Switch to Agent and Retry. */
	blockedByMode?: AgentMode;
}

export interface TodoItem {
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed';
}

/** Token counts only when the runtime reports them. Never invent a quota. */
export interface UsageInfo {
	inputTokens?: number;
	outputTokens?: number;
	/** Prompt tokens read from the cache (issue 836). */
	cacheReadTokens?: number;
	/** Prompt tokens written to the cache (issue 836). */
	cacheWriteTokens?: number;
	/** Tokens in the context at the last main-loop model call: input, cache reads and writes, and output. */
	contextTokens?: number;
	/** Context window the runtime reported for the main model. */
	contextWindow?: number;
	/** What the query has cost so far in US dollars, as Claude Code reports it (`total_cost_usd`). Compare Models shows it per run (issue 424). */
	costUsd?: number;
}

/**
 * One row of the context breakdown, as Claude Code's `/context` lists it.
 * `used` rows fill the window, `free` is what is left, `buffer` is the
 * compaction reserve. Rows outside the window are not reported.
 */
export interface ClaudeContextCategory {
	readonly name: string;
	readonly tokens: number;
	readonly kind: 'used' | 'free' | 'buffer';
}

/** What fills a running session's context window, by category. */
export interface ClaudeContextBreakdown {
	readonly usedTokens: number;
	readonly windowTokens: number;
	readonly categories: readonly ClaudeContextCategory[];
}

/** The parts of Claude Code's context usage report that {@link claudeContextBreakdown} reads. */
export interface ClaudeRawContextUsage {
	readonly totalTokens: number;
	readonly maxTokens: number;
	readonly categories: readonly { readonly name: string; readonly tokens: number; readonly kind?: string; readonly isDeferred?: boolean }[];
}

const CONTEXT_KINDS: readonly ClaudeContextCategory['kind'][] = ['used', 'free', 'buffer'];

/**
 * Reads Claude Code's context report. Rows outside the window (deferred tool
 * schemas) and empty rows are left out; a report without a window is none.
 */
export function claudeContextBreakdown(raw: ClaudeRawContextUsage | undefined): ClaudeContextBreakdown | undefined {
	if (!raw || !(raw.maxTokens > 0) || !(raw.totalTokens >= 0)) {
		return undefined;
	}
	const categories: ClaudeContextCategory[] = [];
	for (const category of raw.categories) {
		const kind = category.kind ?? (category.isDeferred ? 'deferred' : 'used');
		if ((CONTEXT_KINDS as readonly string[]).includes(kind) && category.tokens > 0) {
			categories.push({ name: category.name, tokens: category.tokens, kind: kind as ClaudeContextCategory['kind'] });
		}
	}
	return { usedTokens: raw.totalTokens, windowTokens: raw.maxTokens, categories };
}

/**
 * Why a turn stopped. The runner sets this on `session.failed`.
 * Callers must not invent a kind the runtime did not imply.
 */
export type AgentFailureKind =
	| 'auth'
	| 'usage-limit'
	| 'network'
	| 'runtime-missing'
	| 'runtime-version'
	| 'permission-denied'
	| 'tool-failure'
	| 'process-crash'
	| 'workspace-conflict'
	/** Another view already runs this Claude Code session (v5 N5). */
	| 'session-owned'
	/** The query reached its `maxTurns` cap (issues 696, 707). Not an error: Continue resumes the session. */
	| 'turn-limit'
	| 'unknown';

export type ClaudeSubagentState = 'running' | 'success' | 'failed' | 'stopped';

export interface ClaudeSubagentRun {
	/** Agent-tool call id. */
	id: string;
	/** Set when this subagent was started by another subagent. */
	parentRunId?: string;
	agentType: string;
	description: string;
	model?: string;
	background: boolean;
	state: ClaudeSubagentState;
	startedAt: number;
	endedAt?: number;
	toolCallCount: number;
	resultText?: string;
	/** Stop could not target this run, so the parent turn was interrupted. */
	interruptedParent?: boolean;
}

/**
 * A GitHub pull request or issue Claude mentioned or opened (issue 430). The
 * runtime matches the URL's shape only; it never asks GitHub about it.
 */
export interface ClaudeGitHubReference {
	readonly url: string;
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly kind: 'pullRequest' | 'issue';
	/** True when a command of this session created it, such as `gh pr create`. */
	readonly createdBySession: boolean;
}

interface ClaudeEventFields {
	sessionId: string;
	/** Agent-tool call id when the event was produced inside a subagent. */
	parentRunId?: string;
}

export type NormalizedClaudeEvent = ClaudeEventFields & (
	/**
	 * The query started. `claudeSessionId` is Claude Code's own conversation id (the
	 * transcript name), the id to resume with. `sessionId` is this runtime's id.
	 * `target` says where Claude Code runs when the user picked a target (issue 425).
	 * `instructions` lists the AGENTS.md files and `.agents/skills` Klawly passed (issue 499).
	 */
	| { type: 'session.started'; claudeSessionId?: string; model?: string; slashCommands?: readonly string[]; skills?: readonly string[]; target?: ClaudeExecutionTargetInfo; instructions?: readonly ClaudeInstructionSource[] }
	| { type: 'assistant.delta'; text: string }
	| { type: 'assistant.completed'; text: string }
	/**
	 * Claude's extended thinking. A block starts with an empty delta, streams its
	 * text (empty when the runtime omits or redacts it) and ends with `done`.
	 * `at` is when the runtime saw it, so the timeline can say how long Claude thought.
	 * `tokens` is the runtime's running estimate of the block's size (issue 740).
	 */
	| { type: 'thinking.delta'; text: string; at: number; done?: boolean; tokens?: number }
	| { type: 'tool.started'; call: ToolCall }
	| { type: 'tool.updated'; callId: string; update: unknown }
	| { type: 'tool.completed'; callId: string; result: ToolResult }
	| { type: 'permission.requested'; request: PermissionRequest }
	| { type: 'permission.resolved'; outcome: PermissionOutcome }
	| { type: 'file.beforeWrite'; uri: string; before: string | null }
	| { type: 'file.afterWrite'; uri: string; after: string | null }
	| { type: 'todo.changed'; items: TodoItem[] }
	| { type: 'usage.changed'; usage: UsageInfo }
	| { type: 'session.compacted'; info?: unknown }
	/** `targetInstall` is set when a dev container or SSH host has no Claude Code: the IDE offers to install it there (issue 425). */
	/** `turns` is how many turns the query took when it stopped at its `maxTurns` cap (kind `turn-limit`). */
	| { type: 'session.failed'; message: string; kind?: AgentFailureKind; endedAt?: number; targetInstall?: ClaudeTargetInstall; turns?: number; /** The plan limit a `usage-limit` stop hit, when Claude Code named it (issue 450). */ limit?: ClaudeUsageLimit }
	/**
	 * `anchor` is Claude Code's id for the turn's last main-thread chain entry, so a
	 * later resume can stop there and drop every turn after it (issue 702).
	 */
	| { type: 'session.completed'; endedAt?: number; anchor?: string }
	| { type: 'session.modelChanged'; modelId: string }
	| { type: 'session.settingsChanged'; settings: ClaudeSessionSettings }
	/** Fast mode's real state, sent when it changes (issue 456). `previous` is the state before, when one was known. */
	| { type: 'session.fastMode'; status: ClaudeFastModeStatus; previous?: ClaudeFastModeStatus }
	/** The full `/` menu catalog, sent once Claude Code lists its commands and subagents. An empty list leaves that part as it was. */
	| { type: 'session.catalog'; commands: readonly ClaudeCommandInfo[]; agents: readonly ClaudeSubagentInfo[] }
	/**
	 * A short title for the chat, sent once after its first finished turn: Claude Code's
	 * own session title when it has one, else one Claude wrote for the first request.
	 */
	| { type: 'session.titled'; title: string }
	| { type: 'subagent.started'; run: ClaudeSubagentRun }
	| { type: 'subagent.finished'; runId: string; state: ClaudeSubagentState; resultText?: string; endedAt?: number; interruptedParent?: boolean }
	/**
	 * The account's plan limits, session window first, sent when Claude Code reports
	 * them and again whenever they change. An empty list means the account has no
	 * plan limits (API key or cloud provider).
	 */
	| { type: 'session.usageLimits'; windows: readonly ClaudeUsageWindow[] }
	/** A pull request or issue URL in Claude's text or in a command's output, once per URL (again if this session turns out to have created it). */
	| { type: 'github.referenceDetected'; reference: ClaudeGitHubReference }
	/**
	 * An MCP server asks the user for input, as a form or a URL to open (issue 428),
	 * or Claude asks its own questions (`question`, issue 477).
	 * The runtime waits for `resolveElicitation`; `elicitation.resolved` never carries
	 * a form's content. `elicitation.completed` is the server saying a URL sign-in finished.
	 */
	| { type: 'elicitation.requested'; request: ClaudeElicitationRequest }
	| { type: 'elicitation.resolved'; outcome: ClaudeElicitationOutcome }
	| { type: 'elicitation.completed'; server: string; elicitationId: string }
	/**
	 * The findings of a structured review pass (issue 431), worst first. `reviewId` is
	 * the workbench's id for the pass; `reviewChanges` returns it, outside any turn.
	 */
	| { type: 'review.findings'; reviewId: string; findings: readonly ClaudeReviewFinding[]; /** The summary, when the review asked for one (issue 918). */ summary?: ClaudeReviewSummary; /** The merge-readiness score, when the review asked for one (issue 920). */ readiness?: ClaudeReviewReadiness }
);

/** The normalized result of a structured review pass. */
export type ClaudeReviewFindingsEvent = Extract<NormalizedClaudeEvent, { type: 'review.findings' }>;

export const KNOWN_CLAUDE_EVENT_TYPES: readonly NormalizedClaudeEvent['type'][] = [
	'session.started',
	'assistant.delta',
	'assistant.completed',
	'thinking.delta',
	'tool.started',
	'tool.updated',
	'tool.completed',
	'permission.requested',
	'permission.resolved',
	'file.beforeWrite',
	'file.afterWrite',
	'todo.changed',
	'usage.changed',
	'session.compacted',
	'session.failed',
	'session.completed',
	'session.modelChanged',
	'session.settingsChanged',
	'session.fastMode',
	'session.catalog',
	'session.titled',
	'subagent.started',
	'subagent.finished',
	'session.usageLimits',
	'github.referenceDetected',
	'elicitation.requested',
	'elicitation.resolved',
	'elicitation.completed',
	'review.findings',
];

export function isKnownClaudeEventType(type: string): type is NormalizedClaudeEvent['type'] {
	return (KNOWN_CLAUDE_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Maps a Claude tool name to a stable UI category.
 * `WebFetch` and `WebSearch` are included because the category list has `web`
 * and those are the Claude Code web tool names. The section 8 snippet omits them.
 */
export function classifyTool(name: string): ToolCall['category'] {
	if (name === 'Read') {
		return 'read';
	}
	if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') {
		return 'write';
	}
	// A notebook edit is a file write too: it is checkpointed and reviewed (issue 526).
	if (name === 'NotebookEdit') {
		return 'write';
	}
	if (name === 'Grep' || name === 'Glob') {
		return 'search';
	}
	// Klawly's run_in_terminal (issue 452) runs a command too, so it draws as a command card.
	if (name === 'Bash' || name === CLAUDE_TERMINAL_TOOL_ID) {
		return 'shell';
	}
	if (name === 'WebFetch' || name === 'WebSearch') {
		return 'web';
	}
	if (name === 'Skill') {
		return 'skill';
	}
	if (name.startsWith('mcp__')) {
		return 'mcp';
	}
	return 'other';
}

/** Compare Models (issue 424): one run of a comparison, as the user picked it. */
export interface ClaudeComparisonRunSpec {
	readonly modelId: string;
	/** Absent: the model's own default effort. */
	readonly effort?: ClaudeEffortLevel;
	/** Model name and effort, as the model pill shows them. */
	readonly label: string;
}

export type ClaudeComparisonRunState = 'starting' | 'running' | 'waiting' | 'complete' | 'failed' | 'kept' | 'discarded';

export interface ClaudeComparisonDiffStat {
	readonly filesChanged: number;
	readonly added: number;
	readonly removed: number;
}

/** The judge's place for one run. `run` is the 1-based run number. */
export interface ClaudeComparisonRanking {
	readonly run: number;
	readonly score: number;
	readonly reasons: string;
}

/**
 * Compare Models (issue 424): the comparison's own events. Each run is an
 * ordinary background session whose chat keeps the session events above,
 * keyed by its own session id. `run` is the 1-based run number.
 */
export type ClaudeComparisonEvent =
	| { type: 'comparison.started'; comparisonId: string; prompt: string; runs: readonly ClaudeComparisonRunSpec[] }
	| { type: 'comparison.runUpdated'; comparisonId: string; run: number; state: ClaudeComparisonRunState; sessionId?: string; diffStat?: ClaudeComparisonDiffStat; message?: string; costUsd?: number; durationMs?: number }
	| { type: 'comparison.judged'; comparisonId: string; ranking: readonly ClaudeComparisonRanking[]; summary: string }
	| { type: 'comparison.judgeFailed'; comparisonId: string; message: string };
