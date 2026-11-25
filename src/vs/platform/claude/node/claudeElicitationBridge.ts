/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../base/common/uuid.js';
import { CLAUDE_ELICITATION_TIMEOUT_MS, ClaudeElicitationAnswer, ClaudeElicitationRequest, ClaudeElicitationSource, claudeElicitationUrlHost } from '../common/claudeElicitation.js';
import { NormalizedClaudeEvent } from '../common/claudeProtocol.js';
import { ClaudeElicitationQueryRequest, ClaudeElicitationQueryResult } from './claudeQuery.js';

interface PendingElicitation {
	readonly resolve: (settled: SettledElicitation) => void;
	readonly cleanup: () => void;
}

interface SettledElicitation {
	readonly answer: ClaudeElicitationAnswer;
	readonly source: ClaudeElicitationSource;
}

const CANCELLED: ClaudeElicitationAnswer = { action: 'cancel' };

/** How long a URL request waits for Claude Code to name the server's configured URL. */
const SERVER_URL_TIMEOUT_MS = 2000;

/**
 * Holds MCP elicitation requests until the workbench answers (issue 428). It
 * works like the permission bridge: a request ends as `cancel` when the
 * session stops, the query aborts, the wait times out or the bridge is
 * disposed. Nothing here ever answers `accept` on its own.
 */
export class ClaudeElicitationBridge {
	private readonly _pending = new Map<string, PendingElicitation>();

	request(request: { readonly sessionId: string; readonly id: string; readonly signal: AbortSignal; readonly timeoutMs: number }): Promise<SettledElicitation> {
		const key = pendingKey(request.sessionId, request.id);
		if (request.signal.aborted) {
			return Promise.resolve({ answer: CANCELLED, source: 'session-stopped' });
		}
		return new Promise<SettledElicitation>(resolvePromise => {
			const onAbort = () => this.settle(key, { answer: CANCELLED, source: 'session-stopped' });
			const timer = setTimeout(() => this.settle(key, { answer: CANCELLED, source: 'timeout' }), request.timeoutMs);
			request.signal.addEventListener('abort', onAbort, { once: true });
			this._pending.get(key)?.resolve({ answer: CANCELLED, source: 'session-stopped' });
			this._pending.set(key, {
				resolve: resolvePromise,
				cleanup: () => {
					clearTimeout(timer);
					request.signal.removeEventListener('abort', onAbort);
				},
			});
		});
	}

	/** Answers one pending request. Returns false when nothing was waiting. */
	resolve(sessionId: string, id: string, answer: ClaudeElicitationAnswer): boolean {
		return this.settle(pendingKey(sessionId, id), { answer: sanitize(answer), source: 'user' });
	}

	/** Cancels every request this session is waiting on. */
	cancelSession(sessionId: string): void {
		const prefix = `${sessionId}\n`;
		for (const key of [...this._pending.keys()]) {
			if (key.startsWith(prefix)) {
				this.settle(key, { answer: CANCELLED, source: 'session-stopped' });
			}
		}
	}

	hasPending(sessionId: string): boolean {
		const prefix = `${sessionId}\n`;
		return [...this._pending.keys()].some(key => key.startsWith(prefix));
	}

	dispose(): void {
		for (const key of [...this._pending.keys()]) {
			this.settle(key, { answer: CANCELLED, source: 'session-stopped' });
		}
	}

	private settle(key: string, settled: SettledElicitation): boolean {
		const pending = this._pending.get(key);
		if (!pending) {
			return false;
		}
		this._pending.delete(key);
		pending.cleanup();
		pending.resolve(settled);
		return true;
	}
}

/** What {@link runClaudeElicitation} needs from the runner. */
export interface ClaudeElicitationContext {
	readonly bridge: ClaudeElicitationBridge;
	readonly sessionId: string;
	readonly push: (event: NormalizedClaudeEvent) => void;
	readonly timeoutMs?: number;
	/** The configured URL of an MCP server by name, so a URL card can compare hosts. */
	readonly serverUrl?: (server: string) => Promise<string | undefined>;
	readonly now?: () => number;
	readonly newId?: () => string;
}

