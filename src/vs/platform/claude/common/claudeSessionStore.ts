/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { dirname, join } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { assertSafeId } from './claudeCheckpoints.js';
import { AGENT_DATABASE_SCHEMA_VERSION, AgentPreferences, IdeAgentSession, PersistedAgentDatabase, SessionIndexRecord } from './claudeStorage.js';

/**
 * Filesystem the session store uses. The workbench passes the file service.
 * Node tests pass `fs`. Paths are absolute.
 */
export interface SessionStorage {
	read(path: string): Promise<string | undefined>;
	write(path: string, text: string): Promise<void>;
	append(path: string, text: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	/** Removes a file or a directory tree. Missing paths are fine. */
	remove(path: string): Promise<void>;
	/** Child names of a directory. Missing directories are an empty list. */
	list?(path: string): Promise<readonly string[]>;
}

/** Identity of one chat-reference file. Scope and subagent keep two chips from sharing a path. */
export interface ChatReferenceFileSpec {
	readonly asOfTurn: number;
	readonly turnStart?: number;
	readonly scope?: 'summary' | 'full';
	readonly subagentId?: string;
}

export interface StoredHistoryLine {
	readonly v: 1;
	readonly ts: number;
	readonly event: unknown;
}

const encoder = new TextEncoder();

/** The write queue of `comparisons.json`. A file name, so it never meets a session id. */
const COMPARISONS_QUEUE = 'comparisons.json';

/** The write queue of `search-index.json` (issue 489). */
const SEARCH_INDEX_QUEUE = 'search-index.json';

/**
 * Append-only JSONL transcripts and an atomic session index.
 * A truncated last line is dropped. Older indexes migrate forward.
 */
export class JsonlSessionStore {
	private readonly _tails = new Map<string, Promise<void>>();
	/** Serializes index updates from delete and from session metadata writes. */
	private _indexTail: Promise<void> = Promise.resolve();
	/** Sessions whose log tail was checked in this process. Later appends do not re-read it. */
	private readonly _tailChecked = new Set<string>();
	/** Sessions removed by `deleteSession`. Queued writes after that become no-ops. */
	private readonly _removed = new Set<string>();

	constructor(
		private readonly _userDataPath: string,
		private readonly _storage: SessionStorage,
	) { }

	eventsPath(sessionId: string): string {
		return join(this.sessionDir(sessionId), 'events.jsonl');
	}

	sessionFile(sessionId: string): string {
		return join(this.sessionDir(sessionId), 'session.json');
	}

	reviewsFile(sessionId: string): string {
		return join(this.sessionDir(sessionId), 'reviews.json');
	}

	referencePath(sessionId: string, spec: ChatReferenceFileSpec): string {
		const asOfTurn = spec.asOfTurn;
		const turnStart = spec.turnStart ?? 1;
		if (!Number.isInteger(asOfTurn) || asOfTurn < 1 || asOfTurn > 1_000_000 || !Number.isInteger(turnStart) || turnStart < 1 || turnStart > asOfTurn) {
			throw new Error('Chat reference turn is not a safe file name.');
		}
		const scope = spec.scope === 'full' ? 'full' : 'summary';
		const subagent = spec.subagentId ? `-${referenceToken(spec.subagentId)}` : '';
		return join(this.sessionDir(sessionId), `reference-${turnStart}-${asOfTurn}-${scope}${subagent}.md`);
	}

	indexPath(): string {
		return join(this.root(), 'index.json');
	}

	indexBackupPath(): string {
		return `${this.indexPath()}.bak`;
	}

	/** Compare Models records (issue 424): one file beside the index, listing each comparison's run sessions. */
	comparisonsPath(): string {
		return join(this.root(), 'comparisons.json');
	}

	/** Appends one JSON line. Callers serialize their own event shape. */
	append(sessionId: string, event: unknown, now = Date.now()): Promise<void> {
		const line: StoredHistoryLine = { v: 1, ts: now, event };
		const text = JSON.stringify(line) + '\n';
		return this.queue(sessionId, async () => {
			if (this._removed.has(sessionId)) {
				return;
			}
			const path = this.eventsPath(sessionId);
			await this._storage.mkdir(dirname(path));
			await this.repairTail(sessionId, path);
			if (this._removed.has(sessionId)) {
				return;
			}
			await this._storage.append(path, text);
		});
	}

	/**
	 * Reads every complete line. A crash can leave a partial last line;
	 * that line and anything after it are ignored.
	 */
	async read(sessionId: string): Promise<readonly StoredHistoryLine[]> {
		const raw = await this._storage.read(this.eventsPath(sessionId));
		if (!raw) {
			return [];
		}
		const out: StoredHistoryLine[] = [];
		for (const line of raw.split('\n')) {
			if (!line.trim()) {
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				break;
			}
			if (!isHistoryLine(parsed)) {
				break;
			}
			out.push(parsed);
		}
		return out;
	}

