/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';

/** The id upstream's remote indicator (`remoteIndicator.ts`) uses for its status bar entry. */
export const REMOTE_INDICATOR_ENTRY_ID = 'status.host';

/**
 * Where the default stands, per profile: `hidden` once Klawly hid the indicator,
 * `done` once nothing is left to do (the user had already hidden it, or a remote
 * window brought it back).
 */
export const REMOTE_INDICATOR_DEFAULT_STORAGE_KEY = 'klawly.statusbar.remoteIndicatorDefault';

/**
 * Hides upstream's remote indicator (the `><` item at the far left of the status
 * bar) by default, so the bar starts with the branch. It only flips the entry's
 * visibility, once per profile: the item stays in the status bar context menu to
 * show again, and the remote commands stay in the command palette. A remote
 * window brings it back, since there it shows the connection.
 */
export class ClaudeRemoteIndicatorDefaultContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeRemoteIndicatorDefault';

	constructor(
		@IStatusbarService statusbar: IStatusbarService,
		@IStorageService storage: IStorageService,
		@IWorkbenchEnvironmentService environment: IWorkbenchEnvironmentService,
	) {
		super();

		const state = storage.get(REMOTE_INDICATOR_DEFAULT_STORAGE_KEY, StorageScope.PROFILE);
		if (state === 'done') {
			return;
		}
		if (environment.remoteAuthority) {
			if (state === 'hidden' && !statusbar.isEntryVisible(REMOTE_INDICATOR_ENTRY_ID)) {
				statusbar.updateEntryVisibility(REMOTE_INDICATOR_ENTRY_ID, true);
			}
			storage.store(REMOTE_INDICATOR_DEFAULT_STORAGE_KEY, 'done', StorageScope.PROFILE, StorageTarget.USER);
			return;
		}
		if (state === undefined) {
			if (statusbar.isEntryVisible(REMOTE_INDICATOR_ENTRY_ID)) {
				statusbar.updateEntryVisibility(REMOTE_INDICATOR_ENTRY_ID, false);
				storage.store(REMOTE_INDICATOR_DEFAULT_STORAGE_KEY, 'hidden', StorageScope.PROFILE, StorageTarget.USER);
			} else {
				storage.store(REMOTE_INDICATOR_DEFAULT_STORAGE_KEY, 'done', StorageScope.PROFILE, StorageTarget.USER);
			}
		}
	}
}
