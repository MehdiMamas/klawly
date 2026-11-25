/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { KlawlySyncStatus, klawlySyncStatusLine } from '../../../../../platform/claude/common/klawlySyncModel.js';
import { klawlySyncEntry, klawlySyncMemoryItems, klawlySyncMemoryProjectLabel, klawlySyncRunnableActions } from '../../electron-browser/klawlySyncStatusBar.js';

suite('Klawly Sync status bar', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const base: KlawlySyncStatus = { signedIn: true, paused: false, running: false, lastSyncedAt: 0, conflicts: 0, waiting: false, error: undefined };

	test('the entry hides while signed out and marks an error', () => {
		assert.deepStrictEqual([
			klawlySyncEntry({ ...base, signedIn: false }, 0),
			klawlySyncEntry(base, 0)?.kind,
			klawlySyncEntry({ ...base, error: 'HTTP 502' }, 0)?.kind,
			klawlySyncEntry({ ...base, error: 'HTTP 502' }, 0)?.command,
		], [undefined, undefined, 'error', 'klawly.sync.showStatus']);
	});

	test('only actions that can run are offered (DL-12): Resume runs through the service', () => {
		const actions = (status: KlawlySyncStatus) => klawlySyncRunnableActions(klawlySyncStatusLine(status, 0));
		assert.deepStrictEqual([
			actions({ ...base, paused: true }),
			actions({ ...base, error: '401 Bad credentials' }),
			actions({ ...base, error: 'HTTP 502' }),
		], [['resume'], ['signIn', 'retry', 'showDetails'], ['retry', 'showDetails']]);
	});

	test('the memory view groups notes under their project and badges this computer', () => {
		const items = klawlySyncMemoryItems({
			projects: [{ slug: 'github.com__o__app', notes: [{ name: 'tabs.md', path: '/m/tabs.md', bytes: 10, updatedAt: 1 }], transcripts: 2 }, { slug: 'alias__notes', notes: [], transcripts: 0 }],
			machines: [{ name: 'laptop', sessions: 1, current: false }, { name: 'pc', sessions: 5, current: true }],
		});
		assert.deepStrictEqual(
			items.map(item => item.type === 'separator' ? `--${item.label}` : `${item.label}|${item.description ?? ''}|${item.detail ?? ''}`),
			['--github.com/o/app', 'tabs.md|1 KB|', '2 synced sessions||', '--alias/notes', 'No notes yet||', '--Computers', 'laptop|1 session|', 'pc|5 sessions|This computer']
		);
		assert.strictEqual(klawlySyncMemoryProjectLabel('alias__x'), 'alias/x');
		assert.deepStrictEqual(klawlySyncMemoryItems({ projects: [], machines: [] }), []);
	});
});
