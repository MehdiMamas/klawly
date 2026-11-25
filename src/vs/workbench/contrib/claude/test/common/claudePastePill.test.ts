/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextAttachment } from '../../../../../platform/claude/common/claudeContext.js';
import { claudePastePillAt, claudePastePillLabel, claudePastePillRuns, pruneClaudePastePills } from '../../common/claudePastePill.js';

suite('Claude paste pills', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const first: ContextAttachment = { kind: 'pasted-text', id: 'a', text: 'one\ntwo', lineCount: 2, label: 'Pasted text #1 +2 lines' };
	const third: ContextAttachment = { kind: 'pasted-text', id: 'c', text: 'x', lineCount: 1, label: 'Pasted text #3' };
	const chip: ContextAttachment = { kind: 'pasted-text', id: 'b', text: 'diff', lineCount: 1 };
	const file: ContextAttachment = { kind: 'file', uri: 'file:///a.ts' };

	test('issue 737: labels, pruning, one-key deletion and the marked runs', () => {
		const value = 'Why [Pasted text #1 +2 lines] and [Pasted text #3]?';
		assert.deepStrictEqual({
			labels: [claudePastePillLabel([], 12), claudePastePillLabel([first, third, chip, file], 1)],
			kept: pruneClaudePastePills(value, [first, third, chip, file]),
			pruned: pruneClaudePastePills('Why  and [Pasted text #3]?', [first, third, chip, file]),
			backspace: claudePastePillAt(value, value.indexOf(' and'), 'before', [first, third]),
			delete: claudePastePillAt(value, value.indexOf('[Pasted text #3]'), 'after', [first, third]),
			inside: claudePastePillAt(value, value.indexOf('#1'), 'before', [first, third]),
			runs: claudePastePillRuns(value, [first, third, chip]),
			noPills: claudePastePillRuns('plain', [chip]),
		}, {
			labels: ['Pasted text #1 +12 lines', 'Pasted text #4'],
			kept: undefined,
			pruned: [third, chip, file],
			backspace: { start: 4, end: 29 },
			delete: { start: 34, end: 50 },
			inside: undefined,
			runs: [
				{ text: 'Why ', pill: false },
				{ text: '[Pasted text #1 +2 lines]', pill: true },
				{ text: ' and ', pill: false },
				{ text: '[Pasted text #3]', pill: true },
				{ text: '?', pill: false },
			],
			noPills: [{ text: 'plain', pill: false }],
		});
	});
});
