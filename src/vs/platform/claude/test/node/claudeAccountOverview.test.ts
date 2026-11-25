/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeMcpServerState, ClaudeUsageWindow, claudeUsageWindows } from '../../common/claudeAccount.js';
import { NormalizedClaudeEvent } from '../../common/claudeProtocol.js';
import { FAKE_CLAUDE_ACCOUNT_OVERVIEW, FakeClaudeRuntimeService } from '../../common/fakeClaudeRuntimeService.js';
import { ClaudeAgentRunner, ClaudePermissionBridge } from '../../node/claudeAgentRunner.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery } from '../../node/claudeQuery.js';

/**
 * Klawly Settings shows the account, plan limits, MCP servers, commands and
 * subagents that Claude Code reports. The runner keeps the last answers so the
 * pages still have them once the session ends.
 */
suite('Claude account overview', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const folders: string[] = [];

	teardown(() => {
		for (const folder of folders.splice(0)) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	test('usage windows: session first, clamped, unknown windows left out', () => {
		assert.deepStrictEqual(claudeUsageWindows({
			seven_day: { utilization: 140, resets_at: '2026-10-12T09:00:00Z' },
			five_hour: { utilization: 12.5, resets_at: 'not a date' },
			seven_day_opus: { utilization: null, resets_at: null },
			seven_day_sonnet: null,
			model_scoped: [{ display_name: 'Fable', utilization: -3, resets_at: null }],
		}), [
			{ kind: 'session', label: undefined, percent: 12.5, resetsAt: undefined },
			{ kind: 'week', label: undefined, percent: 100, resetsAt: Date.UTC(2026, 9, 12, 9, 0) },
			{ kind: 'model', label: 'Fable', percent: 0, resetsAt: undefined },
		]);
		assert.deepStrictEqual(claudeUsageWindows(undefined), []);
	});

	test('an MCP state Claude Code adds later reads as still starting', () => {
		assert.deepStrictEqual(['connected', 'needs-auth', 'disabled', 'reconnecting'].map(claudeMcpServerState), ['connected', 'needs-auth', 'disabled', 'pending']);
	});

	test('the fake runtime reports its fixture overview', async () => {
		const fake = store.add(new FakeClaudeRuntimeService(new Map()));
		assert.strictEqual(await fake.getAccountOverview(), FAKE_CLAUDE_ACCOUNT_OVERVIEW);
	});

	function overviewQuery(released: Promise<void>, failUsage: { value: boolean }): ClaudeQuery {
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: 'system', subtype: 'init', slash_commands: ['compact'], skills: [], session_id: 'sdk-session' };
				await released;
			},
			interrupt: async () => undefined,
			setModel: async () => undefined,
			supportedModels: async () => [],
			supportedCommands: async () => [{ name: 'compact', description: 'Compact', builtin: true }],
			supportedAgents: async () => [{ name: 'code-reviewer', description: 'Reviews' }],
			accountInfo: async () => ({ email: 'someone@example.invalid', plan: 'pro' }),
			usageLimits: async () => {
				if (failUsage.value) {
					throw new Error('usage unavailable');
				}
				return [{ kind: 'session', percent: 30 }];
			},
			mcpServerStatus: async () => [{ name: 'docs', state: 'connected', toolCount: 2 }],
			stopTask: async () => undefined,
			close: () => undefined,
		};
	}

	test('the runner asks the live session, then keeps the last answers', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'klawly-account-'));
		folders.push(cwd);
		const registry = store.add(new ClaudeProcessRegistry());
		let release: () => void = () => undefined;
		const released = new Promise<void>(resolve => release = resolve);
		const failUsage = { value: false };
		const events: NormalizedClaudeEvent[] = [];
		const bridge: ClaudePermissionBridge = { request: async () => ({ behavior: 'deny', message: 'test' }) };
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				await start.prompt[Symbol.asyncIterator]().next();
				return overviewQuery(released, failUsage);
			},
		}));
		const done = (async () => {
			for await (const event of runner.start({ sessionId: 's1', prompt: 'hi', cwd, mode: 'agent', workspaceTrusted: true, permissionBridge: bridge })) {
				events.push(event);
			}
		})();
		store.add({ dispose: () => { release(); void done; } });
		for (let attempt = 0; attempt < 400 && !(events.some(event => event.type === 'session.catalog') && events.some(event => event.type === 'session.usageLimits')); attempt++) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}

		// When Claude Code reported the plan limits is checked apart: it is the clock's.
		const read = async (sessionId?: string) => {
			const { usageCheckedAt, ...overview } = await runner.accountOverview(sessionId);
			return typeof usageCheckedAt === 'number' ? overview : { ...overview, usageCheckedAt };
		};
		const before = await read();
		const live = await read('s1');
		failUsage.value = true;
		const failed = await read('s1');
		runner.disposeSession('s1');
		const after = await read('s1');

		const known = {
			account: { email: 'someone@example.invalid', plan: 'pro' },
			usage: [{ kind: 'session', percent: 30 }],
			mcpServers: [{ name: 'docs', state: 'connected', toolCount: 2 }],
			commands: [{ name: 'compact', description: 'Compact', argumentHint: undefined, aliases: undefined, source: 'builtin' }],
			agents: [{ name: 'code-reviewer', description: 'Reviews' }],
		};
		// The session already sent its plan limits when it started.
		const catalogOnly = { account: undefined, usage: known.usage, mcpServers: undefined, commands: known.commands, agents: known.agents };
		assert.deepStrictEqual({ before, live, failed, after }, {
			before: { live: false, ...catalogOnly },
			live: { live: true, ...known },
			failed: { live: true, ...known },
			after: { live: false, ...known },
		});
	});

	test('with no session, the runner asks a short query for the plan limits, shares it, and reuses an answer for a minute (issue 704)', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		let started = 0;
		let closed = 0;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async () => {
				started++;
				return {
					async *[Symbol.asyncIterator]() { },
					interrupt: async () => undefined,
					setModel: async () => undefined,
					supportedModels: async () => [],
					supportedCommands: async () => [],
					usageLimits: async () => [{ kind: 'session', percent: 10 * started }],
					stopTask: async () => undefined,
					close: () => { closed++; },
				};
			},
		}));
		const target = { cwd: tmpdir() };
		const usage = async (refresh?: 'stale' | 'now', withTarget = true) => (await runner.accountOverview(undefined, refresh, withTarget ? target : undefined)).usage?.[0]?.percent;
		const together = await Promise.all([usage('stale'), usage('stale')]);
		const again = [await usage('stale'), await usage('now'), await usage(), await usage('stale', false)];
		const checked = typeof (await runner.accountOverview()).usageCheckedAt === 'number';
		runner.forgetAccount();
		const afterLogout = await usage('stale');
		assert.deepStrictEqual({ together, again, checked, afterLogout, started, closed }, {
			together: [10, 10],
			again: [10, 10, 10, 10],
			checked: true,
			afterLogout: 20,
			started: 2,
			closed: 2,
		});
	});

	test('after an account switch the old limits are not asked, a failed ask says so and no limits means none (issue 942)', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'klawly-account-'));
		folders.push(cwd);
		const registry = store.add(new ClaudeProcessRegistry());
		let release: () => void = () => undefined;
		const released = new Promise<void>(resolve => release = resolve);
		const failUsage = { value: false };
		const events: NormalizedClaudeEvent[] = [];
		const bridge: ClaudePermissionBridge = { request: async () => ({ behavior: 'deny', message: 'test' }) };
		// The session answers for the old account; a probe query, started with no prompt read, answers for the new one.
		let probeAnswer: () => Promise<readonly ClaudeUsageWindow[] | undefined> = async () => [{ kind: 'session', percent: 5 }];
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				if (start.options?.maxTurns === 1) {
					return { ...overviewQuery(released, failUsage), usageLimits: () => probeAnswer() };
				}
				await start.prompt[Symbol.asyncIterator]().next();
				return overviewQuery(released, failUsage);
			},
		}));
		const done = (async () => {
			for await (const event of runner.start({ sessionId: 's1', prompt: 'hi', cwd, mode: 'agent', workspaceTrusted: true, permissionBridge: bridge })) {
				events.push(event);
			}
		})();
		store.add({ dispose: () => { release(); void done; } });
		for (let attempt = 0; attempt < 400 && !events.some(event => event.type === 'session.usageLimits'); attempt++) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		const oldPercent = (await runner.accountOverview('s1')).usage?.[0]?.percent;
		runner.forgetAccount();
		const target = { cwd };
		const cleared = await runner.accountOverview('s1');
		const fromNewAccount = (await runner.accountOverview('s1', 'now', target)).usage?.[0]?.percent;
		probeAnswer = async () => { throw new Error('offline'); };
		runner.forgetAccount();
		const failedFirst = await runner.accountOverview('s1', 'now', target);
		probeAnswer = async () => undefined;
		runner.forgetAccount();
		const none = await runner.accountOverview('s1', 'now', target);
		assert.deepStrictEqual({
			oldPercent,
			cleared: [cleared.usage, cleared.usageFailed, cleared.live],
			fromNewAccount,
			failedFirst: [failedFirst.usage, failedFirst.usageFailed],
			none: [none.usage, none.usageFailed],
		}, {
			oldPercent: 30,
			cleared: [undefined, undefined, false],
			fromNewAccount: 5,
			failedFirst: [undefined, true],
			none: [[], undefined],
		});
	});

	test('the runner sends the plan limits when the session starts, on rate-limit events and after each turn', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'klawly-account-'));
		folders.push(cwd);
		const registry = store.add(new ClaudeProcessRegistry());
		const events: NormalizedClaudeEvent[] = [];
		const answers: (() => readonly ClaudeUsageWindow[] | undefined)[] = [
			() => [{ kind: 'session', percent: 42, resetsAt: 1000 }, { kind: 'week', percent: 18 }],
			// An API-key or cloud-provider account has no plan limits.
			() => undefined,
			() => { throw new Error('usage unavailable'); },
		];
		let calls = 0;
		const settle = () => new Promise(resolve => setTimeout(resolve, 5));
		const query: ClaudeQuery = {
			async *[Symbol.asyncIterator]() {
				yield { type: 'system', subtype: 'init', slash_commands: [], skills: [], session_id: 'sdk-session' };
				await settle();
				yield { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour' }, session_id: 'sdk-session' };
				await settle();
				yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sdk-session' };
				await settle();
			},
			interrupt: async () => undefined,
			setModel: async () => undefined,
			supportedModels: async () => [],
			supportedCommands: async () => [],
			usageLimits: async () => answers[calls++](),
			stopTask: async () => undefined,
			close: () => undefined,
		};
		const bridge: ClaudePermissionBridge = { request: async () => ({ behavior: 'deny', message: 'test' }) };
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				await start.prompt[Symbol.asyncIterator]().next();
				return query;
			},
		}));
		for await (const event of runner.start({ sessionId: 's1', prompt: 'hi', cwd, mode: 'agent', workspaceTrusted: true, permissionBridge: bridge })) {
			events.push(event);
		}
		runner.disposeSession('s1');

		assert.deepStrictEqual({
			calls,
			sent: events.filter(event => event.type === 'session.usageLimits').map(event => event.type === 'session.usageLimits' ? event.windows : undefined),
			kept: (await runner.accountOverview()).usage,
		}, {
			calls: 3,
			sent: [[{ kind: 'session', percent: 42, resetsAt: 1000 }, { kind: 'week', percent: 18 }], []],
			kept: [],
		});
	});

	test('each chat starts with the config folder of the account it chose, the active one by default (issue 1385)', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'klawly-account-'));
		folders.push(cwd);
		const registry = store.add(new ClaudeProcessRegistry());
		const bridge: ClaudePermissionBridge = { request: async () => ({ behavior: 'deny', message: 'test' }) };
		const startedWith: (string | undefined)[] = [];
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			processEnvironment: () => ({ CLAUDE_CONFIG_DIR: '/active' }),
			accountEnvironment: accountId => ({ CLAUDE_CONFIG_DIR: `/accounts/${accountId}` }),
			queryFactory: async start => {
				await start.prompt[Symbol.asyncIterator]().next();
				startedWith.push(start.options?.env?.CLAUDE_CONFIG_DIR);
				return overviewQuery(Promise.resolve(), { value: false });
			},
		}));
		for (const [sessionId, accountId] of [['a', undefined], ['b', 'work']] as const) {
			for await (const event of runner.start({ sessionId, prompt: 'hi', cwd, mode: 'agent', workspaceTrusted: true, permissionBridge: bridge, accountId })) {
				void event;
			}
		}
		assert.deepStrictEqual(startedWith, ['/active', '/accounts/work']);
	});
});
