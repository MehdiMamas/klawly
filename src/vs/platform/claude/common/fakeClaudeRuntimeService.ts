/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ClaudeAccountOverview } from './claudeAccount.js';
import { ClaudeInlineCompletionRequest } from './claudeAutocomplete.js';
import { BeginClaudeRequest, ClaudeModelInfo, ClaudeRunHandle, ClaudeRuntimeState, ClaudeUserInput, IClaudeRuntimeService } from './claude.js';
import { ClaudeCommandInfo, ClaudeCommandListing, ClaudeSubagentInfo } from './claudeCommands.js';
import { ClaudeMcpAddRequest, ClaudeMcpRemoveRequest, readClaudeMcpAddRequest, readClaudeMcpRemoveRequest } from './claudeMcpConfig.js';
import { ClaudeSubagentState, isKnownClaudeEventType, NormalizedClaudeEvent, PermissionChoice, PermissionRequest } from './claudeProtocol.js';
import { ClaudeSessionPermissions, NO_SESSION_PERMISSIONS, readClaudeSessionPermissions } from './claudeSessionPermissions.js';
import { claudeSettingsProblem, ClaudeSessionSettings, DEFAULT_CLAUDE_SESSION_SETTINGS, readClaudeSessionSettings } from './claudeSessionSettings.js';
import { ClaudeSideQuestionRequest, ClaudeSideQuestionResult } from './claudeSideQuestion.js';
import { ClaudeAutoModelClassification, ClaudeAutoModelRequest, estimateClaudeAutoComplexity } from './claudeAutoModel.js';

/** Models this fake reports. They are script labels, not a live model catalog. */
export const FAKE_CLAUDE_MODELS: readonly ClaudeModelInfo[] = [
	// No effort level, fast mode or adaptive thinking.
	{ id: 'fixture-sonnet', displayName: 'Fixture Sonnet', description: 'Scripted test model', source: 'runtime' },
	{
		id: 'fixture-opus', displayName: 'Fixture Opus', description: 'Scripted test model', source: 'runtime',
		supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAdaptiveThinking: true, supportsFastMode: true,
	},
	{
		id: 'fixture-opus[1m]', displayName: 'Fixture Opus (1M context)', description: 'Scripted test model with a 1M-token context', source: 'runtime',
		supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAdaptiveThinking: true, supportsFastMode: true,
	},
];

/**
 * The `/` menu catalog this fake sends after each `session.started`, the way the
 * real runner does once Claude Code lists its commands and subagents.
 */
export const FAKE_CLAUDE_CATALOG: { readonly commands: readonly ClaudeCommandInfo[]; readonly agents: readonly ClaudeSubagentInfo[] } = {
	commands: [
		{ name: 'compact', description: 'Summarize the conversation to free context', argumentHint: '[instructions]', source: 'builtin' },
		{ name: 'clear', description: 'Start over with an empty conversation', aliases: ['reset', 'new'], source: 'builtin' },
		{ name: 'explain', description: 'Explain code in plain words', source: 'skill' },
		{ name: 'ship', description: 'Run the checks and open a pull request', argumentHint: '[branch]', source: 'project' },
	],
	agents: [
		{ name: 'code-reviewer', description: 'Reviews a change for bugs and missing tests', model: 'fixture-sonnet' },
	],
};

/**
 * The account, plan limits and MCP servers this fake reports to Klawly Settings.
 * Reset times are fixed so screenshots and tests do not drift.
 */
export const FAKE_CLAUDE_ACCOUNT_OVERVIEW: ClaudeAccountOverview = {
	live: true,
	account: { email: 'fixture@example.invalid', plan: 'max', provider: 'firstParty' },
	usage: [
		{ kind: 'session', percent: 18, resetsAt: Date.UTC(2026, 9, 7, 17, 0) },
		{ kind: 'week', percent: 42, resetsAt: Date.UTC(2026, 9, 12, 9, 0) },
		{ kind: 'weekOpus', percent: 64, resetsAt: Date.UTC(2026, 9, 12, 9, 0) },
	],
	mcpServers: [
		{ name: 'fixture-docs', state: 'connected', scope: 'project', version: '1.2.0', toolCount: 4 },
		{ name: 'fixture-tracker', state: 'needs-auth', scope: 'user', toolCount: 0 },
		{ name: 'fixture-broken', state: 'failed', scope: 'local', toolCount: 0, error: 'The server exited during startup.' },
	],
	commands: FAKE_CLAUDE_CATALOG.commands,
	agents: FAKE_CLAUDE_CATALOG.agents,
};

