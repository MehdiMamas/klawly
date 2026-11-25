/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A tiny stdio MCP server for the issue 428 acceptance run. It has two tools:
// `fill_form` asks for a form through elicitation and returns the answer, and
// `sign_in` asks the user to open a local URL; opening it completes the sign-in.
// No dependencies, so it runs with plain `node` once transpiled (`npm run transpile-client`):
//
//   claude mcp add elicitation-fixture -- node <repo>/out/vs/platform/claude/test/node/fixtures/elicitationMcpServer.js
//
// Then ask Claude to "call fill_form and sign_in from elicitation-fixture".

import { randomUUID } from 'crypto';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { createInterface } from 'readline';

interface JsonRpcMessage {
	readonly id?: string | number;
	readonly method?: string;
	readonly params?: Record<string, unknown>;
	readonly result?: unknown;
	readonly error?: { readonly code?: number; readonly message?: string };
}

interface ElicitResult {
	readonly action?: string;
}

interface ToolResult {
	readonly content: readonly { readonly type: 'text'; readonly text: string }[];
	readonly isError: boolean;
}

const FORM_SCHEMA = {
	type: 'object',
	properties: {
		name: { type: 'string', title: 'Name', minLength: 2 },
		email: { type: 'string', title: 'Email', format: 'email' },
		age: { type: 'integer', title: 'Age', minimum: 0, maximum: 150 },
		subscribe: { type: 'boolean', title: 'Subscribe', default: false },
		plan: { type: 'string', title: 'Plan', enum: ['free', 'pro'], enumNames: ['Free', 'Pro'] },
	},
	required: ['name', 'plan'],
};

const TOOLS = [
	{ name: 'fill_form', description: 'Asks the user for their name, email, age and plan through an MCP elicitation form, then returns the answer.', inputSchema: { type: 'object', properties: {} } },
	{ name: 'sign_in', description: 'Asks the user to open a sign-in URL through an MCP URL elicitation. Opening it completes the sign-in.', inputSchema: { type: 'object', properties: {} } },
];

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

let clientCapabilities: { readonly elicitation?: { readonly url?: object } } = {};
let nextRequestId = 1;
/** Our requests to the client, by JSON-RPC id. */
const waiting = new Map<string | number, { resolve(result: unknown): void; reject(error: Error): void }>();
/** Sign-ins whose URL has not been opened yet, by elicitation id. */
const signIns = new Map<string, () => void>();

function send(message: JsonRpcMessage): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function ask(method: string, params: Record<string, unknown>): Promise<ElicitResult | undefined> {
	const id = `fixture-${nextRequestId++}`;
	send({ id, method, params });
	return new Promise<ElicitResult | undefined>((resolve, reject) => waiting.set(id, { resolve: result => resolve(result as ElicitResult | undefined), reject }));
}

function text(value: unknown, isError = false): ToolResult {
	return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError };
}

const http = createServer((request, response) => {
	const state = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('state');
	const finish = state ? signIns.get(state) : undefined;
	response.writeHead(finish ? 200 : 404, { 'content-type': 'text/plain; charset=utf-8' });
	response.end(finish ? 'Signed in. You can close this tab and go back to Klawly.' : 'Unknown or finished sign-in.');
	finish?.();
});
const httpReady = new Promise<number>(resolve => http.listen(0, '127.0.0.1', () => resolve((http.address() as AddressInfo).port)));
http.unref();

async function fillForm(): Promise<ToolResult> {
	if (!clientCapabilities.elicitation) {
		return text('The client does not support elicitation.', true);
	}
	const result = await ask('elicitation/create', { message: 'The fixture needs a few details to continue.', requestedSchema: FORM_SCHEMA });
	return text({ elicitation: result });
}

async function signIn(): Promise<ToolResult> {
	if (!clientCapabilities.elicitation?.url) {
		return text('The client does not support URL elicitation.', true);
	}
	const port = await httpReady;
	const elicitationId = randomUUID();
	const opened = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signIns.delete(elicitationId);
			reject(new Error('The sign-in URL was not opened in time.'));
		}, SIGN_IN_TIMEOUT_MS);
		signIns.set(elicitationId, () => {
			clearTimeout(timer);
			signIns.delete(elicitationId);
			resolve();
		});
	});
	opened.catch(() => undefined);
	const result = await ask('elicitation/create', {
		mode: 'url',
		message: 'Sign in to the elicitation fixture.',
		url: `http://127.0.0.1:${port}/sign-in?state=${elicitationId}`,
		elicitationId,
	});
	if (result?.action !== 'accept') {
		signIns.get(elicitationId)?.();
		return text({ elicitation: result, signedIn: false });
	}
	try {
		await opened;
	} catch (error) {
		return text(String(error), true);
	}
	send({ method: 'notifications/elicitation/complete', params: { elicitationId } });
	return text({ elicitation: result, signedIn: true });
}

async function handle(message: JsonRpcMessage): Promise<void> {
	if (message.method === undefined) {
		// A response to one of our requests.
		if (message.id === undefined) {
			return;
		}
		const entry = waiting.get(message.id);
		waiting.delete(message.id);
		if (message.error) {
			entry?.reject(new Error(message.error.message ?? 'elicitation failed'));
		} else {
			entry?.resolve(message.result);
		}
		return;
	}
	if (message.id === undefined) {
		return; // A notification, such as notifications/initialized.
	}
	try {
		switch (message.method) {
			case 'initialize':
				clientCapabilities = (message.params?.capabilities ?? {}) as typeof clientCapabilities;
				send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'klawly-elicitation-fixture', version: '1.0.0' } } });
				return;
			case 'ping':
				send({ id: message.id, result: {} });
				return;
			case 'tools/list':
				send({ id: message.id, result: { tools: TOOLS } });
				return;
			case 'tools/call': {
				const name = message.params?.name;
				const result = name === 'fill_form' ? await fillForm() : name === 'sign_in' ? await signIn() : text(`Unknown tool ${name}`, true);
				send({ id: message.id, result });
				return;
			}
			default:
				send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
		}
	} catch (error) {
		send({ id: message.id, result: text(String(error), true) });
	}
}

createInterface({ input: process.stdin }).on('line', line => {
	if (!line.trim()) {
		return;
	}
	let message: JsonRpcMessage;
	try {
		message = JSON.parse(line) as JsonRpcMessage;
	} catch {
		return;
	}
	void handle(message);
});
process.stdin.on('end', () => process.exit(0));
