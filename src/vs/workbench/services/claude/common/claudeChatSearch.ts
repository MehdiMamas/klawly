/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { removeClaudeSecrets } from '../../../../platform/claude/common/claudeSecretScan.js';
import { StoredHistoryLine } from '../../../../platform/claude/common/claudeSessionStore.js';
import { AgentReducerEvent, TurnViewModel } from './claudeAgentState.js';
import { replayDurableEvents } from './claudeTranscript.js';

/**
 * Search inside past chats (issue 489). Each chat's prompts and Claude's replies are kept as
 * plain text in `search-index.json` beside the session index, never tool output or thinking,
 * and with every secret the guard finds removed. A word index built in memory picks the chats
 * that can match; the text then decides the turn and the line to show.
 */

/** One prompt or reply of a turn, as the index keeps it. */
export interface ClaudeChatSearchEntry {
	readonly turnId: string;
	readonly role: 'user' | 'assistant';
	readonly text: string;
}

interface ChatSearchDocument {
	/** The session's `updatedAt` when its text was taken. */
	readonly updatedAt: number;
	readonly entries: readonly ClaudeChatSearchEntry[];
}

interface PersistedChatSearchIndex {
	readonly v: 1;
	readonly sessions: Record<string, ChatSearchDocument>;
}

/** A turn whose prompt or reply has the searched words. */
export interface ClaudeChatSearchHit {
	readonly sessionId: string;
	readonly turnId: string;
	readonly role: 'user' | 'assistant';
	/** The line with the match, cut around it. */
	readonly line: string;
}

/** A session the search covers, with the time it last changed. */
export interface ClaudeChatSearchSession {
	readonly id: string;
	readonly updatedAt: number;
}

/** Where the index lives. {@link JsonlSessionStore} is one. */
export interface ClaudeChatSearchStorage {
	readSearchIndex(): Promise<string | undefined>;
	writeSearchIndex(json: string): Promise<void>;
	/** The session's `events.jsonl`, to index a chat saved before the index knew it. */
	read(sessionId: string): Promise<readonly StoredHistoryLine[]>;
}

/** Content search starts at this many characters; shorter text only matches titles. */
export const CLAUDE_CHAT_SEARCH_MIN_QUERY = 3;
/** One very long reply does not fill the file. */
const MAX_ENTRY_CHARS = 20_000;
const MAX_LINE_CHARS = 120;
const MAX_HITS_PER_SESSION = 3;
const DEFAULT_HIT_LIMIT = 30;
const SAVE_DELAY_MS = 1_000;

const WORD = /[\p{L}\p{N}_]+/gu;

/** The lowercase words of `text`, the unit the in-memory index keys on. */
export function chatSearchWords(text: string): string[] {
	return text.toLowerCase().match(WORD) ?? [];
}

/**
 * What the index keeps of a chat: each main-agent turn's prompt, the messages steered into it,
 * and Claude's reply text. Subagent chats, tools and thinking are not in it. Secrets are removed.
 */
export function claudeChatSearchEntries(turns: readonly TurnViewModel[]): ClaudeChatSearchEntry[] {
	const entries: ClaudeChatSearchEntry[] = [];
	const add = (turnId: string, role: 'user' | 'assistant', text: string) => {
		const clean = removeClaudeSecrets(text.slice(0, MAX_ENTRY_CHARS)).trim();
		if (clean) {
			entries.push({ turnId, role, text: clean });
		}
	};
	for (const turn of turns) {
		add(turn.id, 'user', turn.user.text);
		for (const steered of turn.steered) {
			add(turn.id, 'user', steered);
		}
		add(turn.id, 'assistant', turn.assistantText);
	}
	return entries;
}

/**
 * The line of `text` that best shows the match: the whole query when it is there,
 * else the first word of it. Cut to {@link MAX_LINE_CHARS} around the match.
 */
export function claudeChatSearchLine(text: string, query: string): string {
	const lower = text.toLowerCase();
	const phrase = query.trim().toLowerCase();
	let at = lower.indexOf(phrase);
	let length = phrase.length;
	if (at < 0) {
		const first = chatSearchWords(phrase)[0] ?? '';
		at = Math.max(0, lower.indexOf(first));
		length = first.length;
	}
	const start = text.lastIndexOf('\n', at - 1) + 1;
	const newline = text.indexOf('\n', at);
	const line = text.slice(start, newline < 0 ? text.length : newline);
	const offset = at - start;
	const collapse = (value: string) => value.replace(/\s+/g, ' ');
	if (line.length <= MAX_LINE_CHARS) {
		return collapse(line).trim();
	}
	const from = Math.max(0, Math.min(offset - Math.floor((MAX_LINE_CHARS - length) / 3), line.length - MAX_LINE_CHARS));
	const cut = line.slice(from, from + MAX_LINE_CHARS);
	return collapse(`${from > 0 ? '…' : ''}${cut.trim()}${from + MAX_LINE_CHARS < line.length ? '…' : ''}`);
}

