/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { tmpdir } from 'os';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeElicitationForm, claudeElicitationHostDiffers, claudeElicitationUrlHost, parseClaudeElicitationJson, validateClaudeElicitationForm } from '../../common/claudeElicitation.js';
import { NormalizedClaudeEvent } from '../../common/claudeProtocol.js';
import { ClaudeAgentRunner } from '../../node/claudeAgentRunner.js';
import { ClaudeElicitationBridge, runClaudeElicitation } from '../../node/claudeElicitationBridge.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeElicitationQueryRequest, ClaudeQuery, ClaudeQueryStart } from '../../node/claudeQuery.js';
import { createClaudeBridge } from '../../node/claudeCliQuery.js';
import { createClaudeNormalizerState, normalizeClaudeMessage } from '../../node/claudeStreamNormalizer.js';

const FORM_SCHEMA = {
	type: 'object',
	properties: {
		name: { type: 'string', title: 'Name', minLength: 2 },
		email: { type: 'string', format: 'email', description: 'Work address' },
		age: { type: 'integer', minimum: 0, maximum: 150 },
		ratio: { type: 'number', default: 0.5 },
		subscribe: { type: 'boolean', default: true },
		plan: { type: 'string', enum: ['free', 'pro'], enumNames: ['Free', 'Pro'], default: 'pro' },
		region: { type: 'string', oneOf: [{ const: 'eu', title: 'Europe' }, { const: 'us', title: 'United States' }] },
		tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, maxItems: 1 },
	},
	required: ['name', 'plan'],
};

function formRequest(overrides: Partial<ClaudeElicitationQueryRequest> = {}): ClaudeElicitationQueryRequest {
	return { serverName: 'acme', message: 'Who are you?', mode: 'form', requestedSchema: FORM_SCHEMA, ...overrides };
}

