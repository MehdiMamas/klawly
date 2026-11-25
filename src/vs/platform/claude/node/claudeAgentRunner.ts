/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { claudeReadDenyRules, claudeSandboxDenyRead } from '../common/claudeReadRules.js';
import { claudeModeState } from '../common/claudeModeTool.js';
import { ClaudeStatusReport } from '../common/claudeStatusTool.js';
import { ClaudeFeedbackToolRequest } from '../common/claudeFeedbackTool.js';
import { homedir } from 'os';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isAbsolute, join, posix } from '../../../base/common/path.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import product from '../../product/common/product.js';
import { CLAUDE_CANVAS_FOLDER } from '../common/claudeCanvas.js';
import { pruneClaudeCanvases, saveClaudeCanvas } from './claudeCanvasFiles.js';
import { CLAUDE_DELEGATE_PLUGIN_FOLDER, CLAUDE_DELEGATE_TOOL_ID, claudeDelegateGuidance, ClaudeDelegateToolArgs, ClaudeDelegateToolResult } from '../common/claudeDelegate.js';
import { ClaudeDepartmentToolArgs, ClaudeDepartmentToolResult } from '../common/claudeDepartment.js';
import { CLAUDE_START_AGENT_TOOL_ID, ClaudeStartAgentToolArgs, ClaudeStartAgentToolResult } from '../common/claudeStartAgent.js';
import { ensureClaudeDelegatePlugin } from './claudeDelegatePlugin.js';
import { ClaudeModelInfo } from '../common/claude.js';
import { ClaudeAccountDetails, ClaudeAccountOverview, ClaudeMcpServerInfo, ClaudeUsageRefresh, ClaudeUsageWindow } from '../common/claudeAccount.js';
import { claudeMcpAppFromContents, ClaudeMcpAppLoad, ClaudeMcpResourceContent, findClaudeMcpApp } from '../common/claudeMcpApps.js';
import { CheckpointDirtyBuffer, DEFAULT_CHECKPOINT_RETENTION_DAYS } from '../common/claudeCheckpoints.js';
import { ClaudeCheckpointStore } from '../common/claudeCheckpointStore.js';
import { ClaudeSaveBeforeCommandsMode } from '../common/claudeConfiguration.js';
import { AgentMode } from '../common/claudeContext.js';
import { allowedToolsForMode, disallowedToolsForMode, evaluateModePolicy } from '../common/claudeModePolicy.js';
import { CLAUDE_QUESTION_TOOL, ClaudeQuestion, readClaudeQuestions } from '../common/claudeQuestion.js';
import { PermissionDecision } from '../common/claudePermissions.js';
import { ClaudeCommandInfo, ClaudeCommandListing, ClaudeSubagentInfo } from '../common/claudeCommands.js';
import { claudeConfigDirectory, claudePlanDirectory, klawlyPlanDirectory } from '../common/claudePlanFiles.js';
import { classifyTool, ClaudeContextBreakdown, NormalizedClaudeEvent, PermissionOutcome, PermissionRequest } from '../common/claudeProtocol.js';
import { resumeFailureMessage } from '../common/claudeResume.js';
import { canOfferAllowAllCommands, claudeAutonomyInstructions, claudeRunsUnasked, claudeSessionAskReason, ClaudeSessionPermissions } from '../common/claudeSessionPermissions.js';
import { claudeAutoReviewApplies, ClaudeAutoReviewRequest, ClaudeAutoReviewToggles, ClaudeAutoReviewVerdict } from '../common/claudeAutoReview.js';
import { claudeGitFlagSettings, ClaudeGitSettings } from '../common/claudeGitSettings.js';
import { ClaudeSecuritySettings } from '../common/claudeSecuritySettings.js';
import { ClaudeExecutionTarget, isRemoteClaudeExecutionTarget } from '../common/claudeExecutionTarget.js';
import { CLAUDE_REMOTE_SCHEME, claudeRemoteUri, IClaudeRemoteFilesService, parseClaudeRemoteUri } from '../common/claudeRemoteFiles.js';
import { ClaudeAgentsFilesSettings, ClaudeInstructionSource } from '../common/claudeAgentsFiles.js';
import { ClaudeWorkerProfile, claudeWorkerProfileShape, claudeWorkerSettingSources } from '../common/claudeWorkerProfile.js';
import { claudeMakerInstructions } from '../common/claudeMakerPrompt.js';
import { claudeWorkRulesInstructions } from '../common/claudeWorkRules.js';
import { ClaudeVerifyUi, claudeVerifyUiInstructions } from '../common/claudeVerifyUi.js';
import { claudeReplyStyleInstructions, ClaudeReplyStyle, joinClaudeSystemPrompt } from '../common/claudeReplyStyle.js';
import { claudePlanDependsInstructions } from '../common/claudePlanDependsPrompt.js';
import { CLAUDE_EFFORT_LEVELS, claudeFlagSettingsPatch, ClaudeSessionSettings, claudeStartSettings, DEFAULT_CLAUDE_SESSION_SETTINGS, isClaudeEffortLevel, sameClaudeSessionSettings } from '../common/claudeSessionSettings.js';
import { claudePolicyToolCall, ClaudeTerminalRunResult } from '../common/claudeTerminalRun.js';
import { selectBuiltinAgents } from './claudeBuiltinAgents.js';
import { readClaudeCommandCatalog, readClaudeSkillNames, toClaudeSubagentInfo } from './claudeCommandCatalog.js';
import { ClaudeSettingsToolArgs, ClaudeSettingsToolResult } from '../common/claudeSettingsTool.js';
import { ClaudeElicitationBridge, runClaudeElicitation } from './claudeElicitationBridge.js';
import { classifyAgentFailure } from './claudeFailure.js';
import { claudeSandboxFailureMessage } from './claudeSecurityOptions.js';
import { resolveClaudeAgentsFiles, withClaudeInstructionSources } from './claudeAgentsFiles.js';
import { resolveClaudeUserLayer } from './claudeUserLayer.js';
import { resolveClaudeProjectMemory } from './claudeProjectMemory.js';
import { CLAUDE_USER_LAYER_PLUGIN_FOLDER, claudeUserLayerDirectory, claudeUserLayerMcpScope, ClaudeUserLayerSettings } from '../common/claudeUserLayer.js';
import { ClaudeCommandRunner, claudeContainerPathToLocal, ClaudeExecutionTargetError, ClaudePreparedTarget, ClaudeTargetHost, claudeTargetFallbackNotice, defaultClaudeTargetHost, prepareClaudeExecutionTarget, runClaudeTargetCommand, withClaudeExecutionTarget } from './claudeExecutionTarget.js';
import { ClaudeModelProbe, probeClaudeCommands, probeClaudeModels, probeClaudeUsage } from './claudeModelProbe.js';
import { ClaudeRemoteFiles } from './claudeRemoteFiles.js';
import { ClaudePermissionHost, PermissionScope, PermissionVerdict, SESSION_STOPPED_MESSAGE } from './claudePermissionHost.js';
import { ClaudeProcessRegistry, DEFAULT_CLAUDE_SESSION_TIMEOUT_MS } from './claudeProcessRegistry.js';
import { claudeDebugToolHost, ClaudeDebugToolProvider } from './claudeDebugLogSink.js';
import { CLAUDE_DUPLICATE_SESSION_MANAGER_TOOLS, CLAUDE_MERGE_GATE_TOOL_ID, claudeSleepPollingProblem } from '../common/claudeNoModelTools.js';
import type { ClaudeNoModelTools } from './claudeNoModelTools.js';
import { createClaudeReviewToolHost } from './claudeReviewHost.js';
import { ClaudeBrowserToolArgs, ClaudeBrowserToolResult } from '../common/claudeBrowserTool.js';
import { ClaudePromptMessage, ClaudeQuery, ClaudeQueryAgent, ClaudeQueryCommand, ClaudeQueryFactory, ClaudeQueryModel, ClaudeQueryOptions, ClaudeQueryPermissionMode, ClaudeCanvasToolHost, ClaudeDelegateToolHost, ClaudeDepartmentToolHost, ClaudeNoModelToolHost, ClaudeSettingsToolHost, ClaudeBrowserToolHost, ClaudeStartAgentToolHost, ClaudeTerminalToolHost, ClaudeToolContext, ClaudeToolPermission, ClaudeToolScreen } from './claudeQuery.js';
import { runClaudeQuestion } from './claudeQuestionRequest.js';
import { claudeProcessEnvironment } from './claudeRuntime.js';
import { claudeChainAnchor, ClaudeInitMetadata, ClaudeNormalizerState, createClaudeNormalizerState, normalizeClaudeMessage } from './claudeStreamNormalizer.js';
import { claudeSupportsThinkingDisplay } from './claudeVersion.js';
import { ClaudeMcpControlAction } from '../common/claudeMcpControl.js';

/** Claude Code's tool for leaving plan mode: a choice for the user, never a permission (issue 694). */
const CLAUDE_EXIT_PLAN_TOOL = 'ExitPlanMode';

/** The record an Ask-mode write denial leaves in the timeline. */
const ASK_DENIAL_RECORD = 'Ask mode never changes files. Switch to Agent to allow changes.';

/** Tools the cost watcher's refusal lets through: delegating, loading the delegate tool, asking and leaving plan mode (issue 847). */
const COST_WATCHER_EXEMPT_TOOLS = new Set([CLAUDE_DELEGATE_TOOL_ID, 'ToolSearch', 'AskUserQuestion', CLAUDE_EXIT_PLAN_TOOL]);

export interface ClaudePermissionBridge {
	request(request: {
		readonly sessionId: string;
		/** The tool call id. The renderer answers with it. */
		readonly requestId: string;
		readonly toolName: string;
		readonly input: Record<string, unknown>;
		readonly reason?: string;
		readonly signal: AbortSignal;
	}): Promise<PermissionDecision>;
}

export const denyClaudePermissionBridge: ClaudePermissionBridge = {
	request: async () => ({ behavior: 'deny', message: 'No permission bridge is configured.' }),
};

export interface ClaudeAgentRunRequest {
	readonly sessionId: string;
	readonly prompt: string;
	readonly cwd: string;
	readonly modelId?: string;
	/** Mode for this turn. Defaults to agent. */
	readonly mode?: AgentMode;
	readonly resumeSessionId?: string;
	/** With `resumeSessionId`: the chain entry the resumed conversation stops at (issue 702). */
	readonly resumeSessionAt?: string;
	/** The account this chat uses. Absent, it follows the account in use (issue 1385). */
	readonly accountId?: string;
	readonly allowedTools?: readonly string[];
	readonly additionalDirectories?: readonly string[];
	readonly maxTurns?: number;
	readonly builtInAgents?: boolean;
	/** Git settings the session's queries open with. Absent leaves Claude Code's own. */
	readonly gitSettings?: ClaudeGitSettings;
	/** Sandbox, telemetry export and policy settings the session's queries open with. Absent leaves Claude Code's own. */
	readonly securitySettings?: ClaudeSecuritySettings;
	/** Where Claude Code runs (issue 425). Absent runs it on this machine. */
	readonly executionTarget?: ClaudeExecutionTarget;
	readonly executablePath?: string;
	/** The Claude Code version the probe found, so the query asks only for flags it takes. */
	readonly runtimeVersion?: string;
	readonly permissionBridge?: ClaudePermissionBridge;
	/** Absolute workspace folders. Defaults to cwd. */
	readonly workspaceFolders?: readonly string[];
	/** Workspace Trust. Unset means untrusted, so a write or command asks and cannot be remembered. */
	readonly workspaceTrusted?: boolean;
	/** IDE session the checkpoint JSON is stored under. Defaults to the runtime session id. */
	readonly checkpointSessionId?: string;
	/** Turn id used as the checkpoint file name. */
	readonly turnId?: string;
	/** Unsaved editor buffers captured at turn start. */
	readonly dirtyBuffers?: readonly CheckpointDirtyBuffer[];
	/** Allow All Commands and Allow Everything for this session. Absent leaves both off. */
	readonly sessionPermissions?: ClaudeSessionPermissions;
	/** Effort, fast mode, Ultracode and thinking the query opens with. Absent means the model's defaults. */
	readonly sessionSettings?: ClaudeSessionSettings;
	/** Absolute plugin folders the session loads without installing them. Only a trusted workspace loads them. */
	readonly plugins?: readonly string[];
	/** Lean or full: what a delegated worker starts with (issue 843). */
	readonly workerProfile?: ClaudeWorkerProfile;
	/** Spend cap in US dollars for each query the session opens (issue 424). */
	readonly maxBudgetUsd?: number;
	/** Which open agent files (AGENTS.md, `.agents/skills`) the session passes (issue 499). Absent passes both. */
	readonly agentsFiles?: ClaudeAgentsFilesSettings;
	/** How Claude shapes its replies (issue 462). Absent is the default style. */
	readonly replyStyle?: ClaudeReplyStyle;
	/** Maker mode: adds the Maker section to the system prompt (issue 1184). Absent is a normal user. */
	readonly makerMode?: boolean;
	readonly workRules?: boolean;
	readonly verifyUi?: ClaudeVerifyUi;
	/** Whether `~/.claude` loads beside Klawly's own user layer (issue 455). Absent loads it. */
	readonly userLayer?: ClaudeUserLayerSettings;
}

/** Per-turn values `send` takes besides the text, mode and trust. */
export interface ClaudeAgentTurnOptions {
	readonly turnId?: string;
	readonly checkpointSessionId?: string;
	readonly dirtyBuffers?: readonly CheckpointDirtyBuffer[];
	/** Replaces the session switches when set. */
	readonly sessionPermissions?: ClaudeSessionPermissions;
	/** Moves the chat to another account from this turn on (issue 1385). */
	readonly accountId?: string;
}

/**
 * Setting sources for a query. An untrusted workspace loads only the user's own
 * settings: project `.claude/settings.json` hooks, project MCP servers, and
 * repository instructions are untrusted input until the user trusts the folder.
 * `user` is Claude Code's `~/.claude`, which the user can leave out (issue 455);
 * Klawly's own user layer reaches the query through its options either way.
 */
