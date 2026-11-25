/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { BackgroundAgentTask, IClaudeWorktreeService } from '../../../../platform/claude/common/claudeBackground.js';
import { applyClaudeComparisonEvent, CLAUDE_COMPARE_MAX_BUDGET_SETTING, claudeComparisonRunsProblem, claudeComparisonTaskId, ClaudeComparisonJudgeRun, ClaudeComparisonView, ClaudeStoredComparison, isClaudeComparisonSettled, readClaudeCompareBudget, readClaudeComparisons, serializeClaudeComparisons } from '../../../../platform/claude/common/claudeComparison.js';
import { ClaudeComparisonEvent, ClaudeComparisonRunSpec, ClaudeComparisonRunState } from '../../../../platform/claude/common/claudeProtocol.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IClaudeAgentService } from './claudeAgentService.js';
import { AgentViewState } from './claudeAgentState.js';
import { IClaudeBackgroundAgentService } from './claudeBackgroundAgent.js';

export const IClaudeComparisonService = createDecorator<IClaudeComparisonService>('claudeComparisonService');

/** Compare Models: asks for a prompt, the runs, the judge and the budget, then starts them. */
export const CLAUDE_COMPARE_MODELS_COMMAND_ID = 'claude.compareModels';

/** Opens the Compare editor of the comparison whose id is the argument. */
export const CLAUDE_OPEN_COMPARISON_COMMAND_ID = 'claude.openComparison';

export interface ClaudeComparisonStartRequest {
	readonly prompt: string;
	/** Two to four distinct model and effort pairs. */
	readonly runs: readonly ClaudeComparisonRunSpec[];
	/** Set to rank the runs once they all end. `modelId` absent: Claude Code's default model. */
	readonly judge?: { readonly modelId?: string };
	/** Spend cap per run in US dollars. Default: `claude.compare.maxBudgetUsd`. */
	readonly maxBudgetUsd?: number;
}

/** Where comparisons are kept: `comparisons.json` beside the sessions (`JsonlSessionStore`). */
export interface ClaudeComparisonStore {
	readComparisons(): Promise<string | undefined>;
	writeComparisons(json: string): Promise<void>;
}

/** What a run cost and how long it took, from its session: Claude Code's reported cost, first prompt to last turn's end. */
export function claudeComparisonRunStats(state: AgentViewState): { readonly costUsd?: number; readonly durationMs?: number } {
	const startedAt = state.turns[0]?.startedAt;
	const endedAt = state.turns[state.turns.length - 1]?.endedAt;
	return {
		costUsd: state.usage?.costUsd,
		durationMs: startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt ? endedAt - startedAt : undefined,
	};
}

/**
 * Compare Models (issue 424): one prompt on several models and efforts, each
 * an ordinary background agent in its own worktree, then an optional judge
 * and Keep, which applies one run and discards the others.
 */
export interface IClaudeComparisonService {
	readonly _serviceBrand: undefined;
	/** Every change to a comparison, as protocol events. */
	readonly onDidEmit: Event<ClaudeComparisonEvent>;
	/** A comparison changed, or the saved ones were read. */
	readonly onDidChangeComparisons: Event<void>;
	getComparisons(): readonly ClaudeComparisonView[];
	/** Every comparison with its dates, newest first, as History lists them. */
	getHistory(): readonly ClaudeStoredComparison[];
	getComparison(comparisonId: string): ClaudeComparisonView | undefined;
	/** True while the judge ranks the runs of a comparison that settled. */
	isJudging(comparisonId: string): boolean;
	/** The background task of a run, while it exists. */
	getRunTask(comparisonId: string, run: number): BackgroundAgentTask | undefined;
	/** Starts every run. A run that cannot start is marked failed; the others go on. */
	start(request: ClaudeComparisonStartRequest): Promise<ClaudeComparisonView>;
	/**
	 * Asks to discard the other runs, applies `run` through the background
	 * agent review and three-way apply, then deletes the others. False when the
	 * user declined or nothing was applied.
	 */
	keep(comparisonId: string, run: number): Promise<boolean>;
	/** Deletes every run's worktree and branch after one confirmation. */
	discard(comparisonId: string): Promise<void>;
	/** Reads the saved comparisons and saves every later change. */
	attachDurableHistory(store: ClaudeComparisonStore): Promise<void>;
}

