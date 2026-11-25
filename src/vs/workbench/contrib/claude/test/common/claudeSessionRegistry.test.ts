/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeRegistryImportLink, claudeRegistryImportList, parseClaudeRegistrySession } from '../../common/claudeSessionRegistry.js';

const ID_A = '015d1452-d47d-4611-9f1a-baaa4fbacc00';
const ID_B = '0168db6d-3ee4-464b-9217-a3a341dd4078';

suite('Klawly session registry import list (issue 1186)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a registry file becomes a session; bad files are skipped', () => {
		const file = JSON.stringify({ sessionId: ID_A, name: 'manager', state: 'working', task: ' fix it ', cwd: 'C:/Work/app', updatedAt: 5 });
		assert.deepStrictEqual([
			parseClaudeRegistrySession(file),
			parseClaudeRegistrySession('not json'),
			parseClaudeRegistrySession(JSON.stringify({ sessionId: 'x', cwd: 'C:/Work/app' })),
			parseClaudeRegistrySession(JSON.stringify({ sessionId: ID_A, cwd: 'relative/dir' })),
		], [
			{ sessionId: ID_A, name: 'manager', state: 'working', task: 'fix it', folder: 'C:/Work/app', updatedAt: 5 },
			undefined,
			undefined,
			undefined,
		]);
	});

	test('the list is newest first, one row per id, and hides ended sessions unless asked', () => {
		const a = { sessionId: ID_A, name: 'a', state: 'working', folder: 'C:/a', updatedAt: 1 };
		const aNewer = { ...a, updatedAt: 9, state: 'ended' };
		const b = { sessionId: ID_B, name: 'b', state: 'idle', folder: 'C:/b', updatedAt: 5 };
		assert.deepStrictEqual([
			claudeRegistryImportList([a, aNewer, b], false).map(s => s.name),
			claudeRegistryImportList([a, aNewer, b], true).map(s => s.name),
			claudeRegistryImportList([a, b], true, 1).map(s => s.name),
		], [['b'], ['a', 'b'], ['b']]);
	});

	test('the import link names the session and folder, encoded', () => {
		assert.strictEqual(claudeRegistryImportLink({ sessionId: ID_A, name: 'a', state: 'idle', folder: 'C:/My Work/app', updatedAt: 1 }),
			`klawly://agent/import?session=${ID_A}&folder=C%3A%2FMy%20Work%2Fapp`);
	});
});
