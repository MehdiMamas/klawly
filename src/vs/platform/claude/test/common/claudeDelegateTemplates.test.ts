/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeDelegateArgsProblem, CLAUDE_DELEGATE_TOOL_DESCRIPTION } from '../../common/claudeDelegate.js';
import { CLAUDE_DELEGATE_TEMPLATES, claudeDelegateTemplateProblem, expandClaudeDelegateTemplate } from '../../common/claudeDelegateTemplates.js';

suite('Claude delegate templates', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every template expands to the small tier with a short budget and a 100-word report', () => {
		const args: Record<string, string> = { 'watch-ci': '845', 'run-tests': 'npm run test-node', 'merge-pr': '12', 'find': 'where is the ladder' };
		for (const template of CLAUDE_DELEGATE_TEMPLATES) {
			const call = expandClaudeDelegateTemplate({ task: '', template, args: args[template], tier: 'large' });
			assert.strictEqual(call.tier, 'small', template);
			assert.ok(call.task.includes('100 words'), template);
			assert.ok(call.acceptance && call.budget?.calls, template);
			assert.ok(call.task.includes(args[template]), template);
		}
	});

	test('the waiting templates name the no-model tools and forbid polling', () => {
		const ci = expandClaudeDelegateTemplate({ task: '', template: 'watch-ci', args: '845' }).task;
		const merge = expandClaudeDelegateTemplate({ task: '', template: 'merge-pr', args: '#12' }).task;
		assert.ok(ci.includes('ci_wait') && ci.includes('Never wait in a loop'));
		assert.ok(merge.includes('merge_gate') && merge.includes('ci_wait'));
	});

	test('bad template or args say what is needed; a caller title and budget are kept', () => {
		assert.deepStrictEqual([
			claudeDelegateTemplateProblem('nope', 'x'),
			claudeDelegateTemplateProblem('merge-pr', 'soon'),
			claudeDelegateTemplateProblem('find', ' '),
			claudeDelegateTemplateProblem('run-tests', 'npm test'),
			claudeDelegateArgsProblem({ task: '', template: 'find' }),
			claudeDelegateArgsProblem({ task: '', template: 'find', args: 'where' }),
		], [
			'template is one of watch-ci, run-tests, merge-pr, find.',
			'Merge Pull Request needs a pull request number.',
			'Find needs the question.',
			undefined,
			'Find needs the question.',
			undefined,
		]);
		const call = expandClaudeDelegateTemplate({ task: '', template: 'find', args: 'q', title: 'Mine', budget: { calls: 5 } });
		assert.deepStrictEqual([call.title, call.budget], ['Mine', { calls: 5 }]);
	});

	test('the tool description tells Claude about templates', () => {
		assert.ok(CLAUDE_DELEGATE_TOOL_DESCRIPTION.includes('watch-ci') && CLAUDE_DELEGATE_TOOL_DESCRIPTION.includes('small tier'));
	});
});
