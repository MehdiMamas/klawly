/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { klawlyProjectIdentityFromAlias, klawlyProjectIdentityFromRemote, klawlyProjectIdentitySlug } from '../../common/klawlySyncProjectIdentity.js';

suite('Klawly Sync project identity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the same project gets the same identity from every remote spelling', () => {
		const spellings = [
			'git@github.com:Owner/Repo.git',
			'https://github.com/owner/repo',
			'https://user:token@github.com/Owner/Repo.git/',
			'ssh://git@github.com:22/owner/repo.git',
			'https://github.com/owner/repo?tab=readme#top',
		];
		assert.deepStrictEqual(spellings.map(klawlyProjectIdentityFromRemote), spellings.map(() => 'github.com/owner/repo'));
	});

	test('a remote that does not name an owner and repo has no identity', () => {
		assert.deepStrictEqual(
			['', '  ', 'nonsense', 'https://github.com/only', 'https://github.com/a/../b'].map(klawlyProjectIdentityFromRemote),
			[undefined, undefined, undefined, undefined, undefined]);
	});

	test('an alias names a project without a remote', () => {
		assert.deepStrictEqual(
			[klawlyProjectIdentityFromAlias(' My Notes! '), klawlyProjectIdentityFromAlias('   ')],
			['alias/my-notes', undefined]);
	});

	test('the slug is one safe path segment', () => {
		assert.deepStrictEqual(
			[klawlyProjectIdentitySlug('github.com/owner/repo'), klawlyProjectIdentitySlug('..x/y:z')],
			['github.com__owner__repo', '_x__y_z']);
	});
});
