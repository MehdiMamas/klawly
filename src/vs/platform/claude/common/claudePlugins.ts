/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

/** Shared-process channel for `IClaudePluginService`. */
export const CLAUDE_PLUGIN_CHANNEL = 'claudePlugins';

/** What a plugin can add to Claude Code. The values match the Customize kinds. */
export type ClaudePluginKind = 'skills' | 'subagents' | 'commands' | 'hooks' | 'mcp';

export const CLAUDE_PLUGIN_KINDS: readonly ClaudePluginKind[] = ['skills', 'subagents', 'commands', 'hooks', 'mcp'];

/** Where Claude Code installs a plugin: yours everywhere, the project's `.claude/settings.json`, or yours in this project. */
export type ClaudePluginScope = 'user' | 'project' | 'local';

/** One command a plugin hook runs. `command` is the prompt for a prompt hook. */
export interface ClaudePluginHook {
	readonly event: string;
	readonly matcher?: string;
	readonly command: string;
}

/** One MCP server a plugin starts (`command`) or connects to (`url`). */
export interface ClaudePluginMcpServer {
	readonly name: string;
	readonly command?: string;
	readonly args?: readonly string[];
	readonly url?: string;
}

export interface ClaudePluginContents {
	readonly skills: readonly string[];
	readonly subagents: readonly string[];
	readonly commands: readonly string[];
	readonly hooks: readonly ClaudePluginHook[];
	readonly mcpServers: readonly ClaudePluginMcpServer[];
	/** The `allowed-tools` its commands and skills declare. */
	readonly allowedTools: readonly string[];
	/**
	 * False when Klawly could not read all of the plugin's files (a plugin hosted
	 * outside GitHub, or one whose folders cannot be listed), so the lists may be short.
	 */
	readonly complete: boolean;
}

export interface ClaudePluginInstall {
	readonly scope: string;
	readonly version?: string;
}

/**
 * How a team asks for a plugin. `defaultOn`: the project's shared
 * `.claude/settings.json` enables it under `enabledPlugins`. `required`: Claude
 * Code's managed settings enable it, so nobody here can remove it.
 */
export type ClaudePluginPolicy = 'defaultOn' | 'required';

export interface ClaudePluginEntry {
	/** `name@marketplace`, the id Claude Code uses. */
	readonly id: string;
	readonly name: string;
	/** The marketplace's name for it, for people; rows show it in place of `name` (issue 534). */
	readonly displayName?: string;
	readonly marketplace: string;
	readonly description: string;
	readonly author?: string;
	readonly category?: string;
	readonly homepage?: string;
	readonly version?: string;
	/** Where its icon is fetched from (issue 534); only {@link IClaudePluginService.getPluginIcons} loads it. */
	readonly iconUrl?: string;
	/** Where the plugin comes from, for people: `owner/repo`, a URL, or a folder of the marketplace. */
	readonly source: string;
	/** What it adds, when Klawly could read it without a download. */
	readonly contents?: ClaudePluginContents;
	/**
	 * The kinds it adds, known before details open: read from its files, from
	 * Claude Code's own catalog cache, or resolved later with {@link IClaudePluginService.resolveKinds}.
	 */
	readonly kinds?: readonly ClaudePluginKind[];
	/**
	 * `kinds` came from Claude Code's catalog cache, which can miss one (an MCP
	 * server declared by path, issue 535), and Klawly can still read the plugin's
	 * files: {@link IClaudePluginService.resolveKinds} adds what they declare.
	 */
	readonly kindsPartial?: boolean;
	readonly installed?: ClaudePluginInstall;
	readonly updateAvailable: boolean;
	/** Set when the project or the organization turns the plugin on. */
	readonly policy?: ClaudePluginPolicy;
}

export interface ClaudeMarketplaceInfo {
	readonly name: string;
	/** `owner/repo`, a URL or a path. */
	readonly source: string;
	/** True when Claude Code has it (`claude plugin marketplace list`). */
	readonly added: boolean;
	/** True when it is on Klawly's short built-in list. */
	readonly builtIn: boolean;
	readonly pluginCount: number;
	readonly error?: string;
	/** The settings file that declares it under `extraKnownMarketplaces`: `.claude/settings.json` (project), `.claude/settings.local.json` (local) or Claude Code's managed settings (managed). */
	readonly declaredIn?: 'project' | 'local' | 'managed';
}

export interface ClaudePluginCatalog {
	readonly marketplaces: readonly ClaudeMarketplaceInfo[];
	readonly plugins: readonly ClaudePluginEntry[];
}

