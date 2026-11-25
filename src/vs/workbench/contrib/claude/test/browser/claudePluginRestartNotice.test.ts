/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudePluginRestartNotice } from '../../browser/chat/claudePluginRestartNotice.js';

suite('Claude plugin restart notice', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('shows only for a session with plugin changes, names them, and Restart Session restarts that session', () => {
		const container = document.createElement('div');
		const notice = store.add(new ClaudePluginRestartNotice(container));
		const restarted: string[] = [];
		const restart = (sessionId: string) => restarted.push(sessionId);
		const read = () => ({
			hidden: notice.element.hidden,
			title: notice.element.querySelector('.title')?.textContent,
			button: notice.element.querySelector('button')?.textContent,
		});

		const notStarted = notice.sync('pane-1', [], restart);
		const quiet = read();
		const shown = notice.sync('pane-1', [{ plugin: 'commit-commands', removed: false }], restart);
		const loaded = read();
		const unchanged = notice.sync('pane-1', [{ plugin: 'commit-commands', removed: false }], restart);
		notice.element.querySelector('button')!.click();
		notice.sync('pane-1', [{ plugin: 'commit-commands', removed: false }, { plugin: 'lint', removed: true }], restart);
		const applied = read();
		const gone = notice.sync(undefined, [], restart);

		assert.deepStrictEqual({ notStarted, quiet, shown, loaded, unchanged, restarted, applied, gone, hiddenAfter: notice.element.hidden }, {
			notStarted: false,
			quiet: { hidden: true, title: undefined, button: undefined },
			shown: true,
			loaded: { hidden: false, title: 'Restart this session to load commit-commands', button: 'Restart Session' },
			unchanged: false,
			restarted: ['pane-1'],
			applied: { hidden: false, title: 'Restart this session to apply changes to commit-commands, lint', button: 'Restart Session' },
			gone: true,
			hiddenAfter: true,
		});
	});
});
