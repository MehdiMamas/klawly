/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeSwitcherProjects, claudeUnreadElsewhere } from '../../common/claudeProjectSwitcher.js';

/** Issue 1459: the window switcher's project list and unread badge. */
suite('Claude project switcher', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const klawly = URI.file('/work/klawly');
	const relay = URI.file('/work/relay');
	const docs = URI.file('/work/docs');

	test('lists open projects first, then recent ones, each once, unread first within a group', () => {
		const projects = claudeSwitcherProjects([klawly, relay], [docs, relay], new Map([[relay.fsPath, 2]]));
		assert.deepStrictEqual(projects.map(p => [p.name, p.unread, p.current]), [['relay', 2, false], ['klawly', 0, true], ['docs', 0, false]]);
	});

	test('the badge counts unread hand-offs in other projects only', () => {
		const projects = claudeSwitcherProjects([klawly], [relay], new Map([[klawly.fsPath, 4], [relay.fsPath, 3]]));
		assert.strictEqual(claudeUnreadElsewhere(projects), 3);
	});
});
