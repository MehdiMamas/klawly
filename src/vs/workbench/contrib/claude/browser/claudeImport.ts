/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { OS } from '../../../../base/common/platform.js';
import { env } from '../../../../base/common/process.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { EXTENSION_INSTALL_SOURCE_CONTEXT, ExtensionInstallSource, IExtensionGalleryService, IGalleryExtension, InstallExtensionInfo } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, IPromptChoice, Severity } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IUserDataProfile, IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IJSONEditingService } from '../../../services/configuration/common/jsonEditing.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchExtensionManagementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { CLAUDE_USER_LAYER_FILES, CLAUDE_USER_LAYER_FOLDER, claudeUserLayerLabel } from '../../../../platform/claude/common/claudeUserLayer.js';
import { IUserDataProfileManagementService, IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { KLAWLY_CATEGORY } from '../common/claudeViews.js';
import {
	CLAUDE_IMPORT_EDITORS, CLAUDE_IMPORT_FROM_CURSOR_COMMAND_ID, CLAUDE_IMPORT_FROM_VSCODE_COMMAND_ID, CLAUDE_UNDO_IMPORT_COMMAND_ID, ClaudeExtensionsImportPlan, ClaudeImportBackup, ClaudeImportEditorId, claudeImportEditorName,
	claudeImportExtensionCandidates, ClaudeImportExtension, ClaudeImportFailure, claudeImportHasChanges, ClaudeImportItem, claudeImportItems, ClaudeImportLocations, claudeImportLocations, ClaudeImportMode, ClaudeImportOutcome,
	ClaudeImportPart, ClaudeImportPlan, claudeImportPreview, ClaudeImportReader, claudeImportReport, ClaudeImportSource, ClaudeKeybindingsImportPlan, claudeKeybindingLabel, claudeSelectImport,
	parseClaudeImportBackup, planClaudeExtensionsImport, planClaudeKeybindingsImport, planClaudeSettingsImport, planClaudeSnippetsImport, ClaudeSettingsImportPlan,
	ClaudeImportProfile, claudeImportProfileLocations, ClaudeThemeEnvironment, planClaudeThemesImport, claudeImportThemeExtensions, ClaudeImportThemeKind, claudeImportRulesBody,
	ClaudeRulesImportPlan, ClaudeMcpImportPlan, planClaudeRulesImport, claudeRulesAppendix, claudeRulesRemove, planClaudeMcpImport, claudeMcpImportText, claudeMcpUndoText,
} from '../common/claudeImport.js';

export const CLAUDE_IMPORT_VSCODE_AVAILABLE = new RawContextKey<boolean>('claude.importFromVSCodeAvailable', false, localize('claudeImportVSCodeKey', "Whether VS Code is installed and its settings can be imported"));
export const CLAUDE_IMPORT_CURSOR_AVAILABLE = new RawContextKey<boolean>('claude.importFromCursorAvailable', false, localize('claudeImportCursorKey', "Whether Cursor is installed and its settings can be imported"));
export const CLAUDE_IMPORT_UNDO_AVAILABLE = new RawContextKey<boolean>('claude.importUndoAvailable', false, localize('claudeImportUndoKey', "Whether the last import into this profile can be undone"));

const IMPORTED_KEY = 'claude.import.done';
/** The {@link ClaudeImportBackup} of the last import into this profile (issue 549). */
const BACKUP_KEY = 'claude.import.backup';

/** Where an import writes: the current profile, or a new one in `profile` mode. */
interface ClaudeImportTarget {
	readonly settingsResource: URI;
	readonly keybindingsResource: URI;
	readonly snippetsHome: URI;
	/** Set for a new profile, so extensions install into it. */
	readonly extensionsResource?: URI;
}

/** A row of the item picker. */
type ClaudeImportRow = IQuickPickItem & { readonly importItem: ClaudeImportItem };

export const IClaudeImportService = createDecorator<IClaudeImportService>('claudeImportService');

/**
 * Imports settings, keybindings, snippets and extensions from VS Code or
 * Cursor into the current Klawly profile. Reads only the allowlisted files
 * (see `claudeImportFileKind`), shows a preview, and never overwrites a value
 * the user already set in Klawly.
 */
export interface IClaudeImportService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** Editors whose user folder exists, from the last detection. Empty before the first one. */
	readonly detected: readonly ClaudeImportEditorId[];
	/** True once an import finished in this profile. */
	readonly imported: boolean;
	/** Looks for each editor's user folder again. */
	detect(): Promise<readonly ClaudeImportEditorId[]>;
	/** Runs the import. Without an editor it asks which one when both are installed. */
	run(editor?: ClaudeImportEditorId): Promise<void>;
	/** True when the last import into this profile backed up what it changed. */
	readonly canUndo: boolean;
	/** Puts back the settings, keybindings and snippet files the last import changed. */
	undo(): Promise<void>;
}

interface PlannedImport {
	readonly plan: ClaudeImportPlan;
	readonly gallery: ReadonlyMap<string, IGalleryExtension>;
}

