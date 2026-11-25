/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JSONPath, parse, ParseError } from '../../../../base/common/json.js';
import { applyEdits, setProperty } from '../../../../base/common/jsonEdit.js';
import { equals } from '../../../../base/common/objects.js';
import { IProcessEnvironment, OperatingSystem } from '../../../../base/common/platform.js';
import { basename, dirname, extUriBiasedIgnorePathCase, joinPath, normalizePath } from '../../../../base/common/resources.js';
import { posix, win32 } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { OVERRIDE_PROPERTY_REGEX } from '../../../../platform/configuration/common/configurationRegistry.js';
import { EXTENSION_IDENTIFIER_REGEX } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { claudeSettingsFormatting, parseClaudeSettings } from '../../../../platform/claude/common/claudeHooks.js';
import { isClaudeMcpServerName } from '../../../../platform/claude/common/claudeMcpConfig.js';
import { readClaudeUserMcpServers, removeClaudeUserMcpServer } from '../../../../platform/claude/common/claudeUserLayer.js';

/**
 * Import from VS Code and Cursor (phase 22). Everything here is pure or reads
 * through {@link ClaudeImportReader}, which opens only the allowlisted files:
 * settings.json, keybindings.json, snippet files and extension manifests.
 */

export const CLAUDE_IMPORT_FROM_VSCODE_COMMAND_ID = 'claude.importFromVSCode';
export const CLAUDE_IMPORT_FROM_CURSOR_COMMAND_ID = 'claude.importFromCursor';
export const CLAUDE_UNDO_IMPORT_COMMAND_ID = 'claude.undoImport';

export type ClaudeImportEditorId = 'vscode' | 'cursor';

/** Editors the import knows, in the order they are offered. */
export const CLAUDE_IMPORT_EDITORS: readonly ClaudeImportEditorId[] = ['vscode', 'cursor'];

/** Product names are proper nouns and are not translated. */
export function claudeImportEditorName(editor: ClaudeImportEditorId): string {
	return editor === 'vscode' ? 'VS Code' : 'Cursor';
}

export interface ClaudeImportLocations {
	readonly editor: ClaudeImportEditorId;
	/** `Code/User` or `Cursor/User`. The editor counts as installed when it exists. */
	readonly userFolder: URI;
	/** `~/.vscode/extensions` or `~/.cursor/extensions`. */
	readonly extensionsFolder: URI;
	/** The editor's own `User` folder. Differs from {@link userFolder} when the source is a profile (issue 857). */
	readonly storageFolder?: URI;
	/** The workspace folders open in Klawly. Project rules and `mcp.json` files are read from them (issue 857). */
	readonly workspaceFolders?: readonly URI[];
	/** The profile the source is, or undefined for the default profile. */
	readonly profileName?: string;
}

const FOLDER_NAMES: Record<ClaudeImportEditorId, { readonly appData: string; readonly home: string }> = {
	vscode: { appData: 'Code', home: '.vscode' },
	cursor: { appData: 'Cursor', home: '.cursor' },
};

/**
 * Where each editor keeps its user folder: `%APPDATA%` on Windows,
 * `~/Library/Application Support` on macOS, `$XDG_CONFIG_HOME` or `~/.config`
 * on Linux. Extensions live in `~/.vscode/extensions` or `~/.cursor/extensions`.
 */
export function claudeImportLocations(editor: ClaudeImportEditorId, os: OperatingSystem, userHome: URI, env: IProcessEnvironment): ClaudeImportLocations {
	const names = FOLDER_NAMES[editor];
	return {
		editor,
		userFolder: joinPath(appDataFolder(os, userHome, env), names.appData, 'User'),
		extensionsFolder: joinPath(userHome, names.home, 'extensions'),
		storageFolder: joinPath(appDataFolder(os, userHome, env), names.appData, 'User'),
	};
}

function appDataFolder(os: OperatingSystem, userHome: URI, env: IProcessEnvironment): URI {
	if (os === OperatingSystem.Windows) {
		const appData = envValue(env, 'APPDATA');
		if (appData && win32.isAbsolute(appData)) {
			const path = appData.replace(/\\/g, '/');
			return userHome.with({ path: path.startsWith('/') ? path : `/${path}` });
		}
		return joinPath(userHome, 'AppData', 'Roaming');
	}
	if (os === OperatingSystem.Macintosh) {
		return joinPath(userHome, 'Library', 'Application Support');
	}
	const xdg = envValue(env, 'XDG_CONFIG_HOME');
	return xdg && posix.isAbsolute(xdg) ? userHome.with({ path: xdg }) : joinPath(userHome, '.config');
}

/** Environment names are case-insensitive on Windows. */
function envValue(env: IProcessEnvironment, name: string): string | undefined {
	const exact = env[name];
	if (exact) {
		return exact;
	}
	const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name);
	return key ? env[key] : undefined;
}

// --- Allowlist -----------------------------------------------------------------------------

export type ClaudeImportFileKind = 'settings' | 'keybindings' | 'snippet' | 'extensions-index' | 'extension-manifest' | 'profiles' | 'rules' | 'mcp';

const SNIPPET_FILE = /^[^.\\/][^\\/]*\.(?:json|code-snippets)$/i;

/**
 * The only files the import may open (rule 40): the user folder's
 * settings.json and keybindings.json, files directly in its `snippets` folder,
 * the extension folder's extensions.json, and `package.json` directly inside
 * one extension folder. Everything else, such as `state.vscdb`,
 * `globalStorage`, `workspaceStorage` or `Local Storage`, returns undefined.
 */
export function claudeImportFileKind(resource: URI, locations: ClaudeImportLocations): ClaudeImportFileKind | undefined {
	const uri = extUriBiasedIgnorePathCase;
	const target = normalizePath(resource);
	const name = basename(target);
	const folder = dirname(target);
	if (uri.isEqual(target, joinPath(locations.userFolder, 'settings.json'))) {
		return 'settings';
	}
	if (uri.isEqual(target, joinPath(locations.userFolder, 'keybindings.json'))) {
		return 'keybindings';
	}
	if (uri.isEqual(folder, joinPath(locations.userFolder, 'snippets')) && SNIPPET_FILE.test(name)) {
		return 'snippet';
	}
	if (uri.isEqual(target, joinPath(locations.extensionsFolder, 'extensions.json'))) {
		return 'extensions-index';
	}
	if (name.toLowerCase() === 'package.json' && uri.isEqual(dirname(folder), locations.extensionsFolder) && !basename(folder).startsWith('.')) {
		return 'extension-manifest';
	}
	if (uri.isEqual(target, joinPath(locations.storageFolder ?? locations.userFolder, 'globalStorage', 'storage.json'))) {
		return 'profiles';
	}
	if (mcpFiles(locations).some(file => uri.isEqual(target, file))) {
		return 'mcp';
	}
	if (rulesSingleFiles(locations).some(file => uri.isEqual(target, file)) || rulesFolders(locations).some(rules => uri.isEqual(folder, rules) && rulesFileName(locations.editor).test(name))) {
		return 'rules';
	}
	return undefined;
}

const RULES_FILE_CURSOR = /^[^.\\/][^\\/]*\.(?:md|mdc)$/i;
const RULES_FILE_VSCODE = /^[^.\\/][^\\/]*\.instructions\.md$/i;

function rulesFileName(editor: ClaudeImportEditorId): RegExp {
	return editor === 'cursor' ? RULES_FILE_CURSOR : RULES_FILE_VSCODE;
}

/** The editor's own folder in the home folder: `~/.cursor` (the extensions folder's parent). */
function editorHomeFolder(locations: ClaudeImportLocations): URI {
	return dirname(locations.extensionsFolder);
}

/** Folders whose rules files are read: user rules and each workspace's project rules. */
function rulesFolders(locations: ClaudeImportLocations): readonly URI[] {
	const workspaces = locations.workspaceFolders ?? [];
	return locations.editor === 'cursor'
		? [joinPath(editorHomeFolder(locations), 'rules'), ...workspaces.map(folder => joinPath(folder, '.cursor', 'rules'))]
		: [joinPath(locations.userFolder, 'prompts')];
}

/** Single rules files: the project's `.cursorrules` or the instructions file in `.github`. */
function rulesSingleFiles(locations: ClaudeImportLocations): readonly URI[] {
	const workspaces = locations.workspaceFolders ?? [];
	return locations.editor === 'cursor'
		? workspaces.map(folder => joinPath(folder, '.cursorrules'))
		: workspaces.map(folder => joinPath(folder, '.github', 'copilot-instructions.md'));
}

/** The `mcp.json` files: the user's and each workspace's. */
function mcpFiles(locations: ClaudeImportLocations): readonly URI[] {
	const workspaces = locations.workspaceFolders ?? [];
	return locations.editor === 'cursor'
		? [joinPath(editorHomeFolder(locations), 'mcp.json'), ...workspaces.map(folder => joinPath(folder, '.cursor', 'mcp.json'))]
		: [joinPath(locations.userFolder, 'mcp.json'), ...workspaces.map(folder => joinPath(folder, '.vscode', 'mcp.json'))];
}

/** The only folders the import may list: the snippets folder and the extensions folder. */
export function claudeImportFolderAllowed(resource: URI, locations: ClaudeImportLocations): boolean {
	const uri = extUriBiasedIgnorePathCase;
	const target = normalizePath(resource);
	return uri.isEqual(target, joinPath(locations.userFolder, 'snippets')) || uri.isEqual(target, locations.extensionsFolder) || rulesFolders(locations).some(rules => uri.isEqual(target, rules));
}

// --- Reading ---------------------------------------------------------------------------------

/** The file service calls the reader uses. Writes never go through it. */
export type ClaudeImportFiles = Pick<IFileService, 'readFile' | 'resolve'>;

export interface ClaudeImportSnippetFile {
	readonly name: string;
	readonly resource: URI;
}

export interface ClaudeImportExtension {
	/** `publisher.name` as the source editor wrote it. */
	readonly id: string;
	readonly version?: string;
}

export type ClaudeImportThemeKind = 'color' | 'icon' | 'productIcon';

/** A theme an extension of the source editor contributes (issue 857). */
export interface ClaudeImportThemeProvider {
	readonly extensionId: string;
	readonly kind: ClaudeImportThemeKind;
	/** The value the theme setting takes: the theme's `id`, or its label. */
	readonly name: string;
}

