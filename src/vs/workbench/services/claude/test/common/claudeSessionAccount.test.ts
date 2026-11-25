/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FakeClaudeRuntimeService } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { IOutputService } from '../../../output/common/output.js';
import { ClaudeAgentService } from '../../common/claudeAgentService.js';
import { agentWorkspaceStubs } from './claudeAgentTestUtils.js';

/** A chat runs on its own account and limit policy, and retry can move it to another account (issue 1385). */
suite('Claude session account', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create() {
		const fixtures = new Map([['plain-answer', [
			'{"type":"session.started","sessionId":"$session"}',
			'{"type":"assistant.completed","sessionId":"$session","text":"Done."}',
			'{"type":"session.completed","sessionId":"$session"}',
		].join('\n')]]);
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures));
		const begins: (string | undefined)[] = [];
		const begin = runtime.begin.bind(runtime);
		runtime.begin = async request => {
			begins.push(request.accountId);
			return begin(request);
		};
		const output = { _serviceBrand: undefined, getChannel: () => ({ append: () => undefined }) } as unknown as IOutputService;
		const agent = store.add(new ClaudeAgentService(runtime, output, ...agentWorkspaceStubs()));
		return { agent, begins };
	}

	async function until(read: () => boolean): Promise<void> {
		for (let i = 0; i < 200 && !read(); i++) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		assert.ok(read(), 'timed out waiting');
	}

	test('the chat account and policy are per chat and reach the runtime', async () => {
		const { agent, begins } = create();
		const first = agent.createSession();
		const second = agent.createSession();
		agent.setSessionAccount(first.id, 'work');
		agent.setSessionLimitPolicy(first.id, 'extraUsage');
		await agent.submit(first.id, 'Hello', '/repo');
		await agent.submit(second.id, 'Hello', '/repo');
		await until(() => begins.length === 2);
		assert.deepStrictEqual({
			begins,
			first: [agent.getSessionAccount(first.id), agent.getSessionLimitPolicy(first.id)],
			second: [agent.getSessionAccount(second.id), agent.getSessionLimitPolicy(second.id)],
		}, {
			begins: ['work', undefined],
			first: ['work', 'extraUsage'],
			second: [undefined, undefined],
		});
	});
});
