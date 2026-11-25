/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FAKE_CLAUDE_CATALOG, FakeClaudeRuntimeService } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { BeginClaudeRequest, ClaudeRunHandle } from '../../../../../platform/claude/common/claude.js';
import { NormalizedClaudeEvent } from '../../../../../platform/claude/common/claudeProtocol.js';
import { IOutputService } from '../../../output/common/output.js';
import { ClaudeAgentService } from '../../common/claudeAgentService.js';
import { agentWorkspaceStubs } from './claudeAgentTestUtils.js';

/** Phase 34: the session keeps the `/` menu catalog Claude Code lists. */
suite('Claude agent command catalog (Phase 34)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the session takes the commands and subagents Claude Code lists after init', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures()));
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		const current = agent.getCurrentSession()!;
		assert.deepStrictEqual({ commands: current.commands, agents: current.agents, names: current.slashCommands }, {
			commands: FAKE_CLAUDE_CATALOG.commands,
			agents: FAKE_CLAUDE_CATALOG.agents,
			names: ['compact', 'explain'],
		});
	});

	test('a new chat has its commands and skills before the first message (issue 968)', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures()));
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await until(() => agent.getCurrentSession()!.commands.length > 0);
		const current = agent.getCurrentSession()!;
		assert.deepStrictEqual({ id: current.id === session.id, commands: current.commands, agents: current.agents, turns: agent.getViewState(session.id).turns.length }, {
			id: true,
			commands: FAKE_CLAUDE_CATALOG.commands,
			agents: FAKE_CLAUDE_CATALOG.agents,
			turns: 0,
		});
	});

	test('a listing with no commands keeps the commands it had and takes the subagents', async () => {
		const runtime = store.add(new EmittingRuntime(fixtures()));
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		const runtimeId = runtime.lastHandle!;
		runtime.emit({ type: 'session.catalog', sessionId: runtimeId, commands: [], agents: [{ name: 'planner', description: 'Plans' }] });
		const current = agent.getCurrentSession()!;
		assert.deepStrictEqual({ commands: current.commands, agents: current.agents }, {
			commands: FAKE_CLAUDE_CATALOG.commands,
			agents: [{ name: 'planner', description: 'Plans' }],
		});
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

function fixtures(): Map<string, string> {
	return new Map([
		['plain-answer', [
			'{"type":"session.started","sessionId":"$session","model":"fixture-sonnet","slashCommands":["compact","explain"],"skills":["explain"]}',
			'{"type":"assistant.completed","sessionId":"$session","text":"Done."}',
			'{"type":"session.completed","sessionId":"$session"}',
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
