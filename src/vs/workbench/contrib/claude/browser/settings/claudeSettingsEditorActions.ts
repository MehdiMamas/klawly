/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { isAllowEverythingLevel } from '../../../../../platform/claude/common/claudeSessionPermissions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { CLAUDE_AGENT_ENABLED, CLAUDE_KLAWLY_KEYMAP } from '../../common/claudeContextKeys.js';
import { claudePermissionLevels } from '../../common/claudePermissionLevels.js';
import { claudeAutomationTemplates } from '../../common/claudeAutomationTemplates.js';
import { isClaudeCreateKind } from '../../common/claudeCustomizeCreate.js';
import { ClaudeSettingsPageId, claudeSettingsPages } from '../../common/claudeSettingsPages.js';
import { CLAUDE_CHANGE_PERMISSION_LEVEL_COMMAND_ID, CLAUDE_IMPORT_FROM_CLAUDE_CODE_COMMAND_ID, CLAUDE_MANAGE_MODELS_COMMAND_ID, CLAUDE_OPEN_CUSTOMIZE_COMMAND_ID, CLAUDE_OPEN_SETTINGS_COMMAND_ID, CLAUDE_SHOW_PLAN_USAGE_COMMAND_ID, KLAWLY_CATEGORY } from '../../common/claudeViews.js';
import { claudeUserLayerLabel } from '../../../../../platform/claude/common/claudeUserLayer.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { ClaudeCodeImporter, ClaudeImportEntry, claudeImportKindLabel } from './claudeCodeImporter.js';
import { ClaudeSettingsEditor } from './claudeSettingsEditor.js';
import { ClaudeSettingsEditorInput, IClaudeSettingsEditorOptions } from './claudeSettingsEditorInput.js';

/** The settings tab keeps no state of its own, so it restores as the same tab after a reload. */
class ClaudeSettingsEditorInputSerializer implements IEditorSerializer {
	canSerialize(editor: EditorInput): boolean {
		return editor instanceof ClaudeSettingsEditorInput;
	}

	serialize(editor: EditorInput): string | undefined {
		return editor instanceof ClaudeSettingsEditorInput ? '' : undefined;
	}

	deserialize(instantiationService: IInstantiationService): EditorInput | undefined {
		return instantiationService.createInstance(ClaudeSettingsEditorInput);
	}
}

/** What `claude.openSettings` takes: a page id, or a page and a search. */
type ClaudeOpenSettingsArg = ClaudeSettingsPageId | { readonly page?: ClaudeSettingsPageId; readonly query?: string; readonly form?: string; readonly automationTemplate?: string } | undefined;

function readOpenSettingsArg(arg: unknown): Pick<IClaudeSettingsEditorOptions, 'page' | 'query' | 'form' | 'automationTemplate'> {
	const pages = claudeSettingsPages().map(page => page.id as string);
	const value = arg as ClaudeOpenSettingsArg;
	if (typeof value === 'string') {
		return pages.includes(value) ? { page: value } : {};
	}
	if (typeof value === 'object' && value !== null) {
		return {
			page: typeof value.page === 'string' && pages.includes(value.page) ? value.page : undefined,
			query: typeof value.query === 'string' ? value.query : undefined,
			form: typeof value.form === 'string' && (value.form === 'hooks' || isClaudeCreateKind(value.form)) ? value.form : undefined,
			automationTemplate: claudeAutomationTemplates().find(template => template.id === value.automationTemplate)?.id,
		};
	}
	return {};
}

/** Opens the one settings tab, at a page or with a search typed, and focuses it. */
export async function openClaudeSettings(editors: IEditorService, instantiation: IInstantiationService, arg?: unknown): Promise<ClaudeSettingsEditor | undefined> {
	const options: IClaudeSettingsEditorOptions = { pinned: true, ...readOpenSettingsArg(arg) };
	const pane = await editors.openEditor(instantiation.createInstance(ClaudeSettingsEditorInput), options);
	return pane instanceof ClaudeSettingsEditor ? pane : undefined;
}

