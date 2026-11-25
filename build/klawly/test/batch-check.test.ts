/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Run: node --test build/klawly/test/batch-check.test.ts

import assert from 'assert';
import { suite, test } from 'node:test';
import { baselineFiles, buildResult, prsForFailure, touchesUi, unionChangedFiles } from '../batch-check.ts';

const PANE = 'src/vs/workbench/contrib/claude/browser/claudePane.ts';
const MODEL = 'src/vs/platform/claude/common/claudeAutoModel.ts';
const PER_PR = new Map<string, string[]>([
	['101', [PANE, 'docs/a.md']],
	['102', [MODEL, 'src/vs/platform/claude/test/common/claudeAutoModel.test.ts']],
]);

suite('batch-check', () => {
	test('unionChangedFiles dedupes, normalizes slashes and sorts', () => {
		const union = unionChangedFiles(new Map([['1', ['b.ts', 'a\\x.ts']], ['2', ['b.ts', 'a/x.ts']]]));
		assert.deepStrictEqual(union, ['a/x.ts', 'b.ts']);
	});

	test('touchesUi: pane code yes, platform and tests no', () => {
		assert.deepStrictEqual([PANE, MODEL, 'docs/a.md'].map(file => touchesUi([file])), [true, false, false]);
	});

	test('prsForFailure points at the PR whose file the log names', () => {
		assert.deepStrictEqual(prsForFailure(`error TS2322 in ${PANE.replace(/\//g, '\\')}(4,1)`, PER_PR), { prs: ['101'], attributed: true });
	});

	test('prsForFailure follows a failing test back to the PR that changed its source', () => {
		const covers = new Map([[MODEL, ['src/vs/platform/claude/test/common/claudeAutoModelOther.test.ts']]]);
		assert.deepStrictEqual(prsForFailure('FAIL claudeAutoModelOther.test.ts\n at src/vs/platform/claude/test/common/claudeAutoModelOther.test.ts', PER_PR, covers), { prs: ['102'], attributed: true });
	});

	test('prsForFailure blames every PR when the log names nothing', () => {
		assert.deepStrictEqual(prsForFailure('out of memory', PER_PR), { prs: ['101', '102'], attributed: false });
	});

	test('buildResult: notes only on failed steps, screenshots only on UI PRs', () => {
		const result = buildResult(
			[{ name: 'compile', ok: true, logTail: '' }, { name: 'typecheck', ok: false, logTail: `error in ${MODEL}` }],
			PER_PR, new Map(), ['design/.parity/batch/dark-large-home.png']);
		assert.deepStrictEqual(result.prs, {
			'101': { notes: [], screenshots: ['design/.parity/batch/dark-large-home.png'] },
			'102': { notes: ['typecheck failed and names files this PR changed'], screenshots: [] },
		});
	});

	test('a baseline run falls back to the last commit when the diff against the base is empty', () => {
		assert.deepStrictEqual(baselineFiles([], () => ['a.ts']), ['a.ts']);
		assert.deepStrictEqual(baselineFiles(['b.ts'], () => ['a.ts']), ['b.ts']);
	});
});
