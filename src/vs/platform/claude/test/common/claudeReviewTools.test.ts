/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeFindingId } from '../../common/claudeReviewCli.js';
import { ClaudeReviewFinding } from '../../common/claudeReviewLoop.js';
import { ClaudePersistedReview } from '../../common/claudeReviewPersist.js';
import { runClaudeReviewApplyTool, runClaudeReviewFindingsTool, runClaudeReviewMarkTool } from '../../common/claudeReviewToolRun.js';
import { applyClaudeReviewSuggestion, ClaudeReviewToolHost, isClaudeReviewRelativePath } from '../../common/claudeReviewTools.js';

suite('Claude review tools (issue 1376)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const finding: ClaudeReviewFinding = { file: 'src/a.ts', startLine: 2, endLine: 3, severity: 'high', category: 'bug', title: 'Off by one', body: 'x', suggestion: 'fixed();' };

	function host(review: ClaudePersistedReview | undefined, files: Record<string, string>) {
		const state = { review, files: { ...files } };
		const tools: ClaudeReviewToolHost = {
			read: async () => state.review,
			write: async next => { state.review = next; },
			readFile: async file => state.files[file],
			writeFile: async (file, content) => {
				state.files[file] = content;
				return true;
			},
			store: async () => ({ open: [], sha: 'abc' }),
			run: async () => ({ text: 'ran' }),
		};
		return { state, tools };
	}

	test('paths must stay relative and inside the checkout', () => {
		assert.deepStrictEqual(['src/a.ts', '../x', '/etc/passwd', 'C:\\x', ''].map(isClaudeReviewRelativePath), [true, false, false, false, false]);
	});

	test('a suggestion replaces the lines of its finding and refuses a finding without one', () => {
		assert.deepStrictEqual([
			applyClaudeReviewSuggestion('a\nb\nc\nd', finding),
			applyClaudeReviewSuggestion('a', { ...finding, suggestion: undefined }).ok,
		], [{ ok: true, content: 'a\nfixed();\nd' }, false]);
	});

	test('get_review_findings lists the open findings with their ids', async () => {
		const { tools } = host({ reviewedSha: 'abc', findings: [{ finding, status: 'open' }] }, {});
		const parsed = JSON.parse((await runClaudeReviewFindingsTool(tools)).text);
		assert.deepStrictEqual([parsed.reviewedSha, parsed.findings.map((item: { id: string }) => item.id)], ['abc', [claudeFindingId(finding)]]);
	});

	test('apply_suggestion edits the file, marks the finding addressed and refuses an unknown id', async () => {
		const { state, tools } = host({ reviewedSha: 'abc', findings: [{ finding, status: 'open' }] }, { 'src/a.ts': 'a\nb\nc\nd' });
		const unknown = await runClaudeReviewApplyTool(tools, 'nope');
		const applied = await runClaudeReviewApplyTool(tools, claudeFindingId(finding));
		assert.deepStrictEqual({ unknown: unknown.isError, applied: applied.isError, file: state.files['src/a.ts'], status: state.review?.findings[0].status }, { unknown: true, applied: undefined, file: 'a\nfixed();\nd', status: 'addressed' });
	});

	test('mark_addressed marks by id', async () => {
		const { state, tools } = host({ reviewedSha: 'abc', findings: [{ finding, status: 'open' }] }, {});
		const result = await runClaudeReviewMarkTool(tools, [claudeFindingId(finding)]);
		assert.deepStrictEqual({ text: result.text, status: state.review?.findings[0].status }, { text: '1 finding(s) marked addressed.', status: 'addressed' });
	});
});
