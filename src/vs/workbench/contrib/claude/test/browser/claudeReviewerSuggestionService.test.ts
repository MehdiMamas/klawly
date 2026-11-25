/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeGitHubReference } from '../../../../../platform/claude/common/claudeProtocol.js';
import { GitHubRequestError } from '../../../../../platform/github/common/githubTypes.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AuthenticationSession, IAuthenticationService } from '../../../../services/authentication/common/authentication.js';
import { IWorkbenchGitHubService } from '../../../../services/github/common/githubService.js';
import { ClaudeReviewerSuggestionService } from '../../browser/chat/claudeReviewerSuggestions.js';

const reference: ClaudeGitHubReference = { kind: 'pullRequest', owner: 'acme', repo: 'secret', number: 1, url: 'https://github.com/acme/secret/pull/1', createdBySession: false };

function session(id: string, scopes: string[]): AuthenticationSession {
	return { id, accessToken: 'token', account: { id, label: id }, scopes };
}

const PULL_REQUEST = { user: { login: 'author' }, base: { ref: 'main' } };

suite('Klawly Suggest Reviewers sign-in access (issue 1497)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** `readable` names the sign-in ids GitHub lets read the repository; `publicRepo` lets anonymous reads through. */
	function setup(sessions: AuthenticationSession[], readable: string[], publicRepo: boolean) {
		const calls: string[] = [];
		const github = {
			acquireSessionClient: async (_provider: string, sessionId: string) => ({
				object: {
					credentials: { getCredential: async () => ({ account: { host: 'api.github.com' }, token: 't' }) },
					endpoint: { getApiBaseUri: () => 'https://api.github.com' },
					transport: {
						rest: async (_account: unknown, _token: string, request: { url: string }) => {
							calls.push(`session ${sessionId} ${request.url.replace('https://api.github.com', '')}`);
							if (!readable.includes(sessionId)) {
								throw new GitHubRequestError('Not found', 'notFound', 404);
							}
							return { statusCode: 200, data: request.url.endsWith('/pulls/1') ? PULL_REQUEST : [] };
						},
					},
				},
				dispose: () => undefined,
			}),
			acquireAnonymousClient: () => ({
				object: {
					get: async (path: string) => {
						calls.push(`anonymous ${path}`);
						return publicRepo ? { statusCode: 200, data: path.endsWith('/pulls/1') ? PULL_REQUEST : [] } : { statusCode: 404, data: undefined };
					},
				},
				dispose: () => undefined,
			}),
		} as unknown as IWorkbenchGitHubService;
		const created: string[][] = [];
		const authentication = {
			getSessions: async () => sessions,
			createSession: async (_provider: string, scopes: string[]) => {
				created.push(scopes);
				const signedIn = session('repo-session', scopes);
				sessions.push(signedIn);
				readable.push(signedIn.id);
				return signedIn;
			},
		} as unknown as IAuthenticationService;
		const service = store.add(new ClaudeReviewerSuggestionService(github, authentication, { open: async () => true } as unknown as IOpenerService, new NullLogService()));
		return { service, calls, created };
	}

	test('a read:user sign-in on a private repository needs repository access, and signing in with it loads the suggestions', async () => {
		const { service, created } = setup([session('profile', ['read:user'])], [], false);
		await service.suggest('s', reference);
		const before = service.get('s', reference).status;
		await service.signIn('s', reference);
		assert.deepStrictEqual({ before, created, after: service.get('s', reference).status }, { before: 'needsAccess', created: [['repo']], after: 'ready' });
	});

	test('no GitHub sign-in at all on a private repository needs repository access too', async () => {
		const { service } = setup([], [], false);
		await service.suggest('s', reference);
		assert.strictEqual(service.get('s', reference).status, 'needsAccess');
	});

	test('a repo-scoped sign-in is used over a read:user one', async () => {
		const { service, calls } = setup([session('profile', ['read:user']), session('repo-session', ['repo'])], ['repo-session'], false);
		await service.suggest('s', reference);
		assert.deepStrictEqual({ status: service.get('s', reference).status, usedProfile: calls.some(call => call.startsWith('session profile')), usedRepo: calls.some(call => call.startsWith('session repo-session')) }, { status: 'ready', usedProfile: false, usedRepo: true });
	});

	test('a public repository still loads with a read:user sign-in, anonymously', async () => {
		const { service, calls } = setup([session('profile', ['read:user'])], [], true);
		await service.suggest('s', reference);
		assert.deepStrictEqual({ status: service.get('s', reference).status, anonymous: calls.some(call => call.startsWith('anonymous')) }, { status: 'ready', anonymous: true });
	});

	test('a repo-scoped sign-in that still cannot read the repository is unavailable, not a sign-in prompt', async () => {
		const { service } = setup([session('repo-session', ['repo'])], [], false);
		await service.suggest('s', reference);
		assert.strictEqual(service.get('s', reference).status, 'unavailable');
	});
});
