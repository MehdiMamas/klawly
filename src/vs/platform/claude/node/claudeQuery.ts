/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeModeState } from '../common/claudeModeTool.js';
import { ClaudeStatusKind } from '../common/claudeStatusTool.js';
import { ClaudeFeedbackToolKind } from '../common/claudeFeedbackTool.js';
import type { ClaudeCiWaitArgs, ClaudeMergeGateArgs, ClaudeVerifyArgs } from '../common/claudeNoModelTools.js';
import type { ClaudeNoModelToolResult } from './claudeNoModelTools.js';
import { ClaudeAccountDetails, ClaudeMcpServerInfo, ClaudeUsageWindow } from '../common/claudeAccount.js';
import { ClaudeMcpResourceContent } from '../common/claudeMcpApps.js';
import { PermissionDenial } from '../common/claudePermissions.js';
import { ClaudeContextBreakdown } from '../common/claudeProtocol.js';
import { ClaudeGitFlagSettings } from '../common/claudeGitSettings.js';
import { ClaudeSecuritySettings } from '../common/claudeSecuritySettings.js';
import { ClaudeEffortLevel, ClaudeFlagSettingsPatch, ClaudeStartSettings } from '../common/claudeSessionSettings.js';
import { ClaudeTerminalRunResult } from '../common/claudeTerminalRun.js';
import { ClaudeDebugToolHost } from './claudeDebugLogSink.js';
import { ClaudeBuiltinAgent } from './claudeBuiltinAgents.js';
import { ClaudePreparedTarget } from './claudeExecutionTarget.js';
import { ClaudeSettingsToolArgs, ClaudeSettingsToolResult } from '../common/claudeSettingsTool.js';
import { ClaudeBrowserToolArgs, ClaudeBrowserToolResult } from '../common/claudeBrowserTool.js';
import { ClaudeCanvasToolArgs, ClaudeCanvasToolResult } from '../common/claudeCanvas.js';
import { ClaudeDelegateToolArgs, ClaudeDelegateToolResult } from '../common/claudeDelegate.js';
import { ClaudeDepartmentToolArgs, ClaudeDepartmentToolResult } from '../common/claudeDepartment.js';
import type { ClaudeReviewToolHost } from '../common/claudeReviewTools.js';
import { ClaudeStartAgentToolArgs, ClaudeStartAgentToolResult } from '../common/claudeStartAgent.js';

export interface ClaudeQueryModel {
	readonly id: string;
	readonly displayName: string;
	readonly description?: string;
	readonly resolvedModel?: string;
	readonly supportsEffort?: boolean;
	readonly supportedEffortLevels?: readonly ClaudeEffortLevel[];
	readonly supportsAdaptiveThinking?: boolean;
	readonly supportsFastMode?: boolean;
	readonly supportsAutoMode?: boolean;
}

export interface ClaudeQueryCommand {
	readonly name: string;
	readonly description: string;
	readonly argumentHint?: string;
	readonly aliases?: readonly string[];
	/** Ships with Claude Code, as opposed to a skill, a custom command or an MCP prompt. */
	readonly builtin?: boolean;
}

export interface ClaudeQueryAgent {
	readonly name: string;
	readonly description: string;
	readonly model?: string;
}

