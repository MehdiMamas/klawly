/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { Dirent, promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, relative, resolve, sep } from '../../../base/common/path.js';
import { isLinux } from '../../../base/common/platform.js';
import { CLAUDE_AGENTS_SKILLS_PLUGIN, ClaudeAgentsFilesSettings, ClaudeInstructionSource } from '../common/claudeAgentsFiles.js';
import { NormalizedClaudeEvent } from '../common/claudeProtocol.js';

/** Characters of the root AGENTS.md the system prompt carries; Claude reads the rest itself. */
export const AGENTS_MD_MAX_CHARS = 40_000;
/** Claude Code follows CLAUDE.md imports this many levels deep. */
const IMPORT_MAX_DEPTH = 5;
/** A file larger than this is never read for imports. */
const IMPORT_MAX_BYTES = 1024 * 1024;
/** How far the nested AGENTS.md search goes, so a large repository starts quickly. */
const NESTED_MAX_DEPTH = 6;
const NESTED_MAX_FOLDERS = 3000;
const NESTED_MAX_FILES = 50;

export interface ClaudeAgentsFilesRequest {
	/** The session's working folder, where `AGENTS.md` and `.agents/skills` are looked up. */
	readonly cwd: string;
	readonly settings: ClaudeAgentsFilesSettings;
	/** Folder the `.agents/skills` plugin is linked under, one subfolder per workspace. */
	readonly pluginRoot: string;
	/** Resolves `~/` imports and the user CLAUDE.md. Defaults to the OS home. */
	readonly homeDirectory?: string;
}

/** What a query passes to Claude Code besides its own CLAUDE.md and skills. */
export interface ClaudeAgentsFiles {
	/** Text the query adds to its system prompt. Absent adds nothing. */
	readonly systemPrompt?: string;
	/** A plugin folder whose only content is a link to `.agents/skills`. */
	readonly plugin?: string;
	readonly sources: readonly ClaudeInstructionSource[];
}

/**
 * Finds the workspace's `AGENTS.md` files and `.agents/skills` (issue 499).
 * The root `AGENTS.md` goes in the system prompt unless a CLAUDE.md Claude Code
 * loads already imports it; nested ones are listed for Claude to read where it
 * works. `.agents/skills` becomes a plugin whose only folder links to it, so
 * Claude Code loads the skills in place and nothing is copied into `.claude`.
 */
export async function resolveClaudeAgentsFiles(request: ClaudeAgentsFilesRequest): Promise<ClaudeAgentsFiles> {
	const cwd = resolve(request.cwd);
	const home = request.homeDirectory ?? homedir();
	const sources: ClaudeInstructionSource[] = [];
	const prompt: string[] = [];
	if (request.settings.instructions) {
		const loaded = await claudeMdFiles(cwd, home);
		const root = join(cwd, 'AGENTS.md');
		const text = await readText(root);
		if (text?.trim() && !await isImported(root, loaded, home)) {
			prompt.push(agentsMdPrompt(root, text));
			sources.push({ kind: 'agentsMd', path: 'AGENTS.md' });
		}
		const nested: string[] = [];
		for (const file of await findNestedAgentsMd(cwd)) {
			// Claude Code reads a folder's own CLAUDE.md when it works there, so its import counts too.
			const folder = dirname(file);
			if (!await isImported(file, [...loaded, join(folder, 'CLAUDE.md'), join(folder, '.claude', 'CLAUDE.md'), join(folder, 'CLAUDE.local.md')], home)) {
				nested.push(workspacePath(cwd, file));
			}
		}
		if (nested.length) {
			prompt.push(nestedAgentsMdPrompt(nested));
			sources.push(...nested.map(path => ({ kind: 'agentsMd' as const, path, nested: true as const })));
		}
	}
	let plugin: string | undefined;
	if (request.settings.skills) {
		const skills = join(cwd, '.agents', 'skills');
		if (await hasSkills(skills)) {
			plugin = await linkSkillsPlugin(skills, request.pluginRoot, cwd);
			if (plugin) {
				sources.push({ kind: 'agentsSkills', path: '.agents/skills' });
			}
		}
	}
	return { systemPrompt: prompt.length ? prompt.join('\n\n') : undefined, plugin, sources };
}

/** Adds the sources to the main conversation's `session.started`, so the inspector shows what was sent. */
export function withClaudeInstructionSources(event: NormalizedClaudeEvent, sources: readonly ClaudeInstructionSource[] | undefined): NormalizedClaudeEvent {
	return event.type === 'session.started' && event.parentRunId === undefined && sources?.length ? { ...event, instructions: sources } : event;
}

