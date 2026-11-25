/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeRuntimeState } from '../../../../../platform/claude/common/claude.js';
import { claudeAccountActions, claudeAccountPicks, claudeLogOutConfirmation, ClaudeLogOutHost, claudeShownAccount, klawlyClaudeServiceAccount, runClaudeLogOut } from '../../common/claudeAccountActions.js';
import { claudeLimitBanner, claudeLimitPolicyLine } from '../../common/claudeLimitBanner.js';

const ready: ClaudeRuntimeState = { installed: true, authenticated: true, version: '2.1.0', authMode: 'claude-account' };
const signedOut: ClaudeRuntimeState = { installed: true, authenticated: false, version: '2.1.0' };

suite('Claude account actions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Switch Account and Log Out only reach a Claude account sign-in', () => {
		const modes = ['claude-account', 'unknown', 'api-key', 'bedrock', 'vertex', 'enterprise'] as const;
		assert.deepStrictEqual({
			missing: claudeAccountActions({ installed: false, authenticated: false }),
			signedOut: claudeAccountActions(signedOut),
			...Object.fromEntries(modes.map(authMode => [authMode, claudeAccountActions({ ...ready, authMode })?.enabled])),
			reasons: modes.every(authMode => (claudeAccountActions({ ...ready, authMode })?.reason !== undefined) === !['claude-account', 'unknown'].includes(authMode)),
		}, {
			missing: undefined,
			signedOut: undefined,
			'claude-account': true,
			unknown: true,
			'api-key': false,
			bedrock: false,
			vertex: false,
			enterprise: false,
			reasons: true,
		});
	});

	test('the account is hidden once signed out, so the old email never stays on screen', () => {
		const account = { email: 'ada@example.com', plan: 'max' };
		assert.deepStrictEqual([claudeShownAccount(ready, account), claudeShownAccount(signedOut, account), claudeShownAccount(undefined, account)], [account, undefined, undefined]);
	});

	function host(running: readonly string[], answer: boolean) {
		const log: string[] = [];
		const fake: ClaudeLogOutHost = {
			runningSessions: () => running,
			confirm: async (kind, count) => { log.push(`confirm ${kind} ${count}`); return answer; },
			stop: async sessionId => { log.push(`stop ${sessionId}`); },
			logout: async () => { log.push('logout'); return signedOut; },
		};
		return { fake, log };
	}

	test('running agents stop after a confirm; nothing runs when the user keeps them', async () => {
		const idle = host([], false);
		const kept = host(['a'], false);
		const stopped = host(['a', 'b'], true);
		const results = [await runClaudeLogOut(idle.fake, 'logOut'), await runClaudeLogOut(kept.fake, 'logOut'), await runClaudeLogOut(stopped.fake, 'switchAccount')];
		assert.deepStrictEqual({ results, idle: idle.log, kept: kept.log, stopped: stopped.log }, {
			results: [signedOut, undefined, signedOut],
			idle: ['logout'],
			kept: ['confirm logOut 1'],
			stopped: ['confirm switchAccount 2', 'stop a', 'stop b', 'logout'],
		});
	});

	test('the confirm says the agents stop and Claude Code signs out everywhere on this computer', () => {
		assert.deepStrictEqual([claudeLogOutConfirmation('logOut', 1), claudeLogOutConfirmation('switchAccount', 3)], [
			{ message: 'Log out of Claude?', detail: '1 agent is running. It stops, and Claude Code signs out on this computer, in the terminal too.', primaryButton: '&&Log Out' },
			{ message: 'Switch Claude account?', detail: '3 agents are running. They stop, and Claude Code signs out on this computer, in the terminal too.', primaryButton: '&&Switch Account' },
		]);
	});

	test('the Claude row under the GitHub profile names the account kind and offers the sign-in of Claude itself (issue 446)', () => {
		const row = (state: ClaudeRuntimeState | undefined, plan?: string, agentEnabled = true) => {
			const account = klawlyClaudeServiceAccount(state, plan ? { email: 'ada@example.com', plan } : undefined, agentEnabled);
			return [account.id, account.label, account.signedIn, account.actions.map(action => [action.commandId, action.label, ...(action.args ?? [])].join(' '))];
		};
		assert.deepStrictEqual([
			row(ready, undefined, false),
			row(undefined),
			row({ installed: false, authenticated: false }),
			row(signedOut),
			row(ready, 'max'),
			row({ ...ready, authMode: 'api-key' }),
			row(signedOut, 'max'),
		], [
			['claude', 'Claude: Off', false, ['claude.enableAgent Turn On Claude Agent']],
			['claude', 'Claude: Checking...', false, []],
			['claude', 'Claude: Not Installed', false, ['claude.installRuntime Install Claude Code']],
			['claude', 'Claude: Signed Out', false, ['claude.signIn Log In']],
			['claude', 'Claude: Max', true, ['claude.switchAccount Switch Account...', 'claude.logOut Log Out']],
			['claude', 'Claude: API Key', true, ['claude.openSettings Plan & Usage plan']],
			['claude', 'Claude: Signed Out', false, ['claude.signIn Log In']],
		]);
	});

	test('Switch Account lists every account with its plan, marks the one in use, and offers a new sign-in where one is missing', () => {
		assert.deepStrictEqual(claudeAccountPicks([
			{ id: 'default', email: 'ada@example.com', plan: 'pro', signedIn: true, active: false },
			{ id: 'a1', email: 'grace@example.com', plan: 'max', organization: 'Example', signedIn: true, active: true },
			{ id: 'a2', email: 'lin@example.com', signedIn: false, active: false },
			{ id: 'a3', email: 'kim@example.com', signedIn: true, mismatch: true, active: false },
		]).map(pick => [pick.kind, pick.label, pick.description, pick.detail !== undefined, pick.signInAgain === true]), [
			['account', 'ada@example.com', 'Pro', false, false],
			['account', 'grace@example.com', 'Max · Example · In Use', false, false],
			['account', 'lin@example.com', undefined, true, true],
			['account', 'kim@example.com', undefined, true, true],
			['add', 'Add Account...', undefined, false, false],
		]);
	});

	test('the usage-limit banner names the limit and offers what the plan allows', () => {
		const banner = (limit: Parameters<typeof claudeLimitBanner>[0]) => {
			const model = claudeLimitBanner(limit, resetsAt => `at ${resetsAt}`);
			return [model.title, model.detail, model.note !== undefined, model.actions.map(action => action.id)];
		};
		assert.deepStrictEqual([
			banner({ window: 'session', status: 'rejected', resetsAt: 5, plan: 'pro' }),
			banner({ window: 'week', status: 'rejected', plan: 'max', overage: { inUse: true } }),
			banner({ window: 'weekOpus', status: 'rejected', plan: 'team' }),
			banner({ window: 'overage', status: 'rejected', resetsAt: 5, overage: { resetsAt: 9 }, plan: 'max' }),
			banner({ window: 'credits', status: 'rejected' }),
			banner(undefined),
		], [
			['You reached your 5-hour session limit.', 'Resets at 5.', false, ['switchAccount', 'extraUsage', 'upgrade']],
			['You reached your weekly limit.', undefined, false, ['switchAccount', 'upgrade']],
			['You reached your weekly Opus limit.', undefined, true, ['switchAccount']],
			['You used all of your extra usage.', 'Resets at 9.', false, ['switchAccount', 'extraUsage', 'upgrade']],
			['Your Claude Console credits ran out.', undefined, false, ['switchAccount', 'addCredits']],
			['Claude reached its current usage limit.', undefined, false, ['switchAccount']],
		]);
	});

	test('the policy line says what the chat does on a limit, and why it asks instead', () => {
		assert.deepStrictEqual([
			claudeLimitPolicyLine({ policy: 'ask', source: 'global' }, undefined),
			claudeLimitPolicyLine({ policy: 'extraUsage', source: 'global' }, { allowExtraUsage: true, extraUsageCapUsd: 20, allowApiFallback: false, kind: 'personal' }),
			claudeLimitPolicyLine({ policy: 'apiKey', source: 'chat' }, undefined),
			claudeLimitPolicyLine({ policy: 'ask', source: 'global', blocked: 'extraUsage' }, undefined),
			claudeLimitBanner({ window: 'week', status: 'rejected' }, undefined, 'Continuing on your API key.').policyLine,
		], [
			undefined,
			'Continuing on extra usage, up to $20.',
			'Continuing on your API key.',
			'Your policy is to keep going on extra usage, but this account does not allow it. Asking instead.',
			'Continuing on your API key.',
		]);
	});

	test('the banner offers to wait for a reset only when it is rejected and still ahead', () => {
		const waitUntil = (limit: Parameters<typeof claudeLimitBanner>[0]) => claudeLimitBanner(limit, undefined, undefined, 100).waitUntil;
		assert.deepStrictEqual([
			waitUntil({ window: 'session', status: 'rejected', resetsAt: 500 }),
			waitUntil({ window: 'session', status: 'rejected', resetsAt: 50 }),
			waitUntil({ window: 'session', status: 'rejected' }),
			waitUntil({ window: 'credits', status: 'rejected', resetsAt: 500 }),
			waitUntil(undefined),
		], [500, undefined, undefined, undefined, undefined]);
	});
});
