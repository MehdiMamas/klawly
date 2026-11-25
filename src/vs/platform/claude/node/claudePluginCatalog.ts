/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { encodeBase64, VSBuffer } from '../../../base/common/buffer.js';
import { dirname, isAbsolute, join, resolve } from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { CLAUDE_MANAGED_SETTINGS_FILE, CLAUDE_MANAGED_SETTINGS_FOLDER } from '../common/claudeManagedFiles.js';
import { CLAUDE_BUILT_IN_MARKETPLACES, ClaudeInstalledPlugin, ClaudeMarketplaceInfo, ClaudePluginCatalog, ClaudePluginCatalogRequest, ClaudePluginContents, ClaudePluginDetails, ClaudePluginEntry, ClaudePluginHook, ClaudePluginInstall, ClaudePluginKind, claudePluginKinds, ClaudePluginMcpServer, ClaudePluginPolicy, knownClaudePluginKinds, unionClaudePluginKinds } from '../common/claudePlugins.js';

/** What a GET returned: 304 means the cached body still holds. */
export interface ClaudeCatalogFetchResult {
	readonly status: number;
	readonly etag?: string;
	readonly body?: string;
}

/** A GET with an optional `If-None-Match`. The shared process passes the platform request service, so proxy settings apply. */
export type ClaudeCatalogFetch = (url: string, etag: string | undefined) => Promise<ClaudeCatalogFetchResult>;

/** A GET that keeps the body as bytes, for plugin files copied as they are (images, archives). */
export type ClaudeCatalogFetchBytes = (url: string) => Promise<{ readonly status: number; readonly body?: VSBuffer }>;

export interface ClaudePluginCatalogOptions {
	/** Claude Code's folder: `CLAUDE_CONFIG_DIR`, else `~/.claude`. Only `plugins/*.json` metadata is read there. */
	readonly configDirectory: string;
	readonly fetch: ClaudeCatalogFetch;
	readonly now?: () => number;
	/** Klawly's own folder for copies of GitHub plugins a session tries without installing them. */
	readonly trialDirectory?: string;
	/** Fetches the files of those copies; without it, GitHub plugins cannot be tried. */
	readonly fetchBytes?: ClaudeCatalogFetchBytes;
	/**
	 * Claude Code's managed folder (`claudeManagedDirectory`): its managed
	 * settings declare the organization's marketplaces and required plugins.
	 * Without it, no managed settings are read.
	 */
	readonly managedDirectory?: string;
}

/** Where a plugin comes from, as the marketplace manifest says. */
export type ClaudePluginSource =
	| { readonly kind: 'relative'; readonly path: string }
	| { readonly kind: 'github'; readonly repo: string; readonly ref?: string; readonly sha?: string; readonly path?: string }
	| { readonly kind: 'git'; readonly url: string; readonly ref?: string; readonly sha?: string; readonly path?: string }
	| { readonly kind: 'other'; readonly label: string };

/** Content paths a manifest declares: a path, a list of paths, or (hooks and MCP servers) the config itself. */
export interface ClaudeDeclaredContents {
	readonly commands?: unknown;
	readonly agents?: unknown;
	readonly skills?: unknown;
	readonly hooks?: unknown;
	readonly mcpServers?: unknown;
}

export interface ClaudeMarketplacePlugin {
	readonly name: string;
	readonly displayName?: string;
	readonly description: string;
	readonly author?: string;
	readonly category?: string;
	readonly homepage?: string;
	readonly version?: string;
	/** An HTTPS image the entry names as its `icon` or `logo`. The official manifest has none yet. */
	readonly icon?: string;
	readonly source: ClaudePluginSource;
	readonly declared: ClaudeDeclaredContents;
}

export interface ClaudeMarketplaceManifest {
	readonly name?: string;
	readonly plugins: readonly ClaudeMarketplacePlugin[];
	/** Entries left out because they had no name or no source. */
	readonly skipped: number;
}

