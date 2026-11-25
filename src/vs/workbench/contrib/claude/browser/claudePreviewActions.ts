/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILocalizedString, localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { CLAUDE_AGENT_ENABLED_SETTING, CLAUDE_PREVIEW_ENABLED_SETTING, readClaudeAgentEnabled } from '../../../../platform/claude/common/claudeConfiguration.js';
import { CLAUDE_AGENT_ENABLED, CLAUDE_PREVIEW_ENABLED } from '../common/claudeContextKeys.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { parsePreviewUrl, previewRejectedMessage } from '../common/claudePreview.js';
import { ClaudePreviewEditor, ClaudePreviewInput } from './claudePreviewEditor.js';
import { KLAWLY_CATEGORY } from '../common/claudeViews.js';

const previewActive = ContextKeyExpr.and(ActiveEditorContext.isEqualTo(ClaudePreviewEditor.ID), CLAUDE_PREVIEW_ENABLED);
/** Preview actions that hand something to the agent also need `claude.agent.enabled`. */
const previewAgentActive = ContextKeyExpr.and(previewActive, CLAUDE_AGENT_ENABLED);

/** `claude.preview.enabled`: commands run from code skip the precondition, so they check too. */
function previewEnabled(accessor: ServicesAccessor): boolean {
	return accessor.get(IConfigurationService).getValue(CLAUDE_PREVIEW_ENABLED_SETTING) === true;
}

/** `claude.agent.enabled`, checked for the same reason. */
function agentEnabled(accessor: ServicesAccessor): boolean {
	return readClaudeAgentEnabled(accessor.get(IConfigurationService).getValue(CLAUDE_AGENT_ENABLED_SETTING));
}

function preview(accessor: ServicesAccessor): ClaudePreviewEditor | undefined {
	const pane = accessor.get(IEditorService).activeEditorPane;
	return pane instanceof ClaudePreviewEditor ? pane : undefined;
}

export function registerClaudePreviewActions(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'claude.preview.open',
				title: localize2('claudeOpenPreview', "Open Browser Preview"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_PREVIEW_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			if (!previewEnabled(accessor)) {
				return;
			}
			const quickInput = accessor.get(IQuickInputService);
			const notifications = accessor.get(INotificationService);
			const instantiation = accessor.get(IInstantiationService);
			const editorService = accessor.get(IEditorService);
			const value = await quickInput.input({
				prompt: localize('claudePreviewUrlPrompt', "Local preview URL"),
				placeHolder: 'http://localhost:3000',
				value: 'http://localhost:3000',
			});
			if (!value) {
				return;
			}
			const href = parsePreviewUrl(value);
			if (!href) {
				notifications.warn(previewRejectedMessage());
				return;
			}
			const input = instantiation.createInstance(ClaudePreviewInput, href);
			await editorService.openEditor(input);
		}
	});

	registerPreviewAction('claude.preview.back', localize2('claudePreviewBackAction', "Preview: Back"), pane => pane.back(), true);
	registerPreviewAction('claude.preview.forward', localize2('claudePreviewForwardAction', "Preview: Forward"), pane => pane.forward(), true);
	registerPreviewAction('claude.preview.refresh', localize2('claudePreviewRefreshAction', "Preview: Refresh"), pane => pane.refresh(), true);
	registerPreviewAction('claude.preview.device.desktop', localize2('claudePreviewDesktop', "Preview Device: Desktop"), pane => pane.setDevice('desktop'), false);
	registerPreviewAction('claude.preview.device.tablet', localize2('claudePreviewTablet', "Preview Device: Tablet"), pane => pane.setDevice('tablet'), false);
	registerPreviewAction('claude.preview.device.mobile', localize2('claudePreviewMobile', "Preview Device: Mobile"), pane => pane.setDevice('mobile'), false);
	registerPreviewAction('claude.preview.addScreenshot', localize2('claudePreviewShotAction', "Add Screenshot to Agent"), pane => pane.addScreenshot(), true, true);
	registerPreviewAction('claude.preview.freezeFrame', localize2('claudePreviewFreezeAction', "Draw on Preview and Add to Agent"), pane => { void pane.freezeFrame(); }, true, true);
	registerPreviewAction('claude.preview.addConsoleErrors', localize2('claudePreviewConsoleAction', "Add Console Errors to Agent"), pane => pane.addConsoleErrors(), true, true);
	registerPreviewAction('claude.preview.pickElement', localize2('claudePreviewPickAction', "Pick Preview Element"), pane => pane.armPicker(), true);
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'claude.preview.toggleDesignMode',
				title: localize2('claudePreviewDesignAction', "Preview: Toggle Design Mode"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: previewActive,
				// Issue 485. Above the Run and Debug view's Ctrl/Cmd+Shift+D, only while a preview is the active editor.
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyD,
					weight: KeybindingWeight.WorkbenchContrib + 1,
					when: previewActive,
				},
			});
		}
		run(accessor: ServicesAccessor): void {
			const pane = previewEnabled(accessor) ? preview(accessor) : undefined;
			pane?.toggleDesignMode();
		}
	});
	registerPreviewAction('claude.preview.addElement', localize2('claudePreviewElementAction', "Add Selected Elements to Agent"), pane => pane.addElement(), true, true);
	registerPreviewAction('claude.preview.fixElement', localize2('claudePreviewFixAction', "Fix Selected Preview Element with Agent"), pane => pane.fixElement(), true, true);
	registerPreviewAction('claude.preview.copyConsoleErrors', localize2('claudePreviewCopyConsoleAction', "Copy Preview Console Errors"), pane => pane.copyConsoleErrors(), false);
}

function registerPreviewAction(id: string, title: ILocalizedString, run: (pane: ClaudePreviewEditor) => void, menu: boolean, sendsToAgent = false): void {
	const when = sendsToAgent ? previewAgentActive : previewActive;
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id,
				title,
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: when,
				menu: menu ? [{
					id: MenuId.EditorTitle,
					when,
					group: 'navigation',
				}] : undefined,
			});
		}
		run(accessor: ServicesAccessor): void {
			const allowed = previewEnabled(accessor) && (!sendsToAgent || agentEnabled(accessor));
			const pane = allowed ? preview(accessor) : undefined;
			if (pane) {
				run(pane);
			}
		}
	});
}
