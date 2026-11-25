/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeProjectFolderName, claudeTranscriptList, claudeTranscriptTitle } from '../../common/claudeTerminalTranscripts.js';

const ID_A = '015d1452-d47d-4611-9f1a-baaa4fbacc00';
const ID_B = '0168db6d-3ee4-464b-9217-a3a341dd4078';

suite('Klawly terminal session browser (issue 1186)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the project folder name follows Claude Code, the list is newest first and ignores other files', () => {
		assert.deepStrictEqual({
			windows: claudeProjectFolderName('C:\\Users\\someone\\Projects\\klawly'),
			dot: claudeProjectFolderName('/home/me/.config/app'),
			list: claudeTranscriptList([
				{ name: `${ID_A}.jsonl`, mtime: 1 },
				{ name: 'notes.md', mtime: 9 },
				{ name: ID_A, mtime: 9 },
				{ name: `${ID_B}.jsonl`, mtime: 5 },
			]),
		}, {
			windows: 'C--Users-someone-Projects-klawly',
			dot: '-home-me--config-app',
			list: [{ sessionId: ID_B, mtime: 5 }, { sessionId: ID_A, mtime: 1 }],
		});
	});

	test('the title is the first typed prompt, one line; commands and a cut last line are skipped', () => {
		const jsonl = [
			'{"type":"mode"}',
			'{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"}}',
			'{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix the\\n  login   bug"}]}}',
			'{"type":"user","message":{"role":"user","content":"second"}}',
		].join('\n');
		assert.deepStrictEqual([
			claudeTranscriptTitle(jsonl),
			claudeTranscriptTitle('{"type":"user","message":{"content":"cut'),
			claudeTranscriptTitle(`{"type":"user","message":{"content":"${'x'.repeat(200)}"}}`)?.length,
		], ['Fix the login bug', undefined, 100]);
	});
});
