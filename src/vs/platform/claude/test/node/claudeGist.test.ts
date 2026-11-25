/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { parseClaudeGistId } from '../../common/claudeShare.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { createClaudeGist, readClaudeGist, ClaudeGistRunner } from '../../node/claudeGist.js';

suite('Claude gist (issue 490)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('runs gh gist create with the chat on stdin, and reads the link or why it failed', async () => {
		const calls: { args: readonly string[]; input: string }[] = [];
		const runner = (result: Awaited<ReturnType<ClaudeGistRunner>>): ClaudeGistRunner => async (args, input) => { calls.push({ args, input }); return result; };
		const request = { filename: 'Fix', description: 'Klawly chat: Fix', content: '# Fix' };
		assert.deepStrictEqual({
			created: await createClaudeGist(request, runner({ code: 0, stdout: 'https://gist.github.com/someone/abc\n', stderr: '' })),
			missing: await createClaudeGist(request, runner({ code: null, stdout: '', stderr: 'spawn gh ENOENT', missing: true })),
			signedOut: (await createClaudeGist(request, runner({ code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' }))).kind,
			problem: await createClaudeGist(request, runner({ code: 1, stdout: '', stderr: 'error\nHTTP 422: Validation Failed' })),
			call: calls[0],
		}, {
			created: { kind: 'created', url: 'https://gist.github.com/someone/abc' },
			missing: { kind: 'failed', problem: 'ghMissing', message: 'The GitHub CLI (gh) is not installed.' },
			signedOut: 'failed',
			problem: { kind: 'failed', problem: 'failed', message: 'HTTP 422: Validation Failed' },
			call: { args: ['gist', 'create', '--filename', 'Fix.md', '--desc', 'Klawly chat: Fix', '-'], input: '# Fix' },
		});
	});

	test('reads a shared chat from a gist link through gh, and refuses anything that is not a gist link', async () => {
		const calls: (readonly string[])[] = [];
		const runner = (result: Awaited<ReturnType<ClaudeGistRunner>>): ClaudeGistRunner => async args => { calls.push(args); return result; };
		const link = 'https://gist.github.com/someone/0123456789abcdef0123456789abcdef';
		assert.deepStrictEqual({
			ids: [parseClaudeGistId(link), parseClaudeGistId(`${link}/revisions`), parseClaudeGistId('0123456789abcdef0123456789abcdef'), parseClaudeGistId('https://evil.example/someone/0123456789abcdef0123456789abcdef'), parseClaudeGistId('hello')],
			read: await readClaudeGist(link, runner({ code: 0, stdout: '# Fix\n', stderr: '' })),
			missing: await readClaudeGist(link, runner({ code: null, stdout: '', stderr: 'ENOENT', missing: true })),
			notFound: await readClaudeGist(link, runner({ code: 1, stdout: '', stderr: 'HTTP 404: Not Found' })),
			notALink: await readClaudeGist('hello', runner({ code: 0, stdout: 'x', stderr: '' })),
			call: calls[0],
			calls: calls.length,
		}, {
			ids: ['0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef', undefined, undefined],
			read: { kind: 'read', content: '# Fix\n' },
			missing: { kind: 'failed', problem: 'ghMissing', message: 'The GitHub CLI (gh) is not installed.' },
			notFound: { kind: 'failed', problem: 'failed', message: 'HTTP 404: Not Found' },
			notALink: { kind: 'failed', problem: 'failed', message: 'That is not a gist link.' },
			call: ['gist', 'view', '0123456789abcdef0123456789abcdef', '--raw'],
			calls: 3,
		});
	});
});
