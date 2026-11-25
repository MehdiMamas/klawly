/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FakeClaudeRuntimeService } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { IOutputService } from '../../../output/common/output.js';
import { agentWorkspaceStubs } from './claudeAgentTestUtils.js';
import { ClaudeAgentService } from '../../common/claudeAgentService.js';

suite('Claude agent pane sessions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('create, select, and close sessions', () => {
		const agent = store.add(new ClaudeAgentService(store.add(new FakeClaudeRuntimeService(new Map())), output(), ...agentWorkspaceStubs()));
		const reasons: string[] = [];
		store.add(agent.onDidChangeSession(change => reasons.push(change.reason)));

		const first = agent.createSession();
		const second = agent.createSession();
		assert.strictEqual(first.title, 'New Agent');
		assert.strictEqual(second.title, 'New Agent 2');
		assert.strictEqual(first.mode, 'agent');
		assert.strictEqual(agent.getCurrentSession()?.id, second.id);
		assert.strictEqual(agent.getSessions().length, 2);

		agent.selectSession(first.id);
		assert.strictEqual(agent.getCurrentSession()?.id, first.id);
		agent.setDraft(first.id, 'keep this');
		agent.selectSession(second.id);
		agent.selectSession(first.id);
		assert.strictEqual(agent.getCurrentSession()?.draft, 'keep this');

		agent.closeSession(first.id);
		assert.strictEqual(agent.getCurrentSession()?.id, second.id);
		agent.closeSession(second.id);
		assert.strictEqual(agent.getCurrentSession(), undefined);
		assert.deepStrictEqual(reasons, ['created', 'created', 'selected', 'selected', 'selected', 'closed', 'closed']);
	});

	test('a new chat takes the lowest default number no open tab uses', async () => {
		const agent = store.add(new ClaudeAgentService(store.add(new FakeClaudeRuntimeService(new Map())), output(), ...agentWorkspaceStubs()));
		const titles = () => agent.getSessions().map(session => session.title);

		const first = agent.createSession();
		const second = agent.createSession();
		const third = agent.createSession();
		agent.closeSession(first.id);
		agent.closeSession(second.id);
		agent.closeSession(third.id);
		agent.createSession();
		const afterCloseAll = titles();

		const two = agent.createSession();
		agent.closeSession(agent.getSessions()[0].id);
		agent.createSession();
		agent.createSession();
		const afterGap = titles();

		// Renamed, continued and lone closed chats free their numbers.
		await agent.renameSession(two.id, 'Named');
		await agent.continueInNewSession(two.id);
		agent.createSession();
		const afterRename = titles();
		for (const session of agent.getSessions()) {
			agent.closeSession(session.id);
		}
		agent.closeSession(agent.createSession().id);
		agent.createSession();

		assert.deepStrictEqual({ afterCloseAll, afterGap, afterRename, final: titles() }, {
			afterCloseAll: ['New Agent'],
			afterGap: ['New Agent 2', 'New Agent', 'New Agent 3'],
			afterRename: ['Named', 'New Agent', 'New Agent 3', 'Continue: Named', 'New Agent 2'],
			final: ['New Agent'],
		});
	});

	test('setNextModel stores a reported model and does not call the runtime', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(new Map()));
		let setCalls = 0;
		runtime.setModel = async () => { setCalls++; };
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();

		await agent.setNextModel(session.id, 'fixture-opus');
		assert.strictEqual(setCalls, 0);
		assert.strictEqual(agent.getCurrentSession()?.modelId, 'fixture-opus');
		assert.strictEqual(agent.getCurrentSession()?.modelName, 'Fixture Opus');
	});

	test('an empty runtime catalog is not replaced with model names', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(new Map()));
		runtime.listModels = async () => [];
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();

		await assert.rejects(() => agent.setNextModel(session.id, 'fixture-sonnet'), /has not reported any models/);
		assert.strictEqual(agent.getCurrentSession()?.modelId, undefined);
		await assert.rejects(() => agent.setNextModel(session.id, 'made-up'), /has not reported any models/);
	});

	test('a model outside the reported list is rejected', async () => {
		const agent = store.add(new ClaudeAgentService(store.add(new FakeClaudeRuntimeService(new Map())), output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await assert.rejects(() => agent.setNextModel(session.id, 'not-a-model'), /not in the list/);
		assert.strictEqual(agent.getCurrentSession()?.modelId, undefined);
	});

});

function output(): IOutputService {
	return {
		_serviceBrand: undefined,
		getChannel: () => ({ append: () => undefined }),
	} as unknown as IOutputService;
}