/** Turns the SDK's request into the normalized one the card reads. */
export function normalizeClaudeElicitation(request: ClaudeElicitationQueryRequest, id: string, expiresAt: number): ClaudeElicitationRequest {
	const mode = request.mode === 'url' ? 'url' : 'form';
	const urlHost = mode === 'url' ? claudeElicitationUrlHost(request.url) : undefined;
	return {
		id,
		server: request.serverName,
		mode,
		message: request.message,
		title: request.title?.trim() || undefined,
		schema: mode === 'form' ? request.requestedSchema : undefined,
		// Only an http(s) link reaches the card. Anything else is not offered for opening.
		url: urlHost ? request.url : undefined,
		urlHost,
		elicitationId: request.elicitationId,
		expiresAt,
	};
}

/**
 * The runner's `onElicitation`: shows the request, waits for the answer and
 * hands it to the SDK. A URL request whose link is not http(s) has nothing the
 * user can safely open, so it is declined without a wait.
 */
export async function runClaudeElicitation(context: ClaudeElicitationContext, request: ClaudeElicitationQueryRequest, signal: AbortSignal): Promise<ClaudeElicitationQueryResult> {
	const timeoutMs = context.timeoutMs ?? CLAUDE_ELICITATION_TIMEOUT_MS;
	const base = normalizeClaudeElicitation(request, context.newId?.() ?? `elicitation-${generateUuid()}`, (context.now?.() ?? Date.now()) + timeoutMs);
	// Only a URL request waits for the server's URL; without a lookup nothing is awaited before the card shows.
	const serverHost = base.url && context.serverUrl ? claudeElicitationUrlHost(await serverUrl(context.serverUrl, base.server)) : undefined;
	const normalized: ClaudeElicitationRequest = serverHost ? { ...base, serverHost } : base;
	const { sessionId } = context;
	context.push({ type: 'elicitation.requested', sessionId, request: normalized });
	const settled: SettledElicitation = normalized.mode === 'url' && !normalized.url
		? { answer: { action: 'decline' }, source: 'user' }
		: await context.bridge.request({ sessionId, id: normalized.id, signal, timeoutMs });
	context.push({ type: 'elicitation.resolved', sessionId, outcome: { id: normalized.id, server: normalized.server, mode: normalized.mode, action: settled.answer.action, source: settled.source } });
	return settled.answer.action === 'accept' && settled.answer.content
		? { action: 'accept', content: copyContent(settled.answer.content) }
		: { action: settled.answer.action };
}

/** The server's configured URL. A slow or failed status call leaves it out instead of holding the card. */
async function serverUrl(lookup: (server: string) => Promise<string | undefined>, server: string): Promise<string | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			lookup(server),
			new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), SERVER_URL_TIMEOUT_MS); }),
		]);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/** Only the three MCP actions pass, and only `accept` carries content, a question card's notes or its reply. */
function sanitize(answer: ClaudeElicitationAnswer): ClaudeElicitationAnswer {
	switch (answer.action) {
		case 'accept': return {
			action: 'accept',
			...(answer.content ? { content: answer.content } : {}),
			...(answer.notes ? { notes: stringsOf(answer.notes) } : {}),
			...(typeof answer.reply === 'string' ? { reply: answer.reply } : {}),
		};
		case 'decline': return { action: 'decline' };
		default: return CANCELLED;
	}
}

function copyContent(content: Readonly<Record<string, string | number | boolean | readonly string[]>>): Record<string, string | number | boolean | string[]> {
	const copy: Record<string, string | number | boolean | string[]> = {};
	for (const [key, value] of Object.entries(content)) {
		copy[key] = Array.isArray(value) ? [...value] : value as string | number | boolean;
	}
	return copy;
}

/** Keeps the string values of a record that crossed IPC. */
function stringsOf(record: Readonly<Record<string, unknown>>): Record<string, string> {
	const strings: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) {
		if (typeof value === 'string') {
			strings[key] = value;
		}
	}
	return strings;
}

function pendingKey(sessionId: string, id: string): string {
	return `${sessionId}\n${id}`;
}