	async readSession(sessionId: string): Promise<IdeAgentSession | undefined> {
		const raw = await this._storage.read(this.sessionFile(sessionId));
		if (!raw) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(raw) as IdeAgentSession;
			return parsed && parsed.id === sessionId ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	writeSession(session: IdeAgentSession): Promise<void> {
		return this.queue(session.id, async () => {
			if (this._removed.has(session.id)) {
				return;
			}
			await this._storage.mkdir(this.sessionDir(session.id));
			if (this._removed.has(session.id)) {
				return;
			}
			await this.writeAtomic(this.sessionFile(session.id), JSON.stringify(session));
		});
	}

	async readIndex(): Promise<PersistedAgentDatabase> {
		const raw = await this._storage.read(this.indexPath());
		if (!raw) {
			return emptyDatabase();
		}
		const parsed = parseIndex(raw);
		if (parsed) {
			return parsed;
		}
		const backup = await this._storage.read(this.indexBackupPath());
		const fromBackup = backup ? parseIndex(backup) : undefined;
		if (fromBackup) {
			return fromBackup;
		}
		const rebuilt = await this.rebuildIndex();
		if (rebuilt) {
			return rebuilt;
		}
		await this.quarantineIndex();
		return emptyDatabase();
	}

	/** Writes the index by temp file and rename so a crash cannot leave half a file. */
	async writeIndex(database: PersistedAgentDatabase): Promise<void> {
		const migrated = migrateAgentDatabase(database);
		const text = JSON.stringify(migrated);
		await this._storage.mkdir(this.root());
		const current = await this._storage.read(this.indexPath());
		// A corrupt index must not replace a backup that still parses.
		if (current !== undefined && parseIndex(current)) {
			await this.writeAtomic(this.indexBackupPath(), current);
		}
		await this.writeAtomic(this.indexPath(), text);
	}

	async upsertIndex(record: SessionIndexRecord): Promise<void> {
		await this.enqueueIndex(async () => {
			if (this._removed.has(record.id)) {
				return;
			}
			const current = await this.readIndex();
			if (this._removed.has(record.id)) {
				return;
			}
			const sessions = current.sessions.filter(session => session.id !== record.id && !this._removed.has(session.id));
			sessions.push(record);
			sessions.sort((a, b) => b.updatedAt - a.updatedAt);
			await this.writeIndex({ ...current, sessions });
		});
	}

	/** Marks a session in the index as an open or a closed tab. Does nothing when it is not listed. */
	async setOpen(sessionId: string, open: boolean): Promise<void> {
		await this.enqueueIndex(async () => {
			const current = await this.readIndex();
			const record = current.sessions.find(session => session.id === sessionId);
			if (!record || this._removed.has(sessionId) || (record.open ?? false) === open) {
				return;
			}
			await this.writeIndex({ ...current, sessions: current.sessions.map(session => session === record ? { ...record, open } : session) });
		});
	}

	async deleteSession(sessionId: string): Promise<void> {
		assertSafeId(sessionId);
		this._removed.add(sessionId);
		try {
			await this.queue(sessionId, async () => {
				await this._storage.remove(this.sessionDir(sessionId));
			});
			await this.enqueueIndex(async () => {
				const current = await this.readIndex();
				await this.writeIndex({ ...current, sessions: current.sessions.filter(session => session.id !== sessionId && !this._removed.has(session.id)) });
			});
		} finally {
			this._tails.delete(sessionId);
		}
	}

	writeReference(sessionId: string, spec: ChatReferenceFileSpec, markdown: string): Promise<void> {
		return this.queue(sessionId, async () => {
			if (this._removed.has(sessionId)) {
				return;
			}
			const path = this.referencePath(sessionId, spec);
			await this._storage.mkdir(dirname(path));
			if (this._removed.has(sessionId)) {
				return;
			}
			await this.writeAtomic(path, markdown);
		});
	}

	/**
	 * Copies checkpoint JSON and review hunks for `turnIds` onto the forked session.
	 * Blobs stay shared. The Claude resume id is not copied.
	 */
	copyForkArtifacts(fromSessionId: string, toSessionId: string, turnIds: readonly string[]): Promise<void> {
		return this.queue(toSessionId, async () => {
			if (this._removed.has(fromSessionId) || this._removed.has(toSessionId)) {
				return;
			}
			await this._storage.mkdir(this.sessionDir(toSessionId));
			if (this._removed.has(fromSessionId) || this._removed.has(toSessionId)) {
				return;
			}
			const reviews = await this._storage.read(this.reviewsFile(fromSessionId));
			if (reviews) {
				const kept = filterForkReviews(reviews, toSessionId, turnIds);
				if (kept) {
					await this.writeAtomic(this.reviewsFile(toSessionId), kept);
				}
			}
			for (const turnId of turnIds) {
				assertSafeId(turnId);
				const source = join(this.sessionDir(fromSessionId), 'checkpoints', `${turnId}.json`);
				const raw = await this._storage.read(source);
				if (!raw) {
					continue;
				}
				let text = raw;
				try {
					const checkpoint = JSON.parse(raw) as { sessionId?: string };
					checkpoint.sessionId = toSessionId;
					text = JSON.stringify(checkpoint);
				} catch {
					continue;
				}
				const target = join(this.sessionDir(toSessionId), 'checkpoints', `${turnId}.json`);
				await this._storage.mkdir(dirname(target));
				await this.writeAtomic(target, text);
			}
		});
	}

	async readReviews(sessionId: string): Promise<string | undefined> {
		return this._storage.read(this.reviewsFile(sessionId));
	}

	writeReviews(sessionId: string, json: string): Promise<void> {
		return this.queue(sessionId, async () => {
			if (this._removed.has(sessionId)) {
				return;
			}
			await this._storage.mkdir(this.sessionDir(sessionId));
			if (this._removed.has(sessionId)) {
				return;
			}
			await this.writeAtomic(this.reviewsFile(sessionId), json);
		});
	}

	readComparisons(): Promise<string | undefined> {
		return this._storage.read(this.comparisonsPath());
	}

	/** Writes are serialized and atomic, like the index. */
	writeComparisons(json: string): Promise<void> {
		return this.queue(COMPARISONS_QUEUE, async () => {
			await this._storage.mkdir(this.root());
			await this.writeAtomic(this.comparisonsPath(), json);
		});
	}

	/** Chat search (issue 489): the prompts and replies of every chat, one file beside the index. */
	searchIndexPath(): string {
		return join(this.root(), 'search-index.json');
	}

	readSearchIndex(): Promise<string | undefined> {
		return this._storage.read(this.searchIndexPath());
	}

	/** Writes are serialized and atomic, like the index. */
	writeSearchIndex(json: string): Promise<void> {
		return this.queue(SEARCH_INDEX_QUEUE, async () => {
			await this._storage.mkdir(this.root());
			await this.writeAtomic(this.searchIndexPath(), json);
		});
	}

	/** Repairs a truncated tail once per session in this process. A new process checks again. */
	private async repairTail(sessionId: string, path: string): Promise<void> {
		if (this._tailChecked.has(sessionId)) {
			return;
		}
		const raw = await this._storage.read(path);
		this._tailChecked.add(sessionId);
		if (!raw) {
			return;
		}
		const valid = validHistoryPrefix(raw);
		if (valid === raw) {
			return;
		}
		await this.writeAtomic(path, valid);
	}

	/** Moves an unreadable index aside when no backup or session file can rebuild it. */
	private async quarantineIndex(): Promise<void> {
		const path = this.indexPath();
		const raw = await this._storage.read(path);
		if (raw === undefined) {
			return;
		}
		let dest = `${path}.corrupt`;
		if (await this._storage.read(dest) !== undefined) {
			dest = `${path}.corrupt-${Date.now()}`;
		}
		try {
			await this._storage.rename(path, dest);
		} catch {
			// The unreadable bytes stay put. Callers still get an empty database.
		}
	}

	private enqueueIndex(run: () => Promise<void>): Promise<void> {
		const next = this._indexTail.then(run, run);
		this._indexTail = next.then(() => undefined, () => undefined);
		return next;
	}

	private async rebuildIndex(): Promise<PersistedAgentDatabase | undefined> {
		if (!this._storage.list) {
			return undefined;
		}
		const names = await this._storage.list(this.root());
		const sessions: SessionIndexRecord[] = [];
		for (const name of names) {
			if (!name || name === 'index.json' || name.startsWith('index.json')) {
				continue;
			}
			const session = await this.readSession(name);
			if (!session) {
				continue;
			}
			sessions.push({
				id: session.id,
				workspaceId: session.workspaceId,
				title: session.title,
				updatedAt: session.updatedAt,
				createdAt: session.createdAt,
				mode: session.mode,
				status: session.status,
				claudeSessionId: session.claudeSessionId,
				checkpointIds: session.checkpointIds,
				worktree: session.worktree,
			});
		}
		if (sessions.length === 0) {
			return undefined;
		}
		sessions.sort((a, b) => b.updatedAt - a.updatedAt);
		return { schemaVersion: AGENT_DATABASE_SCHEMA_VERSION, sessions, preferences: {} };
	}

	private root(): string {
		return join(this._userDataPath, 'agent-sessions');
	}

	private sessionDir(sessionId: string): string {
		assertSafeId(sessionId);
		return join(this.root(), sessionId);
	}

	private async writeAtomic(path: string, text: string): Promise<void> {
		const tmp = `${path}.tmp-${generateUuid()}`;
		await this._storage.write(tmp, text);
		await this._storage.rename(tmp, path);
	}

	private queue(sessionId: string, run: () => Promise<void>): Promise<void> {
		const previous = this._tails.get(sessionId) ?? Promise.resolve();
		const next = previous.then(run, run);
		this._tails.set(sessionId, next.then(() => undefined, () => undefined));
		return next;
	}
}

export function emptyDatabase(): PersistedAgentDatabase {
	return { schemaVersion: AGENT_DATABASE_SCHEMA_VERSION, sessions: [], preferences: {} };
}

export interface AgentDatabaseMigration {
	readonly from: number;
	readonly to: number;
	run(sessions: Record<string, unknown>[]): Record<string, unknown>[];
}

/** Ordered schema steps. A future version is not rewritten down to the current one. */
export const agentDatabaseMigrations: readonly AgentDatabaseMigration[] = [
	{
		from: 1,
		to: 2,
		run: sessions => sessions.map(session => ({
			...session,
			status: typeof session.status === 'string' ? session.status : 'idle',
			createdAt: typeof session.createdAt === 'number' ? session.createdAt : session.updatedAt,
		})),
	},
];

/**
 * Moves an older index to the current schema. Unknown future versions keep
 * their session list and schema version. Unknown top-level fields are kept.
 * A bad payload becomes an empty database.
 */
export function migrateAgentDatabase(raw: unknown): PersistedAgentDatabase {
	if (!isRecord(raw)) {
		return emptyDatabase();
	}
	const preserved: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key !== 'schemaVersion' && key !== 'sessions' && key !== 'preferences') {
			preserved[key] = value;
		}
	}
	let version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1;
	let sessions = Array.isArray(raw.sessions) ? raw.sessions.filter(isRecord) : [];
	const preferences = isRecord(raw.preferences) ? raw.preferences as AgentPreferences : {};
	if (version > AGENT_DATABASE_SCHEMA_VERSION) {
		const records = sessions.filter(session => typeof session.id === 'string' && typeof session.title === 'string') as unknown as SessionIndexRecord[];
		return { ...preserved, schemaVersion: version, sessions: records, preferences };
	}
	for (const migration of agentDatabaseMigrations) {
		if (version === migration.from && version < migration.to) {
			sessions = migration.run(sessions);
			version = migration.to;
		}
	}
	if (version < AGENT_DATABASE_SCHEMA_VERSION) {
		version = AGENT_DATABASE_SCHEMA_VERSION;
	}
	const records: SessionIndexRecord[] = [];
	for (const session of sessions) {
		if (typeof session.id !== 'string' || typeof session.title !== 'string') {
			continue;
		}
		records.push(session as unknown as SessionIndexRecord);
	}
	return { ...preserved, schemaVersion: version, sessions: records, preferences };
}

