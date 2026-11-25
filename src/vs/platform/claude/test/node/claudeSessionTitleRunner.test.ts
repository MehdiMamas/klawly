/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NormalizedClaudeEvent } from '../../common/claudeProtocol.js';
import { ClaudeAgentRunRequest, ClaudeAgentRunner, ClaudePermissionBridge, ClaudeSessionTitleRequest } from '../../node/claudeAgentRunner.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery } from '../../node/claudeQuery.js';

/**
 * The runner names a fresh chat once, after its first finished turn, and sends the
 * title as `session.titled` so the pane can replace the cut-off first request.
 */
suite('Claude session title runner', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function answeringQuery(released: Promise<void>, subtype: 'success' | 'error_during_execution' = 'success'): ClaudeQuery {
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: 'system', subtype: 'init', session_id: 'sdk-session' };
				yield { type: 'result', subtype, is_error: subtype !== 'success', result: 'ok', session_id: 'sdk-session' };
				await released;
			},
			interrupt: async () => undefined,
			setModel: async () => undefined,
			supportedModels: async () => [],
			supportedCommands: async () => [],
			stopTask: async () => undefined,
			close: () => undefined,
		};
	}

	async function run(request: Partial<ClaudeAgentRunRequest>, sessionTitle: (request: ClaudeSessionTitleRequest) => Promise<string | undefined>, subtype?: 'success' | 'error_during_execution'): Promise<{ events: NormalizedClaudeEvent[]; asked: ClaudeSessionTitleRequest[] }> {
		const registry = store.add(new ClaudeProcessRegistry());
		let release: () => void = () => undefined;
		const released = new Promise<void>(resolve => release = resolve);
		const events: NormalizedClaudeEvent[] = [];
		const asked: ClaudeSessionTitleRequest[] = [];
		const bridge: ClaudePermissionBridge = { request: async () => ({ behavior: 'deny', message: 'test' }) };
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				await start.prompt[Symbol.asyncIterator]().next();
				return answeringQuery(released, subtype);
			},
			onEvent: event => events.push(event),
			sessionTitle: async titleRequest => {
				asked.push(titleRequest);
				return sessionTitle(titleRequest);
			},
		}));
		const done = (async () => {
			for await (const event of runner.start({ sessionId: 's1', prompt: 'Add discount codes to the cart', cwd: process.cwd(), mode: 'agent', workspaceTrusted: true, permissionBridge: bridge, ...request })) {
				events.push(event);
			}
		})();
		store.add({ dispose: () => { release(); void done; } });
		for (let attempt = 0; attempt < 400 && !events.some(event => event.type === 'session.completed' || event.type === 'session.failed'); attempt++) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		// The title request settles on later turns of the event loop.
		await new Promise(resolve => setTimeout(resolve, 50));
		return { events, asked };
	}

	function titles(events: readonly NormalizedClaudeEvent[]): NormalizedClaudeEvent[] {
		return events.filter(event => event.type === 'session.titled');
	}

	test('a fresh chat gets one title after its first finished turn', async () => {
		const { events, asked } = await run({}, async () => ' Discount codes in cart ');
		const types = events.map(event => event.type);
		assert.deepStrictEqual({
			asked: asked.map(request => ({ sessionId: request.sessionId, claudeSessionId: request.claudeSessionId, firstPrompt: request.firstPrompt })),
			titles: titles(events),
			afterCompleted: types.indexOf('session.completed') < types.indexOf('session.titled'),
		}, {
			asked: [{ sessionId: 's1', claudeSessionId: 'sdk-session', firstPrompt: 'Add discount codes to the cart' }],
			titles: [{ type: 'session.titled', sessionId: 's1', title: 'Discount codes in cart' }],
			afterCompleted: true,
		});
	});

	test('no title for a resumed chat, a slash command, a failed turn or an empty answer', async () => {
		const resumed = await run({ resumeSessionId: 'sdk-older' }, async () => 'Resumed');
		const slash = await run({ prompt: '/compact' }, async () => 'Compact');
		const failed = await run({}, async () => 'Failed', 'error_during_execution');
		const empty = await run({}, async () => '  ');
		const thrown = await run({}, async () => { throw new Error('offline'); });
		assert.deepStrictEqual({
			asked: [resumed.asked.length, slash.asked.length, failed.asked.length, empty.asked.length, thrown.asked.length],
			titles: [resumed, slash, failed, empty, thrown].map(result => titles(result.events).length),
		}, { asked: [0, 0, 0, 1, 1], titles: [0, 0, 0, 0, 0] });
	});
});
