/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IView, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainer, ViewContainerLocation } from '../../../common/views.js';
import { CLAUDE_AGENT_VIEW_ID, CLAUDE_VIEW_CONTAINER_ID } from '../common/claudeViews.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';

export function registerClaudeViewDescriptors(
	agentDescriptor: SyncDescriptor<IView>,
): ViewContainer {
	const viewContainers = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
	const existing = viewContainers.get(CLAUDE_VIEW_CONTAINER_ID);
	if (existing) {
		return existing;
	}

	const container = viewContainers.registerViewContainer({
		id: CLAUDE_VIEW_CONTAINER_ID,
		title: localize2('claude', "Agent"),
		icon: Codicon.sparkle,
		order: 100,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CLAUDE_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		storageId: CLAUDE_VIEW_CONTAINER_ID,
		// With `claude.agent.enabled` off every view is hidden, and so is the container.
		hideIfEmpty: true,
	// The default for the agent pane, so a new window opens it rather than upstream's empty Chat container.
	}, ViewContainerLocation.AuxiliaryBar, { isDefault: true });

	const views: IViewDescriptor[] = [
		{
			id: CLAUDE_AGENT_VIEW_ID,
			name: localize2('claudeAgent', "Agent"),
			ctorDescriptor: agentDescriptor,
			canToggleVisibility: true,
			canMoveView: true,
			order: 0,
			weight: 80,
			containerIcon: Codicon.sparkle,
			when: CLAUDE_AGENT_ENABLED,
		},
	];
	Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews(views, container);
	return container;
}