const DEFAULT_FIXTURE = 'plain-answer';

/** The turn a script's file events belong to, as the agent service named it. */
export interface ClaudeFakeTurn {
	readonly checkpointSessionId: string;
	readonly turnId: string;
	readonly cwd: string;
}

/**
 * Carries out a script's `file.beforeWrite` and `file.afterWrite` the way Claude Code's
 * tools and the runner's checkpoints would, so a scripted turn leaves changes to review.
 * Only a dev build's fixture folder sets this (see `claudeFixtureDirectory.ts`).
 */
export interface ClaudeFakeFileWrites {
	beforeWrite(turn: ClaudeFakeTurn, uri: string): Promise<void>;
	afterWrite(turn: ClaudeFakeTurn, uri: string, after: string | null): Promise<void>;
}

export interface FakeClaudeRuntimeOptions {
	/** Milliseconds between scripted events. */
	readonly stepDelayMs?: number;
	/** Models to report instead of {@link FAKE_CLAUDE_MODELS}. */
	readonly models?: readonly ClaudeModelInfo[];
	readonly fileWrites?: ClaudeFakeFileWrites;
	/** The text a Tab completion request gets. Without it, completions return nothing. */
	readonly inlineCompletion?: (request: ClaudeInlineCompletionRequest) => string | undefined;
	/**
	 * Read on every runtime-state request; what it returns replaces those fields of the
	 * fake's own state, so a screenshot can show Claude Code missing (issue 797).
	 */
	readonly runtimeState?: () => Partial<ClaudeRuntimeState> | undefined;
}

interface FakeSession {
	/** The conversation id `session.started` reports: the resumed id, or a new one. */
	readonly claudeSessionId: string;
	readonly cwd: string;
	/** The turn now replaying, when the request named one. */
	turn?: ClaudeFakeTurn;
	modelId?: string;
	settings: ClaudeSessionSettings;
	generation: number;
}

/**
 * Replays normalized JSONL fixtures. Each line is one event. `sessionId: "$session"`
 * is replaced with the IDE session id. Unknown event types are dropped. Unparseable
 * lines are skipped.
 *
 * Replay starts on a timer, so no event fires before `begin()` or `send()` resolves.
 * `interrupt()` stops the pump and emits no terminal event. The agent service ends
 * that turn itself as `stopped`, then disposes the session.
 * `send()` without a fixture replays `plain-answer` when that script is loaded,
 * so a later composer turn still streams. This is a test double. It does not
 * probe Claude or read credentials.
 */
