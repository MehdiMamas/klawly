/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { CLAUDE_AGENTS_WINDOW_ENABLED_SETTING } from '../../../../../platform/claude/common/claudeAgentHost.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { ActiveEditorContext } from '../../../../common/contextkeys.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { AUX_WINDOW_GROUP, IEditorService } from '../../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { OPEN_WORKSPACE_IN_AGENTS_WINDOW_COMMAND_ID } from '../../../chat/common/constants.js';
import { CLAUDE_SESSION_LIST_LOCATION_SETTING, CLAUDE_TOGGLE_AGENTS_SIDEBAR_COMMAND_ID } from '../../common/claudeAgentsList.js';
import { CLAUDE_AGENT_ENABLED } from '../../common/claudeContextKeys.js';
import { CLAUDE_AGENT_VIEW_ID, CLAUDE_MOVE_CHAT_TO_SIDE_BAR_COMMAND_ID, CLAUDE_NEW_SESSION_COMMAND_ID, CLAUDE_OPEN_AGENTS_WINDOW_COMMAND_ID, CLAUDE_OPEN_CHAT_IN_EDITOR_COMMAND_ID, CLAUDE_OPEN_CHAT_IN_WINDOW_COMMAND_ID, KLAWLY_CATEGORY } from '../../common/claudeViews.js';
import { CLAUDE_AGENT_EDITOR_HISTORY_COMMAND_ID, CLAUDE_AGENT_EDITOR_MORE_COMMAND_ID, ClaudeAgentEditor } from './claudeAgentEditor.js';
import { CLAUDE_AGENT_EDITOR_RESOURCE, ClaudeAgentEditorInput } from './claudeAgentEditorInput.js';
import { ClaudeChatOutlineCreator } from './claudeChatOutline.js';
import { ClaudeAgentViewPane } from './claudeViewPane.js';
import { ClaudeChatWidget } from './claudeChatWidget.js';

/** The chat tab has no state of its own, so it restores as the same tab after a reload. */
class ClaudeAgentEditorInputSerializer implements IEditorSerializer {
	canSerialize(editor: EditorInput): boolean {
		return editor instanceof ClaudeAgentEditorInput;
	}

	serialize(editor: EditorInput): string | undefined {
		return editor instanceof ClaudeAgentEditorInput ? '' : undefined;
	}

	deserialize(instantiationService: IInstantiationService): EditorInput | undefined {
		return instantiationService.createInstance(ClaudeAgentEditorInput);
	}
}

/**
 * Shows the chat where it lives, focused or not, and returns its widget: the
 * editor tab when it is open, otherwise the Agent view.
 * Services are read before any await: an accessor is only valid until the first one.
 */
export async function revealClaudeChat(views: IViewsService, editors: IEditorService, instantiation: IInstantiationService, focus: boolean): Promise<ClaudeChatWidget | undefined> {
	if (editors.findEditors(CLAUDE_AGENT_EDITOR_RESOURCE).length) {
		const pane = await editors.openEditor(instantiation.createInstance(ClaudeAgentEditorInput), { preserveFocus: !focus });
		return pane instanceof ClaudeAgentEditor ? pane.widget : undefined;
	}
	const view = await views.openView(CLAUDE_AGENT_VIEW_ID, focus);
	return view instanceof ClaudeAgentViewPane ? view.widget : undefined;
}

/** Opens the chat tab in `group`, and closes the Agent view when it shows only the moved chat. */
async function openChatEditor(accessor: ServicesAccessor, group: typeof AUX_WINDOW_GROUP | undefined): Promise<void> {
	const editors = accessor.get(IEditorService);
	const views = accessor.get(IViewsService);
	const input = accessor.get(IInstantiationService).createInstance(ClaudeAgentEditorInput);
	if (group !== undefined) {
		// A tab moves to its own window: close it where it is first.
		await editors.closeEditors(editors.findEditors(CLAUDE_AGENT_EDITOR_RESOURCE));
	}
	await editors.openEditor(input, { pinned: true }, group);
	if (views.isViewVisible(CLAUDE_AGENT_VIEW_ID)) {
		views.closeView(CLAUDE_AGENT_VIEW_ID);
	}
}

