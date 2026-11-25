/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeReviewFinding } from '../../common/claudeReviewLoop.js';
import { addClaudeReviewRule } from '../../common/claudeReviewConfig.js';
import { ClaudeReviewSignalCounter, claudeLearnedRuleOffer, claudeReviewCategoryLabel, claudeReviewCategoryPhrase, isLearnedClaudeReviewRule, listLearnedClaudeReviewRules, removeLearnedClaudeReviewRule, learnedClaudeReviewRule, normalizeClaudeFindingTitle, readClaudeLearnAfter, recordClaudeReviewSignal, resetClaudeReviewSignal, suggestLearnedRules } from '../../common/claudeReviewLearning.js';

function finding(category: ClaudeReviewFinding['category'], title: string, body = ''): ClaudeReviewFinding {
	return { file: 'a.ts', startLine: 1, endLine: 1, severity: 'low', category, title, body };
}

function record(repo: string, f: ClaudeReviewFinding, times: number): readonly ClaudeReviewSignalCounter[] {
	let counters: readonly ClaudeReviewSignalCounter[] = [];
	for (let i = 0; i < times; i++) {
		counters = recordClaudeReviewSignal(counters, repo, f);
	}
	return counters;
}

suite('claudeReviewLearning', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('threshold table', () => {
		const style = finding('style', 'Prefer `const` over let for "x" 12');
		const table = [1, 2, 3, 4].map(times => suggestLearnedRules(record('/r', style, times), '/r').map(counter => counter.count));
		const lowered = suggestLearnedRules(record('/r', style, 2), '/r', 2).map(counter => counter.count);
		const otherRepo = suggestLearnedRules(record('/r', style, 5), '/other');
		assert.deepStrictEqual({ table, lowered, otherRepo }, { table: [[], [], [3], [4]], lowered: [2], otherRepo: [] });
	});

	test('reworded repeats count together, other categories do not', () => {
		const counters = recordClaudeReviewSignal(recordClaudeReviewSignal(recordClaudeReviewSignal([], '/r', finding('style', 'Use `a` here')), '/r', finding('style', 'Use `b` here!')), '/r', finding('bug', 'Use `a` here'));
		assert.deepStrictEqual(counters.map(counter => [counter.category, counter.title, counter.count]), [['style', 'use here', 2], ['bug', 'use here', 1]]);
	});

	test('security, memory, null and infinite-loop findings are never counted or suggested', () => {
		const never = [
			finding('security', 'Wide CORS'),
			finding('bug', 'Possible memory leak in cache'),
			finding('logic', 'Null dereference when empty'),
			finding('bug', 'Loop', 'This is an infinite loop'),
		];
		assert.deepStrictEqual(never.map(f => record('/r', f, 5).length), [0, 0, 0, 0]);
		const forced: ClaudeReviewSignalCounter[] = [{ repo: '/r', category: 'security', title: 'wide cors', count: 9, sample: 'Wide CORS' }];
		assert.deepStrictEqual(suggestLearnedRules(forced, '/r'), []);
	});

	test('rule format, reset and settings value', () => {
		const counter = record('/r', finding('style', 'Prefer const'), 3)[0];
		const rule = learnedClaudeReviewRule(counter);
		assert.deepStrictEqual({
			rule,
			learned: [isLearnedClaudeReviewRule(rule), isLearnedClaudeReviewRule({ id: 'no-todo' })],
			reset: resetClaudeReviewSignal([counter], '/r', 'style', counter.title),
			title: normalizeClaudeFindingTitle('Missing "foo" in `bar` (3)'),
			learnAfter: [readClaudeLearnAfter(5), readClaudeLearnAfter(0), readClaudeLearnAfter('x'), readClaudeLearnAfter(undefined)],
		}, {
			rule: { id: rule.id, text: 'Do not flag style findings like "Prefer const": this project has dismissed them repeatedly.' },
			learned: [true, false],
			reset: [],
			title: 'missing in',
			learnAfter: [5, 3, 3, 3],
		});
	});

	test('the learned rule sentence reads naturally for every category (issue 1158)', () => {
		const categories = ['security', 'bug', 'logic', 'performance', 'style', 'tests'] as const;
		assert.deepStrictEqual(categories.map(category => learnedClaudeReviewRule({ category, title: 'x', sample: 'S' }).text.split(' like ')[0]), [
			'Do not flag security findings',
			'Do not flag bug findings',
			'Do not flag logic findings',
			'Do not flag performance findings',
			'Do not flag style findings',
			'Do not flag test findings',
		]);
		assert.ok(categories.every(category => claudeReviewCategoryPhrase(category) === claudeReviewCategoryPhrase(category).toLowerCase()));
	});

	test('learned rule ids are unique for long titles that start alike', () => {
		const long = 'Prefer const over let when the value is never reassigned in this file';
		const a = learnedClaudeReviewRule({ category: 'style', title: `${long} in functions`, sample: 'A' });
		const b = learnedClaudeReviewRule({ category: 'style', title: `${long} in classes`, sample: 'B' });
		const again = learnedClaudeReviewRule({ category: 'style', title: `${long} in functions`, sample: 'A' });
		assert.deepStrictEqual({ different: a.id !== b.id, stable: a.id === again.id, prefix: a.id.startsWith('learned-style-Prefer-const-over-let') }, { different: true, stable: true, prefix: true });
	});

	test('the offer is one sentence and the rule names the category by its display name', () => {
		assert.deepStrictEqual({
			offer: claudeLearnedRuleOffer({ category: 'style', sample: 'Prefer const', count: 3 }),
			label: claudeReviewCategoryLabel('performance'),
		}, {
			offer: 'You dismissed "Prefer const" 3 times. Stop flagging it in this project?',
			label: 'Performance',
		});
	});

	test('Learned Rules list shows only learned rules and removes one', () => {
		const rule = learnedClaudeReviewRule({ category: 'style', title: 'Prefer const', sample: 'Prefer const' });
		const text = addClaudeReviewRule(addClaudeReviewRule(undefined, { id: 'no-todo', text: 'No TODO comments' }), rule)!;
		const listed = listLearnedClaudeReviewRules(text).map(r => r.id);
		const after = removeLearnedClaudeReviewRule(text, rule.id);
		const kept = removeLearnedClaudeReviewRule(text, 'no-todo');
		assert.deepStrictEqual({
			listed,
			afterIds: listLearnedClaudeReviewRules(after ?? '').map(r => r.id),
			otherKept: kept === text,
		}, { listed: [rule.id], afterIds: [], otherKept: true });
	});

	test('the learn-after setting falls back to the default for bad values', () => {
		assert.deepStrictEqual([readClaudeLearnAfter(1), readClaudeLearnAfter(-2), readClaudeLearnAfter(2.5), readClaudeLearnAfter(null)], [1, 3, 3, 3]);
	});
});
