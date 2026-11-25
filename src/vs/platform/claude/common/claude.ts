/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ClaudeAccountEntry, ClaudeAccountSignIn } from './claudeAccounts.js';
import { ClaudeAccountOverview, ClaudeUsageRefresh } from './claudeAccount.js';
import { ClaudeCommandListing } from './claudeCommands.js';
import { ClaudeMcpAppLoad, ClaudeMcpResourceContent } from './claudeMcpApps.js';
import { ClaudeInlineCompletionRequest } from './claudeAutocomplete.js';
import { ClaudeComparisonJudgeRequest, ClaudeComparisonJudgeResult } from './claudeComparison.js';
import { AgentMode, ContextAttachment } from './claudeContext.js';
import { ClaudeMcpAddRequest, ClaudeMcpRemoveRequest } from './claudeMcpConfig.js';
import { ClaudePluginCommand, ClaudePluginCommandResult } from './claudePlugins.js';
import { ClaudeSandboxStatus } from './claudeSecuritySettings.js';
import { ClaudeContextBreakdown, ClaudeReviewFindingsEvent, NormalizedClaudeEvent, PermissionChoice } from './claudeProtocol.js';
import { ClaudeElicitationAnswer } from './claudeElicitation.js';
import { ClaudeReviewFailure, ClaudeReviewRequest } from './claudeReviewLoop.js';
import { ClaudeSessionPermissions } from './claudeSessionPermissions.js';
import { ClaudeSideQuestionRequest, ClaudeSideQuestionResult } from './claudeSideQuestion.js';
import { ClaudeAutoModelClassification, ClaudeAutoModelRequest } from './claudeAutoModel.js';
import { ClaudeGistReadResult, ClaudeGistRequest, ClaudeGistResult } from './claudeShare.js';
import { ClaudeStatusLineRequest, ClaudeStatusLineResult } from './claudeStatusLine.js';
import { ClaudeEffortLevel, ClaudeSessionSettings } from './claudeSessionSettings.js';
import { ClaudeExecutionTarget } from './claudeExecutionTarget.js';
import { ClaudeTerminalRunRequest, ClaudeTerminalRunResult } from './claudeTerminalRun.js';
import { ClaudeMcpControlAction, ClaudeMcpLog } from './claudeMcpControl.js';
import { ClaudeDebugExtraLines, ClaudeReproductionAnswer, ClaudeReproductionRequest } from './claudeDebugMode.js';
import { ClaudeKlawlyHookRequest, ClaudeKlawlyHookResult } from './claudeKlawlyHooks.js';
import { ClaudeBrowserToolRequest, ClaudeBrowserToolResult } from './claudeBrowserTool.js';
import { ClaudeSettingsToolRequest, ClaudeSettingsToolResult } from './claudeSettingsTool.js';
import { ClaudeDelegateToolRequest, ClaudeDelegateToolResult } from './claudeDelegate.js';
import { ClaudeDepartmentToolRequest, ClaudeDepartmentToolResult } from './claudeDepartment.js';
import { ClaudeStartAgentToolRequest, ClaudeStartAgentToolResult } from './claudeStartAgent.js';
import { ClaudeCloudCapability, ClaudeCloudSendRequest, ClaudeCloudSendResult } from './claudeCloud.js';
import { ClaudeRemoteControlState } from './claudeRemoteControl.js';
import { ClaudeStatusReport } from './claudeStatusTool.js';
import { ClaudeFeedbackToolRequest } from './claudeFeedbackTool.js';
import { ClaudeWorkerProfile } from './claudeWorkerProfile.js';

export const IClaudeRuntimeService = createDecorator<IClaudeRuntimeService>('claudeRuntimeService');

export interface ClaudeModelInfo {
	/** Value passed to the runtime. */
	id: string;
	displayName: string;
	description?: string;
	source: 'runtime' | 'alias' | 'custom';
	/** The canonical id an alias resolves to (`opus` to `claude-opus-5-5`), when the runtime says. */
	resolvedModel?: string;
	/** False or absent: the model takes no effort level. */
	supportsEffort?: boolean;
	/** The levels this model accepts, lowest first. */
	supportedEffortLevels?: readonly ClaudeEffortLevel[];
	/** Claude decides when and how much to think. Thinking can be turned off only on these models. */
	supportsAdaptiveThinking?: boolean;
	supportsFastMode?: boolean;
	supportsAutoMode?: boolean;
	/** A model Claude Code still runs but leaves out of its own list. The menu shows it under Older Models. */
	older?: boolean;
}

