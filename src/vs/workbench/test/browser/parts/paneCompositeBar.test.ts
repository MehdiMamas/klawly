/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../base/common/event.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../platform/configuration/test/common/testConfigurationService.js';
import { ViewContainerActivityAction } from '../../../browser/parts/paneCompositeBar.js';
import { IPaneCompositePart } from '../../../browser/parts/paneCompositePart.js';
import { IPaneComposite } from '../../../common/panecomposite.js';
import { IActivity, IActivityService } from '../../../services/activity/common/activity.js';
import { Parts } from '../../../services/layout/browser/layoutService.js';
import { TestLayoutService } from '../workbenchTestServices.js';

class RecordingLayoutService extends TestLayoutService {
	readonly hidden: Parts[] = [];

	override async setPartHidden(hidden: boolean, part: Parts): Promise<void> {
		if (hidden) {
			this.hidden.push(part);
		}
	}
}

class TestActivityService extends mock<IActivityService>() {
	override readonly onDidChangeActivity = Event.None;

	override getViewContainerActivities(): IActivity[] {
		return [];
	}
}

suite('ViewContainerActivityAction', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function clickActiveIcon(part: Parts): Promise<{ hidden: Parts[]; opened: string[] }> {
		const layoutService = new RecordingLayoutService();
		const opened: string[] = [];
		const paneCompositePart = new class extends mock<IPaneCompositePart>() {
			override getActivePaneComposite() {
				return new class extends mock<IPaneComposite>() {
					override getId() { return 'workbench.view.explorer'; }
				};
			}
			override async openPaneComposite(id: string) {
				opened.push(id);
				return undefined;
			}
		};
		const action = store.add(new ViewContainerActivityAction(
			{ id: 'workbench.view.explorer', name: 'Explorer', classNames: undefined },
			part,
			paneCompositePart,
			layoutService,
			new TestConfigurationService({ 'workbench.activityBar.iconClickBehavior': 'toggle' }),
			new TestActivityService(),
		));
		await action.run({ preserveFocus: false });
		return { hidden: layoutService.hidden, opened };
	}

	test('clicking the icon of the open view hides the primary side bar from a side or a top activity bar, and leaves the secondary side bar alone (issue 747)', async () => {
		assert.deepStrictEqual([
			await clickActiveIcon(Parts.ACTIVITYBAR_PART),
			await clickActiveIcon(Parts.SIDEBAR_PART),
			await clickActiveIcon(Parts.AUXILIARYBAR_PART),
		], [
			{ hidden: [Parts.SIDEBAR_PART], opened: [] },
			{ hidden: [Parts.SIDEBAR_PART], opened: [] },
			{ hidden: [], opened: ['workbench.view.explorer'] },
		]);
	});
});
