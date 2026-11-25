/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { AgentMode } from '../common/claudeContext.js';
import { claudeMergeDebugLines } from '../common/claudeDebugSources.js';
import { claudeDebugLogText, ClaudeDebugExtraLines, ClaudeDebugLogLine, ClaudeReproductionAnswer, ClaudeReproductionRequest, ClaudeReproductionResult } from '../common/claudeDebugMode.js';

/** Lines kept per capture; older ones are dropped and counted. */
export const CLAUDE_DEBUG_LOG_MAX_LINES = 1000;

/** Characters kept per line. */
export const CLAUDE_DEBUG_LOG_LINE_CHARS = 1000;

/** The largest body one post may send; the rest is not read. */
const MAX_BODY_BYTES = 64 * 1024;

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': '*',
	// A page on a public origin may post to a loopback address only with this (Private Network Access).
	'Access-Control-Allow-Private-Network': 'true',
};

/**
 * A log collector for one Debug-mode session (issue 484): an HTTP endpoint on
 * a free loopback port. Instrumentation posts to `/log/<secret>`; lines are kept
 * only while a capture runs, so the user decides what Claude reads. CORS is open
 * so the user's own web app can post, so the secret path is what keeps any other
 * page in the browser, or another local process, from writing into a capture.
 */
export class ClaudeDebugLogSink {
	/** The only path that takes posts. */
	private readonly _path = `/log/${generateUuid()}`;
	private _server: Server | undefined;
	private _url: Promise<string> | undefined;
	private _lines: ClaudeDebugLogLine[] = [];
	private _dropped = 0;
	private _capturing = false;
	private _start = 0;

	constructor(private readonly _now: () => number = Date.now) { }

