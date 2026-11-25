/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { Disposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { IClaudeMachineSession, IClaudeMachineSessionResult, IClaudeMachineSessionService } from '../common/claudeMachineSessions.js';

const CLI_TIMEOUT_MS = 60_000;
/** The same 10 s freshness the session manager's `agents-cache.mjs` uses, so a list never costs a second process. */
const LIST_FRESH_MS = 10_000;
const CACHE_KEY = 'agents-all';
const GIT_FACTS_FRESH_MS = 30_000;
const GIT_CONCURRENCY = 6;
/** Only a worktree folder is checked for git work; the main checkout is shared by many sessions. */
const WORKTREE_PATH = /[\\/]\.(claude[\\/])?worktrees[\\/]/;
/** `claude stop|kill|rm|respawn` take the short id from `claude agents`. */
const SESSION_ID = /^[\w-]{1,64}$/;

interface IAgentsEntry {
	readonly id: string;
	readonly cwd: string;
	readonly kind: string;
	readonly startedAt: number;
	readonly sessionId: string;
	readonly name?: string;
	readonly state?: string;
}

interface IRegistryRecord {
	readonly parent?: string | null;
	readonly contextTokens?: number;
	readonly model?: string;
	readonly updatedAt?: number;
}

interface ICliResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

function runClaude(args: readonly string[], cwd?: string): Promise<ICliResult> {
	return new Promise(resolve => {
		const child = spawn('claude', args.slice(), { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: CLI_TIMEOUT_MS });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', chunk => { stdout += chunk; });
		child.stderr.on('data', chunk => { stderr += chunk; });
		child.on('error', error => resolve({ code: null, stdout, stderr: error.message }));
		child.on('close', code => resolve({ code, stdout, stderr }));
	});
}

function runGit(cwd: string, args: readonly string[]): Promise<ICliResult> {
	return new Promise(resolve => {
		const child = spawn('git', ['-C', cwd, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
		let stdout = '';
		child.stdout.on('data', chunk => { stdout += chunk; });
		child.on('error', error => resolve({ code: null, stdout, stderr: error.message }));
		child.on('close', code => resolve({ code, stdout, stderr: '' }));
	});
}

async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(file, 'utf8')) as T;
	} catch {
		return undefined;
	}
}

/** Parses `claude agents --json`. Anything that is not a list of sessions gives an empty list. */
export function parseAgentsJson(stdout: string): readonly IAgentsEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	return parsed.filter((entry): entry is IAgentsEntry =>
		typeof entry === 'object' && entry !== null
		&& typeof entry.id === 'string' && SESSION_ID.test(entry.id)
		&& typeof entry.sessionId === 'string' && typeof entry.cwd === 'string');
}

/**
 * Every Claude Code session on this PC, from Claude Code's own `claude agents`. Shared process only:
 * the UI never spawns anything. The list is read through the file cache the session manager keeps,
 * so many windows never start many `claude agents` processes.
 */
export class ClaudeMachineSessionService extends Disposable implements IClaudeMachineSessionService {
	declare readonly _serviceBrand: undefined;

	private readonly _gitFacts = new Map<string, { readonly at: number; readonly unpushed: number; readonly dirty: boolean }>();

	constructor(private readonly _home: string = homedir(), private readonly _now: () => number = Date.now) {
		super();
	}

	async list(): Promise<readonly IClaudeMachineSession[]> {
		const entries = await this._agents();
		const registry = join(this._home, '.claude', 'session-manager');
		const pending = await this._pendingCiOwners(registry);
		const sessions: IClaudeMachineSession[] = [];
		let next = 0;
		const work = async () => {
			while (next < entries.length) {
				const entry = entries[next++];
				const record = await readJson<IRegistryRecord>(join(registry, entry.sessionId, `${entry.sessionId}.json`));
				const git = await this._git(entry.cwd);
				sessions.push({
					id: entry.id,
					sessionId: entry.sessionId,
					name: entry.name || entry.id,
					cwd: entry.cwd,
					kind: entry.kind === 'interactive' ? 'interactive' : 'background',
					rawState: entry.state,
					startedAt: entry.startedAt,
					updatedAt: record?.updatedAt,
					parentSessionId: record?.parent || undefined,
					contextTokens: record?.contextTokens,
					model: record?.model,
					costUsd: undefined,
					unpushed: git.unpushed,
					dirty: git.dirty,
					waitingOnCi: pending.has(entry.sessionId),
				});
			}
		};
		await Promise.all(Array.from({ length: GIT_CONCURRENCY }, work));
		return sessions.sort((a, b) => b.startedAt - a.startedAt);
	}

