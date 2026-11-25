/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ClaudeAccountDetails, ClaudeAccountOverview, ClaudeUsageRefresh, ClaudeUsageWindow } from '../common/claudeAccount.js';
import { CLAUDE_DEFAULT_ACCOUNT_ID, ClaudeAccountEntry, ClaudeAccountSignIn } from '../common/claudeAccounts.js';
import { claudeConfigDirectory } from '../common/claudePlanFiles.js';
import { CLAUDE_ACCOUNTS_FOLDER, ClaudeAccountStore, ClaudeSavedAccount } from './claudeAccountStore.js';
import { ClaudeMcpAppLoad, ClaudeMcpResourceContent } from '../common/claudeMcpApps.js';
import { ClaudeAgentsFilesSettings } from '../common/claudeAgentsFiles.js';
import { ClaudeReplyStyle } from '../common/claudeReplyStyle.js';
import { ClaudeVerifyUi } from '../common/claudeVerifyUi.js';
import { addClaudeUserMcpServer, CLAUDE_USER_LAYER_FILES, claudeUserLayerDirectory, ClaudeUserLayerSettings, removeClaudeUserMcpServer } from '../common/claudeUserLayer.js';
import product from '../../product/common/product.js';
import { ClaudeInlineCompletionRequest } from '../common/claudeAutocomplete.js';
import { ClaudeCommandListing } from '../common/claudeCommands.js';
import { ClaudeStatusReport } from '../common/claudeStatusTool.js';
import { ClaudeFeedbackToolRequest } from '../common/claudeFeedbackTool.js';
import { BeginClaudeRequest, ClaudeSessionMessageRequest, ClaudeModelInfo, ClaudeRawSdkMessage, ClaudeReviewResult, ClaudeRunHandle, ClaudeRuntimeState, ClaudeSaveBeforeCommandRequest, ClaudeUserInput, IClaudeRuntimeService } from '../common/claude.js';
import { ClaudeCheckpointStore } from '../common/claudeCheckpointStore.js';
import { ClaudeSaveBeforeCommandsMode } from '../common/claudeConfiguration.js';
import { ClaudeGitSettings } from '../common/claudeGitSettings.js';
import { ClaudeSecuritySettings } from '../common/claudeSecuritySettings.js';
import { claudeMcpAddArguments, ClaudeMcpAddRequest, claudeMcpRemoveArguments, ClaudeMcpRemoveRequest, ClaudeMcpScope, readClaudeMcpAddRequest, readClaudeMcpRemoveRequest } from '../common/claudeMcpConfig.js';
import { PermissionPolicy } from '../common/claudePermissions.js';
import { claudePluginCommandArguments, ClaudePluginCommand, ClaudePluginCommandResult, readClaudePluginCommand, readClaudePluginCommandResult } from '../common/claudePlugins.js';
import { claudeRemoteControlName, ClaudeRemoteControlState } from '../common/claudeRemoteControl.js';
import { ClaudeCloudCapability, claudeCloudSendArguments, ClaudeCloudSendRequest, ClaudeCloudSendResult, readClaudeCloudCapability, readClaudeCloudSendResult, readClaudeCloudSessionId, readClaudeCloudText } from '../common/claudeCloud.js';
import { ClaudeContextBreakdown, NormalizedClaudeEvent, PermissionChoice } from '../common/claudeProtocol.js';
import { ClaudeElicitationAnswer } from '../common/claudeElicitation.js';
import { ClaudeReviewRequest } from '../common/claudeReviewLoop.js';
import { ClaudeSessionPermissions, readClaudeSessionPermissions } from '../common/claudeSessionPermissions.js';
import { ClaudeSessionSettings, readClaudeSessionSettings } from '../common/claudeSessionSettings.js';
import { readClaudeWorkerProfile } from '../common/claudeWorkerProfile.js';
import { readClaudeExecutionTarget } from '../common/claudeExecutionTarget.js';
import { CLAUDE_SESSION_TITLE_MODEL, claudeSessionTitlePrompt, readClaudeSessionTitle } from '../common/claudeSessionTitle.js';
import { ClaudeSideQuestionRequest, ClaudeSideQuestionResult } from '../common/claudeSideQuestion.js';
import { ClaudeTerminalRunRequest, ClaudeTerminalRunResult } from '../common/claudeTerminalRun.js';
import { ClaudeDebugExtraLines, ClaudeReproductionAnswer } from '../common/claudeDebugMode.js';
import { ClaudeDebugSessions } from './claudeDebugLogSink.js';
import { ClaudeAgentRunRequest, ClaudeAgentRunner, CLAUDE_USAGE_FRESH_MS, CLAUDE_USAGE_RECENT_MS, ClaudeBeforeCommandRequest, ClaudePermissionBridge, ClaudeSessionTitleRequest, ClaudeTerminalRunToolRequest } from './claudeAgentRunner.js';
import { ClaudeNoModelTools } from './claudeNoModelTools.js';
import { createClaudeNoModelHost } from './claudeNoModelHost.js';
import { ClaudePermissionHost, ClaudeUserPermissionBridge, nodeRealpath } from './claudePermissionHost.js';
import { isAbsolute, join } from '../../../base/common/path.js';
import { ClaudeElicitationBridge } from './claudeElicitationBridge.js';
import { classifyAgentFailure, failureMessage } from './claudeFailure.js';
import { ClaudeLiveSession, claudeSessionBlockedBy } from '../common/claudeSessionOwner.js';
import { ClaudeProcessRegistry } from './claudeProcessRegistry.js';
import { runClaudeInlineCompletion } from './claudeAutocompleteQuery.js';
import { ClaudeComparisonJudgeRequest, ClaudeComparisonJudgeResult } from '../common/claudeComparison.js';
import { runClaudeComparisonJudge } from './claudeComparisonJudge.js';
import { ClaudeAutoModelClassification, ClaudeAutoModelRequest } from '../common/claudeAutoModel.js';
import { runClaudeAutoModelClassifier } from './claudeAutoModelQuery.js';
import { runClaudeSideQuestion } from './claudeSideQuestionQuery.js';
import { createClaudeGist, readClaudeGist } from './claudeGist.js';
import { ClaudeGistReadResult, ClaudeGistRequest, ClaudeGistResult } from '../common/claudeShare.js';
import { nodeClaudeStatusLineHost, runClaudeStatusLine } from './claudeStatusLineRunner.js';
import { ClaudeStatusLineRequest, ClaudeStatusLineResult } from '../common/claudeStatusLine.js';
import { ClaudeQueryFactory } from './claudeQuery.js';
import { runClaudeReviewQuery } from './claudeReviewQuery.js';
import { runClaudeAutoReview } from './claudeAutoReviewQuery.js';
import { ClaudeAutoReviewInstructions, ClaudeAutoReviewToggles, NO_AUTO_REVIEW_INSTRUCTIONS, NO_AUTO_REVIEW_TOGGLES } from '../common/claudeAutoReview.js';
import { probeClaudeUsage } from './claudeModelProbe.js';
import { ClaudeRuntimeProbe, claudeProcessEnvironment, defaultExecFile, ExecFileRunner, parseAuthStatusAccount, probeClaudeRuntime } from './claudeRuntime.js';
import { ClaudeCliAdapter } from './claudeCliAdapter.js';
import { createClaudeCliQuery } from './claudeCliQuery.js';
import { readClaudeCodeSessionTitle } from './claudeSessionTitle.js';
import { NodeCheckpointStorage } from './claudeCheckpointNodeStorage.js';
import { claudeCacheRoot, ClaudeMcpControlAction, ClaudeMcpLog } from '../common/claudeMcpControl.js';
import { readClaudeMcpLog } from './claudeMcpLogs.js';
import { ClaudeBrowserToolArgs, ClaudeBrowserToolRequest, ClaudeBrowserToolResult } from '../common/claudeBrowserTool.js';
import { ClaudeSettingsToolArgs, ClaudeSettingsToolRequest, ClaudeSettingsToolResult } from '../common/claudeSettingsTool.js';
import { ClaudeDelegateToolArgs, ClaudeDelegateToolRequest, ClaudeDelegateToolResult } from '../common/claudeDelegate.js';
import { ClaudeDepartmentToolArgs, ClaudeDepartmentToolRequest, ClaudeDepartmentToolResult } from '../common/claudeDepartment.js';
import { ClaudeStartAgentToolArgs, ClaudeStartAgentToolRequest, ClaudeStartAgentToolResult } from '../common/claudeStartAgent.js';

