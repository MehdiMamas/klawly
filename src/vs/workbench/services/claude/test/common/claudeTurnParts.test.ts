/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NormalizedClaudeEvent, ToolCall } from '../../../../../platform/claude/common/claudeProtocol.js';
import { ClaudeElicitationRequest } from '../../../../../platform/claude/common/claudeElicitation.js';
import { AgentReducerEvent, AgentViewState, describeActivity, EMPTY_AGENT_VIEW_STATE, hasPendingElicitation, reduceAgentState, TurnPart, turnParts, TurnViewModel } from '../../common/claudeAgentState.js';
import { exportTranscript, replayDurableEvents } from '../../common/claudeTranscript.js';

suite('Claude turn parts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('text and tools keep event order, and a completion after a tool start lands on its own message', () => {
		// The normalizer emits tool.started before the completion of the same assistant message.
		const turn = run([
			delta('Reading the '),
			delta('middleware.'),
			toolStarted(readCall('r1', 'src/a.ts')),
			completed('Reading the middleware.'),
			{ type: 'tool.completed', sessionId: 's', callId: 'r1', result: { ok: true } },
			delta('Found it.'),
			completed('Found it.'),
		]).turns[0];
		assert.deepStrictEqual({ parts: shape(turn), text: turn.assistantText, open: turn.segmentOpen }, {
			parts: ['text:Reading the middleware.', 'tool:r1', 'text:Found it.'],
			text: 'Reading the middleware.\n\nFound it.',
			open: false,
		});
	});

	test('a tool start closes the open segment and the next delta opens another', () => {
		let state = run([delta('First'), toolStarted(readCall('r1', 'a.ts'))]);
		const closed = state.turns[0].parts?.[0];
		state = reduceAgentState(state, delta(' second'));
		const turn = state.turns[0];
		assert.deepStrictEqual({
			closed: closed?.kind === 'text' ? closed.open : undefined,
			parts: shape(turn),
			newestOpen: lastText(turn)?.open,
			segmentStart: turn.segmentStart,
			text: turn.assistantText,
		}, {
			closed: false,
			parts: ['text:First', 'tool:r1', 'text: second'],
			newestOpen: true,
			segmentStart: 'First\n\n'.length,
			text: 'First\n\n second',
		});
	});

	test('a finished segment keeps its part object while later deltas stream', () => {
		let state = run([delta('Done.'), completed('Done.'), toolStarted(readCall('r1', 'a.ts')), delta('Next')]);
		const finished = state.turns[0].parts?.[0];
		state = reduceAgentState(state, delta(' and more'));
		assert.strictEqual(state.turns[0].parts?.[0], finished);
		assert.strictEqual(lastText(state.turns[0])?.text, 'Next and more');
	});

	test('subagents, permissions and re-runs are parts where they happened; a nested subagent is a part of its parent chat', () => {
		const state = run([
			delta('Looking.'),
			started('run-a', undefined),
			started('run-b', 'run-a'),
			permission('p1'),
			{ type: 'permission.resolved', sessionId: 's', outcome: { requestId: 'p2', toolName: 'Bash', decision: 'allow', source: 'grant', subject: 'ls' } },
			{ type: 'command.rerun', command: 'npm test', allowed: true, source: 'user' },
			delta('Done.'),
		]);
		assert.deepStrictEqual({
			turn: shape(state.turns[0]),
			parentChat: shape(state.subagents[0].chat),
		}, {
			turn: ['text:Looking.', 'subagent:run-a', 'permission:p1', 'permission:p2', 'permission:rerun:2:npm test', 'text:Done.'],
			parentChat: ['subagent:run-b'],
		});
	});

	test('a subagent result ends its chat once', () => {
		let state = run([started('run-a', undefined), inner('run-a', delta('Three callers.')), inner('run-a', completed('Three callers.'))]);
		state = reduceAgentState(state, { type: 'subagent.finished', sessionId: 's', runId: 'run-a', state: 'success', resultText: 'Three callers.' });
		state = reduceAgentState(state, { type: 'subagent.finished', sessionId: 's', runId: 'run-a', state: 'success', resultText: 'Three callers.' });
		const other = reduceAgentState(run([started('run-c', undefined)]), { type: 'subagent.finished', sessionId: 's', runId: 'run-c', state: 'success', resultText: 'Summary.' });
		assert.deepStrictEqual({ same: shape(state.subagents[0].chat), result: shape(other.subagents[0].chat), text: other.subagents[0].chat.assistantText }, {
			same: ['text:Three callers.'],
			result: ['text:Summary.'],
			text: 'Summary.',
		});
	});

	test('the plan takes the place of the answer segment and earlier narration stays', () => {
		const answer = '# Fix login\n\n1. Add `/login` to the routes\n2. Run the tests';
		const plan = run([
			delta('Let me look.'),
			toolStarted(readCall('r1', 'a.ts')),
			completed('Let me look.'),
			{ type: 'tool.completed', sessionId: 's', callId: 'r1', result: { ok: true } },
			delta(answer),
			{ type: 'session.completed', sessionId: 's' },
		], 'plan').turns[0];
		// The list is in an earlier segment than the closing sentence, so the plan reads all the text.
		const split = run([
			completed('# Fix login\n\n1. Add routes\n2. Run tests'),
			toolStarted(readCall('r1', 'a.ts')),
			completed('Ready when you are.'),
			{ type: 'session.completed', sessionId: 's' },
		], 'plan').turns[0];
		assert.deepStrictEqual({
			plan: shape(plan),
			steps: plan.plan?.steps.length,
			text: plan.assistantText,
			split: shape(split),
			splitTitle: split.plan?.title,
		}, {
			plan: ['text:Let me look.', 'tool:r1', `plan:${answer}`],
			steps: 2,
			text: `Let me look.\n\n${answer}`,
			split: ['tool:r1', 'plan:# Fix login\n\n1. Add routes\n2. Run tests\n\nReady when you are.'],
			splitTitle: 'Fix login',
		});
	});

	test('to-dos and context usage of the main agent are in the view state and survive a new turn', () => {
		let state = run([
			{ type: 'todo.changed', sessionId: 's', items: [{ id: 't1', content: 'Find the loop', status: 'in_progress' }] },
			{ type: 'todo.changed', sessionId: 's', parentRunId: 'run-a', items: [{ id: 'x', content: 'Subagent list', status: 'pending' }] },
			{ type: 'usage.changed', sessionId: 's', usage: { inputTokens: 1200, outputTokens: 80 } },
			{ type: 'session.completed', sessionId: 's' },
		]);
		state = reduceAgentState(state, { type: 'turn.submitted', turnId: 'turn-2', text: 'Next' });
		assert.deepStrictEqual({ todos: state.todos, usage: state.usage, turns: state.turns.length }, {
			todos: [{ id: 't1', content: 'Find the loop', status: 'in_progress' }],
			usage: { inputTokens: 1200, outputTokens: 80 },
			turns: 2,
		});
	});

	test('history replay rebuilds the same parts, and the transcript follows them', () => {
		const events: AgentReducerEvent[] = [
			{ type: 'turn.submitted', turnId: 'turn-1', text: 'Fix it' },
			delta('Reading first.'),
			toolStarted({ id: 'b1', name: 'Bash', category: 'shell', input: { command: 'npm test' }, display: { label: 'Run', command: 'npm test' } }),
			completed('Reading first.'),
			{ type: 'tool.completed', sessionId: 's', callId: 'b1', result: { ok: true } },
			delta('All tests pass.'),
			{ type: 'session.completed', sessionId: 's' },
		];
		let live = EMPTY_AGENT_VIEW_STATE;
		for (const event of events) {
			live = reduceAgentState(live, event);
		}
		const replayed = replayDurableEvents(events).state;
		const markdown = exportTranscript(replayed, 'Fix').markdown;
		assert.deepStrictEqual({
			same: JSON.stringify(replayed.turns[0].parts) === JSON.stringify(live.turns[0].parts),
			order: markdown.split('\n').filter(line => line && !line.startsWith('#')),
		}, {
			same: true,
			order: ['Reading first.', '- Ran npm test (success)', 'All tests pass.'],
		});
	});

	test('a turn built without parts gets text, tools and permissions in the old order', () => {
		const turn: TurnViewModel = {
			id: 'legacy',
			user: { text: 'Old' },
			assistantText: 'Answer',
			status: 'complete',
			cards: run([toolStarted(readCall('r1', 'a.ts'))]).turns[0].cards,
			changedFiles: [],
			permissions: [{ id: 'p1', toolName: 'Bash', canRemember: false, state: 'allowed' }],
			segmentOpen: false,
			segmentStart: 0,
			steered: [],
		};
		assert.deepStrictEqual(turnParts(turn).map(part => `${part.kind}:${part.id}`), ['text:text', 'tool:r1', 'permission:p1']);
	});

	test('stop and crash close the open segment and keep it', () => {
		const stopped = reduceAgentState(run([delta('Partial')]), { type: 'turn.stopped' }).turns[0];
		const crashed = reduceAgentState(run([delta('Partial')]), { type: 'session.recovered' }).turns[0];
		assert.deepStrictEqual([lastText(stopped)?.open, lastText(crashed)?.open, stopped.assistantText, crashed.assistantText], [false, false, 'Partial', 'Partial']);
	});

	test('MCP forms and sign-ins (issue 428): a part in order, settled by outcome, signed in on completion, cancelled when the turn stops', () => {
		const waiting = run([
			delta('Need details.'),
			{ type: 'elicitation.requested', sessionId: 's', request: elicitation('e1', 'form') },
			{ type: 'elicitation.requested', sessionId: 's', request: elicitation('e1', 'form') },
		]);
		const answered = [
			{ type: 'elicitation.resolved', sessionId: 's', outcome: { id: 'e1', server: 'deploy', mode: 'form', action: 'accept', source: 'user' } },
			{ type: 'elicitation.requested', sessionId: 's', request: elicitation('e2', 'url') },
			{ type: 'elicitation.resolved', sessionId: 's', outcome: { id: 'e2', server: 'deploy', mode: 'url', action: 'accept', source: 'user' } },
			{ type: 'elicitation.completed', sessionId: 's', server: 'deploy', elicitationId: 'srv-e2' },
			{ type: 'elicitation.requested', sessionId: 's', request: elicitation('e3', 'form') },
			{ type: 'turn.stopped' },
		] satisfies AgentReducerEvent[];
		let state = waiting;
		for (const event of answered) {
			state = reduceAgentState(state, event);
		}
		const turn = state.turns[0];
		assert.deepStrictEqual({
			waiting: [shape(waiting.turns[0]), hasPendingElicitation(waiting.turns[0]), describeActivity(waiting.turns[0])],
			parts: shape(turn),
			entries: turn.elicitations?.map(entry => [entry.id, entry.state, entry.source, entry.completed ?? false]),
			pending: hasPendingElicitation(turn),
		}, {
			waiting: [['text:Need details.', 'elicitation:e1'], true, 'Waiting for your input'],
			parts: ['text:Need details.', 'elicitation:e1', 'elicitation:e2', 'elicitation:e3'],
			entries: [['e1', 'accepted', 'user', false], ['e2', 'accepted', 'user', true], ['e3', 'cancelled', 'session-stopped', false]],
			pending: false,
		});
	});
});