	stop(id: string): Promise<IClaudeMachineSessionResult> {
		return this._command('stop', id);
	}

	kill(id: string): Promise<IClaudeMachineSessionResult> {
		return this._command('kill', id);
	}

	/** Never passes `--discard-unpushed`: Claude Code itself refuses a session whose worktree has unpushed commits. */
	remove(id: string): Promise<IClaudeMachineSessionResult> {
		return this._command('rm', id);
	}

	resume(id: string): Promise<IClaudeMachineSessionResult> {
		return this._command('respawn', id);
	}

	private async _command(verb: 'stop' | 'kill' | 'rm' | 'respawn', id: string): Promise<IClaudeMachineSessionResult> {
		if (!SESSION_ID.test(id)) {
			return { ok: false, message: `Not a session id: ${id}` };
		}
		const result = await runClaude([verb, id]);
		this._invalidate();
		const text = (result.stdout.trim() || result.stderr.trim()).split(/\r?\n/).slice(0, 4).join(' ');
		return { ok: result.code === 0, message: text || `claude ${verb} ${id} exited with ${result.code}` };
	}

	private _cacheFile(): string {
		return join(this._home, '.claude', 'session-manager-cache', 'agents-cache.json');
	}

	private async _readEntries(): Promise<Record<string, { at: number; stdout: string }>> {
		const cache = await readJson<{ entries?: Record<string, { at: number; stdout: string }> }>(this._cacheFile());
		return cache?.entries ?? {};
	}

	private async _agents(): Promise<readonly IAgentsEntry[]> {
		const cached = (await this._readEntries())[CACHE_KEY];
		if (cached && typeof cached.at === 'number' && this._now() - cached.at < LIST_FRESH_MS) {
			return parseAgentsJson(cached.stdout);
		}
		const result = await runClaude(['agents', '--json', '--all']);
		if (result.code !== 0) {
			return cached ? parseAgentsJson(cached.stdout) : [];
		}
		try {
			const entries = await this._readEntries();
			entries[CACHE_KEY] = { at: this._now(), stdout: result.stdout };
			await mkdir(join(this._cacheFile(), '..'), { recursive: true });
			await writeFile(this._cacheFile(), JSON.stringify({ at: this._now(), stdout: '', entries }));
		} catch {
			// The cache is an optimization; the list is still right.
		}
		return parseAgentsJson(result.stdout);
	}

	/** A command changed the sessions: the next list must ask again. */
	private _invalidate(): void {
		this._gitFacts.clear();
		void this._readEntries().then(async entries => {
			delete entries[CACHE_KEY];
			await writeFile(this._cacheFile(), JSON.stringify({ at: this._now(), stdout: '', entries }));
		}).catch(() => undefined);
	}

	/** Owners of a CI watch that has no answer sent yet (the session manager's `ci-wait` folder). */
	private async _pendingCiOwners(registry: string): Promise<ReadonlySet<string>> {
		const dir = join(registry, 'ci-wait');
		let files: string[];
		try {
			files = await readdir(dir);
		} catch {
			return new Set();
		}
		const names = new Set(files);
		const owners = new Set<string>();
		for (const file of files) {
			if (!file.endsWith('.meta.json')) {
				continue;
			}
			const id = file.slice(0, -'.meta.json'.length);
			if (names.has(`${id}.sent`)) {
				continue;
			}
			const meta = await readJson<{ owner?: string }>(join(dir, file));
			if (meta?.owner) {
				owners.add(meta.owner);
			}
		}
		return owners;
	}

	private async _git(cwd: string): Promise<{ readonly unpushed: number; readonly dirty: boolean }> {
		if (!WORKTREE_PATH.test(cwd)) {
			return { unpushed: 0, dirty: false };
		}
		const known = this._gitFacts.get(cwd);
		if (known && this._now() - known.at < GIT_FACTS_FRESH_MS) {
			return known;
		}
		const [count, status] = await Promise.all([
			runGit(cwd, ['rev-list', '--count', 'HEAD', '--not', '--remotes']),
			runGit(cwd, ['status', '--porcelain']),
		]);
		const facts = {
			at: this._now(),
			unpushed: count.code === 0 ? Number(count.stdout.trim()) || 0 : 0,
			dirty: status.code === 0 && status.stdout.trim().length > 0,
		};
		this._gitFacts.set(cwd, facts);
		return facts;
	}
}
