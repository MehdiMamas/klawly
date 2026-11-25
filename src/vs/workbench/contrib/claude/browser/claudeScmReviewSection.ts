/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewDescriptorService, IViewsRegistry } from '../../../common/views.js';
import { VIEWLET_ID } from '../../scm/common/scm.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { CLAUDE_REVIEW_CHANGES_COMMAND_ID } from '../common/claudeViews.js';
import { CLAUDE_REVIEW_SHOW_READINESS_SETTING } from '../../../../platform/claude/common/claudeReviewLoop.js';
import { CLAUDE_REVIEW_BRANCH_COMMAND_ID } from './claudeGitActions.js';

/** The Review with Claude section of Source Control. */
export const CLAUDE_SCM_REVIEW_VIEW_ID = 'workbench.scm.claudeReview';

/**
 * Review with Claude (issue 749): its own section of Source Control, under Changes
 * and above Graph, so the review button no longer crowds the Changes header. The
 * user collapses, hides or moves it like Graph. Its body is the welcome content:
 * one line on what the review does and its button (DL-73).
 */
class ClaudeScmReviewViewPane extends ViewPane {

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	override shouldShowWelcome(): boolean {
		return true;
	}
}

/**
 * Registers the section in the Source Control container, between Changes (order 1)
 * and Graph (order 2). The returned disposable removes it again.
 */
export function registerClaudeScmReviewSection(): IDisposable {
	const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).get(VIEWLET_ID);
	const views = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
	if (!container || views.getView(CLAUDE_SCM_REVIEW_VIEW_ID)) {
		return Disposable.None;
	}
	const section: IViewDescriptor = {
		id: CLAUDE_SCM_REVIEW_VIEW_ID,
		name: localize2('claudeScmReview', "Review with Claude"),
		ctorDescriptor: new SyncDescriptor(ClaudeScmReviewViewPane),
		canToggleVisibility: true,
		canMoveView: true,
		weight: 10,
		order: 1.5,
		containerIcon: Codicon.sparkle,
		when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, ContextKeyExpr.has('scm.providerCount'), ContextKeyExpr.notEquals('scm.providerCount', 0)),
	};
	views.registerViews([section], container);
	const welcome = views.registerViewWelcomeContent(CLAUDE_SCM_REVIEW_VIEW_ID, {
		content: [
			localize('claudeScmReviewWelcome', "Claude reads every uncommitted change and points out bugs and risks in the Agent pane."),
			localize('claudeScmReviewDepth', "Review Depth picks Quick or Deep for each review and says why; big diffs and auth, payments, migrations or CI changes get Deep."),
			`[${localize('claudeScmReviewButton', "Review Changes with Claude")}](command:${CLAUDE_REVIEW_CHANGES_COMMAND_ID})`,
			`[${localize('claudeScmReviewBranchButton', "Review Branch Against Base")}](command:${CLAUDE_REVIEW_BRANCH_COMMAND_ID})`,
		].join('\n'),
	});
	const readinessHint = views.registerViewWelcomeContent(CLAUDE_SCM_REVIEW_VIEW_ID, {
		content: localize('claudeScmReviewReadiness', "Each review ends with a merge-readiness score from 0 to 5 and a one-line reason. It is advice only and never approves a change."),
		when: ContextKeyExpr.notEquals(`config.${CLAUDE_REVIEW_SHOW_READINESS_SETTING}`, false),
		order: 6,
	});
	return toDisposable(() => {
		readinessHint.dispose();
		welcome.dispose();
		views.deregisterViews([section], container);
	});
}
