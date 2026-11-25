/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IViewSize } from '../../../../../base/browser/ui/grid/grid.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IPartVisibilityChangeEvent, Parts } from '../../../../services/layout/browser/layoutService.js';
import { TestLayoutService } from '../../../../test/browser/workbenchTestServices.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { ClaudeFirstRunLayoutContribution } from '../../browser/claudeFirstRunLayout.js';

class FakeLayoutService extends TestLayoutService {
	readonly hidden = new Set<Parts>();
	readonly resized: [Parts, number][] = [];
	readonly visibility = new Emitter<IPartVisibilityChangeEvent>();
	override readonly onDidChangePartVisibility = this.visibility.event;

	override isVisible(part: Parts): boolean { return !this.hidden.has(part); }
	override getSize(_part: Parts): IViewSize { return { width: 300, height: 800 }; }
	override setSize(part: Parts, size: IViewSize): void { this.resized.push([part, size.width]); }

	show(part: Parts): void {
		this.hidden.delete(part);
		this.visibility.fire({ partId: part, visible: true });
	}
}

suite('Claude first-run layout', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let layout: FakeLayoutService;
	let storage: TestStorageService;

	setup(() => {
		layout = new FakeLayoutService();
		disposables.add(layout.visibility);
		storage = disposables.add(new TestStorageService());
	});

	test('a new profile gets the prototype widths once', () => {
		disposables.add(new ClaudeFirstRunLayoutContribution(layout, storage));
		disposables.add(new ClaudeFirstRunLayoutContribution(layout, storage));
		assert.deepStrictEqual(layout.resized, [[Parts.SIDEBAR_PART, 260], [Parts.AUXILIARYBAR_PART, 400]]);
	});

	test('a profile with a stored layout keeps its sizes', () => {
		storage.store('workbench.sideBar.size', 350, StorageScope.PROFILE, StorageTarget.MACHINE);
		storage.store('workbench.auxiliaryBar.size', 320, StorageScope.PROFILE, StorageTarget.MACHINE);
		disposables.add(new ClaudeFirstRunLayoutContribution(layout, storage));
		assert.deepStrictEqual(layout.resized, []);
	});

	test('a part hidden on first run is sized when it first shows, also in a later session', () => runWithFakedTimers({}, async () => {
		layout.hidden.add(Parts.SIDEBAR_PART);
		disposables.add(new ClaudeFirstRunLayoutContribution(layout, storage));
		// The layout stores the hidden side bar's size on shutdown.
		storage.store('workbench.sideBar.size', 300, StorageScope.PROFILE, StorageTarget.MACHINE);
		disposables.add(new ClaudeFirstRunLayoutContribution(layout, storage));
		layout.show(Parts.SIDEBAR_PART);
		await timeout(0);
		layout.show(Parts.SIDEBAR_PART);
		await timeout(0);
		assert.deepStrictEqual(layout.resized, [[Parts.AUXILIARYBAR_PART, 400], [Parts.SIDEBAR_PART, 260]]);
	}));
});
