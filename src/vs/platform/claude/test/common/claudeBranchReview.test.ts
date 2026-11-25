/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_BRANCH_REVIEW_MAX_DIFF, chooseClaudeBranchReviewBase, claudeBranchReviewBases, claudeBranchReviewDiff, claudeBranchReviewDiffArguments, claudeBranchReviewKey } from '../../common/claudeBranchReview.js';

suite('Claude branch review', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the default branch is the first base, the current branch is never one', () => {
		const branches = ['feature', 'main', 'origin/main', 'origin/dev', 'origin/HEAD', 'zeta'];
		assert.deepStrictEqual({
			fromOriginHead: claudeBranchReviewBases({ originHead: 'origin/dev', branches, current: 'feature' }),
			fallback: claudeBranchReviewBases({ branches, current: 'feature' }),
			masterOnly: chooseClaudeBranchReviewBase({ branches: ['master', 'topic'], current: 'topic' }),
			onlyCurrent: chooseClaudeBranchReviewBase({ branches: ['main'], current: 'main' }),
		}, {
			fromOriginHead: ['origin/dev', 'origin/main', 'main', 'zeta'],
			fallback: ['origin/main', 'main', 'origin/dev', 'zeta'],
			masterOnly: 'master',
			onlyCurrent: undefined,
		});
	});

	test('the diff request compares from the merge base, or reads the index', () => {
		assert.deepStrictEqual({
			branch: claudeBranchReviewDiffArguments('branch', 'origin/main'),
			staged: claudeBranchReviewDiffArguments('staged', undefined),
			noBase: claudeBranchReviewDiffArguments('branch', undefined),
			option: claudeBranchReviewDiffArguments('branch', '--output=x'),
			keys: [claudeBranchReviewKey('branch'), claudeBranchReviewKey('staged')],
		}, {
			branch: ['diff', '--no-color', '--patch', '-M', 'origin/main...HEAD', '--'],
			staged: ['diff', '--no-color', '--patch', '-M', '--cached'],
			noBase: undefined,
			option: undefined,
			keys: ['branch', 'staged'],
		});
	});

	test('a long diff is cut with a note and flagged', () => {
		const long = claudeBranchReviewDiff('x'.repeat(CLAUDE_BRANCH_REVIEW_MAX_DIFF + 5));
		assert.deepStrictEqual({
			short: claudeBranchReviewDiff('diff'),
			truncated: long.truncated,
			length: long.diff.length > CLAUDE_BRANCH_REVIEW_MAX_DIFF,
			note: long.diff.endsWith('read the rest with git diff.]'),
		}, { short: { diff: 'diff', truncated: false }, truncated: true, length: true, note: true });
	});
});