/** One rules file of the source editor. `name` is unique within a source and is shown to the user. */
export interface ClaudeImportRulesFile {
	readonly name: string;
	readonly text: string;
}

/** A profile of the source editor: a named one lives under `User/profiles/<location>`. */
export interface ClaudeImportProfile {
	readonly name: string;
	/** The folder name under `profiles`. */
	readonly location: string;
}

/** What one editor has to offer. Settings, keybindings and `mcp.json` are raw JSONC text. */
export interface ClaudeImportSource {
	readonly locations: ClaudeImportLocations;
	readonly settings?: string;
	readonly keybindings?: string;
	readonly snippets: readonly ClaudeImportSnippetFile[];
	readonly extensions: readonly ClaudeImportExtension[];
	/** Theme extensions, read only when the settings name a theme. */
	readonly themeProviders: readonly ClaudeImportThemeProvider[];
	readonly rules: readonly ClaudeImportRulesFile[];
	/** The text of each `mcp.json` found. */
	readonly mcp: readonly string[];
}

const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_EXTENSION_FOLDERS = 1000;
const MAX_RULES_FILES = 50;
const MAX_RULES_CHARS = 200_000;
const THEME_SETTING = /"workbench\.(?:colorTheme|iconTheme|productIconTheme)"/;

/**
 * Reads one editor's importable data. Every read and folder listing checks the
 * allowlist first and throws for anything outside it, so a bug elsewhere cannot
 * open a token store.
 */
export class ClaudeImportReader {

	constructor(
		readonly locations: ClaudeImportLocations,
		private readonly _files: ClaudeImportFiles,
	) { }

	/** Text of an allowlisted file, or undefined when it is missing, too large or unreadable. */
	async readText(resource: URI): Promise<string | undefined> {
		const kind = claudeImportFileKind(resource, this.locations);
		if (!kind) {
			throw new Error(`Import may not read ${resource.toString()}`);
		}
		try {
			const content = await this._files.readFile(resource, { limits: { size: kind === 'extension-manifest' ? MAX_MANIFEST_BYTES : MAX_TEXT_BYTES } });
			return content.value.toString();
		} catch {
			return undefined;
		}
	}

	async collect(): Promise<ClaudeImportSource> {
		const { userFolder } = this.locations;
		const [settings, keybindings, snippets, extensions, rules, mcp] = await Promise.all([
			this.readText(joinPath(userFolder, 'settings.json')),
			this.readText(joinPath(userFolder, 'keybindings.json')),
			this.snippets(),
			this.extensions(),
			this.rules(),
			this.mcp(),
		]);
		const themeProviders = settings !== undefined && THEME_SETTING.test(settings) ? await this.themeProviders() : [];
		return { locations: this.locations, settings, keybindings, snippets, extensions, themeProviders, rules, mcp };
	}

	/**
	 * The editor's profiles from `globalStorage/storage.json`. Only profile names
	 * and folder names are taken from the file; nothing else in it is used
	 * (issue 857). Not part of {@link collect}.
	 */
	async profiles(): Promise<readonly ClaudeImportProfile[]> {
		const text = await this.readText(joinPath(this.locations.storageFolder ?? this.locations.userFolder, 'globalStorage', 'storage.json'));
		return text === undefined ? [] : claudeImportProfilesFromStorage(text);
	}

	private async rules(): Promise<readonly ClaudeImportRulesFile[]> {
		const candidates: { readonly label: string; readonly resource: URI }[] = rulesSingleFiles(this.locations).map(resource => ({ label: basename(resource), resource }));
		for (const folder of rulesFolders(this.locations)) {
			for (const child of await this.list(folder)) {
				if (child.isFile && !child.isSymbolicLink && claudeImportFileKind(child.resource, this.locations) === 'rules') {
					candidates.push({ label: `${basename(folder)}/${child.name}`, resource: child.resource });
				}
			}
		}
		const found: ClaudeImportRulesFile[] = [];
		const names = new Set<string>();
		for (const candidate of candidates.slice(0, MAX_RULES_FILES)) {
			const text = (await this.readText(candidate.resource))?.trim();
			if (!text || text.length > MAX_RULES_CHARS) {
				continue;
			}
			let name = candidate.label;
			for (let count = 2; names.has(name); count++) {
				name = `${candidate.label} (${count})`;
			}
			names.add(name);
			found.push({ name, text });
		}
		return found;
	}

	private async mcp(): Promise<readonly string[]> {
		const texts = await Promise.all(mcpFiles(this.locations).map(file => this.readText(file)));
		return texts.filter((text): text is string => text !== undefined);
	}

	private async themeProviders(): Promise<readonly ClaudeImportThemeProvider[]> {
		const folders = (await this.list(this.locations.extensionsFolder))
			.filter(child => child.isDirectory && !child.name.startsWith('.'))
			.slice(0, MAX_EXTENSION_FOLDERS);
		const manifests = await Promise.all(folders.map(folder => this.readText(joinPath(folder.resource, 'package.json'))));
		return manifests.flatMap(manifest => manifest === undefined ? [] : claudeImportThemeProvidersFromManifest(manifest));
	}

	private async list(folder: URI): Promise<readonly IFileStat[]> {
		if (!claudeImportFolderAllowed(folder, this.locations)) {
			throw new Error(`Import may not list ${folder.toString()}`);
		}
		try {
			return (await this._files.resolve(folder)).children ?? [];
		} catch {
			return [];
		}
	}