export function claudeSettingSourcesFor(trusted: boolean, useClaudeCodeSetup = true): readonly ('user' | 'project')[] {
	return [...useClaudeCodeSetup ? ['user' as const] : [], ...trusted ? ['project' as const] : []];
}

/** A shell command is about to run and the workbench may save unsaved editors first. */
export interface ClaudeBeforeCommandRequest {
	readonly sessionId: string;
	readonly command: string;
	readonly mode: Exclude<ClaudeSaveBeforeCommandsMode, 'never'>;
	/** Aborted when the call or the session ends. */
	readonly signal: AbortSignal;
}

export interface ClaudeTerminalRunToolRequest {
	readonly sessionId: string;
	readonly command: string;
	readonly reason?: string;
	readonly cwd: string;
	/** Aborted when Claude Code cancels the call or the session ends. */
	readonly signal: AbortSignal;
}

export interface ClaudeCapabilities {
	readonly commands: readonly ClaudeQueryCommand[];
	readonly skills: readonly string[];
	readonly models: readonly ClaudeModelInfo[];
	readonly version?: string;
}

interface RunnerSession {
	queue: ClaudeEventQueue;
	stream: ClaudePromptStream;
	cwd: string;
	mode: AgentMode;
	/** The `disallowedTools` the live query was opened with, joined. A mode with other limits restarts the query. */
	queryLimits?: string;
	/** Workspace Trust the live query was opened with. It fixed the setting sources. */
	queryTrusted?: boolean;
	/** The Allow Everything instructions the live query's system prompt was opened with (issue 741). */
	queryAutonomy?: string;
	/** The account folder the live query was opened with, '' for the default account (issue 450). */
	queryAccount?: string;
	/** The account this chat chose. Absent, the chat follows the account in use (issue 1385). */
	accountId?: string;
	/** The permission mode the live query runs in now (issue 694). */
	queryPermissionMode?: ClaudeQueryPermissionMode;
	/** True when the live query was opened able to switch into `unasked` without a restart. */
	queryAllowsUnasked?: boolean;
	modelId?: string;
	allowedTools?: readonly string[];
	additionalDirectories?: readonly string[];
	/** Plugin folders to try without installing them. */
	plugins?: readonly string[];
	workerProfile?: ClaudeWorkerProfile;
	agentsFiles?: ClaudeAgentsFilesSettings;
	replyStyle?: ClaudeReplyStyle;
	makerMode?: boolean;
	workRules?: boolean;
	verifyUi?: ClaudeVerifyUi;
	userLayer?: ClaudeUserLayerSettings;
	/** The user layer servers the live query was given, so Settings shows them as yours. */
	userMcpServers?: readonly string[];
	/** What the live query was given from AGENTS.md and `.agents/skills`, added to its `session.started`. */
	instructionSources?: readonly ClaudeInstructionSource[];
	maxTurns?: number;
	maxBudgetUsd?: number;
	builtInAgents: boolean;
	gitSettings?: ClaudeGitSettings;
	securitySettings?: ClaudeSecuritySettings;
	executionTarget?: ClaudeExecutionTarget;
	runtimeVersion?: string;
	/** The dev container or SSH host once it answered the probes. Prepared once per session. */
	preparedTarget?: ClaudePreparedTarget;
	/** Why a resumed session left its target for this machine, sent once on the next `session.started`. */
	targetNotice?: string;
	executablePath?: string;
	permissionBridge: ClaudePermissionBridge;
	workspaceFolders: readonly string[];
	trusted: boolean;
	sdkSessionId?: string;
	/** The first request of a fresh chat, until the runner has asked for the chat's title. */
	titlePrompt?: string;
	/** Resume id for the query that has not emitted `session.started` yet. */
	resumeAttempt?: string;
	/** Chain entry the first resumed query stops at, until it emits `session.started` (issue 702). */
	resumeAt?: string;
	/** The open turn's last main-thread chain entry, sent with `session.completed`. */
	turnAnchor?: string;
	readonly tasks: Map<string, string>;
	/** SDK sub-agent id (`agentID`) to the agent-tool call id used as the run id. */
	readonly agentRuns: Map<string, string>;
	readonly normalizer: ClaudeNormalizerState;
	abort: AbortController;
	launching: boolean;
	generation: number;
	/** Model requested while `query()` is still starting. Applied after track. */
	pendingModel?: string;
	modelBeforePending?: string;
	readonly modelWaiters: Array<{ readonly modelId: string; resolve: () => void; reject: (error: unknown) => void }>;
	/** Effort, fast mode, Ultracode and thinking the user chose. */
	settings: ClaudeSessionSettings;
	/** What the live query runs with. Undefined while no query is open. */
	appliedSettings?: ClaudeSessionSettings;
	/** Settings the user had before a change that waits for `query()` to start. */
	settingsBeforePending?: ClaudeSessionSettings;
	readonly settingsWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
	checkpointSessionId: string;
	turnId?: string;
	dirtyBuffers?: readonly CheckpointDirtyBuffer[];
	/** Tool call id to the absolute path (or `claude-remote:` uri) snapshotted before that write. */
	readonly writeCaptures: Map<string, string>;
	/** Call ids of shell commands whose file changes settle when the command ends. */
	readonly shellCaptures: Set<string>;
}

/** What the runner knows when it names a chat. */
export interface ClaudeSessionTitleRequest {
	readonly sessionId: string;
	/** Claude Code's conversation id, when the query reported one. */
	readonly claudeSessionId?: string;
	readonly cwd: string;
	readonly firstPrompt: string;
	readonly executablePath?: string;
}

/** Where a model probe runs when no session is up. */
export type ClaudeModelProbeTarget = Pick<ClaudeModelProbe, 'cwd' | 'executablePath' | 'timeoutMs'>;

/** Plan limits younger than this are reused when a page asks only for limits that are not stale (issue 704). */
export const CLAUDE_USAGE_FRESH_MS = 60_000;
/** Plan limits younger than this are reused even when asked for now, so several pages asking at once make one call. */
export const CLAUDE_USAGE_RECENT_MS = 5_000;

export interface ClaudeAgentRunnerOptions {
	readonly queryFactory: ClaudeQueryFactory;
	readonly registry: ClaudeProcessRegistry;
	readonly timeoutMs?: number;
	readonly homeDirectory?: string;
	/** The product's per-user data folder name, such as `.klawly`. Defaults to the running product's. */
	readonly dataFolderName?: string;
	readonly log?: (line: string) => void;
	/** Policy, grants, and history. Defaults to the built-in policy. */
	readonly permissionHost?: ClaudePermissionHost;
	/** Used when the session queue is already closed, so model changes still surface. */
	readonly onEvent?: (event: NormalizedClaudeEvent) => void;
	/** When true, each SDK message is also passed to `onRawMessage`. */
	readonly retainRawMessages?: () => boolean;
	readonly onRawMessage?: (sessionId: string, message: unknown) => void;
	/** Absent in tests that do not exercise snapshots. */
	readonly checkpoints?: ClaudeCheckpointStore;
	readonly checkpointsEnabled?: () => boolean;
	readonly retentionDays?: () => number;
	/** Environment for each query. Defaults to the allowlist with telemetry off. */
	readonly processEnvironment?: () => Readonly<Record<string, string>>;
	/** The environment signed in as one account, for a chat that chose its own (issue 1385). */
	readonly accountEnvironment?: (accountId: string) => Readonly<Record<string, string>>;
	/** `claude.agent.saveBeforeCommands`, read before each shell command. Absent means `never`. */
	readonly saveBeforeCommands?: () => ClaudeSaveBeforeCommandsMode;
	/**
	 * Lets the workbench save unsaved editors before a shell command runs. The
	 * command waits for it. A rejection does not block the command.
	 */
	readonly beforeCommand?: (request: ClaudeBeforeCommandRequest) => Promise<void>;
	/**
	 * Names a fresh chat once its first turn finishes, for `session.titled`. No title
	 * (or a rejection) leaves the first prompt as the chat's title. Absent sends no title.
	 */
	readonly sessionTitle?: (request: ClaudeSessionTitleRequest) => Promise<string | undefined>;
	/** This machine as the dev container and SSH targets see it. Defaults to the real one; tests inject it. */
	readonly executionTargetHost?: ClaudeTargetHost;
	/** Runs a target's probes and `devcontainer up`. Defaults to a child process; tests inject it. */
	readonly runTargetCommand?: ClaudeCommandRunner;
	/** Reads files on an SSH target for change capture. Defaults to `ssh`; tests inject it. */
	readonly remoteFiles?: Pick<IClaudeRemoteFilesService, 'readFile'>;
	/**
	 * Runs a `run_in_terminal` call in a visible terminal of the window that owns
	 * the session, and resolves when it ends (issue 452). Absent leaves the tool out.
	 */
	readonly terminalRun?: (request: ClaudeTerminalRunToolRequest) => Promise<ClaudeTerminalRunResult>;
	/** Answers Klawly's settings tools in the window that owns the session (issue 525). Absent leaves them out. */
	readonly browserRequest?: (request: ClaudeBrowserToolArgs & { readonly sessionId: string; readonly signal: AbortSignal }) => Promise<ClaudeBrowserToolResult>;
	readonly settingsRequest?: (request: ClaudeSettingsToolArgs & { readonly sessionId: string; readonly signal: AbortSignal }) => Promise<ClaudeSettingsToolResult>;
	/**
	 * Runs a `klawly_delegate` call as a delegated chat in the window that owns the
	 * session, and resolves with its answer (issue 693). Absent leaves the tool out.
	 */
	/** Shows one `klawly_status` line on the tab of the chat that owns the session (issue 1171). Absent leaves the tool out. */
	readonly statusReport?: (report: ClaudeStatusReport) => void;
	/** Opens the Send Feedback form for `klawly_feedback` in the window that owns the session (issue 1174). Absent leaves the tool out. */
	readonly feedbackRequest?: (request: ClaudeFeedbackToolRequest) => void;
	/** Hands a `klawly_department` call to the window that owns the session (issue 1177). Absent leaves the tool out. */
	readonly departmentRequest?: (request: ClaudeDepartmentToolArgs & { readonly sessionId: string; readonly signal: AbortSignal }) => Promise<ClaudeDepartmentToolResult>;
	/** Hands a `klawly_start_agent` call to the window that owns the session (issue 991). Absent leaves the tool out. */
	readonly startAgentRequest?: (request: ClaudeStartAgentToolArgs & { readonly sessionId: string; readonly signal: AbortSignal }) => Promise<ClaudeStartAgentToolResult>;
	readonly delegateRequest?: (request: ClaudeDelegateToolArgs & { readonly sessionId: string; readonly signal: AbortSignal }) => Promise<ClaudeDelegateToolResult>;
	/** The no-model CI, test and merge tools (issue 844). Absent leaves them out. */
	readonly noModelTools?: ClaudeNoModelTools;
	/** `klawly.delegation.mergeWithoutAsking`, read before each merge. Absent means ask. */
	readonly mergeWithoutAsking?: () => boolean;
	/** Read when a query starts. False leaves out the delegate tool and the bundled delegate skill (issue 835). Absent keeps them. */
	readonly delegationEnabled?: () => boolean;
	/** Klawly's version, which the bundled plugins carry. Defaults to the running product's. */
	readonly productVersion?: string;
	/** Holds MCP elicitation requests for the workbench (issue 428). Absent, Claude Code declines them. */
	readonly elicitations?: ClaudeElicitationBridge;
	/** Debug mode's log sinks and reproductions (issue 484). Absent leaves the debug tools out. */
	readonly debug?: ClaudeDebugToolProvider;
	/**
	 * The Auto level's classifier (issue 510), asked inside `canUseTool` before a
	 * card. Absent, or when it does not answer allow, the card shows as usual.
	 */
	readonly autoReview?: (request: ClaudeAutoReviewRequest) => Promise<ClaudeAutoReviewVerdict>;
	/** The opt-in Auto toggles (issue 908), read on every request. Absent means both off. */
	readonly autoReviewToggles?: () => ClaudeAutoReviewToggles;
	/** Auto mode is on: a `sleep` polling loop in Bash is refused and points to Watch CI (issue 1110). Absent means off. */
	readonly autoModeOn?: () => boolean;
}

/**
 * Starts one streaming `query()` per session. Callers read normalized events
 * from the async iterable `start` returns. SDK message objects do not leave
 * the normalizer.
 */
export class ClaudeAgentRunner extends Disposable {
	private readonly _sessions = new Map<string, RunnerSession>();
	private readonly _turnOpen = new Set<string>();
	private readonly _models: ClaudeModelInfo[] = [];
	/** Models Claude Code still runs but leaves out of its lineup; only the probe finds them. */
	private _olderModels: readonly ClaudeModelInfo[] = [];
	private _olderAsked = false;
	private _modelProbe: Promise<void> | undefined;
	/** The `/` menu catalog a no-turn probe found, per working directory (issue 968). */
	private readonly _commandProbes = new Map<string, Promise<ClaudeCommandListing>>();
	/** Sessions whose main agent's tool calls the cost watcher refuses, with the refusal (issue 847). */
	private readonly _toolRefusals = new Map<string, string>();
	private _commands: readonly ClaudeQueryCommand[] = [];
	private _skills: readonly string[] = [];
	private _runtimeVersion: string | undefined;
	/** What the last session reported, for Klawly Settings once no session runs. */
	private _account: ClaudeAccountDetails | undefined;
	private _usage: readonly ClaudeUsageWindow[] | undefined;
	/** When Claude Code last reported `_usage`, in epoch milliseconds (issue 704). */
	private _usageCheckedAt: number | undefined;
	/** True while the last ask for the plan limits failed, so a page can say "could not load" rather than "none" (issue 942). */
	private _usageFailed = false;
	/** Sessions started under an account that has since been switched or logged out: what they report is not the new account's (issue 942). */
	private readonly _staleAccount = new WeakSet<RunnerSession>();
	/** The running plan-limits probe, so several pages asking at once share one query. */
	private _usageProbe: Promise<void> | undefined;
	private _remoteFiles: Pick<IClaudeRemoteFilesService, 'readFile'> | undefined;
	/** Sessions whose plan limits are being asked for, so refreshes do not pile up. */
	private readonly _usageRefreshes = new Set<RunnerSession>();
	private _mcpServers: readonly ClaudeMcpServerInfo[] | undefined;
	private _catalogCommands: readonly ClaudeCommandInfo[] | undefined;
	private _catalogAgents: readonly ClaudeSubagentInfo[] | undefined;

