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
import { $, append, EventType, addDisposableListener } from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAction } from '../../../../base/common/actions.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IClaudeAgentsService } from '../../../services/claude/browser/claudeAgentsService.js';
import { CLAUDE_BACKGROUND_TITLE, CLAUDE_BACKGROUND_VIEW_CONTAINER_ID, CLAUDE_BACKGROUND_VIEW_ID, CLAUDE_WORKTREE_CLEANUP_SETTING, ClaudeBackgroundViewPane } from '../browser/claudeBackgroundView.js';
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

registerAction2(class DetectClaude extends Action2 {
	constructor() {
		super({ id: 'claude.agent.detect', title: localize2('claude.agent.detect', "Re-detect Claude Runtime"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await (await getAgentView(accessor))?.detect();
	}
});

registerAction2(class InstallClaude extends Action2 {
	constructor() {
		super({ id: 'claude.agent.install', title: localize2('claude.agent.install', "Install Claude Code"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await (await getAgentView(accessor))?.install();
	}
});

// --- The Background panel view (v5-S27)

const backgroundIcon = registerIcon('claude-background-view-icon', Codicon.layers, localize('claude.background.icon', "View icon of the Background view."));

const backgroundContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: CLAUDE_BACKGROUND_VIEW_CONTAINER_ID,
	title: CLAUDE_BACKGROUND_TITLE,
	icon: backgroundIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CLAUDE_BACKGROUND_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: CLAUDE_BACKGROUND_VIEW_CONTAINER_ID,
	hideIfEmpty: true,
	order: 20,
}, ViewContainerLocation.Panel, { doNotRegisterOpenCommand: true });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: CLAUDE_BACKGROUND_VIEW_ID,
	containerIcon: backgroundIcon,
	containerTitle: CLAUDE_BACKGROUND_TITLE.value,
	singleViewPaneContainerTitle: CLAUDE_BACKGROUND_TITLE.value,
	name: CLAUDE_BACKGROUND_TITLE,
	canToggleVisibility: false,
	canMoveView: false,
	ctorDescriptor: new SyncDescriptor(ClaudeBackgroundViewPane),
	order: 0,
}], backgroundContainer);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'claude.agents',
	order: 100,
	title: localize('claude.agents.config', "Claude Agents"),
	type: 'object',
	properties: {
		[CLAUDE_WORKTREE_CLEANUP_SETTING]: {
			type: 'number',
			default: 7,
			minimum: 0,
			markdownDescription: localize('claude.agents.worktreeCleanupDays', "Days after which a finished, clean worktree under `.claude/worktrees/` that no agent uses is removed at startup and once a day. `0` turns the cleanup off. A worktree with uncommitted changes is never removed."),
		},
	},
});

// --- Agents layout (v5-S25): the title bar switch, the list, Needs you, Run Parallel Agents, Background

