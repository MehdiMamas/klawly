/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { Extensions as ViewExtensions, IView, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../../common/views.js';
import { ViewDescriptorService } from '../../../../services/views/browser/viewDescriptorService.js';
import { registerClaudeViewDescriptors } from '../../browser/claudeViewRegistration.js';
import { CLAUDE_AGENT_VIEW_ID, CLAUDE_VIEW_CONTAINER_ID } from '../../common/claudeViews.js';

suite('Claude pane layout', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiationService: TestInstantiationService;

	setup(() => {
		disposables.add(instantiationService = workbenchInstantiationService(undefined, disposables));
		instantiationService.stub(IContextKeyService, disposables.add(instantiationService.createInstance(ContextKeyService)));
	});

	teardown(() => {
		const views = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		const containers = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
		const container = containers.get(CLAUDE_VIEW_CONTAINER_ID);
		if (container) {
			views.deregisterViews(views.getViews(container), container);
			containers.deregisterViewContainer(container);
		}
	});

	test('opens in the auxiliary bar, hides, moves, and keeps that layout', () => {
		const container = registerClaudeViewDescriptors(new SyncDescriptor(StubView as new () => IView));
		const views = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).getViews(container);
		assert.deepStrictEqual(views.map(view => view.id), [CLAUDE_AGENT_VIEW_ID]);
		assert.strictEqual(views.every(view => view.canMoveView && view.canToggleVisibility), true);

		const first = service();
		assert.strictEqual(first.getViewContainerLocation(container), ViewContainerLocation.AuxiliaryBar);
		const model = first.getViewContainerModel(container);
		assert.strictEqual(model.isVisible(CLAUDE_AGENT_VIEW_ID), true);

		model.setVisible(CLAUDE_AGENT_VIEW_ID, false);
		assert.strictEqual(model.isVisible(CLAUDE_AGENT_VIEW_ID), false);
		model.setVisible(CLAUDE_AGENT_VIEW_ID, true);
		assert.strictEqual(model.isVisible(CLAUDE_AGENT_VIEW_ID), true);

		first.moveViewContainerToLocation(container, ViewContainerLocation.Sidebar, undefined, 'test');
		assert.strictEqual(first.getViewContainerLocation(container), ViewContainerLocation.Sidebar);
		first.dispose();

		const restarted = service();
		assert.strictEqual(restarted.getViewContainerLocation(container), ViewContainerLocation.Sidebar);
		const restored = restarted.getViewContainerModel(container);
		assert.strictEqual(restored.isVisible(CLAUDE_AGENT_VIEW_ID), true);
		restarted.moveViewContainerToLocation(container, ViewContainerLocation.Panel, undefined, 'test');
		restarted.dispose();

		const movedAgain = service();
		assert.strictEqual(movedAgain.getViewContainerLocation(container), ViewContainerLocation.Panel);
		movedAgain.dispose();
	});

	function service(): ViewDescriptorService {
		return disposables.add(instantiationService.createInstance(ViewDescriptorService));
	}
});

class StubView { }