export interface ClaudePluginDetails {
	readonly plugin: ClaudePluginEntry;
	readonly contents: ClaudePluginContents;
	/** The plugin's README.md, as Markdown. */
	readonly readme?: string;
}

export interface ClaudePluginCatalogRequest {
	/** `claude.plugins.builtInMarketplaces`: also read Klawly's built-in list. */
	readonly builtIn: boolean;
	/** Skips the few minutes the last catalog is kept for. */
	readonly refresh?: boolean;
	/** The trusted project folder: its `.claude/settings*.json` marketplaces are listed, and its project installs count. */
	readonly cwd?: string;
}

/** A plugin Claude Code has installed where this window works, with what it adds, for Customize's Installed tab. */
export interface ClaudeInstalledPlugin {
	/** `name@marketplace`. */
	readonly id: string;
	readonly name: string;
	readonly scope: string;
	readonly contents: ClaudePluginContents;
}

/** A `claude plugin` command Klawly runs. Every field is checked again in the shared process. */
export type ClaudePluginCommand =
	| { readonly action: 'install'; readonly plugin: string; readonly scope: ClaudePluginScope; readonly marketplaceSource?: string; readonly acceptCommand?: string; readonly cwd?: string }
	| { readonly action: 'update'; readonly plugin: string; readonly scope?: ClaudePluginScope; readonly acceptCommand?: string; readonly cwd?: string }
	| { readonly action: 'uninstall'; readonly plugin: string; readonly scope: ClaudePluginScope; readonly cwd?: string }
	| { readonly action: 'addMarketplace'; readonly source: string; readonly scope?: ClaudePluginScope; readonly cwd?: string }
	| { readonly action: 'removeMarketplace'; readonly name: string };

export interface ClaudePluginCommandResult {
	/** `confirm`: the marketplace declares a command that runs to install it; show it, then run again with `acceptCommand`. */
	readonly outcome: 'done' | 'failed' | 'confirm';
	readonly message: string;
	/** `archiveUrl`: the command is a headersHelper that fetches this archive, not the install itself. */
	readonly shownCommand?: { readonly command: string; readonly sha256: string; readonly archiveUrl?: string };
}

export const IClaudePluginService = createDecorator<IClaudePluginService>('claudePluginService');

/**
 * Claude Code plugin marketplaces, for Customize's Discover tab. Reads what
 * Claude Code itself added, plus Klawly's built-in list, and changes things only
 * through `claude plugin`, so the terminal and Klawly see the same state.
 */
export interface IClaudePluginService {
	readonly _serviceBrand: undefined;
	getCatalog(request: ClaudePluginCatalogRequest): Promise<ClaudePluginCatalog>;
	/** Everything the plugin adds, read from its files, and its README. Undefined for an unknown id. */
	getDetails(id: string, request: ClaudePluginCatalogRequest): Promise<ClaudePluginDetails | undefined>;
	/**
	 * The kinds each listed plugin adds, read from its GitHub folder (cached, with
	 * ETags) for plugins whose files are not on disk. Ids it could not read are left out.
	 */
	resolveKinds(ids: readonly string[], request: ClaudePluginCatalogRequest): Promise<Record<string, readonly ClaudePluginKind[]>>;
	/** The plugins installed for you, and in `cwd` when given, with what each adds. */
	getInstalled(cwd: string | undefined): Promise<ClaudeInstalledPlugin[]>;
	run(command: ClaudePluginCommand): Promise<ClaudePluginCommandResult>;
	/**
	 * A folder with the plugin's files, for one new session to load without
	 * installing it (the SDK's `plugins: [{ type: 'local', path }]`). Undefined
	 * when Klawly cannot get its files.
	 */
	preparePluginTrial(id: string, request: ClaudePluginCatalogRequest): Promise<string | undefined>;
	/**
	 * Issue 534: the icons of these plugins as `data:` URLs of PNG, JPEG, GIF,
	 * WebP or ICO images, fetched and cached in the shared process, never by the
	 * UI. Plugins without one are left out.
	 */
	getPluginIcons(ids: readonly string[], request: ClaudePluginCatalogRequest): Promise<Record<string, string>>;
	/**
	 * Issue 1186: writes the bundled `/klawly` marketplace to Klawly's data folder
	 * and returns its path, the source for `addMarketplace`. Rejects when it cannot be written.
	 */
	prepareTerminalPlugin(): Promise<string>;
}

/** Lists Klawly's built-in marketplaces in Discover even before Claude Code has them. */
export const CLAUDE_PLUGINS_BUILT_IN_MARKETPLACES_SETTING = 'claude.plugins.builtInMarketplaces';