	private async snippets(): Promise<readonly ClaudeImportSnippetFile[]> {
		const children = await this.list(joinPath(this.locations.userFolder, 'snippets'));
		return children
			.filter(child => child.isFile && !child.isSymbolicLink && SNIPPET_FILE.test(child.name))
			.map(child => ({ name: child.name, resource: child.resource }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	private async extensions(): Promise<readonly ClaudeImportExtension[]> {
		const index = await this.readText(joinPath(this.locations.extensionsFolder, 'extensions.json'));
		const fromIndex = index === undefined ? undefined : claudeImportExtensionsFromIndex(index);
		if (fromIndex) {
			return fromIndex;
		}
		const folders = (await this.list(this.locations.extensionsFolder))
			.filter(child => child.isDirectory && !child.name.startsWith('.'))
			.slice(0, MAX_EXTENSION_FOLDERS);
		const manifests = await Promise.all(folders.map(folder => this.readText(joinPath(folder.resource, 'package.json'))));
		const found: ClaudeImportExtension[] = [];
		for (const manifest of manifests) {
			const extension = manifest === undefined ? undefined : claudeImportExtensionFromManifest(manifest);
			if (extension) {
				found.push(extension);
			}
		}
		return dedupeExtensions(found);
	}
}

/** IDs from an extension folder's `extensions.json`. Undefined when it is not the expected array. */
export function claudeImportExtensionsFromIndex(text: string): readonly ClaudeImportExtension[] | undefined {
	const errors: ParseError[] = [];
	const value: unknown = parse(text, errors, { allowTrailingComma: true });
	if (errors.length || !Array.isArray(value)) {
		return undefined;
	}
	const found: ClaudeImportExtension[] = [];
	for (const entry of value) {
		const identifier = isRecord(entry) && isRecord(entry.identifier) ? entry.identifier : undefined;
		const id = typeof identifier?.id === 'string' ? identifier.id : undefined;
		if (id && EXTENSION_IDENTIFIER_REGEX.test(id)) {
			found.push({ id, version: isRecord(entry) && typeof entry.version === 'string' ? entry.version : undefined });
		}
	}
	return dedupeExtensions(found);
}

/** `publisher.name` and version from one extension's `package.json`. */
export function claudeImportExtensionFromManifest(text: string): ClaudeImportExtension | undefined {
	const errors: ParseError[] = [];
	const value: unknown = parse(text, errors, { allowTrailingComma: true });
	if (errors.length || !isRecord(value) || typeof value.publisher !== 'string' || typeof value.name !== 'string') {
		return undefined;
	}
	const id = `${value.publisher}.${value.name}`;
	return EXTENSION_IDENTIFIER_REGEX.test(id) ? { id, version: typeof value.version === 'string' ? value.version : undefined } : undefined;
}

/** The themes one extension's `package.json` contributes. Labels that are `%placeholders%` are left out. */
export function claudeImportThemeProvidersFromManifest(text: string): readonly ClaudeImportThemeProvider[] {
	const extension = claudeImportExtensionFromManifest(text);
	const errors: ParseError[] = [];
	const value: unknown = parse(text, errors, { allowTrailingComma: true });
	const contributes = !errors.length && isRecord(value) && isRecord(value.contributes) ? value.contributes : undefined;
	if (!extension || !contributes) {
		return [];
	}
	const found: ClaudeImportThemeProvider[] = [];
	for (const [key, kind] of [['themes', 'color'], ['iconThemes', 'icon'], ['productIconThemes', 'productIcon']] as const) {
		const entries = contributes[key];
		for (const entry of Array.isArray(entries) ? entries : []) {
			const name = isRecord(entry) ? (typeof entry.id === 'string' ? entry.id : typeof entry.label === 'string' ? entry.label : undefined) : undefined;
			if (name && !name.startsWith('%')) {
				found.push({ extensionId: extension.id, kind, name });
			}
		}
	}
	return found;
}

/**
 * The profiles listed in a `storage.json`: `userDataProfiles` entries with a
 * name and a plain folder name. Nothing else in the file is used, and a
 * `location` with a path separator is dropped so it can't leave `profiles`.
 */
export function claudeImportProfilesFromStorage(text: string): readonly ClaudeImportProfile[] {
	const errors: ParseError[] = [];
	const value: unknown = parse(text, errors, { allowTrailingComma: true });
	const entries = !errors.length && isRecord(value) && Array.isArray(value.userDataProfiles) ? value.userDataProfiles : [];
	const found: ClaudeImportProfile[] = [];
	for (const entry of entries) {
		if (isRecord(entry) && typeof entry.name === 'string' && entry.name.trim() && entry.name.length <= 100 && typeof entry.location === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(entry.location)) {
			found.push({ name: entry.name.trim(), location: entry.location });
		}
	}
	return found.slice(0, 100);
}

/** The locations of a named profile: its own settings, keybindings, snippets and `mcp.json`; extensions are shared. */
export function claudeImportProfileLocations(base: ClaudeImportLocations, profile: ClaudeImportProfile | undefined): ClaudeImportLocations {
	if (!profile) {
		return base;
	}
	const storageFolder = base.storageFolder ?? base.userFolder;
	return { ...base, storageFolder, userFolder: joinPath(storageFolder, 'profiles', profile.location), profileName: profile.name };
}

function dedupeExtensions(extensions: readonly ClaudeImportExtension[]): readonly ClaudeImportExtension[] {
	const seen = new Set<string>();
	return extensions.filter(extension => {
		const key = extension.id.toLowerCase();
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

// --- Skip rules ------------------------------------------------------------------------------

export type ClaudeImportSkipReason =
	| 'cursor'
	| 'ai'
	| 'klawly'
	| 'updates'
	| 'telemetry'
	| 'workspace-trust'
	| 'executable'
	| 'terminal-input'
	| 'cursor-extension'
	| 'microsoft-only'
	| 'installed'
	| 'not-found'
	| 'no-gallery'
	| 'gallery-unreachable'
	| 'theme-not-installed'
	| 'mcp-invalid';

export interface ClaudeImportSkip {
	readonly item: string;
	readonly reason: ClaudeImportSkipReason;
}

/** Cursor's own settings. */
const CURSOR_SETTING_PREFIXES = ['cursor.', 'cursorai.', 'cursorpyright.', 'anysphere.', 'aipopup.'];
/** AI settings with no Klawly equivalent: Copilot, VS Code chat and MCP, other Claude integrations. */
const AI_SETTING_PREFIXES = ['github.copilot', 'chat.', 'inlinechat.', 'mcp.', 'claudecode.', 'claude-code.'];
const AI_SETTING_KEYS = ['mcp'];

/**
 * Settings that start a program or shell. An imported value would run a binary
 * chosen for another editor, so the user sets it again in Klawly.
 * `terminal.integrated.shellIntegration.*` is not here: it only toggles features.
 */
const EXECUTABLE_SETTING_PREFIXES = [
	'terminal.integrated.profiles.',
	'terminal.integrated.defaultprofile.',
	'terminal.integrated.automationprofile.',
	'terminal.integrated.shell.',
	'terminal.integrated.shellargs.',
	'terminal.integrated.automationshell.',
	'terminal.external.',
];
/** `typescript.tsdk` loads a TypeScript server from that folder. */
const EXECUTABLE_SETTING_KEYS = ['git.path', 'typescript.tsdk'];
/** A last key segment that names a program: `x.path`, `x.executablePath`, `x.serverPath`, `x.runtimeExecutable`. */
const EXECUTABLE_SETTING_SUFFIX = /\.(?:path|[a-z0-9]*(?:executable|executablepath|exepath|binarypath|binpath|serverpath|interpreterpath|nodepath|pythonpath))$/;

function isExecutableSetting(lower: string): boolean {
	return EXECUTABLE_SETTING_KEYS.includes(lower)
		|| EXECUTABLE_SETTING_PREFIXES.some(prefix => lower.startsWith(prefix))
		|| EXECUTABLE_SETTING_SUFFIX.test(lower);
}

/**
 * Why a setting is not imported, or undefined to import it. Besides Cursor and
 * AI keys, this keeps Klawly's own `claude.*` keys, its updater, its
 * telemetry default (off) and Workspace Trust, which guards the agent.
 */
export function claudeImportSettingSkipReason(key: string): ClaudeImportSkipReason | undefined {
	const lower = key.toLowerCase();
	const startsWith = (prefixes: readonly string[]) => prefixes.some(prefix => lower.startsWith(prefix));
	if (lower === 'cursor' || startsWith(CURSOR_SETTING_PREFIXES)) {
		return 'cursor';
	}
	if (AI_SETTING_KEYS.includes(lower) || startsWith(AI_SETTING_PREFIXES)) {
		return 'ai';
	}
	if (lower.startsWith('claude.')) {
		return 'klawly';
	}
	if (lower.startsWith('update.')) {
		return 'updates';
	}
	if (lower.startsWith('telemetry.')) {
		return 'telemetry';
	}
	if (lower.startsWith('security.workspace.trust.')) {
		return 'workspace-trust';
	}
	if (isExecutableSetting(lower)) {
		return 'executable';
	}
	return undefined;
}

/** Cursor's own commands. Only applied to Cursor's keybindings, so VS Code commands such as `cursorDown` are never matched. */
const CURSOR_COMMAND_PREFIXES = ['cursor.', 'cursorai.', 'aichat.', 'aipopup.', 'composer.', 'anysphere.'];
/** AI commands with no Klawly equivalent. */
const AI_COMMAND_PREFIXES = ['github.copilot', 'workbench.action.chat.', 'chat.', 'inlinechat.', 'workbench.action.inlinechat', 'claude-code.', 'claude-vscode.'];

/** Why a keybinding's command is not imported, or undefined to import it. A leading `-` (removal) is ignored. */
export function claudeImportCommandSkipReason(command: string, editor: ClaudeImportEditorId): ClaudeImportSkipReason | undefined {
	const lower = command.replace(/^-/, '').toLowerCase();
	if (editor === 'cursor' && CURSOR_COMMAND_PREFIXES.some(prefix => lower.startsWith(prefix))) {
		return 'cursor';
	}
	if (AI_COMMAND_PREFIXES.some(prefix => lower.startsWith(prefix))) {
		return 'ai';
	}
	if (lower.startsWith('claude.') || lower.startsWith('klawly.')) {
		return 'klawly';
	}
	return undefined;
}

const TERMINAL_SEQUENCE_COMMAND = 'workbench.action.terminal.sendsequence';
const RUN_COMMANDS_COMMAND = 'runcommands';

/**
 * Why a whole keybinding entry is not imported, or undefined to import it. On
 * top of {@link claudeImportCommandSkipReason}, a binding that types text into
 * the terminal (`workbench.action.terminal.sendSequence`, also inside
 * `runCommands`) is skipped: one key press would run whatever the text says.
 * Removing such a binding (`-` prefix) runs nothing and is still imported.
 */
function claudeImportKeybindingSkipReason(entry: Record<string, unknown>, editor: ClaudeImportEditorId): ClaudeImportSkipReason | undefined {
	const command = String(entry.command);
	const reason = claudeImportCommandSkipReason(command, editor);
	if (reason || command.startsWith('-')) {
		return reason;
	}
	return sendsTerminalText(command, entry.args, 0) ? 'terminal-input' : undefined;
}

function sendsTerminalText(command: string, args: unknown, depth: number): boolean {
	const lower = command.toLowerCase();
	if (lower === TERMINAL_SEQUENCE_COMMAND) {
		return true;
	}
	if (lower !== RUN_COMMANDS_COMMAND || depth > 4) {
		return false;
	}
	const steps = isRecord(args) ? args.commands : undefined;
	if (!Array.isArray(steps)) {
		return false;
	}
	return steps.some(step => {
		if (typeof step === 'string') {
			return sendsTerminalText(step, undefined, depth + 1);
		}
		return isRecord(step) && typeof step.command === 'string' && sendsTerminalText(step.command, step.args, depth + 1);
	});
}

/** Extensions published only to the Visual Studio Marketplace under Microsoft's license. */
const MICROSOFT_ONLY_EXTENSIONS: readonly (string | RegExp)[] = [
	/^ms-vscode-remote\./,
	'ms-vscode.remote-explorer',
	'ms-vscode.remote-server',
	'ms-vscode.cpptools',
	'ms-vscode.cpptools-extension-pack',
	'ms-python.vscode-pylance',
	'ms-dotnettools.csdevkit',
	'ms-dotnettools.vscodeintellicode-csharp',
	/^github\.copilot/,
];

/** Why an extension is skipped before the gallery is asked, or undefined. */
export function claudeImportExtensionSkipReason(id: string): ClaudeImportSkipReason | undefined {
	const lower = id.toLowerCase();
	if (lower.startsWith('anysphere.')) {
		return 'cursor-extension';
	}
	if (MICROSOFT_ONLY_EXTENSIONS.some(rule => typeof rule === 'string' ? rule === lower : rule.test(lower))) {
		return 'microsoft-only';
	}
	return undefined;
}

export function claudeImportSkipReasonLabel(reason: ClaudeImportSkipReason): string {
	switch (reason) {
		case 'cursor': return localize('claudeImportSkipCursor', "Cursor feature with no Klawly equivalent");
		case 'ai': return localize('claudeImportSkipAI', "AI feature with no Klawly equivalent");
		case 'klawly': return localize('claudeImportSkipKlawly', "Klawly's own setting; set it in Klawly");
		case 'updates': return localize('claudeImportSkipUpdates', "Applies to the other editor's updates");
		case 'telemetry': return localize('claudeImportSkipTelemetry', "Klawly keeps telemetry off");
		case 'workspace-trust': return localize('claudeImportSkipTrust', "Workspace Trust protects the agent; review it in Klawly");
		case 'executable': return localize('claudeImportSkipExecutable', "Starts a program or shell; set it in Klawly after checking it");
		case 'terminal-input': return localize('claudeImportSkipTerminalInput', "Types text into the terminal; add it in Klawly after checking it");
		case 'cursor-extension': return localize('claudeImportSkipCursorExtension', "Cursor's own extension");
		case 'microsoft-only': return localize('claudeImportSkipMicrosoft', "Not on Open VSX (Microsoft license)");
		case 'installed': return localize('claudeImportSkipInstalled', "Already installed");
		case 'not-found': return localize('claudeImportSkipNotFound', "Not found in the extension gallery");
		case 'no-gallery': return localize('claudeImportSkipNoGallery', "No extension gallery is configured");
		case 'gallery-unreachable': return localize('claudeImportSkipUnreachable', "The extension gallery could not be reached");
		case 'theme-not-installed': return localize('claudeImportSkipTheme', "Theme not installed in Klawly, and no extension of the other editor provides it");
		case 'mcp-invalid': return localize('claudeImportSkipMcp', "Not a valid MCP server entry");
	}
}

// --- Plans -----------------------------------------------------------------------------------

/** `source`: the other editor's file has errors. `target`: Klawly's has errors. `unsaved`: Klawly's is open with unsaved changes. */
export type ClaudeImportInvalid = 'source' | 'target' | 'unsaved';

export interface ClaudeImportSettingValue {
	/** Shown to the user: `editor.fontSize`, or `[python] editor.tabSize`. */
	readonly label: string;
	readonly path: JSONPath;
	readonly value: unknown;
	/** Themes only: the extension to install from the gallery before this value is written. */
	readonly needsExtension?: string;
}

/** Theme settings: imported as their own part, and mapped to the themes Klawly has (issue 857). */
const THEME_SETTINGS: Readonly<Record<string, ClaudeImportThemeKind>> = {
	'workbench.colortheme': 'color',
	'workbench.preferreddarkcolortheme': 'color',
	'workbench.preferredlightcolortheme': 'color',
	'workbench.preferredhighcontrastcolortheme': 'color',
	'workbench.preferredhighcontrastlightcolortheme': 'color',
	'workbench.icontheme': 'icon',
	'workbench.producticontheme': 'productIcon',
};

function themeSettingKind(key: string): ClaudeImportThemeKind | undefined {
	return hasOwn(THEME_SETTINGS, key.toLowerCase()) ? THEME_SETTINGS[key.toLowerCase()] : undefined;
}

/**
 * How imported values meet the profile (issue 549). `keep` only fills in what
 * is not set (the phase 22 behavior). `overwrite` replaces values that differ,
 * each one can be kept in the item picker. `profile` imports into a new
 * profile and leaves the current one untouched.
 */
export type ClaudeImportMode = 'keep' | 'overwrite' | 'profile';

/** A setting Klawly already sets to another value, replaced in `overwrite` mode. */
export interface ClaudeImportSettingReplace extends ClaudeImportSettingValue {
	readonly current: unknown;
}

export interface ClaudeSettingsImportPlan {
	readonly add: readonly ClaudeImportSettingValue[];
	/** Values Klawly sets differently, to replace. Only in `overwrite` mode. */
	readonly replace: readonly ClaudeImportSettingReplace[];
	/** Keys already set in Klawly (in `overwrite` mode: to the same value). They are not written. */
	readonly kept: readonly string[];
	readonly skipped: readonly ClaudeImportSkip[];
	/** Why nothing is added: a file could not be parsed, or Klawly's file has unsaved changes. */
	readonly invalid?: ClaudeImportInvalid;
}

/**
 * Settings from `sourceText` that Klawly's `targetText` does not set yet, and
 * in `overwrite` mode the ones it sets to another value. Language blocks such
 * as `[python]` merge key by key.
 */
export function planClaudeSettingsImport(sourceText: string, targetText: string, mode: ClaudeImportMode = 'keep', scope: 'settings' | 'themes' = 'settings'): ClaudeSettingsImportPlan {
	const source = parseObject(sourceText);
	if (!source) {
		return { add: [], replace: [], kept: [], skipped: [], invalid: 'source' };
	}
	const target = parseObject(targetText);
	if (!target) {
		return { add: [], replace: [], kept: [], skipped: [], invalid: 'target' };
	}
	const add: ClaudeImportSettingValue[] = [];
	const replace: ClaudeImportSettingReplace[] = [];
	const kept: string[] = [];
	const skipped: ClaudeImportSkip[] = [];
	const setAlready = (label: string, path: JSONPath, value: unknown, current: unknown) => {
		if (mode === 'overwrite' && !equals(value, current)) {
			replace.push({ label, path, value, current });
		} else {
			kept.push(label);
		}
	};
	for (const [key, value] of Object.entries(source)) {
		if ((themeSettingKind(key) !== undefined) !== (scope === 'themes')) {
			continue;
		}
		const reason = claudeImportSettingSkipReason(key);
		if (reason) {
			skipped.push({ item: key, reason });
			continue;
		}
		const existing = hasOwn(target, key) ? target[key] : undefined;
		if (OVERRIDE_PROPERTY_REGEX.test(key) && isRecord(value) && (existing === undefined || isRecord(existing))) {
			for (const [inner, innerValue] of Object.entries(value)) {
				const label = `${key} ${inner}`;
				const innerReason = claudeImportSettingSkipReason(inner);
				if (innerReason) {
					skipped.push({ item: label, reason: innerReason });
				} else if (existing && hasOwn(existing, inner)) {
					setAlready(label, [key, inner], innerValue, existing[inner]);
				} else {
					add.push({ label, path: [key, inner], value: innerValue });
				}
			}
			continue;
		}
		if (hasOwn(target, key)) {
			setAlready(key, [key], value, target[key]);
		} else {
			add.push({ label: key, path: [key], value });
		}
	}
	return { add, replace, kept, skipped };
}

export interface ClaudeKeybindingsImportPlan {
	/** Entries to append, exactly as the source wrote them (args included). */
	readonly add: readonly Record<string, unknown>[];
	/** Entries Klawly already has with the same key, command and when clause. */
	readonly existing: number;
	readonly skipped: readonly ClaudeImportSkip[];
	readonly invalid?: ClaudeImportInvalid;
}

/** Short label for a keybinding entry: `ctrl+k → command`. */
export function claudeKeybindingLabel(entry: Record<string, unknown>): string {
	return `${String(entry.key)} → ${String(entry.command)}`;
}

/**
 * The identity used to find duplicates: key (case, spacing and modifier order
 * ignored), command and when clause (spacing ignored).
 */
export function claudeKeybindingIdentity(entry: Record<string, unknown>): string | undefined {
	if (typeof entry.key !== 'string' || typeof entry.command !== 'string' || !entry.key.trim() || !entry.command) {
		return undefined;
	}
	const key = entry.key.trim().toLowerCase().split(/\s+/).map(chord => {
		const parts = chord.split('+');
		const last = parts.pop() ?? '';
		return [...parts.sort(), last].join('+');
	}).join(' ');
	const when = typeof entry.when === 'string' ? entry.when.replace(/\s+/g, '') : '';
	return JSON.stringify([key, entry.command, when]);
}

/** Keybindings from `sourceText` that Klawly's `targetText` does not have yet. */
export function planClaudeKeybindingsImport(sourceText: string, targetText: string, editor: ClaudeImportEditorId): ClaudeKeybindingsImportPlan {
	const source = parseArray(sourceText);
	if (!source) {
		return { add: [], existing: 0, skipped: [], invalid: 'source' };
	}
	const target = parseArray(targetText);
	if (!target) {
		return { add: [], existing: 0, skipped: [], invalid: 'target' };
	}
	const seen = new Set<string>();
	for (const entry of target) {
		const identity = isRecord(entry) ? claudeKeybindingIdentity(entry) : undefined;
		if (identity) {
			seen.add(identity);
		}
	}
	const add: Record<string, unknown>[] = [];
	const skipped: ClaudeImportSkip[] = [];
	let existing = 0;
	for (const entry of source) {
		const identity = isRecord(entry) ? claudeKeybindingIdentity(entry) : undefined;
		if (!identity || !isRecord(entry)) {
			continue;
		}
		const reason = claudeImportKeybindingSkipReason(entry, editor);
		if (reason) {
			skipped.push({ item: claudeKeybindingLabel(entry), reason });
		} else if (seen.has(identity)) {
			existing++;
		} else {
			seen.add(identity);
			add.push(entry);
		}
	}
	return { add, existing, skipped };
}

export interface ClaudeSnippetsImportPlan {
	readonly copy: readonly ClaudeImportSnippetFile[];
	/** Snippet files Klawly has under the same name, to replace. Only in `overwrite` mode. */
	readonly replace: readonly ClaudeImportSnippetFile[];
	/** Snippet files Klawly already has under the same name, left as they are. */
	readonly kept: readonly string[];
}

export function planClaudeSnippetsImport(source: readonly ClaudeImportSnippetFile[], existingNames: readonly string[], mode: ClaudeImportMode = 'keep'): ClaudeSnippetsImportPlan {
	const existing = new Map(existingNames.map(name => [name.toLowerCase(), name]));
	const copy: ClaudeImportSnippetFile[] = [];
	const replace: ClaudeImportSnippetFile[] = [];
	const kept: string[] = [];
	for (const file of source) {
		const current = existing.get(file.name.toLowerCase());
		if (current === undefined) {
			copy.push(file);
		} else if (mode === 'overwrite') {
			// Written under Klawly's own spelling, so the file is replaced, not doubled on a case-sensitive disk.
			replace.push({ name: current, resource: file.resource });
		} else {
			kept.push(file.name);
		}
	}
	return { copy, replace, kept };
}

export interface ClaudeExtensionsImportPlan {
	readonly install: readonly ClaudeImportExtension[];
	readonly skipped: readonly ClaudeImportSkip[];
}

/** Extensions worth asking the gallery about: not skipped by rule and not installed. */
export function claudeImportExtensionCandidates(found: readonly ClaudeImportExtension[], installedIds: ReadonlySet<string>): readonly ClaudeImportExtension[] {
	return found.filter(extension => !claudeImportExtensionSkipReason(extension.id) && !installedIds.has(extension.id.toLowerCase()));
}

/**
 * `installedIds` and the gallery's IDs are lower case. `gallery` is the set of
 * IDs the gallery returned, or why it could not be asked.
 */
export function planClaudeExtensionsImport(found: readonly ClaudeImportExtension[], installedIds: ReadonlySet<string>, gallery: ReadonlySet<string> | 'no-gallery' | 'gallery-unreachable'): ClaudeExtensionsImportPlan {
	const install: ClaudeImportExtension[] = [];
	const skipped: ClaudeImportSkip[] = [];
	for (const extension of found) {
		const id = extension.id.toLowerCase();
		const reason = claudeImportExtensionSkipReason(id)
			?? (installedIds.has(id) ? 'installed' : typeof gallery === 'string' ? gallery : !gallery.has(id) ? 'not-found' : undefined);
		if (reason) {
			skipped.push({ item: extension.id, reason });
		} else {
			install.push(extension);
		}
	}
	return { install, skipped };
}

// --- Themes (issue 857) ------------------------------------------------------------------------

export interface ClaudeThemeEnvironment {
	/** Lower-case ids and labels of the themes Klawly has, by kind. */
	readonly installed: Readonly<Record<ClaudeImportThemeKind, ReadonlySet<string>>>;
	/** Themes the source editor's extensions contribute. */
	readonly providers: readonly ClaudeImportThemeProvider[];
	/** Lower-case IDs of the extensions Klawly has installed. */
	readonly installedExtensions: ReadonlySet<string>;
	/** The IDs the gallery has, or why it could not be asked. */
	readonly gallery: Pick<ReadonlySet<string>, 'has'> | 'no-gallery' | 'gallery-unreachable';
}

/**
 * Theme settings of `sourceText` mapped to Klawly's themes: a theme Klawly has
 * is written as it is; one that only an extension of the other editor provides
 * is written together with an extension to install from the gallery
 * (`needsExtension`); any other theme is skipped with its reason, so a theme is
 * never dropped without a word.
 */
export function planClaudeThemesImport(sourceText: string, targetText: string, mode: ClaudeImportMode, env: ClaudeThemeEnvironment): ClaudeSettingsImportPlan {
	const base = planClaudeSettingsImport(sourceText, targetText, mode, 'themes');
	const skipped: ClaudeImportSkip[] = [...base.skipped];
	const resolve = <T extends ClaudeImportSettingValue>(entry: T): T | undefined => {
		const kind = themeSettingKind(String(entry.path[entry.path.length - 1]));
		const name = typeof entry.value === 'string' ? entry.value : undefined;
		const item = `${entry.label} (${name ?? claudeImportValueLabel(entry.value)})`;
		if (!kind || !name) {
			skipped.push({ item, reason: 'theme-not-installed' });
			return undefined;
		}
		const lower = name.toLowerCase();
		if (env.installed[kind].has(lower)) {
			return entry;
		}
		const provider = env.providers.find(candidate => candidate.kind === kind && candidate.name.toLowerCase() === lower);
		const extensionId = provider?.extensionId.toLowerCase();
		const reason: ClaudeImportSkipReason | undefined = !provider || !extensionId ? 'theme-not-installed'
			: claudeImportExtensionSkipReason(extensionId)
			?? (env.installedExtensions.has(extensionId) ? 'theme-not-installed' : typeof env.gallery === 'string' ? env.gallery : !env.gallery.has(extensionId) ? 'not-found' : undefined);
		if (reason) {
			skipped.push({ item, reason });
			return undefined;
		}
		return { ...entry, needsExtension: provider?.extensionId };
	};
	const add = base.add.map(resolve).filter(entry => !!entry);
	const replace = base.replace.map(resolve).filter(entry => !!entry);
	return { ...base, add, replace, skipped };
}

/** The extensions a themes plan needs from the gallery, without repeats. */
export function claudeImportThemeExtensions(plan: ClaudeSettingsImportPlan): readonly string[] {
	return [...new Set([...plan.add, ...plan.replace].flatMap(entry => entry.needsExtension ? [entry.needsExtension] : []))];
}

// --- Rules as CLAUDE.md (issue 857) ------------------------------------------------------------

/**
 * Rules files that Klawly's `CLAUDE.md` does not hold yet. `target` is the text
 * of `CLAUDE.md` before the import, or undefined when the file does not exist.
 */
export interface ClaudeRulesImportPlan {
	readonly add: readonly ClaudeImportRulesFile[];
	/** Files whose text is already in CLAUDE.md. */
	readonly kept: readonly string[];
	readonly target?: string;
}

export function planClaudeRulesImport(files: readonly ClaudeImportRulesFile[], target: string | undefined): ClaudeRulesImportPlan {
	const add: ClaudeImportRulesFile[] = [];
	const kept: string[] = [];
	for (const file of files) {
		if (target?.includes(file.text)) {
			kept.push(file.name);
		} else {
			add.push(file);
		}
	}
	return { add, kept, target };
}

/** A rules file without the front matter Cursor puts in `.mdc` files. */
export function claudeImportRulesBody(text: string): string {
	return text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '').trim();
}

/**
 * The text appended to CLAUDE.md: one marked section with a heading per file.
 * Empty when there is nothing to add. Undo removes exactly this text.
 */
export function claudeRulesAppendix(editor: ClaudeImportEditorId, plan: ClaudeRulesImportPlan): string {
	if (!plan.add.length) {
		return '';
	}
	const name = claudeImportEditorName(editor);
	const block = [
		`<!-- klawly-import:begin ${name} -->`,
		`## ${localize('claudeImportRulesHeading', "Rules imported from {0}", name)}`,
		'',
		...plan.add.flatMap(file => [`### ${file.name}`, '', file.text, '']),
		'<!-- klawly-import:end -->',
	].join('\n');
	const target = plan.target ?? '';
	const lead = !target.trim() || target.endsWith('\n\n') ? '' : target.endsWith('\n') ? '\n' : '\n\n';
	return `${lead}${block}\n`;
}

/**
 * CLAUDE.md without what the import appended. Undefined when that text is no
 * longer there (the file was edited since), so nothing is guessed; null when
 * the import created the file and nothing else is left in it.
 */
export function claudeRulesRemove(current: string, appended: string, created: boolean): string | null | undefined {
	const index = appended ? current.lastIndexOf(appended) : -1;
	if (index < 0) {
		return undefined;
	}
	const text = current.slice(0, index) + current.slice(index + appended.length);
	return created && !text.trim() ? null : text;
}

// --- MCP servers (issue 857) -------------------------------------------------------------------

const MAX_MCP_SERVERS = 100;
const SECRET_KEY = /key|token|secret|passw(?:or)?d|pwd|auth|credential|bearer|cookie|session|signature/i;
const SECRET_VALUES: readonly RegExp[] = [
	/^sk-/i, /^gh[pousr]_/, /^github_pat_/, /^xox[abposr]-/, /^AKIA[0-9A-Z]{8,}/, /^eyJ[\w-]+\.[\w-]+/,
	/\bbearer\s+\S+/i, /\bbasic\s+[A-Za-z0-9+/=]{8,}/i,
	/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_\-+=]{32,}$/,
];

function looksSecret(value: string): boolean {
	return SECRET_VALUES.some(pattern => pattern.test(value.trim()));
}

/** `${NAME}`: Claude Code fills it from the environment when it starts the server. */
function mcpPlaceholder(source: string): string {
	let name = source.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase().slice(0, 64) || 'VALUE';
	if (/^\d/.test(name)) {
		name = `MCP_${name}`;
	}
	return `\${${name}}`;
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function sanitizeMcpArgs(args: readonly string[], leftOut: string[]): string[] {
	const result: string[] = [];
	let flag: string | undefined;
	args.forEach((arg, index) => {
		if (flag !== undefined) {
			const waiting = flag;
			flag = undefined;
			if (!arg.startsWith('-')) {
				result.push(mcpPlaceholder(waiting));
				leftOut.push(`args ${waiting}`);
				return;
			}
		}
		const assignment = /^(-{1,2}[A-Za-z0-9][\w.-]*)=([\s\S]*)$/.exec(arg);
		const header = /^([A-Za-z0-9-]+):\s*\S/.exec(arg);
		if (assignment) {
			if (SECRET_KEY.test(assignment[1]) || looksSecret(assignment[2])) {
				result.push(`${assignment[1]}=${mcpPlaceholder(assignment[1])}`);
				leftOut.push(`args ${assignment[1]}`);
				return;
			}
		} else if (/^-{1,2}[A-Za-z0-9][\w.-]*$/.test(arg)) {
			if (SECRET_KEY.test(arg)) {
				flag = arg;
			}
		} else if (!arg.startsWith('-') && (looksSecret(arg) || header && SECRET_KEY.test(header[1]))) {
			result.push(mcpPlaceholder(`arg ${index + 1}`));
			leftOut.push(`args[${index}]`);
			return;
		}
		result.push(arg);
	});
	return result;
}

function sanitizeMcpUrl(raw: string, leftOut: string[]): string | undefined {
	if (raw.length > 2000 || !/^https?:\/\/[^\s]+$/i.test(raw)) {
		return undefined;
	}
	let rest = raw;
	const userinfo = /^(https?:\/\/)[^/?#@]*@/i.exec(rest);
	if (userinfo) {
		rest = userinfo[1] + rest.slice(userinfo[0].length);
		leftOut.push('url credentials');
	}
	const hash = rest.indexOf('#');
	if (hash >= 0) {
		rest = rest.slice(0, hash);
	}
	const question = rest.indexOf('?');
	const head = question >= 0 ? rest.slice(0, question) : rest;
	const query = question >= 0 ? rest.slice(question + 1) : '';
	const parts = /^(https?:\/\/[^/]*)(.*)$/i.exec(head);
	if (!parts) {
		return undefined;
	}
	const path = parts[2].split('/').map(segment => {
		if (segment && looksSecret(safeDecode(segment))) {
			leftOut.push('url path');
			return mcpPlaceholder('url token');
		}
		return segment;
	}).join('/');
	const params = query.split('&').filter(Boolean).map(pair => {
		const equals = pair.indexOf('=');
		const key = equals >= 0 ? pair.slice(0, equals) : pair;
		if (equals >= 0 && (SECRET_KEY.test(safeDecode(key)) || looksSecret(safeDecode(pair.slice(equals + 1))))) {
			leftOut.push(`url ${key}`);
			return `${key}=${mcpPlaceholder(key)}`;
		}
		return pair;
	});
	return parts[1] + path + (params.length ? `?${params.join('&')}` : '');
}

const MCP_KNOWN_FIELDS = ['type', 'command', 'args', 'env', 'envFile', 'url', 'headers'];

/**
 * One MCP server as Klawly writes it, from an entry of the other editor's
 * `mcp.json` (untrusted: the shape is checked and unknown fields are dropped).
 * Only `type`, `command`, `args` and `url` come from the file. Every value of
 * `env` and `headers`, and anything in `args` or the URL that looks like a key
 * or token, is replaced by a `${NAME}` placeholder the user fills in; `leftOut`
 * says which. Undefined when the entry is not a usable server.
 */
export function claudeImportMcpEntry(config: unknown): { readonly entry: Record<string, unknown>; readonly leftOut: readonly string[] } | undefined {
	if (!isRecord(config)) {
		return undefined;
	}
	const command = typeof config.command === 'string' ? config.command.trim() : '';
	const url = typeof config.url === 'string' ? config.url.trim() : '';
	let type = typeof config.type === 'string' ? config.type.toLowerCase() : command ? 'stdio' : url ? 'http' : undefined;
	if (type === 'streamable-http' || type === 'streamablehttp') {
		type = 'http';
	}
	if (type !== 'stdio' && type !== 'http' && type !== 'sse') {
		return undefined;
	}
	const leftOut: string[] = [];
	const entry: Record<string, unknown> = { type };
	const placeholders = (value: unknown, label: string, valid: RegExp, name: (key: string) => string): Record<string, string> | undefined => {
		if (!isRecord(value)) {
			return undefined;
		}
		const pairs: [string, string][] = [];
		for (const key of Object.keys(value).slice(0, 50)) {
			if (valid.test(key)) {
				pairs.push([key, mcpPlaceholder(name(key))]);
			}
			leftOut.push(`${label}.${key.slice(0, 64)}`);
		}
		return pairs.length ? Object.fromEntries(pairs) : undefined;
	};
	if (config.env !== undefined && !isRecord(config.env) || config.headers !== undefined && !isRecord(config.headers)) {
		return undefined;
	}
	if (type === 'stdio') {
		if (!command || command.length > 1000 || /[\u0000-\u001f]/.test(command) || looksSecret(command)) {
			return undefined;
		}
		const args = config.args === undefined ? [] : config.args;
		if (!Array.isArray(args) || args.length > 100 || args.some(arg => typeof arg !== 'string' || arg.length > 2000)) {
			return undefined;
		}
		entry.command = command;
		if (args.length) {
			entry.args = sanitizeMcpArgs(args as string[], leftOut);
		}
		const env = placeholders(config.env, 'env', /^[A-Za-z_][A-Za-z0-9_]{0,63}$/, key => key);
		if (env) {
			entry.env = env;
		}
	} else {
		const clean = sanitizeMcpUrl(url, leftOut);
		if (!clean) {
			return undefined;
		}
		entry.url = clean;
		const headers = placeholders(config.headers, 'headers', /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/, key => key);
		if (headers) {
			entry.headers = headers;
		}
	}
	if (config.envFile !== undefined) {
		leftOut.push('envFile');
	}
	for (const key of Object.keys(config)) {
		if (!MCP_KNOWN_FIELDS.includes(key) && SECRET_KEY.test(key)) {
			leftOut.push(key.slice(0, 64));
		}
	}
	return { entry, leftOut: [...new Set(leftOut)] };
}

export interface ClaudeMcpImportServer {
	readonly name: string;
	readonly entry: Record<string, unknown>;
	/** What was not copied and is a placeholder or gone: `env.API_KEY`, `headers.Authorization`. */
	readonly leftOut: readonly string[];
}

export interface ClaudeMcpImportPlan {
	readonly add: readonly ClaudeMcpImportServer[];
	/** Servers Klawly already has under that name. They are never replaced. */
	readonly kept: readonly string[];
	readonly skipped: readonly ClaudeImportSkip[];
	/** Klawly's `.mcp.json` has errors. */
	readonly invalid?: ClaudeImportInvalid;
}

/** The servers of the other editor's `mcp.json` files that Klawly's `.mcp.json` (`targetText`) does not have. */
export function planClaudeMcpImport(sources: readonly string[], targetText: string | undefined): ClaudeMcpImportPlan {
	if (targetText?.trim() && !parseClaudeSettings(targetText)) {
		return { add: [], kept: [], skipped: [], invalid: 'target' };
	}
	const existing = readClaudeUserMcpServers(targetText);
	const add: ClaudeMcpImportServer[] = [];
	const kept: string[] = [];
	const skipped: ClaudeImportSkip[] = [];
	for (const source of sources) {
		const errors: ParseError[] = [];
		const value: unknown = parse(source, errors, { allowTrailingComma: true });
		if (errors.length || !isRecord(value)) {
			skipped.push({ item: 'mcp.json', reason: 'mcp-invalid' });
			continue;
		}
		const servers = isRecord(value.mcpServers) ? value.mcpServers : isRecord(value.servers) ? value.servers : undefined;
		for (const [name, config] of Object.entries(servers ?? {}).slice(0, MAX_MCP_SERVERS)) {
			if (!isClaudeMcpServerName(name)) {
				skipped.push({ item: String(name).slice(0, 64), reason: 'mcp-invalid' });
			} else if (hasOwn(existing, name) || add.some(server => server.name === name)) {
				if (!kept.includes(name)) {
					kept.push(name);
				}
			} else {
				const built = claudeImportMcpEntry(config);
				if (built) {
					add.push({ name, entry: built.entry, leftOut: built.leftOut });
				} else {
					skipped.push({ item: name, reason: 'mcp-invalid' });
				}
			}
		}
	}
	return { add, kept, skipped };
}

/** `.mcp.json` with the servers added, keeping its comments and other servers. Undefined when the file is not a JSON object. */
export function claudeMcpImportText(targetText: string | undefined, add: readonly ClaudeMcpImportServer[]): string | undefined {
	let text = targetText?.trim() ? targetText : '{}';
	if (!parseClaudeSettings(text)) {
		return undefined;
	}
	for (const server of add) {
		text = applyEdits(text, setProperty(text, ['mcpServers', server.name], server.entry, claudeSettingsFormatting(text)));
	}
	return text;
}

/** `.mcp.json` without the servers the import added; null when the import created the file and no server is left. */
export function claudeMcpUndoText(text: string, servers: readonly string[], created: boolean): string | null {
	let result: string | undefined = text;
	for (const name of servers) {
		result = removeClaudeUserMcpServer(result, name);
	}
	return created && !Object.keys(readClaudeUserMcpServers(result)).length ? null : result ?? text;
}

/** One import, with a plan for each part the user picked. */
export interface ClaudeImportPlan {
	readonly editor: ClaudeImportEditorId;
	/** `keep` when absent. */
	readonly mode?: ClaudeImportMode;
	/** The new profile's name in `profile` mode. */
	readonly profileName?: string;
	readonly settings?: ClaudeSettingsImportPlan;
	readonly keybindings?: ClaudeKeybindingsImportPlan;
	readonly snippets?: ClaudeSnippetsImportPlan;
	readonly extensions?: ClaudeExtensionsImportPlan;
	/** Color, file icon and product icon themes (issue 857). Written with the settings. */
	readonly themes?: ClaudeSettingsImportPlan;
	readonly rules?: ClaudeRulesImportPlan;
	readonly mcp?: ClaudeMcpImportPlan;
}

export function claudeImportHasChanges(plan: ClaudeImportPlan): boolean {
	return !!(plan.settings?.add.length || plan.settings?.replace.length || plan.keybindings?.add.length || plan.snippets?.copy.length || plan.snippets?.replace.length || plan.extensions?.install.length
		|| plan.themes?.add.length || plan.themes?.replace.length || plan.rules?.add.length || plan.mcp?.add.length);
}

// --- Item picker (issue 549) -----------------------------------------------------------------

export type ClaudeImportPart = 'settings' | 'keybindings' | 'snippets' | 'extensions' | 'themes' | 'rules' | 'mcp';

/** One row of the item picker: a single setting, keybinding, snippet file or extension. */
export interface ClaudeImportItem {
	/** `<part>:<key>`, unique in one plan. */
	readonly id: string;
	readonly part: ClaudeImportPart;
	readonly label: string;
	readonly description?: string;
	/** Checked when the picker opens. */
	readonly picked: boolean;
	/** Why the item is not imported. The row is shown, but can't be checked, so the skip list stays visible. */
	readonly skipped?: string;
}

const VALUE_LIMIT = 40;

/** A setting value as one short line: `4`, `"on"`, `{"*":true}`. */
export function claudeImportValueLabel(value: unknown): string {
	const text = JSON.stringify(value) ?? String(value);
	return text.length > VALUE_LIMIT ? `${text.slice(0, VALUE_LIMIT - 1)}…` : text;
}

/**
 * Every item of the plan, in part order. Adds are checked; replacements are
 * checked too (the user chose Overwrite) and unchecking one keeps Klawly's value.
 * Skipped items come last in each part, with their reason.
 */
export function claudeImportItems(plan: ClaudeImportPlan): readonly ClaudeImportItem[] {
	const items: ClaudeImportItem[] = [];
	const skips = (part: ClaudeImportPart, skipped: readonly ClaudeImportSkip[]) => {
		for (const skip of skipped) {
			items.push({ id: `${part}:skip:${skip.item}`, part, label: skip.item, picked: false, skipped: claudeImportSkipReasonLabel(skip.reason) });
		}
	};
	const { settings, keybindings, snippets, extensions } = plan;
	if (settings && !settings.invalid) {
		for (const value of settings.add) {
			items.push({ id: `settings:${value.label}`, part: 'settings', label: value.label, description: claudeImportValueLabel(value.value), picked: true });
		}
		for (const value of settings.replace) {
			items.push({
				id: `settings:${value.label}`, part: 'settings', label: value.label, picked: true,
				description: localize('claudeImportItemReplace', "Replaces {0} with {1}", claudeImportValueLabel(value.current), claudeImportValueLabel(value.value)),
			});
		}
		skips('settings', settings.skipped);
	}
	if (keybindings && !keybindings.invalid) {
		keybindings.add.forEach((entry, index) => {
			items.push({ id: `keybindings:${index}`, part: 'keybindings', label: claudeKeybindingLabel(entry), description: typeof entry.when === 'string' ? entry.when : undefined, picked: true });
		});
		skips('keybindings', keybindings.skipped);
	}
	if (snippets) {
		for (const file of snippets.copy) {
			items.push({ id: `snippets:${file.name}`, part: 'snippets', label: file.name, picked: true });
		}
		for (const file of snippets.replace) {
			items.push({ id: `snippets:${file.name}`, part: 'snippets', label: file.name, description: localize('claudeImportItemReplaceFile', "Replaces Klawly's file"), picked: true });
		}
	}
	if (extensions) {
		for (const extension of extensions.install) {
			items.push({ id: `extensions:${extension.id}`, part: 'extensions', label: extension.id, picked: true });
		}
		skips('extensions', extensions.skipped.filter(skip => skip.reason !== 'installed'));
	}
	const { themes, rules, mcp } = plan;
	if (themes && !themes.invalid) {
		for (const value of [...themes.add, ...themes.replace]) {
			items.push({
				id: `themes:${value.label}`, part: 'themes', label: value.label, picked: true,
				description: value.needsExtension
					? localize('claudeImportItemThemeInstall', "{0}, installs {1}", claudeImportValueLabel(value.value), value.needsExtension)
					: claudeImportValueLabel(value.value),
			});
		}
		skips('themes', themes.skipped);
	}
	if (rules) {
		for (const file of rules.add) {
			items.push({ id: `rules:${file.name}`, part: 'rules', label: file.name, description: localize('claudeImportItemRules', "Added to CLAUDE.md"), picked: true });
		}
	}
	if (mcp && !mcp.invalid) {
		for (const server of mcp.add) {
			items.push({
				id: `mcp:${server.name}`, part: 'mcp', label: server.name, picked: true,
				description: server.leftOut.length ? localize('claudeImportItemMcpLeftOut', "Left out: {0}", shortList(server.leftOut)) : undefined,
			});
		}
		skips('mcp', mcp.skipped);
	}
	return items;
}

/**
 * The plan with only the picked items. An unpicked replacement keeps Klawly's
 * value (it moves to `kept`); an unpicked add is left out.
 */
export function claudeSelectImport(plan: ClaudeImportPlan, picked: ReadonlySet<string>): ClaudeImportPlan {
	const { settings, keybindings, snippets, extensions, themes, rules, mcp } = plan;
	return {
		...plan,
		settings: settings && {
			...settings,
			add: settings.add.filter(value => picked.has(`settings:${value.label}`)),
			replace: settings.replace.filter(value => picked.has(`settings:${value.label}`)),
			kept: [...settings.kept, ...settings.replace.filter(value => !picked.has(`settings:${value.label}`)).map(value => value.label)],
		},
		keybindings: keybindings && { ...keybindings, add: keybindings.add.filter((_, index) => picked.has(`keybindings:${index}`)) },
		snippets: snippets && {
			copy: snippets.copy.filter(file => picked.has(`snippets:${file.name}`)),
			replace: snippets.replace.filter(file => picked.has(`snippets:${file.name}`)),
			kept: [...snippets.kept, ...snippets.replace.filter(file => !picked.has(`snippets:${file.name}`)).map(file => file.name)],
		},
		extensions: extensions && { ...extensions, install: extensions.install.filter(extension => picked.has(`extensions:${extension.id}`)) },
		themes: themes && {
			...themes,
			add: themes.add.filter(value => picked.has(`themes:${value.label}`)),
			replace: themes.replace.filter(value => picked.has(`themes:${value.label}`)),
			kept: [...themes.kept, ...themes.replace.filter(value => !picked.has(`themes:${value.label}`)).map(value => value.label)],
		},
		rules: rules && { ...rules, add: rules.add.filter(file => picked.has(`rules:${file.name}`)) },
		mcp: mcp && { ...mcp, add: mcp.add.filter(server => picked.has(`mcp:${server.name}`)) },
	};
}

// --- Undo Import (issue 549) -----------------------------------------------------------------

/**
 * What an import replaced, so Undo Import can put it back. A file's text is
 * `null` when the import created the file. Only the files the import wrote
 * are listed. `extensions` are the IDs the import installed; Undo Import
 * uninstalls them (issue 658).
 */
export interface ClaudeImportBackup {
	readonly editor: ClaudeImportEditorId;
	readonly settings?: string | null;
	readonly keybindings?: string | null;
	readonly snippets: readonly { readonly name: string; readonly previous: string | null }[];
	readonly extensions?: readonly string[];
	/** CLAUDE.md: the text the import appended, and whether it created the file (issue 857). */
	readonly claudeMd?: { readonly appended: string; readonly created: boolean };
	/** `.mcp.json`: the servers the import added, and whether it created the file (issue 857). */
	readonly mcp?: { readonly servers: readonly string[]; readonly created: boolean };
}

const MAX_BACKUP_APPENDIX = MAX_RULES_CHARS * 2;

/** The backup as stored, or undefined when the text is not one. */
export function parseClaudeImportBackup(text: string | undefined): ClaudeImportBackup | undefined {
	if (!text) {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	const fileText = (candidate: unknown) => candidate === undefined || candidate === null || typeof candidate === 'string';
	if (!isRecord(value) || !CLAUDE_IMPORT_EDITORS.includes(value.editor as ClaudeImportEditorId) || !fileText(value.settings) || !fileText(value.keybindings) || !Array.isArray(value.snippets)) {
		return undefined;
	}
	const snippets: { name: string; previous: string | null }[] = [];
	for (const entry of value.snippets) {
		// A name with a path separator would write outside the snippets folder.
		if (!isRecord(entry) || typeof entry.name !== 'string' || !SNIPPET_FILE.test(entry.name) || !(entry.previous === null || typeof entry.previous === 'string')) {
			return undefined;
		}
		snippets.push({ name: entry.name, previous: entry.previous });
	}
	let extensions: string[] | undefined;
	if (value.extensions !== undefined) {
		if (!Array.isArray(value.extensions) || value.extensions.some(id => typeof id !== 'string' || !EXTENSION_IDENTIFIER_REGEX.test(id))) {
			return undefined;
		}
		extensions = value.extensions as string[];
	}
	let claudeMd: ClaudeImportBackup['claudeMd'];
	if (value.claudeMd !== undefined) {
		const md = value.claudeMd;
		if (!isRecord(md) || typeof md.appended !== 'string' || md.appended.length > MAX_BACKUP_APPENDIX || typeof md.created !== 'boolean') {
			return undefined;
		}
		claudeMd = { appended: md.appended, created: md.created };
	}
	let mcp: ClaudeImportBackup['mcp'];
	if (value.mcp !== undefined) {
		const entry = value.mcp;
		if (!isRecord(entry) || typeof entry.created !== 'boolean' || !Array.isArray(entry.servers) || entry.servers.length > MAX_MCP_SERVERS
			|| entry.servers.some(name => typeof name !== 'string' || !isClaudeMcpServerName(name))) {
			return undefined;
		}
		mcp = { servers: entry.servers as string[], created: entry.created };
	}
	return {
		editor: value.editor as ClaudeImportEditorId, settings: value.settings as string | null | undefined, keybindings: value.keybindings as string | null | undefined, snippets,
		...extensions?.length ? { extensions } : {}, ...claudeMd ? { claudeMd } : {}, ...mcp ? { mcp } : {},
	};
}

// --- Preview and report ----------------------------------------------------------------------

const PREVIEW_LIMIT = 8;
const RULES_PREVIEW_CHARS = 1200;

function shortList(items: readonly string[]): string {
	const shown = items.slice(0, PREVIEW_LIMIT).join(', ');
	return items.length > PREVIEW_LIMIT ? localize('claudeImportMore', "{0}, and {1} more", shown, items.length - PREVIEW_LIMIT) : shown;
}

/** The text of the confirmation shown before anything is written. */
export function claudeImportPreview(plan: ClaudeImportPlan): string {
	const name = claudeImportEditorName(plan.editor);
	const lines: string[] = [];
	const { settings, keybindings, snippets, extensions } = plan;
	const skipLine = (skipped: readonly ClaudeImportSkip[]) => {
		if (skipped.length) {
			lines.push(localize('claudeImportPreviewSkips', "  Skips: {0}", shortList(skipped.map(skip => `${skip.item} (${claudeImportSkipReasonLabel(skip.reason)})`))));
		}
	};
	if (settings) {
		if (settings.invalid) {
			lines.push(invalidLine('settings.json', settings.invalid, name));
		} else {
			lines.push(settings.replace.length
				? localize('claudeImportPreviewSettingsReplace', "Settings: {0} to add, {1} to replace, {2} kept, {3} skipped.", settings.add.length, settings.replace.length, settings.kept.length, settings.skipped.length)
				: localize('claudeImportPreviewSettings', "Settings: {0} to add, {1} already set in Klawly (kept), {2} skipped.", settings.add.length, settings.kept.length, settings.skipped.length));
			if (settings.add.length) {
				lines.push(localize('claudeImportPreviewAdds', "  Adds: {0}", shortList(settings.add.map(value => value.label))));
			}
			if (settings.replace.length) {
				lines.push(localize('claudeImportPreviewReplaces', "  Replaces: {0}", shortList(settings.replace.map(value => value.label))));
			}
			skipLine(settings.skipped);
		}
	}
	if (keybindings) {
		if (keybindings.invalid) {
			lines.push(invalidLine('keybindings.json', keybindings.invalid, name));
		} else {
			lines.push(localize('claudeImportPreviewKeybindings', "Keybindings: {0} to add, {1} already in Klawly, {2} skipped.", keybindings.add.length, keybindings.existing, keybindings.skipped.length));
			if (keybindings.add.length) {
				lines.push(localize('claudeImportPreviewAdds', "  Adds: {0}", shortList(keybindings.add.map(claudeKeybindingLabel))));
			}
			skipLine(keybindings.skipped);
		}
	}
	if (snippets) {
		lines.push(localize('claudeImportPreviewSnippets', "Snippets: {0} files to copy, {1} already in Klawly (kept).", snippets.copy.length, snippets.kept.length));
		if (snippets.copy.length) {
			lines.push(localize('claudeImportPreviewCopies', "  Copies: {0}", shortList(snippets.copy.map(file => file.name))));
		}
		if (snippets.replace.length) {
			lines.push(localize('claudeImportPreviewReplaces', "  Replaces: {0}", shortList(snippets.replace.map(file => file.name))));
		}
	}
	if (extensions) {
		lines.push(localize('claudeImportPreviewExtensions', "Extensions: {0} to install from the extension gallery, {1} skipped.", extensions.install.length, extensions.skipped.length));
		if (extensions.install.length) {
			lines.push(localize('claudeImportPreviewInstalls', "  Installs: {0}", shortList(extensions.install.map(extension => extension.id))));
		}
		skipLine(extensions.skipped.filter(skip => skip.reason !== 'installed'));
	}
	if (plan.themes && !plan.themes.invalid) {
		const { themes } = plan;
		lines.push(localize('claudeImportPreviewThemes', "Themes: {0} to set, {1} skipped.", themes.add.length + themes.replace.length, themes.skipped.length));
		const set = [...themes.add, ...themes.replace];
		if (set.length) {
			lines.push(localize('claudeImportPreviewThemeSets', "  Sets: {0}", shortList(set.map(value => `${claudeImportValueLabel(value.value)}${value.needsExtension ? ` (${localize('claudeImportPreviewThemeInstalls', "installs {0}", value.needsExtension)})` : ''}`))));
		}
		skipLine(themes.skipped);
	}
	if (plan.rules) {
		const { rules } = plan;
		lines.push(localize('claudeImportPreviewRules', "Rules: {0} files to append to your CLAUDE.md, {1} already in it.", rules.add.length, rules.kept.length));
		if (rules.add.length) {
			const appendix = claudeRulesAppendix(plan.editor, rules).trim();
			lines.push(localize('claudeImportPreviewRulesAdded', "  This section is added at the end of CLAUDE.md. Your own text is not changed, and Undo Import removes exactly this section:"));
			lines.push(...(appendix.length > RULES_PREVIEW_CHARS ? `${appendix.slice(0, RULES_PREVIEW_CHARS)}…` : appendix).split('\n').map(line => `    ${line}`));
		}
	}
	if (plan.mcp) {
		if (plan.mcp.invalid) {
			lines.push(invalidLine('.mcp.json', plan.mcp.invalid, name));
		} else {
			const { mcp } = plan;
			lines.push(localize('claudeImportPreviewMcp', "MCP servers: {0} to add, {1} already in Klawly (kept), {2} skipped.", mcp.add.length, mcp.kept.length, mcp.skipped.length));
			if (mcp.add.length) {
				lines.push(localize('claudeImportPreviewMcpAdds', "  Adds: {0}", shortList(mcp.add.map(server => server.name))));
			}
			for (const server of mcp.add.filter(candidate => candidate.leftOut.length)) {
				lines.push(localize('claudeImportPreviewMcpLeftOut', "  {0}: left out as placeholders to fill in: {1}", server.name, shortList(server.leftOut)));
			}
			skipLine(mcp.skipped);
		}
	}
	lines.push('');
	if (plan.mode === 'profile') {
		lines.push(localize('claudeImportPreviewProfile', "Everything goes into a new profile, {0}. Your current profile is not changed. A full report is available when the import finishes.", plan.profileName ?? name));
	} else if (plan.settings?.replace.length || plan.snippets?.replace.length || plan.themes?.replace.length) {
		lines.push(localize('claudeImportPreviewOverwrite', "The values you picked replace yours. Your settings.json, keybindings.json and snippet files are backed up first, and Undo Import puts them back."));
	} else {
		lines.push(localize('claudeImportPreviewNote', "Nothing you already set in Klawly is overwritten. A full report is available when the import finishes."));
	}
	return lines.join('\n');
}

function invalidLine(file: string, invalid: ClaudeImportInvalid, editorName: string): string {
	switch (invalid) {
		case 'source': return localize('claudeImportPreviewSourceInvalid', "{0}'s {1} has errors and is skipped.", editorName, file);
		case 'target': return localize('claudeImportPreviewTargetInvalid', "Klawly's {0} has errors; fix it, then import again. It is skipped.", file);
		case 'unsaved': return localize('claudeImportPreviewUnsaved', "Klawly's {0} has unsaved changes; save it, then import again. It is skipped.", file);
	}
}

/** Something that failed while the import was writing or installing. */
export interface ClaudeImportFailure {
	readonly part: ClaudeImportPart;
	readonly item: string;
	readonly message: string;
}

export interface ClaudeImportOutcome {
	readonly failures: readonly ClaudeImportFailure[];
}

/** Markdown report of everything added, kept, skipped (with reasons) and failed. */
export function claudeImportReport(plan: ClaudeImportPlan, outcome: ClaudeImportOutcome): string {
	const name = claudeImportEditorName(plan.editor);
	const out: string[] = [`# ${localize('claudeImportReportTitle', "Import from {0}", name)}`, ''];
	const failed = (part: ClaudeImportFailure['part']) => outcome.failures.filter(failure => failure.part === part);
	const failedItems = (part: ClaudeImportFailure['part']) => new Set(failed(part).map(failure => failure.item));
	const section = (title: string, items: readonly string[]) => {
		if (items.length) {
			out.push(`### ${title} (${items.length})`, '', ...items.map(item => `- ${code(item)}`), '');
		}
	};
	const skips = (items: readonly ClaudeImportSkip[]) => {
		if (items.length) {
			out.push(`### ${localize('claudeImportReportSkipped', "Skipped")} (${items.length})`, '', ...items.map(skip => `- ${code(skip.item)}: ${claudeImportSkipReasonLabel(skip.reason)}`), '');
		}
	};
	const failures = (part: ClaudeImportFailure['part']) => {
		const items = failed(part);
		if (items.length) {
			out.push(`### ${localize('claudeImportReportFailed', "Failed")} (${items.length})`, '', ...items.map(failure => `- ${code(failure.item)}: ${failure.message}`), '');
		}
	};

	if (plan.settings) {
		out.push(`## ${localize('claudeImportReportSettings', "Settings")}`, '');
		if (plan.settings.invalid) {
			out.push(invalidLine('settings.json', plan.settings.invalid, name), '');
		}
		const notWritten = failedItems('settings');
		section(localize('claudeImportReportAdded', "Added"), plan.settings.add.map(value => value.label).filter(label => !notWritten.has(label)));
		section(localize('claudeImportReportReplaced', "Replaced"), plan.settings.replace.map(value => value.label).filter(label => !notWritten.has(label)));
		section(localize('claudeImportReportKept', "Already set in Klawly (kept)"), plan.settings.kept);
		skips(plan.settings.skipped);
		failures('settings');
	}
	if (plan.keybindings) {
		out.push(`## ${localize('claudeImportReportKeybindings', "Keybindings")}`, '');
		if (plan.keybindings.invalid) {
			out.push(invalidLine('keybindings.json', plan.keybindings.invalid, name), '');
		}
		const notWritten = failedItems('keybindings');
		section(localize('claudeImportReportAdded', "Added"), plan.keybindings.add.map(claudeKeybindingLabel).filter(label => !notWritten.has(label)));
		if (plan.keybindings.existing) {
			out.push(localize('claudeImportReportKeybindingsExisting', "{0} keybindings were already in Klawly.", plan.keybindings.existing), '');
		}
		skips(plan.keybindings.skipped);
		failures('keybindings');
	}
	if (plan.snippets) {
		out.push(`## ${localize('claudeImportReportSnippets', "Snippets")}`, '');
		const notWritten = failedItems('snippets');
		section(localize('claudeImportReportCopied', "Copied"), plan.snippets.copy.map(file => file.name).filter(fileName => !notWritten.has(fileName)));
		section(localize('claudeImportReportReplaced', "Replaced"), plan.snippets.replace.map(file => file.name).filter(fileName => !notWritten.has(fileName)));
		section(localize('claudeImportReportKept', "Already set in Klawly (kept)"), plan.snippets.kept);
		failures('snippets');
	}
	if (plan.extensions) {
		out.push(`## ${localize('claudeImportReportExtensions', "Extensions")}`, '');
		const notInstalled = failedItems('extensions');
		section(localize('claudeImportReportInstalled', "Installed"), plan.extensions.install.map(extension => extension.id).filter(id => !notInstalled.has(id)));
		failures('extensions');
		skips(plan.extensions.skipped);
	}
	if (plan.themes && !plan.themes.invalid) {
		out.push(`## ${localize('claudeImportReportThemes', "Themes")}`, '');
		const notWritten = failedItems('themes');
		section(localize('claudeImportReportSet', "Set"), [...plan.themes.add, ...plan.themes.replace].filter(value => !notWritten.has(value.label)).map(value => `${value.label}: ${claudeImportValueLabel(value.value)}`));
		skips(plan.themes.skipped);
		failures('themes');
	}
	if (plan.rules) {
		out.push(`## ${localize('claudeImportReportRules', "Rules")}`, '');
		const notWritten = failedItems('rules');
		section(localize('claudeImportReportAppended', "Added to CLAUDE.md"), plan.rules.add.map(file => file.name).filter(fileName => !notWritten.has(fileName)));
		section(localize('claudeImportReportKept', "Already set in Klawly (kept)"), plan.rules.kept);
		failures('rules');
	}
	if (plan.mcp) {
		out.push(`## ${localize('claudeImportReportMcp', "MCP servers")}`, '');
		if (plan.mcp.invalid) {
			out.push(invalidLine('.mcp.json', plan.mcp.invalid, name), '');
		}
		const notWritten = failedItems('mcp');
		section(localize('claudeImportReportAdded', "Added"), plan.mcp.add.map(server => server.name).filter(serverName => !notWritten.has(serverName)));
		const placeholders = plan.mcp.add.filter(server => server.leftOut.length && !notWritten.has(server.name));
		if (placeholders.length) {
			out.push(`### ${localize('claudeImportReportLeftOut', "Left out, fill these in")}`, '', ...placeholders.map(server => `- ${code(server.name)}: ${server.leftOut.map(code).join(', ')}`), '');
		}
		section(localize('claudeImportReportKept', "Already set in Klawly (kept)"), plan.mcp.kept);
		skips(plan.mcp.skipped);
		failures('mcp');
	}
	return out.join('\n');
}

/** Inline code that survives a backtick inside the value. */
function code(value: string): string {
	return '`' + value.replace(/`/g, '\'') + '`';
}

// --- JSON helpers ----------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

/** JSONC object. Empty text counts as `{}`; anything malformed is undefined. */
function parseObject(text: string): Record<string, unknown> | undefined {
	const errors: ParseError[] = [];
	const value: unknown = parse(text, errors, { allowTrailingComma: true, allowEmptyContent: true });
	if (errors.length) {
		return undefined;
	}
	return value === undefined ? {} : isRecord(value) ? value : undefined;
}

/** JSONC array. Empty text counts as `[]`; anything malformed is undefined. */
function parseArray(text: string): readonly unknown[] | undefined {
	const errors: ParseError[] = [];
	const value: unknown = parse(text, errors, { allowTrailingComma: true, allowEmptyContent: true });
	if (errors.length) {
		return undefined;
	}
	return value === undefined ? [] : Array.isArray(value) ? value : undefined;
}
