/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CLAUDE_CANVAS_CSP, claudeCanvasDocument, claudeCanvasStandalone } from '../../common/claudeCanvasDocument.js';

suite('Claude canvas document (issue 493)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the sealed policy comes first, before anything in the page can run', () => {
		const meta = `<meta http-equiv="Content-Security-Policy" content="${CLAUDE_CANVAS_CSP}">`;
		assert.deepStrictEqual({
			policy: CLAUDE_CANVAS_CSP,
			withDoctype: claudeCanvasDocument('<!doctype html><html><head><script>x()</script></head></html>'),
			withoutDoctype: claudeCanvasDocument('<table></table>'),
			leadingSpace: claudeCanvasDocument('\n  <!DOCTYPE html><p>a</p>'),
			byteOrderMark: claudeCanvasDocument('\uFEFF<!doctype html><p>b</p>'),
		}, {
			policy: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'`,
			withDoctype: `<!doctype html>${meta}<html><head><script>x()</script></head></html>`,
			withoutDoctype: `<!DOCTYPE html>${meta}<table></table>`,
			leadingSpace: `\n  <!DOCTYPE html>${meta}<p>a</p>`,
			byteOrderMark: `\uFEFF<!doctype html>${meta}<p>b</p>`,
		});
	});

	test('an export carries the sealed policy once, however often it is exported (issue 885)', () => {
		const once = claudeCanvasStandalone('<p>a</p>');
		assert.deepStrictEqual({
			first: once,
			again: claudeCanvasStandalone(once),
		}, {
			first: claudeCanvasDocument('<p>a</p>'),
			again: claudeCanvasDocument('<p>a</p>'),
		});
	});
});
