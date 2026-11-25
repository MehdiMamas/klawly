/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IMarker, IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { IClaudeActionService } from '../../../../platform/claude/common/claudeActions.js';
import { CLAUDE_DIAGNOSTICS_AUTO_VERIFY_SETTING, CLAUDE_DIAGNOSTICS_MAX_CYCLES_SETTING, CLAUDE_DIAGNOSTICS_MAX_WAIT_MS, CLAUDE_DIAGNOSTICS_SETTLE_MS_SETTING, readClaudeDiagnosticsAutoVerify, readClaudeDiagnosticsMaxCycles, readClaudeDiagnosticsSettleMs } from '../../../../platform/claude/common/claudeConfiguration.js';
import { DiagnosticSummary } from '../../../../platform/claude/common/claudePrompt.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { IClaudeCheckpointService } from '../../../services/claude/common/claudeCheckpointService.js';
import { DiagnosticsLoop, IClaudeDiagnosticsService, toDiagnosticSummary, touchedUrisFromOriginals } from '../../../services/claude/common/claudeDiagnostics.js';
import { workspaceRelativePath } from './claudeContextService.js';

/**
 * After a code-changing turn, waits for language services to settle, then
 * records new errors in the files that turn wrote. Auto-verify sends those
 * errors through {@link IClaudeActionService} until the cycle cap.
 */
