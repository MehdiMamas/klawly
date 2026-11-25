/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { dirname, isAbsolute, join } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { CheckpointDirtyBuffer, CheckpointFileRecord, CHECKPOINT_LARGE_FILE_BYTES, CHECKPOINT_SCHEMA_VERSION, CHECKPOINT_TMP_STALE_MS, TurnCheckpoint, assertSafeId, checkpointBlobPath, checkpointFilePath, checkpointObjectsRoot, fileUriFromPath, sha256Hex } from './claudeCheckpoints.js';
import { branchFromHead, locateGitRepository, parseGitIndex, relativeGitPath } from './claudeGit.js';

export interface CheckpointStorageStat {
	readonly mtime: number;
	readonly size: number;
}

/**
 * The object store talks to this instead of `fs`, so the workbench can use the
 * file service and the shared process can use Node. Paths are absolute.
 */
export interface CheckpointStorage {
	exists(path: string): Promise<boolean>;
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, bytes: Uint8Array): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	readDir(path: string): Promise<readonly string[]>;
	remove(path: string): Promise<void>;
	stat(path: string): Promise<CheckpointStorageStat | undefined>;
	/**
	 * Hash `source` and, when `place(hash)` is not already there, copy the bytes
	 * there without holding the whole file. Absent on stores that only restore.
	 */
	importLarge?(source: string, place: (hash: string) => string): Promise<string>;
	hashFile?(path: string): Promise<string>;
}

/** A shell watch looks at no more files than this, and copies none bigger than the byte limit. */
const SHELL_WATCH_MAX_FILES = 4000;
const SHELL_WATCH_MAX_BYTES = 512 * 1024;
const SHELL_WATCH_MAX_DEPTH = 4;
const SHELL_WATCH_SKIP = new Set(['.git', 'node_modules', '.worktrees', 'out', 'dist', '.build', '.vscode-test']);

interface ShellWatchFile {
	readonly mtime: number;
	readonly size: number;
	/** The bytes before the shell ran. Absent for a file too big to copy. */
	readonly hash?: string;
}

interface ShellWatch {
	readonly turnId: string;
	readonly root: string;
	readonly files: Map<string, ShellWatchFile>;
}

export interface ShellWatchRequest {
	readonly sessionId: string;
	readonly turnId: string;
	readonly cwd: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface BeginTurnCheckpoint {
	readonly sessionId: string;
	readonly turnId: string;
	readonly cwd: string;
	readonly dirtyFiles?: readonly CheckpointDirtyBuffer[];
}

export interface SnapshotWriteRequest {
	readonly sessionId: string;
	readonly turnId: string;
	readonly cwd: string;
	readonly absolutePath: string;
}

export interface RemoteSnapshotWriteRequest {
	readonly sessionId: string;
	readonly turnId: string;
	/** A `claude-remote:` uri. */
	readonly uri: string;
	readonly bytes: Uint8Array | null;
}

interface GitSnapshot {
	readonly head?: string;
	readonly branch?: string;
	readonly index?: Map<string, string>;
	readonly cwd?: string;
	readonly indexError?: string;
}

/**
 * Content-addressed checkpoint blobs and the JSON that points at them.
 * Writes land in a temp file and then rename. Unchanged bytes share one blob.
 */
export class ClaudeCheckpointStore {
	private readonly _latest = new Map<string, string>();
	private readonly _turnGit = new Map<string, { turnId: string; snap: GitSnapshot }>();
	private readonly _shellWatch = new Map<string, ShellWatch>();
	private _lastIndexError: string | undefined;
	private _tail: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly _userDataPath: string,
		private readonly _storage: CheckpointStorage,
		private readonly _options: { pid?: number; largeFileBytes?: number; log?: (message: string) => void } = {},
	) { }

	/** Set when the git index was missing or could not be parsed. */
	lastGitIndexError(): string | undefined {
		return this._lastIndexError;
	}

	/** SHA-256 hex of `bytes`. The blob path is `checkpoint-objects/ab/cdef…`. */
	async putBlob(bytes: Uint8Array): Promise<string> {
		const hash = await sha256Hex(bytes);
		const target = checkpointBlobPath(this._userDataPath, hash);
		if (await this._storage.exists(target)) {
			return hash;
		}
		await this._storage.mkdir(dirname(target));
		const tmp = `${target}.tmp-${this._options.pid ?? 0}-${generateUuid()}`;
		await this._storage.writeFile(tmp, bytes);
		try {
			await this._storage.rename(tmp, target);
		} catch (error) {
			if (await this._storage.exists(target)) {
				await this._storage.remove(tmp);
				return hash;
			}
			throw error;
		}
		return hash;
	}

