/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { DiagnosticSummary } from '../../../../platform/claude/common/claudePrompt.js';
import { redactSecrets } from './claudeAgentLog.js';
import { isReviewBaseline } from './claudeReview.js';

export const IClaudeDiagnosticsService = createDecorator<IClaudeDiagnosticsService>('claudeDiagnosticsService');

/** How many new problems one Fix Problems send includes. */
export const DIAGNOSTIC_SEND_LIMIT = 50;

export interface IClaudeDiagnosticsService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeProblems: Event<void>;
	/** New errors collected for a finished code-changing turn. Undefined until collection finishes. */
	getProblems(turnId: string): readonly DiagnosticSummary[] | undefined;
}

export interface DiagnosticMarkerInput {
	readonly uri: string;
	readonly path?: string;
	readonly severity: number;
	readonly line: number;
	readonly column: number;
	readonly source?: string;
	readonly code?: string;
	readonly message: string;
}

export interface VerifyBudget {
	readonly enabled: boolean;
	readonly maxCycles: number;
	readonly used: number;
}

export interface SettleInput {
	readonly now: number;
	readonly turnEndedAt: number;
	readonly lastMarkerAt: number | undefined;
	readonly settleMs: number;
	readonly maxWaitMs: number;
}

export interface SettlePlan {
	readonly waitMs: number;
	readonly ready: boolean;
}

export interface DiagnosticsClock {
	now(): number;
	schedule(delayMs: number, run: () => void): { dispose(): void };
}

export interface DiagnosticsLoopOptions {
	readonly settleMs: number;
	readonly maxWaitMs: number;
	readonly autoVerify: boolean;
	readonly maxCycles: number;
}

/**
 * Files the Phase 12 collector recorded as writes, plus any uri the turn
 * reducer already listed. Dirty buffers that were only unsaved are not edits.
 */
export function touchedUrisFromOriginals(
	files: readonly { readonly uri: string; readonly capturedAs?: 'buffer' | 'write'; readonly afterHash?: string | null }[],
	changedFiles: readonly string[],
): string[] {
	const uris: string[] = [];
	const add = (uri: string) => {
		if (!uris.some(existing => sameDiagnosticUri(existing, uri))) {
			uris.push(uri);
		}
	};
	for (const file of files) {
		if (isReviewBaseline(file)) {
			add(file.uri);
		}
	}
	for (const uri of changedFiles) {
		add(uri);
	}
	return uris;
}

export function sameDiagnosticUri(left: string, right: string): boolean {
	try {
		return extUriBiasedIgnorePathCase.isEqual(URI.parse(left), URI.parse(right));
	} catch {
		return left === right;
	}
}

export function severityLabel(severity: number): 'error' | 'warning' | 'info' | undefined {
	if (severity === MarkerSeverity.Error) {
		return 'error';
	}
	if (severity === MarkerSeverity.Warning) {
		return 'warning';
	}
	if (severity === MarkerSeverity.Info) {
		return 'info';
	}
	return undefined;
}

export function toDiagnosticSummary(input: DiagnosticMarkerInput): DiagnosticSummary | undefined {
	const severity = severityLabel(input.severity);
	if (!severity) {
		return undefined;
	}
	return {
		uri: input.uri,
		path: input.path,
		severity,
		line: input.line,
		column: input.column,
		source: input.source,
		code: input.code,
		message: input.message,
	};
}

export function diagnosticIdentity(item: DiagnosticSummary): string {
	return [
		item.uri ?? item.path ?? '',
		item.severity,
		item.line ?? '',
		item.column ?? '',
		item.source ?? '',
		item.code ?? '',
		item.message,
	].join('\0');
}

/**
 * Errors that were not present before the turn, limited to files that turn
 * wrote. Warnings and errors in other files stay out of the send.
 */
export function newErrorDiagnostics(
	before: readonly DiagnosticSummary[],
	after: readonly DiagnosticSummary[],
	touchedUris: readonly string[],
): DiagnosticSummary[] {
	const seen = new Set(before.filter(item => item.severity === 'error' && uriTouched(item, touchedUris)).map(diagnosticIdentity));
	const added = new Set<string>();
	const result: DiagnosticSummary[] = [];
	for (const item of after) {
		if (item.severity !== 'error' || !uriTouched(item, touchedUris)) {
			continue;
		}
		const key = diagnosticIdentity(item);
		if (seen.has(key) || added.has(key)) {
			continue;
		}
		added.add(key);
		result.push(item);
	}
	result.sort((left, right) => (left.uri ?? '').localeCompare(right.uri ?? '') || (left.line ?? 0) - (right.line ?? 0) || (left.column ?? 0) - (right.column ?? 0));
	return result.slice(0, DIAGNOSTIC_SEND_LIMIT);
}

