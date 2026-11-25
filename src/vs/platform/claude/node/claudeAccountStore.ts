/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { basename, dirname, join } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { CLAUDE_DEFAULT_ACCOUNT_ID } from '../common/claudeAccounts.js';

/** The folder under Klawly's user data that holds one folder per added Claude account (issue 450). */
export const CLAUDE_ACCOUNTS_FOLDER = 'claude-accounts';

/**
 * Folders of Claude Code's own folder an account folder links to, so every
 * account sees the same transcripts, memory, plans and Claude Code setup.
 * Everything else in the account folder, such as its sign-in, is its own.
 */
const SHARED_FOLDERS: readonly string[] = ['projects', 'plans', 'skills', 'agents', 'commands', 'rules', 'output-styles', 'plugins', 'file-history', 'todos', 'ide', 'session-env', 'model-router', 'session-manager', 'session-manager-cache', 'gaming', 'pause', 'handoffs', 'jobs', 'personal-state', 'dev-mods', 'chat-links'];

/**
 * Files shared the same way. Windows links a file only with Developer Mode on, so
 * there a file falls back to a hard link (same volume, no rights needed), then to a
 * copy, and is shared again before each switch (issue 1180).
 */
const SHARED_FILES: readonly string[] = ['CLAUDE.md', 'settings.json', 'history.jsonl'];

