/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeGhResult, ClaudeGitHubApi, claudeGhApiArgs, parseClaudeGhApiOutput } from '../../node/claudeGitHubApi.js';

suite('Claude GitHub API through gh (issue 518)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('builds a read-only gh api call, conditional on the ETag', () => {
		assert.deepStrictEqual({
			plain: claudeGhApiArgs('repos/octo-org/app/branches/main'),
			conditional: claudeGhApiArgs('repos/octo-org/app/branches/main', 'W/"abc"'),
			injected: claudeGhApiArgs('repos/octo-org/app/branches/main', 'W/"abc"\r\nX-Evil: 1'),
			refused: (() => { try { return claudeGhApiArgs('user'); } catch (error) { return (error as Error).message; } })(),
		}, {
			plain: ['api', '-i', '--method', 'GET', 'repos/octo-org/app/branches/main'],
			conditional: ['api', '-i', '--method', 'GET', '-H', 'If-None-Match: W/"abc"', 'repos/octo-org/app/branches/main'],
			injected: ['api', '-i', '--method', 'GET', 'repos/octo-org/app/branches/main'],
			refused: 'Not a GitHub API path Klawly polls: user',
		});
	});

	test('reads the status line, not the exit code: 200, 304, an error status and no answer', () => {
		const result = (stdout: string, code = 0, stderr = ''): ClaudeGhResult => ({ code, stdout, stderr });
		assert.deepStrictEqual([
			parseClaudeGhApiOutput(result('HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nEtag: W/"abc"\r\n\r\n{"commit":{"sha":"a"}}')),
			parseClaudeGhApiOutput(result('HTTP/2.0 304 Not Modified\nEtag: "abc"\n\n', 1, 'gh: HTTP 304')),
			parseClaudeGhApiOutput(result('HTTP/2.0 404 Not Found\n\n{"message":"Not Found"}', 1, 'gh: Not Found (HTTP 404)')),
			parseClaudeGhApiOutput(result('', 4, 'To get started with GitHub CLI, please run:  gh auth login\n')),
			parseClaudeGhApiOutput(result('HTTP/2.0 200 OK\n\n<html>', 0)),
		], [
			{ status: 200, etag: 'W/"abc"', body: { commit: { sha: 'a' } } },
			{ status: 304, etag: '"abc"' },
			{ status: 404, error: 'Not Found' },
			{ status: 0, error: 'To get started with GitHub CLI, please run:  gh auth login' },
			{ status: 200, error: 'GitHub sent an answer that is not JSON.' },
		]);
	});

	test('the service runs gh with the injected runner', async () => {
		const calls: string[] = [];
		const api = new ClaudeGitHubApi(async args => {
			calls.push(args.join(' '));
			return { code: 0, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
		});
		assert.deepStrictEqual({ response: await api.get('repos/octo-org/app/pulls?state=open', 'e1'), calls }, {
			response: { status: 200, etag: undefined, body: [] },
			calls: ['api -i --method GET -H If-None-Match: e1 repos/octo-org/app/pulls?state=open'],
		});
	});
});