/** How long a catalog is reused before the files and manifests are read again. */
const CATALOG_TTL_MS = 5 * 60 * 1000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FRONTMATTER_READS = 40;
/** Files one plugin copy for a trial may have. */
const MAX_TRIAL_FILES = 200;
const MAX_ETAG_ENTRIES = 400;
/** Plugins one {@link ClaudePluginCatalogReader.resolveKinds} call reads, and how many at a time, to stay inside GitHub's unauthenticated rate limit. */
const MAX_RESOLVE = 60;
const RESOLVE_CONCURRENCY = 6;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF = /^[A-Za-z0-9_./-]{1,200}$/;
const GITHUB_URL = /^https:\/\/github\.com\/(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
/** A GitHub account in a URL's first path segment, for its avatar. */
const GITHUB_ACCOUNT = /^https:\/\/(?:www\.)?github\.com\/(?<owner>[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?:[/?#]|$)/i;
/** First path segments on github.com that are pages, not accounts. */
const GITHUB_PAGES = new Set(['about', 'apps', 'features', 'marketplace', 'orgs', 'settings', 'sponsors', 'topics']);
/** Icons Discover reads in one call, how many at a time, how big one may be, and how long one is kept (a miss, less long). */
const MAX_ICONS = 120;
const ICON_CONCURRENCY = 6;
const MAX_ICON_BYTES = 128 * 1024;
const ICON_TTL_MS = 24 * 60 * 60 * 1000;
const ICON_RETRY_MS = 10 * 60 * 1000;

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A path inside the plugin, without `./`, or undefined when it is absolute or leaves the plugin. */
function innerPath(value: string): string | undefined {
	const parts = value.replace(/\\/g, '/').split('/').filter(part => part.length > 0 && part !== '.');
	if (/^[a-zA-Z]:/.test(value) || value.startsWith('/') || value.startsWith('\\') || parts.some(part => part === '..')) {
		return undefined;
	}
	return parts.join('/');
}

function readSource(value: unknown, pluginRoot: string | undefined): ClaudePluginSource | undefined {
	if (typeof value === 'string') {
		const path = innerPath(!value.startsWith('./') && pluginRoot ? `${pluginRoot}/${value}` : value);
		return path === undefined ? undefined : { kind: 'relative', path };
	}
	const source = record(value);
	if (!source) {
		return undefined;
	}
	const ref = text(source.ref) && REF.test(source.ref as string) ? source.ref as string : undefined;
	const sha = text(source.sha) && /^[0-9a-f]{7,64}$/i.test(source.sha as string) ? source.sha as string : undefined;
	const path = text(source.path) ? innerPath(source.path as string) : undefined;
	switch (source.source) {
		case 'github': {
			const repo = text(source.repo);
			return repo && REPO.test(repo) ? { kind: 'github', repo, ref, sha, path } : undefined;
		}
		case 'url':
		case 'git':
		case 'git-subdir': {
			const url = text(source.url);
			if (!url) {
				return undefined;
			}
			const github = GITHUB_URL.exec(url)?.groups;
			return github ? { kind: 'github', repo: `${github.owner}/${github.repo}`, ref, sha, path } : { kind: 'git', url, ref, sha, path };
		}
		default: {
			const label = text(source.package) ?? text(source.url) ?? text(source.source);
			return label ? { kind: 'other', label } : undefined;
		}
	}
}

/**
 * Reads a `.claude-plugin/marketplace.json`. Entries without a name or a source
 * are skipped and counted; fields Klawly does not know are ignored.
 */
export function parseClaudeMarketplaceManifest(json: string): ClaudeMarketplaceManifest | undefined {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return undefined;
	}
	const manifest = record(value);
	if (!manifest || !Array.isArray(manifest.plugins)) {
		return undefined;
	}
	const pluginRoot = text(record(manifest.metadata)?.pluginRoot);
	const plugins: ClaudeMarketplacePlugin[] = [];
	let skipped = 0;
	for (const item of manifest.plugins) {
		const entry = record(item);
		const name = text(entry?.name);
		const source = entry && readSource(entry.source, pluginRoot ? innerPath(pluginRoot) : undefined);
		if (!entry || !name || !NAME.test(name) || !source) {
			skipped++;
			continue;
		}
		const author = text(entry.author) ?? text(record(entry.author)?.name);
		const icon = text(entry.icon) ?? text(entry.logo);
		plugins.push({
			name,
			displayName: text(entry.displayName),
			description: text(entry.description) ?? '',
			author,
			category: text(entry.category),
			homepage: text(entry.homepage),
			version: text(entry.version),
			icon: icon && httpsUrl(icon) ? icon : undefined,
			source,
			declared: { commands: entry.commands, agents: entry.agents, skills: entry.skills, hooks: entry.hooks, mcpServers: entry.mcpServers },
		});
	}
	return { name: text(manifest.name), plugins, skipped };
}

function httpsUrl(value: string): URL | undefined {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password ? url : undefined;
	} catch {
		return undefined;
	}
}

function githubAccount(url: string | undefined): string | undefined {
	const owner = url ? GITHUB_ACCOUNT.exec(url)?.groups?.owner : undefined;
	return owner && !GITHUB_PAGES.has(owner.toLowerCase()) ? owner : undefined;
}

/**
 * Issue 534: where a plugin's icon comes from, first hit wins: the image its
 * entry names, the avatar of the GitHub account its source or homepage is under,
 * the favicon of any other HTTPS homepage. Undefined leaves the monogram tile.
 */
export function claudePluginIconUrl(plugin: Pick<ClaudeMarketplacePlugin, 'icon' | 'homepage' | 'source'>): string | undefined {
	if (plugin.icon) {
		return plugin.icon;
	}
	const owner = (plugin.source.kind === 'github' ? plugin.source.repo.split('/')[0] : undefined) ?? githubAccount(plugin.homepage);
	if (owner) {
		return `https://github.com/${owner}.png?size=64`;
	}
	// A GitHub page that is not an account (an org's projects, say) has GitHub's own favicon, not the plugin's.
	const homepage = plugin.homepage ? httpsUrl(plugin.homepage) : undefined;
	return homepage && !/^(?:www\.)?github\.com$/i.test(homepage.hostname) ? `${homepage.origin}/favicon.ico` : undefined;
}

/** The image as a `data:` URL when its bytes are a PNG, JPEG, GIF, WebP or ICO no bigger than the cap; never SVG, which can carry script. */
export function claudeIconDataUrl(bytes: VSBuffer): string | undefined {
	if (bytes.byteLength < 12 || bytes.byteLength > MAX_ICON_BYTES) {
		return undefined;
	}
	const b = bytes.buffer;
	const ascii = (start: number, end: number) => String.fromCharCode(...b.subarray(start, end));
	const type = b[0] === 0x89 && ascii(1, 4) === 'PNG' ? 'image/png'
		: b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'image/jpeg'
			: ascii(0, 4) === 'GIF8' ? 'image/gif'
				: ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' ? 'image/webp'
					: b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 ? 'image/x-icon'
						: undefined;
	return type && `data:${type};base64,${encodeBase64(bytes)}`;
}

/** One way to read a plugin's files: from disk, or over HTTPS. */
interface PluginFiles {
	read(path: string): Promise<string | undefined>;
	/** Undefined when the folder could not be listed (as opposed to missing, which is empty). */
	list(path: string): Promise<readonly { readonly name: string; readonly directory: boolean }[] | undefined>;
}

class LocalPluginFiles implements PluginFiles {
	constructor(private readonly _root: string) { }

	async read(path: string): Promise<string | undefined> {
		try {
			const file = join(this._root, path);
			const stat = await fs.stat(file);
			return stat.isFile() && stat.size <= MAX_FILE_BYTES ? await fs.readFile(file, 'utf8') : undefined;
		} catch {
			return undefined;
		}
	}

	async list(path: string): Promise<readonly { name: string; directory: boolean }[] | undefined> {
		try {
			const entries = await fs.readdir(join(this._root, path), { withFileTypes: true });
			return entries.map(entry => ({ name: entry.name, directory: entry.isDirectory() }));
		} catch (error) {
			return (error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error as NodeJS.ErrnoException)?.code === 'ENOTDIR' ? [] : undefined;
		}
	}
}

/**
 * A repository's whole file list from one `git/trees?recursive=1` call: path to
 * whether it is a folder. No paths when GitHub cut the list short.
 */
type GitHubTree = { readonly paths: ReadonlyMap<string, boolean> | undefined };

/** Reads a `git/trees` answer. Undefined when it is not one. */
export function parseGitHubTree(body: string): GitHubTree | undefined {
	const tree = parseJson(body);
	if (!tree || !Array.isArray(tree.tree)) {
		return undefined;
	}
	if (tree.truncated === true) {
		return { paths: undefined };
	}
	const paths = new Map<string, boolean>();
	for (const item of tree.tree.map(record)) {
		if (typeof item?.path === 'string') {
			paths.set(item.path, item.type === 'tree');
		}
	}
	return { paths };
}

/**
 * A plugin on GitHub: files from raw.githubusercontent.com, folders from the
 * repository's tree (one API call for every plugin in it), or from the contents
 * API when the tree is too big for one answer.
 */
class GitHubPluginFiles implements PluginFiles {
	constructor(
		private readonly _fetchText: (url: string) => Promise<{ status: number; body?: string }>,
		private readonly _repo: string,
		private readonly _ref: string,
		private readonly _base: string,
		private readonly _tree?: () => Promise<GitHubTree | undefined>,
	) { }

	private path(path: string): string {
		return [this._base, path].filter(part => part.length > 0).join('/');
	}

	async read(path: string): Promise<string | undefined> {
		const tree = await this._tree?.();
		// The tree says which files exist, so a missing hooks.json or .mcp.json costs no request.
		if (tree?.paths && tree.paths.get(this.path(path)) !== false) {
			return undefined;
		}
		const result = await this._fetchText(`https://raw.githubusercontent.com/${this._repo}/${this._ref}/${this.path(path)}`);
		return result.status === 200 && result.body !== undefined && result.body.length <= MAX_FILE_BYTES ? result.body : undefined;
	}

	async list(path: string): Promise<readonly { name: string; directory: boolean }[] | undefined> {
		if (this._tree) {
			const tree = await this._tree();
			if (!tree) {
				return undefined;
			}
			if (tree.paths) {
				const folder = this.path(path);
				if (folder && tree.paths.get(folder) !== true) {
					return [];
				}
				const prefix = folder ? `${folder}/` : '';
				const entries: { name: string; directory: boolean }[] = [];
				for (const [item, directory] of tree.paths) {
					if (item.startsWith(prefix) && !item.slice(prefix.length).includes('/')) {
						entries.push({ name: item.slice(prefix.length), directory });
					}
				}
				return entries;
			}
		}
		const result = await this._fetchText(`https://api.github.com/repos/${this._repo}/contents/${this.path(path)}?ref=${encodeURIComponent(this._ref)}`);
		if (result.status === 404) {
			return [];
		}
		if (result.status !== 200 || result.body === undefined) {
			return undefined;
		}
		try {
			const items: unknown = JSON.parse(result.body);
			if (!Array.isArray(items)) {
				return [];
			}
			return items.map(record).filter(item => typeof item?.name === 'string').map(item => ({ name: item!.name as string, directory: item!.type === 'dir' }));
		} catch {
			return undefined;
		}
	}
}

/** Paths a manifest field names, inside the plugin. A config object yields none. */
function declaredPaths(value: unknown): string[] {
	const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
	return values.filter((item): item is string => typeof item === 'string').map(innerPath).filter((path): path is string => !!path);
}

function parseJson(body: string | undefined): Record<string, unknown> | undefined {
	if (body === undefined) {
		return undefined;
	}
	try {
		return record(JSON.parse(body));
	} catch {
		return undefined;
	}
}

/** Every command of a hooks config, `{ hooks: { Event: [{ matcher, hooks: [{ command }] }] } }` or the inner map. */
export function readClaudePluginHooks(config: unknown): ClaudePluginHook[] {
	const root = record(config);
	const events = record(root?.hooks) ?? root;
	const hooks: ClaudePluginHook[] = [];
	for (const [event, groups] of Object.entries(events ?? {})) {
		if (!Array.isArray(groups)) {
			continue;
		}
		for (const group of groups.map(record)) {
			const matcher = text(group?.matcher);
			for (const hook of Array.isArray(group?.hooks) ? group.hooks.map(record) : []) {
				const command = text(hook?.command) ?? text(hook?.prompt) ?? text(hook?.url);
				if (command) {
					hooks.push({ event, matcher, command });
				}
			}
		}
	}
	return hooks;
}

/** Every server of an MCP config, `{ mcpServers: { name: { command, args, url } } }` or the inner map. */
export function readClaudePluginMcpServers(config: unknown): ClaudePluginMcpServer[] {
	const root = record(config);
	const servers = record(root?.mcpServers) ?? root;
	const result: ClaudePluginMcpServer[] = [];
	for (const [name, value] of Object.entries(servers ?? {})) {
		const server = record(value);
		if (!server) {
			continue;
		}
		const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === 'string') : undefined;
		result.push({ name, command: text(server.command), args: args?.length ? args : undefined, url: text(server.url) });
	}
	return result;
}

/** The `allowed-tools` of a Markdown file's front matter, as a list or a comma-separated line. */
export function readAllowedTools(markdown: string): string[] {
	const match = /^---\r?\n(?<body>[\s\S]*?)\r?\n---/.exec(markdown);
	const lines = match?.groups?.body.split(/\r?\n/) ?? [];
	const index = lines.findIndex(line => /^allowed-tools\s*:/.test(line));
	if (index < 0) {
		return [];
	}
	const inline = lines[index].replace(/^allowed-tools\s*:/, '').trim().replace(/^\[(?<list>.*)\]$/, '$<list>');
	const items: string[] = [];
	if (inline) {
		let depth = 0;
		let current = '';
		for (const char of inline) {
			if (char === ',' && depth === 0) {
				items.push(current);
				current = '';
				continue;
			}
			depth += char === '(' ? 1 : char === ')' ? -1 : 0;
			current += char;
		}
		items.push(current);
	} else {
		for (const line of lines.slice(index + 1)) {
			const item = /^\s*-\s*(?<item>.+)$/.exec(line)?.groups?.item;
			if (!item) {
				break;
			}
			items.push(item);
		}
	}
	return items.map(item => item.trim().replace(/^["']|["']$/g, '')).filter(item => item.length > 0);
}

/**
 * Reads what a plugin adds from its default folders, `plugin.json`, and what the
 * marketplace entry declares. `readTools` also opens each command and skill for
 * its `allowed-tools`, which only details need.
 */
async function readContents(files: PluginFiles, declared: ClaudeDeclaredContents, readTools: boolean): Promise<ClaudePluginContents> {
	const plugin = parseJson(await files.read('.claude-plugin/plugin.json')) ?? {};
	let complete = true;
	const markdown: string[] = [];
	const names = async (folders: string[], depth: number, ext: string, collect: string[]): Promise<void> => {
		for (const folder of folders) {
			if (folder.endsWith(ext)) {
				collect.push(folder.slice(folder.lastIndexOf('/') + 1, -ext.length));
				markdown.push(folder);
				continue;
			}
			const entries = await files.list(folder);
			if (!entries) {
				complete = false;
				continue;
			}
			for (const entry of entries) {
				if (entry.directory && depth > 0) {
					await names([`${folder}/${entry.name}`], depth - 1, ext, collect);
				} else if (!entry.directory && entry.name.endsWith(ext)) {
					collect.push(entry.name.slice(0, -ext.length));
					markdown.push(`${folder}/${entry.name}`);
				}
			}
		}
	};
	const commands: string[] = [];
	const subagents: string[] = [];
	const skills: string[] = [];
	await names(['commands', ...declaredPaths(declared.commands), ...declaredPaths(plugin.commands)], 2, '.md', commands);
	await names(['agents', ...declaredPaths(declared.agents), ...declaredPaths(plugin.agents)], 0, '.md', subagents);
	for (const folder of ['skills', ...declaredPaths(declared.skills), ...declaredPaths(plugin.skills)]) {
		const entries = await files.list(folder);
		if (!entries) {
			complete = false;
			continue;
		}
		if (entries.some(entry => !entry.directory && entry.name === 'SKILL.md')) {
			skills.push(folder.slice(folder.lastIndexOf('/') + 1));
			markdown.push(`${folder}/SKILL.md`);
			continue;
		}
		for (const entry of entries.filter(entry => entry.directory)) {
			skills.push(entry.name);
			markdown.push(`${folder}/${entry.name}/SKILL.md`);
		}
	}

	const hooks: ClaudePluginHook[] = readClaudePluginHooks(parseJson(await files.read('hooks/hooks.json')));
	const mcpServers: ClaudePluginMcpServer[] = readClaudePluginMcpServers(parseJson(await files.read('.mcp.json')));
	for (const value of [declared.hooks, plugin.hooks]) {
		hooks.push(...readClaudePluginHooks(record(value)));
		for (const path of declaredPaths(value)) {
			hooks.push(...readClaudePluginHooks(parseJson(await files.read(path))));
		}
	}
	for (const value of [declared.mcpServers, plugin.mcpServers]) {
		mcpServers.push(...readClaudePluginMcpServers(record(value)));
		for (const path of declaredPaths(value)) {
			mcpServers.push(...readClaudePluginMcpServers(parseJson(await files.read(path))));
		}
	}

	const allowedTools = new Set<string>();
	const toolFiles = readTools ? [...new Set(markdown)] : [];
	for (const path of toolFiles.slice(0, MAX_FRONTMATTER_READS)) {
		const body = await files.read(path);
		for (const tool of body ? readAllowedTools(body) : []) {
			allowedTools.add(tool);
		}
	}
	return {
		skills: [...new Set(skills)],
		subagents: [...new Set(subagents)],
		commands: [...new Set(commands)],
		hooks,
		mcpServers,
		allowedTools: [...allowedTools],
		complete: complete && toolFiles.length <= MAX_FRONTMATTER_READS,
	};
}

/** Where a plugin's files are: a folder on disk, a GitHub folder, or nowhere Klawly can read. */
type PluginLocation =
	| { readonly kind: 'local'; readonly root: string }
	| { readonly kind: 'github'; readonly repo: string; readonly ref: string; readonly path: string }
	| { readonly kind: 'none' };

interface MarketplaceRoot {
	readonly name: string;
	readonly info: Omit<ClaudeMarketplaceInfo, 'pluginCount' | 'error'>;
	/** The marketplace's own files, for plugins with a relative source. */
	readonly location: PluginLocation;
	readonly manifest: () => Promise<string | undefined>;
}

interface LoadedPlugin {
	readonly entry: ClaudePluginEntry;
	readonly location: PluginLocation;
	readonly declared: ClaudeDeclaredContents;
}

interface LoadedCatalog {
	readonly catalog: ClaudePluginCatalog;
	readonly plugins: ReadonlyMap<string, LoadedPlugin>;
	/** Kinds read later from GitHub, with any the catalog cache listed, by plugin id. */
	readonly resolved: Map<string, readonly ClaudePluginKind[]>;
	readonly resolving: Map<string, Promise<readonly ClaudePluginKind[] | undefined>>;
}

/** The settings files a project declares marketplaces in, under `extraKnownMarketplaces`. */
const PROJECT_SETTINGS: readonly (readonly ['project' | 'local', string])[] = [['project', 'settings.json'], ['local', 'settings.local.json']];

async function readFileText(path: string): Promise<string | undefined> {
	try {
		return await fs.readFile(path, 'utf8');
	} catch {
		return undefined;
	}
}

function samePath(a: string, b: string): boolean {
	const normalize = (path: string) => {
		const resolved = resolve(path).replace(/[\\/]+$/, '');
		return isWindows ? resolved.toLowerCase() : resolved;
	};
	return normalize(a) === normalize(b);
}

/** The part of Claude Code's managed settings a team setup uses, merged across the file and its fragments. */
interface ClaudeTeamSettings {
	readonly marketplaces: Record<string, unknown>;
	readonly enabledPlugins: Record<string, unknown>;
}

/**
 * Reads `managed-settings.json`, then each `managed-settings.d/*.json` in name
 * order; a later file wins for the same marketplace or plugin.
 */
async function readManagedTeamSettings(directory: string): Promise<ClaudeTeamSettings> {
	const marketplaces: Record<string, unknown> = {};
	const enabledPlugins: Record<string, unknown> = {};
	let fragments: string[] = [];
	try {
		fragments = (await fs.readdir(join(directory, CLAUDE_MANAGED_SETTINGS_FOLDER))).filter(name => name.toLowerCase().endsWith('.json')).sort();
	} catch {
		// No fragments.
	}
	for (const path of [join(directory, CLAUDE_MANAGED_SETTINGS_FILE), ...fragments.map(name => join(directory, CLAUDE_MANAGED_SETTINGS_FOLDER, name))]) {
		const settings = parseJson(await readFileText(path));
		Object.assign(marketplaces, record(settings?.extraKnownMarketplaces));
		Object.assign(enabledPlugins, record(settings?.enabledPlugins));
	}
	return { marketplaces, enabledPlugins };
}

/** Managed settings make a plugin required; the project's shared settings turn it on by default. Only `true` counts. */
function claudePluginPolicy(id: string, managed: Record<string, unknown> | undefined, project: Record<string, unknown> | undefined): ClaudePluginPolicy | undefined {
	return managed?.[id] === true ? 'required' : project?.[id] === true ? 'defaultOn' : undefined;
}

/**
 * The kinds Claude Code's own catalog cache (`plugins/plugin-catalog-cache.json`,
 * `catalog.plugins[id].components`) lists for a plugin, so kind filters work
 * for plugins whose files are not on disk.
 */
export function readCachedClaudePluginKinds(value: unknown): ClaudePluginKind[] | undefined {
	const components = record(record(value)?.components);
	if (!components) {
		return undefined;
	}
	const kinds: ClaudePluginKind[] = [];
	for (const [key, kind] of [['skills', 'skills'], ['agents', 'subagents'], ['commands', 'commands'], ['hooks', 'hooks'], ['mcpServers', 'mcp']] as const) {
		const list = components[key];
		if (Array.isArray(list) && list.length > 0) {
			kinds.push(kind);
		}
	}
	return kinds;
}

function sourceLabel(source: ClaudePluginSource, marketplace: string): string {
	switch (source.kind) {
		case 'relative': return `${marketplace}/${source.path}`;
		case 'github': return source.path ? `${source.repo}/${source.path}` : source.repo;
		case 'git': return source.path ? `${source.url} (${source.path})` : source.url;
		case 'other': return source.label;
	}
}

function marketplaceSourceLabel(source: Record<string, unknown> | undefined): string {
	return text(source?.repo) ?? text(source?.url) ?? text(source?.path) ?? text(source?.source) ?? '';
}

function joinRelative(base: PluginLocation, path: string): PluginLocation {
	switch (base.kind) {
		case 'local': return { kind: 'local', root: join(base.root, path) };
		case 'github': return { ...base, path: [base.path, path].filter(part => part.length > 0).join('/') };
		case 'none': return base;
	}
}

function pluginLocation(source: ClaudePluginSource, marketplace: PluginLocation): PluginLocation {
	switch (source.kind) {
		case 'relative': return joinRelative(marketplace, source.path);
		case 'github': return { kind: 'github', repo: source.repo, ref: source.sha ?? source.ref ?? 'HEAD', path: source.path ?? '' };
		default: return { kind: 'none' };
	}
}


/**
 * Builds the Discover catalog from Claude Code's added marketplaces (their local
 * clones), the marketplaces the project's settings declare, Klawly's built-in
 * list (fetched with ETags) and the installed plugins. Reads only Claude Code's
 * plugin metadata (`known_marketplaces.json`, `installed_plugins.json`,
 * `plugin-catalog-cache.json`) and the project's `.claude/settings*.json`,
 * never credentials.
 */
export class ClaudePluginCatalogReader {
	private readonly _etags = new Map<string, { readonly etag: string; readonly body: string }>();
	/** Each GitHub repository's tree, read once per catalog. */
	private readonly _trees = new Map<string, Promise<GitHubTree | undefined>>();
	private _cached: { readonly key: string; readonly at: number; readonly value: Promise<LoadedCatalog> } | undefined;
	/** Icons by URL, so plugins under one GitHub account share one fetch. */
	private readonly _icons = new Map<string, { readonly at: number; ttl: number; readonly value: Promise<string | undefined> }>();

	constructor(private readonly _options: ClaudePluginCatalogOptions) { }

	/** Forgets the last catalog, after a `claude plugin` command changed what is installed. */
	invalidate(): void {
		this._cached = undefined;
	}

	async getCatalog(request: ClaudePluginCatalogRequest): Promise<ClaudePluginCatalog> {
		const loaded = await this.load(request);
		if (!loaded.resolved.size) {
			return loaded.catalog;
		}
		const plugins = loaded.catalog.plugins.map(plugin => {
			const kinds = loaded.resolved.get(plugin.id);
			return kinds ? { ...plugin, kinds, kindsPartial: undefined } : plugin;
		});
		return { ...loaded.catalog, plugins };
	}

	async getDetails(id: string, request: ClaudePluginCatalogRequest): Promise<ClaudePluginDetails | undefined> {
		const found = (await this.load({ ...request, refresh: false })).plugins.get(id);
		if (!found) {
			return undefined;
		}
		const files = this.files(found.location);
		if (!files) {
			const contents: ClaudePluginContents = { skills: [], subagents: [], commands: [], hooks: [], mcpServers: [], allowedTools: [], complete: false };
			return { plugin: found.entry, contents };
		}
		const contents = await readContents(files, found.declared, true);
		const readme = await files.read('README.md');
		return { plugin: { ...found.entry, contents }, contents, readme };
	}

	/**
	 * The kinds of the listed plugins. Plugins on GitHub are read through their
	 * repository's tree, at most {@link MAX_RESOLVE} per call; a plugin that could
	 * not be read (a rate limit, a private repository) is left out and tried again
	 * on the next call.
	 */
	async resolveKinds(ids: readonly string[], request: ClaudePluginCatalogRequest): Promise<Record<string, readonly ClaudePluginKind[]>> {
		const loaded = await this.load({ ...request, refresh: false });
		const result: Record<string, readonly ClaudePluginKind[]> = {};
		const queue: string[] = [];
		for (const id of new Set(ids)) {
			const found = loaded.plugins.get(id);
			// Kinds from the catalog cache are only a start (issue 535): the plugin's files are read too.
			const known = found && ((found.entry.kindsPartial ? undefined : knownClaudePluginKinds(found.entry)) ?? loaded.resolved.get(id));
			if (known) {
				result[id] = known;
			} else if (found?.location.kind === 'github' && queue.length < MAX_RESOLVE) {
				queue.push(id);
			}
		}
		const worker = async () => {
			for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
				const kinds = await this.resolveOne(loaded, id);
				if (kinds) {
					result[id] = kinds;
				}
			}
		};
		await Promise.all(Array.from({ length: RESOLVE_CONCURRENCY }, worker));
		return result;
	}

	/**
	 * Issue 534: the icons of these plugins as `data:` URLs, fetched here so the
	 * UI never loads a remote image. Plugins without one, or whose image could
	 * not be read, are left out and show their monogram.
	 */
	async getPluginIcons(ids: readonly string[], request: ClaudePluginCatalogRequest): Promise<Record<string, string>> {
		const fetchBytes = this._options.fetchBytes;
		const result: Record<string, string> = {};
		if (!fetchBytes) {
			return result;
		}
		const loaded = await this.load({ ...request, refresh: false });
		const queue: [string, string][] = [];
		for (const id of new Set(ids)) {
			const url = loaded.plugins.get(id)?.entry.iconUrl;
			if (url && queue.length < MAX_ICONS) {
				queue.push([id, url]);
			}
		}
		const worker = async () => {
			for (let next = queue.shift(); next; next = queue.shift()) {
				const icon = await this.icon(next[1], fetchBytes);
				if (icon) {
					result[next[0]] = icon;
				}
			}
		};
		await Promise.all(Array.from({ length: ICON_CONCURRENCY }, worker));
		return result;
	}

	private icon(url: string, fetchBytes: ClaudeCatalogFetchBytes): Promise<string | undefined> {
		const cached = this._icons.get(url);
		if (cached && this.now() - cached.at < cached.ttl) {
			return cached.value;
		}
		const value = fetchBytes(url).then(result => result.status === 200 && result.body ? claudeIconDataUrl(result.body) : undefined, () => undefined);
		const entry = { at: this.now(), ttl: ICON_TTL_MS, value };
		this._icons.set(url, entry);
		void value.then(icon => {
			entry.ttl = icon ? ICON_TTL_MS : ICON_RETRY_MS;
		});
		return value;
	}

	/** The plugins installed for you, and in `cwd`, with what each adds, read from their install folders. */
	async getInstalled(cwd: string | undefined): Promise<ClaudeInstalledPlugin[]> {
		const installedFile = await this.readJson(join(this._options.configDirectory, 'plugins', 'installed_plugins.json'));
		const result: ClaudeInstalledPlugin[] = [];
		for (const [id, value] of Object.entries(record(installedFile?.plugins) ?? {})) {
			const install = this.readInstall(value, cwd);
			const at = id.indexOf('@');
			const name = at > 0 ? id.slice(0, at) : id;
			if (!install?.path || !NAME.test(name)) {
				continue;
			}
			result.push({ id, name, scope: install.install.scope, contents: await readContents(new LocalPluginFiles(install.path), {}, false) });
		}
		return result;
	}

	/**
	 * A folder with the plugin's files, for one session to try it without
	 * installing it: its own folder when it is on disk, else a copy of its GitHub
	 * folder in {@link ClaudePluginCatalogOptions.trialDirectory}. Undefined when
	 * Klawly cannot read every file (a cut-short tree, a missing or large file).
	 */
	async preparePluginTrial(id: string, request: ClaudePluginCatalogRequest): Promise<string | undefined> {
		const location = (await this.load({ ...request, refresh: false })).plugins.get(id)?.location;
		if (location?.kind === 'local') {
			return location.root;
		}
		const trials = this._options.trialDirectory;
		const fetchBytes = this._options.fetchBytes;
		const at = id.indexOf('@');
		if (location?.kind !== 'github' || !trials || !fetchBytes || at <= 0) {
			return undefined;
		}
		const paths = (await this.tree(location.repo, location.ref))?.paths;
		const prefix = location.path ? `${location.path}/` : '';
		const files = [...paths ?? []].filter(([path, directory]) => !directory && path.startsWith(prefix)).map(([path]) => path.slice(prefix.length));
		if (!files.length || files.length > MAX_TRIAL_FILES || files.some(file => innerPath(file) !== file)) {
			return undefined;
		}
		const bodies: VSBuffer[] = [];
		for (const file of files) {
			const result = await fetchBytes(`https://raw.githubusercontent.com/${location.repo}/${location.ref}/${prefix}${file}`).catch(() => undefined);
			if (result?.status !== 200 || result.body === undefined || result.body.byteLength > MAX_FILE_BYTES) {
				return undefined;
			}
			bodies.push(result.body);
		}
		const segment = (value: string) => value.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_');
		const target = join(trials, segment(id.slice(at + 1)), segment(id.slice(0, at)));
		await fs.rm(target, { recursive: true, force: true });
		for (let i = 0; i < files.length; i++) {
			const file = join(target, files[i]);
			await fs.mkdir(dirname(file), { recursive: true });
			await fs.writeFile(file, bodies[i].buffer);
		}
		return target;
	}

	private resolveOne(loaded: LoadedCatalog, id: string): Promise<readonly ClaudePluginKind[] | undefined> {
		let pending = loaded.resolving.get(id);
		if (!pending) {
			const found = loaded.plugins.get(id);
			const files = found && this.files(found.location);
			pending = (async () => {
				if (!found || !files) {
					return undefined;
				}
				const contents = await readContents(files, found.declared, false);
				const read = claudePluginKinds(contents);
				// A folder that could not be listed may hide a kind, so an empty partial read proves nothing.
				if (!contents.complete && read.length === 0) {
					return undefined;
				}
				// Neither the catalog cache nor the files alone prove a kind is absent.
				const kinds = unionClaudePluginKinds(found.entry.kinds ?? [], read);
				loaded.resolved.set(id, kinds);
				return kinds;
			})().catch(() => undefined);
			loaded.resolving.set(id, pending);
			void pending.then(kinds => {
				if (!kinds) {
					loaded.resolving.delete(id);
				}
			});
		}
		return pending;
	}

	private now(): number {
		return this._options.now?.() ?? Date.now();
	}

	private load(request: ClaudePluginCatalogRequest): Promise<LoadedCatalog> {
		const key = `${request.builtIn === true}|${request.cwd ?? ''}`;
		const cached = this._cached;
		if (!request.refresh && cached && cached.key === key && this.now() - cached.at < CATALOG_TTL_MS) {
			return cached.value;
		}
		const value = this.read(request.builtIn === true, request.cwd);
		this._cached = { key, at: this.now(), value };
		value.catch(() => {
			if (this._cached?.value === value) {
				this._cached = undefined;
			}
		});
		return value;
	}

	/** A plugin's files. `useTree` reads GitHub folders from the repository tree; a lone manifest read skips it. */
	private files(location: PluginLocation, useTree = true): PluginFiles | undefined {
		switch (location.kind) {
			case 'local': return new LocalPluginFiles(location.root);
			case 'github': return new GitHubPluginFiles(url => this.fetchText(url), location.repo, location.ref, location.path, useTree ? () => this.tree(location.repo, location.ref) : undefined);
			case 'none': return undefined;
		}
	}

	/** One `git/trees?recursive=1` call per repository and ref, for every plugin in it. Undefined when it failed. */
	private tree(repo: string, ref: string): Promise<GitHubTree | undefined> {
		const key = `${repo}@${ref}`;
		let tree = this._trees.get(key);
		if (!tree) {
			tree = this.fetchText(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`)
				.then(result => result.status === 200 && result.body !== undefined ? parseGitHubTree(result.body) : undefined);
			this._trees.set(key, tree);
		}
		return tree;
	}

	/** A GET that sends the last ETag and reuses the cached body on 304. */
	private async fetchText(url: string): Promise<{ status: number; body?: string }> {
		const cached = this._etags.get(url);
		let result: ClaudeCatalogFetchResult;
		try {
			result = await this._options.fetch(url, cached?.etag);
		} catch {
			return { status: 0 };
		}
		if (result.status === 304 && cached) {
			return { status: 200, body: cached.body };
		}
		if (result.status === 200 && result.body !== undefined && result.etag) {
			this._etags.delete(url);
			this._etags.set(url, { etag: result.etag, body: result.body });
			if (this._etags.size > MAX_ETAG_ENTRIES) {
				this._etags.delete(this._etags.keys().next().value!);
			}
		}
		return { status: result.status, body: result.body };
	}

	private async readJson(path: string): Promise<Record<string, unknown> | undefined> {
		return parseJson(await readFileText(path));
	}

	/** A marketplace a project or managed settings file declares that Claude Code has not added here yet. Relative paths start at `cwd`. */
	private declaredRoot(name: string, source: Record<string, unknown> | undefined, cwd: string, declaredIn: 'project' | 'local' | 'managed'): MarketplaceRoot {
		const repo = text(source?.repo);
		const url = text(source?.url);
		const path = text(source?.path);
		const ref = text(source?.ref) && REF.test(source?.ref as string) ? source?.ref as string : 'HEAD';
		const githubUrl = url && source?.source === 'git' ? GITHUB_URL.exec(url)?.groups : undefined;
		const githubRepo = source?.source === 'github' && repo && REPO.test(repo) ? repo : githubUrl ? `${githubUrl.owner}/${githubUrl.repo}` : undefined;
		const info = { name, source: marketplaceSourceLabel(source), added: false, builtIn: CLAUDE_BUILT_IN_MARKETPLACES.some(item => item.name === name || item.repo === githubRepo), declaredIn };
		if (githubRepo) {
			const location: PluginLocation = { kind: 'github', repo: githubRepo, ref, path: '' };
			return { name, info, location, manifest: () => this.files(location, false)!.read('.claude-plugin/marketplace.json') };
		}
		if (source?.source === 'directory' && path) {
			const root = isAbsolute(path) ? path : resolve(cwd, path);
			return { name, info, location: { kind: 'local', root }, manifest: () => readFileText(join(root, '.claude-plugin', 'marketplace.json')) };
		}
		if (source?.source === 'file' && path) {
			return { name, info, location: { kind: 'none' }, manifest: () => readFileText(isAbsolute(path) ? path : resolve(cwd, path)) };
		}
		if (source?.source === 'url' && url && /^https:\/\//i.test(url)) {
			return { name, info, location: { kind: 'none' }, manifest: async () => (await this.fetchText(url)).body };
		}
		return { name, info, location: { kind: 'none' }, manifest: async () => undefined };
	}

	private async read(builtIn: boolean, cwd: string | undefined): Promise<LoadedCatalog> {
		this._trees.clear();
		const pluginsFolder = join(this._options.configDirectory, 'plugins');
		const known = await this.readJson(join(pluginsFolder, 'known_marketplaces.json')) ?? {};
		const installedFile = await this.readJson(join(pluginsFolder, 'installed_plugins.json'));
		const installed = record(installedFile?.plugins) ?? {};
		const cachedCatalog = record(record((await this.readJson(join(pluginsFolder, 'plugin-catalog-cache.json')))?.catalog)?.plugins) ?? {};

		const roots: MarketplaceRoot[] = [];
		for (const [name, value] of Object.entries(known)) {
			const entry = record(value);
			const location = text(entry?.installLocation);
			if (!NAME.test(name) || !location) {
				continue;
			}
			const source = record(entry?.source);
			const repo = text(source?.repo);
			const isFile = location.toLowerCase().endsWith('.json');
			roots.push({
				name,
				info: { name, source: marketplaceSourceLabel(source), added: true, builtIn: CLAUDE_BUILT_IN_MARKETPLACES.some(item => item.name === name || item.repo === repo) },
				location: isFile ? { kind: 'none' } : { kind: 'local', root: location },
				manifest: () => readFileText(isFile ? location : join(location, '.claude-plugin', 'marketplace.json')),
			});
		}
		// The first file to declare a marketplace names where it comes from: managed settings, then the project's.
		const declare = (marketplaces: Record<string, unknown> | undefined, base: string, declaredIn: 'project' | 'local' | 'managed') => {
			for (const [name, value] of Object.entries(marketplaces ?? {})) {
				const index = roots.findIndex(root => root.name === name);
				if (index >= 0) {
					roots[index] = { ...roots[index], info: { ...roots[index].info, declaredIn: roots[index].info.declaredIn ?? declaredIn } };
				} else if (NAME.test(name)) {
					roots.push(this.declaredRoot(name, record(record(value)?.source), base, declaredIn));
				}
			}
		};
		let managed: ClaudeTeamSettings | undefined;
		if (this._options.managedDirectory) {
			managed = await readManagedTeamSettings(this._options.managedDirectory);
			declare(managed.marketplaces, this._options.managedDirectory, 'managed');
		}
		let teamPlugins: Record<string, unknown> | undefined;
		if (cwd) {
			for (const [declaredIn, file] of PROJECT_SETTINGS) {
				const settings = await this.readJson(join(cwd, '.claude', file));
				declare(record(settings?.extraKnownMarketplaces), cwd, declaredIn);
				if (declaredIn === 'project') {
					teamPlugins = record(settings?.enabledPlugins);
				}
			}
		}
		if (builtIn) {
			for (const item of CLAUDE_BUILT_IN_MARKETPLACES) {
				if (roots.some(root => root.info.builtIn && (root.name === item.name || root.info.source === item.repo))) {
					continue;
				}
				const location: PluginLocation = { kind: 'github', repo: item.repo, ref: 'HEAD', path: '' };
				roots.push({
					name: item.name,
					info: { name: item.name, source: item.repo, added: false, builtIn: true },
					location,
					manifest: () => this.files(location, false)!.read('.claude-plugin/marketplace.json'),
				});
			}
		}

		const marketplaces: ClaudeMarketplaceInfo[] = [];
		const plugins = new Map<string, LoadedPlugin>();
		for (const root of roots) {
			const body = await root.manifest();
			const manifest = body === undefined ? undefined : parseClaudeMarketplaceManifest(body);
			if (!manifest) {
				marketplaces.push({ ...root.info, pluginCount: 0, error: body === undefined ? 'The marketplace manifest could not be read.' : 'The marketplace manifest is not valid.' });
				continue;
			}
			marketplaces.push({ ...root.info, pluginCount: manifest.plugins.length });
			for (const plugin of manifest.plugins) {
				const id = `${plugin.name}@${root.name}`;
				const install = this.readInstall(installed[id], cwd);
				const location: PluginLocation = install?.path ? { kind: 'local', root: install.path } : pluginLocation(plugin.source, root.location);
				// Only files on disk are read for the list. Other plugins take their kinds from Claude Code's
				// catalog cache, or from `resolveKinds` once a kind filter needs them.
				const contents = location.kind === 'local' ? await readContents(new LocalPluginFiles(location.root), plugin.declared, false) : undefined;
				const cachedKinds = contents ? undefined : readCachedClaudePluginKinds(cachedCatalog[id]);
				const sha = plugin.source.kind === 'github' || plugin.source.kind === 'git' ? plugin.source.sha : undefined;
				const updateAvailable = !!install && ((!!plugin.version && !!install.install.version && plugin.version !== install.install.version) || (!!sha && !!install.sha && !install.sha.startsWith(sha) && !sha.startsWith(install.sha)));
				const entry: ClaudePluginEntry = {
					id,
					name: plugin.name,
					displayName: plugin.displayName,
					marketplace: root.name,
					description: plugin.description,
					author: plugin.author,
					category: plugin.category,
					homepage: plugin.homepage,
					version: plugin.version,
					iconUrl: claudePluginIconUrl(plugin),
					source: sourceLabel(plugin.source, root.name),
					contents,
					kinds: cachedKinds,
					kindsPartial: cachedKinds && location.kind === 'github' ? true : undefined,
					installed: install?.install,
					updateAvailable,
					policy: claudePluginPolicy(id, managed?.enabledPlugins, teamPlugins),
				};
				plugins.set(id, { entry, location, declared: plugin.declared });
			}
		}
		return { catalog: { marketplaces, plugins: [...plugins.values()].map(plugin => plugin.entry) }, plugins, resolved: new Map(), resolving: new Map() };
	}

	/**
	 * The install that applies here: yours (or a managed one) first, else a project
	 * or local install whose `projectPath` is `cwd`. Installs in other projects do not count.
	 */
	private readInstall(value: unknown, cwd: string | undefined): { install: ClaudePluginInstall; path?: string; sha?: string } | undefined {
		const installs = Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => !!item) : [];
		const install = installs.find(item => item.scope === 'user')
			?? installs.find(item => item.scope === 'managed')
			?? installs.find(item => !!cwd && typeof item.projectPath === 'string' && samePath(item.projectPath, cwd));
		if (!install) {
			return undefined;
		}
		return {
			install: { scope: text(install.scope) ?? 'user', version: text(install.version) },
			path: text(install.installPath),
			sha: text(install.gitCommitSha),
		};
	}
}
