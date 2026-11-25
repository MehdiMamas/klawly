/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { applyEdits, setProperty } from '../../../base/common/jsonEdit.js';
import { posix, win32 } from '../../../base/common/path.js';
import { claudeSettingsFormatting, parseClaudeSettings } from './claudeHooks.js';
import { ClaudeMcpServerConfig } from './claudeMcpConfig.js';
import { KLAWLY_SYNC_MEMORY_SETTING } from './klawlySyncService.js';

/**
 * Klawly's own user layer (issue 455): your rules, settings, MCP servers,
 * skills, subagents, commands and output styles for every project and every
 * Claude account, in `~/.klawly/claude/` (`~/.klawly-dev/claude/` from
 * sources). Klawly hands it to Claude Code through query options only, so
 * `~/.claude` and `~/.claude.json` are never written:
 * - `CLAUDE.md` and `rules/*.md` go into the system prompt;
 * - `settings.json` (hooks included) is a settings layer below the project's
 *   own settings;
 * - `.mcp.json` servers are passed as the query's MCP servers;
 * - `skills/`, `agents/`, `commands/` and `output-styles/` load as a local
 *   plugin named `user`, through links in a folder Klawly owns.
 */
export const CLAUDE_USER_LAYER_FOLDER = 'claude';

/** The plugin name the user layer loads under, so its skills and commands are `user:<name>`. */
export const CLAUDE_USER_LAYER_PLUGIN = 'user';

/** The user layer's files, from its folder. */
export const CLAUDE_USER_LAYER_FILES = {
	rules: 'CLAUDE.md',
	settings: 'settings.json',
	mcp: '.mcp.json',
	manifest: ['.claude-plugin', 'plugin.json'],
} as const;

/** The user layer folders that load as the `user` plugin. Hooks live in `settings.json` instead. */
export const CLAUDE_USER_LAYER_PLUGIN_FOLDERS: readonly string[] = ['skills', 'agents', 'commands', 'output-styles'];

/** The folder under the data folder that holds the `user` plugin's manifest and links. */
export const CLAUDE_USER_LAYER_PLUGIN_FOLDER = 'user-plugin';

/** Issue 455: also load `~/.claude` (Claude Code's own user settings, rules, skills and MCP servers). Klawly only reads it. */
export const CLAUDE_USE_CLAUDE_CODE_SETUP_SETTING = 'claude.customize.useClaudeCodeSetup';

/** What a session takes from the user layers. */
export interface ClaudeUserLayerSettings {
	/** Read `~/.claude` too (`settingSources` includes `user`). */
	readonly useClaudeCodeSetup: boolean;
	/** Issue 448: read and write the synced project memory (`klawly.sync.memory.enabled`). */
	readonly projectMemory?: boolean;
}

export function readClaudeUserLayerSettings(get: (key: string) => unknown): ClaudeUserLayerSettings {
	return { useClaudeCodeSetup: get(CLAUDE_USE_CLAUDE_CODE_SETUP_SETTING) !== false, projectMemory: get(KLAWLY_SYNC_MEMORY_SETTING) === true };
}

/** `~/.klawly/claude` for this build: `dataFolderName` is `.klawly`, or `.klawly-dev` from sources. */
export function claudeUserLayerDirectory(homeDirectory: string, dataFolderName: string): string {
	return styleFor(homeDirectory).join(homeDirectory, dataFolderName, CLAUDE_USER_LAYER_FOLDER);
}

/** The `~/`-style label of a user layer file, for rows and messages. */
export function claudeUserLayerLabel(dataFolderName: string, ...segments: string[]): string {
	return ['~', dataFolderName, CLAUDE_USER_LAYER_FOLDER, ...segments].join('/');
}

/** The manifest that makes the folder loadable as a local plugin. */
export function claudeUserLayerManifest(): string {
	return JSON.stringify({ name: CLAUDE_USER_LAYER_PLUGIN, description: 'Your Klawly setup for every project: skills, subagents, commands and output styles.' }, undefined, '\t') + '\n';
}

