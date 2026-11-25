/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeProjectFolderName, lastClaudeCustomTitle, readClaudeCodeSessionTitle } from '../../node/claudeSessionTitle.js';

suite('Claude session title', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the last custom-title line wins, and a cut or foreign line is ignored', () => {
		const transcript = ['{"type":"user"}', '{"type":"custom-title","customTitle":"First"}', 'cut line "custom-title"', '{"type":"custom-title","customTitle":" Second "}', '{"type":"custom-title","customTitle":"  "}'].join('\n');
		assert.deepStrictEqual([lastClaudeCustomTitle(transcript), lastClaudeCustomTitle('{"type":"user"}')], ['Second', undefined]);
	});

	test('the title is read from the transcript of the project folder, and an unsafe id reads nothing', async () => {
		const config = mkdtempSync(join(tmpdir(), 'klawly-title-'));
		try {
			const id = '0f9e6a3c-1111-2222-3333-444455556666';
			const folder = join(config, 'projects', claudeProjectFolderName('/work/my app'));
			mkdirSync(folder, { recursive: true });
			writeFileSync(join(folder, `${id}.jsonl`), '{"type":"custom-title","customTitle":"Fix login"}\n');
			assert.deepStrictEqual({
				folder: claudeProjectFolderName('/work/my app'),
				title: await readClaudeCodeSessionTitle(id, '/work/my app', config),
				missing: await readClaudeCodeSessionTitle('aaaaaaaa-0000', '/work/my app', config),
				unsafe: await readClaudeCodeSessionTitle('../../etc/passwd', '/work/my app', config),
			}, { folder: '-work-my-app', title: 'Fix login', missing: undefined, unsafe: undefined });
		} finally {
			rmSync(config, { recursive: true, force: true });
		}
	});
});
