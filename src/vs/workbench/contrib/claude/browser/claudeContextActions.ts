/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClaudeActionService } from '../../../../platform/claude/common/claudeActions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { CLAUDE_ADD_SELECTION_COMMAND_ID, CLAUDE_ADD_SELECTION_TO_NEW_AGENT_COMMAND_ID, CLAUDE_ADD_TERMINAL_COMMAND_ID, CLAUDE_AGENT_VIEW_ID, CLAUDE_EXPLAIN_SELECTION_COMMAND_ID, KLAWLY_CATEGORY } from '../common/claudeViews.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { CLAUDE_EDITOR_CONTEXT_GROUP } from './claudeMenus.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { TerminalContextMenuGroup } from '../../terminal/browser/terminalMenus.js';
import { TerminalContextKeys } from '../../terminal/common/terminalContextKey.js';
import { claudeTerminalAttachment } from '../common/claudeTerminalAttachment.js';

export function registerClaudeContextActions(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_ADD_SELECTION_COMMAND_ID,
				title: localize2('claudeAddSelection', "Add Selection to Agent"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				menu: [{
					id: MenuId.EditorContext,
					group: CLAUDE_EDITOR_CONTEXT_GROUP,
					order: 1,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, EditorContextKeys.editorTextFocus, EditorContextKeys.hasNonEmptySelection),
				}],
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const views = accessor.get(IViewsService);
			const actions = accessor.get(IClaudeActionService);
			await views.openView(CLAUDE_AGENT_VIEW_ID, true);
			await actions.run({
				id: 'addSelection',
				source: 'menu',
				attachments: [],
			});
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_ADD_SELECTION_TO_NEW_AGENT_COMMAND_ID,
				title: localize2('claudeAddSelectionToNewAgent', "Add Selection to New Agent"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				menu: [{
					id: MenuId.EditorContext,
					group: CLAUDE_EDITOR_CONTEXT_GROUP,
					order: 2,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, EditorContextKeys.editorTextFocus, EditorContextKeys.hasNonEmptySelection),
				}],
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const views = accessor.get(IViewsService);
			const actions = accessor.get(IClaudeActionService);
			accessor.get(IClaudeAgentService).createSession();
			await views.openView(CLAUDE_AGENT_VIEW_ID, true);
			await actions.run({
				id: 'addSelection',
				source: 'menu',
				attachments: [],
			});
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_EXPLAIN_SELECTION_COMMAND_ID,
				title: localize2('claudeExplainSelection', "Explain Selection"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				menu: [{
					id: MenuId.EditorContext,
					group: CLAUDE_EDITOR_CONTEXT_GROUP,
					order: 3,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, EditorContextKeys.editorTextFocus, EditorContextKeys.hasNonEmptySelection),
				}],
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const views = accessor.get(IViewsService);
			const actions = accessor.get(IClaudeActionService);
			await views.openView(CLAUDE_AGENT_VIEW_ID, true);
			await actions.run({
				id: 'explainSelection',
				source: 'menu',
				attachments: [],
			});
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_ADD_TERMINAL_COMMAND_ID,
				title: localize2('claudeAddTerminal', "Add Terminal Selection or Last Command to Agent"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, TerminalContextKeys.isOpen),
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const terminals = accessor.get(ITerminalService);
			const views = accessor.get(IViewsService);
			const agent = accessor.get(IClaudeAgentService);
			const instance = terminals.activeInstance;
			if (!instance) {
				accessor.get(INotificationService).info(localize('claudeAddTerminalNone', "Open a terminal first."));
				return;
			}
			const attachment = claudeTerminalAttachment({
				terminalId: instance.instanceId,
				terminalTitle: instance.title,
				selection: instance.hasSelection() ? instance.selection : undefined,
				lastCommand: lastCommand(instance),
			});
			const session = agent.getCurrentSession() ?? agent.createSession();
			agent.setAttachments(session.id, [...session.attachments, attachment]);
			await views.openView(CLAUDE_AGENT_VIEW_ID, true);
		}
	});

	// The terminal's right-click menu names what it adds: the selection, or the last command (issue 734).
	MenuRegistry.appendMenuItem(MenuId.TerminalInstanceContext, {
		command: { id: CLAUDE_ADD_TERMINAL_COMMAND_ID, title: localize('claudeAddTerminalSelection', "Add Selection to Agent") },
		group: TerminalContextMenuGroup.Chat,
		order: 1,
		when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, TerminalContextKeys.textSelected),
	});
	MenuRegistry.appendMenuItem(MenuId.TerminalInstanceContext, {
		command: { id: CLAUDE_ADD_TERMINAL_COMMAND_ID, title: localize('claudeAddTerminalLastCommand', "Add Last Command to Agent") },
		group: TerminalContextMenuGroup.Chat,
		order: 1,
		when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, TerminalContextKeys.notTextSelected),
	});
}

/** The last finished command and its output, when shell integration knows the boundaries. */
function lastCommand(instance: ITerminalInstance): { command: string; output: string } | undefined {
	const commands = instance.capabilities.get(TerminalCapability.CommandDetection)?.commands ?? [];
	for (let i = commands.length - 1; i >= 0; i--) {
		const command = commands[i];
		if (command.hasOutput()) {
			return { command: command.command, output: command.getOutput() ?? '' };
		}
	}
	return undefined;
}
