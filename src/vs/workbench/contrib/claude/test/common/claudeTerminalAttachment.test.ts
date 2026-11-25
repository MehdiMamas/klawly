/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeTerminalAttachment } from '../../common/claudeTerminalAttachment.js';

suite('Claude terminal attachment', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('issue 734: the selection wins, then the last command with its output, then the tail of the buffer', () => {
		const lastCommand = { command: 'npm test', output: 'FAIL src/a.test.ts\n  expected 1\n\n' };
		assert.deepStrictEqual([
			claudeTerminalAttachment({ terminalId: 1, terminalTitle: 'zsh', selection: 'error: one\nerror: two\n', lastCommand }),
			claudeTerminalAttachment({ terminalId: 1, terminalTitle: 'zsh', selection: '', lastCommand }),
			claudeTerminalAttachment({ terminalId: 1, terminalTitle: 'zsh', lastCommand: { command: `echo ${'x'.repeat(80)}`, output: '' } }),
			claudeTerminalAttachment({ terminalId: 2, terminalTitle: '', lastCommand: { command: ' ', output: ' ' } }),
		], [
			{ kind: 'terminal', terminalId: 1, lines: 2, title: 'zsh selection', text: 'error: one\nerror: two' },
			{ kind: 'terminal', terminalId: 1, lines: 3, title: 'npm test', text: '$ npm test\nFAIL src/a.test.ts\n  expected 1' },
			// allow-any-unicode-next-line
			{ kind: 'terminal', terminalId: 1, lines: 1, title: `echo ${'x'.repeat(54)}…`, text: `echo ${'x'.repeat(80)}`.replace(/^/, '$ ') },
			{ kind: 'terminal', terminalId: 2, lines: 200, title: 'Terminal' },
		]);
	});
});
