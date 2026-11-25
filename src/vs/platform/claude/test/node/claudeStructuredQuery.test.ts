/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { tmpdir } from 'os';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_REVIEW_FINDINGS_SCHEMA, claudeFindingFeedback, formatClaudeReviewFeedback, readClaudeReviewFindings } from '../../common/claudeReviewLoop.js';
import { ClaudeQuery, ClaudeQueryStart } from '../../node/claudeQuery.js';
import { runClaudeReviewQuery } from '../../node/claudeReviewQuery.js';
import { runClaudeStructuredQuery, structuredQueryOptions } from '../../node/claudeStructuredQuery.js';

suite('Claude structured query', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('related repositories become extra directories while the tools stay read-only', () => {
		const base = { queryFactory: async () => { throw new Error('unused'); }, prompt: 'p', cwd: tmpdir(), schema: {}, validate: (v: unknown) => v, tools: ['Read'], abort: new AbortController(), env: {} };
		const withRepos = structuredQueryOptions({ ...base, additionalDirectories: ['/a', '/b'] });
		const without = structuredQueryOptions({ ...base, additionalDirectories: [] });
		assert.deepStrictEqual({ withRepos: withRepos.additionalDirectories, without: without.additionalDirectories, tools: withRepos.allowedTools, mode: withRepos.permissionMode }, { withRepos: ['/a', '/b'], without: undefined, tools: ['Read'], mode: 'default' });
	});

	test('a schema-constrained review returns its findings, worst first, from a read-only query', async () => {
		let captured: ClaudeQueryStart | undefined;
		const outcome = await runClaudeReviewQuery({
			queryFactory: async start => {
				captured = start;
				return scriptedQuery([
					assistant('Looking at the diff.'),
					result({
						subtype: 'success', structured_output: {
							findings: [
								{ file: 'src/b.ts', startLine: 4, endLine: 4, severity: 'low', category: 'bug' as const, title: 'Name', body: 'Rename it.' },
								{ file: 'src/a.ts', startLine: 12, endLine: 10, severity: 'high', category: 'bug' as const, title: 'Off by one', body: 'The loop skips the last item.', suggestion: 'i <= n' },
								{ file: '', startLine: 1, endLine: 1, severity: 'high', category: 'bug' as const, title: 'No file', body: '' },
							],
						},
					}),
				]);
			},
			diff: 'diff --git a/src/a.ts b/src/a.ts',
			cwd: tmpdir(),
			model: 'sonnet',
			abort: new AbortController(),
			env: {},
		});
		const options = captured!.options;
		const prompt = await captured!.prompt[Symbol.asyncIterator]().next();
		assert.deepStrictEqual({
			outcome,
			model: options.model,
			permissionMode: options.permissionMode,
			allowedTools: options.allowedTools,
			readsAllowed: ['Read', 'Grep', 'Glob'].filter(tool => options.disallowedTools?.includes(tool)),
			editsRefused: ['Bash', 'Edit', 'Write'].every(tool => options.disallowedTools?.includes(tool)),
			outputFormat: options.outputFormat,
			hasDiff: String(prompt.value?.message.content).includes('<diff>\ndiff --git a/src/a.ts b/src/a.ts\n</diff>'),
		}, {
			outcome: {
				ok: true, value: [
					{ file: 'src/a.ts', startLine: 12, endLine: 12, severity: 'high', category: 'bug' as const, title: 'Off by one', body: 'The loop skips the last item.', suggestion: 'i <= n' },
					{ file: 'src/b.ts', startLine: 4, endLine: 4, severity: 'low', category: 'bug' as const, title: 'Name', body: 'Rename it.' },
				],
			},
			model: 'sonnet',
			permissionMode: 'default',
			allowedTools: ['Read', 'Grep', 'Glob'],
			readsAllowed: [],
			editsRefused: true,
			outputFormat: { type: 'json_schema', schema: CLAUDE_REVIEW_FINDINGS_SCHEMA },
			hasDiff: true,
		});
	});

	test('the query refuses every tool outside its list', async () => {
		let captured: ClaudeQueryStart | undefined;
		await runClaudeReviewQuery({
			queryFactory: async start => {
				captured = start;
				return scriptedQuery([result({ subtype: 'success', structured_output: { findings: [] } })]);
			},
			diff: '', cwd: tmpdir(), abort: new AbortController(), env: {},
		});
		const options = captured!.options;
		const context = { signal: new AbortController().signal, toolUseID: 't' };
		assert.deepStrictEqual({
			read: await options.canUseTool('Read', {}, context),
			bash: await options.canUseTool('Bash', {}, context),
			screenRead: await options.screenTool('Grep', {}),
			screenEdit: await options.screenTool('Edit', {}),
		}, {
			read: { behavior: 'allow' },
			bash: { behavior: 'deny', message: 'This review can only read files.' },
			screenRead: undefined,
			screenEdit: { decision: 'deny', message: 'This review can only read files.' },
		});
	});

	test('malformed output degrades to the assistant text; failures and cancellation are typed', async () => {
		const run = (messages: readonly unknown[], abort = new AbortController()) => runClaudeStructuredQuery({
			queryFactory: async () => scriptedQuery(messages),
			prompt: 'p', cwd: tmpdir(), schema: {}, validate: readClaudeReviewFindings, tools: [], abort, env: {},
		});
		const cancelled = new AbortController();
		cancelled.abort();
		assert.deepStrictEqual({
			noStructured: await run([assistant('The loop is off by one.'), result({ subtype: 'success', result: 'The loop is off by one.' })]),
			wrongShape: await run([result({ subtype: 'success', result: 'Done.', structured_output: { items: [] } })]),
			retriesSpent: await run([assistant('I could not fit the schema.'), result({ subtype: 'error_max_structured_output_retries' })]),
			error: await run([result({ subtype: 'error_during_execution', errors: ['boom'] })]),
			noResult: await run([assistant('Half way.')]),
			cancelled: await run([], cancelled),
		}, {
			noStructured: { ok: false, failure: { kind: 'malformed', text: 'The loop is off by one.' } },
			wrongShape: { ok: false, failure: { kind: 'malformed', text: 'Done.' } },
			retriesSpent: { ok: false, failure: { kind: 'malformed', text: 'I could not fit the schema.' } },
			error: { ok: false, failure: { kind: 'failed', message: 'boom' } },
			noResult: { ok: false, failure: { kind: 'failed', message: 'Claude Code ended without a result.' } },
			cancelled: { ok: false, failure: { kind: 'cancelled' } },
		});
	});

	test('a factory that throws is a failure, not a throw', async () => {
		const outcome = await runClaudeStructuredQuery({
			queryFactory: async () => { throw new Error('not signed in'); },
			prompt: 'p', cwd: tmpdir(), schema: {}, validate: value => value, tools: [], abort: new AbortController(), env: {},
		});
		assert.deepStrictEqual(outcome, { ok: false, failure: { kind: 'failed', message: 'not signed in' } });
	});

	test('line comments and findings become one message of path:line references', () => {
		const finding = { file: 'src/a.ts', startLine: 12, endLine: 14, severity: 'high' as const, category: 'bug' as const, title: 'Off by one', body: 'Skips the last item.', suggestion: 'i <= n' };
		assert.strictEqual(formatClaudeReviewFeedback([
			{ id: '2', path: 'src/b.ts', startLine: 3, endLine: 3, text: 'Use the helper\nfrom utils.' },
			claudeFindingFeedback(finding, '1'),
			{ id: '3', path: 'src/a.ts', startLine: 2, endLine: 2, text: ' Rename this. ', turnId: 't1' },
		]), [
			'I left review comments on your changes. Address each one, then say what you changed.',
			'',
			'- src/a.ts:2',
			'  Rename this.',
			'- src/a.ts:12-14',
			'  Off by one',
			'  Skips the last item.',
			'  Suggested fix:',
			'  i <= n',
			'- src/b.ts:3',
			'  Use the helper',
			'  from utils.',
		].join('\n'));
	});
});

function assistant(text: string): unknown {
	return { type: 'assistant', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: 'sdk' };
}

function result(fields: Record<string, unknown>): unknown {
	return { type: 'result', is_error: fields.subtype !== 'success', session_id: 'sdk', ...fields };
}

function scriptedQuery(messages: readonly unknown[]): ClaudeQuery {
	return {
		async *[Symbol.asyncIterator]() {
			yield* messages;
		},
		interrupt: async () => undefined,
		setModel: async () => undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => undefined,
	};
}
