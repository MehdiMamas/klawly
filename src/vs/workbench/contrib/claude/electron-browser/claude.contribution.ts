/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { CLAUDE_RUNTIME_CHANNEL, IClaudeRuntimeService } from '../../../../platform/claude/common/claudeRuntime.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSharedProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewDescriptor, IViewsRegistry, IViewContainersRegistry, ViewContainerLocation, Extensions as ViewExtensions } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { CLAUDE_AGENT_TITLE, CLAUDE_AGENT_VIEW_CONTAINER_ID, CLAUDE_AGENT_VIEW_ID, ClaudeAgentViewPane } from '../browser/claudeAgentView.js';

// The runtime lives in the shared process; the workbench only holds a proxy that speaks the normalized protocol.
registerSharedProcessRemoteService(IClaudeRuntimeService, CLAUDE_RUNTIME_CHANNEL);

// --- The Agent view, the default container of the auxiliary bar (D01, v5-S12)

const agentIcon = registerIcon('claude-agent-view-icon', Codicon.sparkle, localize('claude.agent.icon', "View icon of the Agent view."));

const agentContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: CLAUDE_AGENT_VIEW_CONTAINER_ID,
	title: CLAUDE_AGENT_TITLE,
	icon: agentIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CLAUDE_AGENT_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: CLAUDE_AGENT_VIEW_CONTAINER_ID,
	hideIfEmpty: true,
	order: 0,
}, ViewContainerLocation.AuxiliaryBar, { isDefault: true, doNotRegisterOpenCommand: true });

const agentView: IViewDescriptor = {
	id: CLAUDE_AGENT_VIEW_ID,
	containerIcon: agentIcon,
	containerTitle: CLAUDE_AGENT_TITLE.value,
	singleViewPaneContainerTitle: CLAUDE_AGENT_TITLE.value,
	name: CLAUDE_AGENT_TITLE,
	canToggleVisibility: false,
	canMoveView: false,
	ctorDescriptor: new SyncDescriptor(ClaudeAgentViewPane),
	order: 0,
};
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([agentView], agentContainer);

// --- Commands: one id per action, named after the v5 frames (S12 "Commands on this screen")

async function getAgentView(accessor: ServicesAccessor): Promise<ClaudeAgentViewPane | undefined> {
	return (await accessor.get(IViewsService).openView<ClaudeAgentViewPane>(CLAUDE_AGENT_VIEW_ID, true)) ?? undefined;
}

registerAction2(class FocusAgent extends Action2 {
	constructor() {
		super({
			id: 'claude.agent.focus',
			title: localize2('claude.agent.focus', "Focus Agent"),
			f1: true,
			keybinding: { weight: KeybindingWeight.WorkbenchContrib, primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyA },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await getAgentView(accessor);
	}
});

registerAction2(class NewAgent extends Action2 {
	constructor() {
		super({
			id: 'claude.agent.new',
			title: localize2('claude.agent.new', "New Agent"),
			icon: Codicon.add,
			f1: true,
			menu: { id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', CLAUDE_AGENT_VIEW_ID), group: 'navigation' },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		(await getAgentView(accessor))?.newAgent();
	}
});

registerAction2(class SendToAgent extends Action2 {
	constructor() {
		super({ id: 'claude.agent.send', title: localize2('claude.agent.send', "Send to Agent") });
	}
	async run(accessor: ServicesAccessor, prompt?: string): Promise<void> {
		(await getAgentView(accessor))?.send(prompt);
	}
});

registerAction2(class StopAgent extends Action2 {
	constructor() {
		super({
			id: 'claude.agent.stop',
			title: localize2('claude.agent.stop', "Stop Agent"),
			f1: true,
			keybinding: { weight: KeybindingWeight.WorkbenchContrib, primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyX },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		(await getAgentView(accessor))?.stop();
	}
});