	private readonly _host: ClaudePermissionHost;
	/** Klawly's plan folder for this user, where the plan files it writes live. */
	private readonly _klawlyPlanDirectory: string;
	/** Claude Code's folder for this user, where user commands live. */
	private readonly _configDirectory: string;

	constructor(private readonly _options: ClaudeAgentRunnerOptions) {
		super();
		this._host = _options.permissionHost ?? new ClaudePermissionHost();
		this._configDirectory = claudeConfigDirectory(_options.homeDirectory ?? homedir(), process.env.CLAUDE_CONFIG_DIR);
		this._klawlyPlanDirectory = klawlyPlanDirectory(_options.homeDirectory ?? homedir(), _options.dataFolderName ?? product.dataFolderName);
	}

	/**
	 * Claude Code's plan folders, where Plan mode may write: its own, and the
	 * folder of the account in use, which links to it (issue 450).
	 */
	private planDirectories(): readonly string[] {
		const home = this._options.homeDirectory ?? homedir();
		const own = claudePlanDirectory(home, process.env.CLAUDE_CONFIG_DIR);
		const account = this.accountDirectory();
		const accountPlans = account ? claudePlanDirectory(home, account) : undefined;
		return accountPlans && accountPlans !== own ? [own, accountPlans] : [own];
	}

	/** The `CLAUDE_CONFIG_DIR` new Claude processes start with: the account in use. */
	private accountDirectory(session?: RunnerSession): string | undefined {
		return this.sessionEnvironment(session)?.CLAUDE_CONFIG_DIR;
	}

	/** The environment one chat's Claude processes start with: its own account, else the account in use. */
	private sessionEnvironment(session?: RunnerSession): Readonly<Record<string, string>> | undefined {
		if (session?.accountId !== undefined && this._options.accountEnvironment) {
			return this._options.accountEnvironment(session.accountId);
		}
		return this._options.processEnvironment?.();
	}

	/** The permission history for one session, oldest first. */
	permissionHistory(sessionId: string): readonly PermissionOutcome[] {
		return this._host.history(sessionId);
	}

	start(request: ClaudeAgentRunRequest): AsyncIterable<NormalizedClaudeEvent> {
		const existing = this._sessions.get(request.sessionId);
		if (existing) {
			if (request.sessionPermissions) {
				this._host.setSessionPermissions(request.sessionId, request.sessionPermissions);
				void this.syncPermissionMode(request.sessionId, existing);
			}
			this.notePrompt(request.prompt);
			this.openTurn(request.sessionId);
			existing.stream.push(request.prompt);
			this._options.registry.arm(request.sessionId);
			return existing.queue;
		}
		const session = this.createSession(request);
		session.launching = true;
		session.generation = 1;
		this._sessions.set(request.sessionId, session);
		this._host.beginSession(request.sessionId);
		if (request.sessionPermissions) {
			this._host.setSessionPermissions(request.sessionId, request.sessionPermissions);
		}
		this.notePrompt(request.prompt);
		this.openTurn(request.sessionId);
		session.resumeAt = request.resumeSessionId ? request.resumeSessionAt : undefined;
		void this.launch(request.sessionId, session, 1, request.resumeSessionId);
		return session.queue;
	}

	async send(sessionId: string, text: string, mode?: AgentMode, workspaceTrusted?: boolean, turn?: ClaudeAgentTurnOptions): Promise<AsyncIterable<NormalizedClaudeEvent> | undefined> {
		const session = this.requireSession(sessionId);
		if (mode) {
			session.mode = mode;
			if (mode !== 'debug') {
				// The log sink lives only while the session is in Debug mode (issue 484).
				this._options.debug?.close(sessionId);
			}
		}
		if (turn?.sessionPermissions) {
			this._host.setSessionPermissions(sessionId, turn.sessionPermissions);
		}
		if (workspaceTrusted !== undefined) {
			session.trusted = workspaceTrusted;
		}
		if (turn?.accountId !== undefined) {
			session.accountId = turn.accountId;
		}
		const previousTurnId = session.turnId;
		const previousCheckpointSessionId = session.checkpointSessionId;
		const previousDirtyBuffers = session.dirtyBuffers;
		this.applyTurnCheckpoint(session, turn);
		if (!turn?.turnId) {
			session.turnId = mintTurnId();
		}
		this.notePrompt(text);
		try {
			await this.prepareCheckpoint(session, sessionId);
		} catch (error) {
			session.turnId = previousTurnId;
			session.checkpointSessionId = previousCheckpointSessionId;
			session.dirtyBuffers = previousDirtyBuffers;
			// This send has not opened a turn. finishTurn would close an earlier one that is still running.
			if (!this._turnOpen.has(sessionId)) {
				const failure = classifyAgentFailure(error);
				this.publish(session, { type: 'session.failed', sessionId, message: failure.message, kind: failure.kind });
			}
			throw error;
		}
		this.openTurn(sessionId);
		const limitsChanged = !session.launching && session.queryLimits !== undefined && session.queryLimits !== limitsKey(session.mode);
		const trustChanged = !session.launching && session.queryTrusted !== undefined && session.queryTrusted !== session.trusted;
		const autonomyChanged = !session.launching && session.queryLimits !== undefined && session.queryAutonomy !== claudeAutonomyInstructions(this._host.sessionPermissions(sessionId), session.trusted, session.mode);
		const accountChanged = !session.launching && session.queryAccount !== undefined && session.queryAccount !== (this.accountDirectory(session) ?? '');
		// A query opened without the right to run unasked cannot switch into it live (issue 694).
		const unaskedChanged = !session.launching && session.queryPermissionMode !== undefined && !session.queryAllowsUnasked && this.permissionModeFor(sessionId, session) === 'unasked';
		if ((limitsChanged || trustChanged || autonomyChanged || unaskedChanged || accountChanged) && this._options.registry.get(sessionId)) {
			// The SDK fixes `disallowedTools`, the setting sources and the system prompt
			// when the query opens, so a switch to a mode with other tool limits, a change
			// of Workspace Trust, or turning Allow Everything on or off restarts the query
			// on the same conversation.
			session.generation++;
			this._options.registry.disposeSession(sessionId);
			session.stream.close();
			session.queue.close();
		} else if (session.launching || this._options.registry.get(sessionId)) {
			// A switch between Agent and Debug keeps the query: only its permission mode follows (issue 694).
			await this.syncPermissionMode(sessionId, session);
			session.stream.push(text);
			this._options.registry.arm(sessionId);
			return undefined;
		}
		session.generation++;
		const generation = session.generation;
		session.stream = new ClaudePromptStream();
		session.stream.push(text);
		session.abort = new AbortController();
		session.queue = new ClaudeEventQueue();
		session.launching = true;
		void this.launch(sessionId, session, generation, session.sdkSessionId);
		return session.queue;
	}

	/**
	 * Turns Allow All Commands and Allow Everything on or off for a live session.
	 * The next tool call sees the change; a request already on screen keeps its card.
	 */
	/** Starts or lifts the cost watcher's refusal of a session's tool calls (issue 847). Delegating and asking stay allowed. */
	setToolRefusal(sessionId: string, message: string | undefined): void {
		if (message) {
			this._toolRefusals.set(sessionId, message);
		} else {
			this._toolRefusals.delete(sessionId);
		}
	}

	setSessionPermissions(sessionId: string, permissions: ClaudeSessionPermissions): void {
		const session = this._sessions.get(sessionId);
		if (session) {
			this._host.setSessionPermissions(sessionId, permissions);
			// Allow Everything moves the live query in or out of the unasked mode, without a restart (issue 694).
			void this.syncPermissionMode(sessionId, session);
		}
	}

	/** The permission mode a session's query should run in now (issue 694). */
	private permissionModeFor(sessionId: string, session: RunnerSession): ClaudeQueryPermissionMode {
		return claudeRunsUnasked(this._host.sessionPermissions(sessionId), session.mode, session.trusted) ? 'unasked' : 'default';
	}