export interface ClaudeQuery {
	[Symbol.asyncIterator](): AsyncIterator<unknown>;
	interrupt(): Promise<void>;
	setModel(model?: string): Promise<void>;
	/**
	 * Switches Claude Code's permission mode on the running query (issue 694): in and out
	 * of the unasked mode when Allow Everything turns on or off. Optional so query doubles
	 * stay small; the runner restarts the query on the next turn when it is missing.
	 */
	setPermissionMode?(mode: ClaudeQueryPermissionMode): Promise<void>;
	/**
	 * Changes Claude Code's flag settings on the running query; `null` clears a
	 * key. Optional so query doubles that never change settings stay small. The
	 * runner refuses a settings change on a query without it.
	 */
	applyFlagSettings?(patch: ClaudeFlagSettingsPatch): Promise<void>;
	supportedModels(): Promise<readonly ClaudeQueryModel[]>;
	supportedCommands(): Promise<readonly ClaudeQueryCommand[]>;
	/** The subagents the session can call. Optional so query doubles stay small. */
	supportedAgents?(): Promise<readonly ClaudeQueryAgent[]>;
	/** Who the session is signed in as. Optional so query doubles stay small. */
	accountInfo?(): Promise<ClaudeAccountDetails>;
	/** The MCP servers the session loaded. Optional so query doubles stay small. */
	mcpServerStatus?(): Promise<readonly ClaudeMcpServerInfo[]>;
	/** Reconnects one MCP server of this query (issue 512). */
	reconnectMcpServer?(name: string): Promise<void>;
	/** Turns one MCP server of this query off or on (issue 512). */
	toggleMcpServer?(name: string, enabled: boolean): Promise<void>;
	/** Reads one `ui://` resource of an MCP server, an MCP App's HTML (issue 513). */
	readMcpResource?(server: string, uri: string): Promise<readonly ClaudeMcpResourceContent[]>;
	/**
	 * The plan's rate-limit windows, or `undefined` when this sign-in has none
	 * (an API key, a cloud provider). Optional so query doubles stay small.
	 */
	usageLimits?(): Promise<readonly ClaudeUsageWindow[] | undefined>;
	/** What fills the context window, as `/context` shows it. Optional so query doubles stay small. */
	contextBreakdown?(): Promise<ClaudeContextBreakdown | undefined>;
	/**
	 * Turns Claude Code's Remote Control on or off for this query and returns
	 * Claude Code's answer (issue 517). Optional so query doubles stay small.
	 */
	remoteControl?(enabled: boolean, name?: string): Promise<unknown>;
	stopTask(taskId: string): Promise<void>;
	close(): void;
}

export interface ClaudePromptMessage {
	readonly type: 'user';
	readonly message: { readonly role: 'user'; readonly content: string };
	readonly parent_tool_use_id: null;
}

export interface ClaudeToolContext {
	readonly signal: AbortSignal;
	readonly decisionReason?: string;
	readonly toolUseID: string;
	/** Agent-tool call that started the subagent making this request, when the SDK names that call. */
	readonly parentToolUseId?: string;
	/** Sub-agent id from the SDK. Mapped to a run id before it is used as `parentRunId`. */
	readonly agentId?: string;
}

export type ClaudeToolPermission =
	| { behavior: 'allow'; updatedInput?: Record<string, unknown> }
	| { behavior: 'deny'; message: string; denial?: PermissionDenial };

/** The host's early verdict on a tool call. Absent when the host would allow it. */
export interface ClaudeToolScreen {
	readonly decision: 'deny' | 'ask';
	readonly message?: string;
}

/** The SDK's elicitation request, as the adapter passes it on (issue 428). */
export interface ClaudeElicitationQueryRequest {
	readonly serverName: string;
	readonly message: string;
	readonly mode?: 'form' | 'url';
	readonly url?: string;
	readonly elicitationId?: string;
	readonly requestedSchema?: Record<string, unknown>;
	readonly title?: string;
}

/** The MCP answer the adapter returns to the SDK. */
export interface ClaudeElicitationQueryResult {
	readonly action: 'accept' | 'decline' | 'cancel';
	readonly content?: Record<string, string | number | boolean | string[]>;
}

/** The permission modes Klawly starts Claude Code in. */
export type ClaudeQueryPermissionMode = 'default' | 'plan' | 'unasked';

