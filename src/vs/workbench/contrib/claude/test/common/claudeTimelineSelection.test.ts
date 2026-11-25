/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { quoteForReply, SELECTION_SCROLL_MAX_STEP, selectionScrollStep } from '../../common/claudeTimelineSelection.js';

suite('Claude timeline selection (issue 468)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a selecting drag scrolls only at or past an edge, faster the further past, up to a cap', () => {
		const top = 100;
		const bottom = 500;
		assert.deepStrictEqual([
			selectionScrollStep(300, top, bottom),
			selectionScrollStep(117, top, bottom),
			selectionScrollStep(113, top, bottom),
			selectionScrollStep(40, top, bottom),
			selectionScrollStep(483, top, bottom),
			selectionScrollStep(487, top, bottom),
			selectionScrollStep(560, top, bottom),
			selectionScrollStep(5000, top, bottom),
		], [0, 0, -1, -26, 0, 1, 26, SELECTION_SCROLL_MAX_STEP]);
	});

	test('Quote in Reply quotes every line, keeps blank lines inside, and drops them at the ends', () => {
		assert.deepStrictEqual([
			quoteForReply('Run npm test'),
			quoteForReply('\r\nFirst line  \r\n\r\nSecond line\r\n\r\n'),
			quoteForReply(' \n\t\n'),
		], [
			'> Run npm test\n\n',
			'> First line\n>\n> Second line\n\n',
			'',
		]);
	});
});
