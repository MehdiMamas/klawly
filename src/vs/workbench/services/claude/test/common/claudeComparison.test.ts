/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { BackgroundAgentStatus, BackgroundAgentTask, BackgroundApplyResult, ClaudeBackgroundRunOptions, IClaudeWorktreeService } from '../../../../../platform/claude/common/claudeBackground.js';
import { CLAUDE_COMPARE_MAX_BUDGET_SETTING, ClaudeComparisonJudgeRequest, ClaudeComparisonJudgeResult } from '../../../../../platform/claude/common/claudeComparison.js';
import { ClaudeComparisonEvent } from '../../../../../platform/claude/common/claudeProtocol.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IClaudeAgentService } from '../../common/claudeAgentService.js';
import { AgentViewState, EMPTY_AGENT_VIEW_STATE, TurnViewModel } from '../../common/claudeAgentState.js';
import { IClaudeBackgroundAgentService } from '../../common/claudeBackgroundAgent.js';
import { ClaudeComparisonService, ClaudeComparisonStore } from '../../common/claudeComparison.js';

class FakeBackground implements IClaudeBackgroundAgentService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidChangeTasks = new Emitter<void>();
	readonly onDidChangeTasks = this._onDidChangeTasks.event;
	readonly started: { prompt: string; options?: ClaudeBackgroundRunOptions }[] = [];
	readonly ops: string[] = [];
	private readonly _tasks: BackgroundAgentTask[] = [];

	getTasks(): readonly BackgroundAgentTask[] {
		return this._tasks;
	}
	maxParallelSessions(): number {
		return 4;
	}
	canStart(): boolean {
		return true;
	}
	async start(prompt: string, options?: ClaudeBackgroundRunOptions): Promise<BackgroundAgentTask> {
		this.started.push({ prompt, options });
		if (options?.modelId === 'broken') {
			throw new Error('no worktree');
		}
		const id = options?.taskId ?? 'task';
		const task: BackgroundAgentTask = {
			id,
			sessionId: `session-${id}`,
			repoRoot: '/repo',
			baseRef: 'base',
			worktreePath: `/worktrees/${id}`,
			branchName: `agent/${id}`,
			status: 'running',
			title: options?.title ?? prompt,
			filesChanged: 0,
			added: 0,
			removed: 0,
			testStatus: 'tests not run',
			conflicts: [],
			stopped: false,
		};
		this._tasks.push(task);
		this._onDidChangeTasks.fire();
		return task;
	}
	finish(id: string, status: BackgroundAgentStatus, filesChanged: number): void {
		const task = this._tasks.find(candidate => candidate.id === id)!;
		task.status = status;
		task.filesChanged = filesChanged;
		task.added = filesChanged * 10;
		this._onDidChangeTasks.fire();
	}
	async stop(): Promise<void> { }
	async cleanUp() { return { removed: 0, kept: 0 }; }

	async delete(taskId: string, options?: { readonly confirmed?: boolean }): Promise<void> {
		this.ops.push(`delete ${taskId} confirmed=${options?.confirmed}`);
		this._tasks.splice(this._tasks.findIndex(task => task.id === taskId), 1);
	}
	async review(): Promise<void> { }
	async apply(taskId: string): Promise<BackgroundApplyResult> {
		this.ops.push(`apply ${taskId}`);
		return { applied: true, conflicts: [] };
	}
	async openConflicts(): Promise<void> { }
	dispose(): void {
		this._onDidChangeTasks.dispose();
	}
}

function turnState(partial: Partial<TurnViewModel>): AgentViewState {
	return { ...EMPTY_AGENT_VIEW_STATE, turns: [{ assistantText: '', ...partial } as TurnViewModel] };
}