export class ClaudeImportService extends Disposable implements IClaudeImportService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _detected: readonly ClaudeImportEditorId[] = [];
	private readonly _locations = new Map<ClaudeImportEditorId, ClaudeImportLocations>();
	private _detection: Promise<readonly ClaudeImportEditorId[]> | undefined;
	private _running = false;

	constructor(
		@IFileService private readonly _files: IFileService,
		@IPathService private readonly _paths: IPathService,
		@IUserDataProfileService private readonly _profiles: IUserDataProfileService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@IDialogService private readonly _dialogs: IDialogService,
		@INotificationService private readonly _notifications: INotificationService,
		@IProgressService private readonly _progress: IProgressService,
		@IExtensionGalleryService private readonly _gallery: IExtensionGalleryService,
		@IWorkbenchExtensionManagementService private readonly _extensions: IWorkbenchExtensionManagementService,
		@IJSONEditingService private readonly _jsonEditing: IJSONEditingService,
		@ITextFileService private readonly _textFiles: ITextFileService,
		@IEditorService private readonly _editors: IEditorService,
		@IStorageService private readonly _storage: IStorageService,
		@IUserDataProfilesService private readonly _allProfiles: IUserDataProfilesService,
		@IUserDataProfileManagementService private readonly _profileManagement: IUserDataProfileManagementService,
		@IProductService private readonly _product: IProductService,
		@IWorkbenchThemeService private readonly _themes: IWorkbenchThemeService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
	) {
		super();
	}

	get canUndo(): boolean {
		return this._storage.get(BACKUP_KEY, StorageScope.PROFILE) !== undefined;
	}

	get detected(): readonly ClaudeImportEditorId[] {
		return this._detected;
	}

	get imported(): boolean {
		return this._storage.getBoolean(IMPORTED_KEY, StorageScope.PROFILE, false);
	}

	detect(): Promise<readonly ClaudeImportEditorId[]> {
		if (!this._detection) {
			// Cleared once the scan settles, never inside it: a scan that fails before
			// its first await would otherwise clear the field before it is set, and
			// every later call would get that old result.
			const detection = this.scan();
			this._detection = detection;
			void detection.finally(() => {
				if (this._detection === detection) {
					this._detection = undefined;
				}
			});
		}
		return this._detection;
	}

	private async scan(): Promise<readonly ClaudeImportEditorId[]> {
		try {
			// The local home: the other editors are installed on this machine, even in a remote window.
			const userHome = this._paths.userHome({ preferLocal: true });
			const found: ClaudeImportEditorId[] = [];
			for (const editor of CLAUDE_IMPORT_EDITORS) {
				const locations = claudeImportLocations(editor, OS, userHome, env);
				this._locations.set(editor, locations);
				if (await this._files.exists(locations.userFolder)) {
					found.push(editor);
				}
			}
			if (found.join() !== this._detected.join() && !this._store.isDisposed) {
				this._detected = found;
				this._onDidChange.fire();
			}
		} catch {
			// Detection is best effort. Nothing found means nothing is offered.
		}
		return this._detected;
	}

	async run(editor?: ClaudeImportEditorId): Promise<void> {
		if (this._running) {
			this._notifications.info(localize('claudeImportRunning', "An import is already in progress."));
			return;
		}
		const detected = await this.detect();
		if (!detected.length) {
			this._notifications.info(localize('claudeImportNoneFound', "Neither VS Code nor Cursor was found on this computer."));
			return;
		}
		if (editor && !detected.includes(editor)) {
			this._notifications.info(localize('claudeImportNotFound', "{0} was not found on this computer.", claudeImportEditorName(editor)));
			return;
		}
		const chosen = editor ?? (detected.length === 1 ? detected[0] : await this.pickEditor(detected));
		const locations = chosen && this._locations.get(chosen);
		if (!chosen || !locations || this._running) {
			return;
		}
		this._running = true;
		try {
			await this.doRun(chosen, locations);
		} catch (error) {
			this._notifications.error(localize('claudeImportFailed', "Import from {0} failed: {1}", claudeImportEditorName(chosen), toErrorMessage(error)));
		} finally {
			this._running = false;
		}
	}

	private async pickEditor(detected: readonly ClaudeImportEditorId[]): Promise<ClaudeImportEditorId | undefined> {
		const picked = await this._quickInput.pick(detected.map(editor => ({ id: editor, label: claudeImportEditorName(editor) })), {
			title: localize('claudeImportPickEditorTitle', "Import Settings"),
			placeHolder: localize('claudeImportPickEditor', "Import from which editor?"),
		});
		return detected.find(editor => editor === picked?.id);
	}

	/** VS Code only: the default profile, or one of its named profiles (issue 857). Undefined when the user cancels. */
	private async pickProfile(editor: ClaudeImportEditorId, locations: ClaudeImportLocations): Promise<{ readonly locations: ClaudeImportLocations } | undefined> {
		const base: ClaudeImportLocations = { ...locations, workspaceFolders: this._workspace.getWorkspace().folders.map(folder => folder.uri) };
		if (editor !== 'vscode') {
			return { locations: base };
		}
		let profiles: readonly ClaudeImportProfile[] = [];
		try {
			profiles = await new ClaudeImportReader(base, this._files).profiles();
		} catch {
			// A profile list that can't be read means only the default profile is offered.
		}
		if (!profiles.length) {
			return { locations: base };
		}
		const items: (IQuickPickItem & { profile?: ClaudeImportProfile })[] = [
			{ label: localize('claudeImportProfileDefault', "Default Profile"), description: localize('claudeImportProfileDefaultDetail', "The settings you get without a profile") },
			...profiles.map(profile => ({ profile, label: profile.name })),
		];
		const picked = await this._quickInput.pick(items, {
			title: localize('claudeImportProfileTitle', "Import from {0}", claudeImportEditorName(editor)),
			placeHolder: localize('claudeImportProfilePick', "Which profile do you want to import from?"),
		});
		return picked ? { locations: claudeImportProfileLocations(base, picked.profile) } : undefined;
	}

	private async doRun(editor: ClaudeImportEditorId, baseLocations: ClaudeImportLocations): Promise<void> {
		const profile = await this.pickProfile(editor, baseLocations);
		if (!profile) {
			return;
		}
		const reader = new ClaudeImportReader(profile.locations, this._files);
		const source = await reader.collect();
		const parts = await this.pickParts(editor, source);
		if (!parts) {
			return;
		}
		const mode = await this.pickMode(editor);
		if (!mode) {
			return;
		}
		const planned = await this.plan(editor, source, parts, mode);
		if (!planned) {
			return;
		}
		const plan = await this.pickItems(planned.plan);
		if (!plan) {
			return;
		}
		if (!claudeImportHasChanges(plan)) {
			this.finish(plan, { failures: [] });
			return;
		}
		const { confirmed } = await this._dialogs.confirm({
			type: Severity.Info,
			message: localize('claudeImportConfirm', "Import from {0}?", claudeImportEditorName(editor)),
			detail: claudeImportPreview(plan),
			primaryButton: localize({ key: 'claudeImportConfirmButton', comment: ['&& denotes a mnemonic'] }, "&&Import"),
		});
		if (!confirmed) {
			return;
		}
		const target = await this.target(plan);
		const outcome = await this.apply({ plan, gallery: planned.gallery }, reader, target);
		this.finish(plan, outcome, target.profile);
	}

	private async pickMode(editor: ClaudeImportEditorId): Promise<ClaudeImportMode | undefined> {
		const name = claudeImportEditorName(editor);
		const items: (IQuickPickItem & { mode: ClaudeImportMode })[] = [
			{ mode: 'keep', label: localize('claudeImportModeKeep', "Keep Mine"), detail: localize('claudeImportModeKeepDetail', "Only add what isn't set in Klawly. Nothing you set is changed.") },
			{ mode: 'overwrite', label: localize('claudeImportModeOverwrite', "Overwrite"), detail: localize('claudeImportModeOverwriteDetail', "Values from {0} replace yours. Uncheck an item to keep yours; Undo Import puts everything back.", name) },
			{ mode: 'profile', label: localize('claudeImportModeProfile', "New Profile"), detail: localize('claudeImportModeProfileDetail', "Import into a new profile named after {0}. Your current profile is not changed.", name) },
		];
		const picked = await this._quickInput.pick(items, {
			title: localize('claudeImportModeTitle', "Import from {0}", name),
			placeHolder: localize('claudeImportMode', "How should imported values meet the ones you set?"),
		});
		return picked?.mode;
	}

	/** The tree of single items: one checkbox per setting, keybinding, snippet file and extension, grouped by part. */
	private async pickItems(plan: ClaudeImportPlan): Promise<ClaudeImportPlan | undefined> {
		const items = claudeImportItems(plan);
		if (!items.some(item => !item.skipped)) {
			return plan;
		}
		const partLabels: Record<ClaudeImportPart, string> = {
			settings: localize('claudeImportPartSettings', "Settings"),
			keybindings: localize('claudeImportPartKeybindings', "Keybindings"),
			snippets: localize('claudeImportPartSnippets', "Snippets"),
			extensions: localize('claudeImportPartExtensions', "Extensions"),
			themes: localize('claudeImportPartThemes', "Themes"),
			rules: localize('claudeImportPartRules', "Rules (CLAUDE.md)"),
			mcp: localize('claudeImportPartMcp', "MCP Servers"),
		};
		const rows: (IQuickPickSeparator | ClaudeImportRow)[] = [];
		let part: ClaudeImportPart | undefined;
		for (const item of items) {
			if (item.part !== part) {
				part = item.part;
				rows.push({ type: 'separator', label: partLabels[part] });
			}
			rows.push({
				importItem: item,
				label: item.label,
				description: item.skipped ? localize('claudeImportItemSkipped', "Skipped: {0}", item.skipped) : item.description,
				picked: item.picked,
				disabled: !!item.skipped,
			});
		}
		const picked = await this._quickInput.pick<ClaudeImportRow>(rows, {
			canPickMany: true,
			matchOnDescription: true,
			title: localize('claudeImportItemsTitle', "Import from {0}", claudeImportEditorName(plan.editor)),
			placeHolder: localize('claudeImportItems', "Uncheck anything you don't want. Skipped items show why. You see a summary before anything changes."),
		});
		if (!picked?.length) {
			return undefined;
		}
		return claudeSelectImport(plan, new Set(picked.map(row => row.importItem.id)));
	}

	/** The profile to write into. In `profile` mode it is created now, after the user confirmed. */
	private async target(plan: ClaudeImportPlan): Promise<ClaudeImportTarget & { readonly profile?: IUserDataProfile }> {
		if (plan.mode !== 'profile') {
			return this._profiles.currentProfile;
		}
		const profile = await this._profileManagement.createProfile(plan.profileName ?? claudeImportEditorName(plan.editor));
		return { settingsResource: profile.settingsResource, keybindingsResource: profile.keybindingsResource, snippetsHome: profile.snippetsHome, extensionsResource: profile.extensionsResource, profile };
	}

	/** "VS Code (Imported)", then "VS Code (Imported) 2" and so on when that name is taken. */
	private newProfileName(editor: ClaudeImportEditorId): string {
		const base = localize('claudeImportProfileName', "{0} (Imported)", claudeImportEditorName(editor));
		const taken = new Set(this._allProfiles.profiles.map(profile => profile.name.toLowerCase()));
		let name = base;
		for (let index = 2; taken.has(name.toLowerCase()); index++) {
			name = `${base} ${index}`;
		}
		return name;
	}

	private async pickParts(editor: ClaudeImportEditorId, source: ClaudeImportSource): Promise<ReadonlySet<ClaudeImportPart> | undefined> {
		const items: (IQuickPickItem & { part: ClaudeImportPart })[] = [];
		if (source.settings !== undefined) {
			items.push({ part: 'settings', label: localize('claudeImportPartSettings', "Settings"), description: 'settings.json', picked: true });
		}
		if (source.keybindings !== undefined) {
			items.push({ part: 'keybindings', label: localize('claudeImportPartKeybindings', "Keybindings"), description: 'keybindings.json', picked: true });
		}
		if (source.snippets.length) {
			items.push({ part: 'snippets', label: localize('claudeImportPartSnippets', "Snippets"), description: localize('claudeImportPartSnippetsCount', "{0} files", source.snippets.length), picked: true });
		}
		if (source.extensions.length) {
			items.push({ part: 'extensions', label: localize('claudeImportPartExtensions', "Extensions"), description: localize('claudeImportPartExtensionsCount', "{0} extensions, installed again from the extension gallery", source.extensions.length), picked: true });
		}
		if (source.settings !== undefined && planClaudeSettingsImport(source.settings, '', 'keep', 'themes').add.length) {
			items.push({ part: 'themes', label: localize('claudeImportPartThemes', "Themes"), description: localize('claudeImportPartThemesDetail', "Color and icon themes, matched to the ones Klawly has"), picked: true });
		}
		if (source.rules.length) {
			items.push({ part: 'rules', label: localize('claudeImportPartRules', "Rules (CLAUDE.md)"), description: localize('claudeImportPartRulesCount', "{0} rules files, added to your CLAUDE.md as a marked section", source.rules.length), picked: true });
		}
		if (source.mcp.length) {
			items.push({ part: 'mcp', label: localize('claudeImportPartMcp', "MCP Servers"), description: localize('claudeImportPartMcpDetail', "Without keys, tokens or other secrets: you fill those in"), picked: true });
		}
		if (!items.length) {
			this._notifications.info(localize('claudeImportNothing', "{0} has no settings, keybindings, snippets, extensions, themes, rules or MCP servers to import.", claudeImportEditorName(editor)));
			return undefined;
		}
		const picked = await this._quickInput.pick(items, {
			canPickMany: true,
			title: localize('claudeImportPartsTitle', "Import from {0}", claudeImportEditorName(editor)),
			placeHolder: localize('claudeImportParts', "Choose what to import. You see a preview before anything changes."),
		});
		return picked?.length ? new Set(picked.map(item => item.part)) : undefined;
	}

	/** Plans against the current profile, or against an empty one in `profile` mode (the new profile is created only after the preview). */
	private async plan(editor: ClaudeImportEditorId, source: ClaudeImportSource, parts: ReadonlySet<ClaudeImportPart>, mode: ClaudeImportMode): Promise<PlannedImport | undefined> {
		const profile = mode === 'profile' ? undefined : this._profiles.currentProfile;
		const settings = parts.has('settings') && source.settings !== undefined
			? await this.planJson(profile?.settingsResource, target => planClaudeSettingsImport(source.settings ?? '', target, mode), (): ClaudeSettingsImportPlan => ({ add: [], replace: [], kept: [], skipped: [], invalid: 'unsaved' }))
			: undefined;
		const keybindings = parts.has('keybindings') && source.keybindings !== undefined
			? await this.planJson(profile?.keybindingsResource, target => planClaudeKeybindingsImport(source.keybindings ?? '', target, editor), (): ClaudeKeybindingsImportPlan => ({ add: [], existing: 0, skipped: [], invalid: 'unsaved' }))
			: undefined;
		const snippets = parts.has('snippets') ? planClaudeSnippetsImport(source.snippets, profile ? await this.childNames(profile.snippetsHome) : [], mode) : undefined;
		let extensions: ClaudeExtensionsImportPlan | undefined;
		const gallery = new Map<string, IGalleryExtension>();
		let themes: ClaudeSettingsImportPlan | undefined;
		if (parts.has('extensions')) {
			const result = await this.planExtensions(source.extensions, mode);
			if (!result) {
				return undefined;
			}
			extensions = result.plan;
			result.gallery.forEach((value, key) => gallery.set(key, value));
		}
		if (parts.has('themes') && source.settings !== undefined) {
			const result = await this.planThemes(source, profile?.settingsResource, mode, gallery);
			if (!result) {
				return undefined;
			}
			themes = result;
		}
		// CLAUDE.md and .mcp.json are Klawly's user layer, shared by every profile: a new profile has no copy of them.
		let rules: ClaudeRulesImportPlan | undefined;
		let mcp: ClaudeMcpImportPlan | undefined;
		if (mode === 'profile') {
			if (parts.has('rules') || parts.has('mcp')) {
				this._notifications.info(localize('claudeImportUserLayerNotProfile', "Rules and MCP servers go to your Klawly user setup, which every profile shares. Import them with Keep Mine or Overwrite instead."));
			}
		} else {
			if (parts.has('rules')) {
				const files = source.rules.map(file => ({ name: file.name, text: claudeImportRulesBody(file.text) })).filter(file => file.text);
				rules = planClaudeRulesImport(files, await this.readText(this.userLayerFile('rules')));
			}
			if (parts.has('mcp')) {
				mcp = planClaudeMcpImport(source.mcp, await this.readText(this.userLayerFile('mcp')));
			}
		}
		const profileName = mode === 'profile' ? this.newProfileName(editor) : undefined;
		return { plan: { editor, mode, profileName, settings, keybindings, snippets, extensions, themes, rules, mcp }, gallery };
	}

	/** `~/.klawly/claude/<file>`: the user layer, in the local home folder. */
	private userLayerFile(file: 'rules' | 'mcp'): URI {
		return joinPath(this._paths.userHome({ preferLocal: true }), this._product.dataFolderName ?? '.klawly', CLAUDE_USER_LAYER_FOLDER, CLAUDE_USER_LAYER_FILES[file]);
	}

	/** The `~/`-style name of a user layer file, for the report and messages. */
	private userLayerLabel(file: 'rules' | 'mcp'): string {
		return claudeUserLayerLabel(this._product.dataFolderName ?? '.klawly', CLAUDE_USER_LAYER_FILES[file]);
	}

	private async readText(resource: URI): Promise<string | undefined> {
		return (await this._files.exists(resource)) ? (await this._files.readFile(resource)).value.toString() : undefined;
	}

	/** Themes of the source mapped to the ones Klawly has; a theme only an extension of the other editor provides is installed from the gallery, or skipped with its reason. */
	private async planThemes(source: ClaudeImportSource, settingsResource: URI | undefined, mode: ClaudeImportMode, gallery: Map<string, IGalleryExtension>): Promise<ClaudeSettingsImportPlan | undefined> {
		const installedThemes = (themes: readonly { readonly id: string; readonly label: string; readonly settingsId: string | null }[]): ReadonlySet<string> =>
			new Set(themes.flatMap(theme => [theme.id, theme.label, theme.settingsId].filter((name): name is string => !!name).map(name => name.toLowerCase())));
		const installed: Record<ClaudeImportThemeKind, ReadonlySet<string>> = {
			color: installedThemes(await this._themes.getColorThemes()),
			icon: installedThemes(await this._themes.getFileIconThemes()),
			productIcon: installedThemes(await this._themes.getProductIconThemes()),
		};
		const installedExtensions = new Set(mode === 'profile' ? [] : (await this._extensions.getInstalled()).map(extension => extension.identifier.id.toLowerCase()));
		const text = (target: string) => (env: ClaudeThemeEnvironment) => planClaudeThemesImport(source.settings ?? '', target, mode, env);
		const target = settingsResource ? (await this.readText(settingsResource)) ?? '' : '';
		const base = { installed, providers: source.themeProviders, installedExtensions };
		const planWith = text(target);
		if (!this._gallery.isEnabled()) {
			return planWith({ ...base, gallery: 'no-gallery' });
		}
		// First pass: which extensions would the themes need? Then ask the gallery for exactly those.
		const needed = claudeImportThemeExtensions(planWith({ ...base, gallery: { has: () => true } })).filter(id => !gallery.has(id.toLowerCase()));
		if (!needed.length) {
			return planWith({ ...base, gallery: new Set(gallery.keys()) });
		}
		const cancellation = new CancellationTokenSource();
		try {
			const results = await this._progress.withProgress({
				location: ProgressLocation.Notification,
				title: localize('claudeImportThemeLookup', "Looking up {0} theme extensions in the extension gallery...", needed.length),
				cancellable: true,
			}, () => this._gallery.getExtensions(needed.map(id => ({ id })), cancellation.token), () => cancellation.cancel());
			if (cancellation.token.isCancellationRequested) {
				return undefined;
			}
			for (const extension of results) {
				gallery.set(extension.identifier.id.toLowerCase(), extension);
			}
			return planWith({ ...base, gallery: new Set(gallery.keys()) });
		} catch {
			if (cancellation.token.isCancellationRequested) {
				return undefined;
			}
			return planWith({ ...base, gallery: 'gallery-unreachable' });
		} finally {
			cancellation.dispose();
		}
	}

	/** Klawly's own file (none for a new profile). Refuses while it has unsaved changes, so the import never saves someone's half-done edit. */
	private async planJson<T>(resource: URI | undefined, plan: (target: string) => T, unsaved: () => T): Promise<T> {
		if (!resource) {
			return plan('');
		}
		if (this._textFiles.isDirty(resource)) {
			return unsaved();
		}
		let text = '';
		if (await this._files.exists(resource)) {
			text = (await this._files.readFile(resource)).value.toString();
		}
		return plan(text);
	}

	private async childNames(folder: URI): Promise<readonly string[]> {
		try {
			return (await this._files.resolve(folder)).children?.map(child => child.name) ?? [];
		} catch {
			return [];
		}
	}

	private async planExtensions(found: readonly ClaudeImportExtension[], mode: ClaudeImportMode): Promise<{ plan: ClaudeExtensionsImportPlan; gallery: ReadonlyMap<string, IGalleryExtension> } | undefined> {
		// A new profile starts without the current profile's extensions.
		const installed = new Set(mode === 'profile' ? [] : (await this._extensions.getInstalled()).map(extension => extension.identifier.id.toLowerCase()));
		if (!this._gallery.isEnabled()) {
			return { plan: planClaudeExtensionsImport(found, installed, 'no-gallery'), gallery: new Map() };
		}
		const candidates = claudeImportExtensionCandidates(found, installed);
		const gallery = new Map<string, IGalleryExtension>();
		if (!candidates.length) {
			return { plan: planClaudeExtensionsImport(found, installed, new Set()), gallery };
		}
		const cancellation = new CancellationTokenSource();
		try {
			const results = await this._progress.withProgress({
				location: ProgressLocation.Notification,
				title: localize('claudeImportLookup', "Looking up {0} extensions in the extension gallery...", candidates.length),
				cancellable: true,
			}, () => this._gallery.getExtensions(candidates.map(candidate => ({ id: candidate.id })), cancellation.token), () => cancellation.cancel());
			if (cancellation.token.isCancellationRequested) {
				return undefined;
			}
			for (const extension of results) {
				gallery.set(extension.identifier.id.toLowerCase(), extension);
			}
			return { plan: planClaudeExtensionsImport(found, installed, new Set(gallery.keys())), gallery };
		} catch {
			if (cancellation.token.isCancellationRequested) {
				return undefined;
			}
			return { plan: planClaudeExtensionsImport(found, installed, 'gallery-unreachable'), gallery };
		} finally {
			cancellation.dispose();
		}
	}

	private async apply({ plan, gallery }: PlannedImport, reader: ClaudeImportReader, target: ClaudeImportTarget): Promise<ClaudeImportOutcome> {
		const failures: ClaudeImportFailure[] = [];
		const fileBackup = plan.mode === 'profile' ? undefined : await this.backup(plan, target);
		const installedIds: string[] = [];

		// Theme extensions install first, so a theme whose extension failed is never written.
		const themeEntries = [...plan.themes?.add ?? [], ...plan.themes?.replace ?? []];
		const failedThemeExtensions = new Set<string>();
		const themeExtensionIds = claudeImportThemeExtensions(plan.themes ?? { add: [], replace: [], kept: [], skipped: [] });
		const themeInstall: InstallExtensionInfo[] = [];
		for (const id of themeExtensionIds) {
			const galleryExtension = gallery.get(id.toLowerCase());
			if (galleryExtension) {
				themeInstall.push({ extension: galleryExtension, options: { context: { [EXTENSION_INSTALL_SOURCE_CONTEXT]: ExtensionInstallSource.COMMAND }, profileLocation: target.extensionsResource } });
			} else {
				failedThemeExtensions.add(id.toLowerCase());
			}
		}
		if (themeInstall.length) {
			try {
				const results = await this._progress.withProgress({
					location: ProgressLocation.Notification,
					title: localize('claudeImportInstallingThemes', "Installing {0} theme extensions from the extension gallery...", themeInstall.length),
				}, () => this._extensions.installGalleryExtensions(themeInstall));
				for (const result of results) {
					if (result.error) {
						failedThemeExtensions.add(result.identifier.id.toLowerCase());
					} else {
						installedIds.push(result.identifier.id);
					}
				}
			} catch {
				themeInstall.forEach(info => failedThemeExtensions.add(info.extension.identifier.id.toLowerCase()));
			}
		}
		const themeWrites = themeEntries.filter(entry => !entry.needsExtension || !failedThemeExtensions.has(entry.needsExtension.toLowerCase()));
		for (const entry of themeEntries) {
			if (!themeWrites.includes(entry)) {
				failures.push({ part: 'themes', item: entry.label, message: localize('claudeImportThemeExtensionFailed', "The extension {0} could not be installed.", entry.needsExtension ?? '') });
			}
		}

		const settings = [...plan.settings?.add ?? [], ...plan.settings?.replace ?? [], ...themeWrites];
		if (settings.length) {
			try {
				await this.ensureFile(target.settingsResource, '{}');
				await this._jsonEditing.write(target.settingsResource, settings.map(value => ({ path: value.path, value: value.value })), true);
			} catch (error) {
				failures.push(...settings.map(value => ({ part: 'settings' as const, item: value.label, message: toErrorMessage(error) })));
			}
		}

		const keybindings = plan.keybindings?.add ?? [];
		if (keybindings.length) {
			try {
				await this.ensureFile(target.keybindingsResource, '[]');
				await this._jsonEditing.write(target.keybindingsResource, keybindings.map(entry => ({ path: [-1], value: entry })), true);
			} catch (error) {
				failures.push(...keybindings.map(entry => ({ part: 'keybindings' as const, item: claudeKeybindingLabel(entry), message: toErrorMessage(error) })));
			}
		}

		const snippets = [...(plan.snippets?.copy ?? []).map(file => ({ file, overwrite: false })), ...(plan.snippets?.replace ?? []).map(file => ({ file, overwrite: true }))];
		for (const { file, overwrite } of snippets) {
			try {
				const text = await reader.readText(file.resource);
				if (text === undefined) {
					throw new Error(localize('claudeImportUnreadable', "The file could not be read."));
				}
				// Without overwrite, createFile fails when the file exists: only a replacement the user picked replaces one.
				await this._files.createFile(joinPath(target.snippetsHome, file.name), VSBuffer.fromString(text), { overwrite });
			} catch (error) {
				failures.push({ part: 'snippets', item: file.name, message: toErrorMessage(error) });
			}
		}

		const install: InstallExtensionInfo[] = [];
		const planIds = new Map<string, string>();
		for (const extension of plan.extensions?.install ?? []) {
			const galleryExtension = gallery.get(extension.id.toLowerCase());
			if (galleryExtension) {
				planIds.set(extension.id.toLowerCase(), extension.id);
				install.push({ extension: galleryExtension, options: { context: { [EXTENSION_INSTALL_SOURCE_CONTEXT]: ExtensionInstallSource.COMMAND }, profileLocation: target.extensionsResource } });
			}
		}
		if (install.length) {
			try {
				const results = await this._progress.withProgress({
					location: ProgressLocation.Notification,
					title: localize('claudeImportInstalling', "Installing {0} extensions from the extension gallery...", install.length),
				}, () => this._extensions.installGalleryExtensions(install));
				for (const result of results) {
					if (result.error) {
						const id = result.identifier.id.toLowerCase();
						failures.push({ part: 'extensions', item: planIds.get(id) ?? result.identifier.id, message: toErrorMessage(result.error) });
					} else {
						installedIds.push(result.identifier.id);
					}
				}
			} catch (error) {
				failures.push(...[...planIds.values()].map(id => ({ part: 'extensions' as const, item: id, message: toErrorMessage(error) })));
			}
		}
		// Rules: one marked section appended to CLAUDE.md. Undo removes exactly that text.
		let claudeMd: ClaudeImportBackup['claudeMd'];
		const appendix = plan.rules ? claudeRulesAppendix(plan.editor, plan.rules) : '';
		if (plan.rules && appendix) {
			const resource = this.userLayerFile('rules');
			try {
				const existing = await this.readText(resource);
				if (existing !== undefined && existing !== plan.rules.target) {
					throw new Error(localize('claudeImportRulesChanged', "{0} changed while you were deciding. Run the import again.", this.userLayerLabel('rules')));
				}
				if (existing === undefined) {
					await this._files.createFile(resource, VSBuffer.fromString(appendix), { overwrite: false });
				} else {
					await this._files.writeFile(resource, VSBuffer.fromString(existing + appendix));
				}
				claudeMd = { appended: appendix, created: existing === undefined };
			} catch (error) {
				failures.push(...plan.rules.add.map(file => ({ part: 'rules' as const, item: file.name, message: toErrorMessage(error) })));
			}
		}

		// MCP servers: only the sanitized entries. Undo removes exactly those servers.
		let mcp: ClaudeImportBackup['mcp'];
		if (plan.mcp?.add.length) {
			const resource = this.userLayerFile('mcp');
			try {
				const existing = await this.readText(resource);
				const text = claudeMcpImportText(existing, plan.mcp.add);
				if (text === undefined) {
					throw new Error(localize('claudeImportMcpTargetInvalid', "{0} has errors. Fix it first.", this.userLayerLabel('mcp')));
				}
				if (existing === undefined) {
					await this._files.createFile(resource, VSBuffer.fromString(text), { overwrite: false });
				} else {
					await this._files.writeFile(resource, VSBuffer.fromString(text));
				}
				mcp = { servers: plan.mcp.add.map(server => server.name), created: existing === undefined };
			} catch (error) {
				failures.push(...plan.mcp.add.map(server => ({ part: 'mcp' as const, item: server.name, message: toErrorMessage(error) })));
			}
		}

		// Extensions that went into a new profile are undone by deleting that profile.
		const backup = plan.mode === 'profile' ? undefined : fileBackup || installedIds.length || claudeMd || mcp
			? { editor: plan.editor, snippets: [], ...fileBackup, ...installedIds.length ? { extensions: [...new Set(installedIds)] } : {}, ...claudeMd ? { claudeMd } : {}, ...mcp ? { mcp } : {} }
			: undefined;
		if (backup) {
			this._storage.store(BACKUP_KEY, JSON.stringify(backup), StorageScope.PROFILE, StorageTarget.MACHINE);
		}
		return { failures };
	}

	private async ensureFile(resource: URI, empty: string): Promise<void> {
		if (!(await this._files.exists(resource))) {
			await this._files.createFile(resource, VSBuffer.fromString(empty), { overwrite: false });
		}
	}

	/** The text of every file the import is about to change, read before the first write. */
	private async backup(plan: ClaudeImportPlan, target: ClaudeImportTarget): Promise<ClaudeImportBackup | undefined> {
		const read = async (resource: URI) => (await this._files.exists(resource)) ? (await this._files.readFile(resource)).value.toString() : null;
		const writesSettings = !!(plan.settings?.add.length || plan.settings?.replace.length || plan.themes?.add.length || plan.themes?.replace.length);
		const writesKeybindings = !!plan.keybindings?.add.length;
		const snippets: { name: string; previous: string | null }[] = [];
		for (const file of plan.snippets?.copy ?? []) {
			snippets.push({ name: file.name, previous: null });
		}
		for (const file of plan.snippets?.replace ?? []) {
			snippets.push({ name: file.name, previous: await read(joinPath(target.snippetsHome, file.name)) });
		}
		if (!writesSettings && !writesKeybindings && !snippets.length) {
			return undefined;
		}
		return {
			editor: plan.editor,
			settings: writesSettings ? await read(target.settingsResource) : undefined,
			keybindings: writesKeybindings ? await read(target.keybindingsResource) : undefined,
			snippets,
		};
	}

	async undo(): Promise<void> {
		const backup = parseClaudeImportBackup(this._storage.get(BACKUP_KEY, StorageScope.PROFILE));
		if (!backup) {
			this._storage.remove(BACKUP_KEY, StorageScope.PROFILE);
			this._onDidChange.fire();
			this._notifications.info(localize('claudeImportNothingToUndo', "There is no import to undo in this profile."));
			return;
		}
		const profile = this._profiles.currentProfile;
		const name = claudeImportEditorName(backup.editor);
		if ((backup.settings !== undefined && this._textFiles.isDirty(profile.settingsResource)) || (backup.keybindings !== undefined && this._textFiles.isDirty(profile.keybindingsResource))) {
			this._notifications.info(localize('claudeImportUndoUnsaved', "Save or revert your settings.json and keybindings.json first, then undo the import from {0} again.", name));
			return;
		}
		const restore = async (resource: URI, previous: string | null) => {
			if (previous === null) {
				if (await this._files.exists(resource)) {
					await this._files.del(resource);
				}
			} else {
				await this._files.writeFile(resource, VSBuffer.fromString(previous));
			}
		};
		const failed: string[] = [];
		const attempt = async (label: string, task: () => Promise<void>) => {
			try {
				await task();
			} catch (error) {
				failed.push(`${label}: ${toErrorMessage(error)}`);
			}
		};
		if (backup.settings !== undefined) {
			await attempt('settings.json', () => restore(profile.settingsResource, backup.settings ?? null));
		}
		if (backup.keybindings !== undefined) {
			await attempt('keybindings.json', () => restore(profile.keybindingsResource, backup.keybindings ?? null));
		}
		for (const snippet of backup.snippets) {
			await attempt(snippet.name, () => restore(joinPath(profile.snippetsHome, snippet.name), snippet.previous));
		}
		if (backup.claudeMd) {
			const { appended, created } = backup.claudeMd;
			await attempt(this.userLayerLabel('rules'), async () => {
				const resource = this.userLayerFile('rules');
				const current = await this.readText(resource);
				const text = current === undefined ? undefined : claudeRulesRemove(current, appended, created);
				if (text === undefined) {
					throw new Error(localize('claudeImportUndoRulesGone', "The imported section is no longer in the file. It was left as it is."));
				}
				await (text === null ? this._files.del(resource) : this._files.writeFile(resource, VSBuffer.fromString(text)));
			});
		}
		if (backup.mcp) {
			const { servers, created } = backup.mcp;
			await attempt(this.userLayerLabel('mcp'), async () => {
				const resource = this.userLayerFile('mcp');
				const current = await this.readText(resource);
				if (current === undefined) {
					return;
				}
				const text = claudeMcpUndoText(current, servers, created);
				await (text === null ? this._files.del(resource) : this._files.writeFile(resource, VSBuffer.fromString(text)));
			});
		}
		if (backup.extensions?.length) {
			await attempt(localize('claudeImportUndoExtensions', "extensions"), async () => {
				const ids = new Set(backup.extensions?.map(id => id.toLowerCase()));
				const installed = (await this._extensions.getInstalled()).filter(extension => ids.has(extension.identifier.id.toLowerCase()));
				await this._extensions.uninstallExtensions(installed.map(extension => ({ extension })));
			});
		}
		this._storage.remove(BACKUP_KEY, StorageScope.PROFILE);
		this._onDidChange.fire();
		if (failed.length) {
			this._notifications.error(localize('claudeImportUndoFailed', "Undo of the import from {0} could not restore: {1}", name, failed.join('; ')));
		} else {
			this._notifications.info(localize('claudeImportUndone', "Undid the import from {0}, including the extensions it installed.", name));
		}
	}

	private finish(plan: ClaudeImportPlan, outcome: ClaudeImportOutcome, newProfile?: IUserDataProfile): void {
		this._storage.store(IMPORTED_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
		this._onDidChange.fire();
		const report = claudeImportReport(plan, outcome);
		const name = claudeImportEditorName(plan.editor);
		const failed = (part: ClaudeImportFailure['part']) => outcome.failures.filter(failure => failure.part === part).length;
		const settings = (plan.settings?.add.length ?? 0) + (plan.settings?.replace.length ?? 0) - failed('settings');
		const keybindings = (plan.keybindings?.add.length ?? 0) - failed('keybindings');
		const snippets = (plan.snippets?.copy.length ?? 0) + (plan.snippets?.replace.length ?? 0) - failed('snippets');
		const extensions = (plan.extensions?.install.length ?? 0) - failed('extensions');
		const themes = (plan.themes?.add.length ?? 0) + (plan.themes?.replace.length ?? 0) - failed('themes');
		const rules = (plan.rules?.add.length ?? 0) - failed('rules');
		const mcp = (plan.mcp?.add.length ?? 0) - failed('mcp');
		const skipped = (plan.settings?.skipped.length ?? 0) + (plan.keybindings?.skipped.length ?? 0) + (plan.extensions?.skipped.length ?? 0) + (plan.themes?.skipped.length ?? 0) + (plan.mcp?.skipped.length ?? 0);
		let message: string;
		if (!claudeImportHasChanges(plan)) {
			message = localize('claudeImportNothingNew', "Nothing new to import from {0}. Everything is already in Klawly or was skipped.", name);
		} else if (outcome.failures.length) {
			message = localize('claudeImportDoneWithFailures', "Imported from {0}: {1} settings, {2} keybindings, {3} snippet files, {4} extensions, {5} themes, {6} rules files, {7} MCP servers. {8} items failed and {9} were skipped.", name, settings, keybindings, snippets, extensions, themes, rules, mcp, outcome.failures.length, skipped);
		} else {
			message = localize('claudeImportDone', "Imported from {0}: {1} settings, {2} keybindings, {3} snippet files, {4} extensions, {5} themes, {6} rules files, {7} MCP servers. {8} items were skipped.", name, settings, keybindings, snippets, extensions, themes, rules, mcp, skipped);
		}
		const choices: IPromptChoice[] = [{
			label: localize('claudeImportShowReport', "Show Report"),
			run: () => this._editors.openEditor({ resource: undefined, contents: report, languageId: 'markdown', options: { pinned: true } }),
		}];
		if (newProfile) {
			choices.push({ label: localize('claudeImportSwitchProfile', "Switch to {0}", newProfile.name), run: () => this._profileManagement.switchProfile(newProfile) });
		} else if (claudeImportHasChanges(plan) && this.canUndo) {
			choices.push({ label: localize('claudeImportUndo', "Undo Import"), run: () => this.undo() });
		}
		this._notifications.prompt(outcome.failures.length ? Severity.Warning : Severity.Info, message, choices);
	}
}