	async readBlob(hash: string): Promise<Uint8Array> {
		return this._storage.readFile(checkpointBlobPath(this._userDataPath, hash));
	}

	/**
	 * Records Git HEAD and every dirty buffer, then writes the checkpoint JSON.
	 * Collection of expired objects runs first, on the same queue.
	 */
	beginTurn(input: BeginTurnCheckpoint, retentionDays: number, now = Date.now()): Promise<TurnCheckpoint> {
		return this.enqueue(async () => {
			try {
				await this.garbageCollectUnlocked(retentionDays, now);
			} catch {
				// A retention failure leaves the objects in place. The snapshot still runs.
			}
			assertSafeId(input.sessionId);
			assertSafeId(input.turnId);
			const existing = await this.readCheckpointUnlocked(input.sessionId, input.turnId);
			if (existing) {
				this._latest.set(input.sessionId, existing.id);
				return existing;
			}
			const git = await this.gitForTurn(input.sessionId, input.turnId, input.cwd);
			const files: CheckpointFileRecord[] = [];
			for (const dirty of input.dirtyFiles ?? []) {
				if (!isAbsolute(dirty.path)) {
					continue;
				}
				const uri = fileUriFromPath(dirty.path);
				if (files.some(file => file.uri === uri)) {
					continue;
				}
				const bytes = textEncoder.encode(dirty.text);
				const hash = await this.putBlob(bytes);
				const stat = await this._storage.stat(dirty.path);
				const diskHash = stat ? await this.hashOnly(dirty.path) : undefined;
				files.push(this.stampIndex(git, dirty.path, {
					uri,
					existed: !!stat,
					hash,
					diskHash,
					stat: stat ? { mtime: stat.mtime, size: stat.size } : { mtime: now, size: bytes.byteLength },
					capturedAs: 'buffer',
				}));
			}
			const checkpoint: TurnCheckpoint = {
				schemaVersion: CHECKPOINT_SCHEMA_VERSION,
				id: input.turnId,
				sessionId: input.sessionId,
				turnId: input.turnId,
				createdAt: now,
				files,
				gitHead: git.head,
				gitBranch: git.branch,
			};
			await this.writeCheckpoint(checkpoint);
			this._latest.set(input.sessionId, checkpoint.id);
			return checkpoint;
		});
	}

	/** Captures the file as it is now, before an approved write changes it. */
	snapshotApprovedWrite(input: SnapshotWriteRequest): Promise<void> {
		return this.enqueue(async () => {
			assertSafeId(input.sessionId);
			assertSafeId(input.turnId);
			if (!isAbsolute(input.absolutePath)) {
				throw new Error('Checkpoint write path must be absolute.');
			}
			let checkpoint = await this.latestUnlocked(input.sessionId);
			const uri = fileUriFromPath(input.absolutePath);
			const sameTurn = checkpoint?.turnId === input.turnId;
			if (sameTurn && checkpoint!.files.some(file => file.uri === uri)) {
				return;
			}
			const git = await this.gitForTurn(input.sessionId, input.turnId, input.cwd);
			if (!sameTurn || !checkpoint) {
				checkpoint = {
					schemaVersion: CHECKPOINT_SCHEMA_VERSION,
					id: input.turnId,
					sessionId: input.sessionId,
					turnId: input.turnId,
					createdAt: Date.now(),
					files: [],
					gitHead: git.head,
					gitBranch: git.branch,
				};
			}
			if (!checkpoint.files.some(file => file.uri === uri)) {
				checkpoint.files.push(this.stampIndex(git, input.absolutePath, await this.capturePath(input.absolutePath, 'write')));
			}
			await this.writeCheckpoint(checkpoint);
			this._latest.set(input.sessionId, checkpoint.id);
		});
	}