export class FakeClaudeRuntimeService extends Disposable implements IClaudeRuntimeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeRuntimeState = this._register(new Emitter<ClaudeRuntimeState>());
	readonly onDidChangeRuntimeState = this._onDidChangeRuntimeState.event;

	private readonly _onDidEmitEvent = this._register(new Emitter<NormalizedClaudeEvent>());
	readonly onDidEmitEvent = this._onDidEmitEvent.event;

	/** Lets a test double emit one event. Production runtimes do not use this. */
	protected emitEvent(event: NormalizedClaudeEvent): void {
		this._onDidEmitEvent.fire(event);
	}

	private _state: ClaudeRuntimeState = {
		installed: true,
		authenticated: true,
		version: 'fake',
		authMode: 'claude-account',
	};

	private readonly _sessions = new Map<string, FakeSession>();
	private readonly _stoppedSubagents = new Set<string>();
	/** Scripted permission requests nobody has answered yet. */
	private readonly _pendingPermissions = new Map<string, PermissionRequest>();
	private readonly _subagentState = new Map<string, ClaudeSubagentState>();
	/** Caller's run id. Absent for a top-level subagent. */
	private readonly _subagentParent = new Map<string, string | undefined>();
	/** Last Allow All Commands and Allow Everything values per session. Scripts do not read them. */
	private readonly _sessionPermissions = new Map<string, ClaudeSessionPermissions>();
	/** Milliseconds between scripted events. Tests raise this to observe a frame mid-script. */
	stepDelayMs: number;
	private readonly _models: readonly ClaudeModelInfo[];
	private readonly _fileWrites: ClaudeFakeFileWrites | undefined;
	private readonly _inlineCompletion: FakeClaudeRuntimeOptions['inlineCompletion'];
	private readonly _runtimeState: FakeClaudeRuntimeOptions['runtimeState'];
	private _disposed = false;

	constructor(private readonly fixtures: ReadonlyMap<string, string>, options?: FakeClaudeRuntimeOptions) {
		super();
		this.stepDelayMs = options?.stepDelayMs ?? 0;
		this._models = options?.models ?? FAKE_CLAUDE_MODELS;
		this._fileWrites = options?.fileWrites;
		this._inlineCompletion = options?.inlineCompletion;
		this._runtimeState = options?.runtimeState;
	}

	async getRuntimeState(): Promise<ClaudeRuntimeState> {
		return { ...this._state, ...this._runtimeState?.() };
	}

	async ensureRuntime(): Promise<ClaudeRuntimeState> {
		return this.getRuntimeState();
	}

	/** Signs the fake out. Nothing is deleted: the fake holds no credentials. */
	async logout(): Promise<ClaudeRuntimeState> {
		this._state = { installed: true, authenticated: false, version: this._state.version };
		this._onDidChangeRuntimeState.fire({ ...this._state });
		return { ...this._state };
	}

	async listModels(): Promise<readonly ClaudeModelInfo[]> {
		return this.catalog().map(model => ({ ...model }));
	}

	/** The models this fake runs and checks settings against; a test fake can override it to change both at once. */
	protected catalog(): readonly ClaudeModelInfo[] {
		return this._models;
	}

	/** Every folder `listCommands` was asked about, for tests. */
	readonly commandListings: string[] = [];

	async listCommands(cwd: string): Promise<ClaudeCommandListing> {
		this.commandListings.push(cwd);
		return FAKE_CLAUDE_CATALOG;
	}

	async getAccountOverview(): Promise<ClaudeAccountOverview> {
		return FAKE_CLAUDE_ACCOUNT_OVERVIEW;
	}

	/** Every MCP add and remove, in order, for tests. Nothing is written. */
	readonly mcpChanges: (ClaudeMcpAddRequest | ClaudeMcpRemoveRequest)[] = [];

	async addMcpServer(request: ClaudeMcpAddRequest): Promise<void> {
		const valid = readClaudeMcpAddRequest(request);
		if (!valid) {
			throw new Error('The MCP server is not valid.');
		}
		this.mcpChanges.push(valid);
	}

	async removeMcpServer(request: ClaudeMcpRemoveRequest): Promise<void> {
		const valid = readClaudeMcpRemoveRequest(request);
		if (!valid) {
			throw new Error('The MCP server is not valid.');
		}
		this.mcpChanges.push(valid);
	}

	async begin(request: BeginClaudeRequest): Promise<ClaudeRunHandle> {
		const sessionId = generateUuid();
		const modelId = request.modelId ?? this.catalog()[0].id;
		this._requireModel(modelId);
		const fixtureName = request.fixture ?? DEFAULT_FIXTURE;
		if (!this.fixtures.has(fixtureName)) {
			throw new Error(`Unknown Claude fixture: ${fixtureName}`);
		}
		const settings = readClaudeSessionSettings(request.sessionSettings);
		this._requireSettings(modelId, settings);
		const turn = request.turnId ? { checkpointSessionId: request.checkpointSessionId ?? sessionId, turnId: request.turnId, cwd: request.cwd } : undefined;
		const session: FakeSession = { claudeSessionId: request.resumeSessionId ?? `claude-${sessionId}`, cwd: request.cwd, turn, modelId, settings, generation: 1 };
		this._sessions.set(sessionId, session);
		if (request.sessionPermissions) {
			this._sessionPermissions.set(sessionId, readClaudeSessionPermissions(request.sessionPermissions));
		}
		this._replay(sessionId, session, fixtureName);
		return { sessionId };
	}

	async canSteer(_sessionId: string): Promise<boolean> {
		return false;
	}

	async steer(_sessionId: string, _text: string): Promise<boolean> {
		return false;
	}

	async send(sessionId: string, input: ClaudeUserInput): Promise<void> {
		const session = this._requireSession(sessionId);
		if (input.sessionPermissions) {
			this._sessionPermissions.set(sessionId, readClaudeSessionPermissions(input.sessionPermissions));
		}
		const fixtureName = input.fixture ?? (input.text.trim() ? DEFAULT_FIXTURE : undefined);
		if (!fixtureName || (!input.fixture && !this.fixtures.has(fixtureName))) {
			return;
		}
		if (!this.fixtures.has(fixtureName)) {
			throw new Error(`Unknown Claude fixture: ${fixtureName}`);
		}
		session.generation++;
		session.turn = input.turnId ? { checkpointSessionId: input.checkpointSessionId ?? session.turn?.checkpointSessionId ?? sessionId, turnId: input.turnId, cwd: session.cwd } : undefined;
		this._dropSessionKeys(sessionId);
		this._replay(sessionId, session, fixtureName);
	}

	async interrupt(sessionId: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (session) {
			session.generation++;
			this._dropSessionKeys(sessionId);
		}
	}

	async resolvePermission(sessionId: string, requestId: string, choice: PermissionChoice): Promise<void> {
		const key = subagentKey(sessionId, requestId);
		const request = this._pendingPermissions.get(key);
		if (!request || this._disposed) {
			return;
		}
		this._pendingPermissions.delete(key);
		const allowed = choice !== 'deny';
		this._onDidEmitEvent.fire({
			type: 'permission.resolved',
			sessionId,
			outcome: {
				requestId,
				toolName: request.toolName,
				decision: allowed ? 'allow' : 'deny',
				scope: !allowed ? undefined : choice === 'allow-session' ? 'session' : choice === 'allow-workspace' ? 'workspace' : 'once',
				source: 'user',
				subject: request.command ?? request.targetPath,
			},
		});
	}

	async setSessionPermissions(sessionId: string, permissions: ClaudeSessionPermissions): Promise<void> {
		if (this._sessions.has(sessionId)) {
			this._sessionPermissions.set(sessionId, readClaudeSessionPermissions(permissions));
		}
	}

	private readonly _toolRefusals = new Map<string, string>();

	async setToolRefusal(sessionId: string, message: string | undefined): Promise<void> {
		if (message === undefined) {
			this._toolRefusals.delete(sessionId);
		} else if (this._sessions.has(sessionId)) {
			this._toolRefusals.set(sessionId, message);
		}
	}

	/** The refusal the cost watcher last set for a session (issue 847). */
	getToolRefusal(sessionId: string): string | undefined {
		return this._toolRefusals.get(sessionId);
	}

	/** The switches the workbench last sent for a session. */
	getSessionPermissions(sessionId: string): ClaudeSessionPermissions {
		return this._sessionPermissions.get(sessionId) ?? NO_SESSION_PERMISSIONS;
	}

	async interruptSubagent(sessionId: string, runId: string): Promise<void> {
		this._requireSession(sessionId);
		const key = subagentKey(sessionId, runId);
		if (this._subagentState.get(key) !== 'running') {
			return;
		}
		this._subagentState.set(key, 'stopped');
		this._stoppedSubagents.add(key);
		if (!this._disposed) {
			const parentRunId = this._subagentParent.get(key);
			this._onDidEmitEvent.fire(parentRunId
				? { type: 'subagent.finished', sessionId, runId, state: 'stopped', parentRunId }
				: { type: 'subagent.finished', sessionId, runId, state: 'stopped' });
		}
	}

	async disposeSession(sessionId: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (session) {
			session.generation++;
		}
		this._sessions.delete(sessionId);
		this._sessionPermissions.delete(sessionId);
		this._dropSessionKeys(sessionId);
	}

	async completeInline(request: ClaudeInlineCompletionRequest): Promise<string | undefined> {
		return this._inlineCompletion?.(request);
	}

	async cancelInline(_requestId: string): Promise<void> { }

	/** The fake runtime has no conversation to fork, so it echoes the question. */
	async askSideQuestion(request: ClaudeSideQuestionRequest): Promise<ClaudeSideQuestionResult> {
		return { kind: 'answer', text: `Side answer from the fake runtime: ${request.question.trim()}` };
	}

	async cancelSideQuestion(_requestId: string): Promise<void> { }

	/** Auto model (issue 521): rates the prompt with the local estimate, so a scripted session routes without Haiku. */
	async classifyAutoModel(request: ClaudeAutoModelRequest): Promise<ClaudeAutoModelClassification> {
		return { ok: true, complexity: estimateClaudeAutoComplexity(request), reason: 'Rated by the fake runtime' };
	}

	async cancelAutoModel(_requestId: string): Promise<void> { }

	async setModel(sessionId: string, modelId: string): Promise<void> {
		const session = this._requireSession(sessionId);
		this._requireModel(modelId);
		session.modelId = modelId;
		if (!this._disposed) {
			this._onDidEmitEvent.fire({
				type: 'session.modelChanged',
				sessionId,
				modelId,
			});
		}
	}

	async setSessionSettings(sessionId: string, value: ClaudeSessionSettings): Promise<void> {
		const session = this._requireSession(sessionId);
		const settings = readClaudeSessionSettings(value);
		this._requireSettings(session.modelId, settings);
		session.settings = settings;
		if (!this._disposed) {
			this._onDidEmitEvent.fire({ type: 'session.settingsChanged', sessionId, settings });
		}
	}

	/** The settings a session runs with, for tests. Default settings for an unknown session. */
	getSessionSettings(sessionId: string): ClaudeSessionSettings {
		return this._sessions.get(sessionId)?.settings ?? DEFAULT_CLAUDE_SESSION_SETTINGS;
	}

	override dispose(): void {
		this._disposed = true;
		super.dispose();
	}

	private _replay(sessionId: string, session: FakeSession, fixtureName: string): void {
		const raw = this.fixtures.get(fixtureName);
		if (raw === undefined) {
			throw new Error(`Unknown Claude fixture: ${fixtureName}`);
		}
		const events = parseClaudeFixture(raw, sessionId);
		const generation = session.generation;
		disposableTimeout(() => this._pump(sessionId, generation, events, 0), 0, this._store);
	}

	private _pump(sessionId: string, generation: number, events: readonly NormalizedClaudeEvent[], index: number): void {
		if (this._disposed) {
			return;
		}
		const session = this._sessions.get(sessionId);
		if (!session || session.generation !== generation) {
			return;
		}
		while (index < events.length) {
			const event = withClaudeSessionId(events[index], session);
			if (this._shouldSkip(sessionId, event)) {
				this._stopDescendant(sessionId, event);
				index++;
				continue;
			}
			const write = this._writeFile(session, event);
			if (write) {
				// A failed write still emits its event: the turn shows the file, with nothing to review.
				void write.catch(() => undefined).then(() => this._emit(sessionId, generation, events, index, event));
			} else {
				this._emit(sessionId, generation, events, index, event);
			}
			return;
		}
	}

	private _emit(sessionId: string, generation: number, events: readonly NormalizedClaudeEvent[], index: number, event: NormalizedClaudeEvent): void {
		if (this._disposed || this._sessions.get(sessionId)?.generation !== generation) {
			return;
		}
		this._rememberSubagent(sessionId, event);
		if (event.type === 'permission.requested') {
			this._pendingPermissions.set(subagentKey(sessionId, event.request.id), event.request);
		}
		this._onDidEmitEvent.fire(event);
		if (event.type === 'session.started' && !event.parentRunId) {
			this._onDidEmitEvent.fire({ type: 'session.catalog', sessionId: event.sessionId, commands: FAKE_CLAUDE_CATALOG.commands, agents: FAKE_CLAUDE_CATALOG.agents });
		}
		disposableTimeout(() => this._pump(sessionId, generation, events, index + 1), this.stepDelayMs, this._store);
	}

	/** Runs a file event's write before it is emitted, when a turn and {@link ClaudeFakeFileWrites} are set. */
	private _writeFile(session: FakeSession, event: NormalizedClaudeEvent): Promise<void> | undefined {
		const writes = this._fileWrites;
		const turn = session.turn;
		if (!writes || !turn) {
			return undefined;
		}
		if (event.type === 'file.beforeWrite') {
			return writes.beforeWrite(turn, event.uri);
		}
		if (event.type === 'file.afterWrite') {
			return writes.afterWrite(turn, event.uri, event.after);
		}
		return undefined;
	}

	private _requireSession(sessionId: string): FakeSession {
		const session = this._sessions.get(sessionId);
		if (!session) {
			throw new Error(`Unknown Claude session: ${sessionId}`);
		}
		return session;
	}

	private _shouldSkip(sessionId: string, event: NormalizedClaudeEvent): boolean {
		if (event.parentRunId && this._stoppedSubagents.has(subagentKey(sessionId, event.parentRunId))) {
			return true;
		}
		return event.type === 'subagent.finished' && this._stoppedSubagents.has(subagentKey(sessionId, event.runId));
	}

	/** A child that starts inside a stopped run is stopped too, so its own events are skipped. */
	private _stopDescendant(sessionId: string, event: NormalizedClaudeEvent): void {
		if (event.type !== 'subagent.started') {
			return;
		}
		const parent = event.parentRunId ?? event.run.parentRunId;
		if (parent && this._stoppedSubagents.has(subagentKey(sessionId, parent))) {
			const key = subagentKey(sessionId, event.run.id);
			this._stoppedSubagents.add(key);
			this._subagentState.set(key, 'stopped');
		}
	}

	private _rememberSubagent(sessionId: string, event: NormalizedClaudeEvent): void {
		if (event.type === 'subagent.started') {
			const key = subagentKey(sessionId, event.run.id);
			this._subagentState.set(key, 'running');
			this._subagentParent.set(key, event.parentRunId ?? event.run.parentRunId);
		} else if (event.type === 'subagent.finished') {
			this._subagentState.set(subagentKey(sessionId, event.runId), event.state);
		}
	}

	private _dropSessionKeys(sessionId: string): void {
		const prefix = `${sessionId}\n`;
		for (const key of [...this._pendingPermissions.keys()]) {
			if (key.startsWith(prefix)) {
				this._pendingPermissions.delete(key);
			}
		}
		for (const key of [...this._stoppedSubagents]) {
			if (key.startsWith(prefix)) {
				this._stoppedSubagents.delete(key);
			}
		}
		for (const key of [...this._subagentState.keys()]) {
			if (key.startsWith(prefix)) {
				this._subagentState.delete(key);
			}
		}
		for (const key of [...this._subagentParent.keys()]) {
			if (key.startsWith(prefix)) {
				this._subagentParent.delete(key);
			}
		}
	}

	/** Refuses what the real runtime would: an effort, Ultracode, fast mode or thinking switch the model lacks. */
	private _requireSettings(modelId: string | undefined, settings: ClaudeSessionSettings): void {
		const problem = claudeSettingsProblem(this.catalog().find(model => model.id === modelId), settings);
		if (problem) {
			throw new Error(problem);
		}
	}

	private _requireModel(modelId: string): void {
		if (!this.catalog().some(model => model.id === modelId)) {
			throw new Error(`Unknown Claude model: ${modelId}`);
		}
	}
}