suite('Claude MCP elicitation', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a flat schema maps each primitive and enum to a field; any other shape falls back to JSON', () => {
		assert.deepStrictEqual(claudeElicitationForm(FORM_SCHEMA), {
			kind: 'fields',
			fields: [
				{ key: 'name', title: 'Name', description: undefined, required: true, kind: 'text', format: undefined, minLength: 2, maxLength: undefined, defaultValue: undefined },
				{ key: 'email', title: 'email', description: 'Work address', required: false, kind: 'text', format: 'email', minLength: undefined, maxLength: undefined, defaultValue: undefined },
				{ key: 'age', title: 'age', description: undefined, required: false, kind: 'number', integer: true, minimum: 0, maximum: 150, defaultValue: undefined },
				{ key: 'ratio', title: 'ratio', description: undefined, required: false, kind: 'number', integer: false, minimum: undefined, maximum: undefined, defaultValue: 0.5 },
				{ key: 'subscribe', title: 'subscribe', description: undefined, required: false, kind: 'boolean', defaultValue: true },
				{ key: 'plan', title: 'plan', description: undefined, required: true, kind: 'enum', options: [{ value: 'free', label: 'Free' }, { value: 'pro', label: 'Pro' }], defaultValue: 'pro' },
				{ key: 'region', title: 'region', description: undefined, required: false, kind: 'enum', options: [{ value: 'eu', label: 'Europe' }, { value: 'us', label: 'United States' }], defaultValue: undefined },
				{ key: 'tags', title: 'tags', description: undefined, required: false, kind: 'multiEnum', options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }], minItems: undefined, maxItems: 1, defaultValue: undefined },
			],
		});
		assert.deepStrictEqual([
			claudeElicitationForm(undefined),
			claudeElicitationForm({ type: 'array' }),
			claudeElicitationForm({ type: 'object', properties: { nested: { type: 'object', properties: {} } } }),
			claudeElicitationForm({ type: 'object', properties: { phone: { type: 'string', format: 'phone' } } }),
			claudeElicitationForm({ type: 'object', properties: { mixed: { type: 'string', enum: ['a', 1] } } }),
		].map(form => form.kind), ['json', 'json', 'json', 'json', 'json']);
	});

	test('validation names each problem, and the content leaves out missing optional values', () => {
		const form = claudeElicitationForm(FORM_SCHEMA);
		assert.ok(form.kind === 'fields');
		assert.deepStrictEqual(validateClaudeElicitationForm(form.fields, { name: 'x', email: 'nope', age: 1.5, plan: 'gold', tags: ['a', 'b'] }), {
			problems: {
				name: { code: 'minLength', limit: 2 },
				email: { code: 'format', format: 'email' },
				age: { code: 'integer' },
				plan: { code: 'option' },
				tags: { code: 'maxItems', limit: 1 },
			},
		});
		assert.deepStrictEqual(validateClaudeElicitationForm(form.fields, { email: '' }), { problems: { name: { code: 'required' }, plan: { code: 'required' } } });
		assert.deepStrictEqual(validateClaudeElicitationForm(form.fields, { name: 'Ada', email: '', plan: 'pro', subscribe: false, tags: [] }), { content: { name: 'Ada', plan: 'pro', subscribe: false } });
	});

	test('the JSON fallback takes an object of primitives and string lists only', () => {
		assert.deepStrictEqual([
			parseClaudeElicitationJson('{"a":1,"b":"x","c":true,"d":["y"]}'),
			parseClaudeElicitationJson('{'),
			parseClaudeElicitationJson('[1]'),
			parseClaudeElicitationJson('{"a":{"b":1}}'),
		], [{ content: { a: 1, b: 'x', c: true, d: ['y'] } }, { problem: 'syntax' }, { problem: 'shape' }, { problem: 'shape' }]);
	});

	test('a URL card shows the http(s) host and warns when it is not the server\'s host', () => {
		assert.deepStrictEqual([
			claudeElicitationUrlHost('https://Login.Example.com:8443/auth?x=1'),
			claudeElicitationUrlHost('file:///etc/passwd'),
			claudeElicitationUrlHost('javascript:alert(1)'),
			claudeElicitationUrlHost('not a url'),
			claudeElicitationHostDiffers('login.example.com', 'example.com'),
			claudeElicitationHostDiffers('example.com:443', 'example.com'),
			claudeElicitationHostDiffers('evil.test', 'example.com'),
			claudeElicitationHostDiffers('evil.test', undefined),
		], ['login.example.com:8443', undefined, undefined, undefined, false, false, true, false]);
	});

	test('the handler maps both modes, and accept, decline and cancel reach the SDK', async () => {
		const bridge = new ClaudeElicitationBridge();
		const seen: NormalizedClaudeEvent[] = [];
		let next = 0;
		const context = { bridge, sessionId: 's', push: (event: NormalizedClaudeEvent) => seen.push(event), now: () => 1000, newId: () => `e${++next}`, timeoutMs: 60_000 };
		const signal = new AbortController().signal;

		const form = runClaudeElicitation(context, formRequest(), signal);
		assert.strictEqual(bridge.resolve('s', 'e1', { action: 'accept', content: { name: 'Ada', tags: ['a'] } }), true);
		const url = runClaudeElicitation(context, { serverName: 'acme', message: 'Sign in', mode: 'url', url: 'https://acme.test/login', elicitationId: 'srv-1' }, signal);
		bridge.resolve('s', 'e2', { action: 'decline' });
		const cancelled = runClaudeElicitation(context, formRequest(), signal);
		bridge.resolve('s', 'e3', { action: 'cancel' });
		const unsafe = runClaudeElicitation(context, { serverName: 'acme', message: 'Open', mode: 'url', url: 'file:///etc/passwd' }, signal);

		assert.deepStrictEqual(await Promise.all([form, url, cancelled, unsafe]), [
			{ action: 'accept', content: { name: 'Ada', tags: ['a'] } },
			{ action: 'decline' },
			{ action: 'cancel' },
			{ action: 'decline' },
		]);
		// Each request's events in order; requests interleave, so they are grouped by id.
		const idOf = (event: NormalizedClaudeEvent) => event.type === 'elicitation.requested' ? event.request.id : event.type === 'elicitation.resolved' ? event.outcome.id : '';
		const grouped = [...seen].sort((a, b) => idOf(a).localeCompare(idOf(b)));
		assert.deepStrictEqual(grouped, [
			{ type: 'elicitation.requested', sessionId: 's', request: { id: 'e1', server: 'acme', mode: 'form', message: 'Who are you?', title: undefined, schema: FORM_SCHEMA, url: undefined, urlHost: undefined, elicitationId: undefined, expiresAt: 61_000 } },
			{ type: 'elicitation.resolved', sessionId: 's', outcome: { id: 'e1', server: 'acme', mode: 'form', action: 'accept', source: 'user' } },
			{ type: 'elicitation.requested', sessionId: 's', request: { id: 'e2', server: 'acme', mode: 'url', message: 'Sign in', title: undefined, schema: undefined, url: 'https://acme.test/login', urlHost: 'acme.test', elicitationId: 'srv-1', expiresAt: 61_000 } },
			{ type: 'elicitation.resolved', sessionId: 's', outcome: { id: 'e2', server: 'acme', mode: 'url', action: 'decline', source: 'user' } },
			{ type: 'elicitation.requested', sessionId: 's', request: { id: 'e3', server: 'acme', mode: 'form', message: 'Who are you?', title: undefined, schema: FORM_SCHEMA, url: undefined, urlHost: undefined, elicitationId: undefined, expiresAt: 61_000 } },
			{ type: 'elicitation.resolved', sessionId: 's', outcome: { id: 'e3', server: 'acme', mode: 'form', action: 'cancel', source: 'user' } },
			{ type: 'elicitation.requested', sessionId: 's', request: { id: 'e4', server: 'acme', mode: 'url', message: 'Open', title: undefined, schema: undefined, url: undefined, urlHost: undefined, elicitationId: undefined, expiresAt: 61_000 } },
			{ type: 'elicitation.resolved', sessionId: 's', outcome: { id: 'e4', server: 'acme', mode: 'url', action: 'decline', source: 'user' } },
		]);
	});

	test('a URL request names the server\'s configured host; a failed lookup and a form leave it out', async () => {
		const bridge = new ClaudeElicitationBridge();
		const seen: NormalizedClaudeEvent[] = [];
		let next = 0;
		const lookups: string[] = [];
		const serverUrl = async (server: string) => {
			lookups.push(server);
			if (server === 'broken') {
				throw new Error('status failed');
			}
			return 'https://API.acme.test:8443/mcp';
		};
		const context = { bridge, sessionId: 's', push: (event: NormalizedClaudeEvent) => seen.push(event), now: () => 0, newId: () => `e${++next}`, timeoutMs: 60_000, serverUrl };
		const signal = new AbortController().signal;
		const answer = async (request: ClaudeElicitationQueryRequest) => {
			const run = runClaudeElicitation(context, request, signal);
			// The lookup runs before the card shows, so answer once the request is waiting.
			while (!bridge.hasPending('s')) {
				await new Promise(resolve => setTimeout(resolve, 0));
			}
			bridge.resolve('s', `e${next}`, { action: 'decline' });
			return run;
		};
		await answer({ serverName: 'acme', message: 'Sign in', mode: 'url', url: 'https://login.other.test/x' });
		await answer({ serverName: 'broken', message: 'Sign in', mode: 'url', url: 'https://login.other.test/x' });
		await answer(formRequest());
		const hosts = seen.flatMap(event => event.type === 'elicitation.requested' ? [event.request.serverHost] : []);
		assert.deepStrictEqual({ hosts, lookups }, { hosts: ['api.acme.test:8443', undefined, undefined], lookups: ['acme', 'broken'] });
	});

	test('an abort, a stopped session, a timeout or a dispose cancels a pending request', async () => {
		const bridge = new ClaudeElicitationBridge();
		const aborted = new AbortController();
		const a = bridge.request({ sessionId: 's', id: 'a', signal: aborted.signal, timeoutMs: 60_000 });
		aborted.abort();
		const b = bridge.request({ sessionId: 's', id: 'b', signal: new AbortController().signal, timeoutMs: 60_000 });
		const other = bridge.request({ sessionId: 'other', id: 'c', signal: new AbortController().signal, timeoutMs: 60_000 });
		bridge.cancelSession('s');
		assert.strictEqual(bridge.hasPending('other'), true);
		const timedOut = bridge.request({ sessionId: 's', id: 'd', signal: new AbortController().signal, timeoutMs: 1 });
		const settledD = await timedOut;
		bridge.dispose();
		assert.deepStrictEqual([await a, await b, settledD, await other, bridge.resolve('s', 'a', { action: 'accept' })], [
			{ answer: { action: 'cancel' }, source: 'session-stopped' },
			{ answer: { action: 'cancel' }, source: 'session-stopped' },
			{ answer: { action: 'cancel' }, source: 'timeout' },
			{ answer: { action: 'cancel' }, source: 'session-stopped' },
			false,
		]);
	});

	test('the Elicitation hook route passes the request and the answer through, and is absent without a handler', async () => {
		const received: ClaudeElicitationQueryRequest[] = [];
		const onElicitation = async (request: ClaudeElicitationQueryRequest) => { received.push(request); return { action: 'accept' as const, content: { name: 'Ada' } }; };
		const agents = { remember: () => undefined, lookup: () => undefined };
		const wired = await createClaudeBridge({ options: { onElicitation } } as unknown as ClaudeQueryStart, agents);
		const bare = await createClaudeBridge({ options: {} } as unknown as ClaudeQueryStart, agents);
		store.add({ dispose: () => { wired.bridge.close(); bare.bridge.close(); } });
		const url = JSON.stringify(wired.hooks.Elicitation).match(/http:[^"]+/)![0];
		const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'Elicitation', mcp_server_name: 'acme', message: 'm', mode: 'url', url: 'https://acme.test', elicitation_id: 'x' }) });
		assert.deepStrictEqual({ received, result: await response.json(), absent: bare.hooks.Elicitation }, {
			received: [{ serverName: 'acme', message: 'm', mode: 'url', url: 'https://acme.test', elicitationId: 'x', requestedSchema: undefined }],
			result: { hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: { name: 'Ada' } } },
			absent: undefined,
		});
	});

	test('the runner offers elicitation only with a bridge, streams the request and cancels it when the session ends', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		const bridge = new ClaudeElicitationBridge();
		const starts: ClaudeQueryStart[] = [];
		let release: (() => void) | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			elicitations: bridge,
			queryFactory: async start => {
				starts.push(start);
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(() => release, fn => { release = fn; });
			},
		}));
		const seen: NormalizedClaudeEvent[] = [];
		const done = (async () => {
			for await (const event of runner.start({ sessionId: 's', prompt: 'hi', cwd: tmpdir() })) {
				seen.push(event);
			}
		})();
		await waitFor(() => seen.some(event => event.type === 'session.started'));
		const pending = starts[0].options.onElicitation!(formRequest(), new AbortController().signal);
		await waitFor(() => bridge.hasPending('s'));
		runner.disposeSession('s');
		const answer = await pending;
		release?.();
		await done;
		assert.deepStrictEqual({
			answer,
			events: seen.filter(event => event.type.startsWith('elicitation.')).map(event => event.type === 'elicitation.resolved' ? [event.type, event.outcome.action, event.outcome.source] : [event.type]),
		}, {
			answer: { action: 'cancel' },
			// The disposed session's stream is closed, so its card ends with the turn, not with a resolved event.
			events: [['elicitation.requested']],
		});
	});

	test('the stream reports a finished URL sign-in', () => {
		const result = normalizeClaudeMessage({ type: 'system', subtype: 'elicitation_complete', mcp_server_name: 'acme', elicitation_id: 'srv-1', uuid: 'u', session_id: 'x' }, 's', createClaudeNormalizerState());
		assert.deepStrictEqual(result.events, [{ type: 'elicitation.completed', sessionId: 's', server: 'acme', elicitationId: 'srv-1' }]);
	});
});

function idleQuery(getRelease: () => (() => void) | undefined, setRelease: (release: () => void) => void): ClaudeQuery {
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: 'system', subtype: 'init', slash_commands: [], skills: [], session_id: 'sdk-session' };
			await new Promise<void>(resolve => setRelease(resolve));
		},
		interrupt: async () => getRelease()?.(),
		setModel: async () => undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => getRelease()?.(),
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > 5000) {
			assert.fail('condition was not met');
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}
