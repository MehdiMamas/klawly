/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeCommand, escapeCmdArgument } from '../../node/claudeWindowsCommand.js';

suite('Claude Windows command', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a native program and any other platform start directly', () => {
		assert.deepStrictEqual([
			claudeCommand('C:\\bin\\claude.exe', ['-p'], 'win32', () => false),
			claudeCommand('/usr/bin/claude', ['-p'], 'darwin', () => false),
			claudeCommand('/x/claude.cmd', ['-p'], 'linux', () => false),
		], [
			{ file: 'C:\\bin\\claude.exe', args: ['-p'], verbatim: false },
			{ file: '/usr/bin/claude', args: ['-p'], verbatim: false },
			{ file: '/x/claude.cmd', args: ['-p'], verbatim: false },
		]);
	});

	test('a shim with a native claude.exe beside it starts the native program', () => {
		const beside = claudeCommand('C:\\npm\\claude.cmd', ['-p'], 'win32', path => path === 'C:\\npm\\claude.exe');
		const packaged = claudeCommand('C:\\npm\\claude.cmd', ['-p'], 'win32', path => path.endsWith('claude-code\\bin\\claude.exe'));
		assert.deepStrictEqual([beside, packaged], [
			{ file: 'C:\\npm\\claude.exe', args: ['-p'], verbatim: false },
			{ file: 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', args: ['-p'], verbatim: false },
		]);
	});

	test('a shim without one goes through cmd.exe with every argument escaped', () => {
		const command = claudeCommand('C:\\Program Files\\npm\\claude.cmd', ['--settings', '{"a":"b & calc"}', '100%'], 'win32', () => false);
		assert.deepStrictEqual({ verbatim: command.verbatim, flags: command.args.slice(0, 3), line: command.args[3] }, {
			verbatim: true,
			flags: ['/d', '/s', '/c'],
			line: `"C:\\Program^ Files\\npm\\claude.cmd ${escapeCmdArgument('--settings', true)} ${escapeCmdArgument('{"a":"b & calc"}', true)} ${escapeCmdArgument('100%', true)}"`,
		});
		assert.ok(!/[^^]&/.test(command.args[3]), 'an & is always escaped');
	});

	test('escaping neutralizes quotes, ampersands and percent signs', () => {
		assert.deepStrictEqual([
			escapeCmdArgument('a b', false),
			escapeCmdArgument('x" & calc', false),
			escapeCmdArgument('%PATH%', false),
		], ['^"a^ b^"', '^"x\\^"^ ^&^ calc^"', '^"^%PATH^%^"']);
	});
});