export class ClaudeDiagnosticsService extends Disposable implements IClaudeDiagnosticsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeProblems = this._register(new Emitter<void>());
	readonly onDidChangeProblems = this._onDidChangeProblems.event;

	private readonly _loop: DiagnosticsLoop;
	private readonly _settling = new Set<string>();
	private readonly _retried = new Set<string>();
	private readonly _retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Turns observed running, or completed after this session was first watched. */
	private readonly _eligible = new Set<string>();
	private readonly _seenSessions = new Set<string>();
	private readonly _turnsBySession = new Map<string, Set<string>>();
	private _watchedSessionId: string | undefined;
	/** Turn ids already on the session when auto-verify called the fix action. */
	private _pendingAuto: { sessionId: string; known: ReadonlySet<string> } | undefined;

	constructor(
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IMarkerService private readonly _markers: IMarkerService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IClaudeCheckpointService private readonly _checkpoints: IClaudeCheckpointService,
		@IClaudeActionService private readonly _actions: IClaudeActionService,
	) {
		super();
		this._loop = new DiagnosticsLoop(
			{
				now: () => Date.now(),
				schedule: (delayMs, run) => {
					const handle = setTimeout(run, delayMs);
					return { dispose: () => clearTimeout(handle) };
				},
			},
			() => this.readErrors(),
			() => ({
				settleMs: readClaudeDiagnosticsSettleMs(this._configuration.getValue(CLAUDE_DIAGNOSTICS_SETTLE_MS_SETTING)),
				maxWaitMs: CLAUDE_DIAGNOSTICS_MAX_WAIT_MS,
				autoVerify: readClaudeDiagnosticsAutoVerify(this._configuration.getValue(CLAUDE_DIAGNOSTICS_AUTO_VERIFY_SETTING)),
				maxCycles: readClaudeDiagnosticsMaxCycles(this._configuration.getValue(CLAUDE_DIAGNOSTICS_MAX_CYCLES_SETTING)),
			}),
			() => this._onDidChangeProblems.fire(),
			problems => this.autoVerify(problems),
		);
		this._register({ dispose: () => this._loop.dispose() });
		this._register(this._agent.onDidChangeViewState(() => this.watch()));
		this._register(this._agent.onDidChangeSession(() => this.watch()));
		this._register(this._markers.onMarkerChanged(() => this._loop.markersChanged()));
		this.watch();
	}

	getProblems(turnId: string): readonly DiagnosticSummary[] | undefined {
		return this._loop.get(turnId);
	}

	override dispose(): void {
		this.forgetTurns([...this._turnsBySession.values()].flatMap(ids => [...ids]));
		this._turnsBySession.clear();
		for (const handle of this._retryTimers.values()) {
			clearTimeout(handle);
		}
		this._retryTimers.clear();
		super.dispose();
	}

	private watch(): void {
		this.pruneClosedSessions();
		const session = this._agent.getCurrentSession();
		if (session?.id !== this._watchedSessionId) {
			this._loop.cancelAutoArm();
			this._pendingAuto = undefined;
			this._watchedSessionId = session?.id;
		}
		if (!session) {
			return;
		}
		const turns = this._agent.getViewState(session.id).turns;
		const firstLook = !this._seenSessions.has(session.id);
		if (firstLook) {
			this._seenSessions.add(session.id);
		}
		let owned = this._turnsBySession.get(session.id);
		if (!owned) {
			owned = new Set();
			this._turnsBySession.set(session.id, owned);
		}
		const pending = this._pendingAuto?.sessionId === session.id ? this._pendingAuto : undefined;
		for (const turn of turns) {
			owned.add(turn.id);
			if (pending && !pending.known.has(turn.id)) {
				this._loop.claimAutoTurn(turn.id);
				this._pendingAuto = undefined;
				if (turn.status === 'running') {
					this._eligible.add(turn.id);
					this._loop.noteRunning(turn.id);
				}
				break;
			}
		}
		for (const turn of turns) {
			owned.add(turn.id);
			if (turn.status === 'running') {
				this._eligible.add(turn.id);
				this._loop.noteRunning(turn.id);
			}
		}
		for (const turn of turns) {
			if (turn.status !== 'complete' || this._settling.has(turn.id) || this._loop.hasResult(turn.id)) {
				continue;
			}
			if (firstLook && !this._eligible.has(turn.id)) {
				continue;
			}
			if (!this._eligible.has(turn.id)) {
				this._eligible.add(turn.id);
			}
			this._settling.add(turn.id);
			void this.begin(session.id, turn.id, turn.changedFiles);
		}
	}

	private pruneClosedSessions(): void {
		const live = new Set(this._agent.getSessions().map(session => session.id));
		for (const [sessionId, turns] of this._turnsBySession) {
			if (live.has(sessionId)) {
				continue;
			}
			this.forgetTurns([...turns]);
			this._turnsBySession.delete(sessionId);
			this._seenSessions.delete(sessionId);
		}
	}

	private forgetTurns(turnIds: readonly string[]): void {
		for (const turnId of turnIds) {
			this._eligible.delete(turnId);
			this._settling.delete(turnId);
			this._retried.delete(turnId);
			const handle = this._retryTimers.get(turnId);
			if (handle) {
				clearTimeout(handle);
				this._retryTimers.delete(turnId);
			}
		}
		this._loop.forget(turnIds);
	}

	private async begin(sessionId: string, turnId: string, changedFiles: readonly string[]): Promise<void> {
		const touched = await this.lookup(sessionId, turnId, changedFiles);
		if (this._store.isDisposed) {
			return;
		}
		if (touched.length === 0) {
			if (!this._retried.has(turnId)) {
				this._retried.add(turnId);
				this._settling.delete(turnId);
				const wait = readClaudeDiagnosticsSettleMs(this._configuration.getValue(CLAUDE_DIAGNOSTICS_SETTLE_MS_SETTING));
				const handle = setTimeout(() => {
					this._retryTimers.delete(turnId);
					this.watch();
				}, wait);
				this._retryTimers.set(turnId, handle);
			}
			return;
		}
		this._loop.startSettle(turnId, touched);
	}

	private async lookup(sessionId: string, turnId: string, changedFiles: readonly string[]): Promise<string[]> {
		try {
			const originals = await this._checkpoints.readCheckpointOriginals(sessionId, turnId);
			return touchedUrisFromOriginals(originals, changedFiles);
		} catch {
			return touchedUrisFromOriginals([], changedFiles);
		}
	}

	private readErrors(): DiagnosticSummary[] {
		const markers = this._markers.read({ severities: MarkerSeverity.Error });
		const items: DiagnosticSummary[] = [];
		for (const marker of markers) {
			const item = summaryFromMarker(marker, workspaceRelativePath(marker.resource, this._workspace));
			if (item?.severity === 'error') {
				items.push(item);
			}
		}
		return items;
	}

	private autoVerify(problems: readonly DiagnosticSummary[]): void {
		const session = this._agent.getCurrentSession();
		if (!session) {
			this._loop.cancelAutoArm();
			return;
		}
		const pending = {
			sessionId: session.id,
			known: new Set(this._agent.getViewState(session.id).turns.map(turn => turn.id)),
		};
		this._pendingAuto = pending;
		const releaseIfUnclaimed = () => {
			if (this._pendingAuto !== pending) {
				return;
			}
			this._pendingAuto = undefined;
			this._loop.cancelAutoArm();
		};
		void Promise.resolve(this._actions.run({
			id: 'fixProblems',
			source: 'button',
			attachments: [{ kind: 'diagnostics', items: problems.slice() }],
		})).then(releaseIfUnclaimed, releaseIfUnclaimed);
	}
}

export function summaryFromMarker(marker: IMarker, path: string): DiagnosticSummary | undefined {
	const code = typeof marker.code === 'string' ? marker.code : marker.code?.value;
	return toDiagnosticSummary({
		uri: marker.resource.toString(),
		path,
		severity: marker.severity,
		line: marker.startLineNumber,
		column: marker.startColumn,
		source: marker.source,
		code,
		message: marker.message,
	});
}

export function summariesFromMarkers(markers: readonly IMarker[], workspace: IWorkspaceContextService): DiagnosticSummary[] {
	const items: DiagnosticSummary[] = [];
	for (const marker of markers) {
		const item = summaryFromMarker(marker, workspaceRelativePath(marker.resource, workspace));
		if (item) {
			items.push(item);
		}
	}
	return items;
}

/** Builds the diagnostics loop at startup so a turn is snapshotted before its writes. */
export class ClaudeDiagnosticsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'claude.diagnostics';

	constructor(@IClaudeDiagnosticsService _diagnostics: IClaudeDiagnosticsService) {
		super();
	}
}
