/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { suite, test } from 'node:test';

const root = path.join(import.meta.dirname, '..', '..', '..');

/**
 * Pages whose Content-Security-Policy allows their inline script by hash. Editing
 * the script without its hash blocks it, and with it every webview (issue 546).
 */
const pages = [
	'src/vs/workbench/contrib/webview/browser/pre/index.html',
	'src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html',
];

suite('Inline script hashes (issue 546)', () => {
	test('each page\'s CSP names the hash of its inline script', () => {
		const result = pages.map(page => {
			const html = fs.readFileSync(path.join(root, page), 'utf8').replace(/\r\n/g, '\n');
			const allowed = [...html.matchAll(/'sha256-(?<hash>[A-Za-z0-9+/=]+)'/g)].map(match => match.groups!.hash);
			const scripts = [...html.matchAll(/<script(?<attributes>[^>]*)>(?<body>[\s\S]*?)<\/script>/g)]
				.filter(match => !/\bsrc=/.test(match.groups!.attributes))
				.map(match => createHash('sha256').update(match.groups!.body).digest('base64'));
			return { page, blocked: scripts.filter(hash => !allowed.includes(hash)), scripts: scripts.length };
		});
		assert.deepStrictEqual(result, pages.map(page => ({ page, blocked: [], scripts: 1 })));
	});
});
