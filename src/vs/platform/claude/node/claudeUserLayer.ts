/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from '../../../base/common/path.js';
import { isLinux } from '../../../base/common/platform.js';
import { parseClaudeSettings } from '../common/claudeHooks.js';
import { CLAUDE_USER_LAYER_FILES, CLAUDE_USER_LAYER_PLUGIN_FOLDERS, claudeUserLayerManifest, claudeUserLayerSettingsBelow, readClaudeUserMcpServers } from '../common/claudeUserLayer.js';
import { claudeMdImports } from './claudeAgentsFiles.js';

/** Characters of one rules file the system prompt carries; Claude reads the rest itself. */
const RULES_MAX_CHARS = 40_000;
/** A file larger than this is never read. */
const FILE_MAX_BYTES = 1024 * 1024;
/** Imports are followed this many levels deep, as Claude Code does for CLAUDE.md. */
const IMPORT_MAX_DEPTH = 5;

export interface ClaudeUserLayerRequest {
	/** `~/.klawly/claude`. */
	readonly directory: string;
	/** Where the `user` plugin's links are kept: a folder Klawly owns, outside the user layer. */
	readonly pluginDirectory: string;
	/** The session's working folder, whose `.claude` settings rank above the user layer. */
	readonly cwd: string;
	/** Workspace Trust. MCP servers start only in a trusted workspace, like Claude Code's own user servers. */
	readonly trusted: boolean;
	/** Claude Code runs in a dev container or on an SSH host, which cannot read local plugin folders or start local servers. */
	readonly remote: boolean;
	/** Resolves `~/` imports. Defaults to the OS home. */
	readonly homeDirectory?: string;
}

/** What a query takes from `~/.klawly/claude`. Every part is absent when the layer has none. */
export interface ClaudeUserLayer {
	readonly systemPrompt?: string;
	/** Settings the project does not set, passed below Klawly's own flag settings. */
	readonly settings?: Record<string, unknown>;
	/** A plugin folder whose folders link to the user layer's skills, agents, commands and output styles. */
	readonly plugin?: string;
	readonly mcpServers?: Readonly<Record<string, Record<string, unknown>>>;
}

/**
 * Reads Klawly's user layer for one query (issue 455). It only reads
 * `~/.klawly/claude`; the only folder it writes is the plugin folder, which
 * holds a manifest and links, never a copy.
 */
export async function resolveClaudeUserLayer(request: ClaudeUserLayerRequest): Promise<ClaudeUserLayer> {
	const home = request.homeDirectory ?? homedir();
	const [systemPrompt, settings, mcp] = await Promise.all([
		userRulesPrompt(request.directory, home),
		userSettings(request),
		request.trusted && !request.remote ? readText(join(request.directory, CLAUDE_USER_LAYER_FILES.mcp)) : undefined,
	]);
	const mcpServers = readClaudeUserMcpServers(mcp);
	return {
		systemPrompt,
		settings,
		plugin: request.remote ? undefined : await linkUserPlugin(request.directory, request.pluginDirectory),
		mcpServers: Object.keys(mcpServers).length ? mcpServers : undefined,
	};
}

/** `CLAUDE.md` with its imports, then `rules/*.md` by name, each under its path. */
async function userRulesPrompt(directory: string, home: string): Promise<string | undefined> {
	const files: string[] = [];
	await collectRules(join(directory, CLAUDE_USER_LAYER_FILES.rules), home, 0, new Set(), files);
	const rules = join(directory, 'rules');
	const entries = await fs.readdir(rules).catch((): string[] => []);
	for (const name of entries.filter(name => name.endsWith('.md')).sort()) {
		await collectRules(join(rules, name), home, 0, new Set(), files);
	}
	const parts: string[] = [];
	for (const file of files) {
		const text = (await readText(file))?.trim();
		if (text) {
			const body = text.length > RULES_MAX_CHARS ? `${text.slice(0, RULES_MAX_CHARS)}\n\n[This file is cut here. Read ${file} for the rest.]` : text;
			parts.push(`Contents of ${file} (the user's own instructions from Klawly, for every project; the project's instructions win where they disagree):\n\n${body}`);
		}
	}
	return parts.length ? parts.join('\n\n') : undefined;
}

