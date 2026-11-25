/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_REVIEW_KNOWLEDGE_BUDGET, CLAUDE_REVIEW_KNOWLEDGE_FILE, claudeRevertLines, claudeReviewInstructionsWithKnowledge, claudeReviewKnowledgePrompt, claudeReviewKnowledgeText, isClaudeReviewKnowledgeStale, parseClaudeReverts } from '../../common/claudeReviewKnowledge.js';

const a = 'a'.repeat(40);
const b = 'b'.repeat(40);
const c = 'c'.repeat(40);

suite('Claude review knowledge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the revert miner reads quoted reverts, rollbacks and the commit they name', () => {
		const log = [
			`${a}\x1fRevert "Add retry to sync (#12)"\x1fThis reverts commit ${'d'.repeat(40)}.\x1e`,
			`${b}\x1fRoll back the cache change\x1f\x1e`,
			`${c}\x1fRename helper\x1fmentions revert in the body only\x1e`,
			`nothex\x1fRevert "x"\x1f\x1e`,
		].join('\n');
		assert.deepStrictEqual(parseClaudeReverts(log), [
			{ sha: a, subject: 'Add retry to sync (#12)', revertedSha: 'd'.repeat(40) },
		]);
		assert.deepStrictEqual(parseClaudeReverts(`${b}\x1fRollback of the cache change\x1f\x1e`), [{ sha: b, subject: 'Rollback of the cache change', revertedSha: undefined }]);
	});

	test('revert lines are short and capped', () => {
		const lines = claudeRevertLines([{ sha: a, subject: 'One', revertedSha: 'd'.repeat(40) }, { sha: b, subject: 'Two' }], 1);
		assert.deepStrictEqual(lines, ['- One (aaaaaaaaa, reverted ddddddddd)']);
	});

	test('the generation prompt names the file, the sections and the reverts', () => {
		const prompt = claudeReviewKnowledgePrompt([{ sha: a, subject: 'Add retry' }]);
		assert.ok(prompt.includes(CLAUDE_REVIEW_KNOWLEDGE_FILE));
		for (const section of ['## Modules', '## Glossary', '## Risk Areas', '## Past Reverts']) {
			assert.ok(prompt.includes(section), section);
		}
		assert.ok(prompt.includes('- Add retry (aaaaaaaaa)'));
		assert.ok(claudeReviewKnowledgePrompt([]).includes('No reverts were found'));
	});

	test('the reader has its own budget and drops empty files', () => {
		assert.strictEqual(claudeReviewKnowledgeText('  \n'), undefined);
		assert.strictEqual(claudeReviewKnowledgeText(undefined), undefined);
		assert.strictEqual(claudeReviewKnowledgeText(' short '), 'short');
		const long = claudeReviewKnowledgeText('x'.repeat(CLAUDE_REVIEW_KNOWLEDGE_BUDGET + 50))!;
		assert.strictEqual(long.startsWith('x'.repeat(CLAUDE_REVIEW_KNOWLEDGE_BUDGET)), true);
		assert.ok(long.endsWith('[The knowledge file is cut here.]'));
	});

	test('the knowledge block follows the notes and is absent without a file', () => {
		assert.strictEqual(claudeReviewInstructionsWithKnowledge('notes', undefined), 'notes');
		assert.strictEqual(claudeReviewInstructionsWithKnowledge(undefined, ' '), undefined);
		const both = claudeReviewInstructionsWithKnowledge('notes', '## Modules\n- a')!;
		assert.ok(both.startsWith('notes\n\n'));
		assert.ok(both.includes('<project_knowledge>\n## Modules\n- a\n</project_knowledge>'));
		assert.ok(claudeReviewInstructionsWithKnowledge(undefined, 'k')!.startsWith('Background on this project'));
	});

	test('staleness starts at 200 changed files', () => {
		assert.deepStrictEqual([isClaudeReviewKnowledgeStale(199), isClaudeReviewKnowledgeStale(200)], [false, true]);
	});
});
