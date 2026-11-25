/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { CLAUDE_MODELS_CUSTOM_SETTING, CLAUDE_MODELS_ENABLED_SETTING } from '../../../../platform/claude/common/claudeConfiguration.js';
import { pickableClaudeModels, readClaudeModelIdList } from '../../../../platform/claude/common/claudeModels.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { IClaudeModelSwitchService } from './claudeModelSwitch.js';
import { redactSecrets } from '../../../services/claude/common/claudeAgentLog.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { CLAUDE_AGENT_VIEW_ID, CLAUDE_NEW_SESSION_COMMAND_ID, CLAUDE_PICK_MODE_COMMAND_ID, CLAUDE_PICK_MODEL_COMMAND_ID, KLAWLY_CATEGORY } from '../common/claudeViews.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { revealClaudeChat } from './chat/claudeAgentEditorActions.js';
import { CLAUDE_AGENT_EDITOR_RESOURCE } from './chat/claudeAgentEditorInput.js';
import { claudeModes } from './chat/claudeModes.js';

export function registerClaudePaneActions(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_NEW_SESSION_COMMAND_ID,
				// One name per job (DL-30, issue 766): the button's "New Agent"; the older names are aliases.
				title: { ...localize2('claudeNewAgentSession', "New Agent"), original: 'New Agent (New Chat, New Agent Session, New Conversation)' },
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const views = accessor.get(IViewsService);
			const editors = accessor.get(IEditorService);
			const groups = accessor.get(IEditorGroupsService);
			const instantiation = accessor.get(IInstantiationService);
			const chatEditors = editors.findEditors(CLAUDE_AGENT_EDITOR_RESOURCE);
			accessor.get(IClaudeAgentService).createSession();
			// The Agents Window is the chat's own window: the new chat opens there.
			if (chatEditors.some(editor => groups.getPart(editor.groupId) !== groups.mainPart)) {
				await revealClaudeChat(views, editors, instantiation, true);
				return;
			}
			// The chat editor tab follows the current session, so a new chat in it would take the open chat's tab
			// and leave the side bar on its placeholder. The new chat opens in the side bar instead, with the open
			// chat as its second tab, and the editor goes back to the code (issue 333).
			await editors.closeEditors(chatEditors);
			await views.openView(CLAUDE_AGENT_VIEW_ID, true);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_PICK_MODEL_COMMAND_ID,
				title: { ...localize2('claudePickModel', "Pick Model"), original: 'Pick Model (Model, Switch Model, Change Model, Opus, Sonnet, Haiku)' },
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const agent = accessor.get(IClaudeAgentService);
			const modelSwitches = accessor.get(IClaudeModelSwitchService);
			const quickInput = accessor.get(IQuickInputService);
			const runtime = accessor.get(IClaudeRuntimeService);
			const notification = accessor.get(INotificationService);
			const configuration = accessor.get(IConfigurationService);
			const session = agent.getCurrentSession() ?? agent.createSession();
			try {
				// Only enabled models and custom ids (spec 34b). A disabled model set elsewhere still works.
				const models = pickableClaudeModels(
					await runtime.listModels(),
					readClaudeModelIdList(configuration.getValue(CLAUDE_MODELS_ENABLED_SETTING)),
					readClaudeModelIdList(configuration.getValue(CLAUDE_MODELS_CUSTOM_SETTING)),
				);
				if (models.length === 0) {
					await quickInput.pick([], {
						placeHolder: localize('claudeNoModels', "Claude has not reported any models."),
					});
					return;
				}
				const items = models.map(model => ({
					id: model.id,
					label: model.id === session.modelId ? `$(check) ${model.displayName}` : model.displayName,
					description: model.source === 'custom' ? localize('claudeCustomModel', "Custom model ID") : model.description,
				}));
				const picked = await quickInput.pick(items, {
					placeHolder: localize('claudePickModelPlaceholder', "Select a model for the next turn"),
					matchOnDescription: true,
					activeItem: items.find(item => item.id === session.modelId),
				});
				if (picked?.id) {
					await modelSwitches.switchModel(session.id, picked.id);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notification.error(redactSecrets(message));
			}
		}
	});

	// DL-30 (issue 723): the composer's mode pill had no Command Palette twin, so "plan mode" found nothing there.
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_PICK_MODE_COMMAND_ID,
				title: { ...localize2('claudePickMode', "Pick Mode"), original: 'Pick Mode (Agent Mode, Plan Mode, Ask Mode, Debug Mode)' },
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const agent = accessor.get(IClaudeAgentService);
			const quickInput = accessor.get(IQuickInputService);
			const notification = accessor.get(INotificationService);
			const session = agent.getCurrentSession() ?? agent.createSession();
			const items = claudeModes().map(({ mode, label, description, icon }) => ({
				mode,
				label: `$(${icon.id}) ${label}`,
				description,
			}));
			const picked = await quickInput.pick(items, {
				placeHolder: localize('claudePickModePlaceholder', "Select a mode for the next turn"),
				matchOnDescription: true,
				activeItem: items.find(item => item.mode === session.mode),
			});
			if (picked) {
				try {
					agent.setMode(session.id, picked.mode);
				} catch (error) {
					notification.error(error instanceof Error ? error.message : String(error));
				}
			}
		}
	});
}
