/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_SIDE_QUESTION_DISALLOWED_TOOLS, claudeSideQuestionQuote, ClaudeSideQuestionRequest } from '../../common/claudeSideQuestion.js';
import { ClaudeNodeRuntimeService } from '../../node/claudeNodeRuntimeService.js';
import { ClaudeQuery, ClaudeQueryStart } from '../../node/claudeQuery.js';
import { buildClaudeCliArguments } from '../../node/claudeCliArgs.js';
import { sideQuestionToolDenial } from '../../node/claudeSideQuestionQuery.js';

suite('Claude side question (issue 433)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;

	setup(() => {
		root = join(tmpdir(), `klawly-side-question-${Date.now()}`);
		mkdirSync(root, { recursive: true });
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('forks the chat unsaved in plan mode, beside its running turn', async () => {
		let main: ClaudeQueryStart | undefined;
		let side: ClaudeQueryStart | undefined;
		const mainPrompts: string[] = [];
		const runtime = store.add(new ClaudeNodeRuntimeService({
			runtimePath: process.execPath,
			execFile: async (_file, args) => args[0] === '--version'
				? { stdout: '2.1.288 (Claude Code)\n', stderr: '' }
				: { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' },
			queryFactory: async start => {
				if (start.options.forkSession) {
					side = start;
					await start.prompt[Symbol.asyncIterator]().next();
					return scriptedQuery(['Let me check the file.', 'It edits `a.ts`.']);
				}
				main = start;
				const first = await start.prompt[Symbol.asyncIterator]().next();
				mainPrompts.push(JSON.stringify(first.value?.message.content));
				return hangingQuery(start.options.abortController.signal);
			},
		}));
		const chat = await runtime.begin({ prompt: 'refactor a.ts', cwd: root, mode: 'agent', workspaceFolders: [root], resumeSessionId: 'claude-chat-1' });
		await waitFor(() => mainPrompts.length === 1);

		const result = await runtime.askSideQuestion({ id: 'side-1', claudeSessionId: 'claude-chat-1', question: 'Which file?', cwd: root, workspaceFolders: [root], model: 'haiku' });
		assert.ok(main && side);
		const args = buildClaudeCliArguments(side.options, { bridgeMcpServers: {}, permissionBridge: true }, side.options.resume);
		assert.deepStrictEqual({
			result,
			side: {
				resume: side.options.resume,
				forkSession: side.options.forkSession,
				persistSession: side.options.persistSession,
				permissionMode: side.options.permissionMode,
				strictMcpConfig: side.options.strictMcpConfig,
				allowedTools: side.options.allowedTools,
				disallowedTools: side.options.disallowedTools === CLAUDE_SIDE_QUESTION_DISALLOWED_TOOLS,
				model: side.options.model,
				ownAbort: side.options.abortController !== main.options.abortController,
			},
			cli: { resume: args[args.indexOf('--resume') + 1], forkSession: args.includes('--fork-session'), persistSession: !args.includes('--no-session-persistence'), permissionMode: args[args.indexOf('--permission-mode') + 1], settingSources: args[args.indexOf('--setting-sources') + 1] },
			chat: { prompts: mainPrompts, aborted: main.options.abortController.signal.aborted, resume: main.options.resume, forkSession: main.options.forkSession, persistSession: main.options.persistSession },
		}, {
			result: { kind: 'answer', text: 'It edits `a.ts`.' },
			side: {
				resume: 'claude-chat-1',
				forkSession: true,
				persistSession: false,
				permissionMode: 'plan',
				strictMcpConfig: true,
				allowedTools: [],
				disallowedTools: true,
				model: 'haiku',
				ownAbort: true,
			},
			cli: { resume: 'claude-chat-1', forkSession: true, persistSession: false, permissionMode: 'plan', settingSources: '' },
			chat: { prompts: ['"refactor a.ts"'], aborted: false, resume: 'claude-chat-1', forkSession: undefined, persistSession: undefined },
		});
		await runtime.disposeSession(chat.sessionId);
	});

	test('cancelSideQuestion ends an answer in flight', async () => {
		let side: ClaudeQueryStart | undefined;
		const runtime = store.add(new ClaudeNodeRuntimeService({
			runtimePath: process.execPath,
			execFile: async (_file, args) => args[0] === '--version'
				? { stdout: '2.1.288 (Claude Code)\n', stderr: '' }
				: { stdout: '{"loggedIn":true}', stderr: '' },
			queryFactory: async start => {
				side = start;
				return hangingQuery(start.options.abortController.signal);
			},
		}));
		const pending = runtime.askSideQuestion(request());
		await waitFor(() => side !== undefined);
		await runtime.cancelSideQuestion('side-2');
		assert.deepStrictEqual(await pending, { kind: 'cancelled' });
	});

	test('only reads inside the workspace, never credentials', async () => {
		const run = { request: request() };
		const outside = join(tmpdir(), 'elsewhere', 'notes.md');
		const cases: Array<[string, Record<string, unknown>]> = [
			['Read', { file_path: join(root, 'src', 'a.ts') }],
			['Read', { file_path: 'src/b.ts' }],
			['Grep', { pattern: 'TODO' }],
			['Glob', { pattern: '**/*.ts', path: join(root, 'src') }],
			['Read', { file_path: outside }],
			['Read', { file_path: join(root, '.env') }],
			['Read', { file_path: '~/.ssh/id_ed25519' }],
			['Glob', { pattern: `${join(tmpdir(), 'elsewhere')}/**/*.md` }],
			['Read', {}],
			['Bash', { command: 'ls' }],
			['Edit', { file_path: join(root, 'a.ts') }],
			['ExitPlanMode', {}],
		];
		const verdicts: string[] = [];
		for (const [tool, input] of cases) {
			verdicts.push(`${tool} ${await sideQuestionToolDenial(tool, input, run) === undefined ? 'allow' : 'deny'}`);
		}
		assert.deepStrictEqual(verdicts, [
			'Read allow', 'Read allow', 'Grep allow', 'Glob allow',
			'Read deny', 'Read deny', 'Read deny', 'Glob deny', 'Read deny', 'Bash deny', 'Edit deny', 'ExitPlanMode deny',
		]);
	});

	test('a question about a selection starts a fresh unsaved query with the code (issue 491)', async () => {
		let side: ClaudeQueryStart | undefined;
		let prompt: unknown;
		const runtime = store.add(new ClaudeNodeRuntimeService({
			runtimePath: process.execPath,
			execFile: async (_file, args) => args[0] === '--version'
				? { stdout: '2.1.288 (Claude Code)\n', stderr: '' }
				: { stdout: '{"loggedIn":true}', stderr: '' },
			queryFactory: async start => {
				side = start;
				prompt = (await start.prompt[Symbol.asyncIterator]().next()).value?.message.content;
				return scriptedQuery(['It returns the sum.']);
			},
		}));
		const result = await runtime.askSideQuestion({
			id: 'inline-1',
			question: ' What does it return? ',
			cwd: root,
			workspaceFolders: [root],
			selection: { path: 'src/a.ts', languageId: 'typescript', startLine: 3, endLine: 5, text: 'function add(a, b) {\n\treturn a + b; // ```\n}\n' },
		});
		assert.ok(side);
		assert.deepStrictEqual({
			result,
			prompt,
			options: { resume: side.options.resume, forkSession: side.options.forkSession, persistSession: side.options.persistSession, permissionMode: side.options.permissionMode, allowedTools: side.options.allowedTools, disallowedTools: side.options.disallowedTools === CLAUDE_SIDE_QUESTION_DISALLOWED_TOOLS },
		}, {
			result: { kind: 'answer', text: 'It returns the sum.' },
			prompt: [
				'This is a question about src/a.ts, lines 3-5. Answer it briefly from the code below, and read other files only if you need to.',
				'Do not change anything.',
				'',
				'````typescript',
				'function add(a, b) {',
				'\treturn a + b; // ```',
				'}',
				'````',
				'',
				'What does it return?',
			].join('\n'),
			options: { resume: undefined, forkSession: undefined, persistSession: false, permissionMode: 'plan', allowedTools: [], disallowedTools: true },
		});
	});

	test('the answer goes into the composer as a quote', () => {
		assert.strictEqual(claudeSideQuestionQuote('First line.\n\nSecond line.\n'), '> First line.\n>\n> Second line.\n\n');
	});

	function request(): ClaudeSideQuestionRequest {
		return { id: 'side-2', claudeSessionId: 'claude-chat-2', question: 'Why?', cwd: root, workspaceFolders: [root] };
	}
});

function scriptedQuery(texts: readonly string[]): ClaudeQuery {
	return {
		async *[Symbol.asyncIterator]() {
			for (const [index, text] of texts.entries()) {
				yield {
					type: 'assistant',
					message: { id: `m${index}`, role: 'assistant', content: [{ type: 'text', text }] },
					parent_tool_use_id: null,
					session_id: 'forked',
				};
			}
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
			assert.fail('timed out waiting for the query');
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}
