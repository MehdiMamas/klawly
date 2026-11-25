/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { tmpdir } from 'os';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeCommandInfo } from '../../common/claudeCommands.js';
import { claudeHasOwnReviewCommand, normalizeClaudeFindingPath, readClaudeReviewFindingsFromText } from '../../common/claudeReviewLoop.js';
import { ClaudeNodeRuntimeService } from '../../node/claudeNodeRuntimeService.js';
import { ClaudeQuery, ClaudeQueryFactory } from '../../node/claudeQuery.js';

suite('Claude review pass', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function runtime(queryFactory: ClaudeQueryFactory): ClaudeNodeRuntimeService {
		return store.add(new ClaudeNodeRuntimeService({
			runtimePath: process.execPath,
			execFile: async (_file, args) => args[0] === '--version'
				? { stdout: '2.1.288 (Claude Code)\n', stderr: '' }
				: { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' },
			queryFactory,
		}));
	}

	test('reviewChanges returns the normalized findings event; malformed output keeps Claude\'s text (issue 431)', async () => {
		const finding = { file: 'src/a.ts', startLine: 3, endLine: 3, severity: 'medium', category: 'bug' as const, title: 'Unchecked index', body: 'items[0] can be undefined.' };
		const answers = [
			[result({ subtype: 'success', structured_output: { findings: [finding] } })],
			[assistant('The diff looks fine to me.'), result({ subtype: 'success', result: 'The diff looks fine to me.' })],
		];
		const service = runtime(async () => scriptedQuery(answers.shift() ?? []));
		const found = await service.reviewChanges({ reviewId: 'r1', sessionId: 's1', cwd: tmpdir(), diff: 'diff --git a/src/a.ts b/src/a.ts' });
		const malformed = await service.reviewChanges({ reviewId: 'r2', sessionId: 's1', cwd: tmpdir(), diff: 'diff' });
		assert.deepStrictEqual({ found, malformed }, {
			found: { ok: true, event: { type: 'review.findings', sessionId: 's1', reviewId: 'r1', findings: [finding] } },
			malformed: { ok: false, reviewId: 'r2', failure: { kind: 'malformed', text: 'The diff looks fine to me.' } },
		});
	});

	test('reviewChanges carries the summary into the findings event (issue 918)', async () => {
		const summary = { overview: 'Adds a parser.', files: [{ path: 'src/a.ts', risk: 'high', change: 'new parser' }] };
		const service = runtime(async () => scriptedQuery([result({ subtype: 'success', structured_output: { findings: [], summary } })]));
		const found = await service.reviewChanges({ reviewId: 'r1', sessionId: 's1', cwd: tmpdir(), diff: 'diff', summary: 'summary' });
		assert.deepStrictEqual(found, { ok: true, event: { type: 'review.findings', sessionId: 's1', reviewId: 'r1', findings: [], summary } });
	});

	test('cancelReview stops a pass in flight', async () => {
		let started = false;
		const service = runtime(async start => {
			started = true;
			return hangingQuery(start.options.abortController.signal);
		});
		const pending = service.reviewChanges({ reviewId: 'r3', sessionId: 's1', cwd: tmpdir(), diff: 'diff' });
		await waitFor(() => started);
		await service.cancelReview('r3');
		assert.deepStrictEqual(await pending, { ok: false, reviewId: 'r3', failure: { kind: 'cancelled' } });
	});

	test('the one-click rule, findings in a /review answer, and finding paths', () => {
		const command = (name: string, source: ClaudeCommandInfo['source']): ClaudeCommandInfo => ({ name, description: '', source });
		assert.deepStrictEqual({
			builtinOnly: claudeHasOwnReviewCommand([command('review', 'builtin')], [], true),
			unsorted: claudeHasOwnReviewCommand([command('review', 'other')], [], true),
			project: claudeHasOwnReviewCommand([command('review', 'project')], [], true),
			skill: claudeHasOwnReviewCommand([], ['code-review'], true),
			preferOff: claudeHasOwnReviewCommand([command('review', 'project')], ['review'], false),
			fenced: readClaudeReviewFindingsFromText('Two problems.\n\n```json\n{"findings":[{"file":"a.ts","startLine":2,"endLine":2,"severity":"error","title":"Bug","body":"x"}]}\n```\n')?.map(item => `${item.file}:${item.startLine}`),
			whole: readClaudeReviewFindingsFromText('{"findings":[]}'),
			prose: readClaudeReviewFindingsFromText('Looks good. ```js\nconst a = 1;\n```'),
			paths: ['./src\\a.ts', ' src/a.ts '].map(normalizeClaudeFindingPath),
		}, {
			builtinOnly: false,
			unsorted: false,
			project: true,
			skill: true,
			preferOff: false,
			fenced: ['a.ts:2'],
			whole: [],
			prose: undefined,
			paths: ['src/a.ts', 'src/a.ts'],
		});
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

function hangingQuery(signal: AbortSignal): ClaudeQuery {
	return {
		async *[Symbol.asyncIterator]() {
			await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
			throw new Error('aborted');
		},
		interrupt: async () => undefined,
		setModel: async () => undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => undefined,
	};
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !condition(); i++) {
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}