	/**
	 * Captures a file on an SSH host (issue 425) before an approved write, from
	 * the bytes the remote helper read: `null` when the file did not exist. The
	 * record keeps the `claude-remote:` uri, so Review reads and writes the host.
	 */
	snapshotRemoteWrite(input: RemoteSnapshotWriteRequest): Promise<void> {
		return this.enqueue(async () => {
			assertSafeId(input.sessionId);
			assertSafeId(input.turnId);
			let checkpoint = await this.latestUnlocked(input.sessionId);
			if (checkpoint?.turnId === input.turnId && checkpoint.files.some(file => file.uri === input.uri)) {
				return;
			}
			if (checkpoint?.turnId !== input.turnId || !checkpoint) {
				checkpoint = { schemaVersion: CHECKPOINT_SCHEMA_VERSION, id: input.turnId, sessionId: input.sessionId, turnId: input.turnId, createdAt: Date.now(), files: [] };
			}
			checkpoint.files.push(input.bytes
				? { uri: input.uri, existed: true, hash: await this.putBlob(input.bytes), stat: { mtime: Date.now(), size: input.bytes.byteLength }, capturedAs: 'write' }
				: { uri: input.uri, existed: false, capturedAs: 'write' });
			await this.writeCheckpoint(checkpoint);
			this._latest.set(input.sessionId, checkpoint.id);
		});
	}

	/** Records a remote file's bytes after the approved write finished: `null` when it is gone. */
	noteRemoteAfterWrite(sessionId: string, uri: string, bytes: Uint8Array | null): Promise<void> {
		return this.enqueue(async () => {
			const checkpoint = await this.latestUnlocked(sessionId);
			const file = checkpoint?.files.find(candidate => candidate.uri === uri);
			if (!checkpoint || !file) {
				return;
			}
			file.afterHash = bytes ? await this.putBlob(bytes) : null;
			await this.writeCheckpoint(checkpoint);
		});
	}

	/** Records the bytes on disk after the approved write finished. */
	noteAfterWrite(sessionId: string, absolutePath: string): Promise<void> {
		return this.enqueue(async () => {
			const checkpoint = await this.latestUnlocked(sessionId);
			if (!checkpoint || !isAbsolute(absolutePath)) {
				return;
			}
			const uri = fileUriFromPath(absolutePath);
			const file = checkpoint.files.find(candidate => candidate.uri === uri);
			if (!file) {
				return;
			}
			const stat = await this._storage.stat(absolutePath);
			// Store the post-write bytes. Review uses them as the hunk's modified side.
			file.afterHash = stat ? await this.hashPath(absolutePath, stat.size) : null;
			await this.writeCheckpoint(checkpoint);
		});
	}

	/**
	 * Remembers the files under `cwd` before a shell command runs (issue 1054),
	 * once per turn: the git-tracked files plus a bounded walk for the rest.
	 * Files over the byte limit are only counted, so a change to one is not recorded.
	 */
	beginShellWatch(input: ShellWatchRequest): Promise<void> {
		return this.enqueue(async () => {
			assertSafeId(input.sessionId);
			assertSafeId(input.turnId);
			if (!isAbsolute(input.cwd) || this._shellWatch.get(input.sessionId)?.turnId === input.turnId) {
				return;
			}
			const files = new Map<string, ShellWatchFile>();
			for (const path of await this.walkShellRoot(input.cwd)) {
				const stat = await this._storage.stat(path);
				if (!stat) {
					continue;
				}
				let hash: string | undefined;
				if (stat.size <= SHELL_WATCH_MAX_BYTES) {
					try {
						hash = await this.putBlob(await this._storage.readFile(path));
					} catch {
						// Unreadable now: treated as too big to restore.
					}
				}
				files.set(path, { mtime: stat.mtime, size: stat.size, hash });
			}
			this._shellWatch.set(input.sessionId, { turnId: input.turnId, root: input.cwd, files });
		});
	}

	/**
	 * Adds a record for every file a shell command changed, created or deleted
	 * since `beginShellWatch`, unless a write tool already captured it. Returns
	 * how many were added.
	 */
	settleShellWatch(sessionId: string): Promise<number> {
		return this.enqueue(async () => {
			const watch = this._shellWatch.get(sessionId);
			const checkpoint = watch ? await this.latestUnlocked(sessionId) : undefined;
			if (!watch || !checkpoint || checkpoint.turnId !== watch.turnId) {
				return 0;
			}
			const git = await this.gitForTurn(sessionId, watch.turnId, watch.root);
			const now = new Set(await this.walkShellRoot(watch.root));
			let added = 0;
			for (const path of new Set([...watch.files.keys(), ...now])) {
				const uri = fileUriFromPath(path);
				const before = watch.files.get(path);
				const stat = now.has(path) ? await this._storage.stat(path) : undefined;
				if (checkpoint.files.some(file => file.uri === uri)) {
					continue;
				}
				if (before && stat && before.mtime === stat.mtime && before.size === stat.size) {
					continue;
				}
				if ((before && !before.hash) || (!before && !stat)) {
					continue;
				}
				let afterHash: string | null = null;
				if (stat) {
					try {
						afterHash = await this.hashPath(path, stat.size);
					} catch {
						continue;
					}
					if (before?.hash === afterHash) {
						continue;
					}
				}
				const record: CheckpointFileRecord = before
					? { uri, existed: true, hash: before.hash, stat: { mtime: before.mtime, size: before.size }, afterHash, capturedAs: 'write' }
					: { uri, existed: false, afterHash, capturedAs: 'write' };
				checkpoint.files.push(this.stampIndex(git, path, record));
				added++;
			}
			if (added) {
				await this.writeCheckpoint(checkpoint);
			}
			return added;
		});
	}

