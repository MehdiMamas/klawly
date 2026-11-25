/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeUsageLimitFromRateLimitInfo } from '../../common/claudeAccounts.js';
import { ClaudeAccountStore } from '../../node/claudeAccountStore.js';
import { ClaudeNodeRuntimeService } from '../../node/claudeNodeRuntimeService.js';
import { createClaudeNormalizerState, normalizeClaudeMessage } from '../../node/claudeStreamNormalizer.js';
import { removeDirWithRetries } from './claudeTestFiles.js';

/**
 * Several Claude accounts (issue 450): each added one signs in inside its own
 * folder, which links to Claude Code's, and Klawly never writes Claude Code's
 * own folder or its credentials.
 */
suite('Claude accounts', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	let claudeDirectory: string;

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'klawly-accounts-'));
		claudeDirectory = join(root, 'home', '.claude');
		mkdirSync(join(claudeDirectory, 'projects', 'repo'), { recursive: true });
		mkdirSync(join(claudeDirectory, 'skills'), { recursive: true });
		writeFileSync(join(claudeDirectory, 'projects', 'repo', 'chat.jsonl'), '{}\n');
		writeFileSync(join(claudeDirectory, 'CLAUDE.md'), '# Rules\n');
	});

	teardown(() => removeDirWithRetries(root, 10, 100));

	test('mod state folders are shared with the account, so a mod sees one state on every account (issue 1270)', async () => {
		mkdirSync(join(claudeDirectory, 'model-router'), { recursive: true });
		mkdirSync(join(claudeDirectory, 'session-manager'), { recursive: true });
		writeFileSync(join(claudeDirectory, 'model-router', 'state.json'), '{"a":1}');
		const store = new ClaudeAccountStore(join(root, 'accounts'), claudeDirectory);
		const id = await store.create();
		const directory = store.directory(id);
		assert.deepStrictEqual({
			router: lstatSync(join(directory, 'model-router')).isSymbolicLink(),
			state: readFileSync(join(directory, 'model-router', 'state.json'), 'utf8'),
			manager: lstatSync(join(directory, 'session-manager')).isSymbolicLink(),
			missing: existsSync(join(directory, 'gaming')),
		}, { router: true, state: '{"a":1}', manager: true, missing: false });
		await store.remove(id);
	});

	test('an account folder links to Claude Code\'s folder, and removing it leaves what the links point to', async () => {
		const store = new ClaudeAccountStore(join(root, 'accounts'), claudeDirectory);
		const id = await store.create();
		const directory = store.directory(id);
		// The account's own sign-in, as Claude Code would write it there.
		writeFileSync(join(directory, '.claude.json'), '{}');
		const shared = {
			projects: lstatSync(join(directory, 'projects')).isSymbolicLink() && realpathSync(join(directory, 'projects')) === realpathSync(join(claudeDirectory, 'projects')),
			transcript: readFileSync(join(directory, 'projects', 'repo', 'chat.jsonl'), 'utf8'),
			skills: lstatSync(join(directory, 'skills')).isSymbolicLink(),
			// Nothing to link where Claude Code has no such folder.
			plans: existsSync(join(directory, 'plans')),
		};
		await store.remove(id);
		assert.deepStrictEqual({
			shared,
			removed: existsSync(directory),
			kept: [readFileSync(join(claudeDirectory, 'projects', 'repo', 'chat.jsonl'), 'utf8'), readFileSync(join(claudeDirectory, 'CLAUDE.md'), 'utf8'), existsSync(join(claudeDirectory, 'skills'))],
		}, {
			shared: { projects: true, transcript: '{}\n', skills: true, plans: false },
			removed: false,
			kept: ['{}\n', '# Rules\n', true],
		});
	});

	test('an account gets settings.json and CLAUDE.md even where files cannot be linked, and the user-scope .claude.json parts but never the sign-in (issue 1180)', async () => {
		const store = new ClaudeAccountStore(join(root, 'accounts'), claudeDirectory);
		writeFileSync(join(claudeDirectory, 'settings.json'), '{"enabledPlugins":{"a@b":true}}');
		writeFileSync(join(root, 'home', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x' }, mcpServers: { chat: { command: 'x' } }, projects: { '/ws': { hasTrustDialogAccepted: true, lastCost: 3 } } }));
		const id = await store.create();
		const directory = store.directory(id);
		writeFileSync(join(directory, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'b@x' } }));
		// Claude Code replaced the file in place of a link: the next link() shares it again.
		writeFileSync(join(claudeDirectory, 'settings.json'), '{"enabledPlugins":{"c@d":true}}');
		await store.link(id);
		assert.deepStrictEqual({
			settings: readFileSync(join(directory, 'settings.json'), 'utf8'),
			claudeMd: readFileSync(join(directory, 'CLAUDE.md'), 'utf8'),
			config: JSON.parse(readFileSync(join(directory, '.claude.json'), 'utf8')),
		}, {
			settings: '{"enabledPlugins":{"c@d":true}}',
			claudeMd: '# Rules\n',
			config: { oauthAccount: { emailAddress: 'b@x' }, mcpServers: { chat: { command: 'x' } }, projects: { '/ws': { hasTrustDialogAccepted: true } } },
		});
	});

	test('the store refuses the default account and malformed ids, and reads a broken list as none', async () => {
		const store = new ClaudeAccountStore(join(root, 'accounts'), claudeDirectory);
		mkdirSync(join(root, 'accounts'), { recursive: true });
		writeFileSync(join(root, 'accounts', 'accounts.json'), '{"active":"../x","accounts":[{"id":"../x"},{"id":"default"},{"id":"abc-1","email":"ada@example.com"}]}');
		assert.deepStrictEqual({
			read: await store.read(),
			refused: ['default', '../x', ''].map(id => { try { store.directory(id); return false; } catch { return true; } }),
		}, {
			read: { active: undefined, accounts: [{ id: 'abc-1', email: 'ada@example.com', plan: undefined, organization: undefined }] },
			refused: [true, true, true],
		});
	});

	function service() {
		const calls: string[] = [];
		/** Who is signed in, by `CLAUDE_CONFIG_DIR` ('' for the default folder). */
		const signedIn = new Map<string, string>([['', '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"ada@example.com","subscriptionType":"pro"}']]);
		const runtime = disposables.add(new ClaudeNodeRuntimeService({
			runtimePath: process.execPath,
			userDataPath: join(root, 'userData'),
			homeDirectory: join(root, 'home'),
			execFile: async (_file: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
				const folder = options?.env?.CLAUDE_CONFIG_DIR ?? '';
				const account = folder.startsWith(join(root, 'userData')) ? 'added' : 'default';
				calls.push(`${args.join(' ')} @${account}`);
				if (args[0] === '--version') {
					return { stdout: '2.1.299\n', stderr: '' };
				}
				if (args[0] === 'auth' && args[1] === 'logout') {
					signedIn.delete(account === 'added' ? folder : '');
					return { stdout: 'Successfully logged out\n', stderr: '' };
				}
				if (args[0] === 'auth') {
					return { stdout: signedIn.get(account === 'added' ? folder : '') ?? '{"loggedIn":false}', stderr: '' };
				}
				return { stdout: '', stderr: '' };
			},
		}));
		return { runtime, calls, signedIn };
	}

	test('adding an account switches every Claude process to its folder, and signing it out falls back to the default one', async () => {
		const { runtime, calls, signedIn } = service();
		await runtime.ensureRuntime();
		const signIn = await runtime.addAccount();
		// The Sign In terminal ran `claude auth login` in the new folder.
		signedIn.set(signIn.env.CLAUDE_CONFIG_DIR, '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"grace@example.com","subscriptionType":"max"}');
		const added = await runtime.finishAddAccount(signIn.id);
		const listed = (await runtime.listAccounts()).map(account => ({ email: account.email, plan: account.plan, active: account.active, signedIn: account.signedIn }));
		calls.length = 0;
		await runtime.ensureRuntime();
		const probedAs = [...calls];
		await runtime.signOutAccount(signIn.id);
		const after = (await runtime.listAccounts()).map(account => ({ email: account.email, active: account.active }));
		assert.deepStrictEqual({
			added: { email: added?.email, active: added?.active },
			listed,
			probedAs,
			after,
			folderRemoved: !existsSync(signIn.env.CLAUDE_CONFIG_DIR),
			transcriptKept: readFileSync(join(claudeDirectory, 'projects', 'repo', 'chat.jsonl'), 'utf8'),
		}, {
			added: { email: 'grace@example.com', active: true },
			listed: [
				{ email: 'ada@example.com', plan: 'pro', active: false, signedIn: true },
				{ email: 'grace@example.com', plan: 'max', active: true, signedIn: true },
			],
			probedAs: ['--version @added', 'auth status @added'],
			after: [{ email: 'ada@example.com', active: true }],
			folderRemoved: true,
			transcriptKept: '{}\n',
		});
	});

	test('a sign-in that ended signed out keeps nothing, and the same email again switches to the account it has', async () => {
		const { runtime, signedIn } = service();
		const cancelled = await runtime.addAccount();
		const kept = await runtime.finishAddAccount(cancelled.id);
		const again = await runtime.addAccount();
		signedIn.set(again.env.CLAUDE_CONFIG_DIR, '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com"}');
		const same = await runtime.finishAddAccount(again.id);
		assert.deepStrictEqual({
			kept,
			cancelledFolder: existsSync(cancelled.env.CLAUDE_CONFIG_DIR),
			same: { id: same?.id, active: same?.active },
			againFolder: existsSync(again.env.CLAUDE_CONFIG_DIR),
			accounts: (await runtime.listAccounts()).length,
		}, {
			kept: undefined,
			cancelledFolder: false,
			same: { id: 'default', active: true },
			againFolder: false,
			accounts: 1,
		});
	});

	test('reads Claude Code\'s rate-limit info into a plan limit', () => {
		assert.deepStrictEqual([
			claudeUsageLimitFromRateLimitInfo({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_800_000_000, utilization: 1 }),
			claudeUsageLimitFromRateLimitInfo({ status: 'allowed_warning', rateLimitType: 'seven_day_opus', utilization: 0.82 }),
			claudeUsageLimitFromRateLimitInfo({ status: 'rejected', rateLimitType: 'seven_day', overageStatus: 'rejected', overageDisabledReason: 'out_of_credits' }),
			claudeUsageLimitFromRateLimitInfo({ status: 'rejected', rateLimitType: 'something_new' }),
			claudeUsageLimitFromRateLimitInfo({ status: 'odd' }),
			claudeUsageLimitFromRateLimitInfo(undefined),
		], [
			{ window: 'session', status: 'rejected', resetsAt: 1_800_000_000_000, percent: 100, overage: undefined, model: undefined },
			{ window: 'weekOpus', status: 'warning', resetsAt: undefined, percent: 82, overage: undefined, model: 'opus' },
			{ window: 'week', status: 'rejected', resetsAt: undefined, percent: undefined, overage: { status: 'rejected', resetsAt: undefined, disabledReason: 'out_of_credits', inUse: undefined }, model: undefined },
			{ window: 'unknown', status: 'rejected', resetsAt: undefined, percent: undefined, overage: undefined, model: undefined },
			undefined,
			undefined,
		]);
	});

	test('a turn that stops on a plan limit names it: from the rate-limit event, after a warning, or out of credits', () => {
		const failedLimit = (messages: readonly Record<string, unknown>[]) => {
			const state = createClaudeNormalizerState();
			const events = messages.flatMap(message => normalizeClaudeMessage({ session_id: 'sdk-session', parent_tool_use_id: null, ...message }, 'session-1', state).events);
			const failed = events.find(event => event.type === 'session.failed');
			return failed?.type === 'session.failed' ? { kind: failed.kind, window: failed.limit?.window, resetsAt: failed.limit?.resetsAt } : undefined;
		};
		assert.deepStrictEqual([
			failedLimit([{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1_800_000_000 } }]),
			failedLimit([
				{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: 1_800_000_000 } },
				{ type: 'assistant', error: 'rate_limit', message: { role: 'assistant', content: '' } },
			]),
			failedLimit([{ type: 'assistant', error: 'billing_error', message: { role: 'assistant', content: '' } }]),
			failedLimit([{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } }]),
		], [
			{ kind: 'usage-limit', window: 'week', resetsAt: 1_800_000_000_000 },
			{ kind: 'usage-limit', window: 'session', resetsAt: 1_800_000_000_000 },
			{ kind: 'usage-limit', window: 'credits', resetsAt: undefined },
			undefined,
		]);
	});
});