registerAction2(class ToggleLayout extends Action2 {
	constructor() {
		super({
			id: 'claude.layout.toggle',
			title: localize2('claude.layout.toggle', "Toggle Editor and Agents Layout"),
			f1: true,
			menu: { id: MenuId.TitleBar, group: 'navigation', order: -10 },
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(IClaudeAgentsService).toggleLayout();
	}
});

registerAction2(class ToggleAgentsList extends Action2 {
	constructor() {
		super({ id: 'claude.agents.toggleList', title: localize2('claude.agents.toggleList', "Toggle Agents Sidebar"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const agents = accessor.get(IClaudeAgentsService);
		await getAgentView(accessor);
		agents.toggleList();
	}
});

registerAction2(class OpenInPane extends Action2 {
	constructor() {
		super({ id: 'claude.agents.openInPane', title: localize2('claude.agents.openInPane', "Open in Agent Pane"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IClaudeAgentsService).setLayout('editor');
		await getAgentView(accessor);
	}
});

registerAction2(class OpenBackground extends Action2 {
	constructor() {
		super({ id: 'claude.agents.background', title: localize2('claude.agents.background', "Open Background Agents"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(CLAUDE_BACKGROUND_VIEW_ID, true);
	}
});

registerAction2(class RunParallelAgents extends Action2 {
	constructor() {
		super({ id: 'claude.agents.multitask', title: localize2('claude.agents.multitask', "Run Parallel Agents (Multitask)"), f1: true });
	}
	async run(accessor: ServicesAccessor, prompt?: string, attempts?: number): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		const agents = accessor.get(IClaudeAgentsService);
		const cwd = accessor.get(IWorkspaceContextService).getWorkspace().folders[0]?.uri.fsPath;
		const runtime = accessor.get(IClaudeRuntimeService);
		const trust = accessor.get(IWorkspaceTrustManagementService);
		const views = accessor.get(IViewsService);
		if (!cwd || (await runtime.checkGit(cwd)).state !== 'ok') {
			notifications.warn(localize('claude.multitask.noRepo', "Run Parallel Agents needs an open folder that is a git repository: each attempt works in its own worktree."));
			return;
		}
		const text = prompt ?? await quickInput.input({ prompt: localize('claude.multitask.prompt', "What should the agents try?"), placeHolder: localize('claude.multitask.placeholder', "For example: Fix the flaky e2e test") });
		if (!text?.trim()) {
			return;
		}
		const count = attempts ?? Number(await quickInput.input({
			prompt: localize('claude.multitask.count', "Number of attempts"),
			value: '3',
			validateInput: async value => /^[1-8]$/.test(value) ? undefined : localize('claude.multitask.count.invalid', "Enter a number from 1 to 8"),
		}));
		if (!count) {
			return;
		}
		const trusted = trust.isWorkspaceTrusted();
		await views.openView(CLAUDE_AGENT_VIEW_ID, true);
		await agents.startMultitask(text, count, { cwd, permissionMode: trusted ? 'default' : 'plan' });
	}
});

/** The two-segment "Editor | Agents" switch with "<folder> · N agents" before it, in the title bar. */
class LayoutSwitchItem extends BaseActionViewItem {

	constructor(action: IAction, options: IBaseActionViewItemOptions, @IClaudeAgentsService private readonly agents: IClaudeAgentsService) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('claude-layout-switch');
		const label = append(container, $('span.claude-layout-label'));
		const group = append(container, $('.claude-layout-segments'));
		group.setAttribute('role', 'group');
		group.setAttribute('aria-label', localize('claude.layout.label', "Layout"));
		const segment = (text: string, layout: 'editor' | 'agents') => {
			const button = append(group, $('button.claude-layout-segment')) as HTMLButtonElement;
			button.textContent = text;
			this._register(addDisposableListener(button, EventType.CLICK, () => this.agents.setLayout(layout)));
			return button;
		};
		const editor = segment(localize('claude.layout.editor', "Editor"), 'editor');
		const agents = segment(localize('claude.layout.agents', "Agents"), 'agents');
		const update = () => {
			const count = this.agents.count;
			label.textContent = localize('claude.layout.count', "{0} · {1} agents", this.agents.folderName, count);
			editor.setAttribute('aria-pressed', String(this.agents.layout === 'editor'));
			agents.setAttribute('aria-pressed', String(this.agents.layout === 'agents'));
		};
		update();
		this._register(this.agents.onDidChange(update));
		this._register(this.agents.onDidChangeLayout(update));
	}
}

class ClaudeAgentsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'claude.agents';

	private readonly timer = this._register(new IntervalTimer());

	constructor(
		@IActionViewItemService actionViewItems: IActionViewItemService,
		@IClaudeAgentsService agents: IClaudeAgentsService,
		@IClaudeRuntimeService private readonly runtime: IClaudeRuntimeService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		// creating the service here also puts a saved Agents layout back at startup
		void agents;
		this._register(actionViewItems.register(MenuId.TitleBar, 'claude.layout.toggle', (action, options, instantiation) => instantiation.createInstance(LayoutSwitchItem, action, options)));
		this.cleanup();
		this.timer.cancelAndSet(() => this.cleanup(), 24 * 60 * 60 * 1000);
	}

	/** Removes finished, clean worktrees older than the setting; never with --force (the runtime keeps dirty and running ones). */
	private async cleanup(): Promise<void> {
		const cwd = this.workspace.getWorkspace().folders[0]?.uri.fsPath;
		const days = this.configuration.getValue<number>(CLAUDE_WORKTREE_CLEANUP_SETTING) ?? 7;
		if (cwd && days > 0) {
			try {
				await this.runtime.cleanupWorktrees(cwd, days);
			} catch {
				// not a git repository, or git is missing: nothing to clean
			}
		}
	}
}

registerWorkbenchContribution2(ClaudeAgentsContribution.ID, ClaudeAgentsContribution, WorkbenchPhase.Eventually);
