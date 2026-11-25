/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CLAUDE_MAKER_RECHECK_MS, claudeEffectiveMakerRole, claudeMakerNeedsRecheck, claudeMakerVerdict, parseClaudeMakerVerdict } from '../../common/claudeMakerRole.js';

suite('Klawly maker role (issue 1184)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('admin or maintain on the repo makes a maker; read-only and bad data do not', () => {
		assert.deepStrictEqual([
			claudeMakerVerdict({ id: 7, login: 'x' }, { permissions: { admin: true } }, 10),
			claudeMakerVerdict({ id: 7 }, { permissions: { admin: false, maintain: true } }, 10),
			claudeMakerVerdict({ id: 7 }, { permissions: { admin: false, push: true } }, 10),
			claudeMakerVerdict({ id: 7 }, { permissions: { admin: 'true' } }, 10),
			claudeMakerVerdict({ id: 7 }, undefined, 10),
			claudeMakerVerdict({ login: 'MehdiMamas' }, { permissions: { admin: true } }, 10),
			claudeMakerVerdict({ id: '7' }, { permissions: { admin: true } }, 10),
		], [
			{ userId: 7, role: 'maker', checkedAt: 10 },
			{ userId: 7, role: 'maker', checkedAt: 10 },
			{ userId: 7, role: 'user', checkedAt: 10 },
			{ userId: 7, role: 'user', checkedAt: 10 },
			{ userId: 7, role: 'user', checkedAt: 10 },
			undefined,
			undefined,
		]);
	});

	test('the role is re-checked daily, for another account, and after a clock step back', () => {
		const verdict = { userId: 7, role: 'maker', checkedAt: 1000 } as const;
		assert.deepStrictEqual([
			claudeMakerNeedsRecheck(undefined, 7, 1000),
			claudeMakerNeedsRecheck(verdict, 7, 1000 + CLAUDE_MAKER_RECHECK_MS - 1),
			claudeMakerNeedsRecheck(verdict, 7, 1000 + CLAUDE_MAKER_RECHECK_MS),
			claudeMakerNeedsRecheck(verdict, 8, 2000),
			claudeMakerNeedsRecheck(verdict, 7, 500),
			claudeMakerNeedsRecheck(verdict, undefined, 2000),
		], [true, false, true, true, true, false]);
	});

	test('signing out or switching account drops the role at once', () => {
		const verdict = { userId: 7, role: 'maker', checkedAt: 1000 } as const;
		assert.deepStrictEqual([
			claudeEffectiveMakerRole(verdict, 7),
			claudeEffectiveMakerRole(verdict, undefined),
			claudeEffectiveMakerRole(verdict, 8),
			claudeEffectiveMakerRole(undefined, 7),
		], ['maker', 'user', 'user', 'user']);
	});

	test('a stored verdict is read back; damaged entries are not', () => {
		const verdict = { userId: 7, role: 'maker', checkedAt: 10 };
		assert.deepStrictEqual([
			parseClaudeMakerVerdict(JSON.stringify(verdict)),
			parseClaudeMakerVerdict('{"userId":"7","role":"maker","checkedAt":1}'),
			parseClaudeMakerVerdict('{"userId":7,"role":"root","checkedAt":1}'),
			parseClaudeMakerVerdict('not json'),
			parseClaudeMakerVerdict(undefined),
		], [verdict, undefined, undefined, undefined, undefined]);
	});
});