	/**
	 * Moves the live query to the permission mode the session's level, mode and trust
	 * ask for (issue 694). Leaving the unasked mode always works; entering it needs a
	 * query opened with `allowUnasked`, else the next turn restarts the query (see
	 * `send`). Until a switch lands, the screen still follows the level.
	 */
	private async syncPermissionMode(sessionId: string, session: RunnerSession): Promise<void> {
		const target = this.permissionModeFor(sessionId, session);
		if (session.queryPermissionMode === undefined || session.queryPermissionMode === target || (target === 'unasked' && !session.queryAllowsUnasked)) {
			return;
		}
		const previous = session.queryPermissionMode;
		session.queryPermissionMode = target;
		try {
			if (!await this._options.registry.setPermissionMode(sessionId, target)) {
				session.queryPermissionMode = previous;
				return;
			}
			this._options.log?.(`permission mode: ${target === 'unasked' ? 'Allow Everything, Claude Code runs every tool without asking' : 'Claude Code asks Klawly again'}`);
		} catch (error) {
			session.queryPermissionMode = previous;
			this._options.log?.(`permission mode: could not switch to ${target}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** True while the open query will fold another user message into this turn. */
	canSteer(sessionId: string): boolean {
		const session = this._sessions.get(sessionId);
		if (!session || !session.stream.acceptsInput()) {
			return false;
		}
		return session.launching || !!this._options.registry.get(sessionId);
	}

	/**
	 * Delivers text at the streaming-input boundary. The SDK reads it when the
	 * current turn can take another user message. Returns false when it cannot.
	 */
	steer(sessionId: string, text: string): boolean {
		const trimmed = text.trim();
		if (!trimmed || !this.canSteer(sessionId)) {
			return false;
		}
		this.requireSession(sessionId).stream.push(trimmed);
		return true;
	}

	async interrupt(sessionId: string): Promise<void> {
		// Hash after the interrupt returns. A write still in flight must not get an afterHash from the bytes that were on disk before it landed.
		await this._options.registry.interrupt(sessionId);
		const session = this._sessions.get(sessionId);
		if (session) {
			await this.finishWriteCaptures(session);
		}
	}

	async interruptSubagent(sessionId: string, runId: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (!session || !session.normalizer.startedRuns.has(runId) || session.normalizer.finishedRuns.has(runId)) {
			return;
		}
		const taskId = session.tasks.get(runId) ?? runId;
		const stopped = await this._options.registry.stopTask(sessionId, taskId);
		if (stopped) {
			return;
		}
		if (!session.normalizer.finishedRuns.has(runId)) {
			session.normalizer.finishedRuns.add(runId);
			this.publish(session, {
				type: 'subagent.finished',
				sessionId,
				runId,
				state: 'stopped',
				resultText: 'Stopped by interrupting the parent turn.',
				interruptedParent: true,
			});
		}
		await this.interrupt(sessionId);
	}

	async setModel(sessionId: string, modelId: string): Promise<void> {
		const session = this.requireSession(sessionId);
		const previous = session.modelId;
		if (session.launching && !this._options.registry.get(sessionId)) {
			if (session.pendingModel === undefined) {
				session.modelBeforePending = session.modelId;
			}
			session.modelId = modelId;
			session.pendingModel = modelId;
			return new Promise((resolve, reject) => {
				session.modelWaiters.push({ modelId, resolve, reject });
			});
		}
		if (this._options.registry.get(sessionId)) {
			try {
				await this._options.registry.setModel(sessionId, modelId);
			} catch (error) {
				session.modelId = previous;
				throw error;
			}
		}
		session.modelId = modelId;
		this.publish(session, { type: 'session.modelChanged', sessionId, modelId });
	}

	/**
	 * Replaces the session's effort, fast mode, Ultracode and thinking. A live
	 * query changes through `applyFlagSettings`, without a restart. A query that
	 * is still starting gets them once it is tracked; with no query, the next one
	 * opens with them.
	 */
	async setSessionSettings(sessionId: string, settings: ClaudeSessionSettings): Promise<void> {
		const session = this.requireSession(sessionId);
		if (session.launching && !this._options.registry.get(sessionId)) {
			if (session.settingsWaiters.length === 0) {
				session.settingsBeforePending = session.settings;
			}
			session.settings = settings;
			return new Promise((resolve, reject) => {
				session.settingsWaiters.push({ resolve, reject });
			});
		}
		if (this._options.registry.get(sessionId) && session.appliedSettings) {
			const patch = claudeFlagSettingsPatch(session.appliedSettings, settings);
			if (patch) {
				await this._options.registry.applyFlagSettings(sessionId, patch);
			}
			session.appliedSettings = settings;
		}
		session.settings = settings;
		this.publish(session, { type: 'session.settingsChanged', sessionId, settings });
	}

	/**
	 * Asks a running session for its models. With no session and no list yet,
	 * `target` lets a short query that runs no turn ask instead, so the model
	 * menu works before the first prompt. That query also finds the older
	 * models, which follow the lineup; with a session open it runs in the
	 * background and its models join the next call.
	 */
	async listModels(sessionId?: string, target?: ClaudeModelProbeTarget): Promise<readonly ClaudeModelInfo[]> {
		const query = sessionId ? this._options.registry.get(sessionId) : undefined;
		if (query) {
			try {
				const models = await query.supportedModels();
				this._models.splice(0, this._models.length, ...models.map(toModelInfo));
			} catch {
				// Keep the last list the runtime reported.
			}
		}
		if (target && this._models.length === 0) {
			await this.probeModels(target);
		} else if (target && !this._olderAsked) {
			// The lineup is already listed: do not hold it up. The older models join the next call.
			void this.probeModels(target);
		}
		const older = this._olderModels.filter(model => !this._models.some(listed => listed.id === model.id));
		return [...this._models, ...older].map(model => ({ ...model }));
	}

	/**
	 * The `/` menu catalog for a chat that has sent nothing (issue 968): what a
	 * session reported, else what a short query that runs no turn lists, kept per
	 * working directory. A failed or empty probe is forgotten so the next call asks again.
	 */
	async listCommands(cwd: string, target?: ClaudeModelProbeTarget): Promise<ClaudeCommandListing> {
		if (this._catalogCommands?.length) {
			return { commands: this._catalogCommands, agents: this._catalogAgents ?? [] };
		}
		if (!target) {
			return { commands: [], agents: [] };
		}
		let probe = this._commandProbes.get(cwd);
		if (!probe) {
			probe = (async () => {
				const listed = await probeClaudeCommands({
					...target,
					queryFactory: this._options.queryFactory,
					env: this._options.processEnvironment?.() ?? claudeProcessEnvironment(),
				});
				const skills = await readClaudeSkillNames(cwd, this._configDirectory);
				return {
					commands: await readClaudeCommandCatalog(listed.commands, skills, cwd, this._configDirectory),
					agents: listed.agents.map(toClaudeSubagentInfo),
				};
			})();
			this._commandProbes.set(cwd, probe);
		}
		try {
			const listing = await probe;
			if (listing.commands.length === 0) {
				this._commandProbes.delete(cwd);
			}
			return listing;
		} catch {
			this._commandProbes.delete(cwd);
			this._options.log?.('Claude Code could not list its commands.');
			return { commands: [], agents: [] };
		}
	}

	/**
	 * One probe at a time. A failed probe leaves an empty list empty so the next
	 * call tries again; once a session has listed the lineup, the older models
	 * are asked for only once.
	 */
	private probeModels(target: ClaudeModelProbeTarget): Promise<void> {
		this._modelProbe ??= (async () => {
			try {
				const models = await probeClaudeModels({
					...target,
					queryFactory: this._options.queryFactory,
					env: this._options.processEnvironment?.() ?? claudeProcessEnvironment(),
				});
				if (this._models.length === 0) {
					this._models.splice(0, 0, ...models.lineup.map(toModelInfo));
				}
				this._olderModels = models.older.map(model => ({ ...toModelInfo(model), older: true }));
			} catch {
				this._options.log?.('Claude Code could not list its models.');
			} finally {
				this._olderAsked = this._models.length > 0;
				this._modelProbe = undefined;
			}
		})();
		return this._modelProbe;
	}

	/**
	 * Reconnects or turns off or on one MCP server of a running session (issue 512),
	 * then reports the account overview again so the server's new state shows.
	 */
	async controlMcpServer(sessionId: string | undefined, name: string, action: ClaudeMcpControlAction): Promise<ClaudeAccountOverview> {
		const query = sessionId ? this._options.registry.get(sessionId) : undefined;
		if (!query) {
			throw new Error('Start an agent first: MCP servers run inside a Claude Code session.');
		}
		if (action === 'reconnect') {
			if (!query.reconnectMcpServer) {
				throw new Error('This Claude Code cannot reconnect MCP servers.');
			}
			await query.reconnectMcpServer(name);
		} else {
			if (!query.toggleMcpServer) {
				throw new Error('This Claude Code cannot turn MCP servers off and on.');
			}
			await query.toggleMcpServer(name, action === 'enable');
		}
		return this.accountOverview(sessionId);
	}

	/**
	 * The MCP App the tool `toolName` draws (issue 513): its `ui://` resource, read
	 * from the server through the session's running query. `undefined` when the
	 * session is not running or the tool draws no app.
	 */
	async loadMcpApp(sessionId: string, toolName: string): Promise<ClaudeMcpAppLoad | undefined> {
		const query = this._options.registry.get(sessionId);
		if (!query?.mcpServerStatus) {
			return undefined;
		}
		const found = findClaudeMcpApp(toolName, await query.mcpServerStatus());
		if (!found) {
			return undefined;
		}
		const { server, app } = found;
		if (!query.readMcpResource) {
			return { ok: false, message: 'This Claude Code cannot read MCP Apps. Update Claude Code, then try again.' };
		}
		try {
			return claudeMcpAppFromContents(server.name, app.tool, app.resourceUri, await query.readMcpResource(server.name, app.resourceUri));
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * One resource of a connected MCP server of a running session, for an MCP
	 * App's `resources/read` (issue 897). The server must be connected in that
	 * session, so an app only reads from a server the session already trusts.
	 */
	async readMcpResource(sessionId: string, server: string, uri: string): Promise<readonly ClaudeMcpResourceContent[]> {
		const query = this._options.registry.get(sessionId);
		if (!query?.mcpServerStatus || !query.readMcpResource) {
			throw new Error('The session is not running, so its MCP servers cannot be read.');
		}
		const connected = (await query.mcpServerStatus()).some(status => status.name === server && status.state === 'connected');
		if (!connected) {
			throw new Error(`The MCP server ${server} is not connected.`);
		}
		return query.readMcpResource(server, uri);
	}

	/**
	 * Asks a running session for the account, plan limits and MCP servers. Each
	 * answer is kept, so with no session (or a failed call) the last one is returned.
	 * Plan limits Claude Code reported a moment ago are reused rather than asked
	 * for again (issue 704): within {@link CLAUDE_USAGE_FRESH_MS} for `'stale'`,
	 * within {@link CLAUDE_USAGE_RECENT_MS} otherwise. With no session, `refreshUsage`
	 * and a `target` let a short query that runs no turn ask instead. Limits a
	 * running session reads here are also sent as `session.usageLimits`, so the
	 * status bar and the composer show what Settings shows.
	 */
	async accountOverview(sessionId?: string, refreshUsage?: ClaudeUsageRefresh, target?: ClaudeModelProbeTarget): Promise<ClaudeAccountOverview> {
		const stale = !!sessionId && this.isStaleAccount(sessionId);
		const query = sessionId && !stale ? this._options.registry.get(sessionId) : undefined;
		const checkedAt = this._usageCheckedAt;
		const usageFresh = checkedAt !== undefined && Date.now() - checkedAt < (refreshUsage === 'stale' ? CLAUDE_USAGE_FRESH_MS : CLAUDE_USAGE_RECENT_MS);
		if (query) {
			const [account, usage, mcpServers] = await Promise.allSettled([
				query.accountInfo?.(),
				usageFresh ? Promise.resolve(this._usage) : query.usageLimits?.(),
				query.mcpServerStatus?.(),
			]);
			if (account.status === 'fulfilled' && account.value) {
				this._account = account.value;
			}
			if (usage.status === 'rejected' && !usageFresh && query.usageLimits) {
				this._usageFailed = true;
			}
			if (usage.status === 'fulfilled' && !usageFresh && query.usageLimits) {
				this.rememberUsage(usage.value);
				const session = this._sessions.get(sessionId!);
				if (session) {
					this.publish(session, { type: 'session.usageLimits', sessionId: sessionId!, windows: usage.value ?? [] });
				}
			}
			if (mcpServers.status === 'fulfilled' && mcpServers.value) {
				const userLayer = this._sessions.get(sessionId!)?.userMcpServers;
				this._mcpServers = mcpServers.value.map(server => {
					const scope = claudeUserLayerMcpScope(server.scope, server.name, userLayer);
					return scope === server.scope ? server : { ...server, scope };
				});
			}
		} else if (refreshUsage && target && !usageFresh) {
			await this.probeUsage(target);
		}
		return {
			live: !!query,
			account: this._account,
			usage: this._usage,
			usageCheckedAt: this._usageCheckedAt,
			...(this._usageFailed ? { usageFailed: true } : {}),
			mcpServers: this._mcpServers,
			commands: this._catalogCommands,
			agents: this._catalogAgents,
		};
	}

	/** One probe at a time; a failed probe keeps the last limits and their time. */
	private probeUsage(target: ClaudeModelProbeTarget): Promise<void> {
		this._usageProbe ??= (async () => {
			try {
				this.rememberUsage(await probeClaudeUsage({
					...target,
					queryFactory: this._options.queryFactory,
					env: this._options.processEnvironment?.() ?? claudeProcessEnvironment(),
				}));
			} catch {
				this._usageFailed = true;
				this._options.log?.('Claude Code could not report the plan limits.');
			} finally {
				this._usageProbe = undefined;
			}
		})();
		return this._usageProbe;
	}

	/** A reported answer, even an empty one, means Claude Code answered: none is "none", never "not asked". */
	private rememberUsage(windows: readonly ClaudeUsageWindow[] | undefined): void {
		this._usage = windows ?? [];
		this._usageCheckedAt = Date.now();
		this._usageFailed = false;
	}

	private isStaleAccount(sessionId: string): boolean {
		const session = this._sessions.get(sessionId);
		return !!session && this._staleAccount.has(session);
	}

	/** Drops the account and plan limits the last session reported, after a log out (issue 536). */
	forgetAccount(): void {
		this._account = undefined;
		this._usage = undefined;
		this._usageCheckedAt = undefined;
		this._usageFailed = false;
		this._usageProbe = undefined;
		for (const session of this._sessions.values()) {
			this._staleAccount.add(session);
		}
	}

	/** Asks the session's running query what fills its context window. */
	async contextBreakdown(sessionId: string): Promise<ClaudeContextBreakdown | undefined> {
		return this._options.registry.get(sessionId)?.contextBreakdown?.();
	}

	capabilities(): Promise<ClaudeCapabilities> {
		return Promise.resolve({
			commands: this._commands,
			skills: this._skills,
			models: this._models.map(model => ({ ...model })),
			version: this._runtimeVersion,
		});
	}

	hasSession(sessionId: string): boolean {
		return this._sessions.has(sessionId);
	}

	disposeSession(sessionId: string): void {
		const session = this._sessions.get(sessionId);
		if (!session) {
			return;
		}
		this._host.endSession(sessionId);
		this._options.debug?.close(sessionId);
		this._turnOpen.delete(sessionId);
		this._toolRefusals.delete(sessionId);
		this._sessions.delete(sessionId);
		void this.finishWriteCaptures(session);
		session.launching = false;
		this.failPendingModel(session, new Error('Claude session disposed.'));
		this.failPendingSettings(session, new Error('Claude session disposed.'));
		session.stream.close();
		session.abort.abort();
		this._options.registry.disposeSession(sessionId);
		session.queue.close();
	}

	override dispose(): void {
		for (const sessionId of [...this._sessions.keys()]) {
			this.disposeSession(sessionId);
		}
		this._turnOpen.clear();
		super.dispose();
	}

	private createSession(request: ClaudeAgentRunRequest): RunnerSession {
		const stream = new ClaudePromptStream();
		stream.push(request.prompt);
		return {
			queue: new ClaudeEventQueue(),
			stream,
			accountId: request.accountId,
			cwd: request.cwd,
			mode: request.mode ?? 'agent',
			modelId: request.modelId,
			allowedTools: request.allowedTools,
			additionalDirectories: request.additionalDirectories?.filter(directory => isAbsolute(directory)),
			plugins: request.plugins?.filter(directory => isAbsolute(directory)),
			workerProfile: request.workerProfile,
			agentsFiles: request.agentsFiles,
			replyStyle: request.replyStyle,
			makerMode: request.makerMode === true,
			workRules: request.workRules,
			verifyUi: request.verifyUi,
			userLayer: request.userLayer,
			// No cap unless the request sets one: Claude Code has none in interactive use, and real agent
			// work runs past any small number (issues 696, 707). Automations pass their own cap.
			maxTurns: request.maxTurns,
			maxBudgetUsd: request.maxBudgetUsd,
			builtInAgents: request.builtInAgents !== false,
			gitSettings: request.gitSettings,
			securitySettings: request.securitySettings,
			executionTarget: request.executionTarget,
			executablePath: request.executablePath,
			runtimeVersion: request.runtimeVersion,
			titlePrompt: request.resumeSessionId || isSlashCommandPrompt(request.prompt) ? undefined : request.prompt,
			permissionBridge: request.permissionBridge ?? denyClaudePermissionBridge,
			workspaceFolders: request.workspaceFolders && request.workspaceFolders.length > 0 ? request.workspaceFolders.filter(folder => isAbsolute(folder)) : [request.cwd],
			trusted: request.workspaceTrusted === true,
			tasks: new Map(),
			agentRuns: new Map(),
			normalizer: createClaudeNormalizerState(),
			abort: new AbortController(),
			launching: false,
			generation: 0,
			modelWaiters: [],
			settings: request.sessionSettings ?? DEFAULT_CLAUDE_SESSION_SETTINGS,
			settingsWaiters: [],
			checkpointSessionId: request.checkpointSessionId ?? request.sessionId,
			turnId: request.turnId,
			dirtyBuffers: request.dirtyBuffers,
			writeCaptures: new Map(),
			shellCaptures: new Set(),
		};
	}

	private async launch(sessionId: string, session: RunnerSession, generation: number, resume: string | undefined): Promise<void> {
		session.resumeAttempt = resume;
		try {
			await this.prepareCheckpoint(session, sessionId);
			if (session.generation !== generation || !this._sessions.has(sessionId)) {
				return;
			}
			const query = await this.openQuery(session, resume);
			if (session.generation !== generation || !this._sessions.has(sessionId)) {
				this.failPendingModel(session, new Error('Claude session ended before the model could change.'));
				this.failPendingSettings(session, new Error('Claude session ended before the settings could change.'));
				try {
					query.close();
				} catch {
					// The query may already have closed itself.
				}
				return;
			}
			this._options.registry.track(sessionId, query, this._options.timeoutMs ?? DEFAULT_CLAUDE_SESSION_TIMEOUT_MS);
			if (this._turnOpen.has(sessionId)) {
				this._options.registry.arm(sessionId);
			}
			await this.applyPendingModel(sessionId, session, query);
			await this.applyPendingSettings(sessionId, session);
			session.launching = false;
			await this.consume(sessionId, query, generation);
		} catch (error) {
			this.failPendingModel(session, error);
			this.failPendingSettings(session, error);
			this.failQuery(sessionId, generation, session, error);
			if (session.generation === generation) {
				session.queue.close();
			}
		} finally {
			if (session.generation === generation) {
				session.launching = false;
			}
		}
	}

	/**
	 * Brings up a dev container or checks an SSH host once per session, before its
	 * first query. A failed probe throws, so the session stops with what to fix.
	 */
	private async prepareExecutionTarget(session: RunnerSession): Promise<ClaudePreparedTarget | undefined> {
		if (!session.preparedTarget && isRemoteClaudeExecutionTarget(session.executionTarget)) {
			session.preparedTarget = await prepareClaudeExecutionTarget(session.executionTarget, {
				cwd: session.cwd,
				workspaceFolders: session.workspaceFolders,
				trusted: session.trusted,
				host: this._options.executionTargetHost ?? defaultClaudeTargetHost(),
				run: this._options.runTargetCommand ?? runClaudeTargetCommand,
			});
		}
		return session.preparedTarget;
	}

	private async openQuery(session: RunnerSession, resume: string | undefined): Promise<ClaudeQuery> {
		const readUserRules = (await this._host.readRulesFor(session.workspaceFolders)).filter(rule => rule.source === 'user');
		const agents = selectBuiltinAgents(session.cwd, session.builtInAgents, this._options.homeDirectory, process.env.CLAUDE_CONFIG_DIR);
		const disallowedTools = [...disallowedToolsForMode(session.mode) ?? [], ...CLAUDE_DUPLICATE_SESSION_MANAGER_TOOLS];
		session.queryLimits = limitsKey(session.mode);
		const trusted = session.trusted;
		session.queryTrusted = trusted;
		// Under Allow Everything Claude finishes routine steps itself instead of handing them back (issue 741).
		const runnerSessionId = this.sessionIdFor(session);
		const permissions = runnerSessionId ? this._host.sessionPermissions(runnerSessionId) : undefined;
		const autonomy = claudeAutonomyInstructions(permissions, trusted, session.mode);
		session.queryAutonomy = autonomy;
		session.queryAccount = this.accountDirectory(session) ?? '';
		// Allow Everything runs Claude Code unasked in Agent mode (issue 694). While the level is
		// on, the query may switch into that mode later, so going back to Agent needs no restart.
		const permissionMode: ClaudeQueryPermissionMode = claudeRunsUnasked(permissions, session.mode, trusted) ? 'unasked' : 'default';
		const allowUnasked = claudeRunsUnasked(permissions, 'agent', trusted);
		session.queryPermissionMode = permissionMode;
		session.queryAllowsUnasked = allowUnasked;
		if (!trusted) {
			this._options.log?.('The workspace is not trusted, so project settings, hooks, and MCP servers are not loaded.');
		}
		const start = claudeStartSettings(session.settings);
		const git = claudeGitFlagSettings(session.gitSettings);
		let executionTarget: ClaudePreparedTarget | undefined;
		try {
			executionTarget = await this.prepareExecutionTarget(session);
		} catch (error) {
			if (resume === undefined || !session.executionTarget || !(error instanceof ClaudeExecutionTargetError) || error.reason !== 'unreachable') {
				throw error;
			}
			// A resumed agent whose host or container is gone runs here. Its old
			// conversation is stored on the target, so the turn starts a new one.
			session.targetNotice = claudeTargetFallbackNotice(session.executionTarget, error);
			this._options.log?.(session.targetNotice);
			session.executionTarget = { kind: 'local' };
			session.resumeAttempt = undefined;
			resume = undefined;
		}
		// AGENTS.md and `.agents/skills` are project input like CLAUDE.md, read from this machine's files (issue 499).
		const agentsFiles = trusted && !executionTarget ? await resolveClaudeAgentsFiles({
			cwd: session.cwd,
			settings: session.agentsFiles ?? { instructions: true, skills: true },
			pluginRoot: join(this._options.homeDirectory ?? homedir(), this._options.dataFolderName ?? product.dataFolderName, 'agents-skills'),
			homeDirectory: this._options.homeDirectory,
		}).catch(() => undefined) : undefined;
		session.instructionSources = agentsFiles?.sources;
		// Klawly's own rules, settings, servers and skills for every project (issue 455). Only read: `~/.claude` stays as it is.
		const userLayer = await resolveClaudeUserLayer({
			directory: claudeUserLayerDirectory(this._options.homeDirectory ?? homedir(), this._options.dataFolderName ?? product.dataFolderName),
			pluginDirectory: this.dataPath(CLAUDE_USER_LAYER_PLUGIN_FOLDER),
			cwd: session.cwd,
			trusted,
			remote: !!executionTarget,
			homeDirectory: this._options.homeDirectory,
		}).catch(() => undefined);
		// Synced project memory (issue 448): the notes join the prompt and the notes folder is writable.
		const projectMemory = session.userLayer?.projectMemory ? await resolveClaudeProjectMemory(claudeUserLayerDirectory(this._options.homeDirectory ?? homedir(), this._options.dataFolderName ?? product.dataFolderName), session.cwd).catch(() => undefined) : undefined;
		session.userMcpServers = userLayer?.mcpServers ? Object.keys(userLayer.mcpServers) : undefined;
		const plugins = [...session.plugins ?? [], ...agentsFiles?.plugin ? [agentsFiles.plugin] : []];
		// The delegation mod ships with Klawly (issue 693). It has no hooks and no MCP
		// servers, so it loads in an untrusted workspace too; a remote target cannot read it.
		// The skill in that plugin is how Claude learns to delegate; a remote target gets it in the system prompt instead (issue 1406). The tool itself is served in-process, so it reaches the remote session too.
		const remoteDelegation = !!executionTarget && !!this.delegateToolFor(session);
		const bundled = executionTarget || this._options.delegationEnabled?.() === false ? undefined : await ensureClaudeDelegatePlugin(this.dataPath(CLAUDE_DELEGATE_PLUGIN_FOLDER), this._options.productVersion ?? product.version);
		// The user's own skills, agents, commands and output styles load in any workspace, like `~/.claude/skills`; the plugin has no hooks or servers.
		const ownPlugins = [...bundled ? [bundled] : [], ...userLayer?.plugin ? [userLayer.plugin] : []];
		// A lean delegated worker starts with the file and shell tools only (issue 843).
		const shape = claudeWorkerProfileShape(session.workerProfile ?? 'full');
		const options: ClaudeQueryOptions = {
			cwd: session.cwd,
			settingSources: claudeWorkerSettingSources(session.workerProfile ?? 'full', claudeSettingSourcesFor(trusted, session.userLayer?.useClaudeCodeSetup !== false)),
			// Only MCP servers passed here, and there are none, so a project `.mcp.json` cannot start one.
			strictMcpConfig: trusted && shape.mcpServers ? undefined : true,
			tools: shape.builtinTools,
			skills: shape.skills ? undefined : false,
			resume,
			resumeSessionAt: resume ? session.resumeAt : undefined,
			// A rewind continues a copy, so the conversation it went back in stays whole (issue 702).
			forkSession: resume && session.resumeAt ? true : undefined,
			allowedTools: allowedToolsForMode(session.mode, session.allowedTools),
			disallowedTools,
			additionalDirectories: projectMemory ? [...session.additionalDirectories ?? [], projectMemory.directory] : session.additionalDirectories,
			// A plugin's hooks and MCP servers run commands, so an untrusted workspace loads none.
			plugins: !shape.plugins ? undefined : trusted && plugins.length || ownPlugins.length ? [...trusted ? plugins : [], ...ownPlugins] : undefined,
			// The user's rules come first, so the project's AGENTS.md reads after them. ADHD mode's reply style follows the project's own instructions (issue 462).
			systemPrompt: joinClaudeSystemPrompt(userLayer?.systemPrompt, projectMemory?.prompt, agentsFiles?.systemPrompt, autonomy, claudePlanDependsInstructions(session.mode), claudeReplyStyleInstructions(session.replyStyle), claudeMakerInstructions(session.makerMode), claudeWorkRulesInstructions(session.workRules), claudeVerifyUiInstructions(session.verifyUi), remoteDelegation ? claudeDelegateGuidance() : undefined),
			maxTurns: session.maxTurns,
			maxBudgetUsd: session.maxBudgetUsd,
			model: session.modelId,
			effort: start.effort,
			flagSettings: start.flagSettings || git ? { ...start.flagSettings, ...git } : undefined,
			userSettings: userLayer?.settings,
			readDenyRules: readUserRules.length > 0 ? claudeReadDenyRules(readUserRules) : undefined,
			sandboxDenyRead: readUserRules.length > 0 ? claudeSandboxDenyRead(readUserRules) : undefined,
			userMcpServers: shape.mcpServers ? userLayer?.mcpServers : undefined,
			permissionMode,
			allowUnasked: allowUnasked || undefined,
			includePartialMessages: true,
			// Without it Claude Code streams thinking blocks with no text (issue 740). A remote
			// target runs its own Claude Code, whose version the probe did not see.
			thinkingDisplay: !executionTarget && claudeSupportsThinkingDisplay(session.runtimeVersion ?? this._runtimeVersion) ? 'summarized' : undefined,
			forwardSubagentText: true,
			pathToClaudeCodeExecutable: session.executablePath,
			env: this.sessionEnvironment(session) ?? claudeProcessEnvironment(),
			security: session.securitySettings,
			executionTarget,
			log: this._options.log,
			agents,
			abortController: session.abort,
			canUseTool: (toolName, input, context) => this.allowTool(session, toolName, input, context),
			screenTool: (toolName, input, toolUseId, agentId) => this.screenTool(session, toolName, input, toolUseId, agentId),
			terminalTool: this.terminalToolFor(session),
			debugTool: this._options.debug && shape.mcpServers ? claudeDebugToolHost(this._options.debug, () => ({ sessionId: this.sessionIdFor(session), mode: session.mode, signal: session.abort.signal })) : undefined,
			settingsTool: shape.mcpServers ? this.settingsToolFor(session) : undefined,
			browserTool: shape.mcpServers ? this.browserToolFor(session) : undefined,
			canvasTool: shape.mcpServers ? this.canvasToolFor(session) : undefined,
			delegateTool: this.delegateToolFor(session),
			departmentTool: this.departmentToolFor(session),
			startAgentTool: this.startAgentToolFor(session),
			reviewTool: createClaudeReviewToolHost({ cwd: session.cwd, env: this._options.processEnvironment?.() ?? claudeProcessEnvironment(), queryFactory: this._options.queryFactory }),
			noModelTool: this.noModelToolFor(session),
			modeTool: () => claudeModeState(session.mode, runnerSessionId ? this._host.sessionPermissions(runnerSessionId) : undefined, session.trusted, session.replyStyle),
			statusTool: this._options.statusReport ? report => {
				const sessionId = this.sessionIdFor(session);
				if (sessionId && !session.abort.signal.aborted) {
					this._options.statusReport?.({ sessionId, ...report });
				}
			} : undefined,
			feedbackTool: this._options.feedbackRequest ? request => {
				const sessionId = this.sessionIdFor(session);
				if (sessionId && !session.abort.signal.aborted) {
					this._options.feedbackRequest?.({ sessionId, ...request });
				}
			} : undefined,
			onElicitation: this.elicitationHandler(session),
		};
		session.appliedSettings = session.settings;
		return this._options.queryFactory({ prompt: session.stream, options });
	}

	/** The query's `onElicitation`. Disposing the session ends the wait, like a permission request. */
	private elicitationHandler(session: RunnerSession): ClaudeQueryOptions['onElicitation'] {
		const bridge = this._options.elicitations;
		if (!bridge) {
			return undefined;
		}
		return async (request, signal) => {
			const sessionId = this.sessionIdFor(session);
			if (!sessionId || signal.aborted) {
				return { action: 'cancel' };
			}
			const serverUrl = async (server: string) => (await this._options.registry.get(sessionId)?.mcpServerStatus?.())?.find(candidate => candidate.name === server)?.url;
			return runClaudeElicitation({ bridge, sessionId, push: event => session.queue.push(event), serverUrl }, request, AbortSignal.any([signal, session.abort.signal]));
		};
	}

	/**
	 * Runs before the SDK applies any of its own allow rules, from a `PreToolUse`
	 * hook. It returns a verdict only when the host would not allow the call by
	 * itself, so a rule in the user's Claude settings cannot approve a call the
	 * host refuses or wants to ask about.
	 */
	private async screenTool(session: RunnerSession, toolName: string, input: Record<string, unknown>, toolUseId?: string, agentId?: string): Promise<ClaudeToolScreen | undefined> {
		// The terminal tool runs a shell command, so Bash's rules apply to it (issue 452).
		({ toolName, input } = claudePolicyToolCall(toolName, input));
		const sessionId = this.sessionIdFor(session);
		if (!sessionId) {
			return { decision: 'deny', message: SESSION_STOPPED_MESSAGE };
		}
		// A subagent's denial belongs on its own card, like the records canUseTool writes.
		const parentRunId = this.parentRunIdFor(session, { agentId });
		// A denial here ends the call before canUseTool, so the record is written here.
		const modeResult = evaluateModePolicy(session.mode, toolName, input);
		if (modeResult.behavior === 'deny') {
			if (toolUseId) {
				this.settle(session, sessionId, { requestId: toolUseId, toolName, decision: 'deny', source: 'policy', subject: subjectOf(input), message: ASK_DENIAL_RECORD, blockedByMode: session.mode }, parentRunId);
			}
			return { decision: 'deny', message: modeResult.message };
		}
		// The cost watcher refuses the chat's own calls until it delegates or gives a reason (issue 847).
		const refusal = agentId ? undefined : this._toolRefusals.get(sessionId);
		if (refusal && !COST_WATCHER_EXEMPT_TOOLS.has(toolName)) {
			if (toolUseId) {
				this.settle(session, sessionId, { requestId: toolUseId, toolName, decision: 'deny', source: 'policy', subject: subjectOf(input), message: refusal }, parentRunId);
			}
			return { decision: 'deny', message: refusal };
		}
		// A question always reaches canUseTool, where the card collects the answers (issue 477).
		if (this.questionsFor(toolName, input) && this._options.elicitations) {
			return { decision: 'ask' };
		}
		if (claudeRunsUnasked(this._host.sessionPermissions(sessionId), session.mode, session.trusted)) {
			return this.screenUnasked(session, sessionId, toolName, input, toolUseId, parentRunId);
		}
		const verdict = await this._host.evaluate(this.scopeFor(sessionId, session), toolName, input);
		if (verdict.behavior === 'deny') {
			if (toolUseId) {
				this.settle(session, sessionId, { requestId: toolUseId, toolName, decision: 'deny', source: 'policy', subject: verdict.subject, message: verdict.why, blockedByMode: verdict.modeDenial ? session.mode : undefined }, parentRunId);
			}
			return { decision: 'deny', message: verdict.message };
		}
		if (verdict.behavior === 'ask') {
			return { decision: 'ask' };
		}
		// The SDK may run an allowed command without calling canUseTool, so this is the last host stop before it runs.
		await this.beforeCommand(sessionId, toolName, input, session.abort.signal);
		return undefined;
	}

	/**
	 * Allow Everything in Agent mode (issue 694): the call runs without a card, and
	 * nothing the host would ask about or refuse holds it back. Leaving plan mode is a
	 * choice, not a permission, so it still reaches the user. A write is snapshotted
	 * first, so checkpoints and Undo keep working; one that cannot be snapshotted is denied.
	 */
	private async screenUnasked(session: RunnerSession, sessionId: string, toolName: string, input: Record<string, unknown>, toolUseId: string | undefined, parentRunId: string | undefined): Promise<ClaudeToolScreen | undefined> {
		if (toolName === CLAUDE_EXIT_PLAN_TOOL) {
			return { decision: 'ask' };
		}
		let verdict: PermissionVerdict | undefined;
		try {
			verdict = await this._host.evaluate(this.scopeFor(sessionId, session), toolName, input);
		} catch {
			// The verdict only names the write target and the subject; the call still runs.
		}
		if (verdict?.behavior === 'ask' && verdict.details.publishes) {
			// A push, publish or deploy always reaches the user, even under Allow Everything (issue 1167).
			return { decision: 'ask' };
		}
		if (toolUseId && verdict) {
			const snapshotted = await this.captureApprovedWrite(session, sessionId, toolUseId, toolName, verdict, parentRunId);
			if (snapshotted) {
				return { decision: 'deny', message: snapshotted.behavior === 'deny' ? snapshotted.message : undefined };
			}
			if (verdict.behavior !== 'allow' || verdict.switchedBy) {
				this.settle(session, sessionId, { requestId: toolUseId, toolName, decision: 'allow', scope: 'session', source: 'allow-everything', subject: verdict.subject }, parentRunId);
			}
		}
		await this.beforeCommand(sessionId, toolName, input, session.abort.signal);
		return undefined;
	}

	/** The questions of an `AskUserQuestion` call that has none answered yet. */
	private questionsFor(toolName: string, input: Record<string, unknown>): readonly ClaudeQuestion[] | undefined {
		return toolName === CLAUDE_QUESTION_TOOL && input.answers === undefined ? readClaudeQuestions(input) : undefined;
	}

	/** The terminal tool for one session's query, when the runtime can open terminals. */
	private terminalToolFor(session: RunnerSession): ClaudeTerminalToolHost | undefined {
		const run = this._options.terminalRun;
		if (!run) {
			return undefined;
		}
		return {
			run: async (command, reason, signal) => {
				const sessionId = this.sessionIdFor(session);
				if (!sessionId || session.abort.signal.aborted) {
					return { kind: 'cancelled' };
				}
				return run({ sessionId, command, reason, cwd: session.cwd, signal: signal ? AbortSignal.any([signal, session.abort.signal]) : session.abort.signal });
			},
		};
	}

	/** Klawly's settings tools for one session's query (issue 525), when the runtime can reach a window. */
	/** The browser tool of a session (issue 466): the window that owns the chat runs each action. */
	private browserToolFor(session: RunnerSession): ClaudeBrowserToolHost | undefined {
		const request = this._options.browserRequest;
		if (!request) {
			return undefined;
		}
		return {
			call: async (args, signal) => {
				const sessionId = this.sessionIdFor(session);
				if (!sessionId || session.abort.signal.aborted) {
					return { kind: 'failed', message: 'The session ended.' };
				}
				return request({ ...args, sessionId, signal: signal ? AbortSignal.any([signal, session.abort.signal]) : session.abort.signal });
			},
		};
	}

	private settingsToolFor(session: RunnerSession): ClaudeSettingsToolHost | undefined {
		const request = this._options.settingsRequest;
		if (!request) {
			return undefined;
		}
		return {
			call: async (args, signal) => {
				const sessionId = this.sessionIdFor(session);
				if (!sessionId || session.abort.signal.aborted) {
					return { kind: 'failed', message: 'The session ended.' };
				}
				return request({ ...args, sessionId, signal: signal ? AbortSignal.any([signal, session.abort.signal]) : session.abort.signal });
			},
		};
	}

	/** A folder under the product's per-user data folder, such as `~/.klawly/canvases`. */
	private dataPath(folder: string): string {
		return join(this._options.homeDirectory ?? homedir(), this._options.dataFolderName ?? product.dataFolderName, folder);
	}

	/** Klawly's delegate tool for one session's query (issue 693), when the runtime can reach a window. */
	private delegateToolFor(session: RunnerSession): ClaudeDelegateToolHost | undefined {
		const request = this._options.delegateRequest;
		if (!request || this._options.delegationEnabled?.() === false) {
			return undefined;
		}
		return {
			delegate: async (args, signal) => {
				const sessionId = this.sessionIdFor(session);
				if (!sessionId || session.abort.signal.aborted) {
					return { kind: 'stopped' };
				}
				return request({ ...args, sessionId, signal: signal ? AbortSignal.any([signal, session.abort.signal]) : session.abort.signal });
			},
		};
	}

	/** Klawly's department tool for one session's query (issue 1177), when the runtime can reach a window. */
	private departmentToolFor(session: RunnerSession): ClaudeDepartmentToolHost | undefined {
		const request = this._options.departmentRequest;
		if (!request) {
			return undefined;
		}
		return {
			handOff: async (args, signal) => {
				const sessionId = this.sessionIdFor(session);
				if (!sessionId || session.abort.signal.aborted) {
					return { kind: 'failed', message: 'The chat was stopped.' };
				}
				return request({ ...args, sessionId, signal: signal ? AbortSignal.any([signal, session.abort.signal]) : session.abort.signal });
			},
		};
	}

	/** Klawly's start_agent tool for one session's query (issue 991), when the runtime can reach a window. */
	private startAgentToolFor(session: RunnerSession): ClaudeStartAgentToolHost | undefined {
		const request = this._options.startAgentRequest;
		if (!request) {
			return undefined;
		}
		return {
			start: async (args, signal) => {
				const sessionId = this.sessionIdFor(session);
				if (!sessionId || session.abort.signal.aborted) {
					return { kind: 'failed', message: 'The chat was stopped.' };
				}
				return request({ ...args, sessionId, signal: signal ? AbortSignal.any([signal, session.abort.signal]) : session.abort.signal });
			},
		};
	}

	/** The no-model tools for one session's query (issue 844); the CI watch ends with the session. */
	private noModelToolFor(session: RunnerSession): ClaudeNoModelToolHost | undefined {
		const tools = this._options.noModelTools;
		if (!tools) {
			return undefined;
		}
		return {
			ciWait: args => {
				const sessionId = this.sessionIdFor(session);
				if (!sessionId || session.abort.signal.aborted) {
					return { text: SESSION_STOPPED_MESSAGE, isError: true };
				}
				return tools.ciWait(sessionId, args, session.abort.signal);
			},
			verify: args => tools.verify(args),
			mergeGate: args => tools.mergeGate(args),
		};
	}

	/** Canvas pages for one session's query (issue 493), saved under the data folder, one folder per session. */
	private canvasToolFor(session: RunnerSession): ClaudeCanvasToolHost {
		const root = join(this._options.homeDirectory ?? homedir(), this._options.dataFolderName ?? product.dataFolderName, CLAUDE_CANVAS_FOLDER);
		return {
			save: async args => {
				const sessionId = this.sessionIdFor(session);
				if (!sessionId || session.abort.signal.aborted) {
					return { kind: 'failed', message: 'The session ended.' };
				}
				const saved = await saveClaudeCanvas(root, sessionId, args);
				void pruneClaudeCanvases(root, Date.now());
				return saved;
			},
		};
	}

	/** Gives the workbench a chance to save unsaved editors before a shell command. */
	private async beforeCommand(sessionId: string, toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<void> {
		const hook = this._options.beforeCommand;
		if (!hook || classifyTool(toolName) !== 'shell' || signal.aborted) {
			return;
		}
		const mode = this._options.saveBeforeCommands?.() ?? 'never';
		const command = input.command;
		if (mode === 'never' || typeof command !== 'string') {
			return;
		}
		try {
			await hook({ sessionId, command, mode, signal });
		} catch {
			// Saving is a convenience. The command runs against the files on disk.
		}
	}

	/**
	 * `agentID` is the sub-agent id. It becomes `parentRunId` only when
	 * `task_started` mapped it to the agent-tool call. An explicit tool-call id
	 * is already that run id.
	 */
	private parentRunIdFor(session: RunnerSession, context: Pick<ClaudeToolContext, 'agentId' | 'parentToolUseId'>): string | undefined {
		if (context.agentId) {
			const mapped = session.agentRuns.get(context.agentId);
			if (mapped) {
				return mapped;
			}
			if (!context.parentToolUseId) {
				return undefined;
			}
		}
		return context.parentToolUseId;
	}

	private async allowTool(session: RunnerSession, toolName: string, input: Record<string, unknown>, context: ClaudeToolContext): Promise<ClaudeToolPermission> {
		({ toolName, input } = claudePolicyToolCall(toolName, input));
		const sessionId = this.sessionIdFor(session);
		if (!sessionId || context.signal.aborted) {
			return { behavior: 'deny', message: SESSION_STOPPED_MESSAGE };
		}
		const parentRunId = this.parentRunIdFor(session, context);
		const category = classifyTool(toolName);
		const requestId = context.toolUseID;
		// The mode filter runs first, so Ask never reaches the policy with a write.
		const modeResult = evaluateModePolicy(session.mode, toolName, input);
		if (modeResult.behavior === 'deny') {
			this.settle(session, sessionId, { requestId, toolName, decision: 'deny', source: 'policy', subject: subjectOf(input), message: ASK_DENIAL_RECORD, blockedByMode: session.mode }, parentRunId);
			return { behavior: 'deny', message: modeResult.message, denial: modeResult.denial };
		}
		// Auto waits with the free tools, not with a sleeping loop that spends tokens (issue 1110).
		const pollingMessage = this._options.autoModeOn?.() ? claudeSleepPollingProblem(toolName, input) : undefined;
		if (pollingMessage) {
			this.settle(session, sessionId, { requestId, toolName, decision: 'deny', source: 'policy', subject: subjectOf(input), message: pollingMessage }, parentRunId);
			return { behavior: 'deny', message: pollingMessage };
		}
		// Claude's questions wait on the user's answers, not on an allow (issue 477).
		const questions = this.questionsFor(toolName, input);
		if (questions && this._options.elicitations) {
			return runClaudeQuestion({ bridge: this._options.elicitations, sessionId, push: event => session.queue.push(event) }, requestId, questions, input, AbortSignal.any([context.signal, session.abort.signal]));
		}

		// A dry run only reads; a merge goes ahead without a card when the user turned that on (issue 844).
		if (toolName === CLAUDE_MERGE_GATE_TOOL_ID && (input.dry_run === true || this._options.mergeWithoutAsking?.() === true)) {
			this.settle(session, sessionId, { requestId, toolName, decision: 'allow', scope: 'once', source: 'policy', subject: subjectOf(input) }, parentRunId);
			return { behavior: 'allow' };
		}

		// Under Auto in a trusted workspace a local start needs no card; other levels ask once (issue 991).
		if (toolName === CLAUDE_START_AGENT_TOOL_ID && session.trusted && this._host.sessionPermissions(sessionId)?.autoReview === true) {
			this.settle(session, sessionId, { requestId, toolName, decision: 'allow', scope: 'once', source: 'policy', subject: subjectOf(input) }, parentRunId);
			return { behavior: 'allow' };
		}

		const scope = this.scopeFor(sessionId, session);
		let verdict: PermissionVerdict;
		try {
			verdict = await this._host.evaluate(scope, toolName, input);
		} catch {
			// A policy that cannot decide does not allow.
			this.settle(session, sessionId, { requestId, toolName, decision: 'deny', source: 'policy', message: 'The IDE could not check this request.' }, parentRunId);
			return { behavior: 'deny', message: 'Denied by the IDE: it could not check this request.' };
		}
		if (verdict.behavior === 'deny') {
			const message = verdict.message ?? 'Denied by the IDE.';
			this.settle(session, sessionId, { requestId, toolName, decision: 'deny', source: 'policy', subject: verdict.subject, message: verdict.why, blockedByMode: verdict.modeDenial ? session.mode : undefined }, parentRunId);
			return { behavior: 'deny', message, denial: { code: verdict.modeDenial ? 'mode-read-only' : 'policy', mode: session.mode, tool: toolName, category } };
		}
		if (verdict.behavior === 'allow') {
			const snapshotted = await this.captureApprovedWrite(session, sessionId, requestId, toolName, verdict, parentRunId);
			if (snapshotted) {
				return snapshotted;
			}
			if (verdict.switchedBy) {
				this.settle(session, sessionId, { requestId, toolName, decision: 'allow', scope: 'session', source: verdict.switchedBy, subject: verdict.subject }, parentRunId);
			} else if (verdict.grantedBy) {
				this.settle(session, sessionId, { requestId, toolName, decision: 'allow', scope: verdict.grantedBy, source: 'grant', subject: verdict.subject }, parentRunId);
			}
			return { behavior: 'allow' };
		}

		const review = await this.autoReview(session, sessionId, scope, verdict, toolName, input, AbortSignal.any([context.signal, session.abort.signal]));
		if (review?.decision === 'allow') {
			const snapshotted = await this.captureApprovedWrite(session, sessionId, requestId, toolName, verdict, parentRunId);
			if (snapshotted) {
				return snapshotted;
			}
			this.settle(session, sessionId, { requestId, toolName, decision: 'allow', scope: 'once', source: 'auto', subject: verdict.subject }, parentRunId);
			await this.beforeCommand(sessionId, toolName, input, session.abort.signal);
			return { behavior: 'allow' };
		}
		if (context.signal.aborted || session.abort.signal.aborted) {
			this.settle(session, sessionId, { requestId, toolName, decision: 'deny', source: 'session-stopped', subject: verdict.subject }, parentRunId);
			return { behavior: 'deny', message: SESSION_STOPPED_MESSAGE, denial: { code: 'session-stopped', mode: session.mode, tool: toolName, category } };
		}

		const request: PermissionRequest = {
			...verdict.details,
			id: requestId,
			toolName,
			input,
			reason: context.decisionReason,
			why: review?.reason ?? verdict.why,
			canRemember: verdict.canRemember,
			mode: session.mode,
			canAllowAllCommands: canOfferAllowAllCommands(verdict.details, session.trusted),
			workspaceTrusted: session.trusted,
		};
		// Says why the session switches did not cover it, so a report can tell an untrusted workspace from a switch that was off (issue 741).
		this._options.log?.(`permission asks: tool=${toolName} because ${claudeSessionAskReason(verdict.details, this._host.sessionPermissions(sessionId), scope.trusted)}`);
		session.queue.push(parentRunId
			? { type: 'permission.requested', sessionId, parentRunId: parentRunId, request }
			: { type: 'permission.requested', sessionId, request });
		// Disposing the session ends the wait too, not only the SDK's own abort.
		const signal = AbortSignal.any([context.signal, session.abort.signal]);
		let decision: PermissionDecision;
		try {
			decision = await session.permissionBridge.request({
				sessionId,
				requestId,
				toolName,
				input,
				reason: context.decisionReason,
				signal,
			});
		} catch {
			decision = { behavior: 'deny', message: 'Permission request failed.' };
		}
		if (signal.aborted || decision.message === SESSION_STOPPED_MESSAGE) {
			this.settle(session, sessionId, { requestId, toolName, decision: 'deny', source: 'session-stopped', subject: verdict.subject }, parentRunId);
			return { behavior: 'deny', message: SESSION_STOPPED_MESSAGE, denial: { code: 'session-stopped', mode: session.mode, tool: toolName, category } };
		}
		if (decision.behavior !== 'allow') {
			this.settle(session, sessionId, { requestId, toolName, decision: 'deny', source: 'user', subject: verdict.subject }, parentRunId);
			return { behavior: 'deny', message: decision.message ?? 'Denied.', denial: { code: 'user-denied', mode: session.mode, tool: toolName, category } };
		}
		const snapshotted = await this.captureApprovedWrite(session, sessionId, requestId, toolName, verdict, parentRunId);
		if (snapshotted) {
			return snapshotted;
		}
		const granted = this._host.remember(scope, verdict, decision);
		this.settle(session, sessionId, { requestId, toolName, decision: 'allow', scope: granted, source: 'user', subject: verdict.subject }, parentRunId);
		// The screen asked instead of allowing, so it did not offer the save. The user approved, so offer it now.
		await this.beforeCommand(sessionId, toolName, input, signal);
		// The input the SDK runs is the input the user saw. A bridge cannot swap it.
		return { behavior: 'allow' };
	}

	/**
	 * Asks the Auto level's classifier about a request that would show a card
	 * (issue 510). Undefined when Auto is off or may not review this request; a
	 * classifier that fails answers ask.
	 */
	private async autoReview(session: RunnerSession, sessionId: string, scope: PermissionScope, verdict: PermissionVerdict, toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ClaudeAutoReviewVerdict | undefined> {
		const review = this._options.autoReview;
		if (!review || !claudeAutoReviewApplies(verdict.details, verdict.canRemember, this._host.sessionPermissions(sessionId), scope.trusted, this._options.autoReviewToggles?.())) {
			return undefined;
		}
		try {
			return await review({ toolName, input, cwd: session.cwd, executablePath: session.executablePath, signal });
		} catch {
			return { decision: 'ask' };
		}
	}

	private applyTurnCheckpoint(session: RunnerSession, turn: { readonly turnId?: string; readonly checkpointSessionId?: string; readonly dirtyBuffers?: readonly CheckpointDirtyBuffer[] } | undefined): void {
		if (!turn) {
			return;
		}
		if (turn.checkpointSessionId) {
			session.checkpointSessionId = turn.checkpointSessionId;
		}
		if (turn.turnId) {
			session.turnId = turn.turnId;
		}
		session.dirtyBuffers = turn.dirtyBuffers;
	}

	/** Git state and dirty buffers, before the query can write. Failures here fail the turn. */
	private async prepareCheckpoint(session: RunnerSession, sessionId: string): Promise<void> {
		const store = this._options.checkpoints;
		if (!store) {
			return;
		}
		const retention = this._options.retentionDays?.() ?? DEFAULT_CHECKPOINT_RETENTION_DAYS;
		if (this._options.checkpointsEnabled?.() === false) {
			try {
				await store.garbageCollect(retention);
			} catch {
				// Retention cleanup must not block the turn.
			}
			return;
		}
		const turnId = session.turnId ?? mintTurnId();
		session.turnId = turnId;
		const dirtyFiles = session.dirtyBuffers ?? [];
		session.dirtyBuffers = undefined;
		await store.beginTurn({
			sessionId: session.checkpointSessionId || sessionId,
			turnId,
			cwd: session.cwd,
			dirtyFiles,
		}, retention);
	}

	/**
	 * Snapshots a write target before allow is returned. A snapshot failure denies
	 * the write so the tool cannot change a file we cannot restore. A plan file in
	 * a plan folder is not a code change: it is not snapshotted, so it never shows
	 * for review and Undo never deletes it.
	 */
	private async captureApprovedWrite(session: RunnerSession, sessionId: string, requestId: string, toolName: string, verdict: PermissionVerdict, parentRunId?: string): Promise<ClaudeToolPermission | undefined> {
		const { targetPath } = verdict.details;
		if (this._options.checkpoints && this._options.checkpointsEnabled?.() !== false && classifyTool(toolName) === 'shell' && !session.preparedTarget?.kind) {
			// A shell command can change any file: watch the folder so Undo can restore what it touched.
			const turnId = session.turnId ?? mintTurnId();
			session.turnId = turnId;
			try {
				await this._options.checkpoints.beginShellWatch({ sessionId: session.checkpointSessionId || sessionId, turnId, cwd: session.cwd });
				session.shellCaptures.add(requestId);
			} catch {
				// Shell changes stay untracked, as before.
			}
			return undefined;
		}
		if (!this._options.checkpoints || this._options.checkpointsEnabled?.() === false || classifyTool(toolName) !== 'write' || !targetPath || verdict.planFile) {
			return undefined;
		}
		const turnId = session.turnId ?? mintTurnId();
		session.turnId = turnId;
		try {
			const location = writeLocation(session, targetPath);
			if (!location) {
				// Outside the dev container's workspace mount, or relative to an SSH home: nothing here to restore.
				this._options.log?.(`Not capturing ${toolName} on ${session.preparedTarget?.kind}: ${targetPath} has no copy Klawly can restore.`);
				return undefined;
			}
			if (typeof location !== 'string') {
				const uri = claudeRemoteUri(location.host, location.path).toString();
				const before = await this.remoteFiles().readFile(location.host, location.path);
				await this._options.checkpoints.snapshotRemoteWrite({ sessionId: session.checkpointSessionId || sessionId, turnId, uri, bytes: before ? before.buffer : null });
				session.writeCaptures.set(requestId, uri);
				return undefined;
			}
			await this._options.checkpoints.snapshotApprovedWrite({
				sessionId: session.checkpointSessionId || sessionId,
				turnId,
				cwd: session.cwd,
				absolutePath: location,
			});
			session.writeCaptures.set(requestId, location);
			return undefined;
		} catch {
			this.settle(session, sessionId, { requestId, toolName, decision: 'deny', source: 'policy', subject: verdict.subject, message: 'The file could not be snapshotted.' }, parentRunId);
			return { behavior: 'deny', message: 'The IDE could not snapshot the file before writing, so the write was denied.' };
		}
	}

	private scopeFor(sessionId: string, session: RunnerSession): PermissionScope {
		return {
			sessionId,
			cwd: session.cwd,
			workspaceFolders: session.workspaceFolders,
			additionalDirectories: session.additionalDirectories ?? [],
			trusted: session.trusted,
			mode: session.mode,
			planDirectories: this.planDirectories(),
			klawlyPlanDirectory: this._klawlyPlanDirectory,
		};
	}

	/** Records the outcome in the host history and tells the renderer. */
	private settle(session: RunnerSession, sessionId: string, outcome: PermissionOutcome, parentRunId?: string): void {
		// A session that ended while a request was pending has no history to extend and no queue to tell.
		if (this._sessions.get(sessionId) !== session) {
			return;
		}
		this._host.record(sessionId, outcome);
		session.queue.push(parentRunId
			? { type: 'permission.resolved', sessionId, parentRunId, outcome }
			: { type: 'permission.resolved', sessionId, outcome });
	}

	private sessionIdFor(session: RunnerSession): string | undefined {
		for (const [sessionId, candidate] of this._sessions) {
			if (candidate === session) {
				return sessionId;
			}
		}
		return undefined;
	}

	private async consume(sessionId: string, query: ClaudeQuery, generation: number): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (!session || session.generation !== generation) {
			return;
		}
		const openCalls = new Set<string>();
		try {
			for await (const message of query) {
				if (this._sessions.get(sessionId)?.generation !== generation) {
					break;
				}
				if (this._options.retainRawMessages?.()) {
					this._options.onRawMessage?.(sessionId, message);
				}
				const normalized = normalizeClaudeMessage(message, sessionId, session.normalizer, line => this._options.log?.(line));
				session.turnAnchor = claudeChainAnchor(message) ?? session.turnAnchor;
				if (normalized.sdkSessionId) {
					session.sdkSessionId = normalized.sdkSessionId;
				}
				if (normalized.init) {
					this.rememberInit(normalized.init);
					void this.refreshListings(sessionId, session, generation, query);
				}
				if (normalized.init || normalized.endedTurn || normalized.rateLimitChanged) {
					void this.refreshUsage(sessionId, session, generation, query);
				}
				for (const binding of normalized.taskBindings ?? []) {
					session.tasks.set(binding.runId, binding.taskId);
					session.agentRuns.set(binding.agentId, binding.runId);
				}
				for (const normalizedEvent of normalized.events) {
					if (normalizedEvent.type === 'tool.started') {
						openCalls.add(normalizedEvent.call.id);
						this._options.registry.setOpenCalls(sessionId, openCalls.size);
					} else if (normalizedEvent.type === 'tool.completed') {
						openCalls.delete(normalizedEvent.callId);
						this._options.registry.setOpenCalls(sessionId, openCalls.size);
					}
					if (normalizedEvent.type === 'session.started') {
						session.resumeAttempt = undefined;
						session.resumeAt = undefined;
					}
					if (normalizedEvent.type === 'tool.completed') {
						await this.noteCapturedTool(session, normalizedEvent.callId);
					}
					if (normalizedEvent.type === 'session.failed') {
						// The banner offers what the plan allows, so the limit names the plan (issue 450).
						const plan = this._account?.plan;
						this.finishTurn(sessionId, generation, normalizedEvent.limit && plan && !normalizedEvent.limit.plan ? { ...normalizedEvent, limit: { ...normalizedEvent.limit, plan } } : normalizedEvent);
					} else {
						this.publish(session, withClaudeInstructionSources(withClaudeExecutionTarget(normalizedEvent, session.executionTarget, session.targetNotice), session.instructionSources));
						if (normalizedEvent.type === 'session.started' && normalizedEvent.parentRunId === undefined) {
							session.targetNotice = undefined;
						}
						if (this._turnOpen.has(sessionId)) {
							this._options.registry.arm(sessionId);
						}
					}
				}
				if (normalized.endedTurn) {
					openCalls.clear();
					this._options.registry.setOpenCalls(sessionId, 0);
					this._options.registry.disarm(sessionId);
				}
				if (normalized.endedTurn === 'success') {
					this.finishTurn(sessionId, generation, { type: 'session.completed', sessionId, ...(session.turnAnchor ? { anchor: session.turnAnchor } : {}) });
					void this.nameSession(sessionId, session);
				}
			}
			if (this._sessions.get(sessionId)?.generation === generation) {
				if (this._options.registry.wasTimedOut(sessionId)) {
					const minutes = Math.round((this._options.timeoutMs ?? DEFAULT_CLAUDE_SESSION_TIMEOUT_MS) / 60000);
					this.finishTurn(sessionId, generation, { type: 'session.failed', sessionId, message: `Stopped after ${minutes} minutes without activity.`, kind: 'process-crash' });
				} else {
					this.finishTurn(sessionId, generation, { type: 'session.completed', sessionId });
				}
			}
		} catch (error) {
			await this.finishWriteCaptures(session);
			this.failQuery(sessionId, generation, session, error);
		} finally {
			await this.finishWriteCaptures(session);
			if (this._sessions.get(sessionId)?.generation === generation) {
				this._options.registry.untrack(sessionId);
				session.queue.close();
			}
		}
	}

	private rememberInit(init: ClaudeInitMetadata): void {
		this._skills = init.skills;
		this._runtimeVersion = init.claudeCodeVersion ?? this._runtimeVersion;
		if (init.slashCommands.length > 0) {
			this._commands = init.slashCommands.map(name => ({ name, description: '' }));
		}
	}

	/**
	 * Reads the command, model and subagent listings once the query is up, and sends
	 * the session its `/` menu catalog. A query that cannot list leaves the names
	 * `session.started` gave.
	 */
	private async refreshListings(sessionId: string, session: RunnerSession, generation: number, query: ClaudeQuery): Promise<void> {
		let commands: readonly ClaudeQueryCommand[] = [];
		try {
			const [listed, models] = await Promise.all([query.supportedCommands(), query.supportedModels()]);
			commands = listed;
			if (listed.length > 0) {
				this._commands = listed;
			}
			if (models.length > 0) {
				this._models.splice(0, this._models.length, ...models.map(toModelInfo));
			}
		} catch {
			// Listings are optional. Init metadata already recorded the command and skill names.
		}
		let agents: readonly ClaudeQueryAgent[] = [];
		try {
			agents = await query.supportedAgents?.() ?? [];
		} catch {
			// A runtime without subagent listings offers none in the menu.
		}
		if (commands.length === 0 && agents.length === 0) {
			return;
		}
		let catalog: readonly ClaudeCommandInfo[] = [];
		if (commands.length > 0) {
			catalog = await readClaudeCommandCatalog(commands, this._skills, session.cwd, this._configDirectory);
		}
		const subagents = agents.map(toClaudeSubagentInfo);
		this._catalogCommands = catalog;
		this._catalogAgents = subagents;
		if (this._sessions.get(sessionId) !== session || session.generation !== generation) {
			return;
		}
		this.publish(session, { type: 'session.catalog', sessionId, commands: catalog, agents: subagents });
	}

	/**
	 * Asks the query for the plan limits when the session starts, after each turn and
	 * whenever Claude Code reports a rate-limit change, and sends them as
	 * `session.usageLimits` so the chat's usage row stays current. A query that
	 * cannot report them, or whose call fails, sends nothing. One call per session
	 * at a time: a refresh asked for while one runs is dropped.
	 */
	private async refreshUsage(sessionId: string, session: RunnerSession, generation: number, query: ClaudeQuery): Promise<void> {
		if (!query.usageLimits || this._usageRefreshes.has(session) || this._staleAccount.has(session)) {
			return;
		}
		this._usageRefreshes.add(session);
		let windows: readonly ClaudeUsageWindow[] | undefined;
		try {
			windows = await query.usageLimits();
		} catch {
			return;
		} finally {
			this._usageRefreshes.delete(session);
		}
		if (this._staleAccount.has(session)) {
			// The account changed while the call ran: this answer belongs to the old one.
			return;
		}
		this.rememberUsage(windows);
		if (this._sessions.get(sessionId) !== session || session.generation !== generation) {
			return;
		}
		this.publish(session, { type: 'session.usageLimits', sessionId, windows: windows ?? [] });
	}

	/**
	 * Asks once, after the first finished turn of a fresh chat, for a short title.
	 * A resumed chat or one that opened with a slash command keeps its title.
	 */
	private async nameSession(sessionId: string, session: RunnerSession): Promise<void> {
		const firstPrompt = session.titlePrompt;
		const source = this._options.sessionTitle;
		if (firstPrompt === undefined || !source) {
			return;
		}
		session.titlePrompt = undefined;
		let title: string | undefined;
		try {
			title = (await source({ sessionId, claudeSessionId: session.sdkSessionId, cwd: session.cwd, firstPrompt, executablePath: session.executablePath }))?.trim();
		} catch {
			// The first prompt stays the title.
			return;
		}
		if (!title || this._sessions.get(sessionId) !== session) {
			return;
		}
		this.publish(session, { type: 'session.titled', sessionId, title });
	}

	private failPendingModel(session: RunnerSession, error: unknown): void {
		const waiters = session.modelWaiters.splice(0, session.modelWaiters.length);
		session.pendingModel = undefined;
		if (waiters.length > 0 && session.modelBeforePending !== undefined) {
			session.modelId = session.modelBeforePending;
		}
		for (const waiter of waiters) {
			waiter.reject(error);
		}
	}

	/** Sends what changed while `query()` was starting. A refusal restores the earlier choice. */
	private async applyPendingSettings(sessionId: string, session: RunnerSession): Promise<void> {
		const waiters = session.settingsWaiters.splice(0, session.settingsWaiters.length);
		const applied = session.appliedSettings ?? DEFAULT_CLAUDE_SESSION_SETTINGS;
		const before = session.settingsBeforePending;
		session.settingsBeforePending = undefined;
		if (waiters.length === 0 && sameClaudeSessionSettings(applied, session.settings)) {
			return;
		}
		const settings = session.settings;
		try {
			const patch = claudeFlagSettingsPatch(applied, settings);
			if (patch) {
				await this._options.registry.applyFlagSettings(sessionId, patch);
			}
			session.appliedSettings = settings;
			this.publish(session, { type: 'session.settingsChanged', sessionId, settings });
			for (const waiter of waiters) {
				waiter.resolve();
			}
		} catch (error) {
			session.settings = before ?? applied;
			for (const waiter of waiters) {
				waiter.reject(error);
			}
		}
	}

	private failPendingSettings(session: RunnerSession, error: unknown): void {
		const waiters = session.settingsWaiters.splice(0, session.settingsWaiters.length);
		if (waiters.length > 0 && session.settingsBeforePending) {
			session.settings = session.settingsBeforePending;
		}
		session.settingsBeforePending = undefined;
		for (const waiter of waiters) {
			waiter.reject(error);
		}
	}

	private async applyPendingModel(sessionId: string, session: RunnerSession, query: ClaudeQuery): Promise<void> {
		const waiters = session.modelWaiters.splice(0, session.modelWaiters.length);
		const modelId = session.pendingModel;
		session.pendingModel = undefined;
		if (!modelId) {
			return;
		}
		try {
			await query.setModel(modelId);
			session.modelId = modelId;
			this.publish(session, { type: 'session.modelChanged', sessionId, modelId });
			for (const waiter of waiters) {
				waiter.resolve();
			}
		} catch (error) {
			session.modelId = session.modelBeforePending;
			for (const waiter of waiters) {
				waiter.reject(error);
			}
		}
	}

	private openTurn(sessionId: string): void {
		this._turnOpen.add(sessionId);
		const session = this._sessions.get(sessionId);
		if (session) {
			session.turnAnchor = undefined;
		}
	}

	private failQuery(sessionId: string, generation: number, session: RunnerSession, error: unknown): void {
		const failure = classifyAgentFailure(error);
		const message = resumeFailureMessage(error, session.resumeAttempt) ?? claudeSandboxFailureMessage(failure.message, process.platform) ?? failure.message;
		const targetInstall = error instanceof ClaudeExecutionTargetError ? error.install : undefined;
		this.finishTurn(sessionId, generation, { type: 'session.failed', sessionId, message, kind: failure.kind, ...(targetInstall ? { targetInstall } : {}) });
	}

	private finishTurn(sessionId: string, generation: number, terminal: Extract<NormalizedClaudeEvent, { type: 'session.failed' | 'session.completed' }>): void {
		const session = this._sessions.get(sessionId);
		if (!session || session.generation !== generation || !this._turnOpen.has(sessionId)) {
			return;
		}
		this._turnOpen.delete(sessionId);
		this._options.registry.disarm(sessionId);
		this.publish(session, terminal);
	}

	/** Records disk bytes after a write tool ends, then drops the capture. */
	private async noteCapturedTool(session: RunnerSession, callId: string): Promise<void> {
		if (session.shellCaptures.delete(callId)) {
			try {
				await this._options.checkpoints?.settleShellWatch(session.checkpointSessionId);
			} catch {
				// A missed shell change only means Undo leaves that file alone.
			}
			return;
		}
		const captured = session.writeCaptures.get(callId);
		if (!captured) {
			return;
		}
		session.writeCaptures.delete(callId);
		const store = this._options.checkpoints;
		if (!store) {
			return;
		}
		try {
			await this.noteAfterWrite(session, store, captured);
		} catch {
			// The original snapshot is already on disk.
		}
	}

	private async finishWriteCaptures(session: RunnerSession): Promise<void> {
		const paths = [...session.writeCaptures.values()];
		session.writeCaptures.clear();
		const store = this._options.checkpoints;
		if (!store) {
			return;
		}
		for (const captured of paths) {
			try {
				await this.noteAfterWrite(session, store, captured);
			} catch {
				// The original snapshot is already on disk.
			}
		}
	}

	/** The bytes after a write, read from this machine or, for a `claude-remote:` capture, from the host. */
	private async noteAfterWrite(session: RunnerSession, store: ClaudeCheckpointStore, captured: string): Promise<void> {
		const remote = captured.startsWith(`${CLAUDE_REMOTE_SCHEME}:`) ? parseClaudeRemoteUri(URI.parse(captured)) : undefined;
		if (!remote) {
			await store.noteAfterWrite(session.checkpointSessionId, captured);
			return;
		}
		const after = await this.remoteFiles().readFile(remote.host, remote.path);
		await store.noteRemoteAfterWrite(session.checkpointSessionId, captured, after ? after.buffer : null);
	}

	private remoteFiles(): Pick<IClaudeRemoteFilesService, 'readFile'> {
		this._remoteFiles ??= this._options.remoteFiles ?? new ClaudeRemoteFiles(this._options.executionTargetHost ?? defaultClaudeTargetHost());
		return this._remoteFiles;
	}

	private publish(session: RunnerSession, normalizedEvent: NormalizedClaudeEvent): void {
		if (!session.queue.push(normalizedEvent)) {
			this._options.onEvent?.(normalizedEvent);
		}
	}

	private notePrompt(text: string): void {
		if (isSlashCommandPrompt(text)) {
			this._options.log?.('Submitted a slash command as prompt text so Claude Code can dispatch it.');
		}
	}

	private requireSession(sessionId: string): RunnerSession {
		const session = this._sessions.get(sessionId);
		if (!session) {
			throw new Error(`Unknown Claude session: ${sessionId}`);
		}
		return session;
	}
}

function mintTurnId(): string {
	return `turn-${generateUuid()}`;
}

/**
 * Where a write tool's file is, for change capture: a path on this machine (a
 * dev container's workspace is a bind mount of it), a file on the SSH host, or
 * undefined when Klawly has no copy it can restore.
 */
function writeLocation(session: RunnerSession, targetPath: string): string | { readonly host: string; readonly path: string } | undefined {
	const target = session.preparedTarget;
	if (target?.kind === 'ssh') {
		const remoteFolder = target.remotePath && posix.isAbsolute(target.remotePath) ? target.remotePath : undefined;
		const path = posix.isAbsolute(targetPath) ? posix.normalize(targetPath) : remoteFolder ? posix.join(remoteFolder, targetPath) : undefined;
		return path ? { host: target.host, path } : undefined;
	}
	if (target?.kind === 'devcontainer' && targetPath.startsWith('/')) {
		return claudeContainerPathToLocal(target, targetPath);
	}
	return resolveWritePath(session.cwd, targetPath);
}

/** A relative tool path is resolved against the session directory. Anything else is refused. */
function resolveWritePath(cwd: string, targetPath: string): string {
	if (isAbsolute(targetPath)) {
		return targetPath;
	}
	if (!isAbsolute(cwd)) {
		throw new Error('Checkpoint write path is not absolute.');
	}
	const resolved = join(cwd, targetPath);
	if (!isAbsolute(resolved)) {
		throw new Error('Checkpoint write path is not absolute.');
	}
	return resolved;
}

export function isSlashCommandPrompt(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith('/') && /^\/[A-Za-z0-9_:-]+/.test(trimmed);
}

function toModelInfo(model: ClaudeQueryModel): ClaudeModelInfo {
	const levels = model.supportedEffortLevels?.filter(isClaudeEffortLevel);
	return {
		id: model.id,
		displayName: model.displayName,
		description: model.description,
		source: 'runtime',
		resolvedModel: model.resolvedModel,
		supportsEffort: model.supportsEffort,
		// Lowest first, whatever order the runtime listed them in.
		supportedEffortLevels: levels ? CLAUDE_EFFORT_LEVELS.filter(level => levels.includes(level)) : undefined,
		supportsAdaptiveThinking: model.supportsAdaptiveThinking,
		supportsFastMode: model.supportsFastMode,
		supportsAutoMode: model.supportsAutoMode,
	};
}

class ClaudePromptStream implements AsyncIterable<ClaudePromptMessage> {
	private readonly _queue: ClaudePromptMessage[] = [];
	private readonly _waiters: Array<(result: IteratorResult<ClaudePromptMessage>) => void> = [];
	private _closed = false;

	acceptsInput(): boolean {
		return !this._closed;
	}

	push(text: string): void {
		if (this._closed) {
			return;
		}
		const message: ClaudePromptMessage = {
			type: 'user',
			message: { role: 'user', content: text },
			parent_tool_use_id: null,
		};
		const waiter = this._waiters.shift();
		if (waiter) {
			waiter({ value: message, done: false });
			return;
		}
		this._queue.push(message);
	}

	close(): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		for (const waiter of this._waiters.splice(0)) {
			waiter({ value: undefined as unknown as ClaudePromptMessage, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<ClaudePromptMessage> {
		return {
			next: () => {
				const queued = this._queue.shift();
				if (queued) {
					return Promise.resolve({ value: queued, done: false as const });
				}
				if (this._closed) {
					return Promise.resolve({ value: undefined as unknown as ClaudePromptMessage, done: true as const });
				}
				return new Promise(resolve => this._waiters.push(resolve));
			},
		};
	}
}

class ClaudeEventQueue implements AsyncIterable<NormalizedClaudeEvent> {
	private readonly _items: NormalizedClaudeEvent[] = [];
	private readonly _waiters: Array<(result: IteratorResult<NormalizedClaudeEvent>) => void> = [];
	private _closed = false;

	push(event: NormalizedClaudeEvent): boolean {
		if (this._closed) {
			return false;
		}
		const waiter = this._waiters.shift();
		if (waiter) {
			waiter({ value: event, done: false });
			return true;
		}
		this._items.push(event);
		return true;
	}

	close(): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		for (const waiter of this._waiters.splice(0)) {
			waiter({ value: undefined as unknown as NormalizedClaudeEvent, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<NormalizedClaudeEvent> {
		return {
			next: () => {
				const queued = this._items.shift();
				if (queued) {
					return Promise.resolve({ value: queued, done: false as const });
				}
				if (this._closed) {
					return Promise.resolve({ value: undefined as unknown as NormalizedClaudeEvent, done: true as const });
				}
				return new Promise(resolve => this._waiters.push(resolve));
			},
		};
	}
}

function subjectOf(input: unknown): string | undefined {
	if (typeof input !== 'object' || input === null) {
		return undefined;
	}
	const record = input as Record<string, unknown>;
	for (const field of ['command', 'file_path', 'notebook_path', 'path', 'url']) {
		if (typeof record[field] === 'string') {
			return record[field];
		}
	}
	return undefined;
}

/** Key for the tool limits a query opens with in `mode`. */
function limitsKey(mode: AgentMode): string {
	return (disallowedToolsForMode(mode) ?? []).join(',');
}
