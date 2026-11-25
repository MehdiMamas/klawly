/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions as ViewExtensions, IView, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry } from '../../../../common/views.js';
import { IClaudeBackgroundAgentService } from '../../../../services/claude/common/claudeBackgroundAgent.js';
import { ViewDescriptorService } from '../../../../services/views/browser/viewDescriptorService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { registerClaudeViewDescriptors } from '../../../claude/browser/claudeViewRegistration.js';
import { CLAUDE_AGENT_VIEW_ID, CLAUDE_VIEW_CONTAINER_ID } from '../../../claude/common/claudeViews.js';
import { claudeBackgroundViewDescriptor } from '../../browser/claudeBackground.contribution.js';
import { ClaudeBackgroundViewPane } from '../../browser/claudeBackgroundViewPane.js';
import { CLAUDE_BACKGROUND_VIEW_ID } from '../../common/claudeBackground.js';

suite('Claude background agents view', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiationService: TestInstantiationService;

	setup(() => {
		instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IContextKeyService, store.add(instantiationService.createInstance(ContextKeyService)));
		instantiationService.stub(IClaudeBackgroundAgentService, {
			onDidChangeTasks: Event.None,
			getTasks: () => [],
			maxParallelSessions: () => 4,
		} as unknown as IClaudeBackgroundAgentService);
	});

	test('audit 4: Background Agents starts hidden, so Agent is the only visible view, and its start button is a ghost', () => {
		const container = registerClaudeViewDescriptors(new SyncDescriptor(StubView as new () => IView));
		const views = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		const descriptor = claudeBackgroundViewDescriptor();
		views.registerViews([descriptor], container);
		try {
			const service = store.add(instantiationService.createInstance(ViewDescriptorService));
			instantiationService.stub(IViewDescriptorService, service);
			const model = service.getViewContainerModel(container);
			const pane = store.add(instantiationService.createInstance(ClaudeBackgroundViewPane, { id: CLAUDE_BACKGROUND_VIEW_ID, title: 'Background Agents' }));
			pane.render();
			const start = pane.element.querySelector('.claude-background-bar button');
			assert.deepStrictEqual({
				visible: model.visibleViewDescriptors.map(view => view.id),
				registered: [descriptor.hideByDefault, model.allViewDescriptors.some(view => view.id === CLAUDE_BACKGROUND_VIEW_ID)],
				root: pane.element.querySelector('.claude-background')?.classList.contains('claude-root'),
				ghost: [start?.classList.contains('is-ghost'), start?.classList.contains('is-primary'), start?.textContent],
			}, {
				visible: [CLAUDE_AGENT_VIEW_ID],
				registered: [true, true],
				root: true,
				ghost: [true, false, 'New background agent'],
			});
		} finally {
			const containers = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
			const registered = containers.get(CLAUDE_VIEW_CONTAINER_ID);
			if (registered) {
				views.deregisterViews(views.getViews(registered), registered);
				containers.deregisterViewContainer(registered);
			}
		}
	});
});

class StubView { }
