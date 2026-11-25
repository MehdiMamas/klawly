/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { tmpdir } from 'os';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeInlineCompletionRequest } from '../../common/claudeAutocomplete.js';
import { ClaudeNodeRuntimeService } from '../../node/claudeNodeRuntimeService.js';
import { CLAUDE_AUTOCOMPLETE_DISALLOWED_TOOLS, CLAUDE_AUTOCOMPLETE_MAX_TURNS, inlineQueryOptions, runClaudeInlineCompletion } from '../../node/claudeAutocompleteQuery.js';
import { buildClaudeCliArguments } from '../../node/claudeCliArgs.js';
import { ClaudeQuery, ClaudeQueryStart } from '../../node/claudeQuery.js';

suite('Claude autocomplete query', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a cancelled completion does not call the runtime', async () => {
		let called = false;
		const abort = new AbortController();
		abort.abort();
		const text = await runClaudeInlineCompletion({
			queryFactory: async () => {
				called = true;
				throw new Error('should not run');
			},
			request: { id: '1', prompt: 'x', cwd: tmpdir() },
			abort,
			env: {},
		});
		assert.strictEqual(text, undefined);
		assert.strictEqual(called, false);
	});

	test('the platform runtime uses one turn and no tools', async () => {
		let captured: ClaudeQueryStart | undefined;
		const runtime = store.add(new ClaudeNodeRuntimeService({
			runtimePath: process.execPath,
			execFile: async (_file, args) => {
				if (args[0] === '--version') {
					return { stdout: '2.1.288 (Claude Code)\n', stderr: '' };
				}
				return { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' };
			},
			queryFactory: async start => {
				captured = start;
				await start.prompt[Symbol.asyncIterator]().next();
				return scriptedQuery('const n = 1;');
			},
		}));

		const text = await runtime.completeInline({ id: 'req-1', prompt: 'complete this', cwd: tmpdir(), model: 'haiku' });
		assert.strictEqual(text, 'const n = 1;');
		assert.ok(captured);
		assert.strictEqual(captured!.options.maxTurns, CLAUDE_AUTOCOMPLETE_MAX_TURNS);
		assert.deepStrictEqual([...captured!.options.allowedTools ?? []], []);
		assert.strictEqual(captured!.options.model, 'haiku');
		for (const tool of ['Bash', 'Write', 'Edit']) {
			assert.ok(captured!.options.disallowedTools?.includes(tool), tool);
		}
		assert.deepStrictEqual(captured!.options.disallowedTools, CLAUDE_AUTOCOMPLETE_DISALLOWED_TOOLS);
		assert.strictEqual(captured!.options.settingSources, undefined);
		assert.strictEqual(captured!.options.includePartialMessages, undefined);
		assert.strictEqual(captured!.options.forwardSubagentText, undefined);
		const args = buildClaudeCliArguments(captured!.options, { bridgeMcpServers: {}, permissionBridge: true });
		assert.deepStrictEqual({
			settingSources: args[args.indexOf('--setting-sources') + 1],
			partial: args.includes('--include-partial-messages'),
			subagentText: args.includes('--forward-subagent-text'),
		}, { settingSources: '', partial: false, subagentText: false });
		const direct = inlineQueryOptions({
			queryFactory: async () => scriptedQuery(''),
			request: { id: 'opts', prompt: 'x', cwd: tmpdir() },
			abort: new AbortController(),
			env: {},
		});
		assert.strictEqual(direct.settingSources, undefined);
		assert.strictEqual(direct.includePartialMessages, undefined);
		assert.strictEqual(direct.forwardSubagentText, undefined);
		const denied = await captured!.options.canUseTool('Bash', {}, { signal: new AbortController().signal, toolUseID: 'tool-1' });
		assert.strictEqual(denied.behavior, 'deny');
		const screened = await captured!.options.screenTool('Write', {});
		assert.strictEqual(screened?.decision, 'deny');
	});

	test('cancelInline drops an in-flight completion', async () => {
		let captured: ClaudeQueryStart | undefined;
		const runtime = store.add(new ClaudeNodeRuntimeService({
			runtimePath: process.execPath,
			execFile: async (_file, args) => {
				if (args[0] === '--version') {
					return { stdout: '2.1.288 (Claude Code)\n', stderr: '' };
				}
				return { stdout: '{"loggedIn":true}', stderr: '' };
			},
			queryFactory: async start => {
				captured = start;
				return hangingQuery(start.options.abortController.signal);
			},
		}));

		const request: ClaudeInlineCompletionRequest = { id: 'req-2', prompt: 'complete this', cwd: tmpdir() };
		const pending = runtime.completeInline(request);
		await waitFor(() => captured !== undefined);
		await runtime.cancelInline(request.id);
		assert.strictEqual(await pending, undefined);
	});
});

function scriptedQuery(text: string): ClaudeQuery {
	return {
		async *[Symbol.asyncIterator]() {
			yield {
				type: 'assistant',
				message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text }] },
				parent_tool_use_id: null,
				session_id: 'sdk',
			};
		},
		interrupt: async () => undefined,
		setModel: async () => undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => undefined,
	};
}

function hangingQuery(signal: AbortSignal): ClaudeQuery {
	return {
		async *[Symbol.asyncIterator]() {
			await new Promise<void>((_resolve, reject) => {
				if (signal.aborted) {
					reject(new Error('aborted'));
					return;
				}
				signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
			});
		},
		interrupt: async () => undefined,
		setModel: async () => undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => undefined,
	};
}

async function waitFor(ready: () => boolean): Promise<void> {
	const started = Date.now();
	while (!ready()) {
		if (Date.now() - started > 2000) {
			assert.fail('timed out waiting for the completion query');
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}
