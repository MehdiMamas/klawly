/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

/** What a tool call returns to Claude Code: MCP content items. */
export interface ClaudeLocalToolResult {
	readonly content: readonly ({ readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly data: string; readonly mimeType: string })[];
	readonly isError?: boolean;
	readonly [key: string]: unknown;
}

/** One tool of a server Klawly runs for Claude Code. */
export interface ClaudeLocalTool {
	readonly name: string;
	readonly description: string;
	/** A JSON Schema object for the arguments. */
	readonly inputSchema: Record<string, unknown>;
	/** True lists the tool upfront instead of behind Claude Code's tool search. */
	readonly alwaysLoad?: boolean;
	/** Runs the call. `signal` aborts when Claude Code cancels it or the connection drops. */
	call(args: Record<string, unknown>, signal: AbortSignal): Promise<ClaudeLocalToolResult>;
}

export interface ClaudeLocalMcpServer {
	readonly instructions?: string;
	readonly tools: readonly ClaudeLocalTool[];
}

/** Answers one hook POST: the JSON Claude Code reads back. */
export type ClaudeLocalHookHandler = (input: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>;

const MCP_PROTOCOL_VERSION = '2025-03-26';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * One localhost HTTP server for one Claude Code process. It hosts the MCP
 * servers Klawly offers (its own tools, the permission tool) and the hook
 * endpoints, replacing what the SDK ran in-process. It listens on 127.0.0.1
 * only, and every path starts with a random token, so another program on the
 * machine cannot reach a tool or answer a permission request.
 */
export class ClaudeLocalBridge {
	private readonly _token = randomBytes(24).toString('hex');
	private readonly _servers = new Map<string, ClaudeLocalMcpServer>();
	private readonly _hooks = new Map<string, ClaudeLocalHookHandler>();
	private _server: Server | undefined;
	private _port = 0;

	addMcpServer(name: string, server: ClaudeLocalMcpServer): void {
		this._servers.set(name, server);
	}

	addHook(event: string, handler: ClaudeLocalHookHandler): void {
		this._hooks.set(event, handler);
	}

	get port(): number {
		return this._port;
	}

	async start(): Promise<void> {
		const { createServer } = await import('http');
		const server = createServer((request, response) => { void this._handle(request, response); });
		// A terminal tool call can wait an hour for the user.
		server.requestTimeout = 0;
		server.timeout = 0;
		this._server = server;
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => resolve());
		});
		this._port = (server.address() as AddressInfo).port;
	}

	/** The `--mcp-config` entry for one hosted server. */
	mcpConfig(name: string, host: string = '127.0.0.1', port: number = this._port): Record<string, unknown> {
		const tools = this._servers.get(name)?.tools ?? [];
		return { type: 'http', url: `http://${host}:${port}/mcp/${this._token}/${encodeURIComponent(name)}`, ...tools.some(tool => tool.alwaysLoad) ? { alwaysLoad: true } : {} };
	}

	/** The URL a hook entry posts to. */
	hookUrl(event: string, host: string = '127.0.0.1', port: number = this._port): string {
		return `http://${host}:${port}/hook/${this._token}/${encodeURIComponent(event)}`;
	}

	close(): void {
		this._server?.close();
		this._server?.closeAllConnections();
		this._server = undefined;
	}

	private async _handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const abort = new AbortController();
		response.on('close', () => abort.abort());
		try {
			const [, kind, token, name] = (request.url ?? '').split('?')[0].split('/');
			if (token !== this._token || request.method !== 'POST') {
				// A GET asks for the optional event stream; 405 tells Claude Code there is none.
				response.writeHead(request.method === 'GET' && token === this._token ? 405 : 404).end();
				return;
			}
			const body = await readBody(request);
			if (kind === 'hook') {
				const handler = this._hooks.get(decodeURIComponent(name ?? ''));
				if (!handler) {
					response.writeHead(404).end();
					return;
				}
				sendJson(response, 200, await handler(JSON.parse(body) as Record<string, unknown>, abort.signal));
				return;
			}
			const server = kind === 'mcp' ? this._servers.get(decodeURIComponent(name ?? '')) : undefined;
			if (!server) {
				response.writeHead(404).end();
				return;
			}
			await this._handleMcp(decodeURIComponent(name), server, JSON.parse(body) as unknown, response, abort);
		} catch (error) {
			if (!response.headersSent) {
				sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
			} else {
				response.end();
			}
		}
	}

	/** In-flight calls by `server/request id`: ids repeat across servers. */
	private readonly _calls = new Map<string, AbortController>();

	private async _handleMcp(serverName: string, server: ClaudeLocalMcpServer, message: unknown, response: ServerResponse, abort: AbortController): Promise<void> {
		const request = message as { id?: string | number; method?: string; params?: Record<string, unknown> };
		if (typeof request !== 'object' || request === null || typeof request.method !== 'string') {
			sendJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
			return;
		}
		if (request.id === undefined) {
			// A notification. Only a cancellation does anything.
			if (request.method === 'notifications/cancelled') {
				const target = request.params?.requestId;
				if (typeof target === 'string' || typeof target === 'number') {
					this._calls.get(`${serverName}/${target}`)?.abort();
				}
			}
			response.writeHead(202).end();
			return;
		}
		const reply = (result: unknown) => sendJson(response, 200, { jsonrpc: '2.0', id: request.id, result });
		switch (request.method) {
			case 'initialize':
				reply({
					protocolVersion: typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : MCP_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: 'klawly', version: '1.0.0' },
					...server.instructions ? { instructions: server.instructions } : {},
				});
				return;
			case 'ping':
				reply({});
				return;
			case 'tools/list':
				reply({
					tools: server.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema,
						...tool.alwaysLoad ? { _meta: { 'anthropic/alwaysLoad': true } } : {},
					})),
				});
				return;
			case 'tools/call': {
				const tool = server.tools.find(candidate => candidate.name === request.params?.name);
				if (!tool) {
					sendJson(response, 200, { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: `Unknown tool: ${String(request.params?.name)}` } });
					return;
				}
				// One signal for both ways a call ends early: a cancel notification and a dropped connection.
				const call = new AbortController();
				abort.signal.addEventListener('abort', () => call.abort(), { once: true });
				this._calls.set(`${serverName}/${request.id}`, call);
				try {
					const args = typeof request.params?.arguments === 'object' && request.params.arguments !== null ? request.params.arguments as Record<string, unknown> : {};
					reply(await tool.call(args, call.signal));
				} catch (error) {
					reply({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
				} finally {
					this._calls.delete(`${serverName}/${request.id}`);
				}
				return;
			}
			default:
				sendJson(response, 200, { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } });
		}
	}
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	if (response.writableEnded || response.destroyed) {
		return;
	}
	response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error('The request is too large.'));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		request.on('error', reject);
	});
}
