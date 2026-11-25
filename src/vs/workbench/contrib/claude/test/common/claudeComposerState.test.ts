/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentReducerEvent, EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../../../services/claude/common/claudeAgentState.js';
import { claudeComposerMeta, claudeContextUsage, claudeRelativeFolder, claudeRuntimeModel, claudeSlashDraftWithText, claudeTodoProgress, EMPTY_COMPOSER_META, foldClaudeRuntimeModel, showClaudeContextRing, showClaudeTodos, spliceClaudeMention } from '../../common/claudeComposerState.js';

suite('Claude composer state', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const todos = (statuses: readonly ('pending' | 'in_progress' | 'completed')[]) => statuses.map((status, index) => ({ id: `t${index}`, content: `Step ${index + 1}`, status }));

	test('to-dos and usage come from the view state, the model from the newest main-loop event', () => {
		const events: AgentReducerEvent[] = [
			{ type: 'session.started', sessionId: 's', model: 'claude-sonnet' },
			{ type: 'todo.changed', sessionId: 's', items: todos(['in_progress', 'pending']) },
			{ type: 'usage.changed', sessionId: 's', usage: { inputTokens: 10, outputTokens: 2, contextTokens: 50_000, contextWindow: 200_000 } },
			{ type: 'todo.changed', sessionId: 's', items: todos(['completed', 'in_progress']) },
			{ type: 'todo.changed', sessionId: 's', parentRunId: 'run-a', items: todos(['pending']) },
			{ type: 'session.modelChanged', sessionId: 's', parentRunId: 'run-a', modelId: 'claude-haiku' },
			{ type: 'assistant.delta', sessionId: 's', text: 'tail' },
		];
		const state = events.reduce(reduceAgentState, EMPTY_AGENT_VIEW_STATE);
		const meta = claudeComposerMeta(state, claudeRuntimeModel(events));
		const changed: AgentReducerEvent = { type: 'session.modelChanged', sessionId: 's', modelId: 'claude-opus' };
		assert.deepStrictEqual({
			todos: meta.todos.map(item => item.status),
			usage: meta.usage?.contextTokens,
			model: meta.runtimeModel,
			empty: claudeComposerMeta(EMPTY_AGENT_VIEW_STATE, claudeRuntimeModel([])),
			stableEmpty: claudeComposerMeta(EMPTY_AGENT_VIEW_STATE, undefined).todos === EMPTY_COMPOSER_META.todos,
			latest: claudeRuntimeModel([...events, changed]),
			folded: [changed, events[0], events[5], events[6], undefined].map(event => foldClaudeRuntimeModel('claude-known', event)),
		}, {
			todos: ['completed', 'in_progress'],
			usage: 50_000,
			model: 'claude-sonnet',
			empty: { todos: [], usage: undefined, runtimeModel: undefined },
			stableEmpty: true,
			latest: 'claude-opus',
			folded: ['claude-opus', 'claude-sonnet', 'claude-known', 'claude-known', 'claude-known'],
		});
	});

	test('to-do progress and when the strip shows', () => {
		assert.deepStrictEqual(claudeTodoProgress(todos(['completed', 'in_progress', 'pending'])), { done: 1, total: 3, current: { id: 't1', content: 'Step 2', status: 'in_progress' } });
		assert.deepStrictEqual([
			showClaudeTodos([], true),
			showClaudeTodos(todos(['completed', 'completed']), true),
			showClaudeTodos(todos(['completed', 'completed']), false),
			showClaudeTodos(todos(['completed', 'pending']), false),
		], [false, true, false, true]);
	});

	test('the context ring needs both real numbers', () => {
		assert.deepStrictEqual([
			claudeContextUsage(undefined),
			claudeContextUsage({ inputTokens: 10, outputTokens: 5 }),
			claudeContextUsage({ contextTokens: 10 }),
			claudeContextUsage({ contextTokens: 10, contextWindow: 0 }),
			claudeContextUsage({ contextTokens: 50_000, contextWindow: 200_000 }),
			claudeContextUsage({ contextTokens: 300_000, contextWindow: 200_000 })?.fraction,
		], [undefined, undefined, undefined, undefined, { used: 50_000, window: 200_000, fraction: 0.25 }, 1]);
	});

	test('the context ring shows from half the window on (#136)', () => {
		assert.deepStrictEqual([
			showClaudeContextRing(undefined),
			showClaudeContextRing(claudeContextUsage({ contextTokens: 50_000, contextWindow: 200_000 })),
			showClaudeContextRing(claudeContextUsage({ contextTokens: 100_000, contextWindow: 200_000 })),
			showClaudeContextRing(claudeContextUsage({ contextTokens: 300_000, contextWindow: 200_000 })),
		], [false, false, true, true]);
	});

	test('accepting a mention never leaves a double space', () => {
		const accept = (value: string, query: string, insert: string) => {
			const cursor = value.indexOf(query) + query.length;
			return spliceClaudeMention(value, value.indexOf(query), cursor, insert);
		};
		assert.deepStrictEqual([
			accept('Explain @midd and why', '@midd', ''),
			accept('Explain @midd', '@midd', ''),
			accept('@midd and why', '@midd', ''),
			accept('/rev the diff', '/rev', '/review '),
			accept('Look at @src', '@src', ''),
		], [
			{ value: 'Explain and why', cursor: 8 },
			{ value: 'Explain ', cursor: 8 },
			{ value: 'and why', cursor: 0 },
			{ value: '/review the diff', cursor: 8 },
			{ value: 'Look at ', cursor: 8 },
		]);
	});

	test('the @ menu shows the folder relative to the workspace', () => {
		assert.deepStrictEqual([
			claudeRelativeFolder('src/auth/middleware.ts'),
			claudeRelativeFolder('src\\auth\\middleware.ts'),
			claudeRelativeFolder('README.md'),
		], ['src/auth', 'src/auth', '']);
	});

	test('Edit Goal keeps a draft already typed in the composer', () => {
		assert.deepStrictEqual([
			claudeSlashDraftWithText('goal', 'ship it', ''),
			claudeSlashDraftWithText('goal', 'ship it', '  '),
			claudeSlashDraftWithText('goal', 'ship it', 'also fix the tests'),
			claudeSlashDraftWithText('goal', 'ship it', '/goal old outcome'),
		], ['/goal ship it', '/goal ship it', '/goal ship it\nalso fix the tests', '/goal ship it']);
	});
});
