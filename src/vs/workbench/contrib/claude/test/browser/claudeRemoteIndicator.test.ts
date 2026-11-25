/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { ClaudeRemoteIndicatorDefaultContribution, REMOTE_INDICATOR_DEFAULT_STORAGE_KEY, REMOTE_INDICATOR_ENTRY_ID } from '../../browser/claudeRemoteIndicator.js';

suite('ClaudeRemoteIndicatorDefaultContribution', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** Starts a window with the given hidden entries and stored state; returns what the window leaves behind. */
	function start(options: { hidden?: string[]; state?: string; remoteAuthority?: string }) {
		const hidden = new Set(options.hidden ?? []);
		const statusbar = {
			isEntryVisible: (id: string) => !hidden.has(id),
			updateEntryVisibility: (id: string, visible: boolean) => visible ? hidden.delete(id) : hidden.add(id),
		} as unknown as IStatusbarService;
		const storage = store.add(new TestStorageService());
		if (options.state !== undefined) {
			storage.store(REMOTE_INDICATOR_DEFAULT_STORAGE_KEY, options.state, StorageScope.PROFILE, StorageTarget.USER);
		}
		const environment = { remoteAuthority: options.remoteAuthority } as IWorkbenchEnvironmentService;
		store.add(new ClaudeRemoteIndicatorDefaultContribution(statusbar, storage, environment));
		return { visible: !hidden.has(REMOTE_INDICATOR_ENTRY_ID), state: storage.get(REMOTE_INDICATOR_DEFAULT_STORAGE_KEY, StorageScope.PROFILE) };
	}

	test('hides the indicator once in a local window and leaves it to the user after', () => {
		assert.deepStrictEqual([
			start({}),
			start({ state: 'hidden' }),
			start({ hidden: [REMOTE_INDICATOR_ENTRY_ID] }),
			start({ state: 'done' }),
		], [
			{ visible: false, state: 'hidden' },
			{ visible: true, state: 'hidden' },
			{ visible: false, state: 'done' },
			{ visible: true, state: 'done' },
		]);
	});

	test('shows the indicator in a remote window', () => {
		assert.deepStrictEqual([
			start({ remoteAuthority: 'ssh-remote+host' }),
			start({ remoteAuthority: 'ssh-remote+host', state: 'hidden', hidden: [REMOTE_INDICATOR_ENTRY_ID] }),
			start({ remoteAuthority: 'ssh-remote+host', state: 'done', hidden: [REMOTE_INDICATOR_ENTRY_ID] }),
			start({ remoteAuthority: 'ssh-remote+host', hidden: [REMOTE_INDICATOR_ENTRY_ID] }),
		], [
			{ visible: true, state: 'done' },
			{ visible: true, state: 'done' },
			{ visible: false, state: 'done' },
			{ visible: false, state: 'done' },
		]);
	});
});