export interface ClaudeRuntimeState {
	installed: boolean;
	authenticated: boolean;
	version?: string;
	authMode?: 'claude-account' | 'api-key' | 'enterprise' | 'bedrock' | 'vertex' | 'unknown';
	error?: string;
	/**
	 * Executable the probe found, when it found one. Onboarding shows it and starts
	 * the official sign-in with it. Absent on runtimes that do not probe a binary.
	 */
	binaryPath?: string;
}

export interface ClaudeRawSdkMessage {
	readonly sessionId: string;
	readonly message: unknown;
}

export interface ClaudeRunHandle {
	sessionId: string;
}

export interface BeginClaudeRequest {
	prompt: string;
	cwd: string;
	mode: AgentMode;
	modelId?: string;
	resumeSessionId?: string;
	/** With `resumeSessionId`: the chain entry the conversation is cut after, dropping later turns (issue 702). */
	resumeSessionAt?: string;
	/** The account this chat runs as. Left out, it follows the account in use (issue 1385). */
	accountId?: string;
	attachments?: ContextAttachment[];
	/** Absolute directories the runtime may read outside the workspace. */
	additionalDirectories?: readonly string[];
	/** Absolute workspace folders. Writes outside them ask. Defaults to `cwd`. */
	workspaceFolders?: readonly string[];
	/** Workspace Trust at the time of the request. Unset is treated as untrusted. */
	workspaceTrusted?: boolean;
	/**
	 * Fixture name under `test/claude/fixtures`, without `.jsonl`.
	 * `FakeClaudeRuntimeService` replays that script. The real runner ignores it.
	 */
	fixture?: string;
	/** IDE session id the checkpoint is stored under. */
	checkpointSessionId?: string;
	/** Stable id for this turn's checkpoint file. */
	turnId?: string;
	/** Unsaved editor text captured at turn start. */
	dirtyBuffers?: readonly { readonly path: string; readonly text: string }[];
	/** Allow All Commands and Allow Everything for this session (Phase 27). Absent leaves both off. */
	sessionPermissions?: ClaudeSessionPermissions;
	/** Effort, fast mode, Ultracode and thinking the query opens with (Phase 33). Absent means the model's defaults. */
	sessionSettings?: ClaudeSessionSettings;
	/** Where Claude Code runs: the "Run in" pick (issue 425). Absent runs it on this machine. */
	executionTarget?: ClaudeExecutionTarget;
	/** Absolute plugin folders this session loads without installing them (Try in a New Session). Ignored in an untrusted workspace. */
	plugins?: readonly string[];
	/** Lean or full: what a delegated worker starts with (issue 843). */
	workerProfile?: ClaudeWorkerProfile;
	/**
	 * Most the session's query may spend, in US dollars, before Claude Code stops
	 * it with a failed turn (`maxBudgetUsd`). Absent means no Klawly limit. Set by
	 * background runs such as Compare Models (issue 424).
	 */
	maxBudgetUsd?: number;
	/** Most turns the session's query may take. Absent means no cap (issues 696, 707). Set by automation runs (issue 426). */
	maxTurns?: number;
}

export interface ClaudeUserInput {
	text: string;
	/** Mode for this turn. The runtime keeps the last one when it is absent. */
	mode?: AgentMode;
	/** Workspace Trust now. The runtime keeps the last value when it is absent. */
	workspaceTrusted?: boolean;
	/** Moves the chat to another account from this turn on, as Retry with Another Account does (issue 1385). */
	accountId?: string;
	attachments?: ContextAttachment[];
	/** Same contract as `BeginClaudeRequest.fixture`, for a later turn. */
	fixture?: string;
	/** IDE session id the checkpoint is stored under. */
	checkpointSessionId?: string;
	/** Stable id for this turn's checkpoint file. */
	turnId?: string;
	/** Unsaved editor text captured at turn start. */
	dirtyBuffers?: readonly { readonly path: string; readonly text: string }[];
	/** Replaces the session switches when set. The runtime keeps the last value when it is absent. */
	sessionPermissions?: ClaudeSessionPermissions;
}

/**
 * The only agent engine the workbench is allowed to call.
 * Implementations must not leak Agent SDK types through this interface.
 */
