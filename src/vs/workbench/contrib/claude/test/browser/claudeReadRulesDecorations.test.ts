/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseReadRules } from '../../../../../platform/claude/common/claudeReadRules.js';
import { claudeReadBlockDecoration } from '../../browser/claudeReadRulesDecorations.js';

suite('Claude read-rule decorations', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a blocked path is marked with the rule, an open or re-allowed one is not', () => {
		const rules = parseReadRules('.env\nsecrets/*\n!secrets/public.txt', { source: 'user', home: '/home/me' });
		assert.deepStrictEqual(
			['/p/.env', '/p/secrets/k.txt', '/p/secrets/public.txt', '/p/a.txt'].map(path => claudeReadBlockDecoration(rules, path)?.tooltip),
			[
				'Claude cannot read this: .env (your block list)',
				'Claude cannot read this: secrets/* (your block list)',
				undefined,
				undefined,
			]);
	});
});