export interface ClaudeNodeRuntimeOptions {
	readonly queryFactory?: ClaudeQueryFactory;
	readonly execFile?: ExecFileRunner;
	readonly timeoutMs?: number;
	readonly maxTurns?: number;
	readonly runtimePath?: string;
	readonly knownBadVersions?: readonly string[];
	readonly homeDirectory?: string;
	/** Replaces the prompt that waits for the user. Tests use this. The host policy still runs first. */
	readonly permissionBridge?: ClaudePermissionBridge;
	/** Read on every request, so a settings change applies to the next tool call. */
	readonly getPermissionPolicy?: () => PermissionPolicy;
	/** The Auto level's allow and block instructions (issue 510), read on every classifier call. */
	readonly autoReviewInstructions?: () => ClaudeAutoReviewInstructions;
	readonly autoReviewToggles?: () => ClaudeAutoReviewToggles;
	/** Auto mode is on (issue 1110). */
	readonly autoModeOn?: () => boolean;
	readonly builtInAgents?: boolean;
	/** Read when a query starts, so `claude.subagents.builtInAgents` applies to the next session. Wins over `builtInAgents`. */
	readonly builtInAgentsEnabled?: () => boolean;
	/** Read when a query starts, so `klawly.delegation.enabled` applies to the next session. Absent leaves delegation on. */
	readonly delegationEnabled?: () => boolean;
	/** Read when a session starts, so the `claude.git.*` settings apply to the next session. */
	readonly gitSettings?: () => ClaudeGitSettings;
	/** Read when a session starts, so the sandbox, telemetry export and policy settings apply to the next session. */
	readonly securitySettings?: () => ClaudeSecuritySettings;
	/** Read when a session starts, so the `claude.instructions.*` settings apply to the next session (issue 499). */
	readonly agentsFiles?: () => ClaudeAgentsFilesSettings;
	/** Read when a session starts, so `claude.agent.replyStyle` applies to the next session (issue 462). */
	readonly replyStyle?: () => ClaudeReplyStyle;
	/** Read when a session starts: whether the Maker section joins the system prompt (issue 1184). */
	readonly makerMode?: () => boolean;
	/** Read when a session starts, so `claude.agent.workRules` applies to the next session (issue 1388). */
	readonly workRules?: () => boolean;
	/** Read when a session starts, so `claude.agent.verifyUiChanges` applies to the next session (issue 467). */
	readonly verifyUi?: () => ClaudeVerifyUi;
	/** Read when a session starts, so `claude.customize.useClaudeCodeSetup` applies to the next session (issue 455). */
	readonly userLayer?: () => ClaudeUserLayerSettings;
	/** The product's per-user data folder name, such as `.klawly`, that holds the user layer. Defaults to the running product's. */
	readonly dataFolderName?: string;
	readonly log?: (line: string) => void;
	/** Root of `<userData>/checkpoint-objects` and `agent-sessions`. Absent skips snapshots. */
	readonly userDataPath?: string;
	readonly checkpointsEnabled?: () => boolean;
	readonly retentionDays?: () => number;
	/** Read on each SDK message. Raw messages are emitted only while this is true. */
	readonly retainRawMessages?: () => boolean;
	/** `claude.telemetry.enabled`, read whenever a Claude process starts. Absent means off. */
	readonly telemetryEnabled?: () => boolean;
	/** `claude.agent.saveBeforeCommands`, read before each shell command. Absent means `never`. */
	readonly saveBeforeCommands?: () => ClaudeSaveBeforeCommandsMode;
	/** `klawly.delegation.mergeWithoutAsking`, read before each merge (issue 844). Absent means ask. */
	readonly mergeWithoutAsking?: () => boolean;
	/** How long a command waits for the workbench to save. Defaults to {@link SAVE_BEFORE_COMMAND_TIMEOUT_MS}. */
	readonly saveBeforeCommandTimeoutMs?: (mode: Exclude<ClaudeSaveBeforeCommandsMode, 'never'>) => number;
	/**
	 * Names a fresh chat after its first turn. Defaults to Claude Code's own title, else a
	 * one-turn title request. Off when `queryFactory` replaces the SDK, which keeps no transcript.
	 */
	readonly sessionTitle?: (request: ClaudeSessionTitleRequest) => Promise<string | undefined>;
	/**
	 * Answers MCP elicitation in the IDE (issue 428): requests become
	 * `elicitation.requested` and wait for `resolveElicitation`. Off, Claude Code declines them.
	 */
	readonly elicitations?: boolean;
}

/**
 * Upper bounds for the wait before a shell command. Both stay under the SDK's
 * one-minute hook timeout. When one passes, the command runs against the files on disk.
 */
export const SAVE_BEFORE_COMMAND_TIMEOUT_MS: Readonly<Record<Exclude<ClaudeSaveBeforeCommandsMode, 'never'>, number>> = {
	always: 15_000,
	prompt: 50_000,
};

/** How long a settings tool call waits for a window (issue 525). */
const SETTINGS_REQUEST_TIMEOUT_MS = 30_000;
/** How long a browser action waits for the window: page loads and screenshots take time (issue 466). */
const BROWSER_REQUEST_TIMEOUT_MS = 90_000;
/** How long a `claude mcp` subcommand may take. */
const CLAUDE_COMMAND_TIMEOUT_MS = 30_000;
/** `claude plugin install` and `marketplace add` clone Git repositories. */
const CLAUDE_PLUGIN_COMMAND_TIMEOUT_MS = 5 * 60_000;

/**
 * Node implementation of `IClaudeRuntimeService`. Phase 5 registers it in the workbench.
 * `runtimePath` is the `claude.agent.runtimePath` override.
 */
