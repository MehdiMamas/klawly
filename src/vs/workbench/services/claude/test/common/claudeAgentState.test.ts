/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NormalizedClaudeEvent, ToolCall } from '../../../../../platform/claude/common/claudeProtocol.js';
import { AgentViewState, describeActivity, describeFailure, EMPTY_AGENT_VIEW_STATE, hasLiveChildren, reduceAgentState } from '../../common/claudeAgentState.js';

suite('Claude agent view state', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('hasLiveChildren follows background children, even after the head turn completed', () => {
		const started: NormalizedClaudeEvent = {
			type: 'subagent.started',
			sessionId: 's',
			run: { id: 'run-1', agentType: 'local_bash', description: 'Build', background: true, state: 'running', startedAt: 1, toolCallCount: 0 },
		};
		let state = submit('Go');
		const none = hasLiveChildren(state);
		state = reduceAgentState(state, started);
		state = reduceAgentState(state, { type: 'session.completed', sessionId: 's' });
		const live = hasLiveChildren(state);
		state = reduceAgentState(state, { type: 'subagent.finished', sessionId: 's', runId: 'run-1', state: 'success' });
		assert.deepStrictEqual({ none, live, turn: state.turns[0].status, after: hasLiveChildren(state) }, { none: false, live: true, turn: 'complete', after: false });
	});

	test('streams deltas, then replaces the open segment with the completed text', () => {
		let state = submit('Why?');
		state = reduceAgentState(state, delta('The handler '));
		state = reduceAgentState(state, delta('returns early.'));
		assert.strictEqual(state.turns[0].assistantText, 'The handler returns early.');
		assert.strictEqual(state.turns[0].segmentOpen, true);
		state = reduceAgentState(state, { type: 'assistant.completed', sessionId: 's', text: 'The handler returns early.' });
		const turn = state.turns[0];
		assert.strictEqual(turn.assistantText, 'The handler returns early.');
		assert.strictEqual(turn.segmentOpen, false);
		assert.strictEqual(turn.status, 'running');
	});

	test('a later assistant message is its own segment', () => {
		let state = submit('Why?');
		state = reduceAgentState(state, { type: 'assistant.completed', sessionId: 's', text: 'First.' });
		state = reduceAgentState(state, delta('Second.'));
		assert.strictEqual(state.turns[0].assistantText, 'First.\n\nSecond.');
	});

	test('a turn keeps when it was submitted and when it ended, and an untimed turn gets neither', () => {
		let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text: 'Why?', startedAt: 1000 });
		state = reduceAgentState(state, delta('Because.'));
		const running = state.turns[0].endedAt;
		state = reduceAgentState(state, { type: 'session.completed', sessionId: 's', endedAt: 6000 });
		const untimed = reduceAgentState(submit('Again?'), { type: 'turn.stopped' });
		assert.deepStrictEqual({
			running,
			timed: { startedAt: state.turns[0].startedAt, endedAt: state.turns[0].endedAt },
			untimed: [untimed.turns[0].startedAt, untimed.turns[0].endedAt],
		}, { running: undefined, timed: { startedAt: 1000, endedAt: 6000 }, untimed: [undefined, undefined] });
	});

	test('an empty delta does not change the state', () => {
		const state = reduceAgentState(submit('Why?'), delta(''));
		assert.strictEqual(state.turns.length, 1);
		assert.strictEqual(reduceAgentState(state, delta('')), state);
	});

	test('activity follows the newest running tool and never prints tool input', () => {
		let state = submit('Look');
		state = reduceAgentState(state, toolStarted(readCall('read-1', 'src/auth.ts')));
		assert.strictEqual(describeActivity(state.turns[0]), 'Reading src/auth.ts');
		state = reduceAgentState(state, toolStarted({
			id: 'search-1', name: 'Grep', category: 'search', input: { pattern: 'secret' },
			display: { label: 'Search', query: 'verifyToken' },
		}));
		assert.strictEqual(describeActivity(state.turns[0]), 'Searching "verifyToken"');
		state = reduceAgentState(state, { type: 'tool.completed', sessionId: 's', callId: 'search-1', result: { ok: true } });
		state = reduceAgentState(state, toolStarted(writeCall('w1', 'a.ts')));
		state = reduceAgentState(state, toolStarted(writeCall('w2', 'b.ts')));
		state = reduceAgentState(state, toolStarted(writeCall('w3', 'c.ts')));
		assert.strictEqual(describeActivity(state.turns[0]), 'Editing 3 files');
		state = reduceAgentState(state, toolStarted({
			id: 'sh', name: 'Bash', category: 'shell', input: { command: 'npm test --secret' },
			display: { label: 'Run', command: 'npm test' },
		}));
		assert.strictEqual(describeActivity(state.turns[0]), 'Running npm test');
		assert.strictEqual(JSON.stringify(state).includes('secret'), false);
	});

	test('a turn stopped at its step cap reads as a stop with the step count, not an error (issues 696, 707)', () => {
		const state = reduceAgentState(submit('Fix the auth path'), { type: 'session.failed', sessionId: 's', message: 'Claude stopped at its turn limit.', kind: 'turn-limit', turns: 33 });
		assert.deepStrictEqual({ status: state.turns[0].status, failure: state.turns[0].failure, presented: describeFailure(state.turns[0].failure) }, {
			status: 'failed',
			failure: { message: 'Claude stopped at its turn limit.', kind: 'turn-limit', turns: 33 },
			presented: { title: 'Claude stopped after 33 steps.' },
		});
	});

	test('failure and stop keep partial text', () => {
		let state = submit('Why?');
		state = reduceAgentState(state, delta('Partial answer'));
		state = reduceAgentState(state, toolStarted(readCall('read-1', 'src/auth.ts')));
		const failed = reduceAgentState(state, { type: 'session.failed', sessionId: 's', message: 'process exited', kind: 'process-crash' });
		assert.strictEqual(failed.turns[0].assistantText, 'Partial answer');
		assert.strictEqual(failed.turns[0].status, 'failed');
		assert.strictEqual(failed.turns[0].cards[0].state, 'failed');
		assert.strictEqual(describeFailure(failed.turns[0].failure).title, 'Claude stopped unexpectedly.');
		assert.strictEqual(describeFailure(failed.turns[0].failure).description, 'process exited');
		assert.strictEqual(describeActivity(failed.turns[0]), undefined);

		const stopped = reduceAgentState(state, { type: 'turn.stopped' });
		assert.strictEqual(stopped.turns[0].assistantText, 'Partial answer');
		assert.strictEqual(stopped.turns[0].status, 'stopped');
		assert.strictEqual(stopped.turns[0].cards[0].state, 'cancelled');
	});

	test('a completed session finishes the turn and a new prompt starts another', () => {
		let state = submit('First');
		state = reduceAgentState(state, { type: 'assistant.completed', sessionId: 's', text: 'Done.' });
		state = reduceAgentState(state, { type: 'session.completed', sessionId: 's' });
		assert.strictEqual(state.turns[0].status, 'complete');
		state = reduceAgentState(state, { type: 'turn.submitted', turnId: 'turn-2', text: 'Second' });
		assert.strictEqual(state.turns.length, 2);
		assert.strictEqual(state.turns[0].assistantText, 'Done.');
		assert.strictEqual(state.turns[1].status, 'running');
	});

	test('thinking streams into its own part, keeps its first and last time, and the answer or a tool closes it', () => {
		let state = submit('Why?');
		for (const event of [thinking('', 1000), thinking('Check ', 1200), thinking('the guard.', 1800), delta('It returns early.'), thinking('', 3000), toolStarted({ id: 't1', name: 'Read', category: 'read', input: {}, display: { label: 'Read' } }), thinking('', 5000, true)]) {
			state = reduceAgentState(state, event);
		}
		const hidden = reduceAgentState(submit('Look'), { type: 'thinking.delta', sessionId: 's', parentRunId: 'run-1', text: 'hidden', at: 1 });
		assert.deepStrictEqual({
			parts: state.turns[0].parts?.map(part => part.kind === 'thinking' ? `thinking:${part.text}:${part.open}:${part.startedAt}-${part.lastAt}` : part.kind),
			answer: state.turns[0].assistantText,
			hidden: hidden.turns[0].parts ?? [],
		}, {
			parts: ['thinking:Check the guard.:false:1000-1800', 'text', 'thinking::false:3000-3000', 'tool', 'thinking::false:5000-5000'],
			answer: 'It returns early.',
			hidden: [],
		});
	});

	test('subagent text stays out of the parent turn', () => {
		let state = submit('Look');
		const hidden: NormalizedClaudeEvent = { type: 'assistant.delta', sessionId: 's', parentRunId: 'run-1', text: 'hidden' };
		state = reduceAgentState(state, hidden);
		state = reduceAgentState(state, delta('visible'));
		assert.strictEqual(state.turns[0].assistantText, 'visible');
		assert.strictEqual(state.turns[0].cards.length, 0);
	});

	test('a steer is kept on the turn and still there after it stops', () => {
		let state = submit('Look');
		state = reduceAgentState(state, { type: 'turn.steered', text: 'Use the helper' });
		assert.deepStrictEqual(state.turns[0].steered, ['Use the helper']);
		assert.strictEqual(state.turns[0].status, 'running');
		state = reduceAgentState(state, { type: 'turn.stopped' });
		assert.strictEqual(state.turns[0].status, 'stopped');
		assert.deepStrictEqual(state.turns[0].steered, ['Use the helper']);
	});

	test('a steer and a command re-run both stay on a running turn', () => {
		let state = submit('Look');
		state = reduceAgentState(state, { type: 'turn.steered', text: 'Use the helper' });
		state = reduceAgentState(state, { type: 'command.rerun', command: 'npm test', cwd: '/repo', allowed: true, source: 'policy', reason: 'Allowed.' });
		assert.deepStrictEqual(state.turns[0].steered, ['Use the helper']);
		assert.strictEqual(state.turns[0].status, 'running');
		assert.strictEqual(state.turns[0].cards.length, 0);
		assert.strictEqual(state.turns[0].permissions[0].command, 'npm test');
		assert.strictEqual(state.turns[0].permissions[0].state, 'allowed');
	});

	test('a second prompt is ignored while a turn is running', () => {
		const state = submit('First');
		assert.strictEqual(reduceAgentState(state, { type: 'turn.submitted', turnId: 'turn-2', text: 'Second' }), state);
	});

	test('usage-limit copy does not invent a checkpoint', () => {
		const presented = describeFailure({ message: 'rate limited', kind: 'usage-limit' });
		assert.strictEqual(presented.title, 'Claude reached its current usage limit.');
		assert.strictEqual(presented.description, 'rate limited');
		assert.strictEqual(JSON.stringify(presented).includes('checkpoint'), false);
	});

	test('a pull request the session created becomes the session pill; a mentioned one or an issue does not', () => {
		const reference = (kind: 'pullRequest' | 'issue', number: number, createdBySession: boolean): NormalizedClaudeEvent => ({
			type: 'github.referenceDetected',
			sessionId: 's',
			reference: { url: `https://github.com/o/r/${kind === 'pullRequest' ? 'pull' : 'issues'}/${number}`, owner: 'o', repo: 'r', number, kind, createdBySession },
		});
		let state = submit('Open a pull request');
		const pills: (number | undefined)[] = [];
		for (const event of [reference('pullRequest', 3, false), reference('issue', 4, true), reference('pullRequest', 3, true), reference('pullRequest', 3, false)]) {
			state = reduceAgentState(state, event);
			pills.push(state.pullRequest?.number);
		}
		const parts = state.turns[0].parts?.flatMap(part => part.kind === 'github' ? [`${part.reference.number}:${part.reference.createdBySession}`] : []);
		assert.deepStrictEqual({ pills, parts }, { pills: [undefined, undefined, 3, 3], parts: ['3:true', '4:true'] });
	});
});

function submit(text: string): AgentViewState {
	return reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text });
}

function thinking(text: string, at: number, isDone?: boolean): NormalizedClaudeEvent {
	return { type: 'thinking.delta', sessionId: 's', text, at, done: isDone };
}

function delta(text: string): NormalizedClaudeEvent {
	return { type: 'assistant.delta', sessionId: 's', text };
}

function toolStarted(call: ToolCall): NormalizedClaudeEvent {
	return { type: 'tool.started', sessionId: 's', call };
}

function readCall(id: string, file: string): ToolCall {
	return { id, name: 'Read', category: 'read', input: {}, display: { label: `Read ${file}`, file } };
}

function writeCall(id: string, file: string): ToolCall {
	return { id, name: 'Edit', category: 'write', input: {}, display: { label: `Edit ${file}`, file } };
}