async function collectRules(file: string, home: string, depth: number, seen: Set<string>, files: string[]): Promise<void> {
	const key = pathKey(file);
	if (depth > IMPORT_MAX_DEPTH || seen.has(key) || files.some(known => pathKey(known) === key)) {
		return;
	}
	seen.add(key);
	const text = await readText(file);
	if (text === undefined) {
		return;
	}
	files.push(file);
	for (const path of claudeMdImports(text)) {
		const imported = path.startsWith('~/') ? join(home, path.slice(2)) : isAbsolute(path) ? resolve(path) : resolve(dirname(file), path);
		await collectRules(imported, home, depth + 1, seen, files);
	}
}

/** The user layer's `settings.json`, without what the project or its local file sets. */
async function userSettings(request: ClaudeUserLayerRequest): Promise<Record<string, unknown> | undefined> {
	const text = await readText(join(request.directory, CLAUDE_USER_LAYER_FILES.settings));
	const user = text === undefined ? undefined : parseClaudeSettings(text);
	if (!user) {
		return undefined;
	}
	// An untrusted workspace loads no project settings, so nothing ranks above the user layer there.
	const higher = request.trusted ? await Promise.all(['settings.json', 'settings.local.json'].map(async name => {
		const project = await readText(join(request.cwd, '.claude', name));
		return project === undefined ? undefined : parseClaudeSettings(project);
	})) : [];
	return claudeUserLayerSettingsBelow(user, higher);
}

/**
 * A plugin folder named `user` whose folders link to the user layer's
 * skills, agents, commands and output styles, so Claude Code loads them in
 * place. Only those folders are linked: the layer's `.mcp.json` and settings
 * reach the query through its options, never twice through the plugin.
 * Undefined when the layer has none of them or a link cannot be made.
 */
async function linkUserPlugin(directory: string, plugin: string): Promise<string | undefined> {
	const present: string[] = [];
	for (const name of CLAUDE_USER_LAYER_PLUGIN_FOLDERS) {
		if (await fs.stat(join(directory, name)).then(stat => stat.isDirectory(), () => false)) {
			present.push(name);
		}
	}
	try {
		for (const name of CLAUDE_USER_LAYER_PLUGIN_FOLDERS) {
			const link = join(plugin, name);
			const current = await fs.readlink(link).catch(() => undefined);
			const target = join(directory, name);
			if (current !== undefined && (!present.includes(name) || pathKey(resolve(plugin, current)) !== pathKey(target))) {
				// Never recursive: removing the link must not touch the folder it points to.
				await fs.unlink(link).catch(() => fs.rmdir(link));
			}
		}
		if (!present.length) {
			return undefined;
		}
		await fs.mkdir(join(plugin, ...CLAUDE_USER_LAYER_FILES.manifest.slice(0, -1)), { recursive: true });
		const manifest = join(plugin, ...CLAUDE_USER_LAYER_FILES.manifest);
		if (await readText(manifest) !== claudeUserLayerManifest()) {
			await fs.writeFile(manifest, claudeUserLayerManifest());
		}
		for (const name of present) {
			const link = join(plugin, name);
			if (await fs.readlink(link).catch(() => undefined) === undefined) {
				// A junction on Windows needs no admin rights; elsewhere the type is ignored.
				await fs.symlink(join(directory, name), link, 'junction');
			}
		}
		return plugin;
	} catch {
		return undefined;
	}
}

async function readText(file: string): Promise<string | undefined> {
	try {
		const stat = await fs.stat(file);
		return stat.isFile() && stat.size <= FILE_MAX_BYTES ? await fs.readFile(file, 'utf8') : undefined;
	} catch {
		return undefined;
	}
}

/** Paths compare case-insensitively where the file system usually does. */
function pathKey(path: string): string {
	const normalized = resolve(path);
	return isLinux ? normalized : normalized.toLowerCase();
}
