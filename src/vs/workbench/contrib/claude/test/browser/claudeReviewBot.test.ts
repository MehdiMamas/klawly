/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeGitHubReview, formatClaudeGitHubReview } from '../../../../../platform/claude/common/claudeReviewBot.js';
import { CLAUDE_REVIEW_CATEGORIES, ClaudeReviewFinding } from '../../../../../platform/claude/common/claudeReviewLoop.js';
import { IConfirmation } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileContent } from '../../../../../platform/files/common/files.js';
import { ClaudeReviewBot, ClaudeReviewBotGitHub, ClaudeReviewBotPullRequest } from '../../browser/review/claudeReviewBotService.js';

const pullRequest: ClaudeReviewBotPullRequest = { owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/pull/7' };
const folder = URI.file('/repo');
const finding: ClaudeReviewFinding = { file: 'src/a.ts', startLine: 4, endLine: 4, severity: 'high', category: 'bug', title: 'Off by one', body: 'The loop skips the last item.' };

suite('Klawly review bot: post, fix, remember (issue 872)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options: { confirm?: boolean; comments?: string[]; files?: Record<string, string> } = {}) {
		const posted: ClaudeGitHubReview[] = [];
		const confirmations: IConfirmation[] = [];
		const submits: { id: string; text: string; cwd: string }[] = [];
		const targets: { id: string; kind: string }[] = [];
		const files = new Map(Object.entries(options.files ?? {}));
		const writes: string[] = [];
		const github: ClaudeReviewBotGitHub = {
			postReview: async (_pullRequest, review) => { posted.push(review); return 'https://github.com/acme/app/pull/7#pullrequestreview-1'; },
			headRef: async () => 'fix/cache',
			comments: async () => options.comments ?? [],
		};
		const bot = new ClaudeReviewBot(
			github,
			{ confirm: async (confirmation: IConfirmation) => { confirmations.push(confirmation); return { confirmed: options.confirm ?? true }; } },
			{
				createSession: () => ({ id: 's1' }),
				setExecutionTarget: (id: string, target: { kind: string }) => { targets.push({ id, kind: target.kind }); },
				selectSession: () => { },
				getSessions: () => [{ id: 's1', mode: 'agent' }],
				submit: async (id: string, text: string, cwd: string) => { submits.push({ id, text, cwd }); },
			} as unknown as ConstructorParameters<typeof ClaudeReviewBot>[2],
			{ preview: async () => ({}) } as unknown as ConstructorParameters<typeof ClaudeReviewBot>[3],
			{
				exists: async (resource: URI) => files.has(resource.path),
				readFile: async (resource: URI) => {
					const text = files.get(resource.path);
					if (text === undefined) {
						throw new Error('not found');
					}
					return { value: VSBuffer.fromString(text) } as IFileContent;
				},
				writeFile: async (resource: URI, content: VSBuffer) => { writes.push(resource.path); files.set(resource.path, content.toString()); return undefined!; },
			} as unknown as ConstructorParameters<typeof ClaudeReviewBot>[4],
		);
		return { bot, posted, confirmations, submits, targets, files, writes };
	}

	const review = () => formatClaudeGitHubReview([finding], { minSeverity: 'low', categories: CLAUDE_REVIEW_CATEGORIES });

	test('posts one review with its line comments only after the person confirms the exact comments', async () => {
		const { bot, posted, confirmations } = setup();
		const result = await bot.post(pullRequest, review(), new AbortController().signal);
		assert.deepStrictEqual({
			result,
			posts: posted.length,
			comments: posted[0].comments.map(comment => `${comment.path}:${comment.line}`),
			shown: confirmations.length === 1 && String(confirmations[0].detail).includes('src/a.ts:4') && String(confirmations[0].message).includes('acme/app#7'),
		}, { result: { status: 'posted', url: 'https://github.com/acme/app/pull/7#pullrequestreview-1' }, posts: 1, comments: ['src/a.ts:4'], shown: true });
	});

	test('cancel posts nothing, and secrets never reach GitHub', async () => {
		const cancelled = setup({ confirm: false });
		assert.deepStrictEqual(await cancelled.bot.post(pullRequest, review(), new AbortController().signal), { status: 'cancelled' });
		assert.strictEqual(cancelled.posted.length, 0);

		const secret = setup();
		const leaky = review();
		const token = 'ghp_' + 'a'.repeat(36);
		await secret.bot.post(pullRequest, { ...leaky, body: `${leaky.body}${token}` }, new AbortController().signal);
		assert.ok(!secret.posted[0].body.includes(token));
	});

	test('Fix on PR Branch starts a chat in a new worktree with the head branch and the finding', async () => {
		const { bot, submits, targets } = setup();
		const id = await bot.startFix(finding, pullRequest, '/repo', new AbortController().signal);
		assert.deepStrictEqual({ id, targets, cwd: submits[0].cwd, branch: submits[0].text.includes('fix/cache'), finding: submits[0].text.includes('Off by one'), noPush: submits[0].text.includes('Do not push') },
			{ id: 's1', targets: [{ id: 's1', kind: 'worktree' }], cwd: '/repo', branch: true, finding: true, noPush: true });
	});

	test('@klawly remember appends new rules to REVIEW.md as a local edit, once', async () => {
		const { bot, files, writes } = setup({ comments: ['@klawly remember Use tabs.', 'nice', '@klawly remember Use tabs.'] });
		const first = await bot.remember(pullRequest, folder, new AbortController().signal);
		const second = await bot.remember(pullRequest, folder, new AbortController().signal);
		assert.deepStrictEqual({ first: first.added, file: first.file.path, second: second.added, writes, text: files.get('/repo/REVIEW.md')?.includes('Use tabs.') },
			{ first: ['Use tabs.'], file: '/repo/REVIEW.md', second: [], writes: ['/repo/REVIEW.md'], text: true });
	});

	test('remember uses .claude/review.md when only that one exists, and writes nothing without rules', async () => {
		const existing = setup({ comments: ['@klawly remember Name tests by behavior.'], files: { '/repo/.claude/review.md': '# Review\n' } });
		const result = await existing.bot.remember(pullRequest, folder, new AbortController().signal);
		assert.deepStrictEqual({ file: result.file.path, writes: existing.writes }, { file: '/repo/.claude/review.md', writes: ['/repo/.claude/review.md'] });

		const none = setup({ comments: ['@klawly review'] });
		assert.deepStrictEqual((await none.bot.remember(pullRequest, folder, new AbortController().signal)).added, []);
		assert.deepStrictEqual(none.writes, []);
	});
});
