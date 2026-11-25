/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { dirname, isAbsolute, join, resolve, sep } from '../../../base/common/path.js';
import { klawlyProjectIdentityFromAlias, klawlyProjectIdentityFromRemote, klawlyProjectIdentitySlug } from '../common/klawlySyncProjectIdentity.js';

/** The machine-local table from a project folder to its alias (a project with no git remote). It is never synced. */
export const CLAUDE_PROJECT_IDENTITIES_FILE = 'project-identities.json';

/** The most memory a session reads into its prompt: a note larger than this is cut, and notes past the total are left out. */
const MAX_NOTE_CHARS = 16 * 1024;
const MAX_TOTAL_CHARS = 64 * 1024;

export interface ClaudeProjectMemory {
	readonly identity: string;
	/** The folder the agent reads and writes notes in: `<layer>/memory/<slug>`. */
	readonly directory: string;
	/** The system prompt part. */
	readonly prompt: string;
}

/** The URL of `origin` (or the first remote) in a git config file, read as text so no `git` process runs. */
export function parseGitConfigRemote(config: string): string | undefined {
	let section: string | undefined;
	let first: string | undefined;
	for (const raw of config.split(/\r?\n/)) {
		const line = raw.trim();
		const header = /^\[remote\s+"(?<name>[^"]+)"\]$/.exec(line);
		if (header?.groups) {
			section = header.groups.name;
			continue;
		}
		if (line.startsWith('[')) {
			section = undefined;
			continue;
		}
		const url = section ? /^url\s*=\s*(?<value>.+)$/.exec(line) : null;
		if (url?.groups) {
			if (section === 'origin') {
				return url.groups.value.trim();
			}
			first ??= url.groups.value.trim();
		}
	}
	return first;
}

/** Walks up from `cwd` to the repository and returns its remote URL. A linked worktree reads the shared config. */
export async function readGitRemote(cwd: string): Promise<string | undefined> {
	let dir = resolve(cwd);
	for (; ;) {
		const dotGit = join(dir, '.git');
		const stat = await fs.stat(dotGit).catch(() => undefined);
		if (stat) {
			let gitDir = dotGit;
			if (stat.isFile()) {
				const pointer = /^gitdir:\s*(?<path>.+)$/m.exec(await fs.readFile(dotGit, 'utf8').catch(() => ''));
				if (!pointer?.groups) {
					return undefined;
				}
				gitDir = resolve(dir, pointer.groups.path.trim());
				const common = (await fs.readFile(join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
				if (common) {
					gitDir = resolve(gitDir, common);
				}
			}
			const config = await fs.readFile(join(gitDir, 'config'), 'utf8').catch(() => undefined);
			return config === undefined ? undefined : parseGitConfigRemote(config);
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

export type ClaudeProjectIdentityTable = Readonly<Record<string, string>>;

export async function readClaudeProjectIdentityTable(layerDirectory: string): Promise<ClaudeProjectIdentityTable> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(join(layerDirectory, CLAUDE_PROJECT_IDENTITIES_FILE), 'utf8'));
		const table: Record<string, string> = {};
		if (parsed && typeof parsed === 'object') {
			for (const [folder, alias] of Object.entries(parsed)) {
				if (typeof alias === 'string' && isAbsolute(folder)) {
					table[folder] = alias;
				}
			}
		}
		return table;
	} catch {
		return {};
	}
}

/** Names a project folder: every session under it takes the alias as its identity. An empty alias removes the entry. */
export async function setClaudeProjectIdentity(layerDirectory: string, folder: string, alias: string): Promise<void> {
	const table: Record<string, string> = { ...await readClaudeProjectIdentityTable(layerDirectory) };
	const key = resolve(folder);
	if (alias.trim()) {
		table[key] = alias.trim();
	} else {
		delete table[key];
	}
	await fs.mkdir(layerDirectory, { recursive: true });
	await fs.writeFile(join(layerDirectory, CLAUDE_PROJECT_IDENTITIES_FILE), JSON.stringify(table, undefined, '\t') + '\n');
}

function isInside(folder: string, root: string): boolean {
	const normalize = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
	const f = normalize(folder);
	const r = normalize(root);
	return f === r || f.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** The identity of the project at `cwd`: its git remote, else the alias of the closest named folder above it. */
export async function resolveClaudeProjectIdentity(layerDirectory: string, cwd: string): Promise<string | undefined> {
	const remote = await readGitRemote(cwd).catch(() => undefined);
	const fromRemote = remote ? klawlyProjectIdentityFromRemote(remote) : undefined;
	if (fromRemote) {
		return fromRemote;
	}
	const table = await readClaudeProjectIdentityTable(layerDirectory);
	const folder = resolve(cwd);
	const closest = Object.keys(table).filter(root => isInside(folder, root)).sort((a, b) => b.length - a.length)[0];
	return closest ? klawlyProjectIdentityFromAlias(table[closest]) : undefined;
}

/** The synced notes of the project at `cwd`, as a system prompt part. Undefined when the project has no identity. */
export async function resolveClaudeProjectMemory(layerDirectory: string, cwd: string): Promise<ClaudeProjectMemory | undefined> {
	const identity = await resolveClaudeProjectIdentity(layerDirectory, cwd);
	if (!identity) {
		return undefined;
	}
	const directory = join(layerDirectory, 'memory', klawlyProjectIdentitySlug(identity));
	const names = (await fs.readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.md')).sort();
	const notes: string[] = [];
	let total = 0;
	for (const name of names) {
		const text = (await fs.readFile(join(directory, name), 'utf8').catch(() => '')).trim();
		if (!text || total >= MAX_TOTAL_CHARS) {
			continue;
		}
		const body = text.slice(0, MAX_NOTE_CHARS);
		total += body.length;
		notes.push(`### ${name}\n${body}`);
	}
	const prompt = [
		`Project memory for ${identity} (synced across the user's machines by Klawly Sync). Save what is worth remembering for this project as short Markdown notes in ${directory}, one fact per file. Never put secrets in a note.`,
		...notes.length ? notes : ['(no notes yet)'],
	].join('\n\n');
	return { identity, directory, prompt };
}
