/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { movePlanStep, renamePlanStep } from '../../../../../platform/claude/common/claudePlanEdit.js';
import { BeginClaudeRequest, ClaudeRunHandle, ClaudeUserInput } from '../../../../../platform/claude/common/claude.js';
import { FakeClaudeRuntimeService } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { IOutputService } from '../../../output/common/output.js';
import { agentWorkspaceStubs } from './claudeAgentTestUtils.js';
import { ClaudeAgentService } from '../../common/claudeAgentService.js';
import { EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../common/claudeAgentState.js';

const PLAN_ANSWER = '# Add expiry\\n\\nReject expired coupons.\\n\\n1. Check `expiresAt` in `src/coupon.ts`\\n2. Add tests';

suite('Claude agent modes', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options?: { stepDelayMs?: number }, firstFixture = 'plan-answer', files?: IFileService) {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), options));
		const begins: BeginClaudeRequest[] = [];
		const sends: ClaudeUserInput[] = [];
		const originalBegin = runtime.begin.bind(runtime);
		const originalSend = runtime.send.bind(runtime);
		runtime.begin = async (request: BeginClaudeRequest): Promise<ClaudeRunHandle> => {
			begins.push(request);
			return originalBegin({ ...request, fixture: begins.length === 1 ? firstFixture : 'plan-answer' });
		};
		runtime.send = async (sessionId: string, input: ClaudeUserInput) => {
			sends.push(input);
			await originalSend(sessionId, { ...input, fixture: 'plan-answer' });
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs({ files })));
		return { agent, begins, sends };
	}

	test('a new session starts in Agent and the mode selector changes it', () => {
		const { agent } = setup();
		const session = agent.createSession();
		assert.strictEqual(session.mode, 'agent');
		const reasons: string[] = [];
		store.add(agent.onDidChangeSession(change => reasons.push(change.reason)));
		agent.setMode(session.id, 'ask');
		agent.setMode(session.id, 'ask');
		assert.strictEqual(agent.getCurrentSession()?.mode, 'ask');
		assert.deepStrictEqual(reasons, ['mode']);
		assert.throws(() => agent.setMode('missing', 'plan'), /not open/);
	});

	test('the runtime receives the mode on the first turn and on later turns', async () => {
		const { agent, begins, sends } = setup();
		const session = agent.createSession();
		agent.setMode(session.id, 'ask');
		await agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		agent.setMode(session.id, 'plan');
		await agent.submit(session.id, 'Plan it', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		assert.deepStrictEqual(begins.map(request => request.mode), ['ask']);
		assert.deepStrictEqual(sends.map(input => input.mode), ['plan']);
		assert.strictEqual(agent.getViewState(session.id).turns[1].user.sent?.mode, 'plan');
	});

	test('the mode cannot change while a turn runs, and it is never switched silently', async () => {
		const { agent } = setup({ stepDelayMs: 40 });
		const session = agent.createSession();
		agent.setMode(session.id, 'ask');
		const pending = agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns.length === 1);
		assert.throws(() => agent.setMode(session.id, 'agent'), /Wait for the agent/);
		await agent.stop(session.id);
		await pending;
		assert.strictEqual(agent.getCurrentSession()?.mode, 'ask');
	});

	test('a Plan turn becomes a checklist and Build runs an Agent turn with the plan and notes', async () => {
		const { agent, begins, sends } = setup();
		const session = agent.createSession();
		agent.setMode(session.id, 'plan');
		agent.setDraft(session.id, 'half-typed draft');
		await agent.submit(session.id, 'Add expiry', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		const planTurn = agent.getViewState(session.id).turns[0];
		assert.strictEqual(planTurn.plan?.title, 'Add expiry');
		assert.deepStrictEqual(planTurn.plan?.steps.map(step => step.title), ['Check expiresAt in src/coupon.ts', 'Add tests']);
		assert.deepStrictEqual(begins.map(request => request.mode), ['plan']);

		agent.setDraft(session.id, 'next question');
		let compiledFrom: string | undefined;
		await agent.buildPlan(session.id, planTurn.id, 'keep the API', '/repo', async text => {
			compiledFrom = text;
			return `<wrapped>${text}</wrapped>`;
		});
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');

		assert.strictEqual(agent.getCurrentSession()?.mode, 'agent');
		assert.strictEqual(agent.getCurrentSession()?.draft, 'next question');
		assert.deepStrictEqual(sends.map(input => input.mode), ['agent']);
		assert.ok(compiledFrom?.includes('1. Check expiresAt in src/coupon.ts'));
		assert.ok(compiledFrom?.endsWith('Notes from the user:\nkeep the API'));
		assert.strictEqual(sends[0].text, `<wrapped>${compiledFrom}</wrapped>`);
		const buildTurn = agent.getViewState(session.id).turns[1];
		assert.strictEqual(buildTurn.user.text, 'Build: Add expiry\nkeep the API');
		assert.strictEqual(buildTurn.user.sent?.mode, 'agent');
	});

	test('Build is refused without a finished plan and leaves the mode alone', async () => {
		const { agent, sends } = setup();
		const session = agent.createSession();
		agent.setMode(session.id, 'ask');
		await agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		const turn = agent.getViewState(session.id).turns[0];
		await assert.rejects(() => agent.buildPlan(session.id, turn.id, '', '/repo'), /no finished plan/);
		await assert.rejects(() => agent.buildPlan(session.id, 'turn-x', '', '/repo'), /no finished plan/);
		assert.strictEqual(agent.getCurrentSession()?.mode, 'ask');
		assert.deepStrictEqual(sends, []);
	});

	test('a compile failure leaves Plan mode in place', async () => {
		const { agent } = setup();
		const session = agent.createSession();
		agent.setMode(session.id, 'plan');
		await agent.submit(session.id, 'Add expiry', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		const turn = agent.getViewState(session.id).turns[0];
		await assert.rejects(() => agent.buildPlan(session.id, turn.id, '', '/repo', async () => { throw new Error('no context'); }), /no context/);
		assert.strictEqual(agent.getCurrentSession()?.mode, 'plan');
	});

	test('Build sends the edited and reordered plan, and refuses an edit that adds or drops steps', async () => {
		const { agent, sends } = setup();
		const session = agent.createSession();
		agent.setMode(session.id, 'plan');
		await agent.submit(session.id, 'Add expiry', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		const planTurn = agent.getViewState(session.id).turns[0];
		const plan = planTurn.plan!;
		const edited = renamePlanStep(movePlanStep(plan, 'step-2', -1), 'step-1', 'Check the expiry date');

		await assert.rejects(() => agent.buildPlan(session.id, planTurn.id, '', '/repo', undefined, { ...plan, steps: plan.steps.slice(1) }), /no longer matches/);
		assert.strictEqual(agent.getCurrentSession()?.mode, 'plan');
		assert.deepStrictEqual(sends, []);

		let compiledFrom = '';
		await agent.buildPlan(session.id, planTurn.id, '', '/repo', async text => {
			compiledFrom = text;
			return text;
		}, edited);
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		assert.ok(compiledFrom.includes('The user edited or reordered the steps of your plan. Follow this version.'));
		assert.ok(compiledFrom.includes('1. Add tests\n2. Check the expiry date\n   Files: src/coupon.ts'));
		assert.strictEqual(agent.getViewState(session.id).turns[1].user.text, 'Build: Add expiry');
		assert.strictEqual(agent.getViewState(session.id).turns[0].plan, plan);
	});

	test('Open Plan writes the plan as Markdown and refuses a turn without a plan', async () => {
		const written: { uri: string; text: string }[] = [];
		const files = {
			writeFile: async (resource: URI, content: VSBuffer) => {
				written.push({ uri: resource.toString(), text: content.toString() });
			},
		} as unknown as IFileService;
		const { agent } = setup(undefined, 'plan-answer', files);
		const session = agent.createSession();
		agent.setMode(session.id, 'plan');
		await agent.submit(session.id, 'Add expiry', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		const planTurn = agent.getViewState(session.id).turns[0];
		const target = URI.file('/repo/plan.md');
		await agent.writePlanFile(session.id, planTurn.id, target, 'keep the API', movePlanStep(planTurn.plan!, 'step-2', -1));
		assert.deepStrictEqual(written, [{
			uri: target.toString(),
			text: '# Add expiry\n\nReject expired coupons.\n\n## To-dos\n\n1. Add tests\n2. Check `expiresAt` in `src/coupon.ts`\n   Files: `src/coupon.ts`\n\n## Notes\n\nkeep the API\n',
		}]);
		await assert.rejects(() => agent.writePlanFile(session.id, 'turn-x', target, ''), /no plan to save/);
		assert.strictEqual(written.length, 1);
	});

	test('retry keeps the mode the turn first ran in', async () => {
		const { agent, begins } = setup(undefined, 'crash');
		const session = agent.createSession();
		agent.setMode(session.id, 'ask');
		await agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'failed');
		agent.setMode(session.id, 'agent');
		await agent.retry(session.id, '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		assert.deepStrictEqual(begins.map(request => request.mode), ['ask', 'ask']);
	});

	test('only a Plan-mode turn that completes gets a plan', () => {
		const sent = (mode: 'plan' | 'ask') => ({ compiled: 'x', mode });
		for (const mode of ['plan', 'ask'] as const) {
			let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 't', text: 'x', sent: sent(mode) });
			state = reduceAgentState(state, { type: 'assistant.completed', sessionId: 's', text: '1. One\n2. Two' });
			state = reduceAgentState(state, { type: 'session.completed', sessionId: 's' });
			assert.strictEqual(state.turns[0].plan?.steps.length, mode === 'plan' ? 2 : undefined);
		}
		let failed = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 't', text: 'x', sent: sent('plan') });
		failed = reduceAgentState(failed, { type: 'assistant.completed', sessionId: 's', text: '1. One' });
		failed = reduceAgentState(failed, { type: 'turn.stopped' });
		assert.strictEqual(failed.turns[0].plan, undefined);
	});
});

function fixtures(): Map<string, string> {
	return new Map([
		['plan-answer', [
			'{"type":"session.started","sessionId":"$session","model":"fixture-sonnet"}',
			`{"type":"assistant.completed","sessionId":"$session","text":"${PLAN_ANSWER}"}`,
			'{"type":"session.completed","sessionId":"$session"}',
		].join('\n')],
		['crash', [
			'{"type":"session.started","sessionId":"$session"}',
			'{"type":"session.failed","sessionId":"$session","message":"process exited","kind":"process-crash"}',
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
	for (let i = 0; i < 100; i++) {
		if (read()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.fail('timed out waiting for the turn');
}
