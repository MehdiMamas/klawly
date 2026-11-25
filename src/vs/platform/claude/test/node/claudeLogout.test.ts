/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeNodeRuntimeService } from '../../node/claudeNodeRuntimeService.js';
import { parseAuthStatusAccount } from '../../node/claudeRuntime.js';

/**
 * Log Out and Switch Account (issue 536) run `claude auth logout` and probe
 * again. Klawly never reads or deletes Claude Code's credentials itself.
 */
suite('Claude log out', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const signedIn = '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"ada@example.com","orgName":"Example","subscriptionType":"max"}';

	function service(fail?: string) {
		const calls: string[] = [];
		let status = signedIn;
		const runtime = store.add(new ClaudeNodeRuntimeService({
			runtimePath: process.execPath,
			execFile: async (_file: string, args: readonly string[]) => {
				calls.push(args.join(' '));
				if (args[0] === '--version') {
					return { stdout: '2.1.288\n', stderr: '' };
				}
				if (args[0] === 'auth' && args[1] === 'logout') {
					if (fail) {
						throw Object.assign(new Error('Command failed'), { stderr: `${fail}\n` });
					}
					status = '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}';
					return { stdout: 'Successfully logged out\n', stderr: '' };
				}
				if (args[0] === 'auth') {
					return { stdout: status, stderr: '' };
				}
				return { stdout: '', stderr: '' };
			},
		}));
		return { runtime, calls };
	}

	test('auth status account: only a signed-in answer with an account', () => {
		assert.deepStrictEqual([
			parseAuthStatusAccount(signedIn),
			parseAuthStatusAccount('{"loggedIn":false,"email":"ada@example.com"}'),
			parseAuthStatusAccount('{"loggedIn":true,"authMethod":"api_key","email":""}'),
			parseAuthStatusAccount('not json'),
		], [
			{ email: 'ada@example.com', organization: 'Example', plan: 'max', provider: 'firstParty' },
			undefined,
			undefined,
			undefined,
		]);
	});

	test('the overview shows the auth status account before any session reports one, and forgets it after a log out', async () => {
		const { runtime, calls } = service();
		const before = await runtime.ensureRuntime();
		const account = (await runtime.getAccountOverview()).account;
		const after = await runtime.logout();
		assert.deepStrictEqual({
			before: before.authenticated,
			account,
			after: { authenticated: after.authenticated, installed: after.installed },
			accountAfter: (await runtime.getAccountOverview()).account,
			calls,
		}, {
			before: true,
			account: { email: 'ada@example.com', organization: 'Example', plan: 'max', provider: 'firstParty' },
			after: { authenticated: false, installed: true },
			accountAfter: undefined,
			calls: ['--version', 'auth status', 'auth status', 'auth logout', '--version', 'auth status'],
		});
	});

	test('a failed log out surfaces what Claude Code printed and keeps the sign-in', async () => {
		const { runtime } = service('Not logged in with a Claude account');
		await runtime.ensureRuntime();
		const error = await runtime.logout().then(() => undefined, (failure: Error) => failure.message);
		assert.deepStrictEqual({ error, authenticated: (await runtime.ensureRuntime()).authenticated }, { error: 'Not logged in with a Claude account', authenticated: true });
	});
});