export interface IClaudeRuntimeService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeRuntimeState: Event<ClaudeRuntimeState>;
	readonly onDidEmitEvent: Event<NormalizedClaudeEvent>;
	/**
	 * Raw SDK messages. Present only when the runtime was asked to retain them.
	 * Absent on the fake runtime.
	 */
	readonly onDidEmitRawMessage?: Event<ClaudeRawSdkMessage>;

	getRuntimeState(): Promise<ClaudeRuntimeState>;
	ensureRuntime(): Promise<ClaudeRuntimeState>;
	begin(request: BeginClaudeRequest): Promise<ClaudeRunHandle>;
	send(sessionId: string, input: ClaudeUserInput): Promise<void>;
	/**
	 * True when this session's streaming query will take another user message
	 * without starting a new turn.
	 */
	canSteer(sessionId: string): Promise<boolean>;
	/**
	 * Pushes text into that open streaming query. Resolves false when the
	 * session has no streaming input. Does not start a turn.
	 */
	steer(sessionId: string, text: string): Promise<boolean>;
	interrupt(sessionId: string): Promise<void>;
	/**
	 * Answers a permission.requested event. A request nobody answers stays denied:
	 * it resolves to deny when the session stops. Unknown ids are ignored.
	 */
	resolvePermission(sessionId: string, requestId: string, choice: PermissionChoice): Promise<void>;
	/**
	 * Turns Allow All Commands and Allow Everything on or off for a session that
	 * is running (Phase 27). The host applies them only in a trusted workspace,
	 * and never to credential files or commands. Unknown ids are ignored.
	 * Optional so a runtime from another phase still implements this interface.
	 */
	setSessionPermissions?(sessionId: string, permissions: ClaudeSessionPermissions): Promise<void>;
	/**
	 * Refuses a running session's own tool calls with `message`, or lifts the
	 * refusal when `message` is undefined (issue 847, cost watcher). Delegating,
	 * asking the user and subagents' calls stay allowed. Unknown ids are ignored.
	 */
	setToolRefusal?(sessionId: string, message: string | undefined): Promise<void>;
	/**
	 * Answers an `elicitation.requested` event (issue 428). A request nobody
	 * answers is cancelled when it times out or the session stops. Unknown ids are ignored.
	 */
	resolveElicitation?(sessionId: string, id: string, answer: ClaudeElicitationAnswer): Promise<void>;
	interruptSubagent(sessionId: string, runId: string): Promise<void>;
	disposeSession(sessionId: string): Promise<void>;
	listModels(): Promise<readonly ClaudeModelInfo[]>;
	/**
	 * The signed-in account, plan limits, MCP servers, commands and subagents,
	 * for Klawly Settings. Asks a running session when there is one, otherwise
	 * returns what the last session reported. `refreshUsage` asks Claude Code
	 * for the plan limits again, with no session through a short query that
	 * runs no turn (issue 704). Optional so a runtime from another phase still
	 * implements this interface.
	 */
	getAccountOverview?(refreshUsage?: ClaudeUsageRefresh, accountId?: string): Promise<ClaudeAccountOverview>;
	/**
	 * The slash commands (skills included) and subagents Claude Code offers in
	 * `cwd`, for the `/` menu of a chat that has sent nothing yet (issue 968).
	 * Reuses what a session reported, else asks with a short query that runs no
	 * turn. Empty when Claude Code is not installed or cannot list. Optional, as above.
	 */
	listCommands?(cwd: string): Promise<ClaudeCommandListing>;
	/**
	 * Signs Claude Code out with `claude auth logout`, forgets the account the
	 * last session reported, and probes again (issue 536). Resolves with the new
	 * state; rejects with Claude Code's message when it fails. Credentials stay
	 * in Claude Code's own store: nothing here reads or deletes them. Optional,
	 * as above.
	 */
	logout?(): Promise<ClaudeRuntimeState>;
	/**
	 * The Claude accounts of Switch Account (issue 450): the default sign-in first,
	 * then each added one, with what its own `auth status` reports now. Optional,
	 * as above: missing means one account only.
	 */
	listAccounts?(): Promise<readonly ClaudeAccountEntry[]>;
	/**
	 * Makes the folder a new account signs in to. The workbench runs `claude auth login`
	 * with the returned environment, then calls {@link finishAddAccount}.
	 */
	addAccount?(): Promise<ClaudeAccountSignIn>;
	/**
	 * Keeps the new account if its folder is signed in now, and switches to it;
	 * an email already in the list switches to that account instead. Otherwise
	 * removes the folder and resolves undefined.
	 */
	finishAddAccount?(id: string): Promise<ClaudeAccountEntry | undefined>;
	/**
	 * Uses this account for every new Claude process, in every window. Open
	 * sessions go on under it from their next turn. Resolves with the new state.
	 */
	switchAccount?(id: string): Promise<ClaudeRuntimeState>;
	/**
	 * Runs `claude auth logout` for this account. An added account's folder is
	 * removed then, its own files only: what it links to stays. Signing out the
	 * account in use goes back to the default one.
	 */
	signOutAccount?(id: string): Promise<ClaudeRuntimeState>;
	/**
	 * Saves an MCP server in Claude Code's own config, through
	 * `claude mcp add-json`, so sessions started afterwards load it. Rejects
	 * with Claude Code's message when it refuses. Optional so a runtime from
	 * another phase still implements this interface.
	 */
	addMcpServer?(request: ClaudeMcpAddRequest): Promise<void>;
	/** Removes an MCP server from one scope, through `claude mcp remove`. Optional, as above. */
	removeMcpServer?(request: ClaudeMcpRemoveRequest): Promise<void>;
	/** Reconnects or turns off or on an MCP server of the running session, and returns the new overview (issue 512). */
	controlMcpServer?(name: string, action: ClaudeMcpControlAction): Promise<ClaudeAccountOverview>;
	/**
	 * The MCP App that the tool `toolName` of runtime session `sessionId` draws
	 * (issue 513), read from its server. `undefined` when the session is not
	 * running or the tool draws no app. Optional, as above.
	 */
	loadMcpApp?(sessionId: string, toolName: string): Promise<ClaudeMcpAppLoad | undefined>;
	/** One resource of an MCP server that runtime session `sessionId` runs, for an MCP App's `resources/read` (issue 897). Rejects when the session or the server is not running. Optional, as above. */
	readMcpResource?(sessionId: string, server: string, uri: string): Promise<readonly ClaudeMcpResourceContent[]>;
	/** The newest log Claude Code wrote for an MCP server, with secrets removed (issue 512). */
	readMcpServerLog?(name: string, cwd: string): Promise<ClaudeMcpLog>;
	/**
	 * Runs one `claude plugin` command (install, update, uninstall, add or remove
	 * a marketplace) with its JSON result, so the terminal and Klawly see the same
	 * plugins. Optional, as above.
	 */
	runPluginCommand?(command: ClaudePluginCommand): Promise<ClaudePluginCommandResult>;
	/**
	 * Whether Claude Code's sandbox can start on this machine and what to install
	 * first (issue 432). Optional, as above.
	 */
	getSandboxStatus?(): Promise<ClaudeSandboxStatus>;
	/**
	 * Whether the installed Claude Code can start, message and teleport cloud
	 * sessions (issue 516), from `claude --help`. Optional, as above.
	 */
	getCloudCapability?(): Promise<ClaudeCloudCapability>;
	/** Queues one message into a running cloud session through `claude -p --cloud`. Optional, as above. */
	sendToCloudSession?(request: ClaudeCloudSendRequest): Promise<ClaudeCloudSendResult>;
	/**
	 * Turns Claude Code's Remote Control on or off for a running session, so the
	 * Claude app and claude.ai/code can follow and answer it (issue 517). Rejects
	 * when the session has no running query or Claude Code refuses. Optional, as above.
	 */
	setRemoteControl?(sessionId: string, enabled: boolean, name?: string): Promise<ClaudeRemoteControlState>;
	/** The session's Remote Control while it is on. Optional, as above. */
	getRemoteControl?(sessionId: string): Promise<ClaudeRemoteControlState | undefined>;
	setModel(sessionId: string, modelId: string): Promise<void>;
	/**
	 * What fills the session's context window, by category, as `/context`
	 * shows it. `undefined` when the session has no running query or Claude
	 * Code does not report it. Optional so a runtime from another phase still
	 * implements this interface.
	 */
	getContextBreakdown?(sessionId: string): Promise<ClaudeContextBreakdown | undefined>;
	/**
	 * Replaces the session's effort, fast mode, Ultracode and thinking choices
	 * (Phase 33). A running query changes without a restart; a starting one
	 * applies them once it opens. Emits `session.settingsChanged` once they took
	 * effect, and rejects with nothing changed when the runtime refuses them.
	 * Optional so a runtime from another phase still implements this interface.
	 */
	setSessionSettings?(sessionId: string, settings: ClaudeSessionSettings): Promise<void>;
	/**
	 * One no-tools, single-turn completion. Optional so a runtime from another
	 * phase still implements this interface. Missing means no suggestion.
	 * Cancel with `cancelInline`. The shared-process proxy does not forward tokens.
	 */
	completeInline?(request: ClaudeInlineCompletionRequest): Promise<string | undefined>;
	cancelInline?(requestId: string): Promise<void>;
	/**
	 * Compare Models judge (issue 424): one no-tools structured query that ranks
	 * every run of a comparison. Resolves with a failure instead of rejecting.
	 * Optional so a runtime from another phase still implements this interface.
	 */
	judgeComparison?(request: ClaudeComparisonJudgeRequest): Promise<ClaudeComparisonJudgeResult>;
	cancelComparisonJudge?(requestId: string): Promise<void>;
	/**
	 * Auto model (issue 521): one no-tools structured query on Haiku that rates
	 * how hard a prompt is, so the composer can pick the model and effort for
	 * the turn. Resolves with a failure instead of rejecting. Optional so a
	 * runtime from another phase still implements this interface.
	 */
	classifyAutoModel?(request: ClaudeAutoModelRequest): Promise<ClaudeAutoModelClassification>;
	cancelAutoModel?(requestId: string): Promise<void>;
	/**
	 * The structured review pass (issue 431): one read-only query over the diff
	 * whose answer is a list of findings. Never rejects. Optional so a runtime
	 * from another phase still implements this interface. Cancel with `cancelReview`.
	 */
	reviewChanges?(request: ClaudeReviewRequest): Promise<ClaudeReviewResult>;
	cancelReview?(reviewId: string): Promise<void>;
	/**
	 * Answers a side question about a chat from an unsaved fork of its Claude
	 * Code conversation, with read-only tools (issue 433). The chat's own
	 * session and running turn are untouched. Optional so a runtime from
	 * another phase still implements this interface. Cancel with `cancelSideQuestion`.
	 */
	askSideQuestion?(request: ClaudeSideQuestionRequest): Promise<ClaudeSideQuestionResult>;
	cancelSideQuestion?(requestId: string): Promise<void>;
	/** Publishes a shared chat as a secret gist with the user's GitHub CLI (issue 490). Never rejects. */
	createSecretGist?(request: ClaudeGistRequest): Promise<ClaudeGistResult>;
	/** Reads a shared chat's Markdown from a gist link with the user's GitHub CLI (issue 684). Never rejects. */
	readSharedGist?(link: string): Promise<ClaudeGistReadResult>;
	/** Runs Claude Code's `statusLine` command from the Claude settings and returns its first line (issue 515). Never rejects. */
	runStatusLine?(request: ClaudeStatusLineRequest): Promise<ClaudeStatusLineResult>;
	/**
	 * A shell command is waiting while `claude.agent.saveBeforeCommands` is
	 * `always` or `prompt`. The window that owns the session saves (or asks), then
	 * calls `resolveSaveBeforeCommand`. Optional: the fake runtime runs no commands.
	 */
	readonly onDidRequestSaveBeforeCommand?: Event<ClaudeSaveBeforeCommandRequest>;
	/** Lets the waiting command run. Unknown ids are ignored. */
	resolveSaveBeforeCommand?(sessionId: string, requestId: string): Promise<void>;
	/**
	 * Claude called `run_in_terminal` (issue 452). The window that owns the
	 * session runs the command in a visible terminal and calls `resolveTerminalRun`
	 * once it ends. Optional: the fake runtime runs no commands.
	 */
	readonly onDidRequestTerminalRun?: Event<ClaudeTerminalRunRequest>;
	/** Answers the waiting tool call. Unknown ids are ignored. */
	resolveTerminalRun?(sessionId: string, requestId: string, result: ClaudeTerminalRunResult): Promise<void>;
	/**
	 * Claude called `request_reproduction` in Debug mode (issue 484). The window
	 * that owns the session shows the Reproduce card, calls `startDebugCapture`
	 * on Start Capturing and `resolveReproduction` when the user is done.
	 */
	readonly onDidRequestReproduction?: Event<ClaudeReproductionRequest>;
	/** Starts keeping the lines the session's log sink receives. Unknown ids are ignored. */
	startDebugCapture?(sessionId: string, requestId: string): Promise<void>;
	/** Answers the waiting tool call with the captured lines, or a cancel. Unknown ids are ignored. */
	resolveReproduction?(sessionId: string, requestId: string, answer: ClaudeReproductionAnswer, extra?: ClaudeDebugExtraLines): Promise<void>;
	/**
	 * Runs the hooks on one of Klawly's own events (issue 514) from the Claude
	 * settings files, node-side. Never rejects. Optional: missing means no hooks run.
	 */
	runKlawlyHooks?(request: ClaudeKlawlyHookRequest): Promise<ClaudeKlawlyHookResult>;
	/** A browser action from Claude for the window that owns the chat to run, answered through `resolveBrowserRequest` (issue 466). */
	readonly onDidRequestBrowser?: Event<ClaudeBrowserToolRequest>;
	resolveBrowserRequest?(sessionId: string, requestId: string, result: ClaudeBrowserToolResult): Promise<void>;
	/**
	 * Claude called `klawly_settings_find` or `klawly_settings_set` (issue 525). The
	 * window that owns the session reads or changes the setting and calls
	 * `resolveSettingsRequest`. A change was approved on a permission card first.
	 */
	readonly onDidRequestSettings?: Event<ClaudeSettingsToolRequest>;
	/** Answers the waiting settings tool call. Unknown ids are ignored. */
	resolveSettingsRequest?(sessionId: string, requestId: string, result: ClaudeSettingsToolResult): Promise<void>;
	/**
	 * Claude called `klawly_delegate` (issue 693). The window that owns the
	 * session runs a delegated chat and calls `resolveDelegateRequest` with its
	 * answer. Optional: the fake runtime delegates nothing.
	 */
	readonly onDidRequestDelegate?: Event<ClaudeDelegateToolRequest>;
	/** Answers the waiting delegate call. Unknown ids are ignored. */
	resolveDelegateRequest?(sessionId: string, requestId: string, result: ClaudeDelegateToolResult): Promise<void>;
	/**
	 * Claude called `klawly_department` (issue 1177). The window that owns the session
	 * hands the request to the other project's chat and calls `resolveDepartmentRequest`.
	 * Optional: the fake runtime hands nothing over.
	 */
	readonly onDidRequestDepartment?: Event<ClaudeDepartmentToolRequest>;
	/** Answers the waiting department call. Unknown ids are ignored. */
	resolveDepartmentRequest?(sessionId: string, requestId: string, result: ClaudeDepartmentToolResult): Promise<void>;
	/**
	 * Claude called `klawly_start_agent` (issue 991). The window that owns the session
	 * starts the chat and calls `resolveStartAgentRequest`.
	 */
	readonly onDidRequestStartAgent?: Event<ClaudeStartAgentToolRequest>;
	/** Answers the waiting start_agent call. Unknown ids are ignored. */
	resolveStartAgentRequest?(sessionId: string, requestId: string, result: ClaudeStartAgentToolResult): Promise<void>;
	/**
	 * A background tool finished and has one message for the chat that started
	 * it, such as the result of `ci_wait` (issue 844). The window that owns the
	 * session puts it into the chat. Optional: the fake runtime sends none.
	 */
	readonly onDidRequestSessionMessage?: Event<ClaudeSessionMessageRequest>;
	/**
	 * Claude called `klawly_status` (issue 1171). The window that owns the session
	 * shows the line on the chat tab. Optional: the fake runtime reports none.
	 */
	readonly onDidReportStatus?: Event<ClaudeStatusReport>;
	/**
	 * Claude called `klawly_feedback` (issue 1174). The window that owns the session opens the
	 * Send Feedback form filled in; nothing is sent until the user clicks Send. Optional: the fake runtime sends none.
	 */
	readonly onDidRequestFeedback?: Event<ClaudeFeedbackToolRequest>;
}

/** One message a background tool puts into the chat `sessionId` (issue 844). */
export interface ClaudeSessionMessageRequest {
	readonly sessionId: string;
	readonly text: string;
}

export interface ClaudeSaveBeforeCommandRequest {
	readonly sessionId: string;
	/** Id `resolveSaveBeforeCommand` answers with. */
	readonly requestId: string;
	/** The command that will run, for the question shown in `prompt` mode. */
	readonly command: string;
	readonly mode: 'always' | 'prompt';
}

/** What `reviewChanges` returns: the normalized findings event, or why there is none. */
export type ClaudeReviewResult =
	| { readonly ok: true; readonly event: ClaudeReviewFindingsEvent }
	| { readonly ok: false; readonly reviewId: string; readonly failure: ClaudeReviewFailure };
