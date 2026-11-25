/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeStatusLineText, parseClaudeStatusLine, readClaudeStatusLineConfig } from '../../common/claudeStatusLine.js';

suite('Claude status line (issue 515)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('local wins over project over user, and only the user entry counts in an untrusted workspace', () => {
		const line = (command: string) => JSON.stringify({ statusLine: { type: 'command', command } });
		const texts = { user: line('user.sh'), project: line('project.sh'), local: line('local.sh') };
		assert.deepStrictEqual({
			trusted: readClaudeStatusLineConfig(texts, true),
			untrusted: readClaudeStatusLineConfig(texts, false),
			projectOnly: readClaudeStatusLineConfig({ user: '{}', project: line('project.sh') }, true),
			untrustedProjectOnly: readClaudeStatusLineConfig({ project: line('project.sh') }, false),
			brokenLocal: readClaudeStatusLineConfig({ local: '{ nope', user: line('user.sh') }, true),
			notCommand: readClaudeStatusLineConfig({ user: JSON.stringify({ statusLine: { type: 'static', command: 'x' } }) }, true),
			none: readClaudeStatusLineConfig({ user: '{"model":"opus"}' }, true),
		}, {
			trusted: { command: 'local.sh', scope: 'local' },
			untrusted: { command: 'user.sh', scope: 'user' },
			projectOnly: { command: 'project.sh', scope: 'project' },
			untrustedProjectOnly: undefined,
			brokenLocal: { command: 'user.sh', scope: 'user' },
			notCommand: undefined,
			none: undefined,
		});
	});

	test('the first line with text is shown, cut to its limit', () => {
		assert.deepStrictEqual([
			claudeStatusLineText('\n  \nOpus 5.5 - main\nsecond'),
			claudeStatusLineText('\u001b[0m\nreal'),
			claudeStatusLineText('   \n'),
			claudeStatusLineText('x'.repeat(600))?.length,
		], ['Opus 5.5 - main', 'real', undefined, 500]);
	});

	test('ANSI colors become segments: 16 colors, bright, 256 below 16, 24-bit, bold and reset', () => {
		assert.deepStrictEqual(parseClaudeStatusLine('\u001b[1;32mmain\u001b[0m \u001b[91m+3\u001b[39m \u001b[38;5;4mblue\u001b[38;5;200m256\u001b[0m \u001b[38;2;255;128;0morange\u001b[0m\u001b[K end'), [
			{ text: 'main', color: 2, bold: true },
			{ text: ' ' },
			{ text: '+3', color: 9 },
			{ text: ' ' },
			{ text: 'blue', color: 4 },
			{ text: '256' },
			{ text: ' ' },
			{ text: 'orange', color: '#ff8000' },
			{ text: ' end' },
		]);
	});
});