export class ClaudeNodeRuntimeService extends Disposable implements IClaudeRuntimeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeRuntimeState = this._register(new Emitter<ClaudeRuntimeState>());
	readonly onDidChangeRuntimeState = this._onDidChangeRuntimeState.event;

	private readonly _onDidEmitEvent = this._register(new Emitter<NormalizedClaudeEvent>());
	readonly onDidEmitEvent = this._onDidEmitEvent.event;

	private readonly _onDidEmitRawMessage = this._register(new Emitter<ClaudeRawSdkMessage>());
	readonly onDidEmitRawMessage = this._onDidEmitRawMessage.event;

	private readonly _onDidRequestSaveBeforeCommand = this._register(new Emitter<ClaudeSaveBeforeCommandRequest>());
	readonly onDidRequestSaveBeforeCommand = this._onDidRequestSaveBeforeCommand.event;
	/** Session id and request id to the function that lets the command run. */
	private readonly _pendingSaves = new Map<string, () => void>();

	private readonly _onDidRequestTerminalRun = this._register(new Emitter<ClaudeTerminalRunRequest>());
	readonly onDidRequestTerminalRun = this._onDidRequestTerminalRun.event;
	/** Session id and request id to the function that answers the waiting `run_in_terminal` call. */
	private readonly _pendingTerminalRuns = new Map<string, (result: ClaudeTerminalRunResult) => void>();

	/** Debug mode's log sinks and the reproductions waiting for a window (issue 484). */
	private readonly _debug = this._register(new ClaudeDebugSessions());
	readonly onDidRequestReproduction = this._debug.onDidRequestReproduction;
	private readonly _onDidRequestSettings = this._register(new Emitter<ClaudeSettingsToolRequest>());
	readonly onDidRequestSettings = this._onDidRequestSettings.event;
	/** Session id and request id to the function that answers the waiting settings tool call (issue 525). */
	private readonly _pendingSettings = new Map<string, (result: ClaudeSettingsToolResult) => void>();
	private readonly _onDidRequestBrowser = this._register(new Emitter<ClaudeBrowserToolRequest>());
	readonly onDidRequestBrowser = this._onDidRequestBrowser.event;
	/** Session id and request id to the function that answers the waiting browser tool call (issue 466). */
	private readonly _pendingBrowser = new Map<string, (result: ClaudeBrowserToolResult) => void>();
	private readonly _onDidRequestDelegate = this._register(new Emitter<ClaudeDelegateToolRequest>());
	readonly onDidRequestDelegate = this._onDidRequestDelegate.event;
	private readonly _onDidRequestDepartment = this._register(new Emitter<ClaudeDepartmentToolRequest>());
	readonly onDidRequestDepartment = this._onDidRequestDepartment.event;
	private readonly _onDidRequestStartAgent = this._register(new Emitter<ClaudeStartAgentToolRequest>());
	readonly onDidRequestStartAgent = this._onDidRequestStartAgent.event;
	private readonly _onDidRequestSessionMessage = this._register(new Emitter<ClaudeSessionMessageRequest>());
	readonly onDidRequestSessionMessage = this._onDidRequestSessionMessage.event;
	private readonly _onDidReportStatus = this._register(new Emitter<ClaudeStatusReport>());
	readonly onDidReportStatus = this._onDidReportStatus.event;
	private readonly _onDidRequestFeedback = this._register(new Emitter<ClaudeFeedbackToolRequest>());
	readonly onDidRequestFeedback = this._onDidRequestFeedback.event;
	/** Session id and request id to the function that answers the waiting `klawly_delegate` call (issue 693). */
	private readonly _pendingDepartments = new Map<string, (result: ClaudeDepartmentToolResult) => void>();
	private readonly _pendingStartAgents = new Map<string, (result: ClaudeStartAgentToolResult) => void>();
	private readonly _pendingDelegates = new Map<string, (result: ClaudeDelegateToolResult) => void>();

	private readonly _registry = this._register(new ClaudeProcessRegistry());
	private readonly _runner: ClaudeAgentRunner;
	private readonly _userBridge = new ClaudeUserPermissionBridge();
	private readonly _elicitations = new ClaudeElicitationBridge();
	private readonly _adapter: ClaudeCliAdapter;
	private readonly _requests = new Map<string, BeginClaudeRequest>();
	private readonly _inline = new Map<string, AbortController>();
	/** Structured review passes in flight, by review id (issue 431). */
	private readonly _reviews = new Map<string, AbortController>();
	/** Side questions in flight, by request id (issue 433). */
	private readonly _sideQuestions = new Map<string, AbortController>();
	private _runtimePath: string | undefined;
	private _probe: ClaudeRuntimeProbe | undefined;
	/** The account `auth status` printed, asked once per probe (issue 536). */
	private _authAccount: Promise<ClaudeAccountDetails | undefined> | undefined;
	/** `claude --help` read once per binary, for cloud sessions (issue 516). */
	private _cloudCapability: { readonly binary: string; readonly capability: Promise<ClaudeCloudCapability> } | undefined;
	/** The added Claude accounts (issue 450). Absent without a user data folder: only the default account then. */
	private readonly _accounts: ClaudeAccountStore | undefined;
	/** The folder of the account in use, read before the first probe. Absent for the default account. */
	private _activeDirectory: string | undefined;
	/** The plan limits last read for each account that is not the one in use (issue 1385). */
	private readonly _otherUsage = new Map<string, { readonly windows: readonly ClaudeUsageWindow[] | undefined; readonly checkedAt: number }>();
	private _accountsLoaded: Promise<void> | undefined;

	constructor(private readonly _options: ClaudeNodeRuntimeOptions = {}) {
		super();
		this._runtimePath = _options.runtimePath;
		this._accounts = _options.userDataPath
			? new ClaudeAccountStore(join(_options.userDataPath, CLAUDE_ACCOUNTS_FOLDER), claudeConfigDirectory(_options.homeDirectory ?? homedir(), process.env.CLAUDE_CONFIG_DIR))
			: undefined;
		this._runner = this._register(new ClaudeAgentRunner({
			queryFactory: _options.queryFactory ?? createClaudeCliQuery,
			registry: this._registry,
			timeoutMs: _options.timeoutMs,
			homeDirectory: _options.homeDirectory,
			dataFolderName: _options.dataFolderName,
			log: _options.log,
			permissionHost: new ClaudePermissionHost({ getPolicy: _options.getPermissionPolicy }),
			onEvent: event => this._onDidEmitEvent.fire(event),
			retainRawMessages: _options.retainRawMessages,
			onRawMessage: (sessionId, message) => this._onDidEmitRawMessage.fire({ sessionId, message }),
			checkpoints: _options.userDataPath ? new ClaudeCheckpointStore(_options.userDataPath, new NodeCheckpointStorage(), { pid: process.pid }) : undefined,
			checkpointsEnabled: _options.checkpointsEnabled,
			retentionDays: _options.retentionDays,
			processEnvironment: () => this.processEnvironment(),
			accountEnvironment: accountId => this.accountEnvironment(this.accountDirectoryFor(accountId)),
			saveBeforeCommands: _options.saveBeforeCommands,
			beforeCommand: request => this.requestSave(request),
			terminalRun: request => this.requestTerminalRun(request),
			debug: this._debug,
			settingsRequest: request => this.requestSettings(request),
			browserRequest: request => this.requestBrowser(request),
			delegateRequest: request => this.requestDelegate(request),
			departmentRequest: request => this.requestDepartment(request),
			startAgentRequest: request => this.requestStartAgent(request),
			statusReport: report => this._onDidReportStatus.fire(report),
			feedbackRequest: request => this._onDidRequestFeedback.fire(request),
			noModelTools: new ClaudeNoModelTools(createClaudeNoModelHost(join(_options.homeDirectory ?? homedir(), _options.dataFolderName ?? product.dataFolderName, 'ci-logs'), (sessionId, text) => this._onDidRequestSessionMessage.fire({ sessionId, text }))),
			mergeWithoutAsking: _options.mergeWithoutAsking,
			delegationEnabled: _options.delegationEnabled,
			sessionTitle: _options.sessionTitle ?? (_options.queryFactory ? undefined : request => this.titleSession(request)),
			elicitations: _options.elicitations ? this._elicitations : undefined,
			autoReviewToggles: _options.autoReviewToggles,
			autoModeOn: _options.autoModeOn,
			autoReview: request => runClaudeAutoReview({
				...request,
				queryFactory: _options.queryFactory ?? createClaudeCliQuery,
				instructions: _options.autoReviewInstructions?.() ?? NO_AUTO_REVIEW_INSTRUCTIONS,
				toggles: _options.autoReviewToggles?.() ?? NO_AUTO_REVIEW_TOGGLES,
				env: this.processEnvironment(),
			}),
		}));
		this._adapter = new ClaudeCliAdapter(this._runner);
	}

	async getRuntimeState(): Promise<ClaudeRuntimeState> {
		if (!this._probe) {
			await this.ensureRuntime();
		}
		return { ...this._probe!.state };
	}

	async ensureRuntime(): Promise<ClaudeRuntimeState> {
		await this.loadActiveAccount();
		this._probe = await probeClaudeRuntime({
			runtimePath: this._runtimePath,
			execFile: this._options.execFile,
			knownBadVersions: this._options.knownBadVersions,
			log: this._options.log,
			telemetryEnabled: this._options.telemetryEnabled?.() === true,
			configDirectory: this._activeDirectory,
		});
		this._authAccount = undefined;
		this._onDidChangeRuntimeState.fire({ ...this._probe.state });
		return { ...this._probe.state };
	}

	setRuntimePath(runtimePath: string | undefined): void {
		this._runtimePath = runtimePath;
		this._probe = undefined;
	}

	async begin(request: BeginClaudeRequest): Promise<ClaudeRunHandle> {
		if (!this._probe) {
			await this.ensureRuntime();
		}
		const probe = this._probe;
		if (!probe) {
			throw Object.assign(new Error(failureMessage('runtime-missing')), { kind: 'runtime-missing' as const });
		}
		const state = probe.state;
		if (!state.installed) {
			throw Object.assign(new Error(failureMessage('runtime-missing')), { kind: 'runtime-missing' as const });
		}
		if (this._probe?.versionAssessment?.disposition === 'block') {
			throw Object.assign(new Error(this._probe.versionAssessment.message ?? failureMessage('runtime-version')), { kind: 'runtime-version' as const });
		}
		// A fork writes a new transcript, so only a plain resume can collide (v5 N5).
		const owner = request.resumeSessionAt ? undefined : claudeSessionBlockedBy(this.liveSessions(), request.resumeSessionId, request.checkpointSessionId ?? '');
		if (owner) {
			throw Object.assign(new Error(failureMessage('session-owned')), { kind: 'session-owned' as const });
		}
		const sessionId = generateUuid();
		this._requests.set(sessionId, request);
		const events = this._adapter.start(this.toRunRequest(sessionId, request.prompt, request, probe.binary));
		void this.pump(events);
		return { sessionId };
	}

	canSteer(sessionId: string): Promise<boolean> {
		return Promise.resolve(this._runner.hasSession(sessionId) && this._runner.canSteer(sessionId));
	}

	async steer(sessionId: string, text: string): Promise<boolean> {
		if (!this._runner.hasSession(sessionId)) {
			return false;
		}
		return this._runner.steer(sessionId, text);
	}

	async send(sessionId: string, input: ClaudeUserInput): Promise<void> {
		const request = this._requests.get(sessionId);
		if (!request || !this._runner.hasSession(sessionId)) {
			throw new Error(`Unknown Claude session: ${sessionId}`);
		}
		const events = await this._runner.send(sessionId, input.text, input.mode, input.workspaceTrusted, {
			turnId: input.turnId,
			checkpointSessionId: input.checkpointSessionId,
			dirtyBuffers: input.dirtyBuffers,
			accountId: input.accountId,
			sessionPermissions: input.sessionPermissions === undefined ? undefined : readClaudeSessionPermissions(input.sessionPermissions),
		});
		if (events) {
			void this.pump(events);
		}
	}

	async resolveSaveBeforeCommand(sessionId: string, requestId: string): Promise<void> {
		this._pendingSaves.get(pendingSaveKey(sessionId, requestId))?.();
	}

	async resolveBrowserRequest(sessionId: string, requestId: string, result: ClaudeBrowserToolResult): Promise<void> {
		this._pendingBrowser.get(pendingSaveKey(sessionId, requestId))?.(result);
	}

	async resolveSettingsRequest(sessionId: string, requestId: string, result: ClaudeSettingsToolResult): Promise<void> {
		this._pendingSettings.get(pendingSaveKey(sessionId, requestId))?.(result);
	}

	async resolveDelegateRequest(sessionId: string, requestId: string, result: ClaudeDelegateToolResult): Promise<void> {
		this._pendingDelegates.get(pendingSaveKey(sessionId, requestId))?.(result);
	}

	async resolveStartAgentRequest(sessionId: string, requestId: string, result: ClaudeStartAgentToolResult): Promise<void> {
		this._pendingStartAgents.get(pendingSaveKey(sessionId, requestId))?.(result);
	}

	async resolveDepartmentRequest(sessionId: string, requestId: string, result: ClaudeDepartmentToolResult): Promise<void> {
		this._pendingDepartments.get(pendingSaveKey(sessionId, requestId))?.(result);
	}

	async resolveTerminalRun(sessionId: string, requestId: string, result: ClaudeTerminalRunResult): Promise<void> {
		this._pendingTerminalRuns.get(pendingSaveKey(sessionId, requestId))?.(result);
	}

	async startDebugCapture(sessionId: string, requestId: string): Promise<void> {
		this._debug.startCapture(sessionId, requestId);
	}

	async resolveReproduction(sessionId: string, requestId: string, answer: ClaudeReproductionAnswer, extra?: ClaudeDebugExtraLines): Promise<void> {
		this._debug.resolve(sessionId, requestId, answer, extra);
	}

	async interrupt(sessionId: string): Promise<void> {
		this._userBridge.cancelSession(sessionId);
		this._elicitations.cancelSession(sessionId);
		this.releaseSaves(sessionId);
		this.cancelTerminalRuns(sessionId);
		await this._adapter.cancel(sessionId);
	}

	async resolvePermission(sessionId: string, requestId: string, choice: PermissionChoice): Promise<void> {
		this._userBridge.resolve(sessionId, requestId, choice);
	}

	async resolveElicitation(sessionId: string, id: string, answer: ClaudeElicitationAnswer): Promise<void> {
		this._elicitations.resolve(sessionId, id, answer);
	}

	async setToolRefusal(sessionId: string, message: string | undefined): Promise<void> {
		this._runner.setToolRefusal(sessionId, message);
	}

	async setSessionPermissions(sessionId: string, permissions: ClaudeSessionPermissions): Promise<void> {
		this._runner.setSessionPermissions(sessionId, readClaudeSessionPermissions(permissions));
	}

	interruptSubagent(sessionId: string, runId: string): Promise<void> {
		return this._runner.interruptSubagent(sessionId, runId);
	}

	async disposeSession(sessionId: string): Promise<void> {
		this._requests.delete(sessionId);
		this._userBridge.cancelSession(sessionId);
		this._elicitations.cancelSession(sessionId);
		this.releaseSaves(sessionId);
		this.cancelTerminalRuns(sessionId);
		this._runner.disposeSession(sessionId);
	}

	async listModels(): Promise<readonly ClaudeModelInfo[]> {
		const sessionId = this.liveSessionId();
		if (!sessionId && !this._probe) {
			await this.ensureRuntime();
		}
		// Before any session, ask Claude Code itself; without it there is nothing to ask.
		const probe = this._probe?.state.installed ? this._probe : undefined;
		return this._runner.listModels(sessionId, probe && { cwd: this._options.homeDirectory ?? homedir(), executablePath: probe.binary });
	}

	async listCommands(cwd: string): Promise<ClaudeCommandListing> {
		if (!this._probe) {
			await this.ensureRuntime();
		}
		// Before any session, ask Claude Code itself; without it there is nothing to ask.
		const probe = this._probe?.state.installed ? this._probe : undefined;
		return this._runner.listCommands(cwd, probe && { cwd, executablePath: probe.binary });
	}

	async getAccountOverview(refreshUsage?: ClaudeUsageRefresh, accountId?: string): Promise<ClaudeAccountOverview> {
		await this.loadActiveAccount();
		if (accountId !== undefined && this.accountDirectoryFor(accountId) !== this._activeDirectory) {
			return this.otherAccountOverview(accountId, refreshUsage);
		}
		// With no session, only a signed-in Claude Code can be asked for the plan limits (issue 704).
		const probe = refreshUsage && this._probe?.state.installed && this._probe.state.authenticated ? this._probe : undefined;
		const overview = await this._runner.accountOverview(this.liveSessionId(), refreshUsage, probe && { cwd: this._options.homeDirectory ?? homedir(), executablePath: probe.binary });
		if (overview.account || !this._probe?.state.authenticated) {
			return overview;
		}
		// No session has reported the account yet, as right after a sign-in: ask `auth status`.
		this._authAccount ??= this.readAuthAccount(this._activeDirectory);
		const account = await this._authAccount;
		return account ? { ...overview, account } : overview;
	}

	/** The folder of one account: undefined for the default one (issue 1385). */
	private accountDirectoryFor(accountId: string): string | undefined {
		return accountId === CLAUDE_DEFAULT_ACCOUNT_ID ? undefined : this._accounts?.directory(accountId);
	}

	/** The overview of an account no chat is signed in as right now: who it is and, when asked, its plan limits. */
	private async otherAccountOverview(accountId: string, refreshUsage: ClaudeUsageRefresh | undefined): Promise<ClaudeAccountOverview> {
		const directory = this.accountDirectoryFor(accountId);
		const cached = this._otherUsage.get(accountId);
		const fresh = cached !== undefined && Date.now() - cached.checkedAt < (refreshUsage === 'now' ? CLAUDE_USAGE_RECENT_MS : CLAUDE_USAGE_FRESH_MS);
		const account = await this.readAuthAccount(directory);
		let entry = cached;
		let usageFailed = false;
		if (refreshUsage && account && !fresh && this._probe?.state.installed) {
			try {
				const windows = await probeClaudeUsage({
					cwd: this._options.homeDirectory ?? homedir(),
					executablePath: this._probe.binary,
					queryFactory: this._options.queryFactory ?? createClaudeCliQuery,
					env: this.accountEnvironment(directory),
				});
				entry = { windows, checkedAt: Date.now() };
				this._otherUsage.set(accountId, entry);
			} catch {
				usageFailed = true;
			}
		}
		return { live: false, account, usage: entry?.windows, usageCheckedAt: entry?.checkedAt, ...(usageFailed ? { usageFailed: true } : {}) };
	}

	private async readAuthAccount(configDirectory: string | undefined): Promise<ClaudeAccountDetails | undefined> {
		try {
			const binary = await this.claudeBinary();
			const run = this._options.execFile ?? defaultExecFile;
			const { stdout } = await run(binary, ['auth', 'status'], { timeout: CLAUDE_COMMAND_TIMEOUT_MS, windowsHide: true, env: this.accountEnvironment(configDirectory) });
			return parseAuthStatusAccount(stdout);
		} catch {
			return undefined;
		}
	}

	/** Logs the account in use out: the default one with `claude auth logout`, an added one as {@link signOutAccount} does. */
	async logout(): Promise<ClaudeRuntimeState> {
		await this.loadActiveAccount();
		return this.signOutAccount((await this._accounts?.read())?.active ?? CLAUDE_DEFAULT_ACCOUNT_ID);
	}

	async listAccounts(): Promise<readonly ClaudeAccountEntry[]> {
		await this.loadActiveAccount();
		const saved = await this._accounts?.read() ?? { accounts: [] };
		const entry = async (id: string, directory: string | undefined, account?: ClaudeSavedAccount): Promise<ClaudeAccountEntry> => {
			const status = await this.readAuthAccount(directory);
			return {
				id,
				email: status?.email ?? account?.email,
				plan: status?.plan ?? account?.plan,
				organization: status?.organization ?? account?.organization,
				signedIn: !!status,
				// A folder signed in as someone else, as when one sign-in store serves every folder.
				mismatch: !!status?.email && !!account?.email && status.email !== account.email ? true : undefined,
				active: (saved.active ?? CLAUDE_DEFAULT_ACCOUNT_ID) === id,
			};
		};
		return Promise.all([
			entry(CLAUDE_DEFAULT_ACCOUNT_ID, undefined),
			...saved.accounts.map(account => entry(account.id, this._accounts!.directory(account.id), account)),
		]);
	}

	async addAccount(): Promise<ClaudeAccountSignIn> {
		if (!this._accounts) {
			throw new Error('This Claude runtime keeps only one account.');
		}
		const id = await this._accounts.create();
		return { id, env: { CLAUDE_CONFIG_DIR: this._accounts.directory(id) } };
	}

	async finishAddAccount(id: string): Promise<ClaudeAccountEntry | undefined> {
		const store = this._accounts;
		if (!store) {
			return undefined;
		}
		const status = await this.readAuthAccount(store.directory(id));
		const saved = await store.read();
		if (!status) {
			// The sign-in was closed or failed: the folder holds nothing worth keeping.
			await store.remove(id);
			return undefined;
		}
		const defaultAccount = status.email ? await this.readAuthAccount(undefined) : undefined;
		const same = status.email ? saved.accounts.find(account => account.email === status.email)?.id ?? (defaultAccount?.email === status.email ? CLAUDE_DEFAULT_ACCOUNT_ID : undefined) : undefined;
		if (same) {
			// Already added: switch to it rather than keep two folders for one account.
			await store.remove(id);
			await this.switchAccount(same);
			return (await this.listAccounts()).find(account => account.id === same);
		}
		await store.write({ active: saved.active, accounts: [...saved.accounts, { id, email: status.email, plan: status.plan, organization: status.organization }] });
		await this.switchAccount(id);
		return (await this.listAccounts()).find(account => account.id === id);
	}

	async switchAccount(id: string): Promise<ClaudeRuntimeState> {
		await this.loadActiveAccount();
		const store = this._accounts;
		if (store && id !== CLAUDE_DEFAULT_ACCOUNT_ID) {
			const saved = await store.read();
			if (!saved.accounts.some(account => account.id === id)) {
				throw new Error('That Claude account was removed.');
			}
			// A folder Claude Code made since the account was added is shared too.
			await store.link(id);
			await store.write({ ...saved, active: id });
			this._activeDirectory = store.directory(id);
		} else if (id === CLAUDE_DEFAULT_ACCOUNT_ID) {
			const saved = await store?.read();
			if (saved?.active) {
				await store!.write({ ...saved, active: undefined });
			}
			this._activeDirectory = undefined;
		} else {
			throw new Error('This Claude runtime keeps only one account.');
		}
		// Open sessions pick the new account up on their next turn: the runner resumes them under it.
		this._runner.forgetAccount();
		return this.ensureRuntime();
	}

	async signOutAccount(id: string): Promise<ClaudeRuntimeState> {
		await this.loadActiveAccount();
		if (id === CLAUDE_DEFAULT_ACCOUNT_ID) {
			await this.runClaudeCommand(['auth', 'logout'], undefined, this.accountEnvironment(undefined));
			if (!this._activeDirectory) {
				this._runner.forgetAccount();
			}
			return this.ensureRuntime();
		}
		const store = this._accounts;
		if (!store) {
			throw new Error('This Claude runtime keeps only one account.');
		}
		const directory = store.directory(id);
		await this.runClaudeCommand(['auth', 'logout'], undefined, this.accountEnvironment(directory));
		// Only the folder's own files go; the links to Claude Code's folder leave what they point to.
		await store.remove(id);
		const saved = await store.read();
		const wasActive = saved.active === id || this._activeDirectory === directory;
		await store.write({ active: wasActive ? undefined : saved.active, accounts: saved.accounts.filter(account => account.id !== id) });
		if (wasActive) {
			this._activeDirectory = undefined;
			this._runner.forgetAccount();
		}
		return this.ensureRuntime();
	}

	/** Reads which account is in use, once, before the first Claude process starts. */
	private loadActiveAccount(): Promise<void> {
		this._accountsLoaded ??= (async () => {
			const store = this._accounts;
			const active = store ? (await store.read()).active : undefined;
			this._activeDirectory = active && store ? store.directory(active) : undefined;
		})();
		return this._accountsLoaded;
	}

	controlMcpServer(name: string, action: ClaudeMcpControlAction): Promise<ClaudeAccountOverview> {
		return this._runner.controlMcpServer(this.liveSessionId(), name, action);
	}

	loadMcpApp(sessionId: string, toolName: string): Promise<ClaudeMcpAppLoad | undefined> {
		return this._runner.loadMcpApp(sessionId, toolName);
	}

	readMcpResource(sessionId: string, server: string, uri: string): Promise<readonly ClaudeMcpResourceContent[]> {
		return this._runner.readMcpResource(sessionId, server, uri);
	}

	readMcpServerLog(name: string, cwd: string): Promise<ClaudeMcpLog> {
		return readClaudeMcpLog(claudeCacheRoot(process.platform, this._options.homeDirectory ?? homedir(), process.env), cwd, name);
	}

	getContextBreakdown(sessionId: string): Promise<ClaudeContextBreakdown | undefined> {
		return this._runner.contextBreakdown(sessionId);
	}

	async setRemoteControl(sessionId: string, enabled: boolean, name?: string): Promise<ClaudeRemoteControlState> {
		const state = await this._registry.remoteControl(sessionId, enabled === true, claudeRemoteControlName(name));
		if (state) {
			return state;
		}
		if (!enabled) {
			return { enabled: false };
		}
		throw new Error('Remote Control shares a running chat. Send a message first, then share it.');
	}

	async getRemoteControl(sessionId: string): Promise<ClaudeRemoteControlState | undefined> {
		return this._registry.remoteControlState(sessionId);
	}

	async addMcpServer(request: ClaudeMcpAddRequest): Promise<void> {
		const valid = readClaudeMcpAddRequest(request);
		if (!valid) {
			throw new Error('The MCP server is not valid.');
		}
		if (valid.scope === 'user') {
			// Yours, in every project: Klawly's user layer, never `~/.claude.json` (issue 455).
			await this.editUserMcpServers(text => addClaudeUserMcpServer(text, valid.name, valid.config));
			return;
		}
		refuseClaudeCodeConfig(valid.scope);
		await this.runClaudeCommand(claudeMcpAddArguments(valid), valid.cwd);
	}

	async removeMcpServer(request: ClaudeMcpRemoveRequest): Promise<void> {
		const valid = readClaudeMcpRemoveRequest(request);
		if (!valid) {
			throw new Error('The MCP server is not valid.');
		}
		if (valid.scope === 'user') {
			await this.editUserMcpServers(text => removeClaudeUserMcpServer(text, valid.name));
			return;
		}
		refuseClaudeCodeConfig(valid.scope);
		await this.runClaudeCommand(claudeMcpRemoveArguments(valid), valid.cwd);
	}

	/** Rewrites the user layer's `.mcp.json`. Nothing is written when the edit leaves it as it was. */
	private async editUserMcpServers(edit: (text: string | undefined) => string | undefined): Promise<void> {
		const directory = claudeUserLayerDirectory(this._options.homeDirectory ?? homedir(), this._options.dataFolderName ?? product.dataFolderName);
		const file = join(directory, CLAUDE_USER_LAYER_FILES.mcp);
		const text = await fs.readFile(file, 'utf8').catch(() => undefined);
		const edited = edit(text);
		if (edited === undefined) {
			throw new Error(`${file} is not valid JSON. Fix it, then try again.`);
		}
		if (edited !== text) {
			await fs.mkdir(directory, { recursive: true });
			await fs.writeFile(file, edited);
		}
	}

	async runPluginCommand(command: ClaudePluginCommand): Promise<ClaudePluginCommandResult> {
		const valid = readClaudePluginCommand(command);
		if (!valid) {
			throw new Error('The plugin command is not valid.');
		}
		const binary = await this.claudeBinary();
		const run = this._options.execFile ?? defaultExecFile;
		try {
			const { stdout, stderr } = await run(binary, claudePluginCommandArguments(valid), { timeout: CLAUDE_PLUGIN_COMMAND_TIMEOUT_MS, windowsHide: true, env: this.processEnvironment(), cwd: valid.action === 'removeMarketplace' ? undefined : valid.cwd });
			return readClaudePluginCommandResult(stdout, false, stderr.trim());
		} catch (error) {
			const output = error as { stdout?: unknown; stderr?: unknown };
			const stderr = typeof output?.stderr === 'string' ? output.stderr.trim() : '';
			return readClaudePluginCommandResult(typeof output?.stdout === 'string' ? output.stdout : '', true, stderr || (error instanceof Error ? error.message : String(error)));
		}
	}

	async getCloudCapability(): Promise<ClaudeCloudCapability> {
		let binary: string;
		try {
			binary = await this.claudeBinary();
		} catch (error) {
			return { cloud: false, teleport: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (this._cloudCapability?.binary !== binary) {
			const version = this._probe?.state.version;
			const run = this._options.execFile ?? defaultExecFile;
			const capability = run(binary, ['--help'], { timeout: CLAUDE_COMMAND_TIMEOUT_MS, windowsHide: true, env: this.processEnvironment() }).then(
				({ stdout }) => readClaudeCloudCapability(stdout, version, binary),
				error => {
					this._cloudCapability = undefined;
					return { cloud: false, teleport: false, version, binary, error: error instanceof Error ? error.message : String(error) };
				},
			);
			this._cloudCapability = { binary, capability };
		}
		return this._cloudCapability.capability;
	}

	async sendToCloudSession(request: ClaudeCloudSendRequest): Promise<ClaudeCloudSendResult> {
		const sessionId = readClaudeCloudSessionId(request?.session);
		const message = readClaudeCloudText(request?.message);
		if (!sessionId || !message) {
			throw new Error('The cloud session or the message is not valid.');
		}
		const binary = await this.claudeBinary();
		const run = this._options.execFile ?? defaultExecFile;
		const cwd = typeof request.cwd === 'string' && isAbsolute(request.cwd) ? request.cwd : undefined;
		try {
			const { stdout, stderr } = await run(binary, claudeCloudSendArguments(sessionId), { timeout: CLAUDE_COMMAND_TIMEOUT_MS, windowsHide: true, env: this.processEnvironment(), cwd, input: message });
			return readClaudeCloudSendResult(stdout, stderr);
		} catch (error) {
			const output = error as { stdout?: unknown; stderr?: unknown };
			const stdout = typeof output?.stdout === 'string' ? output.stdout : '';
			const stderr = typeof output?.stderr === 'string' ? output.stderr : '';
			return stdout.trim() || stderr.trim() ? readClaudeCloudSendResult(stdout, stderr) : { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** The `claude` binary, or a rejection saying why there is none. */
	private async claudeBinary(): Promise<string> {
		if (!this._probe) {
			await this.ensureRuntime();
		}
		const probe = this._probe;
		if (!probe?.state.installed) {
			throw new Error(probe?.state.error ?? 'Claude Code is not installed.');
		}
		return probe.binary;
	}

	/** Runs a `claude` subcommand directly, with no shell, and rejects with what it printed on failure. */
	private async runClaudeCommand(args: readonly string[], cwd: string | undefined, env = this.processEnvironment()): Promise<void> {
		const binary = await this.claudeBinary();
		const run = this._options.execFile ?? defaultExecFile;
		try {
			await run(binary, args, { timeout: CLAUDE_COMMAND_TIMEOUT_MS, windowsHide: true, env, cwd });
		} catch (error) {
			const stderr = typeof (error as { stderr?: unknown })?.stderr === 'string' ? (error as { stderr: string }).stderr.trim() : '';
			throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
		}
	}

	setModel(sessionId: string, modelId: string): Promise<void> {
		return this._runner.setModel(sessionId, modelId);
	}

	setSessionSettings(sessionId: string, settings: ClaudeSessionSettings): Promise<void> {
		return this._runner.setSessionSettings(sessionId, readClaudeSessionSettings(settings));
	}

	async completeInline(request: ClaudeInlineCompletionRequest): Promise<string | undefined> {
		const previous = this._inline.get(request.id);
		previous?.abort();
		const abort = new AbortController();
		this._inline.set(request.id, abort);
		try {
			if (!this._probe) {
				await this.ensureRuntime();
			}
			if (!this._probe?.state.installed || abort.signal.aborted) {
				return undefined;
			}
			return await runClaudeInlineCompletion({
				queryFactory: this._options.queryFactory ?? createClaudeCliQuery,
				request,
				abort,
				env: this.processEnvironment(),
				executablePath: this._probe.binary,
			});
		} catch {
			this._options.log?.('Claude autocomplete failed.');
			return undefined;
		} finally {
			if (this._inline.get(request.id) === abort) {
				this._inline.delete(request.id);
			}
		}
	}

	async cancelInline(requestId: string): Promise<void> {
		const abort = this._inline.get(requestId);
		if (!abort) {
			return;
		}
		this._inline.delete(requestId);
		abort.abort();
	}

	/** Compare Models judge (issue 424). Its abort shares the one-shot map, so dispose and cancel reach it. */
	async judgeComparison(request: ClaudeComparisonJudgeRequest): Promise<ClaudeComparisonJudgeResult> {
		const abort = new AbortController();
		this._inline.get(request.id)?.abort();
		this._inline.set(request.id, abort);
		try {
			if (!this._probe) {
				await this.ensureRuntime();
			}
			if (!this._probe?.state.installed) {
				return { ok: false, message: failureMessage('runtime-missing') };
			}
			return await runClaudeComparisonJudge({
				queryFactory: this._options.queryFactory ?? createClaudeCliQuery,
				request,
				abort,
				env: this.processEnvironment(),
				executablePath: this._probe.binary,
			});
		} finally {
			if (this._inline.get(request.id) === abort) {
				this._inline.delete(request.id);
			}
		}
	}

	cancelComparisonJudge(requestId: string): Promise<void> {
		return this.cancelInline(requestId);
	}

	/** Auto model's classifier (issue 521). Its abort shares the one-shot map, so dispose and cancel reach it. */
	async classifyAutoModel(request: ClaudeAutoModelRequest): Promise<ClaudeAutoModelClassification> {
		const abort = new AbortController();
		this._inline.get(request.id)?.abort();
		this._inline.set(request.id, abort);
		try {
			if (!this._probe) {
				await this.ensureRuntime();
			}
			if (!this._probe?.state.installed) {
				return { ok: false, message: failureMessage('runtime-missing') };
			}
			return await runClaudeAutoModelClassifier({
				queryFactory: this._options.queryFactory ?? createClaudeCliQuery,
				request,
				abort,
				env: this.processEnvironment(),
				executablePath: this._probe.binary,
			});
		} finally {
			if (this._inline.get(request.id) === abort) {
				this._inline.delete(request.id);
			}
		}
	}

	cancelAutoModel(requestId: string): Promise<void> {
		return this.cancelInline(requestId);
	}

	async reviewChanges(request: ClaudeReviewRequest): Promise<ClaudeReviewResult> {
		this._reviews.get(request.reviewId)?.abort();
		const abort = new AbortController();
		this._reviews.set(request.reviewId, abort);
		try {
			if (!this._probe) {
				await this.ensureRuntime();
			}
			if (abort.signal.aborted) {
				return { ok: false, reviewId: request.reviewId, failure: { kind: 'cancelled' } };
			}
			if (!this._probe?.state.installed) {
				return { ok: false, reviewId: request.reviewId, failure: { kind: 'failed', message: this._probe?.state.error ?? 'Claude Code is not installed.' } };
			}
			const outcome = await runClaudeReviewQuery({
				queryFactory: this._options.queryFactory ?? createClaudeCliQuery,
				diff: request.diff,
				cwd: request.cwd,
				model: request.model,
				instructions: request.instructions,
				strictness: request.strictness,
				categories: request.categories,
				summary: request.summary,
				diagramKind: request.diagramKind,
				readiness: request.readiness,
				depth: request.depth,
				maxTurns: request.maxTurns,
				tickets: request.tickets,
				abort,
				env: this.processEnvironment(),
				executablePath: this._probe.binary,
			});
			return outcome.ok
				? { ok: true, event: { type: 'review.findings', sessionId: request.sessionId, reviewId: request.reviewId, findings: outcome.value, ...(outcome.summary ? { summary: outcome.summary } : {}), ...(outcome.readiness ? { readiness: outcome.readiness } : {}) } }
				: { ok: false, reviewId: request.reviewId, failure: outcome.failure };
		} catch (error) {
			return { ok: false, reviewId: request.reviewId, failure: { kind: 'failed', message: error instanceof Error ? error.message : String(error) } };
		} finally {
			if (this._reviews.get(request.reviewId) === abort) {
				this._reviews.delete(request.reviewId);
			}
		}
	}

	async cancelReview(reviewId: string): Promise<void> {
		const abort = this._reviews.get(reviewId);
		this._reviews.delete(reviewId);
		abort?.abort();
	}

	async askSideQuestion(request: ClaudeSideQuestionRequest): Promise<ClaudeSideQuestionResult> {
		this._sideQuestions.get(request.id)?.abort();
		const abort = new AbortController();
		this._sideQuestions.set(request.id, abort);
		try {
			if (!this._probe) {
				await this.ensureRuntime();
			}
			if (abort.signal.aborted) {
				return { kind: 'cancelled' };
			}
			if (!this._probe?.state.installed) {
				return { kind: 'failed', message: 'Claude Code is not installed.' };
			}
			return await runClaudeSideQuestion({
				queryFactory: this._options.queryFactory ?? createClaudeCliQuery,
				request,
				abort,
				env: this.processEnvironment(),
				executablePath: this._probe.binary,
				realpath: nodeRealpath,
			});
		} finally {
			if (this._sideQuestions.get(request.id) === abort) {
				this._sideQuestions.delete(request.id);
			}
		}
	}

	createSecretGist(request: ClaudeGistRequest): Promise<ClaudeGistResult> {
		return createClaudeGist(request);
	}

	readSharedGist(link: string): Promise<ClaudeGistReadResult> {
		return readClaudeGist(link);
	}

	runStatusLine(request: ClaudeStatusLineRequest): Promise<ClaudeStatusLineResult> {
		const home = this._options.homeDirectory ?? homedir();
		const userLayer = claudeUserLayerDirectory(home, this._options.dataFolderName ?? product.dataFolderName);
		return runClaudeStatusLine(request, nodeClaudeStatusLineHost(this.processEnvironment(), home, userLayer, this._options.userLayer?.().useClaudeCodeSetup));
	}

	async cancelSideQuestion(requestId: string): Promise<void> {
		const abort = this._sideQuestions.get(requestId);
		this._sideQuestions.delete(requestId);
		abort?.abort();
	}

	capabilities() {
		return this._adapter.capabilities();
	}

	override dispose(): void {
		for (const abort of this._inline.values()) {
			abort.abort();
		}
		this._inline.clear();
		for (const abort of this._reviews.values()) {
			abort.abort();
		}
		this._reviews.clear();
		for (const abort of this._sideQuestions.values()) {
			abort.abort();
		}
		this._sideQuestions.clear();
		this._userBridge.dispose();
		this._elicitations.dispose();
		for (const release of [...this._pendingSaves.values()]) {
			release();
		}
		for (const answer of [...this._pendingTerminalRuns.values()]) {
			answer({ kind: 'cancelled' });
		}
		for (const answer of [...this._pendingBrowser.values()]) {
			answer({ kind: 'failed', message: 'Klawly closed.' });
		}
		for (const answer of [...this._pendingSettings.values()]) {
			answer({ kind: 'failed', message: 'Klawly closed.' });
		}
		for (const answer of [...this._pendingDelegates.values()]) {
			answer({ kind: 'stopped' });
		}
		for (const answer of [...this._pendingDepartments.values()]) {
			answer({ kind: 'failed', message: 'Klawly closed.' });
		}
		for (const answer of [...this._pendingStartAgents.values()]) {
			answer({ kind: 'failed', message: 'Klawly closed.' });
		}
		super.dispose();
	}

	/**
	 * Asks the workbench window that owns the session to save unsaved editors, and
	 * waits until it answers, the call is aborted, or the timeout passes.
	 */
	private requestSave(request: ClaudeBeforeCommandRequest): Promise<void> {
		if (request.signal.aborted) {
			return Promise.resolve();
		}
		const requestId = generateUuid();
		const key = pendingSaveKey(request.sessionId, requestId);
		return new Promise<void>(resolve => {
			const timeoutMs = this._options.saveBeforeCommandTimeoutMs?.(request.mode) ?? SAVE_BEFORE_COMMAND_TIMEOUT_MS[request.mode];
			const release = () => {
				if (this._pendingSaves.get(key) !== release) {
					return;
				}
				this._pendingSaves.delete(key);
				clearTimeout(timer);
				request.signal.removeEventListener('abort', release);
				resolve();
			};
			const timer = setTimeout(() => {
				this._options.log?.('The workbench did not finish saving before a command, so the command runs against the files on disk.');
				release();
			}, timeoutMs);
			this._pendingSaves.set(key, release);
			request.signal.addEventListener('abort', release, { once: true });
			this._onDidRequestSaveBeforeCommand.fire({ sessionId: request.sessionId, requestId, command: request.command, mode: request.mode });
		});
	}

	/**
	 * Asks the window that owns the session to run a command in a visible
	 * terminal, and waits until it ends there. No timeout: the user may take a
	 * while to sign in. Claude Code's own tool timeout, a stop and the window's
	 * Cancel all end the wait.
	 */
	private requestTerminalRun(request: ClaudeTerminalRunToolRequest): Promise<ClaudeTerminalRunResult> {
		if (request.signal.aborted) {
			return Promise.resolve({ kind: 'cancelled' });
		}
		const requestId = generateUuid();
		const key = pendingSaveKey(request.sessionId, requestId);
		return new Promise<ClaudeTerminalRunResult>(resolve => {
			const answer = (result: ClaudeTerminalRunResult) => {
				if (this._pendingTerminalRuns.get(key) !== answer) {
					return;
				}
				this._pendingTerminalRuns.delete(key);
				request.signal.removeEventListener('abort', onAbort);
				resolve(result);
			};
			const onAbort = () => answer({ kind: 'cancelled' });
			this._pendingTerminalRuns.set(key, answer);
			request.signal.addEventListener('abort', onAbort, { once: true });
			this._onDidRequestTerminalRun.fire({ sessionId: request.sessionId, requestId, command: request.command, reason: request.reason, cwd: request.cwd });
		});
	}

	/**
	 * Asks the window that owns the session to read or change a setting (issue 525).
	 * A window that does not own it stays silent; with no window, the call times out.
	 */
	/**
	 * Asks the window that owns the session to run one browser action (issue 466)
	 * and waits for its answer. The wait is longer than a settings change, because
	 * a page load or a screenshot takes time.
	 */
	private requestBrowser(request: ClaudeBrowserToolArgs & { readonly sessionId: string; readonly signal: AbortSignal }): Promise<ClaudeBrowserToolResult> {
		if (request.signal.aborted) {
			return Promise.resolve({ kind: 'failed', message: 'The call was cancelled.' });
		}
		const { signal, ...args } = request;
		const requestId = generateUuid();
		const key = pendingSaveKey(request.sessionId, requestId);
		return new Promise<ClaudeBrowserToolResult>(resolve => {
			const timer = setTimeout(() => answer({ kind: 'failed', message: 'No Klawly window answered. Open the chat and try again.' }), BROWSER_REQUEST_TIMEOUT_MS);
			const answer = (result: ClaudeBrowserToolResult) => {
				if (this._pendingBrowser.get(key) !== answer) {
					return;
				}
				this._pendingBrowser.delete(key);
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				resolve(result);
			};
			const onAbort = () => answer({ kind: 'failed', message: 'The call was cancelled.' });
			this._pendingBrowser.set(key, answer);
			signal.addEventListener('abort', onAbort, { once: true });
			this._onDidRequestBrowser.fire({ ...args, requestId });
		});
	}

	private requestSettings(request: ClaudeSettingsToolArgs & { readonly sessionId: string; readonly signal: AbortSignal }): Promise<ClaudeSettingsToolResult> {
		if (request.signal.aborted) {
			return Promise.resolve({ kind: 'failed', message: 'The call was cancelled.' });
		}
		const { signal, ...args } = request;
		const requestId = generateUuid();
		const key = pendingSaveKey(request.sessionId, requestId);
		return new Promise<ClaudeSettingsToolResult>(resolve => {
			const timer = setTimeout(() => answer({ kind: 'failed', message: 'No Klawly window answered. Open the chat and try again.' }), SETTINGS_REQUEST_TIMEOUT_MS);
			const answer = (result: ClaudeSettingsToolResult) => {
				if (this._pendingSettings.get(key) !== answer) {
					return;
				}
				this._pendingSettings.delete(key);
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				resolve(result);
			};
			const onAbort = () => answer({ kind: 'failed', message: 'The call was cancelled.' });
			this._pendingSettings.set(key, answer);
			signal.addEventListener('abort', onAbort, { once: true });
			this._onDidRequestSettings.fire({ ...args, requestId });
		});
	}

	/**
	 * Asks the window that owns the session to run a delegated chat (issue 693),
	 * and waits for its answer. No timeout: the delegated chat may work for a
	 * while. A stop of this session and Claude Code's cancel end the wait.
	 */
	private requestDelegate(request: ClaudeDelegateToolArgs & { readonly sessionId: string; readonly signal: AbortSignal }): Promise<ClaudeDelegateToolResult> {
		if (request.signal.aborted) {
			return Promise.resolve({ kind: 'stopped' });
		}
		const { signal, ...args } = request;
		const requestId = generateUuid();
		const key = pendingSaveKey(request.sessionId, requestId);
		return new Promise<ClaudeDelegateToolResult>(resolve => {
			const answer = (result: ClaudeDelegateToolResult) => {
				if (this._pendingDelegates.get(key) !== answer) {
					return;
				}
				this._pendingDelegates.delete(key);
				signal.removeEventListener('abort', onAbort);
				resolve(result);
			};
			const onAbort = () => answer({ kind: 'stopped' });
			this._pendingDelegates.set(key, answer);
			signal.addEventListener('abort', onAbort, { once: true });
			this._onDidRequestDelegate.fire({ ...args, requestId });
		});
	}

	/**
	 * Asks the window that owns the session to hand a request to another project's
	 * chat (issue 1177), and waits for the hand-off result. The window answers once the
	 * message is delivered, so the wait is short; a stop of the session ends it.
	 */
	private requestDepartment(request: ClaudeDepartmentToolArgs & { readonly sessionId: string; readonly signal: AbortSignal }): Promise<ClaudeDepartmentToolResult> {
		if (request.signal.aborted) {
			return Promise.resolve({ kind: 'failed', message: 'The call was cancelled.' });
		}
		const { signal, ...args } = request;
		const requestId = generateUuid();
		const key = pendingSaveKey(request.sessionId, requestId);
		return new Promise<ClaudeDepartmentToolResult>(resolve => {
			const answer = (result: ClaudeDepartmentToolResult) => {
				if (this._pendingDepartments.get(key) !== answer) {
					return;
				}
				this._pendingDepartments.delete(key);
				signal.removeEventListener('abort', onAbort);
				resolve(result);
			};
			const onAbort = () => answer({ kind: 'failed', message: 'The call was cancelled.' });
			this._pendingDepartments.set(key, answer);
			signal.addEventListener('abort', onAbort, { once: true });
			this._onDidRequestDepartment.fire({ ...args, requestId });
		});
	}

	/** Asks the window that owns the session to start a chat; ends with the session's stop (issue 991). */
	private requestStartAgent(request: ClaudeStartAgentToolArgs & { readonly sessionId: string; readonly signal: AbortSignal }): Promise<ClaudeStartAgentToolResult> {
		if (request.signal.aborted) {
			return Promise.resolve({ kind: 'failed', message: 'The call was cancelled.' });
		}
		const { signal, ...args } = request;
		const requestId = generateUuid();
		const key = pendingSaveKey(request.sessionId, requestId);
		return new Promise<ClaudeStartAgentToolResult>(resolve => {
			const answer = (result: ClaudeStartAgentToolResult) => {
				if (this._pendingStartAgents.get(key) !== answer) {
					return;
				}
				this._pendingStartAgents.delete(key);
				signal.removeEventListener('abort', onAbort);
				resolve(result);
			};
			const onAbort = () => answer({ kind: 'failed', message: 'The call was cancelled.' });
			this._pendingStartAgents.set(key, answer);
			signal.addEventListener('abort', onAbort, { once: true });
			this._onDidRequestStartAgent.fire({ ...args, requestId });
		});
	}

	private cancelTerminalRuns(sessionId: string): void {
		const prefix = `${sessionId}\n`;
		for (const [key, answer] of [...this._pendingTerminalRuns]) {
			if (key.startsWith(prefix)) {
				answer({ kind: 'cancelled' });
			}
		}
		for (const [key, answer] of [...this._pendingDelegates]) {
			if (key.startsWith(prefix)) {
				answer({ kind: 'stopped' });
			}
		}
	}

	private releaseSaves(sessionId: string): void {
		const prefix = `${sessionId}\n`;
		for (const [key, release] of [...this._pendingSaves]) {
			if (key.startsWith(prefix)) {
				release();
			}
		}
	}

	/**
	 * Always runs the installed Claude Code at `executablePath`: Klawly never ships the Agent SDK's
	 * bundled copy, so there is no SDK fallback lookup to rely on (issue 548).
	 */
	private toRunRequest(sessionId: string, prompt: string, request: BeginClaudeRequest, executablePath: string): ClaudeAgentRunRequest {
		return {
			sessionId,
			prompt,
			cwd: request.cwd,
			mode: request.mode,
			modelId: request.modelId,
			resumeSessionId: request.resumeSessionId,
			resumeSessionAt: request.resumeSessionAt,
			accountId: request.accountId,
			additionalDirectories: request.additionalDirectories,
			maxTurns: typeof request.maxTurns === 'number' && Number.isInteger(request.maxTurns) && request.maxTurns > 0 ? request.maxTurns : this._options.maxTurns,
			builtInAgents: this._options.builtInAgentsEnabled?.() ?? this._options.builtInAgents,
			gitSettings: this._options.gitSettings?.(),
			securitySettings: this._options.securitySettings?.(),
			agentsFiles: this._options.agentsFiles?.(),
			replyStyle: this._options.replyStyle?.(),
			makerMode: this._options.makerMode?.(),
			workRules: this._options.workRules?.(),
			verifyUi: this._options.verifyUi?.(),
			userLayer: this._options.userLayer?.(),
			executionTarget: readClaudeExecutionTarget(request.executionTarget),
			executablePath,
			runtimeVersion: this._probe?.state.version,
			workspaceFolders: request.workspaceFolders,
			workspaceTrusted: request.workspaceTrusted,
			permissionBridge: this._options.permissionBridge ?? this._userBridge,
			checkpointSessionId: request.checkpointSessionId,
			turnId: request.turnId,
			dirtyBuffers: request.dirtyBuffers,
			sessionPermissions: request.sessionPermissions === undefined ? undefined : readClaudeSessionPermissions(request.sessionPermissions),
			sessionSettings: readClaudeSessionSettings(request.sessionSettings),
			plugins: Array.isArray(request.plugins) ? request.plugins.filter(path => typeof path === 'string') : undefined,
			workerProfile: request.workerProfile === undefined ? undefined : readClaudeWorkerProfile(request.workerProfile),
			maxBudgetUsd: typeof request.maxBudgetUsd === 'number' && request.maxBudgetUsd > 0 ? request.maxBudgetUsd : undefined,
		};
	}

	/** Claude Code's own title for the chat, else a short one Claude writes for the first request. */
	private async titleSession(request: ClaudeSessionTitleRequest): Promise<string | undefined> {
		if (request.claudeSessionId) {
			try {
				const own = await readClaudeCodeSessionTitle(request.claudeSessionId, request.cwd);
				if (own) {
					return own;
				}
			} catch {
				// The transcript could not be read. Ask for a title instead.
			}
		}
		const reply = await this.completeInline({
			id: `title-${request.sessionId}`,
			prompt: claudeSessionTitlePrompt(request.firstPrompt),
			cwd: request.cwd,
			model: CLAUDE_SESSION_TITLE_MODEL,
		});
		return readClaudeSessionTitle(reply);
	}

	/** Every Claude process's environment, signed in as the account in use (issue 450). */
	private processEnvironment(): Record<string, string> {
		return this.accountEnvironment(this._activeDirectory);
	}

	/** The environment signed in as one account: its folder, or undefined for the default one. */
	private accountEnvironment(configDirectory: string | undefined): Record<string, string> {
		return claudeProcessEnvironment(process.env, { telemetryEnabled: this._options.telemetryEnabled?.() === true, configDirectory });
	}

	/** Running processes with the Claude Code session each one holds. */
	private liveSessions(): ClaudeLiveSession[] {
		const live: ClaudeLiveSession[] = [];
		for (const [sessionId, request] of this._requests) {
			if (this._registry.get(sessionId)) {
				live.push({ owner: request.checkpointSessionId ?? sessionId, claudeSessionId: this._runner.claudeSessionIdOf(sessionId) ?? request.resumeSessionId });
			}
		}
		return live;
	}

	private liveSessionId(): string | undefined {
		for (const sessionId of this._requests.keys()) {
			if (this._registry.get(sessionId)) {
				return sessionId;
			}
		}
		return undefined;
	}

	private async pump(events: AsyncIterable<NormalizedClaudeEvent>): Promise<void> {
		try {
			for await (const event of events) {
				this._onDidEmitEvent.fire(event);
			}
		} catch (error) {
			const failure = classifyAgentFailure(error);
			this._options.log?.(failure.message);
		}
	}
}

function pendingSaveKey(sessionId: string, requestId: string): string {
	return `${sessionId}\n${requestId}`;
}

/**
 * `claude mcp` keeps `local` servers in `~/.claude.json`, which Klawly never
 * writes (issue 455). Only the project's `.mcp.json` goes through it.
 */
function refuseClaudeCodeConfig(scope: ClaudeMcpScope): void {
	if (scope === 'local') {
		throw new Error(`Klawly never changes Claude Code's ~/.claude.json, where servers only for you in this project are kept. Add the server for you in every project, or to the project's .mcp.json.`);
	}
}
