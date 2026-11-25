/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeModelInfo } from '../../../../../platform/claude/common/claude.js';
import { ClaudeAccountEntry, claudeAccountsSharingSignIn } from '../../../../../platform/claude/common/claudeAccounts.js';
import { claudeCheaperModelAction, claudeContinuedDivider, claudeEarlyWarning, claudeRefitModel, claudeRetryAccountActions } from '../../common/claudeAccountContinue.js';

const account = (id: string, email: string | undefined, extra: Partial<ClaudeAccountEntry> = {}): ClaudeAccountEntry => ({ id, email, signedIn: true, active: false, ...extra });
const model = (id: string, extra: Partial<ClaudeModelInfo> = {}): ClaudeModelInfo => ({ id, displayName: id, source: 'runtime', ...extra });

suite('Claude account continue', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('two folders on one sign-in flag the later added one, never the default', () => {
		const list = [account('default', 'A@x.com'), account('b', 'a@x.com'), account('c', 'c@x.com'), account('d', undefined, { signedIn: false })];
		assert.deepStrictEqual([...claudeAccountsSharingSignIn(list)], ['b']);
	});

	test('retry offers only other accounts that are signed in and distinct', () => {
		const list = [account('default', 'a@x.com', { active: true }), account('b', 'a@x.com'), account('c', 'c@x.com'), account('d', 'd@x.com', { mismatch: true }), account('e', undefined, { signedIn: false })];
		assert.deepStrictEqual(claudeRetryAccountActions(list, 'default').map(action => action.accountId), ['c']);
	});

	test('divider names the account and plan', () => {
		assert.deepStrictEqual([claudeContinuedDivider({ email: 'a@x.com', plan: 'max' }), claudeContinuedDivider({ email: 'a@x.com' })], ['Continued with a@x.com (max)', 'Continued with a@x.com']);
	});

	test('refit keeps a model that fits and picks the same family otherwise', () => {
		const available = [model('sonnet', { supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }), model('haiku')];
		assert.deepStrictEqual(claudeRefitModel({ model: 'sonnet', effort: 'high' }, available), { model: 'sonnet', effort: 'high', note: undefined });
		const moved = claudeRefitModel({ model: 'opus', effort: 'max' }, available);
		assert.deepStrictEqual([moved.model, moved.effort, !!moved.note], ['sonnet', 'high', true]);
		assert.strictEqual(claudeRefitModel({ model: 'haiku', effort: 'high' }, available).effort, undefined);
	});

	test('early warning appears at allowed_warning or 80 percent, not after the stop', () => {
		assert.deepStrictEqual([
			claudeEarlyWarning(undefined),
			claudeEarlyWarning({ window: 'session', status: 'allowed', percent: 79 }),
			claudeEarlyWarning({ window: 'session', status: 'allowed', percent: 85 }),
			claudeEarlyWarning({ window: 'week', status: 'warning' }),
			claudeEarlyWarning({ window: 'week', status: 'rejected', percent: 100 }),
		], [undefined, undefined, 'You have used 85% of your 5-hour session.', 'You are close to your weekly limit.', undefined]);
	});

	test('a per-model limit offers another family', () => {
		const available = [model('opus'), model('sonnet')];
		assert.strictEqual(claudeCheaperModelAction({ window: 'weekOpus', status: 'rejected', model: 'opus' }, available)?.model, 'sonnet');
		assert.strictEqual(claudeCheaperModelAction({ window: 'week', status: 'rejected' }, available), undefined);
	});
});
