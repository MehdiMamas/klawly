/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';

const enum FirstRunWidthState {
	Pending = 'pending',
	Done = 'done'
}

/**
 * A part a new profile gives a Klawly width instead of the upstream
 * `min(300, width / 4)` default.
 */
interface IFirstRunPartWidth {
	readonly part: Parts.SIDEBAR_PART | Parts.AUXILIARYBAR_PART;
	/** The workbench layout's own (profile) storage key for the part's size. */
	readonly layoutKey: string;
	/** Whether Klawly still has to size the part in this profile. */
	readonly stateKey: string;
	readonly width: number;
}

/**
 * Widths from `--k-sidebar-w` and `--k-chat-w` in `design/assets/global.css`.
 */
export const CLAUDE_FIRST_RUN_PART_WIDTHS: readonly IFirstRunPartWidth[] = [
	{ part: Parts.SIDEBAR_PART, layoutKey: 'workbench.sideBar.size', stateKey: 'klawly.layout.firstRunSideBarWidth', width: 260 },
	{ part: Parts.AUXILIARYBAR_PART, layoutKey: 'workbench.auxiliaryBar.size', stateKey: 'klawly.layout.firstRunAgentPaneWidth', width: 400 },
];

/**
 * Sizes the side bar and the agent pane once per profile, when the profile had
 * no stored layout. A part that is hidden on first run is sized the first time
 * it shows. After that the layout keeps whatever size the user gives it.
 */
export class ClaudeFirstRunLayoutContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeFirstRunLayout';

	constructor(
		@IWorkbenchLayoutService private readonly _layout: IWorkbenchLayoutService,
		@IStorageService private readonly _storage: IStorageService,
	) {
		super();
		for (const entry of CLAUDE_FIRST_RUN_PART_WIDTHS) {
			this.track(entry);
		}
	}

	private track(entry: IFirstRunPartWidth): void {
		let state = this._storage.get(entry.stateKey, StorageScope.PROFILE);
		if (state === undefined) {
			// A stored size means the profile had a layout before Klawly sized it: keep it.
			state = this._storage.get(entry.layoutKey, StorageScope.PROFILE) === undefined ? FirstRunWidthState.Pending : FirstRunWidthState.Done;
			this._storage.store(entry.stateKey, state, StorageScope.PROFILE, StorageTarget.MACHINE);
		}
		if (state !== FirstRunWidthState.Pending || this.apply(entry)) {
			return;
		}

		// The grid shows a part before it gives it its size, so size it a tick later.
		const store = this._register(new DisposableStore());
		const scheduler = store.add(new RunOnceScheduler(() => {
			if (this.apply(entry)) {
				store.dispose();
			}
		}, 0));
		store.add(this._layout.onDidChangePartVisibility(e => {
			if (e.partId === entry.part && e.visible) {
				scheduler.schedule();
			}
		}));
	}

	private apply(entry: IFirstRunPartWidth): boolean {
		if (this._storage.get(entry.stateKey, StorageScope.PROFILE) !== FirstRunWidthState.Pending) {
			return true; // another window of this profile sized it already
		}
		if (!this._layout.isVisible(entry.part) || (entry.part === Parts.AUXILIARYBAR_PART && this._layout.isAuxiliaryBarMaximized())) {
			return false;
		}
		const { height } = this._layout.getSize(entry.part);
		this._layout.setSize(entry.part, { width: entry.width, height });
		this._storage.store(entry.stateKey, FirstRunWidthState.Done, StorageScope.PROFILE, StorageTarget.MACHINE);
		return true;
	}
}