/** True when every query word starts a word of `text`. */
function entryMatches(lowerText: string, queryWords: readonly string[]): boolean {
	return queryWords.every(word => {
		let at = lowerText.indexOf(word);
		while (at >= 0) {
			if (at === 0 || !isWordChar(lowerText.charAt(at - 1))) {
				return true;
			}
			at = lowerText.indexOf(word, at + 1);
		}
		return false;
	});
}

function isWordChar(char: string): boolean {
	return /[\p{L}\p{N}_]/u.test(char);
}

/**
 * The chat search index. `update` takes a saved chat's turns; `search` first indexes the chats
 * it has not seen or that changed since (from `events.jsonl`), then matches. Writes to disk are
 * batched; a write lost on quit heals, because the chat's newer `updatedAt` makes it index again.
 */
export class ClaudeChatSearchIndex implements IDisposable {
	private readonly _documents = new Map<string, ChatSearchDocument>();
	/** Word to the sessions that use it. */
	private readonly _words = new Map<string, Set<string>>();
	/** Session to its words, so a session can leave the word index. */
	private readonly _sessionWords = new Map<string, readonly string[]>();
	/** Sessions whose transcript was read in this process; an empty one is not read again. */
	private readonly _caughtUp = new Map<string, number>();
	private readonly _removed = new Set<string>();
	private _saveTimer: ReturnType<typeof setTimeout> | undefined;
	private _loaded: Promise<void> | undefined;
	private _disposed = false;

	constructor(private readonly _storage: ClaudeChatSearchStorage) { }

	/** A saved chat's turns. Newer text replaces what the index had. */
	update(sessionId: string, updatedAt: number, turns: readonly TurnViewModel[]): void {
		if (this._disposed || this._removed.has(sessionId)) {
			return;
		}
		this.setDocument(sessionId, { updatedAt, entries: claudeChatSearchEntries(turns) });
		this.scheduleSave();
	}

	/** A deleted chat leaves the index. */
	remove(sessionId: string): void {
		this._removed.add(sessionId);
		if (this._documents.delete(sessionId)) {
			this.unindex(sessionId);
			this.scheduleSave();
		}
	}

	/**
	 * Turns of `sessions` whose prompt or reply has every word of `query` (each as the start of a
	 * word). Chats come in the order given; within a chat, turns that hold the exact phrase come first.
	 */
	async search(query: string, sessions: readonly ClaudeChatSearchSession[], limit = DEFAULT_HIT_LIMIT): Promise<ClaudeChatSearchHit[]> {
		const words = [...new Set(chatSearchWords(query))];
		if (query.trim().length < CLAUDE_CHAT_SEARCH_MIN_QUERY || words.length === 0) {
			return [];
		}
		await this.catchUp(sessions);
		const candidates = this.candidates(words);
		const phrase = query.trim().toLowerCase();
		const hits: ClaudeChatSearchHit[] = [];
		for (const session of sessions) {
			if (hits.length >= limit) {
				break;
			}
			const document = candidates.has(session.id) ? this._documents.get(session.id) : undefined;
			if (!document) {
				continue;
			}
			const exact: ClaudeChatSearchHit[] = [];
			const loose: ClaudeChatSearchHit[] = [];
			const seen = new Set<string>();
			for (const entry of document.entries) {
				const key = `${entry.turnId}/${entry.role}`;
				const lower = entry.text.toLowerCase();
				if (seen.has(key) || !entryMatches(lower, words)) {
					continue;
				}
				seen.add(key);
				const hit: ClaudeChatSearchHit = { sessionId: session.id, turnId: entry.turnId, role: entry.role, line: claudeChatSearchLine(entry.text, query) };
				(lower.includes(phrase) ? exact : loose).push(hit);
			}
			hits.push(...[...exact, ...loose].slice(0, Math.min(MAX_HITS_PER_SESSION, limit - hits.length)));
		}
		return hits;
	}

	/** Writes any pending change now. */
	async flush(): Promise<void> {
		if (this._saveTimer !== undefined) {
			clearTimeout(this._saveTimer);
			this._saveTimer = undefined;
			await this.save();
		}
	}

	/** Writes a pending change, then takes no more. */
	dispose(): void {
		void this.flush();
		this._disposed = true;
	}

