/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { CLAUDE_AGENT_ENABLED } from '../../common/claudeContextKeys.js';
import { KLAWLY_CATEGORY } from '../../common/claudeViews.js';
import { CLAUDE_VOICE_AUTO_SEND_SETTING, CLAUDE_VOICE_DELETE_MODEL_COMMAND_ID, CLAUDE_VOICE_ENABLED_SETTING, CLAUDE_VOICE_TOGGLE_COMMAND_ID, IClaudeVoiceInputService } from '../../common/claudeVoiceInput.js';
import { AGENT_VIEW_FOCUSED, CLAUDE_DEFAULT_KEY_WEIGHT } from '../claudeCommands.js';
import { revealClaudeChat } from './claudeAgentEditorActions.js';
import './claudeVoiceInputService.js';

/** Voice input for the composer (issue 429): its settings and commands. */
export function registerClaudeVoice(): void {
	Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
		id: 'claude',
		order: 102,
		title: localize('claudeConfigurationTitle', "AI / Claude"),
		type: 'object',
		properties: {
			[CLAUDE_VOICE_ENABLED_SETTING]: {
				type: 'boolean',
				scope: ConfigurationScope.APPLICATION,
				default: true,
				description: localize('claudeVoiceEnabled', "Shows the microphone in the agent composer. Speech is transcribed on this machine; the audio never leaves it."),
			},
			[CLAUDE_VOICE_AUTO_SEND_SETTING]: {
				type: 'boolean',
				scope: ConfigurationScope.APPLICATION,
				default: false,
				description: localize('claudeVoiceAutoSend', "Sends the prompt as soon as dictation finishes. When off, the dictated text waits in the composer for you to edit and send."),
			},
		},
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_VOICE_TOGGLE_COMMAND_ID,
				title: { ...localize2('claudeVoiceToggle', "Toggle Voice Input"), original: 'Toggle Voice Input (Voice, Dictation, Speak, Microphone)' },
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				// The editor's own dictation keeps this key in code editors.
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyV,
					when: AGENT_VIEW_FOCUSED,
					weight: CLAUDE_DEFAULT_KEY_WEIGHT,
				},
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const pane = await revealClaudeChat(accessor.get(IViewsService), accessor.get(IEditorService), accessor.get(IInstantiationService), true);
			pane?.toggleVoice();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_VOICE_DELETE_MODEL_COMMAND_ID,
				title: localize2('claudeVoiceDeleteModel', "Delete Voice Model"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const voice = accessor.get(IClaudeVoiceInputService);
			const dialogs = accessor.get(IDialogService);
			const notifications = accessor.get(INotificationService);
			const log = accessor.get(ILogService);
			const answer = await dialogs.confirm({
				type: 'warning',
				message: localize('claudeVoiceDeleteConfirm', "Delete the downloaded voice model?"),
				detail: localize('claudeVoiceDeleteConfirmDetail', "The next dictation downloads it again before it can transcribe."),
				primaryButton: localize('claudeVoiceDelete', "Delete"),
			});
			if (!answer.confirmed) {
				return;
			}
			try {
				await voice.deleteModel();
				notifications.info(localize('claudeVoiceDeleted', "Deleted the voice model."));
			} catch (error) {
				log.warn('[claude-voice] could not delete the model', error);
				notifications.error(localize('claudeVoiceDeleteFailed', "Klawly could not delete the voice model. Close other windows that are dictating and try again."));
			}
		}
	});
}