export function parseClaudeFixture(raw: string, sessionId: string): NormalizedClaudeEvent[] {
	const events: NormalizedClaudeEvent[] = [];
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== 'object') {
			continue;
		}
		const record = parsed as Record<string, unknown>;
		if (typeof record.type !== 'string' || !isKnownClaudeEventType(record.type)) {
			continue;
		}
		const event = record as unknown as NormalizedClaudeEvent;
		event.sessionId = event.sessionId === '$session' || event.sessionId === undefined ? sessionId : event.sessionId;
		events.push(event);
	}
	return events;
}

function subagentKey(sessionId: string, runId: string): string {
	return `${sessionId}\n${runId}`;
}

/**
 * A top-level `session.started` reports the conversation id, as Claude Code's init
 * message does, and a finished turn reports the chain entry it ended on (issue 702).
 */
function withClaudeSessionId(event: NormalizedClaudeEvent, session: FakeSession): NormalizedClaudeEvent {
	if (event.type === 'session.completed' && !event.anchor) {
		return { ...event, anchor: `${session.claudeSessionId}-${session.turn?.turnId ?? session.generation}` };
	}
	return event.type === 'session.started' && !event.parentRunId && !event.claudeSessionId ? { ...event, claudeSessionId: session.claudeSessionId } : event;
}
