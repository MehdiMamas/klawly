/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeAgentRunner } from '../../node/claudeAgentRunner.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery } from '../../node/claudeQuery.js';

suite('Claude steer', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('steer pushes the next user message into the open streaming query', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'klawly-steer-'));
		const registry = store.add(new ClaudeProcessRegistry());
		let second = '';
		let releaseSecond: (() => void) | undefined;
		const sawSecond = new Promise<void>(resolve => { releaseSecond = resolve; });
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				const iterator = start.prompt[Symbol.asyncIterator]();
				const first = await iterator.next();
				assert.strictEqual(first.value?.message.content, 'Look');
				void iterator.next().then(result => {
					second = String(result.value?.message.content);
					releaseSecond?.();
				});
				return hangingQuery();
			},
		}));

		const events = runner.start({ sessionId: 'local-session', prompt: 'Look', cwd });
		const reading = readUntilStopped(events);
		await until(() => runner.canSteer('local-session'));
		assert.strictEqual(runner.steer('local-session', '  Also this  '), true);
		assert.strictEqual(runner.steer('missing', 'nope'), false);
		await sawSecond;
		assert.strictEqual(second, 'Also this');
		runner.disposeSession('local-session');
		assert.strictEqual(runner.canSteer('local-session'), false);
		await reading;
	});
});

function hangingQuery(): ClaudeQuery {
	let close: (() => void) | undefined;
	return {
		async *[Symbol.asyncIterator]() {
			await new Promise<void>(resolve => { close = resolve; });
		},
		interrupt: async () => undefined,
		setModel: async () => undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => close?.(),
	};
}

async function readUntilStopped(events: AsyncIterable<{ type: string }>): Promise<void> {
	for await (const event of events) {
		if (event.type === 'session.failed' || event.type === 'session.completed') {
			return;
		}
	}
}

async function until(read: () => boolean): Promise<void> {
	for (let i = 0; i < 50; i++) {
		if (read()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.fail('timed out waiting to steer');
}
