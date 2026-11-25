/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyClaudeComparisonEvent, ClaudeComparisonView } from '../../../../../platform/claude/common/claudeComparison.js';
import { ClaudeComparisonEvent } from '../../../../../platform/claude/common/claudeProtocol.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudeBackgroundAgentService } from '../../../../services/claude/common/claudeBackgroundAgent.js';
import { IClaudeComparisonService } from '../../../../services/claude/common/claudeComparison.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { TestEditorGroupView, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { CLAUDE_AGENT_VIEW_ID } from '../../../claude/common/claudeViews.js';
import { ClaudeComparisonEditor, ClaudeComparisonInput } from '../../browser/claudeComparisonEditor.js';

suite('Claude Compare editor', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiation: TestInstantiationService;
	let calls: string[];
	let view: ClaudeComparisonView | undefined;
	let openSessions: string[];
	let judging: boolean;
	let onDidChangeComparisons: Emitter<void>;

	setup(() => {
		instantiation = workbenchInstantiationService(undefined, store);
		calls = [];
		openSessions = ['s1'];
		judging = false;
		onDidChangeComparisons = store.add(new Emitter<void>());
		const events: ClaudeComparisonEvent[] = [
			{ type: 'comparison.started', comparisonId: 'c1', prompt: 'Add TodoList.remove', runs: [{ modelId: 'opus', effort: 'high', label: 'Opus 5.5, High' }, { modelId: 'sonnet', label: 'Sonnet 5.5' }, { modelId: 'haiku', label: 'Haiku 5.5' }] },
			{ type: 'comparison.runUpdated', comparisonId: 'c1', run: 1, state: 'complete', sessionId: 's1', diffStat: { filesChanged: 2, added: 14, removed: 3 }, costUsd: 0.31, durationMs: 65000 },
			{ type: 'comparison.runUpdated', comparisonId: 'c1', run: 2, state: 'complete', sessionId: 's2', diffStat: { filesChanged: 1, added: 9, removed: 1 }, costUsd: 0.08, durationMs: 21000 },
			{ type: 'comparison.runUpdated', comparisonId: 'c1', run: 3, state: 'failed', sessionId: 's3', message: 'Out of budget.' },
			{ type: 'comparison.judged', comparisonId: 'c1', ranking: [{ run: 2, score: 8, reasons: 'Smallest diff with a test.' }, { run: 1, score: 6, reasons: 'Also renames a helper.' }, { run: 3, score: 1, reasons: 'Did not finish.' }], summary: 'Sonnet wins on scope.' },
		];
		view = events.reduce<ClaudeComparisonView | undefined>((current, event) => applyClaudeComparisonEvent(current, event), undefined);
		instantiation.stub(IClaudeComparisonService, {
			onDidChangeComparisons: onDidChangeComparisons.event,
			onDidEmit: Event.None,
			getComparison: (id: string) => id === view?.id ? view : undefined,
			isJudging: () => judging,
			getRunTask: (_id: string, run: number) => run === 3 ? undefined : { id: `compare-c1-${run}` },
			keep: async (id: string, run: number) => { calls.push(`keep ${id} ${run}`); return true; },
			discard: async (id: string) => { calls.push(`discard ${id}`); },
		} as unknown as IClaudeComparisonService);
		instantiation.stub(IClaudeBackgroundAgentService, {
			onDidChangeTasks: Event.None,
			review: async (taskId: string) => { calls.push(`review ${taskId}`); },
		} as unknown as IClaudeBackgroundAgentService);
		instantiation.stub(IClaudeAgentService, {
			onDidChangeViewState: Event.None,
			getViewState: (id: string) => ({ turns: id === 's2' ? [{ assistantText: 'Added `remove(id)` and a test.' }] : [] }),
			getSessions: () => openSessions.map(id => ({ id })),
			selectSession: (id: string) => { calls.push(`select ${id}`); },
			resume: async (id: string) => { calls.push(`resume ${id}`); },
		} as unknown as IClaudeAgentService);
		instantiation.stub(IViewsService, { openView: async (id: string) => { calls.push(`view ${id}`); return undefined; } } as unknown as IViewsService);
	});

	async function open(comparisonId = 'c1') {
		const editor = store.add(instantiation.createInstance(ClaudeComparisonEditor, new TestEditorGroupView(0)));
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		store.add({ dispose: () => parent.remove() });
		editor.create(parent);
		const input = store.add(instantiation.createInstance(ClaudeComparisonInput, comparisonId));
		await editor.setInput(input, undefined, {}, CancellationToken.None);
		const texts = (selector: string) => [...parent.querySelectorAll(selector)].map(element => element.textContent);
		const button = (run: number, label: string) => [...parent.querySelectorAll<HTMLButtonElement>(`.claude-compare-run[data-run="${run}"] button`)].find(candidate => candidate.textContent === label)!;
		return { parent, input, texts, button };
	}

	test('one column per run, ranked by the judge, with its facts and actions', async () => {
		const { parent, input, texts } = await open();
		assert.deepStrictEqual({
			name: input.getName(),
			title: texts('.claude-compare-title'),
			summary: texts('.claude-compare-summary'),
			discardHidden: parent.querySelector<HTMLButtonElement>('.claude-compare-discard')!.hidden,
			columns: [...parent.querySelectorAll<HTMLElement>('.claude-compare-run')].map(column => ({
				run: column.dataset.run,
				model: column.querySelector('.claude-compare-model')?.textContent,
				rank: column.querySelector('.claude-compare-rank')?.textContent,
				score: column.querySelector('.claude-compare-score')?.textContent,
				status: column.querySelector('.claude-compare-status .label')?.textContent,
				stats: [...column.querySelectorAll('.claude-compare-stats span')].map(span => span.textContent),
				message: column.querySelector('.claude-compare-message')?.textContent,
				reasons: column.querySelector('.claude-compare-reasons p')?.textContent,
				answer: column.querySelector('.claude-compare-answer p')?.textContent,
				actions: [...column.querySelectorAll<HTMLButtonElement>('.claude-compare-actions button')].map(button => `${button.textContent}${button.classList.contains('is-primary') ? ' (primary)' : ''}`),
			})),
		}, {
			name: 'Compare: Add TodoList.remove',
			title: ['Add TodoList.remove'],
			summary: ['Sonnet wins on scope.'],
			discardHidden: false,
			columns: [
				{ run: '2', model: 'Sonnet 5.5', rank: 'Rank 1', score: '8/10', status: 'Done', stats: ['1 file, +9 -1', '$0.08', '21s'], message: undefined, reasons: 'Smallest diff with a test.', answer: 'Added `remove(id)` and a test.', actions: ['Keep (primary)', 'Review Changes', 'Open as Chat'] },
				{ run: '1', model: 'Opus 5.5, High', rank: 'Rank 2', score: '6/10', status: 'Done', stats: ['2 files, +14 -3', '$0.31', '1m 5s'], message: undefined, reasons: 'Also renames a helper.', answer: undefined, actions: ['Keep', 'Review Changes', 'Open as Chat'] },
				{ run: '3', model: 'Haiku 5.5', rank: 'Rank 3', score: '1/10', status: 'Failed', stats: [], message: 'Out of budget.', reasons: 'Did not finish.', answer: undefined, actions: ['Open as Chat'] },
			],
		});
	});

	test('Keep, Discard All, Review Changes and Open as Chat reach the services', async () => {
		const { parent, button } = await open();
		button(2, 'Keep').click();
		parent.querySelector<HTMLButtonElement>('.claude-compare-discard')!.click();
		button(1, 'Review Changes').click();
		button(1, 'Open as Chat').click();
		button(3, 'Open as Chat').click();
		await timeout(0);
		assert.deepStrictEqual(calls, [
			'keep c1 2',
			'discard c1',
			'review compare-c1-1',
			'select s1',
			`view ${CLAUDE_AGENT_VIEW_ID}`,
			'resume s3',
			'select s3',
			`view ${CLAUDE_AGENT_VIEW_ID}`,
		]);
	});

	test('while the judge runs the header says Judging, then shows the ranking', async () => {
		const judged = view!;
		view = { ...judged, verdict: undefined };
		judging = true;
		const { parent, texts } = await open();
		const header = () => ({
			judging: parent.querySelector('.claude-compare-summary')!.classList.contains('is-judging'),
			spinner: !!parent.querySelector('.claude-compare-summary .codicon-loading.codicon-modifier-spin'),
			summary: texts('.claude-compare-summary'),
			ranks: texts('.claude-compare-rank'),
		});
		const before = header();
		view = judged;
		judging = false;
		onDidChangeComparisons.fire();
		await timeout(150);
		assert.deepStrictEqual({ before, after: header() }, {
			before: { judging: true, spinner: true, summary: ['Judging...'], ranks: [] },
			after: { judging: false, spinner: false, summary: ['Sonnet wins on scope.'], ranks: ['Rank 1', 'Rank 2', 'Rank 3'] },
		});
	});

	test('a comparison that is gone says so and offers nothing', async () => {
		view = undefined;
		const { parent, texts } = await open('gone');
		assert.deepStrictEqual({
			summary: texts('.claude-compare-summary'),
			columns: parent.querySelectorAll('.claude-compare-run').length,
			discardHidden: parent.querySelector<HTMLButtonElement>('.claude-compare-discard')!.hidden,
		}, { summary: ['This comparison is no longer available.'], columns: 0, discardHidden: true });
	});
});