/** The `@path` imports of a CLAUDE.md as Claude Code reads them: never inside a code span or a fenced block. */
export function claudeMdImports(text: string): string[] {
	const imports: string[] = [];
	let fenced = false;
	for (const line of text.split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) {
			continue;
		}
		for (const match of line.replace(/`[^`]*`/g, ' ').matchAll(/(?:^|\s)@(?<path>\S+)/g)) {
			imports.push(match.groups!.path);
		}
	}
	return imports;
}

/** The CLAUDE.md files Claude Code loads at session start: the working folder and every folder above it, its rules, and the user's own. */
async function claudeMdFiles(cwd: string, home: string): Promise<string[]> {
	const files: string[] = [];
	for (let folder = cwd; ; folder = dirname(folder)) {
		files.push(join(folder, 'CLAUDE.md'), join(folder, '.claude', 'CLAUDE.md'), join(folder, 'CLAUDE.local.md'));
		if (dirname(folder) === folder) {
			break;
		}
	}
	const rules = join(cwd, '.claude', 'rules');
	const entries = await fs.readdir(rules).catch(() => []);
	files.push(...entries.filter(name => name.endsWith('.md')).map(name => join(rules, name)));
	files.push(join(home, '.claude', 'CLAUDE.md'));
	return files;
}

async function isImported(target: string, files: readonly string[], home: string): Promise<boolean> {
	const seen = new Set<string>();
	for (const file of files) {
		if (await importsFile(file, pathKey(target), home, 0, seen)) {
			return true;
		}
	}
	return false;
}

async function importsFile(file: string, target: string, home: string, depth: number, seen: Set<string>): Promise<boolean> {
	const key = pathKey(file);
	if (depth > IMPORT_MAX_DEPTH || seen.has(key)) {
		return false;
	}
	seen.add(key);
	const text = await readText(file);
	if (text === undefined) {
		return false;
	}
	for (const path of claudeMdImports(text)) {
		const imported = path.startsWith('~/') ? join(home, path.slice(2)) : isAbsolute(path) ? resolve(path) : resolve(dirname(file), path);
		if (pathKey(imported) === target || await importsFile(imported, target, home, depth + 1, seen)) {
			return true;
		}
	}
	return false;
}

/** `AGENTS.md` files below the working folder, outside dot folders and dependencies, sorted. */
async function findNestedAgentsMd(cwd: string): Promise<string[]> {
	const found: string[] = [];
	let level = [cwd];
	let folders = 0;
	for (let depth = 0; depth <= NESTED_MAX_DEPTH && level.length && folders < NESTED_MAX_FOLDERS; depth++) {
		level = level.slice(0, NESTED_MAX_FOLDERS - folders);
		folders += level.length;
		const listed = await Promise.all(level.map(folder => fs.readdir(folder, { withFileTypes: true }).catch((): Dirent[] => [])));
		const next: string[] = [];
		listed.forEach((entries, index) => {
			for (const entry of entries) {
				if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
					next.push(join(level[index], entry.name));
				} else if (depth > 0 && entry.isFile() && entry.name === 'AGENTS.md') {
					found.push(join(level[index], entry.name));
				}
			}
		});
		level = next;
	}
	return found.sort().slice(0, NESTED_MAX_FILES);
}

/** True when the folder has at least one `<name>/SKILL.md`. */
async function hasSkills(folder: string): Promise<boolean> {
	const entries = await fs.readdir(folder).catch((): string[] => []);
	for (const name of entries) {
		if (await fs.stat(join(folder, name, 'SKILL.md')).then(stat => stat.isFile(), () => false)) {
			return true;
		}
	}
	return false;
}

/**
 * A plugin folder for this workspace whose `skills` links to `.agents/skills`.
 * Only `skills` is linked, so commands, hooks or MCP servers that sit next to
 * it in `.agents` never load. Undefined when the link cannot be made.
 */
async function linkSkillsPlugin(skills: string, root: string, cwd: string): Promise<string | undefined> {
	const plugin = join(root, createHash('sha256').update(pathKey(cwd)).digest('hex').slice(0, 16));
	const link = join(plugin, 'skills');
	try {
		await fs.mkdir(join(plugin, '.claude-plugin'), { recursive: true });
		await fs.writeFile(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: CLAUDE_AGENTS_SKILLS_PLUGIN, description: 'Skills from the workspace .agents/skills folder' }, undefined, '\t'));
		const current = await fs.readlink(link).catch(() => undefined);
		if (current === undefined || pathKey(resolve(plugin, current)) !== pathKey(skills)) {
			if (current !== undefined) {
				// Never recursive: removing the link must not touch the folder it points to.
				await fs.unlink(link).catch(() => fs.rmdir(link));
			}
			// A junction on Windows needs no admin rights; elsewhere the type is ignored.
			await fs.symlink(skills, link, 'junction');
		}
		return plugin;
	} catch {
		return undefined;
	}
}

function agentsMdPrompt(file: string, text: string): string {
	const body = text.length > AGENTS_MD_MAX_CHARS ? `${text.slice(0, AGENTS_MD_MAX_CHARS)}\n\n[AGENTS.md is cut here. Read ${file} for the rest.]` : text;
	return `Contents of ${file} (project instructions from AGENTS.md, followed like CLAUDE.md):\n\n${body.trim()}`;
}

function nestedAgentsMdPrompt(paths: readonly string[]): string {
	return [
		'These folders have their own AGENTS.md with instructions for the files under them. Before you work on files in one of these folders, read the AGENTS.md closest to those files: it adds to the ones above it and wins where they disagree.',
		...paths.map(path => `- ${path}`),
	].join('\n');
}

function workspacePath(cwd: string, file: string): string {
	return relative(cwd, file).split(sep).join('/');
}

async function readText(file: string): Promise<string | undefined> {
	try {
		const stat = await fs.stat(file);
		return stat.isFile() && stat.size <= IMPORT_MAX_BYTES ? await fs.readFile(file, 'utf8') : undefined;
	} catch {
		return undefined;
	}
}

/** Paths compare case-insensitively where the file system usually does. */
function pathKey(path: string): string {
	const normalized = resolve(path);
	return isLinux ? normalized : normalized.toLowerCase();
}
