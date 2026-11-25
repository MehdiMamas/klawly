/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isSlashCommandPrompt } from '../../node/claudeAgentRunner.js';
import { CLAUDE_BUDGET_STOP_MESSAGE, CLAUDE_TOOL_RESULT_MAX_IMAGES, claudeChainAnchor, createClaudeNormalizerState, normalizeClaudeMessage, toolResultExtras } from '../../node/claudeStreamNormalizer.js';

suite('Claude stream normalizer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('init metadata lists slash commands and skills', () => {
		const init = readJson('init-metadata.json');
		const logs: string[] = [];
		const result = normalizeClaudeMessage(init, 'session-1', createClaudeNormalizerState(), line => logs.push(line));

		assert.strictEqual(result.init?.slashCommands.includes('review'), true);
		assert.strictEqual(result.init?.skills.includes('code-review'), true);
		assert.strictEqual(result.events[0].type, 'session.started');
		assert.ok(result.events[0].type === 'session.started' && result.events[0].slashCommands?.includes('review'));
		assert.ok(result.events[0].type === 'session.started' && result.events[0].skills?.includes('code-review'));
		assert.strictEqual(result.sdkSessionId, 'sdk-session');
		assert.ok(result.events[0].type === 'session.started' && result.events[0].claudeSessionId === 'sdk-session' && result.events[0].sessionId === 'session-1');
		assert.deepStrictEqual(logs, []);
	});

	test('a slash command prompt is dispatched as text and a local command result normalizes', () => {
		assert.strictEqual(isSlashCommandPrompt('/review'), true);
		assert.strictEqual(isSlashCommandPrompt('please /review'), false);
		const messages = readJson('slash-command.json') as unknown[];
		const state = createClaudeNormalizerState();
		const events = messages.flatMap(message => normalizeClaudeMessage(message, 'session-1', state).events);
		const result = (readJson('slash-command.json') as Array<Record<string, unknown>>)[1];

		assert.strictEqual(result.local_command, '/review');
		assert.ok(events.some(event => event.type === 'session.started'));
		assert.ok(events.some(event => event.type === 'assistant.completed' && event.text === 'Review is a Claude command.'));
		assert.ok(events.some(event => event.type === 'usage.changed' && event.usage.inputTokens === 1));
	});

	test('maps parent_tool_use_id onto subagent events', () => {
		const messages = readJson('subagent.json') as unknown[];
		const state = createClaudeNormalizerState();
		const events = messages.flatMap(message => normalizeClaudeMessage(message, 'session-1', state).events);
		const started = events.find(event => event.type === 'subagent.started');
		const read = events.find(event => event.type === 'tool.started');
		const finished = events.find(event => event.type === 'subagent.finished');

		assert.strictEqual(started?.type, 'subagent.started');
		if (started?.type === 'subagent.started') {
			assert.strictEqual(started.run.id, 'toolu_agent');
			assert.strictEqual(started.run.agentType, 'explorer');
			assert.strictEqual(started.run.description, 'Inspect the sample repo');
		}
		assert.strictEqual(read?.type, 'tool.started');
		if (read?.type === 'tool.started') {
			assert.strictEqual(read.parentRunId, 'toolu_agent');
			assert.strictEqual(read.call.category, 'read');
		}
		assert.strictEqual(finished?.type, 'subagent.finished');
		if (finished?.type === 'subagent.finished') {
			assert.strictEqual(finished.runId, 'toolu_agent');
			assert.strictEqual(finished.state, 'success');
			assert.strictEqual(finished.resultText, 'The sample repo has a README.');
		}
	});

	test('a tool result keeps its images and structured content, within the caps', () => {
		const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
		const svg = { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'AAAA' } };
		const url = { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } };
		const many = Array.from({ length: CLAUDE_TOOL_RESULT_MAX_IMAGES + 2 }, () => png);
		assert.deepStrictEqual(toolResultExtras([{ type: 'text', text: 'x' }, png, svg, url], { structuredContent: { temp: 21 } }), {
			images: [{ mimeType: 'image/png', data: 'AAAA' }],
			structuredContent: { temp: 21 },
		});
		assert.strictEqual(toolResultExtras(many, undefined).images?.length, CLAUDE_TOOL_RESULT_MAX_IMAGES);
		assert.deepStrictEqual(toolResultExtras('text', { structuredContent: 'not an object' }), {});
	});

	test('drops unknown messages and never throws', () => {
		const logs: string[] = [];
		const state = createClaudeNormalizerState();
		const dropped = [
			undefined,
			null,
			42,
			{ type: 'widget_from_the_future', secret: 'token' },
			{ type: 'system', subtype: 'not_a_real_subtype' },
		];
		for (const message of dropped) {
			const result = normalizeClaudeMessage(message, 'session-1', state, line => logs.push(line));
			assert.deepStrictEqual(result.events, []);
		}
		assert.ok(logs.length >= dropped.length);
		assert.ok(logs.every(line => !line.includes('token')));
	});

	test('completes each assistant message and a later result', () => {
		const state = createClaudeNormalizerState();
		const first = normalizeClaudeMessage({
			type: 'assistant',
			message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: ' there' }] },
			parent_tool_use_id: null,
			session_id: 'sdk-session',
		}, 'session-1', state);
		const second = normalizeClaudeMessage({
			type: 'assistant',
			message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
			parent_tool_use_id: null,
			session_id: 'sdk-session',
		}, 'session-1', state);
		const result = normalizeClaudeMessage({
			type: 'result',
			subtype: 'success',
			is_error: false,
			result: 'Final',
			session_id: 'sdk-session',
		}, 'session-1', state);

		assert.ok(first.events.filter(event => event.type === 'assistant.delta').length >= 2);
		assert.ok(first.events.some(event => event.type === 'assistant.completed' && event.text === 'Hello there'));
		assert.ok(second.events.some(event => event.type === 'assistant.completed' && event.text === 'Done'));
		assert.ok(result.events.some(event => event.type === 'assistant.completed' && event.text === 'Final'));
		assert.strictEqual(result.endedTurn, 'success');
	});

	test('a run stopped at its budget fails with a message that says so', () => {
		const result = normalizeClaudeMessage({
			type: 'result',
			subtype: 'error_max_budget_usd',
			is_error: true,
			errors: [],
			session_id: 'sdk-session',
		}, 'session-1', createClaudeNormalizerState());
		assert.deepStrictEqual({
			ended: result.endedTurn,
			failures: result.events.flatMap(event => event.type === 'session.failed' ? [event.message] : []),
		}, { ended: 'error', failures: [CLAUDE_BUDGET_STOP_MESSAGE] });
	});

	test('a run stopped at its turn cap is a turn-limit stop with the turn count (issues 696, 707)', () => {
		const result = normalizeClaudeMessage({
			type: 'result',
			subtype: 'error_max_turns',
			is_error: true,
			num_turns: 33,
			errors: ['Reached maximum number of turns (32)'],
			session_id: 'sdk-session',
		}, 'session-1', createClaudeNormalizerState());
		assert.deepStrictEqual({
			ended: result.endedTurn,
			failures: result.events.flatMap(event => event.type === 'session.failed' ? [{ kind: event.kind, turns: event.turns }] : []),
		}, { ended: 'error', failures: [{ kind: 'turn-limit', turns: 33 }] });
	});

	test('a result reports what the query cost with its usage', () => {
		const result = normalizeClaudeMessage({
			type: 'result',
			subtype: 'success',
			is_error: false,
			result: '',
			total_cost_usd: 0.42,
			usage: { input_tokens: 10, output_tokens: 5 },
			session_id: 'sdk-session',
		}, 'session-1', createClaudeNormalizerState());
		assert.deepStrictEqual(result.events.flatMap(event => event.type === 'usage.changed' ? [event.usage.costUsd] : []), [0.42]);
	});

	test('streamed thinking starts, grows and ends, and its assistant message does not repeat it', () => {
		const state = createClaudeNormalizerState();
		const stream = (event: object) => normalizeClaudeMessage({ type: 'stream_event', event, parent_tool_use_id: null, session_id: 'sdk-session' }, 'session-1', state).events;
		const events = [
			...stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
			...stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Check the ' } }),
			...stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
			...stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'tests first.' } }),
			...stream({ type: 'content_block_stop', index: 0 }),
			...normalizeClaudeMessage({
				type: 'assistant',
				message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: 'Check the tests first.', signature: 'sig' }] },
				parent_tool_use_id: null,
				session_id: 'sdk-session',
			}, 'session-1', state).events,
		];

		assert.deepStrictEqual(events.map(event => event.type === 'thinking.delta' ? { text: event.text, done: event.done === true, timed: event.at > 0 } : event.type), [
			{ text: '', done: false, timed: true },
			{ text: 'Check the ', done: false, timed: true },
			{ text: 'tests first.', done: false, timed: true },
			{ text: '', done: true, timed: true },
		]);
	});

	test('the thinking token estimate grows the open block and is dropped outside one (issue 740)', () => {
		const state = createClaudeNormalizerState();
		const logged: string[] = [];
		const send = (message: object) => normalizeClaudeMessage({ ...message, parent_tool_use_id: null, session_id: 'sdk-session' }, 'session-1', state, line => logged.push(line)).events;
		const tokens = (estimated: number) => send({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: estimated, estimated_tokens_delta: 1 });
		const events = [
			...tokens(3),
			...send({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } }),
			...tokens(50),
			...tokens(221),
			...send({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
			...tokens(300),
		];
		assert.deepStrictEqual({
			events: events.map(event => event.type === 'thinking.delta' ? `${event.text}|${event.tokens ?? ''}|${event.done === true}` : event.type),
			logged,
		}, {
			events: ['||false', '|50|false', '|221|false', '||true'],
			logged: [],
		});
	});

	test('thinking that was not streamed comes whole from the assistant message, and redacted thinking has no text', () => {
		const state = createClaudeNormalizerState();
		const result = normalizeClaudeMessage({
			type: 'assistant',
			message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: 'Plan it.' }, { type: 'redacted_thinking', data: 'opaque' }, { type: 'text', text: 'Done' }] },
			parent_tool_use_id: null,
			session_id: 'sdk-session',
		}, 'session-1', state);

		assert.deepStrictEqual(result.events.map(event => event.type === 'thinking.delta' ? `thinking:${event.text}:${event.done}` : event.type), [
			'thinking:Plan it.:true',
			'thinking::true',
			'assistant.delta',
			'assistant.completed',
		]);
	});

	test('a foreground subagent finishes from its tool result', () => {
		const state = createClaudeNormalizerState();
		const started = normalizeClaudeMessage({
			type: 'assistant',
			message: {
				id: 'm1',
				role: 'assistant',
				content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'Look', subagent_type: 'explorer' } }],
			},
			parent_tool_use_id: null,
			session_id: 'sdk-session',
		}, 'session-1', state);
		const finished = normalizeClaudeMessage({
			type: 'user',
			message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'Found the README.' }] },
			parent_tool_use_id: null,
			session_id: 'sdk-session',
		}, 'session-1', state);

		assert.ok(started.events.some(event => event.type === 'subagent.started'));
		assert.ok(finished.events.some(event => event.type === 'subagent.finished' && event.runId === 'toolu_agent' && event.state === 'success' && event.resultText === 'Found the README.'));
	});

	test('TodoWrite newTodos emits one todo change', () => {
		const state = createClaudeNormalizerState();
		const result = normalizeClaudeMessage({
			type: 'user',
			message: {
				role: 'user',
				content: [
					{ type: 'tool_result', tool_use_id: 'todo-1', content: 'ok' },
					{ type: 'tool_result', tool_use_id: 'todo-1', content: 'ok again' },
				],
			},
			tool_use_result: { newTodos: [{ id: '1', content: 'Write tests', status: 'pending' }] },
			parent_tool_use_id: null,
			session_id: 'sdk-session',
		}, 'session-1', state);
		assert.strictEqual(result.events.filter(event => event.type === 'todo.changed').length, 1);
	});

	test('an allowed overage is not a usage limit', () => {
		const state = createClaudeNormalizerState();
		const result = normalizeClaudeMessage({
			type: 'rate_limit_event',
			rate_limit_info: { status: 'allowed', overageStatus: 'rejected' },
			session_id: 'sdk-session',
		}, 'session-1', state);
		assert.deepStrictEqual(result.events, []);
		assert.strictEqual(result.endedTurn, undefined);
	});

	test('flags every rate-limit event so the runner asks for the plan limits again', () => {
		const state = createClaudeNormalizerState();
		const warning = normalizeClaudeMessage({
			type: 'rate_limit_event',
			rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.82 },
			session_id: 'sdk-session',
		}, 'session-1', state);
		const text = normalizeClaudeMessage({ type: 'stream_event', event: { type: 'message_start' }, session_id: 'sdk-session' }, 'session-1', state);

		assert.deepStrictEqual([warning.events, warning.endedTurn, warning.rateLimitChanged, text.rateLimitChanged], [[], undefined, true, undefined]);
	});

	test('maps assistant auth and rate-limit errors', () => {
		const state = createClaudeNormalizerState();
		const auth = normalizeClaudeMessage({
			type: 'assistant',
			error: 'authentication_failed',
			message: { role: 'assistant', content: '' },
			parent_tool_use_id: null,
			session_id: 'sdk-session',
		}, 'session-1', state);
		const limit = normalizeClaudeMessage({
			type: 'rate_limit_event',
			rate_limit_info: { status: 'rejected' },
			session_id: 'sdk-session',
		}, 'session-1', state);

		assert.strictEqual(auth.events.some(event => event.type === 'session.failed' && event.kind === 'auth'), true);
		assert.strictEqual(limit.events.some(event => event.type === 'session.failed' && event.kind === 'usage-limit'), true);
	});

	test('a resume can stop only at a main-thread assistant or user message (issue 702)', () => {
		assert.deepStrictEqual([
			claudeChainAnchor({ type: 'assistant', uuid: 'a-1', parent_tool_use_id: null, message: { content: [] } }),
			claudeChainAnchor({ type: 'user', uuid: 'u-1', message: { content: [] } }),
			claudeChainAnchor({ type: 'assistant', uuid: 'a-2', parent_tool_use_id: 'toolu_1', message: { content: [] } }),
			claudeChainAnchor({ type: 'result', uuid: 'r-1' }),
			claudeChainAnchor({ type: 'assistant', uuid: '' }),
			claudeChainAnchor(undefined),
		], ['a-1', 'u-1', undefined, undefined, undefined, undefined]);
	});

	test('usage carries the main-loop context size of its own turn and the main model window, never a guess', () => {
		const state = createClaudeNormalizerState();
		const assistant = (id: string, usage: unknown, parent: string | null, model: string) => normalizeClaudeMessage({
			type: 'assistant',
			message: { id, role: 'assistant', model, content: [], usage },
			parent_tool_use_id: parent,
			session_id: 'sdk-session',
		}, 'session-1', state);
		const result = (modelUsage: unknown) => normalizeClaudeMessage({
			type: 'result',
			subtype: 'success',
			result: '',
			usage: { input_tokens: 40, output_tokens: 9 },
			modelUsage,
			session_id: 'sdk-session',
		}, 'session-1', state).events.find(event => event.type === 'usage.changed');

		assistant('m-1', { input_tokens: 3, cache_read_input_tokens: 12_000, cache_creation_input_tokens: 500, output_tokens: 80 }, null, 'claude-sonnet');
		assistant('m-2', { input_tokens: 90_000, output_tokens: 1 }, 'toolu_sub', 'claude-haiku');
		const first = result({ 'claude-sonnet': { contextWindow: 200_000 }, 'claude-haiku': { contextWindow: 100_000 } });
		assistant('m-3', { input_tokens: 3, cache_read_input_tokens: 12_000, cache_creation_input_tokens: 500, output_tokens: 80 }, null, 'claude-sonnet');
		const ambiguous = result({ 'claude-opus': { contextWindow: 200_000 }, 'claude-haiku': { contextWindow: 100_000 } });
		// A turn that ends before any main-loop assistant message (an immediate error) does not repeat the last size.
		const empty = result({ 'claude-sonnet': { contextWindow: 200_000 } });
		assert.deepStrictEqual([first, ambiguous, empty].map(event => event?.type === 'usage.changed' ? event.usage : undefined), [
			{ inputTokens: 40, outputTokens: 9, contextTokens: 12_583, contextWindow: 200_000 },
			{ inputTokens: 40, outputTokens: 9, contextTokens: 12_583, contextWindow: undefined },
			{ inputTokens: 40, outputTokens: 9 },
		]);
	});

	test('prices a subagent run from its tokens, cache rates included (issue 836)', () => {
		const state = createClaudeNormalizerState();
		normalizeClaudeMessage({
			type: 'assistant',
			message: { id: 'm-1', model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 1, output_tokens: 1 } },
			parent_tool_use_id: null,
			session_id: 'sdk-session',
		}, 'session-1', state);
		const usage = normalizeClaudeMessage({
			type: 'result',
			subtype: 'success',
			is_error: false,
			result: '',
			usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 400_000 },
			parent_tool_use_id: 'toolu_sub',
			session_id: 'sdk-session',
		}, 'session-1', state).events.flatMap(event => event.type === 'usage.changed' ? [event.usage] : []);
		assert.deepStrictEqual(usage.map(item => [item.cacheReadTokens, item.cacheWriteTokens, item.costUsd]), [[2_000_000, 400_000, 3 + 1.5 + 0.6 + 1.5]]);
	});

	test('reports fast mode once when it changes, never when it repeats (issue 456)', () => {
		const state = createClaudeNormalizerState();
		const fast = (events: readonly { type: string }[]) => events.flatMap(item => item.type === 'session.fastMode' ? [item as unknown as { status: unknown; previous?: unknown }] : []).map(item => [item.status, item.previous]);
		const init = { type: 'system', subtype: 'init', session_id: 'sdk-session', model: 'm', fast_mode_state: 'on' };
		const result = (extra: Record<string, unknown>) => ({ type: 'result', subtype: 'success', is_error: false, result: '', usage: { input_tokens: 1, output_tokens: 1 }, parent_tool_use_id: null, session_id: 'sdk-session', ...extra });
		const out = [
			fast(normalizeClaudeMessage(init, 'session-1', state).events),
			fast(normalizeClaudeMessage(result({ fast_mode_state: 'on' }), 'session-1', state).events),
			fast(normalizeClaudeMessage(result({ fast_mode_state: 'cooldown', fast_mode_cooldown_until: 4_102_444_800 }), 'session-1', state).events),
			fast(normalizeClaudeMessage(result({ fast_mode_state: 'cooldown', fast_mode_cooldown_until: 4_102_444_900 }), 'session-1', state).events),
			fast(normalizeClaudeMessage(result({}), 'session-1', state).events),
		];
		assert.deepStrictEqual(out, [
			[[{ state: 'on' }, undefined]],
			[],
			[[{ state: 'cooldown', resumesAt: 4_102_444_800_000 }, { state: 'on' }]],
			[],
			[],
		]);
	});
});

function readJson(name: string): unknown {
	return JSON.parse(readFileSync(join(process.cwd(), 'test', 'claude', 'fixtures', 'sdk', name), 'utf8'));
}