export interface ClaudeQueryOptions {
	readonly cwd: string;
	/**
	 * Agent turns load user settings, and project settings in a trusted workspace.
	 * A completion turn omits this.
	 */
	readonly settingSources?: readonly ('user' | 'project')[];
	/** True ignores every MCP configuration on disk, including a project `.mcp.json`. Set in an untrusted workspace. */
	readonly strictMcpConfig?: boolean;
	readonly resume?: string;
	/** With `resume`: the conversation is cut after this chain entry, so later turns are dropped (issue 702). */
	readonly resumeSessionAt?: string;
	/** With `resume`: the query continues a copy of that conversation under a new id. A side question and a rewind set it. */
	readonly forkSession?: true;
	/** False writes no session file. Only a side question sets it, so the chat it asks about keeps no trace. */
	readonly persistSession?: false;
	readonly allowedTools?: readonly string[];
	/** Tools the SDK refuses before `canUseTool` runs. Set for Plan and Ask (see `disallowedToolsForMode`). */
	readonly disallowedTools?: readonly string[];
	readonly additionalDirectories?: readonly string[];
	/** Plugin folders loaded for this query only, without installing them. */
	readonly plugins?: readonly string[];
	/** Built-in tools the query allows, as the SDK's `tools` option (issue 843). Absent keeps every tool. */
	readonly tools?: readonly string[];
	/** False lists no skills, as the SDK's `skills: []` (issue 843). Absent lists them all. */
	readonly skills?: false;
	/** Text added to the system prompt: the workspace's AGENTS.md when no CLAUDE.md imports it (issue 499). */
	readonly systemPrompt?: string;
	readonly maxTurns?: number;
	/** Spend cap in US dollars for this `query()` call (issue 424). */
	readonly maxBudgetUsd?: number;
	readonly model?: string;
	/** Effort and flag settings the query opens with (Phase 33). Absent means the model's defaults. */
	readonly effort?: ClaudeStartSettings['effort'];
	/** Also carries the git settings (attribution, git instructions, worktree base) a session opens with. */
	readonly flagSettings?: NonNullable<ClaudeStartSettings['flagSettings']> & ClaudeGitFlagSettings;
	/** Settings from Klawly's user layer the project does not set (issue 455). They sit below `flagSettings` in the flag layer. */
	readonly userSettings?: Readonly<Record<string, unknown>>;
	/** Claude Code `permissions.deny` entries for the user's list of files Claude cannot read (issue 458). The host enforces the full list; these cover Claude Code's own tools. */
	readonly readDenyRules?: readonly string[];
	/** Paths the sandbox cannot read, from the same list (issue 458). Best effort: it depends on the sandbox being on. */
	readonly sandboxDenyRead?: readonly string[];
	/** MCP servers from Klawly's user layer `.mcp.json` (issue 455), passed beside Klawly's own servers, which win a shared name. */
	readonly userMcpServers?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	/** Model ids Claude Code is asked to list after its own lineup. Only the model probe sets it. */
	readonly modelPicker?: readonly string[];
	/**
	 * Klawly enforces modes itself, so agent turns run in `default`. A side question runs in `plan`.
	 * `unasked` is the confirmed Allow Everything level in Agent mode (issue 694, `claudeRunsUnasked`):
	 * Claude Code runs every tool without its own permission checks, and the SDK adapter is the
	 * only place that names that mode.
	 */
	readonly permissionMode: ClaudeQueryPermissionMode;
	/**
	 * Lets the running query switch into `unasked` later with `setPermissionMode`. Set
	 * whenever the session is at the Allow Everything level, also in Ask and Plan, so a
	 * mode switch back to Agent needs no restart.
	 */
	readonly allowUnasked?: true;
	/** Asks for a final answer that matches a JSON schema; it arrives on the result message as `structured_output`. */
	readonly outputFormat?: { readonly type: 'json_schema'; readonly schema: Record<string, unknown> };
	/** Agent turns stream partials. A completion turn omits this. */
	readonly includePartialMessages?: true;
	/** Asks Claude Code to stream summarized thinking text (`--thinking-display`). Absent leaves its default, which omits it. */
	readonly thinkingDisplay?: 'summarized';
	/** Agent turns keep subagent text. A completion turn omits this. */
	readonly forwardSubagentText?: true;
	readonly pathToClaudeCodeExecutable?: string;
	readonly env: Readonly<Record<string, string>>;
	/** Sandbox, telemetry export and organization policy settings (issue 432). Absent leaves Claude Code's own. */
	readonly security?: ClaudeSecuritySettings;
	/** A dev container or SSH host Claude Code runs on (issue 425). Absent runs it on this machine. */
	readonly executionTarget?: ClaudePreparedTarget;
	/** Where a remote target's stderr goes: the Claude runtime log. */
	readonly log?: (line: string) => void;
	readonly agents?: Readonly<Record<string, ClaudeBuiltinAgent>>;
	readonly abortController: AbortController;
	canUseTool(toolName: string, input: Record<string, unknown>, context: ClaudeToolContext): Promise<ClaudeToolPermission>;
	/**
	 * Called from a PreToolUse hook, before the SDK applies allow rules from the
	 * user's Claude settings. deny blocks the call. The SDK sends it to canUseTool.
	 * `agentId` is the hook input's `agent_id`, present when a subagent makes the call.
	 */
	screenTool(toolName: string, input: Record<string, unknown>, toolUseId?: string, agentId?: string): Promise<ClaudeToolScreen | undefined>;
	/** Answers MCP elicitation in the IDE (issue 428). Absent, Claude Code declines every request. */
	onElicitation?(request: ClaudeElicitationQueryRequest, signal: AbortSignal): Promise<ClaudeElicitationQueryResult>;
	/** Runs `run_in_terminal` calls in a visible terminal (issue 452). Absent leaves the tool out. */
	readonly terminalTool?: ClaudeTerminalToolHost;
	/** Debug mode's log endpoint and Reproduce card (issue 484). Absent leaves those tools out. */
	readonly debugTool?: ClaudeDebugToolHost;
	/** Klawly's settings tools (issue 525), when the runtime can reach a window. */
	readonly settingsTool?: ClaudeSettingsToolHost;
	/** Opens and drives the Agent Browser in the window that owns the chat (issue 466). */
	readonly browserTool?: ClaudeBrowserToolHost;
	/** Saves `klawly_canvas` pages (issue 493). Absent leaves the tool out. */
	readonly canvasTool?: ClaudeCanvasToolHost;
	/** Runs `klawly_delegate` calls as delegated chats (issue 693). Absent leaves the tool out. */
	readonly delegateTool?: ClaudeDelegateToolHost;
	/** Hands `klawly_department` requests to another project's chat (issue 1177). Absent leaves the tool out. */
	readonly departmentTool?: ClaudeDepartmentToolHost;
	/** Starts a new local chat for `klawly_start_agent` (issue 991). Absent leaves the tool out. */
	readonly startAgentTool?: ClaudeStartAgentToolHost;
	/** The review tools over this checkout's stored review (issue 1376). Absent leaves them out. */
	readonly reviewTool?: ClaudeReviewToolHost;
	/** The no-model CI, test and merge tools (issue 844). Absent leaves them out. */
	readonly noModelTool?: ClaudeNoModelToolHost;
	/** Reads this chat's modes for `klawly_mode` (issue 1169). Absent leaves the tool out. */
	readonly modeTool?: () => ClaudeModeState;
	/** Shows one status line on this chat's tab for `klawly_status` (issue 1171). Absent leaves the tool out. */
	readonly statusTool?: (report: { readonly text: string; readonly kind: ClaudeStatusKind }) => void;
	/** Opens the Send Feedback form filled in for `klawly_feedback` (issue 1174). Absent leaves the tool out. */
	readonly feedbackTool?: (request: { readonly title: string; readonly description: string; readonly kind: ClaudeFeedbackToolKind }) => void;
}

