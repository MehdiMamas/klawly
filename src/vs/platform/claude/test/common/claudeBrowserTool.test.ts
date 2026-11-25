/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DEFAULT_PERMISSION_POLICY, PermissionPolicy } from '../../common/claudePermissions.js';
import { CLAUDE_BROWSER_TEXT_LIMIT, CLAUDE_BROWSER_TOOL_ID, claudeBrowserToolText, clipClaudeBrowserText, findClaudeBrowserLocalUrl, isClaudeBrowserLocalUrl } from '../../common/claudeBrowserTool.js';
import { evaluateToolPolicy, ToolPolicyContext } from '../../common/claudeToolPolicy.js';

function context(policy: Partial<PermissionPolicy> = {}): ToolPolicyContext {
	return {
		cwd: '/ws',
		workspaceFolders: ['/ws'],
		additionalDirectories: [],
		trusted: true,
		policy: { ...DEFAULT_PERMISSION_POLICY, ...policy },
	};
}

suite('Claude Agent Browser tool', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only addresses on this machine count as local', () => {
		assert.deepStrictEqual([
			'http://localhost:5173/',
			'https://app.localhost/x',
			'http://127.0.0.1:3000',
			'http://[::1]:8080/',
			'https://example.com/',
			'http://localhost.evil.com/',
			'file:///etc/passwd',
			'not a url',
		].map(isClaudeBrowserLocalUrl), [true, true, true, true, false, false, false, false]);
	});

	test('long text is cut and says so', () => {
		assert.strictEqual(clipClaudeBrowserText('abc'), 'abc');
		const clipped = clipClaudeBrowserText('x'.repeat(CLAUDE_BROWSER_TEXT_LIMIT + 5));
		assert.ok(clipped.endsWith('[cut: 5 more characters]'));
	});

	test('results map to text and an error flag', () => {
		assert.deepStrictEqual([
			claudeBrowserToolText({ kind: 'done', text: 'ok' }),
			claudeBrowserToolText({ kind: 'refused', message: 'no' }),
			claudeBrowserToolText({ kind: 'failed', message: 'boom' }),
		], [
			{ text: 'ok', isError: false },
			{ text: 'no', isError: true },
			{ text: 'The browser could not do that: boom', isError: true },
		]);
	});

	test('localhost and actions on an open page run without a card; other sites follow the network setting', async () => {
		const behavior = async (input: object, network: PermissionPolicy['network']) => (await evaluateToolPolicy(CLAUDE_BROWSER_TOOL_ID, input, context({ network }))).behavior;
		assert.deepStrictEqual([
			await behavior({ action: 'open', url: 'http://localhost:5173' }, 'deny'),
			await behavior({ action: 'click', selector: '#save' }, 'deny'),
			await behavior({ action: 'open', url: 'https://example.com' }, 'allow'),
			await behavior({ action: 'open', url: 'https://example.com' }, 'deny'),
			await behavior({ action: 'navigate', url: 'https://example.com' }, 'ask'),
		], ['allow', 'allow', 'allow', 'deny', 'ask']);
	});

	test('finds a localhost address in dev server output and ignores other sites', () => {
		assert.deepStrictEqual([
			findClaudeBrowserLocalUrl('  Local:   http://localhost:5173/'),
			findClaudeBrowserLocalUrl('listening on http://0.0.0.0:3000.'),
			findClaudeBrowserLocalUrl('see https://example.com/docs'),
			findClaudeBrowserLocalUrl('no address here'),
		], ['http://localhost:5173/', 'http://localhost:3000', undefined, undefined]);
	});
});