	/** The entries of a folder; a file, or a folder that cannot be read, has none. */
	private async listDir(path: string): Promise<readonly string[]> {
		try {
			return await this._storage.readDir(path);
		} catch {
			return [];
		}
	}

	/** Absolute paths of the files a shell watch compares: the git index first, then a bounded walk. */
	private async walkShellRoot(root: string): Promise<string[]> {
		const found = new Set<string>();
		const git = await this.readGitSnapshot(root);
		if (git.index && git.cwd) {
			for (const rel of git.index.keys()) {
				if (found.size >= SHELL_WATCH_MAX_FILES) {
					break;
				}
				found.add(join(git.cwd, rel));
			}
		}
		let level = [root];
		for (let depth = 0; depth <= SHELL_WATCH_MAX_DEPTH && level.length && found.size < SHELL_WATCH_MAX_FILES; depth++) {
			const next: string[] = [];
			for (const dir of level) {
				for (const name of await this.listDir(dir)) {
					const path = join(dir, name);
					if (SHELL_WATCH_SKIP.has(name) || found.size >= SHELL_WATCH_MAX_FILES) {
						continue;
					}
					if ((await this.listDir(path)).length) {
						next.push(path);
					} else {
						found.add(path);
					}
				}
			}
			level = next;
		}
		return [...found];
	}

	readCheckpoint(sessionId: string, checkpointId: string): Promise<TurnCheckpoint | undefined> {
		return this.enqueue(() => this.readCheckpointUnlocked(sessionId, checkpointId));
	}

	listCheckpoints(sessionId: string): Promise<TurnCheckpoint[]> {
		return this.enqueue(() => this.listSessionUnlocked(sessionId));
	}

	garbageCollect(retentionDays: number, now = Date.now()): Promise<void> {
		return this.enqueue(() => this.garbageCollectUnlocked(retentionDays, now));
	}

	async readGitHead(cwd: string): Promise<string | undefined> {
		return (await this.readGitSnapshot(cwd)).head;
	}

	private async gitForTurn(sessionId: string, turnId: string, cwd: string): Promise<GitSnapshot> {
		const cached = this._turnGit.get(sessionId);
		if (cached?.turnId === turnId) {
			return cached.snap;
		}
		const snap = await this.readGitSnapshot(cwd);
		this._turnGit.set(sessionId, { turnId, snap });
		return snap;
	}

	private async readGitSnapshot(cwd: string): Promise<GitSnapshot> {
		if (!isAbsolute(cwd)) {
			return {};
		}
		const located = await locateGitRepository(cwd, path => this.readText(path));
		if (!located) {
			return {};
		}
		let index: Map<string, string> | undefined;
		let indexError: string | undefined;
		try {
			const parsed = parseGitIndex(await this._storage.readFile(join(located.gitDir, 'index')));
			if (parsed) {
				index = parsed;
			} else {
				indexError = 'Git index could not be parsed.';
			}
		} catch {
			indexError = 'Git index could not be read.';
		}
		if (indexError) {
			this._lastIndexError = indexError;
			this._options.log?.(indexError);
		} else {
			this._lastIndexError = undefined;
		}
		return {
			cwd: located.workTree,
			head: await this.resolveHead(located.gitDir, located.headText),
			branch: branchFromHead(located.headText),
			index,
			indexError,
		};
	}

	private stampIndex(git: { cwd?: string; index?: Map<string, string> }, absolutePath: string, record: CheckpointFileRecord): CheckpointFileRecord {
		if (!git.index || !git.cwd) {
			return record;
		}
		const rel = relativeGitPath(git.cwd, absolutePath);
		if (!rel) {
			return record;
		}
		return { ...record, indexBlob: git.index.get(rel) ?? null };
	}