/** The tools that wait on CI, run tests and merge with no model call (issue 844). */
export interface ClaudeNoModelToolHost {
	ciWait(args: ClaudeCiWaitArgs): ClaudeNoModelToolResult;
	verify(args: ClaudeVerifyArgs): Promise<ClaudeNoModelToolResult>;
	mergeGate(args: ClaudeMergeGateArgs): Promise<ClaudeNoModelToolResult>;
}

/** Runs one delegated chat for the session and resolves with its answer (issue 693). */
export interface ClaudeDelegateToolHost {
	delegate(args: ClaudeDelegateToolArgs, signal?: AbortSignal): Promise<ClaudeDelegateToolResult>;
}

/** Hands one request to another project's chat for the session (issue 1177). */
export interface ClaudeDepartmentToolHost {
	handOff(args: ClaudeDepartmentToolArgs, signal?: AbortSignal): Promise<ClaudeDepartmentToolResult>;
}

/** Starts one new local chat for the session (issue 991). */
export interface ClaudeStartAgentToolHost {
	start(args: ClaudeStartAgentToolArgs, signal?: AbortSignal): Promise<ClaudeStartAgentToolResult>;
}

/** Saves one Canvas page for the session (issue 493). */
export interface ClaudeCanvasToolHost {
	save(args: ClaudeCanvasToolArgs): Promise<ClaudeCanvasToolResult>;
}

/** Reads or changes a setting in the window that owns the session (issue 525). */
export interface ClaudeBrowserToolHost {
	call(args: ClaudeBrowserToolArgs, signal: AbortSignal | undefined): Promise<ClaudeBrowserToolResult>;
}

export interface ClaudeSettingsToolHost {
	call(args: ClaudeSettingsToolArgs, signal: AbortSignal | undefined): Promise<ClaudeSettingsToolResult>;
}

/** Runs an interactive command where the user can type, and resolves once it ends. */
export interface ClaudeTerminalToolHost {
	run(command: string, reason: string | undefined, signal: AbortSignal | undefined): Promise<ClaudeTerminalRunResult>;
}

export interface ClaudeQueryStart {
	readonly prompt: AsyncIterable<ClaudePromptMessage>;
	readonly options: ClaudeQueryOptions;
}

export type ClaudeQueryFactory = (start: ClaudeQueryStart) => Promise<ClaudeQuery>;
