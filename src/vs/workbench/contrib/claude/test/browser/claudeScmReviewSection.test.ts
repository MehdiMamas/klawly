/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MenuId, MenuRegistry, isIMenuItem } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainerLocation } from '../../../../common/views.js';
import { HISTORY_VIEW_PANE_ID, VIEWLET_ID, VIEW_PANE_ID } from '../../../scm/common/scm.js';
import { CLAUDE_SCM_REVIEW_VIEW_ID, registerClaudeScmReviewSection } from '../../browser/claudeScmReviewSection.js';
import { CLAUDE_REVIEW_BRANCH_COMMAND_ID, registerClaudeGitActions } from '../../browser/claudeGitActions.js';
import { CLAUDE_REVIEW_CHANGES_COMMAND_ID } from '../../common/claudeViews.js';

suite('Claude Source Control review section', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Review with Claude is its own section under Changes and above Graph, and leaves the Changes header (issue 749)', () => {
		const containers = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
		const views = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		const ownContainer = !containers.get(VIEWLET_ID);
		const container = containers.get(VIEWLET_ID) ?? containers.registerViewContainer({ id: VIEWLET_ID, title: { value: 'Source Control', original: 'Source Control' }, ctorDescriptor: new SyncDescriptor(ViewPaneContainer) }, ViewContainerLocation.Sidebar);
		const upstream: IViewDescriptor[] = [{ id: VIEW_PANE_ID, order: 1 }, { id: HISTORY_VIEW_PANE_ID, order: 2 }]
			.filter(view => !views.getView(view.id))
			.map(view => ({ ...view, name: { value: view.id, original: view.id }, ctorDescriptor: new SyncDescriptor(ViewPaneContainer) }));
		views.registerViews(upstream, container);
		const section = registerClaudeScmReviewSection();
		if (!CommandsRegistry.getCommand(CLAUDE_REVIEW_CHANGES_COMMAND_ID)) {
			registerClaudeGitActions();
		}
		try {
			const order = views.getViews(container)
				.filter(view => view.id === VIEW_PANE_ID || view.id === HISTORY_VIEW_PANE_ID || view.id === CLAUDE_SCM_REVIEW_VIEW_ID)
				.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
				.map(view => view.id);
			const descriptor = views.getView(CLAUDE_SCM_REVIEW_VIEW_ID);
			assert.deepStrictEqual({
				order,
				name: descriptor?.name.value,
				closable: descriptor?.canToggleVisibility,
				welcome: views.getViewWelcomeContent(CLAUDE_SCM_REVIEW_VIEW_ID).map(item => item.content),
				inHeader: MenuRegistry.getMenuItems(MenuId.SCMTitle).some(item => isIMenuItem(item) && item.command.id === CLAUDE_REVIEW_CHANGES_COMMAND_ID),
			}, {
				order: [VIEW_PANE_ID, CLAUDE_SCM_REVIEW_VIEW_ID, HISTORY_VIEW_PANE_ID],
				name: 'Review with Claude',
				closable: true,
				welcome: [`Claude reads every uncommitted change and points out bugs and risks in the Agent pane.\nReview Depth picks Quick or Deep for each review and says why; big diffs and auth, payments, migrations or CI changes get Deep.\n[Review Changes with Claude](command:${CLAUDE_REVIEW_CHANGES_COMMAND_ID})
[Review Branch Against Base](command:${CLAUDE_REVIEW_BRANCH_COMMAND_ID})`, 'Each review ends with a merge-readiness score from 0 to 5 and a one-line reason. It is advice only and never approves a change.'],
				inHeader: false,
			});
		} finally {
			section.dispose();
			views.deregisterViews(upstream, container);
			if (ownContainer) {
				containers.deregisterViewContainer(container);
			}
		}
	});
});