/** Klawly's built-in marketplace list: Anthropic's official directory only. */
export const CLAUDE_BUILT_IN_MARKETPLACES: readonly { readonly name: string; readonly repo: string }[] = [
	{ name: 'claude-plugins-official', repo: 'anthropics/claude-plugins-official' },
];

const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?:@[A-Za-z0-9][A-Za-z0-9_.-]{0,127})?$/;
const MARKETPLACE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const MAX_SOURCE_LENGTH = 2048;

function readScope(value: unknown): ClaudePluginScope | undefined {
	return value === 'user' || value === 'project' || value === 'local' ? value : undefined;
}

function readOptionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A marketplace source: `owner/repo`, a URL or a path. Never an option, never a control character. */
function isMarketplaceSource(value: unknown): value is string {
	return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= MAX_SOURCE_LENGTH && !value.startsWith('-') && !/[\u0000-\u001f]/.test(value);
}

/** Checks a command that crossed a process boundary. Undefined when any part is off. */
export function readClaudePluginCommand(value: unknown): ClaudePluginCommand | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const command = value as Record<string, unknown>;
	const cwd = readOptionalString(command.cwd);
	const acceptCommand = command.acceptCommand === undefined ? undefined : typeof command.acceptCommand === 'string' && SHA256.test(command.acceptCommand) ? command.acceptCommand : null;
	if (acceptCommand === null) {
		return undefined;
	}
	const plugin = typeof command.plugin === 'string' && PLUGIN_ID.test(command.plugin) ? command.plugin : undefined;
	switch (command.action) {
		case 'install': {
			const scope = readScope(command.scope);
			const marketplaceSource = command.marketplaceSource === undefined ? undefined : isMarketplaceSource(command.marketplaceSource) ? command.marketplaceSource : null;
			// `--marketplace` takes the plugin's bare name.
			if (!plugin || !scope || marketplaceSource === null || (marketplaceSource && plugin.includes('@'))) {
				return undefined;
			}
			return { action: 'install', plugin, scope, marketplaceSource, acceptCommand, cwd };
		}
		case 'update': {
			const scope = command.scope === undefined ? undefined : readScope(command.scope);
			if (!plugin || (command.scope !== undefined && !scope)) {
				return undefined;
			}
			return { action: 'update', plugin, scope, acceptCommand, cwd };
		}
		case 'uninstall': {
			const scope = readScope(command.scope);
			return plugin && scope ? { action: 'uninstall', plugin, scope, cwd } : undefined;
		}
		case 'addMarketplace': {
			const scope = command.scope === undefined ? undefined : readScope(command.scope);
			return isMarketplaceSource(command.source) && (command.scope === undefined || scope) ? { action: 'addMarketplace', source: command.source, scope, cwd } : undefined;
		}
		case 'removeMarketplace':
			return typeof command.name === 'string' && MARKETPLACE_NAME.test(command.name) ? { action: 'removeMarketplace', name: command.name } : undefined;
		default:
			return undefined;
	}
}

/** The `claude plugin …` arguments for a checked command. Every one asks for the one-line JSON result. */
export function claudePluginCommandArguments(command: ClaudePluginCommand): string[] {
	switch (command.action) {
		case 'install':
			return [
				'plugin', 'install', command.plugin, '--scope', command.scope, '--json',
				...(command.marketplaceSource ? ['--marketplace', command.marketplaceSource] : []),
				...(command.acceptCommand ? ['--accept-command', command.acceptCommand] : []),
			];
		case 'update':
			return [
				'plugin', 'update', command.plugin, '--json',
				...(command.scope ? ['--scope', command.scope] : []),
				...(command.acceptCommand ? ['--accept-command', command.acceptCommand] : []),
			];
		case 'uninstall':
			return ['plugin', 'uninstall', command.plugin, '--scope', command.scope, '--json'];
		case 'addMarketplace':
			return ['plugin', 'marketplace', 'add', command.source, '--json', ...(command.scope ? ['--scope', command.scope] : [])];
		case 'removeMarketplace':
			return ['plugin', 'marketplace', 'remove', command.name, '--json'];
	}
}

/**
 * Reads the JSON result line `claude plugin … --json` prints last on stdout.
 * `failed` is whether the process exited with an error; `fallback` is what it
 * printed on stderr, used when there is no JSON line.
 */