	/** Starts listening once; resolves to the URL instrumentation posts to. */
	listen(): Promise<string> {
		if (!this._url) {
			this._url = import('http').then(({ createServer }) => new Promise<string>((resolve, reject) => {
				const server = createServer((request, response) => this.handle(request, response));
				this._server = server;
				server.once('error', reject);
				server.listen(0, '127.0.0.1', () => {
					server.off('error', reject);
					resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}${this._path}`);
				});
			}));
		}
		return this._url;
	}

	/** Drops what came before and keeps what comes next. */
	startCapture(): void {
		this._lines = [];
		this._dropped = 0;
		this._capturing = true;
		this._start = this._now();
	}

	/** Ends the capture and returns its lines. */
	take(): { readonly lines: readonly ClaudeDebugLogLine[]; readonly dropped: number } {
		const taken = { lines: this._lines, dropped: this._dropped };
		this._lines = [];
		this._dropped = 0;
		this._capturing = false;
		return taken;
	}

	add(body: string): void {
		if (!this._capturing || !body.trim()) {
			return;
		}
		this._lines.push({ at: Math.max(0, this._now() - this._start), text: claudeDebugLogText(body, CLAUDE_DEBUG_LOG_LINE_CHARS) });
		if (this._lines.length > CLAUDE_DEBUG_LOG_MAX_LINES) {
			this._lines.shift();
			this._dropped++;
		}
	}

	close(): void {
		this._server?.close();
		this._server?.closeAllConnections();
		this._server = undefined;
		this._url = undefined;
		this.take();
	}

	private handle(request: IncomingMessage, response: ServerResponse): void {
		const path = (request.url ?? '').replace(/\?.*$/, '');
		if (request.method === 'OPTIONS') {
			response.writeHead(204, CORS_HEADERS).end();
			return;
		}
		if (request.method !== 'POST' || path !== this._path) {
			response.writeHead(404, CORS_HEADERS).end();
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		request.on('data', (chunk: Buffer) => {
			if (size < MAX_BODY_BYTES) {
				chunks.push(chunk.subarray(0, MAX_BODY_BYTES - size));
			}
			size += chunk.length;
		});
		request.on('end', () => {
			this.add(Buffer.concat(chunks).toString('utf8'));
			response.writeHead(204, CORS_HEADERS).end();
		});
		request.on('error', () => response.destroy());
	}
}

/** What Debug mode's tools ask of the runtime for one session. */
export interface ClaudeDebugToolProvider {
	/** Starts the session's sink if needed and returns its log URL. */
	endpoint(sessionId: string): Promise<string>;
	/** Shows the Reproduce card in the window that owns the session and waits for the user. */
	reproduce(request: { readonly sessionId: string; readonly steps?: string; readonly signal: AbortSignal }): Promise<ClaudeReproductionResult>;
	/** Stops the session's sink; a waiting reproduction is cancelled. */
	close(sessionId: string): void;
}

/** Debug mode's tools for one session's query. */
export interface ClaudeDebugToolHost {
	/** The log URL, or why the tool refuses. */
	endpoint(): Promise<{ readonly url: string } | { readonly refusal: string }>;
	reproduce(steps: string | undefined, signal: AbortSignal | undefined): Promise<ClaudeReproductionResult>;
}

/** The session a tool call belongs to, read when the call arrives. */
export interface ClaudeDebugToolSession {
	readonly sessionId: string | undefined;
	readonly mode: AgentMode;
	readonly signal: AbortSignal;
}

const NOT_DEBUG = 'This tool works only in Debug mode. The user can switch modes in the mode menu.';

/** The query's tool host: refuses outside Debug mode, so the sink runs only for a Debug-mode session. */
export function claudeDebugToolHost(provider: ClaudeDebugToolProvider, current: () => ClaudeDebugToolSession): ClaudeDebugToolHost {
	return {
		endpoint: async () => {
			const { sessionId, mode } = current();
			if (!sessionId || mode !== 'debug') {
				return { refusal: NOT_DEBUG };
			}
			return { url: await provider.endpoint(sessionId) };
		},
		reproduce: async (steps, signal) => {
			const session = current();
			if (!session.sessionId || session.mode !== 'debug') {
				return { kind: 'failed', message: NOT_DEBUG };
			}
			if (session.signal.aborted) {
				return { kind: 'cancelled' };
			}
			return provider.reproduce({ sessionId: session.sessionId, steps, signal: signal ? AbortSignal.any([signal, session.signal]) : session.signal });
		},
	};
}

interface PendingReproduction {
	readonly request: ClaudeReproductionRequest;
	readonly answer: (result: ClaudeReproductionResult) => void;
}

/**
 * The runtime side of Debug mode: one sink per Debug-mode session and the
 * reproductions waiting for a window. Each waiting tool call is answered
 * exactly once: by the user, by a stop, or when the session leaves Debug mode.
 */
export class ClaudeDebugSessions extends Disposable implements ClaudeDebugToolProvider {
	private readonly _onDidRequestReproduction = this._register(new Emitter<ClaudeReproductionRequest>());
	readonly onDidRequestReproduction = this._onDidRequestReproduction.event;

	private readonly _sinks = new Map<string, ClaudeDebugLogSink>();
	private readonly _pending = new Map<string, PendingReproduction>();

	constructor(private readonly _createSink: () => ClaudeDebugLogSink = () => new ClaudeDebugLogSink()) {
		super();
	}

	endpoint(sessionId: string): Promise<string> {
		let sink = this._sinks.get(sessionId);
		if (!sink) {
			sink = this._createSink();
			this._sinks.set(sessionId, sink);
		}
		return sink.listen();
	}

	reproduce(request: { readonly sessionId: string; readonly steps?: string; readonly signal: AbortSignal }): Promise<ClaudeReproductionResult> {
		if (request.signal.aborted) {
			return Promise.resolve({ kind: 'cancelled' });
		}
		if (!this._sinks.has(request.sessionId)) {
			return Promise.resolve({ kind: 'failed', message: 'No log URL yet. Call debug_log_endpoint, add the instrumentation, then ask for the reproduction.' });
		}
		const requestId = generateUuid();
		return new Promise<ClaudeReproductionResult>(resolve => {
			const answer = (result: ClaudeReproductionResult) => {
				if (this._pending.get(requestId)?.answer !== answer) {
					return;
				}
				this._pending.delete(requestId);
				request.signal.removeEventListener('abort', onAbort);
				resolve(result);
			};
			const onAbort = () => answer({ kind: 'cancelled' });
			const view: ClaudeReproductionRequest = { sessionId: request.sessionId, requestId, steps: request.steps?.trim() || undefined };
			this._pending.set(requestId, { request: view, answer });
			request.signal.addEventListener('abort', onAbort, { once: true });
			this._onDidRequestReproduction.fire(view);
		});
	}

	/** The user pressed Start Capturing. Unknown ids are ignored. */
	startCapture(sessionId: string, requestId: string): void {
		if (this._pending.get(requestId)?.request.sessionId === sessionId) {
			this._sinks.get(sessionId)?.startCapture();
		}
	}

	/** The user pressed I Reproduced It or Cancel. Unknown ids are ignored. */
	resolve(sessionId: string, requestId: string, answer: ClaudeReproductionAnswer, extra?: ClaudeDebugExtraLines): void {
		const pending = this._pending.get(requestId);
		if (pending?.request.sessionId !== sessionId) {
			return;
		}
		const sink = this._sinks.get(sessionId);
		if (answer === 'cancelled' || !sink) {
			sink?.take();
			pending.answer({ kind: 'cancelled' });
			return;
		}
		pending.answer({ kind: 'captured', ...claudeMergeDebugLines(sink.take(), extra) });
	}

	close(sessionId: string): void {
		for (const pending of [...this._pending.values()]) {
			if (pending.request.sessionId === sessionId) {
				pending.answer({ kind: 'cancelled' });
			}
		}
		this._sinks.get(sessionId)?.close();
		this._sinks.delete(sessionId);
	}

	override dispose(): void {
		for (const sessionId of [...this._sinks.keys()]) {
			this.close(sessionId);
		}
		super.dispose();
	}
}