export function registerClaudeAgentEditor(): void {
	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(ClaudeAgentEditor, ClaudeAgentEditor.ID, localize('claudeAgentEditor', "Agent")),
		[new SyncDescriptor(ClaudeAgentEditorInput)],
	);
	Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(ClaudeAgentEditorInput.ID, ClaudeAgentEditorInputSerializer);
	// The Outline view, breadcrumbs and Go to Symbol for a chat in an editor (issue 433).
	registerWorkbenchContribution2(ClaudeChatOutlineCreator.ID, ClaudeChatOutlineCreator, WorkbenchPhase.AfterRestored);

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_OPEN_CHAT_IN_EDITOR_COMMAND_ID,
				title: localize2('claudeOpenChatInEditorCommand', "Open Chat in Editor"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		run(accessor: ServicesAccessor): Promise<void> {
			return openChatEditor(accessor, undefined);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_OPEN_CHAT_IN_WINDOW_COMMAND_ID,
				title: localize2('claudeOpenChatInWindowCommand', "Open Chat in New Window"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		run(accessor: ServicesAccessor): Promise<void> {
			return openChatEditor(accessor, AUX_WINDOW_GROUP);
		}
	});

	// One name, one window (DL-27): the title bar pill, File and Home all open the Agents window
	// through this command, so the setting decides which window that name means everywhere.
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_OPEN_AGENTS_WINDOW_COMMAND_ID,
				title: localize2('claudeOpenAgentsWindowCommand', "Open Agents Window"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const agentsWindow = accessor.get(IConfigurationService).getValue<boolean>(CLAUDE_AGENTS_WINDOW_ENABLED_SETTING) === true;
			await accessor.get(ICommandService).executeCommand(agentsWindow ? OPEN_WORKSPACE_IN_AGENTS_WINDOW_COMMAND_ID : CLAUDE_OPEN_CHAT_IN_WINDOW_COMMAND_ID);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_MOVE_CHAT_TO_SIDE_BAR_COMMAND_ID,
				title: localize2('claudeMoveChatToSideBarCommand', "Move Chat to Side Bar"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const editors = accessor.get(IEditorService);
			const views = accessor.get(IViewsService);
			await editors.closeEditors(editors.findEditors(CLAUDE_AGENT_EDITOR_RESOURCE));
			await views.openView(CLAUDE_AGENT_VIEW_ID, true);
		}
	});

	// The chat tab is the session's tab, so New, History, Agents Sidebar and More sit with the editor's
	// actions in the tab row instead of a second row of tabs inside the editor (issue 142).
	const inChatEditor = ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, ActiveEditorContext.isEqualTo(ClaudeAgentEditor.ID));
	MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
		command: { id: CLAUDE_NEW_SESSION_COMMAND_ID, title: localize('claudeAgentEditorNewAgent', "New Agent"), icon: Codicon.add, precondition: CLAUDE_AGENT_ENABLED },
		group: 'navigation',
		order: 1,
		when: inChatEditor,
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_AGENT_EDITOR_HISTORY_COMMAND_ID,
				title: localize2('claudeAgentEditorHistory', "Agent History"),
				icon: Codicon.history,
				f1: false,
				precondition: CLAUDE_AGENT_ENABLED,
				menu: { id: MenuId.EditorTitle, group: 'navigation', order: 2, when: inChatEditor },
			});
		}
		run(accessor: ServicesAccessor): void {
			const pane = accessor.get(IEditorService).activeEditorPane;
			if (pane instanceof ClaudeAgentEditor) {
				pane.widget?.toggleHistory();
			}
		}
	});

	// The agents sidebar is off by default; this button turns it on and off (issue 98).
	MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
		command: {
			id: CLAUDE_TOGGLE_AGENTS_SIDEBAR_COMMAND_ID,
			title: localize('claudeAgentEditorAgentsSidebar', "Toggle Agents Sidebar"),
			icon: Codicon.layoutSidebarRight,
			precondition: CLAUDE_AGENT_ENABLED,
			toggled: ContextKeyExpr.equals(`config.${CLAUDE_SESSION_LIST_LOCATION_SETTING}`, 'side'),
		},
		group: 'navigation',
		order: 3,
		when: inChatEditor,
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_AGENT_EDITOR_MORE_COMMAND_ID,
				title: localize2('claudeAgentEditorMore', "More Agent Actions"),
				icon: Codicon.ellipsis,
				f1: false,
				precondition: CLAUDE_AGENT_ENABLED,
				menu: { id: MenuId.EditorTitle, group: 'navigation', order: 4, when: inChatEditor },
			});
		}
		run(): void {
			// The chat editor draws this button as a dropdown of the chat's More menu (getActionViewItem).
		}
	});
}
