/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeAccountEntry } from '../../../../../platform/claude/common/claudeAccounts.js';
import { claudeAccountsUsageRows, readClaudeKnownUsage, withClaudeKnownUsage } from '../../common/claudeAccountsUsage.js';

suite('Claude accounts usage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const personal: ClaudeAccountEntry = { id: 'default', email: 'me@example.com', plan: 'max', signedIn: true, active: true };
	const work: ClaudeAccountEntry = { id: 'work', email: 'me@work.com', plan: 'pro', signedIn: true, active: false };

	test('marks the account that resets first and shows the windows side by side', () => {
		const now = 1000;
		let known = withClaudeKnownUsage({}, 'default', [{ kind: 'session', percent: 40, resetsAt: 9000 }, { kind: 'week', percent: 10, resetsAt: 99000 }], 500);
		known = withClaudeKnownUsage(known, 'work', [{ kind: 'session', percent: 90, resetsAt: 5000 }], 600);
		assert.deepStrictEqual(
			claudeAccountsUsageRows([personal, work], known, now).map(row => [row.label, row.windows.length, row.resetsAt, row.resetsFirst]),
			[['me@example.com · Max', 2, 9000, false], ['me@work.com · Pro', 1, 5000, true]],
		);
	});

	test('gives no rows below two signed-in accounts, and no mark for accounts never read', () => {
		assert.deepStrictEqual(claudeAccountsUsageRows([personal], {}, 0), []);
		assert.deepStrictEqual(claudeAccountsUsageRows([personal, { ...work, signedIn: false }], {}, 0), []);
		assert.deepStrictEqual(claudeAccountsUsageRows([personal, work], {}, 0).map(row => row.resetsFirst), [false, false]);
	});

	test('reads stored usage safely', () => {
		const stored = JSON.stringify(withClaudeKnownUsage({}, 'work', [{ kind: 'week', percent: 5 }], 7));
		assert.deepStrictEqual(readClaudeKnownUsage(stored), { work: { checkedAt: 7, windows: [{ kind: 'week', percent: 5 }] } });
		assert.deepStrictEqual([readClaudeKnownUsage(undefined), readClaudeKnownUsage('nope'), readClaudeKnownUsage('[1]')], [{}, {}, {}]);
	});
});