function uriTouched(item: DiagnosticSummary, touchedUris: readonly string[]): boolean {
	const uri = item.uri;
	if (!uri) {
		return false;
	}
	return touchedUris.some(touched => sameDiagnosticUri(touched, uri));
}

export function canAutoVerify(budget: VerifyBudget, problemCount: number): boolean {
	return budget.enabled && problemCount > 0 && budget.used < budget.maxCycles;
}

/** Quiet period after the last marker change, unless the max wait has elapsed. */
export function planSettle(input: SettleInput): SettlePlan {
	const quietSince = input.lastMarkerAt ?? input.turnEndedAt;
	const quietFor = input.now - quietSince;
	const elapsed = input.now - input.turnEndedAt;
	if (elapsed >= input.maxWaitMs || quietFor >= input.settleMs) {
		return { waitMs: 0, ready: true };
	}
	const untilQuiet = input.settleMs - quietFor;
	const untilMax = input.maxWaitMs - elapsed;
	return { waitMs: Math.max(0, Math.min(untilQuiet, untilMax)), ready: false };
}

/** Text of a failed command card, sent as the terminal chip for Fix this error. */
export function commandFailureText(input: {
	readonly command?: string;
	readonly cwd?: string;
	readonly exitCode?: number;
	readonly lines: readonly string[];
	readonly error?: string;
}): string {
	const parts: string[] = [];
	if (input.command) {
		parts.push(`$ ${input.command}`);
	}
	if (input.cwd) {
		parts.push(`cwd: ${input.cwd}`);
	}
	if (input.exitCode !== undefined) {
		parts.push(`exit code: ${input.exitCode}`);
	}
	if (input.lines.length > 0) {
		parts.push(input.lines.join('\n'));
	}
	if (input.error) {
		parts.push(input.error);
	}
	return redactSecrets(parts.join('\n'));
}

/**
 * Which diagnostics a Fix Problems gesture sends, capped at
 * {@link DIAGNOSTIC_SEND_LIMIT}. `activeEditor` set (even empty) wins over
 * every marker; an empty selection falls through.
 */
export function chooseFixProblems(input: {
	readonly provided?: readonly DiagnosticSummary[];
	readonly selected?: readonly DiagnosticSummary[];
	readonly activeEditor?: readonly DiagnosticSummary[];
	readonly allMarkers: readonly DiagnosticSummary[];
}): { items: DiagnosticSummary[]; truncated: boolean; total: number } {
	let chosen: readonly DiagnosticSummary[];
	if (input.provided && input.provided.length > 0) {
		chosen = input.provided;
	} else if (input.selected && input.selected.length > 0) {
		chosen = input.selected;
	} else if (input.activeEditor) {
		chosen = input.activeEditor;
	} else {
		chosen = input.allMarkers;
	}
	const total = chosen.length;
	if (total <= DIAGNOSTIC_SEND_LIMIT) {
		return { items: chosen.slice(), truncated: false, total };
	}
	return { items: chosen.slice(0, DIAGNOSTIC_SEND_LIMIT), truncated: true, total };
}

export function isDiagnosticSummaryList(value: unknown): value is DiagnosticSummary[] {
	return Array.isArray(value) && value.every(item => !!item && typeof item === 'object' && typeof (item as DiagnosticSummary).message === 'string' && typeof (item as DiagnosticSummary).severity === 'string');
}

interface PendingSettle {
	touched: readonly string[];
	endedAt: number;
	lastMarkerAt?: number;
	timer?: { dispose(): void };
}

/**
 * After a code-changing turn, wait until markers settle, then report errors
 * that were not in the snapshot taken when the user turn started. Auto-verify
 * reuses that snapshot so an error that survives a fix still counts, and it
 * stops at `maxCycles`.
 */
export class DiagnosticsLoop {
	private readonly _baselines = new Map<string, readonly DiagnosticSummary[]>();
	private readonly _pending = new Map<string, PendingSettle>();
	private readonly _results = new Map<string, readonly DiagnosticSummary[]>();
	private readonly _autoTurns = new Set<string>();
	private _chainBaseline: readonly DiagnosticSummary[] | undefined;
	private _used = 0;
	/** Set when a verify send is about to start. Cleared on the next noteRunning or session change. */
	private _armAuto = false;
	/** Turn the verify action started. Any other turn is a user turn. */
	private _armedTurnId: string | undefined;

