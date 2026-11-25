/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeAccountEntry } from '../../common/claudeAccounts.js';
import { claudeChatAccountLabel, claudeUsageRowAccountName, readClaudeDefaultAccountId, resolveClaudeChatAccount } from '../../common/claudeChatAccount.js';

const personal: ClaudeAccountEntry = { id: 'default', email: 'me@example.com', plan: 'max', signedIn: true, active: true };
const work: ClaudeAccountEntry = { id: 'work', email: 'me@work.example', plan: 'pro', signedIn: true, active: false };
const signedOut: ClaudeAccountEntry = { id: 'old', email: 'old@example.com', signedIn: false, active: false };

suite('Claude per-chat account (issue 1181)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('chat pick beats parent, global default and active account', () => {
		const accounts = [personal, work];
		assert.deepStrictEqual([
			resolveClaudeChatAccount({ accounts, chatAccountId: 'work', parentAccountId: 'default', globalDefaultAccountId: 'default' }),
			resolveClaudeChatAccount({ accounts, parentAccountId: 'work', globalDefaultAccountId: 'default' }),
			resolveClaudeChatAccount({ accounts, globalDefaultAccountId: 'work' }),
			resolveClaudeChatAccount({ accounts }),
		], [
			{ accountId: 'work', source: 'chat' },
			{ accountId: 'work', source: 'parent' },
			{ accountId: 'work', source: 'default' },
			{ accountId: 'default', source: 'active' },
		]);
	});

	test('a removed or signed-out pick falls through to the next choice', () => {
		const accounts = [personal, work, signedOut];
		assert.deepStrictEqual([
			resolveClaudeChatAccount({ accounts, chatAccountId: 'gone', globalDefaultAccountId: 'work' }),
			resolveClaudeChatAccount({ accounts, chatAccountId: 'old', parentAccountId: 'old' }),
		], [
			{ accountId: 'work', source: 'default' },
			{ accountId: 'default', source: 'active' },
		]);
	});

	test('no usable account gives undefined', () => {
		assert.strictEqual(resolveClaudeChatAccount({ accounts: [{ ...signedOut, active: true }] }), undefined);
	});

	test('the global default setting reads strings only', () => {
		assert.deepStrictEqual([readClaudeDefaultAccountId(' work '), readClaudeDefaultAccountId(''), readClaudeDefaultAccountId(3)], ['work', undefined, undefined]);
	});

	test('chip label shows email and plan; usage row names the account only with several signed in', () => {
		assert.deepStrictEqual([
			claudeChatAccountLabel(personal),
			claudeChatAccountLabel({ id: 'x' }),
			claudeUsageRowAccountName([personal, work], 'work'),
			claudeUsageRowAccountName([personal, signedOut], 'default'),
			claudeUsageRowAccountName([personal, work], 'missing'),
		], ['me@example.com · Max', 'x', 'me@work.example · Pro', undefined, undefined]);
	});
});
