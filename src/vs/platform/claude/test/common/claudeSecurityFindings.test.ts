/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_SECURITY_FINDING_FORMAT, claudeSecurityFixPrompt, dismissClaudeFinding, dismissClaudeFindings, isClaudeSecurityAutomationPrompt, openClaudeSecurityFindings, parseClaudeFindingsFile, parseClaudeSecurityFindings, restoreClaudeFinding, stringifyClaudeFindingsFile } from '../../common/claudeSecurityFindings.js';

const RUN = [
	'Here is what I found.',
	'`src/db/users.ts:42 [high] sql-injection: the id from the query string is joined into the SQL text; use a parameter.`',
	'- src\\api\\login.ts:7 [Critical] hardcoded-secret: a token is in the source; move it to the environment.',
	'src/db/users.ts:42 [high] sql-injection: the id from the query string is joined into the SQL text; use a parameter.',
	'lib/a.py:3 [low] weak-hash: md5 is used for a cache key.',
	'No findings.',
].join('\n');

suite('Claude security findings', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the finding lines worst first and skips the rest and repeats', () => {
		assert.deepStrictEqual(parseClaudeSecurityFindings(RUN).map(f => `${f.severity} ${f.file}:${f.line} ${f.category}`), [
			'critical src/api/login.ts:7 hardcoded-secret',
			'high src/db/users.ts:42 sql-injection',
			'low lib/a.py:3 weak-hash',
		]);
		assert.deepStrictEqual(parseClaudeSecurityFindings('No findings.'), []);
	});

	test('dismissals keep a reason, survive a round trip and hide the finding', () => {
		const findings = parseClaudeSecurityFindings(RUN);
		let file = dismissClaudeFinding({ dismissed: [] }, findings[1].key, ' test fixture ', 5);
		file = parseClaudeFindingsFile(stringifyClaudeFindingsFile(file));
		assert.deepStrictEqual({
			file,
			open: openClaudeSecurityFindings(findings, file).map(f => f.category),
			restored: openClaudeSecurityFindings(findings, restoreClaudeFinding(file, findings[1].key)).length,
			broken: parseClaudeFindingsFile('{nope'),
		}, {
			file: { dismissed: [{ key: findings[1].key, reason: 'test fixture', at: 5 }] },
			open: ['hardcoded-secret', 'weak-hash'],
			restored: 3,
			broken: { dismissed: [] },
		});
	});

	test('the fix prompt names the place and asks for a test', () => {
		const prompt = claudeSecurityFixPrompt(parseClaudeSecurityFindings(RUN)[1]);
		assert.ok(prompt.includes('src/db/users.ts at line 42') && prompt.includes('add or update a test'));
	});

	test('a security automation is known by the finding format in its prompt (issue 1076)', () => {
		assert.deepStrictEqual([isClaudeSecurityAutomationPrompt(`Scan the diff. Report each as ${CLAUDE_SECURITY_FINDING_FORMAT}.`), isClaudeSecurityAutomationPrompt('Summarize the open pull requests.')], [true, false]);
	});

	test('dismissing several findings keeps one reason for each (issue 1076)', () => {
		const keys = parseClaudeSecurityFindings(RUN).map(finding => finding.key);
		const file = dismissClaudeFindings({ dismissed: [] }, keys, 'reviewed', 5);
		assert.deepStrictEqual([file.dismissed.length, openClaudeSecurityFindings(parseClaudeSecurityFindings(RUN), file).length, file.dismissed.every(entry => entry.reason === 'reviewed')], [new Set(keys).size, 0, true]);
	});
});