	constructor(
		private readonly _clock: DiagnosticsClock,
		private readonly _read: () => readonly DiagnosticSummary[],
		private readonly _options: () => DiagnosticsLoopOptions,
		private readonly _onProblems: (turnId: string, problems: readonly DiagnosticSummary[]) => void,
		private readonly _onAutoVerify: (problems: readonly DiagnosticSummary[]) => void,
	) { }

	/**
	 * The verify action started `turnId`. Call before that turn's
	 * {@link noteRunning}. A different turn keeps a fresh baseline.
	 */
	claimAutoTurn(turnId: string): void {
		if (this._armAuto && this._armedTurnId === undefined) {
			this._armedTurnId = turnId;
		}
	}

	/** Call when a turn starts, before its writes land. */
	noteRunning(turnId: string): void {
		if (this._baselines.has(turnId)) {
			return;
		}
		const auto = this._armAuto && this._armedTurnId === turnId;
		if (this._armAuto) {
			this._armAuto = false;
			this._armedTurnId = undefined;
		}
		if (auto) {
			this._autoTurns.add(turnId);
			this._baselines.set(turnId, this._chainBaseline ?? this._read());
			return;
		}
		this._chainBaseline = this._read().slice();
		this._baselines.set(turnId, this._chainBaseline);
		this._used = 0;
	}

	/** Start the settle wait for one finished turn that wrote `touched` files. */
	startSettle(turnId: string, touched: readonly string[]): void {
		if (touched.length === 0 || this._results.has(turnId) || this._pending.has(turnId)) {
			return;
		}
		if (!this._baselines.has(turnId)) {
			this.noteRunning(turnId);
		}
		if (!this._autoTurns.has(turnId)) {
			this._used = 0;
		}
		this._pending.set(turnId, { touched: touched.slice(), endedAt: this._clock.now() });
		this.schedule(turnId);
	}

	markersChanged(): void {
		const now = this._clock.now();
		for (const pending of this._pending.values()) {
			pending.lastMarkerAt = now;
		}
		for (const turnId of this._pending.keys()) {
			this.schedule(turnId);
		}
	}

	get(turnId: string): readonly DiagnosticSummary[] | undefined {
		return this._results.get(turnId);
	}

	hasResult(turnId: string): boolean {
		return this._results.has(turnId);
	}

	/** The next turn was not started, or the session changed. Do not treat a later user turn as auto-verify. */
	cancelAutoArm(): void {
		this._armAuto = false;
		this._armedTurnId = undefined;
	}

	/** Drop per-turn snapshots when a session is disposed or removed. */
	forget(turnIds: readonly string[]): void {
		for (const turnId of turnIds) {
			this._baselines.delete(turnId);
			this._results.delete(turnId);
			this._autoTurns.delete(turnId);
			const pending = this._pending.get(turnId);
			pending?.timer?.dispose();
			this._pending.delete(turnId);
			if (this._armedTurnId === turnId) {
				this.cancelAutoArm();
			}
		}
	}

	dispose(): void {
		for (const pending of this._pending.values()) {
			pending.timer?.dispose();
		}
		this._pending.clear();
	}

	private schedule(turnId: string): void {
		const pending = this._pending.get(turnId);
		if (!pending) {
			return;
		}
		pending.timer?.dispose();
		const options = this._options();
		const plan = planSettle({
			now: this._clock.now(),
			turnEndedAt: pending.endedAt,
			lastMarkerAt: pending.lastMarkerAt,
			settleMs: options.settleMs,
			maxWaitMs: options.maxWaitMs,
		});
		if (plan.ready) {
			this.finish(turnId);
			return;
		}
		pending.timer = this._clock.schedule(plan.waitMs, () => this.finish(turnId));
	}

	private finish(turnId: string): void {
		const pending = this._pending.get(turnId);
		if (!pending) {
			return;
		}
		const options = this._options();
		const plan = planSettle({
			now: this._clock.now(),
			turnEndedAt: pending.endedAt,
			lastMarkerAt: pending.lastMarkerAt,
			settleMs: options.settleMs,
			maxWaitMs: options.maxWaitMs,
		});
		if (!plan.ready) {
			this.schedule(turnId);
			return;
		}
		pending.timer?.dispose();
		this._pending.delete(turnId);
		const before = this._baselines.get(turnId) ?? [];
		const problems = newErrorDiagnostics(before, this._read(), pending.touched);
		this._results.set(turnId, problems);
		this._onProblems(turnId, problems);
		if (canAutoVerify({ enabled: options.autoVerify, maxCycles: options.maxCycles, used: this._used }, problems.length)) {
			this._used++;
			this._armAuto = true;
			this._armedTurnId = undefined;
			this._onAutoVerify(problems);
		}
	}
}