/** The per-project keys of `.claude.json` that carry trust and approvals, copied into each account (issue 1180). */
const SHARED_PROJECT_KEYS: readonly string[] = ['hasTrustDialogAccepted', 'hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'allowedTools'];

/** One added account as Klawly keeps it: what Claude Code reported when it signed in. */
export interface ClaudeSavedAccount {
	readonly id: string;
	readonly email?: string;
	readonly plan?: string;
	readonly organization?: string;
}

export interface ClaudeSavedAccounts {
	/** The account new sessions use. Absent means the default one. */
	readonly active?: string;
	readonly accounts: readonly ClaudeSavedAccount[];
}

const ACCOUNT_ID = /^[a-z0-9-]{1,64}$/;

/**
 * The added Claude accounts and their folders (issue 450). Each account signs in
 * inside its own folder, passed to Claude Code as `CLAUDE_CONFIG_DIR`. Klawly never
 * writes Claude Code's own folder: it only links to it, and removing an account
 * removes the links, never what they point to.
 */
export class ClaudeAccountStore {

	/**
	 * @param root `<userData>/claude-accounts`.
	 * @param claudeDirectory Claude Code's own folder, `~/.claude` or `CLAUDE_CONFIG_DIR`.
	 */
	constructor(private readonly root: string, private readonly claudeDirectory: string) { }

	/** The folder of one added account. Throws for the default account or a malformed id. */
	directory(id: string): string {
		if (id === CLAUDE_DEFAULT_ACCOUNT_ID || !ACCOUNT_ID.test(id)) {
			throw new Error(`Not a Klawly Claude account: ${id}`);
		}
		return join(this.root, id);
	}

	/** The saved accounts. A missing or broken list reads as none, on the default account. */
	async read(): Promise<ClaudeSavedAccounts> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await fs.readFile(join(this.root, 'accounts.json'), 'utf8'));
		} catch {
			return { accounts: [] };
		}
		const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
		const accounts = (Array.isArray(record.accounts) ? record.accounts : []).flatMap((value): ClaudeSavedAccount[] => {
			const entry = value && typeof value === 'object' ? value as Record<string, unknown> : {};
			if (typeof entry.id !== 'string' || !ACCOUNT_ID.test(entry.id) || entry.id === CLAUDE_DEFAULT_ACCOUNT_ID) {
				return [];
			}
			return [{ id: entry.id, email: optionalString(entry.email), plan: optionalString(entry.plan), organization: optionalString(entry.organization) }];
		});
		const active = typeof record.active === 'string' && accounts.some(account => account.id === record.active) ? record.active : undefined;
		return { active, accounts };
	}

	/** Saves the list, replacing the file in one step so a crash never leaves half of it. */
	async write(saved: ClaudeSavedAccounts): Promise<void> {
		await fs.mkdir(this.root, { recursive: true });
		const file = join(this.root, 'accounts.json');
		const temporary = `${file}.${generateUuid()}.tmp`;
		await fs.writeFile(temporary, JSON.stringify({ active: saved.active, accounts: saved.accounts }, undefined, '\t'));
		await fs.rename(temporary, file);
	}

	/** Makes a new account folder, linked to Claude Code's own, and returns its id. */
	async create(): Promise<string> {
		const id = generateUuid();
		await fs.mkdir(this.directory(id), { recursive: true });
		await this.link(id);
		return id;
	}

	/**
	 * Links what the account shares with Claude Code's own folder. Only entries
	 * that exist there and not yet here: it runs again before each switch, so a
	 * folder Claude Code made later is linked then. Returns what it linked.
	 */
	async link(id: string): Promise<string[]> {
		const directory = this.directory(id);
		const linked: string[] = [];
		for (const [name, folder] of [...SHARED_FOLDERS.map(name => [name, true] as const), ...SHARED_FILES.map(name => [name, false] as const)]) {
			const target = join(this.claudeDirectory, name);
			const path = join(directory, name);
			if (!await isKind(target, folder)) {
				continue;
			}
			const present = await lstatOrUndefined(path);
			if (present?.isSymbolicLink()) {
				continue;
			}
			if (present && folder) {
				continue;
			}
			if (present && !await replaceable(target, path)) {
				continue;
			}
			if (await this.share(target, path, folder, !!present)) {
				linked.push(name);
			}
		}
		await this.syncUserConfig(directory);
		return linked;
	}

	/**
	 * Shares one entry: a link, else for a file a hard link, else a copy. A file here
	 * that is not a link is one Klawly made, so it is replaced when the original changed.
	 */
	private async share(target: string, path: string, folder: boolean, replace: boolean): Promise<boolean> {
		if (replace) {
			await fs.rm(path, { force: true });
		}
		try {
			// A junction needs no rights on Windows; other systems ignore the type.
			await fs.symlink(target, path, folder ? 'junction' : 'file');
			return true;
		} catch {
			// Windows without Developer Mode cannot link a file.
		}
		if (folder) {
			return false;
		}
		try {
			await fs.link(target, path);
			return true;
		} catch {
			// Another volume: copy it.
		}
		try {
			await fs.copyFile(target, path);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Copies the user-scope parts of Claude Code's `.claude.json` (MCP servers, project
	 * trust and approved imports) into the account's. Never `oauthAccount` or anything else
	 * of the sign-in: the account's own file keeps those.
	 */
	private async syncUserConfig(directory: string): Promise<void> {
		const source = await readJson(basename(this.claudeDirectory) === '.claude' ? join(dirname(this.claudeDirectory), '.claude.json') : join(this.claudeDirectory, '.claude.json'));
		if (!source) {
			return;
		}
		const file = join(directory, '.claude.json');
		const account = await readJson(file) ?? {};
		const next: Record<string, unknown> = { ...account };
		if (isRecord(source.mcpServers)) {
			next.mcpServers = source.mcpServers;
		}
		if (isRecord(source.projects)) {
			const projects: Record<string, unknown> = isRecord(account.projects) ? { ...account.projects } : {};
			for (const [key, value] of Object.entries(source.projects)) {
				if (!isRecord(value)) {
					continue;
				}
				const shared = Object.fromEntries(SHARED_PROJECT_KEYS.filter(name => Object.prototype.hasOwnProperty.call(value, name)).map(name => [name, value[name]]));
				if (Object.keys(shared).length > 0) {
					projects[key] = { ...(isRecord(projects[key]) ? projects[key] : {}), ...shared };
				}
			}
			next.projects = projects;
		}
		if (JSON.stringify(next) === JSON.stringify(account)) {
			return;
		}
		const temporary = `${file}.${generateUuid()}.tmp`;
		await fs.writeFile(temporary, JSON.stringify(next, undefined, 2));
		await fs.rename(temporary, file);
	}

	/**
	 * Removes an account folder: its own files, and the links without what they
	 * point to. The default account has no folder here and is never removed.
	 */
	async remove(id: string): Promise<void> {
		const directory = this.directory(id);
		let names: string[];
		try {
			names = await fs.readdir(directory);
		} catch {
			return;
		}
		for (const name of names) {
			const path = join(directory, name);
			const stat = await fs.lstat(path);
			if (stat.isSymbolicLink()) {
				// Only the link goes: a junction reads as a link here, and removing it leaves its folder.
				await fs.unlink(path).catch(() => fs.rmdir(path));
			} else {
				await fs.rm(path, { recursive: true, force: true });
			}
		}
		await fs.rmdir(directory);
	}
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function isKind(path: string, folder: boolean): Promise<boolean> {
	try {
		const stat = await fs.stat(path);
		return folder ? stat.isDirectory() : stat.isFile();
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

async function lstatOrUndefined(path: string) {
	try {
		return await fs.lstat(path);
	} catch {
		return undefined;
	}
}

/** True when the file at `path` is not the same file as `target`, so it needs sharing again. */
async function replaceable(target: string, path: string): Promise<boolean> {
	try {
		const [a, b] = await Promise.all([fs.stat(target), fs.stat(path)]);
		if (a.ino !== 0 && a.ino === b.ino && a.dev === b.dev) {
			return false;
		}
		return !(a.size === b.size && (await fs.readFile(target)).equals(await fs.readFile(path)));
	} catch {
		return true;
	}
}