/** The scope Klawly shows for Claude Code's own user servers in `~/.claude.json`: listed, never changed. */
export const CLAUDE_CODE_MCP_SCOPE = 'claudeCode';

/**
 * Where a running server is configured, as Klawly shows it. Claude Code
 * reports the user layer's servers as `dynamic`, since the query passes them;
 * they are `user` in Klawly. Its own `user` servers, from `~/.claude.json`,
 * become {@link CLAUDE_CODE_MCP_SCOPE}.
 */
export function claudeUserLayerMcpScope(scope: string | undefined, name: string, userLayerServers: readonly string[] | undefined): string | undefined {
	if (scope === 'dynamic' && userLayerServers?.includes(name)) {
		return 'user';
	}
	return scope === 'user' ? CLAUDE_CODE_MCP_SCOPE : scope;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The part of the Klawly user settings that a more specific layer does not
 * set, so the project still wins as in Claude Code: managed > project local >
 * project > Klawly user > Claude Code user. Klawly passes the user layer as
 * the flag settings layer, which Claude Code ranks above the project, so a key
 * the project (or its local file) sets is dropped here. Objects are compared
 * key by key; arrays are kept, since Claude Code merges them across layers
 * (permission rules, hook lists). `permissions.defaultMode` never passes: the
 * mode is Klawly's to set.
 */
export function claudeUserLayerSettingsBelow(user: JsonObject | undefined, higher: readonly (JsonObject | undefined)[]): JsonObject | undefined {
	if (!user) {
		return undefined;
	}
	const result = below(user, higher.filter(isObject));
	if (isObject(result.permissions)) {
		const { defaultMode: _mode, ...permissions } = result.permissions;
		if (Object.keys(permissions).length) {
			result.permissions = permissions;
		} else {
			delete result.permissions;
		}
	}
	return Object.keys(result).length ? result : undefined;
}

function below(user: JsonObject, higher: readonly JsonObject[]): JsonObject {
	const result: JsonObject = {};
	for (const [key, value] of Object.entries(user)) {
		const set = higher.filter(layer => Object.prototype.hasOwnProperty.call(layer, key)).map(layer => layer[key]);
		if (!set.length || Array.isArray(value) && set.every(Array.isArray)) {
			result[key] = value;
		} else if (isObject(value) && set.every(isObject)) {
			const nested = below(value, set as JsonObject[]);
			if (Object.keys(nested).length) {
				result[key] = nested;
			}
		}
	}
	return result;
}

/** The `mcpServers` of a `.mcp.json`. Entries that are not objects are left out. */
export function readClaudeUserMcpServers(text: string | undefined): Record<string, JsonObject> {
	const servers = text ? parseClaudeSettings(text)?.mcpServers : undefined;
	const result: Record<string, JsonObject> = {};
	if (isObject(servers)) {
		for (const [name, config] of Object.entries(servers)) {
			if (isObject(config)) {
				result[name] = config;
			}
		}
	}
	return result;
}

/**
 * `.mcp.json` with the server added or replaced, keeping the file's comments
 * and other servers. Undefined when the file is not a JSON object; then
 * nothing is written.
 */
export function addClaudeUserMcpServer(text: string | undefined, name: string, config: ClaudeMcpServerConfig): string | undefined {
	const base = text?.trim() ? text : '{}';
	if (!parseClaudeSettings(base)) {
		return undefined;
	}
	const value = config.type === 'stdio' ? { type: 'stdio', command: config.command, args: [...config.args] } : { type: config.type, url: config.url };
	return applyEdits(base, setProperty(base, ['mcpServers', name], value, claudeSettingsFormatting(base)));
}

/** `.mcp.json` without the server. The text is unchanged when it has no such server. */
export function removeClaudeUserMcpServer(text: string | undefined, name: string): string | undefined {
	if (!text || !Object.prototype.hasOwnProperty.call(readClaudeUserMcpServers(text), name)) {
		return text;
	}
	return applyEdits(text, setProperty(text, ['mcpServers', name], undefined, claudeSettingsFormatting(text)));
}

function styleFor(path: string) {
	return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\') ? win32 : posix;
}
