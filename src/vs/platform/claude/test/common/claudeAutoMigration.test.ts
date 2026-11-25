/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeOldAutoSettings, migrateClaudeAutoEnabled } from '../../common/claudeAutoMigration.js';

suite('Claude Auto migration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const none: ClaudeOldAutoSettings = { modelsAuto: undefined, permissionMode: undefined, autoKeep: undefined, defaultModel: undefined };

	test('nothing set keeps the default', () => {
		assert.strictEqual(migrateClaudeAutoEnabled(none), undefined);
	});

	test('explicit off values keep the default', () => {
		assert.strictEqual(migrateClaudeAutoEnabled({ ...none, modelsAuto: 'off', autoKeep: 'off', permissionMode: 'askBeforeEdits' }), undefined);
	});

	for (const strategy of ['cost', 'balance', 'intelligence']) {
		test(`Auto model ${strategy} turns Auto on`, () => {
			assert.strictEqual(migrateClaudeAutoEnabled({ ...none, modelsAuto: strategy }), true);
		});
	}

	test('Auto permission level turns Auto on', () => {
		assert.strictEqual(migrateClaudeAutoEnabled({ ...none, permissionMode: 'auto' }), true);
	});

	for (const keep of ['thisChat', 'always']) {
		test(`Auto-Keep ${keep} turns Auto on`, () => {
			assert.strictEqual(migrateClaudeAutoEnabled({ ...none, autoKeep: keep }), true);
		});
	}

	test('a hand-picked model stays manual', () => {
		assert.strictEqual(migrateClaudeAutoEnabled({ ...none, defaultModel: 'claude-opus-4-1' }), false);
	});

	test('a blank model does not count as picked', () => {
		assert.strictEqual(migrateClaudeAutoEnabled({ ...none, defaultModel: '  ' }), undefined);
	});

	test('an old Auto setting wins over a picked model', () => {
		assert.strictEqual(migrateClaudeAutoEnabled({ ...none, modelsAuto: 'balance', defaultModel: 'claude-opus-4-1' }), true);
	});

	test('unknown values are ignored', () => {
		assert.strictEqual(migrateClaudeAutoEnabled({ modelsAuto: 5, permissionMode: {}, autoKeep: null, defaultModel: 3 }), undefined);
	});
});