export function readClaudePluginCommandResult(stdout: string, failed: boolean, fallback: string): ClaudePluginCommandResult {
	let parsed: Record<string, unknown> | undefined;
	for (const line of stdout.split(/\r?\n/).reverse()) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) {
			continue;
		}
		try {
			const value: unknown = JSON.parse(trimmed);
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				parsed = value as Record<string, unknown>;
				break;
			}
		} catch {
			// Not the result line.
		}
	}
	const message = typeof parsed?.message === 'string' ? parsed.message : fallback;
	// Claude Code 2.1.296 reports `shownCommand: { kind, pluginId, command, mode | archiveUrl, catalogRevision, sha256 }`:
	// `command_source` is a plugin installed by running `command`, `entry_helper` the headersHelper that fetches `archiveUrl`.
	const shown = parsed?.shownCommand;
	if (shown && typeof shown === 'object') {
		const record = shown as Record<string, unknown>;
		const sha256 = typeof record.sha256 === 'string' && SHA256.test(record.sha256) ? record.sha256 : undefined;
		const command = Array.isArray(record.command) && record.command.every(part => typeof part === 'string') ? record.command.join(' ') : record.command;
		const archiveUrl = typeof record.archiveUrl === 'string' && record.archiveUrl.length > 0 ? record.archiveUrl : undefined;
		// Without a terminal and without `-y`, Claude Code refuses and reports the command it would run.
		if (sha256 && typeof command === 'string' && command.length > 0 && failed) {
			return { outcome: 'confirm', message, shownCommand: { command, sha256, archiveUrl } };
		}
	}
	return { outcome: failed || parsed?.outcome === 'failed' ? 'failed' : 'done', message };
}

/** The plugins a search and a kind leave, in catalog order. A kind keeps only plugins known to add it. */
export function filterClaudePlugins(plugins: readonly ClaudePluginEntry[], query: string, kind: ClaudePluginKind | undefined): ClaudePluginEntry[] {
	const words = query.trim().toLowerCase().split(/\s+/).filter(word => word.length > 0);
	return plugins.filter(plugin => {
		if (kind && !knownClaudePluginKinds(plugin)?.includes(kind)) {
			return false;
		}
		const text = `${plugin.name} ${plugin.displayName ?? ''} ${plugin.description} ${plugin.author ?? ''} ${plugin.category ?? ''} ${plugin.marketplace}`.toLowerCase();
		return words.every(word => text.includes(word));
	});
}

/** The kinds a listed plugin adds, or undefined while nobody has read them. */
export function knownClaudePluginKinds(plugin: ClaudePluginEntry): readonly ClaudePluginKind[] | undefined {
	return plugin.kinds ?? (plugin.contents && claudePluginKinds(plugin.contents));
}

/**
 * The installed plugin a Customize row comes from. Claude Code names what a
 * plugin adds `<plugin>:<name>`, and its MCP servers `plugin:<plugin>:<server>`;
 * a bare skill, subagent or command name counts when exactly one installed plugin lists it.
 */
export function claudePluginOrigin(plugins: readonly ClaudeInstalledPlugin[], kind: ClaudePluginKind, name: string): ClaudeInstalledPlugin | undefined {
	const prefix = (kind === 'mcp' ? /^plugin:(?<plugin>[^:]+):/ : /^\/?(?<plugin>[^:\s]+):/).exec(name)?.groups?.plugin;
	if (prefix) {
		const named = plugins.find(plugin => plugin.name === prefix);
		if (named) {
			return named;
		}
	}
	const bare = name.replace(/^\//, '');
	const listing = plugins.filter(plugin => {
		switch (kind) {
			case 'skills': return plugin.contents.skills.includes(bare);
			case 'subagents': return plugin.contents.subagents.includes(bare);
			case 'commands': return plugin.contents.commands.includes(bare);
			// A plugin's servers are always `plugin:<plugin>:<server>`, so a bare name is someone else's.
			case 'mcp':
			case 'hooks': return false;
		}
	});
	return listing.length === 1 ? listing[0] : undefined;
}

/** Every kind either list has, in {@link CLAUDE_PLUGIN_KINDS} order. */
export function unionClaudePluginKinds(a: readonly ClaudePluginKind[], b: readonly ClaudePluginKind[]): ClaudePluginKind[] {
	return CLAUDE_PLUGIN_KINDS.filter(kind => a.includes(kind) || b.includes(kind));
}

/** The kinds a plugin adds, in {@link CLAUDE_PLUGIN_KINDS} order. */
export function claudePluginKinds(contents: ClaudePluginContents): ClaudePluginKind[] {
	const kinds: ClaudePluginKind[] = [];
	if (contents.skills.length) {
		kinds.push('skills');
	}
	if (contents.subagents.length) {
		kinds.push('subagents');
	}
	if (contents.commands.length) {
		kinds.push('commands');
	}
	if (contents.hooks.length) {
		kinds.push('hooks');
	}
	if (contents.mcpServers.length) {
		kinds.push('mcp');
	}
	return kinds;
}
