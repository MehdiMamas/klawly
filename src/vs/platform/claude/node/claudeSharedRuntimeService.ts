/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { homedir } from 'os';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../base/common/lifecycle.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../environment/common/environment.js';
import { ILogService } from '../../log/common/log.js';
import product from '../../product/common/product.js';
import { ClaudeAccountOverview, ClaudeUsageRefresh } from '../common/claudeAccount.js';
import { ClaudeAccountEntry, ClaudeAccountSignIn } from '../common/claudeAccounts.js';
import { ClaudeMcpAppLoad, ClaudeMcpResourceContent } from '../common/claudeMcpApps.js';
import { ClaudeInlineCompletionRequest } from '../common/claudeAutocomplete.js';
import { ClaudeComparisonJudgeRequest, ClaudeComparisonJudgeResult } from '../common/claudeComparison.js';
import { ClaudeAutoModelClassification, ClaudeAutoModelRequest } from '../common/claudeAutoModel.js';
import { ClaudeCommandListing } from '../common/claudeCommands.js';
import { ClaudeStatusReport } from '../common/claudeStatusTool.js';
import { ClaudeFeedbackToolRequest } from '../common/claudeFeedbackTool.js';
import { ClaudeSessionMessageRequest, BeginClaudeRequest, ClaudeModelInfo, ClaudeRawSdkMessage, ClaudeReviewResult, ClaudeRunHandle, ClaudeRuntimeState, ClaudeSaveBeforeCommandRequest, ClaudeUserInput, IClaudeRuntimeService } from '../common/claude.js';
import { readCheckpointRetentionDays, readCheckpointsEnabled } from '../common/claudeCheckpoints.js';
import { CLAUDE_AUTO_ENABLED_SETTING, readClaudeMergeWithoutAsking, CLAUDE_MERGE_WITHOUT_ASKING_SETTING, CLAUDE_AGENT_RUNTIME_PATH_SETTING, CLAUDE_AGENT_RUNTIME_SETTING, CLAUDE_AGENT_SAVE_BEFORE_COMMANDS_SETTING, CLAUDE_CHECKPOINTS_ENABLED_SETTING, CLAUDE_CHECKPOINT_RETENTION_SETTING, CLAUDE_DEBUG_RETAIN_RAW_SETTING, CLAUDE_DELEGATION_ENABLED_SETTING, CLAUDE_SUBAGENTS_BUILT_IN_SETTING, CLAUDE_TELEMETRY_ENABLED_SETTING, ClaudeAgentRuntimeKind, readClaudeAgentRuntimeKind, readClaudeAgentRuntimePath, readClaudeAgentsFilesSettings, readClaudeBuiltInAgents, readClaudeDelegationEnabled, readClaudePermissionPolicy, readClaudeSaveBeforeCommands } from '../common/claudeConfiguration.js';
import { readClaudeGitSettings } from '../common/claudeGitSettings.js';
import { CLAUDE_MAKER_ACTIVE_SETTING, readClaudeMakerActive } from '../common/claudeMakerPrompt.js';
import { CLAUDE_WORK_RULES_SETTING, readClaudeWorkRules } from '../common/claudeWorkRules.js';
import { CLAUDE_VERIFY_UI_SETTING, readClaudeVerifyUi } from '../common/claudeVerifyUi.js';
import { CLAUDE_AGENT_REPLY_STYLE_SETTING,readClaudeReplyStyle } from '../common/claudeReplyStyle.js';
import { ClaudeUserLayerSettings, claudeUserLayerDirectory, readClaudeUserLayerSettings } from '../common/claudeUserLayer.js';
import { ClaudeSandboxStatus, readClaudeSecuritySettings } from '../common/claudeSecuritySettings.js';
// Registers the sandbox and policy settings here too, so this process applies their policies.
import '../common/claudeSecurityConfiguration.js';
import { ClaudeMcpAddRequest, ClaudeMcpRemoveRequest } from '../common/claudeMcpConfig.js';
import { ClaudePluginCommand, ClaudePluginCommandResult } from '../common/claudePlugins.js';
import { FakeClaudeRuntimeService } from '../common/fakeClaudeRuntimeService.js';
import { ClaudeContextBreakdown, NormalizedClaudeEvent, PermissionChoice } from '../common/claudeProtocol.js';
import { ClaudeReviewRequest } from '../common/claudeReviewLoop.js';
import { ClaudeSessionPermissions } from '../common/claudeSessionPermissions.js';
import { ClaudeElicitationAnswer } from '../common/claudeElicitation.js';
import { ClaudeSessionSettings } from '../common/claudeSessionSettings.js';
import { ClaudeSideQuestionRequest, ClaudeSideQuestionResult } from '../common/claudeSideQuestion.js';
import { ClaudeGistReadResult, ClaudeGistRequest, ClaudeGistResult } from '../common/claudeShare.js';
import { ClaudeStatusLineRequest, ClaudeStatusLineResult } from '../common/claudeStatusLine.js';
import { ClaudeTerminalRunRequest, ClaudeTerminalRunResult } from '../common/claudeTerminalRun.js';
import { ClaudeDebugExtraLines, ClaudeReproductionAnswer, ClaudeReproductionRequest } from '../common/claudeDebugMode.js';
import { ClaudeCloudCapability, ClaudeCloudSendRequest, ClaudeCloudSendResult } from '../common/claudeCloud.js';
import { ClaudeRemoteControlState } from '../common/claudeRemoteControl.js';
import { claudeTestSessionFixtures } from '../common/claudeTestSession.js';
import { claudeFakeFixtures } from './claudeFixtureDirectory.js';
import { ClaudeNodeRuntimeService } from './claudeNodeRuntimeService.js';
import { probeClaudeSandbox } from './claudeSandboxProbe.js';
import { ClaudeMcpControlAction, ClaudeMcpLog } from '../common/claudeMcpControl.js';
import { ClaudeKlawlyHookRequest, ClaudeKlawlyHookResult } from '../common/claudeKlawlyHooks.js';
import { nodeClaudeKlawlyHookHost, runClaudeKlawlyHooks } from './claudeKlawlyHookRunner.js';
import { readClaudeAutoReviewInstructions, readClaudeAutoReviewToggles } from '../common/claudeAutoReview.js';
import { ClaudeBrowserToolRequest, ClaudeBrowserToolResult } from '../common/claudeBrowserTool.js';
import { ClaudeSettingsToolRequest, ClaudeSettingsToolResult } from '../common/claudeSettingsTool.js';
import { ClaudeDelegateToolRequest, ClaudeDelegateToolResult } from '../common/claudeDelegate.js';
import { ClaudeDepartmentToolRequest, ClaudeDepartmentToolResult } from '../common/claudeDepartment.js';
import { ClaudeStartAgentToolRequest, ClaudeStartAgentToolResult } from '../common/claudeStartAgent.js';

