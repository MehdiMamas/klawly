/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildTerminalCommandPrompt, buildTerminalQuestionPrompt, parseTerminalCommand, terminalOutputLift, terminalSelectionBarPlace, terminalShellFamily } from '../../common/claudeTerminalPrompt.js';

suite('Claude terminal prompt', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the shell family follows the shell, then the OS', () => {
		assert.deepStrictEqual([
			terminalShellFamily('pwsh', OperatingSystem.Linux),
			terminalShellFamily('cmd', OperatingSystem.Windows),
			terminalShellFamily('gitbash', OperatingSystem.Windows),
			terminalShellFamily('zsh', OperatingSystem.Macintosh),
			terminalShellFamily(undefined, OperatingSystem.Windows),
			terminalShellFamily(undefined, OperatingSystem.Linux),
		], ['pwsh', 'cmd', 'posix', 'posix', 'pwsh', 'posix']);
	});

	test('the prompts name the shell, the OS and the folder', () => {
		const context = { shell: 'pwsh', os: OperatingSystem.Windows, cwd: 'C:\\work\\shop' };
		assert.deepStrictEqual({
			command: buildTerminalCommandPrompt('  list the five largest files ', context).split('\n'),
			question: buildTerminalQuestionPrompt('what does -Force do?', { shell: 'zsh', os: OperatingSystem.Macintosh, cwd: undefined }).split('\n'),
		}, {
			command: [
				'Write one shell command for the terminal described below.',
				'Reply with the command only, on one line. No explanation, no Markdown, no code fence.',
				'If the request needs several steps, chain them in that one line.',
				'Shell: PowerShell',
				'Operating system: Windows',
				'Working directory: C:\\work\\shop',
				'Request: list the five largest files',
			],
			question: [
				'Answer a question about working in the terminal described below.',
				'Use at most three short sentences of plain text. Put any command in backticks.',
				'Shell: zsh',
				'Operating system: macOS',
				'Question: what does -Force do?',
			],
		});
	});

	test('replies become one insertable line', () => {
		assert.deepStrictEqual([
			parseTerminalCommand('git status', 'posix'),
			parseTerminalCommand('```bash\n# show it\n$ git log --oneline -5\n```\nThis lists commits.', 'posix'),
			parseTerminalCommand('`ls -la`', 'posix'),
			parseTerminalCommand('npm ci\nnpm test', 'posix'),
			parseTerminalCommand('PS C:\\work> Get-ChildItem\nGet-Date', 'pwsh'),
			parseTerminalCommand('rem build\nC:\\work>dir /b', 'cmd'),
			parseTerminalCommand('   \n```\n```', 'posix'),
			parseTerminalCommand('x'.repeat(2001), 'posix'),
		], [
			'git status',
			'git log --oneline -5',
			'ls -la',
			'npm ci && npm test',
			'Get-ChildItem; Get-Date',
			'dir /b',
			undefined,
			undefined,
		]);
	});

	test('no control character survives, so the text never runs by itself', () => {
		const hostile = 'echo a\r\necho b\u2028echo c\u0003\u001b[201~\u0007\techo d\u009b\r';
		const command = parseTerminalCommand(hostile, 'posix')!;
		assert.deepStrictEqual({
			command,
			controls: /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(command),
		}, {
			command: 'echo a && echo b && echo c [201~ echo d',
			controls: false,
		});
	});

	test('the output moves up only as far as the card needs to clear the cursor line', () => {
		// 20 rows of 18px; the card takes 100px with its margins.
		assert.deepStrictEqual([
			terminalOutputLift(0, 20, 18, 100),
			terminalOutputLift(13, 20, 18, 100),
			terminalOutputLift(14, 20, 18, 100),
			terminalOutputLift(19, 20, 18, 100),
			terminalOutputLift(19, 20, 18, 100.4),
		], [0, 0, 10, 100, 101]);
	});
	test('the selection bar floats above the selection, under it at the top, and never off screen (issue 780)', () => {
		const screen = { viewportY: 100, rows: 20, cellWidth: 8, cellHeight: 18, width: 640 };
		assert.deepStrictEqual([
			// Above the first selected row, at the selection's start.
			terminalSelectionBarPlace({ startColumn: 4, startRow: 105, endColumn: 10, endRow: 105 }, screen, 120, 30),
			// No room above the top row: under the last selected row.
			terminalSelectionBarPlace({ startColumn: 4, startRow: 100, endColumn: 10, endRow: 101 }, screen, 120, 30),
			// An end at column 0 belongs to the row before.
			terminalSelectionBarPlace({ startColumn: 0, startRow: 100, endColumn: 0, endRow: 102 }, screen, 120, 30),
			// Near the right edge it stays inside the screen.
			terminalSelectionBarPlace({ startColumn: 75, startRow: 110, endColumn: 79, endRow: 110 }, screen, 120, 30),
			// Started above the view: the bar sits at the left of the first row in view, under the selection.
			terminalSelectionBarPlace({ startColumn: 30, startRow: 90, endColumn: 5, endRow: 103 }, screen, 120, 30),
			// The whole view selected: over the top.
			terminalSelectionBarPlace({ startColumn: 0, startRow: 0, endColumn: 80, endRow: 119 }, screen, 120, 30),
			// Scrolled out of view.
			terminalSelectionBarPlace({ startColumn: 0, startRow: 50, endColumn: 5, endRow: 60 }, screen, 120, 30),
		], [
			{ top: 60, left: 32 },
			{ top: 36, left: 32 },
			{ top: 36, left: 0 },
			{ top: 150, left: 520 },
			{ top: 72, left: 0 },
			{ top: 0, left: 0 },
			undefined,
		]);
	});
});
