/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { inlineShellCommand, shellCommandFromBlock } from '../../common/claudeShellCommands.js';

suite('Claude shell commands in replies (issue 733)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a shell block runs its commands; a session block only the prompted lines, never its output', () => {
		assert.deepStrictEqual({
			script: shellCommandFromBlock('bash', 'npm install\nnpm test\n'),
			prompted: shellCommandFromBlock('sh', '$ cd app\n$ npm start'),
			session: shellCommandFromBlock('console', '$ npm test\n\n> klawly@1.0.0 test\n✓ 14 passed'),
			mixed: shellCommandFromBlock('shell', '$ git status\nOn branch main\n% git pull'),
			powershell: shellCommandFromBlock('PowerShell', 'PS C:\\repo> npm test'),
			crlf: shellCommandFromBlock('zsh', 'brew install gh\r\ngh auth login\r\n'),
			empty: shellCommandFromBlock('bash', '\n\n'),
			code: shellCommandFromBlock('typescript', 'npm test'),
			plain: shellCommandFromBlock('', 'npm test'),
		}, {
			script: 'npm install\nnpm test',
			prompted: 'cd app\nnpm start',
			session: 'npm test',
			mixed: 'git status\ngit pull',
			powershell: 'npm test',
			crlf: 'brew install gh\ngh auth login',
			empty: undefined,
			code: undefined,
			plain: undefined,
		});
	});

	test('inline code is a command only when it starts with a known program and has more after it', () => {
		const inputs = ['npm test', 'npm run lint && npm test', 'kill 8284', '$ git status', 'cd app && make build',
			'npm', 'cartService.ts', 'applyDiscount(code)', 'totals()', 'run tests && ship', 'echo `date`', 'git status\ngit pull', `npm ${'x'.repeat(300)}`];
		assert.deepStrictEqual(inputs.map(inlineShellCommand), [
			'npm test', 'npm run lint && npm test', 'kill 8284', 'git status', 'cd app && make build',
			undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
		]);
	});
});