function parseIndex(raw: string): PersistedAgentDatabase | undefined {
	try {
		return migrateAgentDatabase(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

function validHistoryPrefix(raw: string): string {
	const parts = raw.split('\n');
	if (raw.endsWith('\n')) {
		parts.pop();
	}
	const kept: string[] = [];
	for (const line of parts) {
		if (!line.trim()) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			break;
		}
		if (!isHistoryLine(parsed)) {
			break;
		}
		kept.push(line);
	}
	return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
}

function filterForkReviews(json: string, sessionId: string, turnIds: readonly string[]): string | undefined {
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!Array.isArray(parsed)) {
			return undefined;
		}
		const kept = parsed.filter(item => isRecord(item) && typeof item.turnId === 'string' && turnIds.includes(item.turnId)).map(item => ({ ...(item as Record<string, unknown>), sessionId }));
		return kept.length === 0 ? undefined : JSON.stringify(kept);
	} catch {
		return undefined;
	}
}

function referenceToken(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
	return cleaned || 'sub';
}

function isHistoryLine(value: unknown): value is StoredHistoryLine {
	return isRecord(value) && value.v === 1 && typeof value.ts === 'number' && 'event' in value && value.event !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** UTF-8 bytes of a text file. Callers that already have a string can ignore this. */
export function encodeSessionText(text: string): Uint8Array {
	return encoder.encode(text);
}
