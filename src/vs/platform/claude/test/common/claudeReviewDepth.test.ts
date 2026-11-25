/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { chooseClaudeReviewDepth, CLAUDE_REVIEW_DEPTH_SETTING, CLAUDE_REVIEW_MAX_TURNS_SETTING, CLAUDE_REVIEW_MODEL_SETTING, claudeReviewDepthAutomationLine, claudeReviewDepthMessage, claudeReviewDiffStats, claudeReviewModel, claudeReviewNeedsCostNote, mergeClaudeReviewFindings, planClaudeReviewRun, readClaudeReviewDepthSetting, readClaudeReviewMaxTurns, splitClaudeReviewDiff } from '../../common/claudeReviewDepth.js';
import { ClaudeReviewFinding } from '../../common/claudeReviewLoop.js';

function fileDiff(path: string, added: number): string {
	const lines = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1,1 +1,1 @@'];
	for (let i = 0; i < added; i++) {
		lines.push(`+line ${i}`);
	}
	return lines.join('\n');
}

function finding(extra: Partial<ClaudeReviewFinding>): ClaudeReviewFinding {
	return { file: 'src/a.ts', startLine: 4, endLine: 4, severity: 'high', category: 'bug', title: 'Off by one', body: 'The loop skips the last item.', ...extra };
}

suite('Klawly review depth (issue 926)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the stats count files, changed lines and top-level folders', () => {
		const diff = [fileDiff('src/a.ts', 3), fileDiff('src/b.ts', 2), fileDiff('README.md', 1)].join('\n');
		assert.deepStrictEqual(claudeReviewDiffStats(diff), { files: ['src/a.ts', 'src/b.ts', 'README.md'], changedLines: 6, modules: 2 });
	});

	test('Auto picks by risk path, size and modules; a set depth wins', () => {
		const pick = (files: readonly string[], changedLines: number, setting: 'auto' | 'quick' | 'deep' = 'auto') =>
			chooseClaudeReviewDepth({ files, changedLines, modules: new Set(files.map(f => f.split('/')[0])).size }, setting);
		assert.deepStrictEqual([
			pick(['src/auth/login.ts'], 5),
			pick(['db/migrations/001.sql'], 5),
			pick(['.github/workflows/ci.yml'], 5),
			pick(['src/billing.ts'], 5),
			pick(['src/a.ts'], 900),
			pick(['a/x.ts', 'b/x.ts', 'c/x.ts', 'd/x.ts'], 20),
			pick(['src/a.ts'], 40),
			pick(['src/a.ts'], 400),
			pick(['src/auth/login.ts'], 5, 'quick'),
			pick(['src/a.ts'], 5, 'deep'),
			pick(['src/author.ts'], 5),
		], [
			{ depth: 'deep', reason: 'riskPath', riskPath: 'src/auth/login.ts' },
			{ depth: 'deep', reason: 'riskPath', riskPath: 'db/migrations/001.sql' },
			{ depth: 'deep', reason: 'riskPath', riskPath: '.github/workflows/ci.yml' },
			{ depth: 'deep', reason: 'riskPath', riskPath: 'src/billing.ts' },
			{ depth: 'deep', reason: 'big' },
			{ depth: 'deep', reason: 'modules' },
			{ depth: 'quick', reason: 'small' },
			{ depth: 'quick', reason: 'medium' },
			{ depth: 'quick', reason: 'setting' },
			{ depth: 'deep', reason: 'setting' },
			{ depth: 'quick', reason: 'small' },
		]);
	});

	test('the readers keep bad values to the defaults', () => {
		assert.deepStrictEqual([
			readClaudeReviewDepthSetting('deep'), readClaudeReviewDepthSetting('wild'), readClaudeReviewDepthSetting(undefined),
			readClaudeReviewMaxTurns(0, 'quick'), readClaudeReviewMaxTurns(0, 'deep'), readClaudeReviewMaxTurns(12.7, 'quick'), readClaudeReviewMaxTurns(500, 'deep'), readClaudeReviewMaxTurns('9', 'quick'),
			claudeReviewModel('', 'deep', 'sonnet'), claudeReviewModel('', 'quick', 'sonnet'), claudeReviewModel(' haiku ', 'deep', 'sonnet'), claudeReviewModel(undefined, 'quick', undefined),
		], [
			'deep', 'auto', 'auto',
			8, 24, 12, 100, 8,
			'opus', 'sonnet', 'haiku', undefined,
		]);
	});

	test('a Deep diff splits per top-level folder and a one-folder diff stays whole', () => {
		const one = [fileDiff('src/a.ts', 1), fileDiff('src/b.ts', 1)].join('\n');
		const two = [fileDiff('src/a.ts', 1), fileDiff('test/a.ts', 1), fileDiff('src/b.ts', 1)].join('\n');
		assert.deepStrictEqual([splitClaudeReviewDiff(one), splitClaudeReviewDiff(two)], [
			[one],
			[[fileDiff('src/a.ts', 1), fileDiff('src/b.ts', 1)].join('\n'), fileDiff('test/a.ts', 1)],
		]);
	});

	test('merged findings drop repeats of the same file, line and title', () => {
		const merged = mergeClaudeReviewFindings([
			[finding({}), finding({ startLine: 9 })],
			[finding({ title: ' off BY one ', body: 'again' }), finding({ file: 'src/b.ts' })],
		]);
		assert.deepStrictEqual(merged.map(f => `${f.file}:${f.startLine}`), ['src/a.ts:4', 'src/a.ts:9', 'src/b.ts:4']);
	});

	test('the plan reads the settings, a forced depth wins, and a big Deep run gets a cost note', () => {
		const settings: Record<string, unknown> = { [CLAUDE_REVIEW_DEPTH_SETTING]: 'auto', [CLAUDE_REVIEW_MODEL_SETTING]: '', [CLAUDE_REVIEW_MAX_TURNS_SETTING]: 0 };
		const read = (key: string) => settings[key];
		const big = planClaudeReviewRun(fileDiff('src/a.ts', 900), read, { model: 'sonnet' });
		const small = planClaudeReviewRun(fileDiff('src/a.ts', 10), read, { model: 'sonnet' });
		const forced = planClaudeReviewRun(fileDiff('src/a.ts', 10), read, { forced: 'deep', model: 'sonnet' });
		assert.deepStrictEqual([
			[big.depth, big.reason, big.model, big.maxTurns, claudeReviewNeedsCostNote(big)],
			[small.depth, small.reason, small.model, small.maxTurns, claudeReviewNeedsCostNote(small)],
			[forced.depth, forced.reason, forced.model, forced.maxTurns, claudeReviewNeedsCostNote(forced)],
			claudeReviewDepthMessage(small),
		], [
			['deep', 'big', 'opus', 24, true],
			['quick', 'small', 'sonnet', 8, false],
			['deep', 'setting', 'opus', 24, false],
			'Quick review: 10 changed lines is a small diff.',
		]);
		assert.ok(claudeReviewDepthMessage(big).includes('uses more of your plan'));
	});

	test('the automation step follows the setting', () => {
		assert.deepStrictEqual([claudeReviewDepthAutomationLine('auto').includes('pick the depth yourself'), claudeReviewDepthAutomationLine('deep').includes('do a deep pass')], [true, true]);
	});
});
