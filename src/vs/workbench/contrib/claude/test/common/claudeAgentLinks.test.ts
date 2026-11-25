/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { readClaudeAgentLink } from '../../common/claudeAgentLinks.js';

suite('Klawly agent links (issue 519)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('new and open links, in both URI shapes; anything else is not an agent link', () => {
		const read = (link: string) => {
			const uri = URI.parse(link);
			return readClaudeAgentLink(uri.authority, uri.path, uri.query);
		};
		assert.deepStrictEqual([
			read('klawly://agent/new?prompt=Fix%20the%20login%20test&mode=plan'),
			read('klawly:agent/new?prompt=hi'),
			read('klawly://agent/new?mode=edit'),
			read('klawly://agent/new?prompt=x&mode=yolo'),
			read('klawly://agent/open?session=1f2e-ab_c'),
			read('klawly://agent/open?session=../../etc'),
			read('klawly://agent/delete?session=x'),
			read('klawly://other/new?prompt=x'),
			read('klawly://agent/new?prompt=hi&folder=%2Fhome%2Fme%2Fapp'),
			read('klawly://agent/new?prompt=hi&folder=C%3A%5Cwork%5Capp'),
			read('klawly://agent/new?prompt=hi&folder=relative%2Fapp'),
			read('klawly://agent/new?prompt=hi&folder=%2Fhome%2Fme%2F..%2Froot'),
			read('klawly://agent/new?prompt=hi&folder=%2F%2Fevil-host%2Fshare'),
			read('klawly://agent/new?prompt=hi&folder=%2Fhome%2Fme%0Aapp'),
			(read(`klawly://agent/new?prompt=${'a'.repeat(9000)}`) as { prompt: string }).prompt.length,
		], [
			{ kind: 'new', prompt: 'Fix the login test', mode: 'plan' },
			{ kind: 'new', prompt: 'hi' },
			{ kind: 'new', prompt: '', mode: 'agent' },
			{ kind: 'new', prompt: 'x' },
			{ kind: 'open', session: '1f2e-ab_c' },
			undefined,
			undefined,
			undefined,
			{ kind: 'new', prompt: 'hi', folder: '/home/me/app' },
			{ kind: 'new', prompt: 'hi', folder: 'C:\\work\\app' },
			{ kind: 'new', prompt: 'hi' },
			{ kind: 'new', prompt: 'hi' },
			{ kind: 'new', prompt: 'hi' },
			{ kind: 'new', prompt: 'hi' },
			8000,
		]);
	});

	test('an import link needs a Claude Code session id and an absolute folder; its handoff text is capped (issue 1186)', () => {
		const read = (link: string) => {
			const uri = URI.parse(link);
			return readClaudeAgentLink(uri.authority, uri.path, uri.query);
		};
		const id = '0f8e2a4c-1b3d-4e5f-9a7b-6c5d4e3f2a1b';
		assert.deepStrictEqual([
			read(`klawly://agent/import?session=${id}&folder=%2Fhome%2Fme%2Fapp&handoff=Carry%20on`),
			read(`klawly:agent/import?session=${id.toUpperCase()}&folder=C%3A%5Cwork%5Capp`),
			read('klawly://agent/import?session=abc-1&folder=%2Fhome%2Fme%2Fapp'),
			read(`klawly://agent/import?session=${id}%2F..&folder=%2Fhome%2Fme%2Fapp`),
			read(`klawly://agent/import?folder=%2Fhome%2Fme%2Fapp`),
			read(`klawly://agent/import?session=${id}`),
			read(`klawly://agent/import?session=${id}&folder=relative%2Fapp`),
			read(`klawly://agent/import?session=${id}&folder=%2Fhome%2Fme%2F..%2Froot`),
			read(`klawly://agent/import?session=${id}&folder=%2F%2Fevil-host%2Fshare`),
			(read(`klawly://agent/import?session=${id}&folder=%2Fa&handoff=${'a'.repeat(9000)}`) as { handoff: string }).handoff.length,
		], [
			{ kind: 'import', session: id, folder: '/home/me/app', handoff: 'Carry on' },
			{ kind: 'import', session: id, folder: 'C:\\work\\app', handoff: '' },
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			8000,
		]);
	});
});
