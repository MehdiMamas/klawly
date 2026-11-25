/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FakeClaudeRuntimeService } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { BeginClaudeRequest, ClaudeRunHandle } from '../../../../../platform/claude/common/claude.js';
import { NormalizedClaudeEvent } from '../../../../../platform/claude/common/claudeProtocol.js';
import { IOutputService } from '../../../output/common/output.js';
import { ClaudeAgentService } from '../../common/claudeAgentService.js';
import { agentWorkspaceStubs } from './claudeAgentTestUtils.js';

const PROMPT = 'Add discount codes to the cart so a shopper can type SPRING10 at checkout and see the savings in the totals';

/** A chat shows its first request cut off until the runtime sends a short generated title. */
suite('Claude agent session title', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the generated title replaces the cut-off first request', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(true)));
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await agent.submit(session.id, PROMPT, '/repo');
		await until(() => agent.getCurrentSession()?.title === 'Discount codes in cart');
		assert.strictEqual(agent.getCurrentSession()?.title, 'Discount codes in cart');
	});

	test('the first request stays the title until one arrives, and only the first title counts', async () => {
		const runtime = store.add(new EmittingRuntime(fixtures(false)));
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await agent.submit(session.id, PROMPT, '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		const before = agent.getCurrentSession()?.title;
		runtime.emit({ type: 'session.titled', sessionId: runtime.lastHandle!, title: ' Discount codes in cart ' });
		const titled = agent.getCurrentSession()?.title;
		runtime.emit({ type: 'session.titled', sessionId: runtime.lastHandle!, title: 'Something else' });
		assert.deepStrictEqual({ before, titled, after: agent.getCurrentSession()?.title }, {
			before: PROMPT.slice(0, 80),
			titled: 'Discount codes in cart',
			after: 'Discount codes in cart',
		});
	});

	test('a name the user chose is never replaced', async () => {
		const runtime = store.add(new EmittingRuntime(fixtures(false)));
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await agent.submit(session.id, PROMPT, '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		await agent.renameSession(session.id, 'Cart work');
		runtime.emit({ type: 'session.titled', sessionId: runtime.lastHandle!, title: 'Discount codes in cart' });
		assert.strictEqual(agent.getCurrentSession()?.title, 'Cart work');
	});
});

class EmittingRuntime extends FakeClaudeRuntimeService {
	lastHandle: string | undefined;

	override async begin(request: BeginClaudeRequest): Promise<ClaudeRunHandle> {
		const handle = await super.begin(request);
		this.lastHandle = handle.sessionId;
		return handle;
	}

	emit(event: NormalizedClaudeEvent): void {
		this.emitEvent(event);
	}
}

function fixtures(titled: boolean): Map<string, string> {
	return new Map([
		['plain-answer', [
			'{"type":"session.started","sessionId":"$session","model":"fixture-sonnet"}',
			'{"type":"assistant.completed","sessionId":"$session","text":"Done."}',
			'{"type":"session.completed","sessionId":"$session"}',
			...(titled ? ['{"type":"session.titled","sessionId":"$session","title":"Discount codes in cart"}'] : []),
		].join('\n')],
	]);
}

function output(): IOutputService {
	return {
		_serviceBrand: undefined,
		getChannel: () => ({ append: () => undefined }),
	} as unknown as IOutputService;
}

async function until(read: () => boolean): Promise<void> {
	for (let i = 0; i < 80; i++) {
		if (read()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.fail('timed out');
}