/** Detects the editors once the workbench is idle and keeps the palette entries in step. */
export class ClaudeImportContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeImport';

	constructor(
		@IClaudeImportService importService: IClaudeImportService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IUserDataProfileService profiles: IUserDataProfileService,
	) {
		super();
		const vscode = CLAUDE_IMPORT_VSCODE_AVAILABLE.bindTo(contextKeyService);
		const cursor = CLAUDE_IMPORT_CURSOR_AVAILABLE.bindTo(contextKeyService);
		const undo = CLAUDE_IMPORT_UNDO_AVAILABLE.bindTo(contextKeyService);
		const update = () => {
			vscode.set(importService.detected.includes('vscode'));
			cursor.set(importService.detected.includes('cursor'));
			undo.set(importService.canUndo);
		};
		this._register(importService.onDidChange(update));
		// The backup lives in profile storage, so another profile has its own (or none).
		this._register(profiles.onDidChangeCurrentProfile(update));
		update();
		void importService.detect();
	}
}

/** Import from VS Code... and Import from Cursor... in the palette, shown only when that editor is installed, and Undo Import. */
export function registerClaudeImportCommands(): void {
	const category = KLAWLY_CATEGORY;

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: CLAUDE_IMPORT_FROM_VSCODE_COMMAND_ID, title: localize2('claudeImportFromVSCode', "Import from VS Code..."), category, f1: true, precondition: CLAUDE_IMPORT_VSCODE_AVAILABLE });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IClaudeImportService).run('vscode');
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: CLAUDE_IMPORT_FROM_CURSOR_COMMAND_ID, title: localize2('claudeImportFromCursor', "Import from Cursor..."), category, f1: true, precondition: CLAUDE_IMPORT_CURSOR_AVAILABLE });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IClaudeImportService).run('cursor');
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: CLAUDE_UNDO_IMPORT_COMMAND_ID, title: localize2('claudeUndoImport', "Undo Import"), category, f1: true, precondition: CLAUDE_IMPORT_UNDO_AVAILABLE });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IClaudeImportService).undo();
		}
	});
}
