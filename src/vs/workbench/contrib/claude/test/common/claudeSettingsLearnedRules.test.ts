/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CLAUDE_REVIEW_LEARN_AFTER_SETTING } from '../../../../../platform/claude/common/claudeReviewLearning.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeSettingsPages } from '../../common/claudeSettingsPages.js';

suite('Claude Settings learned rules (issue 1068)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const reviewRows = () => claudeSettingsPages().flatMap(page => page.sections).find(section => section.id === 'review')?.rows ?? [];

	test('the Review section has the Learn After number and the Learned Rules list', () => {
		const rows = reviewRows();
		const learnAfter = rows.find(row => row.id === 'learnAfter');
		assert.strictEqual(learnAfter?.key, CLAUDE_REVIEW_LEARN_AFTER_SETTING);
		assert.strictEqual(learnAfter?.control.kind, 'number');
		assert.strictEqual(rows.find(row => row.id === 'learnedRules')?.control.kind, 'learnedRules');
	});

	test('the Review section has a Statistics row (issue 937)', () => {
		assert.strictEqual(reviewRows().find(row => row.id === 'reviewStats')?.control.kind, 'reviewStats');
	});

	test('row ids are unique in the Review section', () => {
		const ids = reviewRows().map(row => row.id);
		assert.strictEqual(new Set(ids).size, ids.length);
	});
});
