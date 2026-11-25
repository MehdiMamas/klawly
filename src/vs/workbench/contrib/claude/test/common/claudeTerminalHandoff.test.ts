/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CLAUDE_TERMINAL_HANDOFF_MAX_BYTES, formatClaudeTerminalHandoff, parseClaudeTerminalHandoff, readClaudeTerminalHandoffPath } from '../../common/claudeTerminalHandoff.js';

suite('Klawly terminal handoff file (issue 1186)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the path must be an absolute .json file without ..', () => {
		assert.deepStrictEqual([
			readClaudeTerminalHandoffPath('/tmp/h.json'),
			readClaudeTerminalHandoffPath('C:\\Users\\a\\h.JSON'),
			readClaudeTerminalHandoffPath('rel/h.json'),
			readClaudeTerminalHandoffPath('/tmp/../etc/h.json'),
			readClaudeTerminalHandoffPath('/tmp/h.txt'),
			readClaudeTerminalHandoffPath('//server/h.json'),
			readClaudeTerminalHandoffPath('Fix the test'),
			readClaudeTerminalHandoffPath(null),
		], ['/tmp/h.json', 'C:\\Users\\a\\h.JSON', undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	test('a handoff is trimmed and capped; wrong version, junk, empty and oversize ones are dropped', () => {
		const many = Array.from({ length: 30 }, (_, i) => `goal ${i}`);
		const parsed = parseClaudeTerminalHandoff(JSON.stringify({
			version: 1, summary: '  Fixing login ', branch: 'fix/1', goals: many, open: ['a', 3, '  '], waitingOnUser: ['ok?'], decisions: 'no', extra: 1,
		}));
		assert.deepStrictEqual({ ...parsed, goals: parsed?.goals.length }, {
			version: 1, summary: 'Fixing login', branch: 'fix/1', goals: 20, open: ['a'], waitingOnUser: ['ok?'], decisions: [],
		});
		assert.deepStrictEqual([
			parseClaudeTerminalHandoff('{"version":2,"goals":["a"]}'),
			parseClaudeTerminalHandoff('nope'),
			parseClaudeTerminalHandoff('[]'),
			parseClaudeTerminalHandoff('{"version":1}'),
			parseClaudeTerminalHandoff(' '.repeat(CLAUDE_TERMINAL_HANDOFF_MAX_BYTES + 1)),
		], [undefined, undefined, undefined, undefined, undefined]);
	});

	test('the note lists the sections that have items', () => {
		assert.strictEqual(formatClaudeTerminalHandoff({ version: 1, summary: 'Fixing login', branch: 'fix/1', goals: ['Ship it'], open: [], waitingOnUser: ['Pick a name'], decisions: [] }),
			'Handoff from my terminal session:\nFixing login\nBranch: fix/1\n\nGoals:\n- Ship it\n\nWaiting on me:\n- Pick a name');
	});
});