	private async resolveHead(gitDir: string, head: string): Promise<string | undefined> {
		const trimmed = head.trim();
		const ref = /^ref:\s*(\S+)$/.exec(trimmed);
		if (!ref) {
			return isGitSha(trimmed) ? trimmed : undefined;
		}
		const refName = ref[1];
		if (refName.includes('..') || !refName.startsWith('refs/')) {
			return undefined;
		}
		const sha = await this.readText(join(gitDir, refName));
		const value = sha?.trim() ?? '';
		if (isGitSha(value)) {
			return value;
		}
		return this.readPackedRef(gitDir, refName);
	}

	/** A fresh clone often stores the branch tip only in `packed-refs`. */
	private async readPackedRef(gitDir: string, refName: string): Promise<string | undefined> {
		const packed = await this.readText(join(gitDir, 'packed-refs'));
		if (packed === undefined) {
			return undefined;
		}
		for (const line of packed.split('\n')) {
			const trimmed = line.trim();
			if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('^')) {
				continue;
			}
			const match = /^([0-9a-f]{40,64})\s+(\S+)$/i.exec(trimmed);
			if (match && match[2] === refName && isGitSha(match[1])) {
				return match[1];
			}
		}
		return undefined;
	}

	private async readText(path: string): Promise<string | undefined> {
		try {
			return textDecoder.decode(await this._storage.readFile(path));
		} catch {
			return undefined;
		}
	}

	private async capturePath(absolutePath: string, capturedAs: 'buffer' | 'write'): Promise<CheckpointFileRecord> {
		const uri = fileUriFromPath(absolutePath);
		const stat = await this._storage.stat(absolutePath);
		if (!stat) {
			return { uri, existed: false, capturedAs };
		}
		const hash = await this.hashPath(absolutePath, stat.size);
		return { uri, existed: true, hash, stat: { mtime: stat.mtime, size: stat.size }, capturedAs };
	}

	private async hashOnly(absolutePath: string): Promise<string> {
		if (this._storage.hashFile) {
			return this._storage.hashFile(absolutePath);
		}
		return sha256Hex(await this._storage.readFile(absolutePath));
	}

	private async hashPath(absolutePath: string, size: number): Promise<string> {
		const limit = this._options.largeFileBytes ?? CHECKPOINT_LARGE_FILE_BYTES;
		if (size > limit && this._storage.importLarge) {
			return this._storage.importLarge(absolutePath, hash => checkpointBlobPath(this._userDataPath, hash));
		}
		return this.putBlob(await this._storage.readFile(absolutePath));
	}

	private async writeCheckpoint(checkpoint: TurnCheckpoint): Promise<void> {
		const target = checkpointFilePath(this._userDataPath, checkpoint.sessionId, checkpoint.id);
		await this._storage.mkdir(dirname(target));
		const bytes = textEncoder.encode(JSON.stringify(checkpoint));
		const tmp = `${target}.tmp-${this._options.pid ?? 0}-${generateUuid()}`;
		await this._storage.writeFile(tmp, bytes);
		if (await this._storage.exists(target)) {
			await this._storage.remove(target);
		}
		await this._storage.rename(tmp, target);
	}

	private async readCheckpointUnlocked(sessionId: string, checkpointId: string): Promise<TurnCheckpoint | undefined> {
		try {
			assertSafeId(sessionId);
			assertSafeId(checkpointId);
		} catch {
			return undefined;
		}
		let bytes: Uint8Array;
		try {
			bytes = await this._storage.readFile(checkpointFilePath(this._userDataPath, sessionId, checkpointId));
		} catch {
			return undefined;
		}
		return parseCheckpoint(bytes);
	}

	private async listSessionUnlocked(sessionId: string): Promise<TurnCheckpoint[]> {
		try {
			assertSafeId(sessionId);
		} catch {
			return [];
		}
		const dir = join(this._userDataPath, 'agent-sessions', sessionId, 'checkpoints');
		const names = await this._storage.readDir(dir);
		const checkpoints: TurnCheckpoint[] = [];
		for (const name of names) {
			if (!name.endsWith('.json') || name.includes('.tmp-')) {
				continue;
			}
			const id = name.slice(0, -'.json'.length);
			const checkpoint = await this.readCheckpointUnlocked(sessionId, id);
			if (checkpoint) {
				checkpoints.push(checkpoint);
			}
		}
		checkpoints.sort((left, right) => left.createdAt - right.createdAt);
		return checkpoints;
	}

	private async latestUnlocked(sessionId: string): Promise<TurnCheckpoint | undefined> {
		const id = this._latest.get(sessionId);
		if (id) {
			const checkpoint = await this.readCheckpointUnlocked(sessionId, id);
			if (checkpoint) {
				return checkpoint;
			}
		}
		const all = await this.listSessionUnlocked(sessionId);
		return all[all.length - 1];
	}

	private async garbageCollectUnlocked(retentionDays: number, now: number): Promise<void> {
		await this.removeStaleTemporaryFiles(now);
		const cutoff = now - Math.max(0, retentionDays) * 24 * 60 * 60 * 1000;
		const sessions = await this._storage.readDir(join(this._userDataPath, 'agent-sessions'));
		const referenced = new Set<string>();
		let unreadable = false;
		for (const sessionId of sessions) {
			if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) {
				continue;
			}
			const dir = join(this._userDataPath, 'agent-sessions', sessionId, 'checkpoints');
			for (const name of await this._storage.readDir(dir)) {
				if (!name.endsWith('.json') || name.includes('.tmp-')) {
					continue;
				}
				const path = join(dir, name);
				let checkpoint: TurnCheckpoint | undefined;
				try {
					checkpoint = parseCheckpoint(await this._storage.readFile(path));
				} catch {
					unreadable = true;
					continue;
				}
				if (!checkpoint) {
					unreadable = true;
					continue;
				}
				if (checkpoint.createdAt < cutoff) {
					await this._storage.remove(path);
					if (this._latest.get(sessionId) === checkpoint.id) {
						this._latest.delete(sessionId);
					}
					continue;
				}
				for (const file of checkpoint.files) {
					if (file.hash) {
						referenced.add(file.hash);
					}
					if (file.afterHash) {
						referenced.add(file.afterHash);
					}
				}
			}
		}
		if (unreadable) {
			return;
		}
		const root = checkpointObjectsRoot(this._userDataPath);
		for (const prefix of await this._storage.readDir(root)) {
			if (!/^[0-9a-f]{2}$/.test(prefix)) {
				continue;
			}
			const dir = join(root, prefix);
			for (const name of await this._storage.readDir(dir)) {
				if (name.includes('.tmp-')) {
					continue;
				}
				const hash = prefix + name;
				if (!/^[0-9a-f]{64}$/.test(hash) || referenced.has(hash)) {
					continue;
				}
				await this._storage.remove(join(dir, name));
			}
		}
	}

	/** `.tmp-*` under the objects root, and `*.tmp-*` in a prefix directory, left behind by a crash. */
	private async removeStaleTemporaryFiles(now: number): Promise<void> {
		const staleBefore = now - CHECKPOINT_TMP_STALE_MS;
		const root = checkpointObjectsRoot(this._userDataPath);
		for (const name of await this._storage.readDir(root)) {
			const path = join(root, name);
			if (name.includes('.tmp-')) {
				await this.removeIfStale(path, staleBefore);
				continue;
			}
			if (!/^[0-9a-f]{2}$/.test(name)) {
				continue;
			}
			for (const child of await this._storage.readDir(path)) {
				if (child.includes('.tmp-')) {
					await this.removeIfStale(join(path, child), staleBefore);
				}
			}
		}
	}

	private async removeIfStale(path: string, staleBefore: number): Promise<void> {
		const stat = await this._storage.stat(path);
		if (stat && stat.mtime <= staleBefore) {
			await this._storage.remove(path);
		}
	}

	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const run = this._tail.then(work, work);
		this._tail = run.then(() => undefined, () => undefined);
		return run;
	}
}

function parseCheckpoint(bytes: Uint8Array): TurnCheckpoint | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(textDecoder.decode(bytes));
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}
	const checkpoint = parsed as TurnCheckpoint;
	if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION || !Array.isArray(checkpoint.files)) {
		return undefined;
	}
	if (typeof checkpoint.id !== 'string' || typeof checkpoint.sessionId !== 'string' || typeof checkpoint.turnId !== 'string') {
		return undefined;
	}
	return checkpoint;
}

function isGitSha(value: string): boolean {
	return /^[0-9a-f]{40}$/i.test(value) || /^[0-9a-f]{64}$/i.test(value);
}