function elicitation(id: string, mode: 'form' | 'url'): ClaudeElicitationRequest {
	return mode === 'form'
		? { id, server: 'deploy', mode, message: 'Release details', schema: { type: 'object', properties: { name: { type: 'string' } } }, expiresAt: 1 }
		: { id, server: 'deploy', mode, message: 'Sign in', url: 'https://auth.deploy.test/x', urlHost: 'auth.deploy.test', elicitationId: `srv-${id}`, expiresAt: 1 };
}

function run(events: readonly AgentReducerEvent[], mode?: 'plan'): AgentViewState {
	let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text: 'Go', sent: mode ? { compiled: 'Go', mode } : undefined });
	for (const event of events) {
		state = reduceAgentState(state, event);
	}
	return state;
}

function shape(turn: TurnViewModel): string[] {
	return turnParts(turn).map((part: TurnPart) => part.kind === 'text' || part.kind === 'plan' ? `${part.kind}:${part.text}` : `${part.kind}:${part.id}`);
}

function lastText(turn: TurnViewModel) {
	const parts = turnParts(turn).filter(part => part.kind === 'text');
	return parts[parts.length - 1];
}

function delta(text: string): NormalizedClaudeEvent {
	return { type: 'assistant.delta', sessionId: 's', text };
}

function completed(text: string): NormalizedClaudeEvent {
	return { type: 'assistant.completed', sessionId: 's', text };
}

function toolStarted(call: ToolCall): NormalizedClaudeEvent {
	return { type: 'tool.started', sessionId: 's', call };
}

function readCall(id: string, file: string): ToolCall {
	return { id, name: 'Read', category: 'read', input: {}, display: { label: `Read ${file}`, file } };
}

function started(id: string, parent: string | undefined): NormalizedClaudeEvent {
	return {
		type: 'subagent.started',
		sessionId: 's',
		parentRunId: parent,
		run: { id, parentRunId: parent, agentType: 'Explore', description: id, background: false, state: 'running', startedAt: 1, toolCallCount: 0 },
	};
}

function inner(runId: string, event: NormalizedClaudeEvent): NormalizedClaudeEvent {
	return { ...event, parentRunId: runId };
}

function permission(id: string): NormalizedClaudeEvent {
	return { type: 'permission.requested', sessionId: 's', request: { id, toolName: 'Bash', category: 'shell', input: {}, command: 'npm test' } };
}
