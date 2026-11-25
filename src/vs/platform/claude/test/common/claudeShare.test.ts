/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeGistArgs, claudeGistFilename, claudeShareContent, readClaudeGistUrl } from '../../common/claudeShare.js';

suite('Claude chat sharing (issue 490)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the shared text loses what the secret guard finds, and says how much', () => {
		const shared = claudeShareContent('# Fix\n\nkey sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ here');
		assert.deepStrictEqual({ removed: shared.removed, leaked: shared.content.includes('sk-ant-api03'), clean: claudeShareContent('# Plain').removed }, { removed: 1, leaked: false, clean: 0 });
	});

	test('the gist is secret (never --public), named from the title, with the text on stdin', () => {
		const args = claudeGistArgs({ filename: 'Fix the flaky checkout test / again', description: 'Klawly chat:\nFix', content: 'x' });
		assert.deepStrictEqual({
			args,
			public: args.includes('--public') || args.includes('-p'),
			empty: claudeGistFilename('***'),
			long: claudeGistFilename('a'.repeat(100)).length,
		}, {
			args: ['gist', 'create', '--filename', 'Fix-the-flaky-checkout-test-again.md', '--desc', 'Klawly chat: Fix', '-'],
			public: false,
			empty: 'klawly-chat.md',
			long: 63,
		});
	});

	test('the link is the last gist URL gh printed', () => {
		assert.deepStrictEqual([
			readClaudeGistUrl('- Creating gist Fix.md\n\u2713 Created secret gist Fix.md\nhttps://gist.github.com/someone/0123abcd\n'),
			readClaudeGistUrl('https://example.com/not-a-gist'),
			readClaudeGistUrl(''),
		], ['https://gist.github.com/someone/0123abcd', undefined, undefined]);
	});
});