suite('Claude Compare Models', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(options?: { confirmed?: boolean }) {
		const background = new FakeBackground();
		store.add({ dispose: () => background.dispose() });
		const views = new Map<string, AgentViewState>();
		const judged: ClaudeComparisonJudgeRequest[] = [];
		const confirms: string[] = [];
		const agent = { getViewState: (sessionId: string) => views.get(sessionId) ?? EMPTY_AGENT_VIEW_STATE } as unknown as IClaudeAgentService;
		const git = { diff: async (worktreePath: string, baseRef: string) => `diff ${worktreePath} ${baseRef}` } as unknown as IClaudeWorktreeService;
		const runtime = {
			judgeComparison: async (request: ClaudeComparisonJudgeRequest): Promise<ClaudeComparisonJudgeResult> => {
				judged.push(request);
				return { ok: true, verdict: { ranking: [{ run: 2, score: 8, reasons: 'Smallest fix.' }, { run: 1, score: 6, reasons: 'Works.' }, { run: 3, score: 1, reasons: 'Stopped.' }], summary: 'Run 2 wins.' } };
			},
		} as unknown as IClaudeRuntimeService;
		const configuration = { getValue: (key: string) => key === CLAUDE_COMPARE_MAX_BUDGET_SETTING ? 2.5 : undefined } as unknown as IConfigurationService;
		const dialog = {
			confirm: async (confirmation: { message: string }) => {
				confirms.push(confirmation.message);
				return { confirmed: options?.confirmed ?? true };
			},
		} as unknown as IDialogService;
		const service = store.add(new ClaudeComparisonService(background, agent, git, runtime, configuration, dialog));
		const events: ClaudeComparisonEvent[] = [];
		store.add(service.onDidEmit(event => events.push(event)));
		return { service, background, views, judged, confirms, events };
	}

	test('N runs with distinct models and budgets; a budget stop is a failed run and the judge reads every diff', async () => {
		const { service, background, views, judged } = create();
		const view = await service.start({
			prompt: ' Fix the parser ',
			runs: [
				{ modelId: 'opus', effort: 'high', label: 'Opus, High' },
				{ modelId: 'sonnet', effort: 'medium', label: 'Sonnet, Medium' },
				{ modelId: 'haiku', label: 'Haiku' },
			],
			judge: { modelId: 'opus' },
		});
		const id = view.id;
		views.set(`session-compare-${id}-1`, { ...turnState({ assistantText: 'Fixed it.', startedAt: 1000, endedAt: 10000 }), usage: { costUsd: 0.31 } });
		views.set(`session-compare-${id}-3`, turnState({ failure: { message: 'Claude Code stopped this run at its spending limit.' } }));
		const done = Event.toPromise(Event.filter(service.onDidEmit, event => event.type === 'comparison.judged'));
		background.finish(`compare-${id}-1`, 'complete', 2);
		background.finish(`compare-${id}-2`, 'complete', 1);
		background.finish(`compare-${id}-3`, 'failed', 0);
		await done;
		assert.deepStrictEqual({
			started: background.started.map(start => start.options),
			judge: judged.map(request => ({ prompt: request.prompt, cwd: request.cwd, modelId: request.modelId, runs: request.runs })),
			view: service.getComparison(id),
		}, {
			started: [1, 2, 3].map(run => ({
				taskId: `compare-${id}-${run}`,
				title: `${['Opus, High', 'Sonnet, Medium', 'Haiku'][run - 1]}: Fix the parser`,
				modelId: ['opus', 'sonnet', 'haiku'][run - 1],
				effort: ['high', 'medium', undefined][run - 1],
				maxBudgetUsd: 2.5,
				select: false,
			})),
			judge: [{
				prompt: 'Fix the parser',
				cwd: '/repo',
				modelId: 'opus',
				runs: [
					{ run: 1, label: 'Opus, High', diff: `diff /worktrees/compare-${id}-1 base`, finalMessage: 'Fixed it.', failure: undefined },
					{ run: 2, label: 'Sonnet, Medium', diff: `diff /worktrees/compare-${id}-2 base`, finalMessage: undefined, failure: undefined },
					{ run: 3, label: 'Haiku', diff: `diff /worktrees/compare-${id}-3 base`, finalMessage: undefined, failure: 'Claude Code stopped this run at its spending limit.' },
				],
			}],
			view: {
				id,
				prompt: 'Fix the parser',
				runs: [
					{ modelId: 'opus', effort: 'high', label: 'Opus, High', run: 1, state: 'complete', sessionId: `session-compare-${id}-1`, diffStat: { filesChanged: 2, added: 20, removed: 0 }, message: undefined, costUsd: 0.31, durationMs: 9000 },
					{ modelId: 'sonnet', effort: 'medium', label: 'Sonnet, Medium', run: 2, state: 'complete', sessionId: `session-compare-${id}-2`, diffStat: { filesChanged: 1, added: 10, removed: 0 }, message: undefined, costUsd: undefined, durationMs: undefined },
					{ modelId: 'haiku', label: 'Haiku', run: 3, state: 'failed', sessionId: `session-compare-${id}-3`, diffStat: { filesChanged: 0, added: 0, removed: 0 }, message: 'Claude Code stopped this run at its spending limit.', costUsd: undefined, durationMs: undefined },
				],
				verdict: { ranking: [{ run: 2, score: 8, reasons: 'Smallest fix.' }, { run: 1, score: 6, reasons: 'Works.' }, { run: 3, score: 1, reasons: 'Stopped.' }], summary: 'Run 2 wins.' },
				judgeError: undefined,
			},
		});
	});

	test('a run that cannot start fails alone; Keep applies one run and deletes the others', async () => {
		const { service, background, judged, confirms } = create();
		const view = await service.start({
			prompt: 'Rename the flag',
			runs: [
				{ modelId: 'opus', label: 'Opus' },
				{ modelId: 'broken', label: 'Broken' },
				{ modelId: 'sonnet', label: 'Sonnet' },
			],
			maxBudgetUsd: 1,
		});
		const id = view.id;
		background.finish(`compare-${id}-1`, 'complete', 1);
		background.finish(`compare-${id}-3`, 'complete', 1);
		const kept = await service.keep(id, 3);
		assert.deepStrictEqual({
			kept,
			budgets: background.started.map(start => start.options?.maxBudgetUsd),
			ops: background.ops,
			confirms,
			judged: judged.length,
			states: service.getComparison(id)?.runs.map(run => [run.state, run.message]),
		}, {
			kept: true,
			budgets: [1, 1, 1],
			ops: [`apply compare-${id}-3`, `delete compare-${id}-1 confirmed=true`],
			confirms: ['Keep Sonnet and discard the other runs?'],
			judged: 0,
			states: [['discarded', undefined], ['failed', 'no worktree'], ['kept', undefined]],
		});
	});

	test('a declined Keep changes nothing; bad run lists are refused', async () => {
		const { service, background } = create({ confirmed: false });
		const view = await service.start({ prompt: 'Go', runs: [{ modelId: 'opus', label: 'Opus' }, { modelId: 'sonnet', label: 'Sonnet' }] });
		assert.strictEqual(await service.keep(view.id, 1), false);
		assert.deepStrictEqual(background.ops, []);
		await assert.rejects(() => service.start({ prompt: 'Go', runs: [{ modelId: 'opus', label: 'Opus' }] }), /2 to 4/);
		await assert.rejects(() => service.start({ prompt: 'Go', runs: [{ modelId: 'opus', label: 'A' }, { modelId: 'opus', label: 'B' }] }), /different model or effort/);
	});

	test('comparisons are saved as they change and read back after a reload, a cut-off run as failed', async () => {
		const first = create();
		const written: string[] = [];
		const store: ClaudeComparisonStore = { readComparisons: async () => undefined, writeComparisons: async json => { written.push(json); } };
		await first.service.attachDurableHistory(store);
		const view = await first.service.start({ prompt: 'Go', runs: [{ modelId: 'opus', label: 'Opus' }, { modelId: 'sonnet', label: 'Sonnet' }] });
		first.background.finish(`compare-${view.id}-1`, 'complete', 1);

		const second = create();
		await second.service.attachDurableHistory({ readComparisons: async () => written[written.length - 1], writeComparisons: async () => { } });
		assert.deepStrictEqual(second.service.getHistory().map(stored => ({ id: stored.view.id, runs: stored.view.runs.map(run => [run.state, run.message]) })), [{
			id: view.id,
			runs: [['complete', undefined], ['failed', 'Klawly closed before this run ended.']],
		}]);
	});
});