export function registerClaudeSettingsEditor(): void {
	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(ClaudeSettingsEditor, ClaudeSettingsEditor.ID, localize('claudeSettingsEditor', "Klawly Settings")),
		[new SyncDescriptor(ClaudeSettingsEditorInput)],
	);
	Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(ClaudeSettingsEditorInput.ID, ClaudeSettingsEditorInputSerializer);

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_OPEN_SETTINGS_COMMAND_ID,
				title: localize2('claudeOpenSettings', "Open Klawly Settings"),
				category: KLAWLY_CATEGORY,
				f1: true,
				keybinding: {
					// Ctrl+Shift+J opens these settings with Klawly Keys on; it stays the
					// search view's own shortcut while search has focus.
					primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyJ,
					when: ContextKeyExpr.and(CLAUDE_KLAWLY_KEYMAP, ContextKeyExpr.not('searchViewletFocus'), ContextKeyExpr.not('inSearchEditor')),
					weight: KeybindingWeight.WorkbenchContrib,
				},
			});
		}
		async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
			await openClaudeSettings(accessor.get(IEditorService), accessor.get(IInstantiationService), arg);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_MANAGE_MODELS_COMMAND_ID,
				title: localize2('claudeManageModels', "Manage Models"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await openClaudeSettings(accessor.get(IEditorService), accessor.get(IInstantiationService), 'models');
		}
	});

	// DL-30 (issue 723): the words people use for "stop asking me" find the permission level in the Command Palette.
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_CHANGE_PERMISSION_LEVEL_COMMAND_ID,
				title: { ...localize2('claudeChangePermissionLevel', "Change Permission Level"), original: 'Change Permission Level (Permissions, Allow Everything, Auto Approve, Bypass, YOLO)' },
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const configuration = accessor.get(IConfigurationService);
			const trusted = accessor.get(IWorkspaceTrustManagementService).isWorkspaceTrusted();
			const current = configuration.getValue(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING);
			const items = claudePermissionLevels().map(({ level, label, description, icon }) => ({
				level,
				label: `$(${icon.id}) ${label}`,
				// The mode menu says the same when an untrusted workspace holds the open levels back.
				description: isAllowEverythingLevel(level) && !trusted ? localize('claudeChangePermissionLevelUntrusted', "Asks before edits until you trust this workspace") : description,
			}));
			const picked = await accessor.get(IQuickInputService).pick(items, {
				placeHolder: localize('claudeChangePermissionLevelPlaceholder', "What Claude may do without asking, in every chat"),
				matchOnDescription: true,
				activeItem: items.find(item => item.level === current),
			});
			if (picked) {
				// The permission service shows the one-time Allow Everything warning when the level changes.
				await configuration.updateValue(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, picked.level, ConfigurationTarget.USER);
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_SHOW_PLAN_USAGE_COMMAND_ID,
				title: { ...localize2('claudeShowPlanUsage', "Show Plan & Usage"), original: 'Show Plan & Usage (Usage, Limits, Quota, Billing, Credits)' },
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await openClaudeSettings(accessor.get(IEditorService), accessor.get(IInstantiationService), 'plan');
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_OPEN_CUSTOMIZE_COMMAND_ID,
				title: { ...localize2('claudeOpenCustomize', "Open Customize"), original: 'Open Customize (Skills, MCP Servers, Hooks, Rules, Plugins, Subagents, CLAUDE.md)' },
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await openClaudeSettings(accessor.get(IEditorService), accessor.get(IInstantiationService), 'customize');
		}
	});

	// Issue 807: copy what you chose from Claude Code's `~/.claude` into Klawly's own user layer. Claude Code's files are only read.
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_IMPORT_FROM_CLAUDE_CODE_COMMAND_ID,
				title: localize2('claudeImportFromClaudeCode', "Import from Claude Code..."),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const quickInput = accessor.get(IQuickInputService);
			const notifications = accessor.get(INotificationService);
			const folderLabel = claudeUserLayerLabel(accessor.get(IProductService).dataFolderName);
			const importer = accessor.get(IInstantiationService).createInstance(ClaudeCodeImporter);
			const entries = await importer.scan();
			if (!entries.length) {
				notifications.info(localize('claudeImportNone', "~/.claude has no CLAUDE.md, rules, skills, subagents or commands to copy."));
				return;
			}
			const picks = await quickInput.pick<IQuickPickItem & { entry: ClaudeImportEntry }>(entries.map(entry => ({
				label: entry.name,
				description: entry.exists ? localize('claudeImportExists', "{0} · Already in {1}", claudeImportKindLabel(entry.kind), folderLabel) : claudeImportKindLabel(entry.kind),
				picked: !entry.exists,
				entry,
			})), {
				canPickMany: true,
				placeHolder: localize('claudeImportPlaceholder', "Choose what to copy into {0}. Claude Code's own files are not changed.", folderLabel),
			});
			if (!picks?.length) {
				return;
			}
			try {
				notifications.info(ClaudeCodeImporter.summary(await importer.copy(picks.map(pick => pick.entry)), folderLabel));
			} catch (error) {
				notifications.error(error instanceof Error ? error.message : String(error));
			}
		}
	});
}