export interface ClaudeSharedRuntimeOptions {
	getKind(): ClaudeAgentRuntimeKind;
	getRuntimePath(): string | undefined;
	readonly onDidChangeConfiguration: Event<IConfigurationChangeEvent>;
	createFake(): IClaudeRuntimeService & IDisposable;
	createLive(runtimePath: string | undefined): IClaudeRuntimeService & IDisposable;
	/** Which user layers Klawly hooks read (issue 455). Both when absent. */
	getUserLayer?(): ClaudeUserLayerSettings;
	log?(line: string): void;
}

/**
 * Shared-process `IClaudeRuntimeService`. `claude.agent.runtime` selects the fake
 * script or `ClaudeNodeRuntimeService`. The renderer only sees this interface.
 */
export class ClaudeSharedRuntimeService extends Disposable implements IClaudeRuntimeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeRuntimeState = this._register(new Emitter<ClaudeRuntimeState>());
	readonly onDidChangeRuntimeState = this._onDidChangeRuntimeState.event;

	private readonly _onDidEmitEvent = this._register(new Emitter<NormalizedClaudeEvent>());
	readonly onDidEmitEvent = this._onDidEmitEvent.event;

	private readonly _onDidEmitRawMessage = this._register(new Emitter<ClaudeRawSdkMessage>());
	readonly onDidEmitRawMessage = this._onDidEmitRawMessage.event;

	private readonly _onDidRequestSaveBeforeCommand = this._register(new Emitter<ClaudeSaveBeforeCommandRequest>());
	readonly onDidRequestSaveBeforeCommand = this._onDidRequestSaveBeforeCommand.event;

	private readonly _onDidRequestTerminalRun = this._register(new Emitter<ClaudeTerminalRunRequest>());
	readonly onDidRequestTerminalRun = this._onDidRequestTerminalRun.event;
	private readonly _onDidRequestBrowser = this._register(new Emitter<ClaudeBrowserToolRequest>());
	readonly onDidRequestBrowser = this._onDidRequestBrowser.event;
	private readonly _onDidRequestSettings = this._register(new Emitter<ClaudeSettingsToolRequest>());
	readonly onDidRequestSettings = this._onDidRequestSettings.event;
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

	private readonly _onDidRequestReproduction = this._register(new Emitter<ClaudeReproductionRequest>());
	readonly onDidRequestReproduction = this._onDidRequestReproduction.event;

	private readonly _implListeners = this._register(new DisposableStore());
	private readonly _openSessions = new Set<string>();
	private _impl: (IClaudeRuntimeService & IDisposable) | undefined;
	private _kind: ClaudeAgentRuntimeKind | undefined;
	private _runtimePath: string | undefined;

	constructor(private readonly _options: ClaudeSharedRuntimeOptions) {
		super();
		this._register(this._options.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_AGENT_RUNTIME_SETTING) || event.affectsConfiguration(CLAUDE_AGENT_RUNTIME_PATH_SETTING)) {
				this.applySelection(true);
			}
		}));
		this.applySelection(false);
	}

	getRuntimeState(): Promise<ClaudeRuntimeState> {
		return this.impl().getRuntimeState();
	}

	ensureRuntime(): Promise<ClaudeRuntimeState> {
		return this.impl().ensureRuntime();
	}

	async begin(request: BeginClaudeRequest): Promise<ClaudeRunHandle> {
		const impl = this.impl();
		const handle = await impl.begin(request);
		if (this._impl !== impl) {
			// The runtime that started this session is no longer current. Dispose
			// that session on the stale runtime: the renderer's dispose goes to
			// the new one, which does not know the id.
			void impl.disposeSession(handle.sessionId);
			this._onDidEmitEvent.fire({
				type: 'session.failed',
				sessionId: handle.sessionId,
				kind: 'unknown',
				message: 'Claude runtime setting changed.',
			});
			return handle;
		}
		this._openSessions.add(handle.sessionId);
		return handle;
	}

	send(sessionId: string, input: ClaudeUserInput): Promise<void> {
		return this.impl().send(sessionId, input);
	}

	canSteer(sessionId: string): Promise<boolean> {
		return this.impl().canSteer(sessionId);
	}

	steer(sessionId: string, text: string): Promise<boolean> {
		return this.impl().steer(sessionId, text);
	}

	interrupt(sessionId: string): Promise<void> {
		return this.impl().interrupt(sessionId);
	}

	resolvePermission(sessionId: string, requestId: string, choice: PermissionChoice): Promise<void> {
		return this.impl().resolvePermission(sessionId, requestId, choice);
	}

	resolveElicitation(sessionId: string, id: string, answer: ClaudeElicitationAnswer): Promise<void> {
		return this.impl().resolveElicitation?.(sessionId, id, answer) ?? Promise.resolve();
	}

	setToolRefusal(sessionId: string, message: string | undefined): Promise<void> {
		return this.impl().setToolRefusal?.(sessionId, message) ?? Promise.resolve();
	}

	setSessionPermissions(sessionId: string, permissions: ClaudeSessionPermissions): Promise<void> {
		return this.impl().setSessionPermissions?.(sessionId, permissions) ?? Promise.resolve();
	}

	interruptSubagent(sessionId: string, runId: string): Promise<void> {
		return this.impl().interruptSubagent(sessionId, runId);
	}

	disposeSession(sessionId: string): Promise<void> {
		this._openSessions.delete(sessionId);
		return this.impl().disposeSession(sessionId);
	}

	listModels(): Promise<readonly ClaudeModelInfo[]> {
		return this.impl().listModels();
	}

	getAccountOverview(refreshUsage?: ClaudeUsageRefresh, accountId?: string): Promise<ClaudeAccountOverview> {
		return this.impl().getAccountOverview?.(refreshUsage, accountId) ?? Promise.resolve({ live: false });
	}

	listCommands(cwd: string): Promise<ClaudeCommandListing> {
		return this.impl().listCommands?.(cwd) ?? Promise.resolve({ commands: [], agents: [] });
	}

	getContextBreakdown(sessionId: string): Promise<ClaudeContextBreakdown | undefined> {
		return this.impl().getContextBreakdown?.(sessionId) ?? Promise.resolve(undefined);
	}

	logout(): Promise<ClaudeRuntimeState> {
		return this.impl().logout?.() ?? Promise.reject(new Error('This Claude runtime cannot log out.'));
	}

	listAccounts(): Promise<readonly ClaudeAccountEntry[]> {
		return this.impl().listAccounts?.() ?? Promise.resolve([]);
	}

	addAccount(): Promise<ClaudeAccountSignIn> {
		return this.impl().addAccount?.() ?? Promise.reject(new Error('This Claude runtime keeps only one account.'));
	}

	finishAddAccount(id: string): Promise<ClaudeAccountEntry | undefined> {
		return this.impl().finishAddAccount?.(id) ?? Promise.resolve(undefined);
	}

	switchAccount(id: string): Promise<ClaudeRuntimeState> {
		return this.impl().switchAccount?.(id) ?? Promise.reject(new Error('This Claude runtime keeps only one account.'));
	}

	signOutAccount(id: string): Promise<ClaudeRuntimeState> {
		return this.impl().signOutAccount?.(id) ?? Promise.reject(new Error('This Claude runtime cannot log out.'));
	}

	addMcpServer(request: ClaudeMcpAddRequest): Promise<void> {
		return this.impl().addMcpServer?.(request) ?? Promise.reject(new Error('This Claude runtime cannot add MCP servers.'));
	}

	controlMcpServer(name: string, action: ClaudeMcpControlAction): Promise<ClaudeAccountOverview> {
		return this.impl().controlMcpServer?.(name, action) ?? Promise.reject(new Error('This Claude runtime cannot control MCP servers.'));
	}

	loadMcpApp(sessionId: string, toolName: string): Promise<ClaudeMcpAppLoad | undefined> {
		return this.impl().loadMcpApp?.(sessionId, toolName) ?? Promise.resolve(undefined);
	}

	readMcpResource(sessionId: string, server: string, uri: string): Promise<readonly ClaudeMcpResourceContent[]> {
		return this.impl().readMcpResource?.(sessionId, server, uri) ?? Promise.reject(new Error('This Claude runtime cannot read MCP resources.'));
	}

	readMcpServerLog(name: string, cwd: string): Promise<ClaudeMcpLog> {
		return this.impl().readMcpServerLog?.(name, cwd) ?? Promise.resolve({ lines: [] });
	}

	removeMcpServer(request: ClaudeMcpRemoveRequest): Promise<void> {
		return this.impl().removeMcpServer?.(request) ?? Promise.reject(new Error('This Claude runtime cannot remove MCP servers.'));
	}

	runPluginCommand(command: ClaudePluginCommand): Promise<ClaudePluginCommandResult> {
		return this.impl().runPluginCommand?.(command) ?? Promise.reject(new Error('This Claude runtime cannot install plugins.'));
	}

	getSandboxStatus(): Promise<ClaudeSandboxStatus> {
		return probeClaudeSandbox();
	}

	/** Hooks run the same for the fake and the live runtime: they are the user's commands, not Claude's. */
	runKlawlyHooks(request: ClaudeKlawlyHookRequest): Promise<ClaudeKlawlyHookResult> {
		const userLayer = claudeUserLayerDirectory(homedir(), product.dataFolderName);
		return runClaudeKlawlyHooks(request, nodeClaudeKlawlyHookHost(userLayer, this._options.getUserLayer?.().useClaudeCodeSetup));
	}

	getCloudCapability(): Promise<ClaudeCloudCapability> {
		return this.impl().getCloudCapability?.() ?? Promise.resolve({ cloud: false, teleport: false });
	}

	sendToCloudSession(request: ClaudeCloudSendRequest): Promise<ClaudeCloudSendResult> {
		return this.impl().sendToCloudSession?.(request) ?? Promise.reject(new Error('This Claude runtime cannot reach cloud sessions.'));
	}

	setRemoteControl(sessionId: string, enabled: boolean, name?: string): Promise<ClaudeRemoteControlState> {
		return this.impl().setRemoteControl?.(sessionId, enabled, name) ?? Promise.reject(new Error('This Claude runtime cannot start Remote Control.'));
	}

	getRemoteControl(sessionId: string): Promise<ClaudeRemoteControlState | undefined> {
		return this.impl().getRemoteControl?.(sessionId) ?? Promise.resolve(undefined);
	}

	setModel(sessionId: string, modelId: string): Promise<void> {
		return this.impl().setModel(sessionId, modelId);
	}

	setSessionSettings(sessionId: string, settings: ClaudeSessionSettings): Promise<void> {
		const impl = this.impl();
		return impl.setSessionSettings ? impl.setSessionSettings(sessionId, settings) : Promise.reject(new Error('This Claude runtime cannot change effort, fast mode, Ultracode or thinking settings.'));
	}

	resolveSaveBeforeCommand(sessionId: string, requestId: string): Promise<void> {
		return this.impl().resolveSaveBeforeCommand?.(sessionId, requestId) ?? Promise.resolve();
	}

	resolveBrowserRequest(sessionId: string, requestId: string, result: ClaudeBrowserToolResult): Promise<void> {
		return this.impl().resolveBrowserRequest?.(sessionId, requestId, result) ?? Promise.resolve();
	}

	resolveSettingsRequest(sessionId: string, requestId: string, result: ClaudeSettingsToolResult): Promise<void> {
		return this.impl().resolveSettingsRequest?.(sessionId, requestId, result) ?? Promise.resolve();
	}

	resolveStartAgentRequest(sessionId: string, requestId: string, result: ClaudeStartAgentToolResult): Promise<void> {
		return this.impl().resolveStartAgentRequest?.(sessionId, requestId, result) ?? Promise.resolve();
	}

	resolveDepartmentRequest(sessionId: string, requestId: string, result: ClaudeDepartmentToolResult): Promise<void> {
		return this.impl().resolveDepartmentRequest?.(sessionId, requestId, result) ?? Promise.resolve();
	}

	resolveDelegateRequest(sessionId: string, requestId: string, result: ClaudeDelegateToolResult): Promise<void> {
		return this.impl().resolveDelegateRequest?.(sessionId, requestId, result) ?? Promise.resolve();
	}

	resolveTerminalRun(sessionId: string, requestId: string, result: ClaudeTerminalRunResult): Promise<void> {
		return this.impl().resolveTerminalRun?.(sessionId, requestId, result) ?? Promise.resolve();
	}

	startDebugCapture(sessionId: string, requestId: string): Promise<void> {
		return this.impl().startDebugCapture?.(sessionId, requestId) ?? Promise.resolve();
	}

	resolveReproduction(sessionId: string, requestId: string, answer: ClaudeReproductionAnswer, extra?: ClaudeDebugExtraLines): Promise<void> {
		return this.impl().resolveReproduction?.(sessionId, requestId, answer, extra) ?? Promise.resolve();
	}

	completeInline(request: ClaudeInlineCompletionRequest): Promise<string | undefined> {
		return this.impl().completeInline?.(request) ?? Promise.resolve(undefined);
	}

	cancelInline(requestId: string): Promise<void> {
		return this.impl().cancelInline?.(requestId) ?? Promise.resolve();
	}

	judgeComparison(request: ClaudeComparisonJudgeRequest): Promise<ClaudeComparisonJudgeResult> {
		return this.impl().judgeComparison?.(request) ?? Promise.resolve({ ok: false, message: 'This Claude runtime cannot judge a comparison.' });
	}

	cancelComparisonJudge(requestId: string): Promise<void> {
		return this.impl().cancelComparisonJudge?.(requestId) ?? Promise.resolve();
	}

	classifyAutoModel(request: ClaudeAutoModelRequest): Promise<ClaudeAutoModelClassification> {
		return this.impl().classifyAutoModel?.(request) ?? Promise.resolve({ ok: false, message: 'This Claude runtime cannot classify a prompt.' });
	}

	cancelAutoModel(requestId: string): Promise<void> {
		return this.impl().cancelAutoModel?.(requestId) ?? Promise.resolve();
	}

	reviewChanges(request: ClaudeReviewRequest): Promise<ClaudeReviewResult> {
		return this.impl().reviewChanges?.(request)
			?? Promise.resolve({ ok: false, reviewId: request.reviewId, failure: { kind: 'failed', message: 'This Claude runtime cannot run a structured review.' } });
	}

	cancelReview(reviewId: string): Promise<void> {
		return this.impl().cancelReview?.(reviewId) ?? Promise.resolve();
	}

	askSideQuestion(request: ClaudeSideQuestionRequest): Promise<ClaudeSideQuestionResult> {
		return this.impl().askSideQuestion?.(request) ?? Promise.resolve({ kind: 'failed', message: 'This Claude runtime cannot answer side questions.' });
	}

	cancelSideQuestion(requestId: string): Promise<void> {
		return this.impl().cancelSideQuestion?.(requestId) ?? Promise.resolve();
	}

	createSecretGist(request: ClaudeGistRequest): Promise<ClaudeGistResult> {
		return this.impl().createSecretGist?.(request) ?? Promise.resolve({ kind: 'failed', problem: 'failed', message: 'This Claude runtime cannot share chats.' });
	}

	readSharedGist(link: string): Promise<ClaudeGistReadResult> {
		return this.impl().readSharedGist?.(link) ?? Promise.resolve({ kind: 'failed', problem: 'failed', message: 'This Claude runtime cannot open shared chats.' });
	}

	runStatusLine(request: ClaudeStatusLineRequest): Promise<ClaudeStatusLineResult> {
		return this.impl().runStatusLine?.(request) ?? Promise.resolve({ kind: 'none' });
	}

	override dispose(): void {
		this.failOpenSessions('Claude runtime stopped.');
		this._implListeners.clear();
		this._impl?.dispose();
		this._impl = undefined;
		super.dispose();
	}

	private applySelection(probe: boolean): void {
		const kind = this._options.getKind();
		const runtimePath = this._options.getRuntimePath();
		if (this._impl && kind === this._kind && (kind === 'fake' || runtimePath === this._runtimePath)) {
			this._runtimePath = runtimePath;
			return;
		}
		this._kind = kind;
		this._runtimePath = runtimePath;
		this.failOpenSessions('Claude runtime setting changed.');
		const previous = this._impl;
		this._impl = undefined;
		this._implListeners.clear();
		previous?.dispose();
		const next = kind === 'live' ? this._options.createLive(runtimePath) : this._options.createFake();
		this._impl = next;
		this._implListeners.add(next.onDidEmitEvent(event => {
			if (event.type === 'session.completed' || event.type === 'session.failed') {
				this._openSessions.delete(event.sessionId);
			}
			this._onDidEmitEvent.fire(event);
		}));
		this._implListeners.add(next.onDidChangeRuntimeState(state => this._onDidChangeRuntimeState.fire(state)));
		if (next.onDidEmitRawMessage) {
			this._implListeners.add(next.onDidEmitRawMessage(message => this._onDidEmitRawMessage.fire(message)));
		}
		if (next.onDidRequestSaveBeforeCommand) {
			this._implListeners.add(next.onDidRequestSaveBeforeCommand(request => this._onDidRequestSaveBeforeCommand.fire(request)));
		}
		if (next.onDidRequestTerminalRun) {
			this._implListeners.add(next.onDidRequestTerminalRun(request => this._onDidRequestTerminalRun.fire(request)));
		}
		if (next.onDidRequestReproduction) {
			this._implListeners.add(next.onDidRequestReproduction(request => this._onDidRequestReproduction.fire(request)));
		}
		if (next.onDidRequestBrowser) {
			this._implListeners.add(next.onDidRequestBrowser(request => this._onDidRequestBrowser.fire(request)));
		}
		if (next.onDidRequestSettings) {
			this._implListeners.add(next.onDidRequestSettings(request => this._onDidRequestSettings.fire(request)));
		}
		if (next.onDidRequestFeedback) {
			this._implListeners.add(next.onDidRequestFeedback(request => this._onDidRequestFeedback.fire(request)));
		}
		if (next.onDidReportStatus) {
			this._implListeners.add(next.onDidReportStatus(report => this._onDidReportStatus.fire(report)));
		}
		if (next.onDidRequestSessionMessage) {
			this._implListeners.add(next.onDidRequestSessionMessage(request => this._onDidRequestSessionMessage.fire(request)));
		}
		if (next.onDidRequestStartAgent) {
			this._implListeners.add(next.onDidRequestStartAgent(request => this._onDidRequestStartAgent.fire(request)));
		}
		if (next.onDidRequestDepartment) {
			this._implListeners.add(next.onDidRequestDepartment(request => this._onDidRequestDepartment.fire(request)));
		}
		if (next.onDidRequestDelegate) {
			this._implListeners.add(next.onDidRequestDelegate(request => this._onDidRequestDelegate.fire(request)));
		}
		this._options.log?.(`Claude runtime selection is ${kind}.`);
		if (probe) {
			void next.ensureRuntime();
		}
	}

	private failOpenSessions(message: string): void {
		const open = [...this._openSessions];
		this._openSessions.clear();
		for (const sessionId of open) {
			this._onDidEmitEvent.fire({
				type: 'session.failed',
				sessionId,
				kind: 'unknown',
				message,
			});
		}
	}

	private impl(): IClaudeRuntimeService {
		if (!this._impl) {
			throw new Error('Claude runtime is disposed.');
		}
		return this._impl;
	}
}