	private scheduleSave(): void {
		if (this._disposed || this._saveTimer !== undefined) {
			return;
		}
		this._saveTimer = setTimeout(() => {
			this._saveTimer = undefined;
			void this.save();
		}, SAVE_DELAY_MS);
	}

	/** Sessions that hold a word starting with each query word. */
	private candidates(words: readonly string[]): Set<string> {
		let result: Set<string> | undefined;
		for (const word of words) {
			const sessions = new Set<string>();
			for (const [indexed, owners] of this._words) {
				if (indexed.startsWith(word)) {
					for (const owner of owners) {
						if (!result || result.has(owner)) {
							sessions.add(owner);
						}
					}
				}
			}
			result = sessions;
			if (result.size === 0) {
				break;
			}
		}
		return result ?? new Set();
	}

	private async catchUp(sessions: readonly ClaudeChatSearchSession[]): Promise<void> {
		await this.load();
		let changed = false;
		for (const session of sessions) {
			const known = this._documents.get(session.id);
			if (this._removed.has(session.id) || (known && known.updatedAt >= session.updatedAt) || (this._caughtUp.get(session.id) ?? -1) >= session.updatedAt) {
				continue;
			}
			this._caughtUp.set(session.id, session.updatedAt);
			let lines: readonly StoredHistoryLine[];
			try {
				lines = await this._storage.read(session.id);
			} catch {
				continue;
			}
			// An `update` may have come while the transcript was read; it is newer.
			if (this._removed.has(session.id) || (this._documents.get(session.id)?.updatedAt ?? -1) >= session.updatedAt) {
				continue;
			}
			const replay = replayDurableEvents(lines.map(line => line.event as AgentReducerEvent));
			this.setDocument(session.id, { updatedAt: session.updatedAt, entries: claudeChatSearchEntries(replay.state.turns) });
			changed = true;
		}
		if (changed) {
			this.scheduleSave();
		}
	}

	private load(): Promise<void> {
		this._loaded ??= this.readFile();
		return this._loaded;
	}

	private async readFile(): Promise<void> {
		let raw: string | undefined;
		try {
			raw = await this._storage.readSearchIndex();
		} catch {
			return;
		}
		const parsed = parsePersistedIndex(raw);
		for (const [sessionId, document] of Object.entries(parsed?.sessions ?? {})) {
			// What `update` gave before the file was read is newer.
			if (!this._removed.has(sessionId) && !this._documents.has(sessionId)) {
				this.setDocument(sessionId, document);
			}
		}
	}

	private async save(): Promise<void> {
		await this.load();
		const sessions: Record<string, ChatSearchDocument> = {};
		for (const [sessionId, document] of this._documents) {
			sessions[sessionId] = document;
		}
		const persisted: PersistedChatSearchIndex = { v: 1, sessions };
		try {
			await this._storage.writeSearchIndex(JSON.stringify(persisted));
		} catch {
			// The next save or the next search writes it again.
		}
	}

	private setDocument(sessionId: string, document: ChatSearchDocument): void {
		this.unindex(sessionId);
		this._documents.set(sessionId, document);
		const words = [...new Set(document.entries.flatMap(entry => chatSearchWords(entry.text)))];
		this._sessionWords.set(sessionId, words);
		for (const word of words) {
			let owners = this._words.get(word);
			if (!owners) {
				owners = new Set();
				this._words.set(word, owners);
			}
			owners.add(sessionId);
		}
	}

	private unindex(sessionId: string): void {
		for (const word of this._sessionWords.get(sessionId) ?? []) {
			const owners = this._words.get(word);
			owners?.delete(sessionId);
			if (owners?.size === 0) {
				this._words.delete(word);
			}
		}
		this._sessionWords.delete(sessionId);
	}
}

function parsePersistedIndex(raw: string | undefined): PersistedChatSearchIndex | undefined {
	if (!raw) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<PersistedChatSearchIndex>;
		if (parsed?.v !== 1 || !parsed.sessions || typeof parsed.sessions !== 'object') {
			return undefined;
		}
		const sessions: Record<string, ChatSearchDocument> = {};
		for (const [sessionId, document] of Object.entries(parsed.sessions)) {
			if (typeof document?.updatedAt === 'number' && Array.isArray(document.entries)) {
				sessions[sessionId] = {
					updatedAt: document.updatedAt,
					entries: document.entries.filter(entry => typeof entry?.turnId === 'string' && typeof entry.text === 'string' && (entry.role === 'user' || entry.role === 'assistant')),
				};
			}
		}
		return { v: 1, sessions };
	} catch {
		return undefined;
	}
}
