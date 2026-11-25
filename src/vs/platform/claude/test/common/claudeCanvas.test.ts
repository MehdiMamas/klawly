/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_CANVAS_MAX_BYTES, CLAUDE_CANVAS_TOOL_ID, claudeCanvasArgsProblem, claudeCanvasFileName, claudeCanvasTitle, claudeCanvasToolText, readClaudeCanvasResult } from '../../common/claudeCanvas.js';
import { DEFAULT_PERMISSION_POLICY } from '../../common/claudePermissions.js';
import { evaluateToolPolicy, ToolPolicyContext } from '../../common/claudeToolPolicy.js';

suite('Claude canvas (issue 493)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('names become safe file names, titles one short line', () => {
		assert.deepStrictEqual({
			names: ['Slow Tests', '../../etc/passwd', 'Café — audit!', '***', 'a'.repeat(80)].map(claudeCanvasFileName),
			titles: [
				claudeCanvasTitle({ name: 'slow-tests', title: '  Slowest\n tests ' }),
				claudeCanvasTitle({ name: 'slow-tests' }),
				claudeCanvasTitle({ name: 'x', title: 't'.repeat(130) }).length,
			],
		}, {
			names: ['slow-tests.html', 'etc-passwd.html', 'cafe-audit.html', undefined, `${'a'.repeat(60)}.html`],
			titles: ['Slowest tests', 'slow-tests', 120],
		});
	});

	test('an empty, nameless or oversized page is refused with the reason', () => {
		const html = '<p>ok</p>';
		assert.deepStrictEqual([
			claudeCanvasArgsProblem({ name: 'slow-tests', html }),
			claudeCanvasArgsProblem({ name: '!!', html }),
			claudeCanvasArgsProblem({ name: 'slow-tests', html: '  ' }),
			claudeCanvasArgsProblem({ name: 'slow-tests', html: 'x'.repeat(CLAUDE_CANVAS_MAX_BYTES + 1) }),
		], [
			undefined,
			'Give the canvas a name with letters or digits, such as "slow-tests".',
			'Give the HTML of the page.',
			'The page is larger than 2 MB. Show less data, or summarize it.',
		]);
	});

	test('the result names the file and title the window opens, and a failure names none', () => {
		const saved = claudeCanvasToolText({ kind: 'saved', path: 'C:\Users\me\.klawly\canvases\s1\slow-tests.html', name: 'slow-tests', title: 'Slowest tests', updated: false });
		const failed = claudeCanvasToolText({ kind: 'failed', message: 'Give the HTML of the page.' });
		assert.deepStrictEqual({
			saved: readClaudeCanvasResult(saved.text),
			savedIsError: saved.isError,
			crlf: readClaudeCanvasResult('Canvas file: /home/me/.klawly/canvases/s1/a.html\r\nCanvas title: \r\n'),
			failed: readClaudeCanvasResult(failed.text),
			failedIsError: failed.isError,
			notHtml: readClaudeCanvasResult('Canvas file: /etc/passwd\nCanvas title: x'),
		}, {
			saved: { path: 'C:\Users\me\.klawly\canvases\s1\slow-tests.html', title: 'Slowest tests' },
			savedIsError: false,
			crlf: { path: '/home/me/.klawly/canvases/s1/a.html', title: 'a' },
			failed: undefined,
			failedIsError: true,
			notHtml: undefined,
		});
	});

	test('the tool runs without a permission card: it writes only into Klawly\'s canvases folder', async () => {
		const context: ToolPolicyContext = { cwd: '/ws', workspaceFolders: ['/ws'], additionalDirectories: [], trusted: true, policy: { ...DEFAULT_PERMISSION_POLICY } };
		const result = await evaluateToolPolicy(CLAUDE_CANVAS_TOOL_ID, { name: 'slow-tests', html: '<p>ok</p>' }, context);
		assert.strictEqual(result.behavior, 'allow');
	});
});