/** DI wrapper registered in the shared process. */
export class ClaudeSharedProcessRuntimeService extends ClaudeSharedRuntimeService {
	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@INativeEnvironmentService environmentService: INativeEnvironmentService,
	) {
		super({
			getKind: () => readClaudeAgentRuntimeKind(configurationService.getValue(CLAUDE_AGENT_RUNTIME_SETTING)),
			getRuntimePath: () => readClaudeAgentRuntimePath(configurationService.getValue(CLAUDE_AGENT_RUNTIME_PATH_SETTING)),
			onDidChangeConfiguration: configurationService.onDidChangeConfiguration,
			createFake: () => {
				const { fixtures, ...options } = claudeFakeFixtures(claudeTestSessionFixtures(), environmentService.isBuilt, environmentService.userDataPath);
				return new FakeClaudeRuntimeService(fixtures, options);
			},
			createLive: runtimePath => new ClaudeNodeRuntimeService({
				runtimePath,
				userDataPath: environmentService.userDataPath,
				checkpointsEnabled: () => readCheckpointsEnabled(configurationService.getValue(CLAUDE_CHECKPOINTS_ENABLED_SETTING)),
				retentionDays: () => readCheckpointRetentionDays(configurationService.getValue(CLAUDE_CHECKPOINT_RETENTION_SETTING)),
				getPermissionPolicy: () => readClaudePermissionPolicy(key => configurationService.getValue(key)),
				autoReviewInstructions: () => readClaudeAutoReviewInstructions(key => configurationService.getValue(key)),
				autoReviewToggles: () => readClaudeAutoReviewToggles(key => configurationService.getValue(key)),
				autoModeOn: () => configurationService.getValue<boolean>(CLAUDE_AUTO_ENABLED_SETTING) === true,
				retainRawMessages: () => configurationService.getValue(CLAUDE_DEBUG_RETAIN_RAW_SETTING) === true,
				builtInAgentsEnabled: () => readClaudeBuiltInAgents(configurationService.getValue(CLAUDE_SUBAGENTS_BUILT_IN_SETTING)),
				delegationEnabled: () => readClaudeDelegationEnabled(configurationService.getValue(CLAUDE_DELEGATION_ENABLED_SETTING)),
				gitSettings: () => readClaudeGitSettings(key => configurationService.getValue(key)),
				securitySettings: () => readClaudeSecuritySettings(key => configurationService.getValue(key), key => configurationService.inspect(key).policyValue),
				agentsFiles: () => readClaudeAgentsFilesSettings(key => configurationService.getValue(key)),
				replyStyle: () => readClaudeReplyStyle(configurationService.getValue(CLAUDE_AGENT_REPLY_STYLE_SETTING)),
				makerMode: () => readClaudeMakerActive(configurationService.getValue(CLAUDE_MAKER_ACTIVE_SETTING)),
				workRules: () => readClaudeWorkRules(configurationService.getValue(CLAUDE_WORK_RULES_SETTING)),
				verifyUi: () => readClaudeVerifyUi(configurationService.getValue(CLAUDE_VERIFY_UI_SETTING)),
				userLayer: () => readClaudeUserLayerSettings(key => configurationService.getValue(key)),
				telemetryEnabled: () => configurationService.getValue(CLAUDE_TELEMETRY_ENABLED_SETTING) === true,
				saveBeforeCommands: () => readClaudeSaveBeforeCommands(configurationService.getValue(CLAUDE_AGENT_SAVE_BEFORE_COMMANDS_SETTING)),
				mergeWithoutAsking: () => readClaudeMergeWithoutAsking(configurationService.getValue(CLAUDE_MERGE_WITHOUT_ASKING_SETTING)),
				// MCP forms and sign-ins are answered in the elicitation card (issue 428).
				elicitations: true,
				log: line => logService.info(`[claude] ${line}`),
			}),
			getUserLayer: () => readClaudeUserLayerSettings(key => configurationService.getValue(key)),
			log: line => logService.info(`[claude] ${line}`),
		});
	}
}