interface ComparisonRecord {
	view: ClaudeComparisonView;
	readonly createdAt: number;
	updatedAt: number;
	readonly judge?: { readonly modelId?: string };
	judging: boolean;
	judged: boolean;
}

export class ClaudeComparisonService extends Disposable implements IClaudeComparisonService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidEmit = this._register(new Emitter<ClaudeComparisonEvent>());
	readonly onDidEmit = this._onDidEmit.event;

	private readonly _onDidChangeComparisons = this._register(new Emitter<void>());
	readonly onDidChangeComparisons = this._onDidChangeComparisons.event;

	private readonly _comparisons = new Map<string, ComparisonRecord>();
	private _historyStore: ClaudeComparisonStore | undefined;

	constructor(
		@IClaudeBackgroundAgentService private readonly _background: IClaudeBackgroundAgentService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeWorktreeService private readonly _git: IClaudeWorktreeService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IDialogService private readonly _dialog: IDialogService,
	) {
		super();
		this._register(this._background.onDidChangeTasks(() => this.syncFromTasks()));
	}

	getComparisons(): readonly ClaudeComparisonView[] {
		return [...this._comparisons.values()].map(record => record.view);
	}

	getHistory(): readonly ClaudeStoredComparison[] {
		return [...this._comparisons.values()]
			.map(record => ({ view: record.view, createdAt: record.createdAt, updatedAt: record.updatedAt }))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async attachDurableHistory(store: ClaudeComparisonStore): Promise<void> {
		this._historyStore = store;
		const saved = readClaudeComparisons(await store.readComparisons(), localize('claudeCompareInterrupted', "Klawly closed before this run ended."));
		for (const stored of saved) {
			// A comparison started before the file was read is newer than its saved copy.
			if (!this._comparisons.has(stored.view.id)) {
				this._comparisons.set(stored.view.id, { ...stored, judging: false, judged: true });
			}
		}
		this._onDidChangeComparisons.fire();
	}

	getComparison(comparisonId: string): ClaudeComparisonView | undefined {
		return this._comparisons.get(comparisonId)?.view;
	}

	isJudging(comparisonId: string): boolean {
		return this._comparisons.get(comparisonId)?.judging ?? false;
	}

	getRunTask(comparisonId: string, run: number): BackgroundAgentTask | undefined {
		const taskId = claudeComparisonTaskId(comparisonId, run);
		return this._background.getTasks().find(task => task.id === taskId);
	}

	async start(request: ClaudeComparisonStartRequest): Promise<ClaudeComparisonView> {
		const prompt = request.prompt.trim();
		if (!prompt) {
			throw new Error(localize('claudeCompareEmpty', "Write what each model should do."));
		}
		const problem = claudeComparisonRunsProblem(request.runs);
		if (problem === 'count') {
			throw new Error(localize('claudeCompareCount', "Pick 2 to 4 models to compare."));
		}
		if (problem === 'duplicate') {
			throw new Error(localize('claudeCompareDuplicate', "Each run needs a different model or effort."));
		}
		const comparisonId = generateUuid().slice(0, 8);
		const maxBudgetUsd = readClaudeCompareBudget(request.maxBudgetUsd ?? this._configuration.getValue(CLAUDE_COMPARE_MAX_BUDGET_SETTING));
		const started: ClaudeComparisonEvent = { type: 'comparison.started', comparisonId, prompt, runs: request.runs.slice() };
		const now = Date.now();
		const record: ComparisonRecord = { view: applyClaudeComparisonEvent(undefined, started)!, createdAt: now, updatedAt: now, judge: request.judge, judging: false, judged: false };
		this._comparisons.set(comparisonId, record);
		this._onDidEmit.fire(started);
		this.changed();
		// One at a time: each start adds a Git worktree to the same repository.
		for (const [index, spec] of request.runs.entries()) {
			const run = index + 1;
			try {
				const task = await this._background.start(prompt, {
					taskId: claudeComparisonTaskId(comparisonId, run),
					title: localize('claudeCompareRunTitle', "{0}: {1}", spec.label, prompt),
					modelId: spec.modelId,
					effort: spec.effort,
					maxBudgetUsd,
					select: false,
				});
				this.updateRun(record, run, task);
			} catch (error) {
				this.emit(record, { type: 'comparison.runUpdated', comparisonId, run, state: 'failed', message: errorMessage(error) });
			}
		}
		this.maybeJudge(record);
		return record.view;
	}

	async keep(comparisonId: string, run: number): Promise<boolean> {
		const record = this._comparisons.get(comparisonId);
		const kept = record?.view.runs.find(candidate => candidate.run === run);
		if (!record || !kept) {
			return false;
		}
		const others = record.view.runs.filter(candidate => candidate.run !== run && this.getRunTask(comparisonId, candidate.run));
		if (others.length) {
			const choice = await this._dialog.confirm({
				message: localize('claudeCompareKeepConfirm', "Keep {0} and discard the other runs?", kept.label),
				detail: localize('claudeCompareKeepDetail', "Its changes open for review before they are applied. The other runs' worktrees and branches are deleted once they are."),
				primaryButton: localize('claudeCompareKeepButton', "Keep"),
			});
			if (!choice.confirmed) {
				return false;
			}
		}
		const result = await this._background.apply(claudeComparisonTaskId(comparisonId, run));
		if (!result.applied) {
			return false;
		}
		this.emit(record, { type: 'comparison.runUpdated', comparisonId, run, state: 'kept' });
		await this.deleteRuns(record, others.map(other => other.run));
		return true;
	}

	async discard(comparisonId: string): Promise<void> {
		const record = this._comparisons.get(comparisonId);
		if (!record) {
			return;
		}
		const runs = record.view.runs.filter(run => this.getRunTask(comparisonId, run.run)).map(run => run.run);
		if (runs.length) {
			const choice = await this._dialog.confirm({
				message: localize('claudeCompareDiscardConfirm', "Discard every run of this comparison?"),
				detail: localize('claudeCompareDiscardDetail', "Their worktrees, branches and unapplied changes are deleted."),
				primaryButton: localize('claudeCompareDiscardButton', "Discard"),
			});
			if (!choice.confirmed) {
				return;
			}
		}
		await this.deleteRuns(record, runs);
	}

	private async deleteRuns(record: ComparisonRecord, runs: readonly number[]): Promise<void> {
		for (const run of runs) {
			try {
				await this._background.delete(claudeComparisonTaskId(record.view.id, run), { confirmed: true });
				this.emit(record, { type: 'comparison.runUpdated', comparisonId: record.view.id, run, state: 'discarded' });
			} catch (error) {
				this.emit(record, { type: 'comparison.runUpdated', comparisonId: record.view.id, run, state: 'failed', message: errorMessage(error) });
			}
		}
	}

	private syncFromTasks(): void {
		for (const record of this._comparisons.values()) {
			for (const run of record.view.runs) {
				if (run.state === 'kept' || run.state === 'discarded') {
					continue;
				}
				const task = this.getRunTask(record.view.id, run.run);
				if (task) {
					this.updateRun(record, run.run, task);
				}
			}
			this.maybeJudge(record);
		}
	}

	private updateRun(record: ComparisonRecord, run: number, task: BackgroundAgentTask): void {
		const current = record.view.runs.find(candidate => candidate.run === run);
		const state: ClaudeComparisonRunState = task.status;
		const diffStat = { filesChanged: task.filesChanged, added: task.added, removed: task.removed };
		const message = state === 'failed' ? this.failureMessage(task) : undefined;
		const { costUsd, durationMs } = claudeComparisonRunStats(this._agent.getViewState(task.sessionId));
		if (current && current.state === state && current.sessionId === task.sessionId && current.message === message && current.costUsd === costUsd && current.durationMs === durationMs
			&& current.diffStat?.filesChanged === diffStat.filesChanged && current.diffStat.added === diffStat.added && current.diffStat.removed === diffStat.removed) {
			return;
		}
		this.emit(record, { type: 'comparison.runUpdated', comparisonId: record.view.id, run, state, sessionId: task.sessionId, diffStat, message, costUsd, durationMs });
	}

	/** Why a run's session failed: the last turn's failure, such as the budget stop, else Stopped. */
	private failureMessage(task: BackgroundAgentTask): string {
		const turns = this._agent.getViewState(task.sessionId).turns;
		const failure = turns[turns.length - 1]?.failure?.message;
		return failure ?? (task.stopped ? localize('claudeCompareStopped', "Stopped.") : localize('claudeCompareFailed', "The run failed."));
	}

	private maybeJudge(record: ComparisonRecord): void {
		if (!record.judge || record.judging || record.judged || !isClaudeComparisonSettled(record.view)) {
			return;
		}
		record.judging = true;
		this._onDidChangeComparisons.fire();
		void this.judge(record).finally(() => {
			record.judging = false;
			record.judged = true;
			this._onDidChangeComparisons.fire();
		});
	}

	private async judge(record: ComparisonRecord): Promise<void> {
		const comparisonId = record.view.id;
		if (!this._runtime.judgeComparison) {
			this.emit(record, { type: 'comparison.judgeFailed', comparisonId, message: localize('claudeCompareNoJudge', "This Claude runtime cannot judge a comparison.") });
			return;
		}
		const runs: ClaudeComparisonJudgeRun[] = [];
		let cwd: string | undefined;
		for (const run of record.view.runs) {
			const task = this.getRunTask(comparisonId, run.run);
			let diff = '';
			let finalMessage: string | undefined;
			if (task) {
				cwd ??= task.repoRoot;
				try {
					diff = await this._git.diff(task.worktreePath, task.baseRef);
				} catch {
					// A worktree that is gone has no diff to judge.
				}
				const turns = this._agent.getViewState(task.sessionId).turns;
				finalMessage = turns[turns.length - 1]?.assistantText.trim() || undefined;
			}
			runs.push({ run: run.run, label: run.label, diff, finalMessage, failure: run.state === 'failed' ? run.message : undefined });
		}
		if (!cwd) {
			this.emit(record, { type: 'comparison.judgeFailed', comparisonId, message: localize('claudeCompareNothingToJudge', "No run started, so there is nothing to judge.") });
			return;
		}
		const result = await this._runtime.judgeComparison({ id: generateUuid(), prompt: record.view.prompt, cwd, modelId: record.judge?.modelId, runs });
		if (result.ok) {
			this.emit(record, { type: 'comparison.judged', comparisonId, ranking: result.verdict.ranking, summary: result.verdict.summary });
		} else {
			this.emit(record, { type: 'comparison.judgeFailed', comparisonId, message: result.message });
		}
	}

	private emit(record: ComparisonRecord, event: ClaudeComparisonEvent): void {
		const next = applyClaudeComparisonEvent(record.view, event);
		if (next) {
			record.view = next;
		}
		record.updatedAt = Date.now();
		this._onDidEmit.fire(event);
		this.changed();
	}

	private changed(): void {
		this._onDidChangeComparisons.fire();
		void this._historyStore?.writeComparisons(serializeClaudeComparisons(this.getHistory())).catch(() => undefined);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
