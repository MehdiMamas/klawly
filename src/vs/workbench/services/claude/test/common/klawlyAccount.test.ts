/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Action, SubmenuAction } from '../../../../../base/common/actions.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { AuthenticationSession, IAuthenticationService } from '../../../authentication/common/authentication.js';
import { IKlawlyGitHubAccount, KlawlyAccountService } from '../../common/klawlyAccount.js';
import { klawlyProfileMenuActions, klawlyProfileTitle } from '../../common/klawlyProfileMenu.js';

/** The GitHub provider, as far as the profile reads it: sessions per account and the calls made. */
class FakeGitHubAuthentication {
	readonly calls: string[] = [];
	sessions: AuthenticationSession[] = [];
	readonly changes = new Emitter<{ providerId: string; label: string; event: { added: undefined; removed: undefined; changed: undefined } }>();
	cancelNext = false;

	readonly service = {
		onDidChangeSessions: this.changes.event,
		onDidRegisterAuthenticationProvider: Event.None,
		getSessions: async (providerId: string, scopes?: readonly string[]) => {
			this.calls.push(`getSessions ${providerId} ${scopes?.join(',') ?? '*'}`);
			return this.sessions.filter(session => !scopes || scopes.every(scope => session.scopes.includes(scope)));
		},
		createSession: async (providerId: string, scopes: readonly string[], options?: { account?: { label: string } }) => {
			this.calls.push(`createSession ${providerId} ${scopes.join(',')}${options?.account ? ` as ${options.account.label}` : ''}`);
			if (this.cancelNext) {
				this.cancelNext = false;
				throw new Error('User did not consent to login. Cancelled');
			}
			const session = githubSession('octocat', '583231', scopes);
			this.sessions.push(session);
			return session;
		},
		removeSession: async (providerId: string, id: string) => {
			this.calls.push(`removeSession ${providerId} ${id}`);
			this.sessions = this.sessions.filter(session => session.id !== id);
		},
	} as Partial<IAuthenticationService> as IAuthenticationService;
}

function githubSession(login: string, id: string, scopes: readonly string[]): AuthenticationSession {
	return {
		id: `${login}-${scopes.join('+')}`,
		accessToken: 'token-never-shown',
		account: { label: login, id, icon: URI.parse(`https://avatars.githubusercontent.com/u/${id}?v=4`) },
		scopes,
	};
}

suite('Klawly profile (issue 446)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(github: FakeGitHubAuthentication, storage = store.add(new InMemoryStorageService())) {
		store.add(github.changes);
		return { service: store.add(new KlawlyAccountService(github.service, storage, new NullLogService())), storage };
	}

	/** A GitHub provider that is not registered when the profile starts and still holds the session from before the update. */
	function lateProvider() {
		const registered = store.add(new Emitter<{ id: string }>());
		const changes = store.add(new Emitter<{ providerId: string }>());
		let ready = false;
		let waited = false;
		let release: (() => void) | undefined;
		const session = githubSession('octocat', '583231', ['read:user', 'user:email']);
		const service = {
			onDidChangeSessions: changes.event,
			onDidRegisterAuthenticationProvider: registered.event,
			getSessions: async () => {
				if (!ready) {
					// The first read waits for the extension to activate, then finds nothing registered.
					if (!waited) {
						waited = true;
						await new Promise<void>(resolve => release = resolve);
					}
					throw new Error(`No authentication provider 'github' is currently registered.`);
				}
				return [session];
			},
		} as unknown as IAuthenticationService;
		return {
			service,
			register: () => { ready = true; registered.fire({ id: 'github' }); },
			failFirstRead: () => release?.(),
		};
	}

	test('a provider that registers after the profile started, with a session already stored, ends signed in (issue 1575)', async () => {
		const late = lateProvider();
		const service = store.add(new KlawlyAccountService(late.service, store.add(new InMemoryStorageService()), new NullLogService()));
		late.failFirstRead();
		await service.refresh();
		const before = service.account;
		const changes: (IKlawlyGitHubAccount | undefined)[] = [];
		store.add(service.onDidChangeAccount(account => changes.push(account)));
		late.register();
		await service.refresh();
		assert.deepStrictEqual({ before, login: service.account?.login, changes }, { before: undefined, login: 'octocat', changes: [{ login: 'octocat', id: '583231', avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4' }] });
	});

	test('a provider that registers while the first read is still running is not lost to that read (issue 1575)', async () => {
		const late = lateProvider();
		const service = store.add(new KlawlyAccountService(late.service, store.add(new InMemoryStorageService()), new NullLogService()));
		// The first read is in flight; the provider registers, then the first read fails.
		late.register();
		late.failFirstRead();
		await service.refresh();
		assert.strictEqual(service.account?.login, 'octocat');
	});

	test('signs in with read:user only, remembers the login, and never stores the token', async () => {
		const github = new FakeGitHubAuthentication();
		const { service, storage } = create(github);
		await service.refresh();
		const changes: (IKlawlyGitHubAccount | undefined)[] = [];
		store.add(service.onDidChangeAccount(account => changes.push(account)));
		github.cancelNext = true;
		const cancelled = await service.signIn();
		const account = await service.signIn();
		assert.deepStrictEqual({
			cancelled,
			account,
			changes,
			remembered: storage.get('klawly.profile.githubAccount', StorageScope.APPLICATION),
			calls: github.calls,
		}, {
			cancelled: undefined,
			account: { login: 'octocat', id: '583231', avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4' },
			changes: [account],
			remembered: 'octocat',
			calls: ['getSessions github read:user', 'getSessions github read:user', 'createSession github read:user', 'createSession github read:user'],
		});
	});

	test('picks the remembered account when the provider has two, and asks for more scopes only on request', async () => {
		const github = new FakeGitHubAuthentication();
		github.sessions = [githubSession('hubot', '1', ['read:user']), githubSession('octocat', '583231', ['read:user'])];
		const storage = store.add(new InMemoryStorageService());
		storage.store('klawly.profile.githubAccount', 'octocat', StorageScope.APPLICATION, StorageTarget.MACHINE);
		const { service } = create(github, storage);
		await service.refresh();
		const silent = await service.getSession(['gist'], false);
		const asked = await service.getSession(['gist'], true);
		assert.deepStrictEqual({ login: service.account?.login, silent, asked: asked?.scopes, last: github.calls.at(-1) }, {
			login: 'octocat',
			silent: undefined,
			asked: ['read:user', 'gist'],
			last: 'createSession github read:user,gist as octocat',
		});
	});

	test('signing out removes every session of the profile account and nothing else', async () => {
		const github = new FakeGitHubAuthentication();
		github.sessions = [githubSession('octocat', '583231', ['read:user']), githubSession('octocat', '583231', ['read:user', 'gist']), githubSession('hubot', '1', ['repo'])];
		const { service } = create(github);
		await service.refresh();
		await service.signOut();
		assert.deepStrictEqual({ account: service.account, left: github.sessions.map(session => session.id) }, { account: undefined, left: ['hubot-repo'] });
	});

	test('the Accounts menu: the GitHub profile first, each service account a smaller row under it', async () => {
		const github = new FakeGitHubAuthentication();
		const { service } = create(github);
		await service.refresh();
		// A newer row replaces the older one with its id, and disposing the replaced one leaves the newer in place.
		const replaced = service.setServiceAccount({ id: 'claude', label: 'Claude: Signed Out', signedIn: false, actions: [{ commandId: 'claude.signIn', label: 'Log In' }] });
		const claude = service.setServiceAccount({ id: 'claude', label: 'Claude: Pro', signedIn: true, actions: [{ commandId: 'claude.logOut', label: 'Log Out' }] });
		replaced.dispose();
		const other = service.setServiceAccount({ id: 'other', label: 'Other: Checking', signedIn: false, actions: [] });
		const ran: string[] = [];
		// The menu owns its disabled rows, as the Accounts entry does.
		const menuOf = () => klawlyProfileMenuActions(service, id => ran.push(id)).map(action => action instanceof Action ? store.add(action) : action);
		const describe = () => menuOf().map(action => action instanceof SubmenuAction
			? `${action.label} > ${action.actions.map(child => child.label).join(', ')}`
			: `${action.label}${action.enabled ? '' : ' (disabled)'}`);
		const signedOut = { menu: describe(), title: klawlyProfileTitle(service) };
		await service.signIn();
		const menu = menuOf();
		await menu[0].run();
		await menu[1].run();
		const signedIn = { menu: describe(), title: klawlyProfileTitle(service) };
		other.dispose();
		claude.dispose();
		assert.deepStrictEqual({ signedOut, signedIn, ran, left: service.serviceAccounts }, {
			signedOut: { menu: ['Sign In with GitHub', 'Claude: Pro > Log Out', 'Other: Checking (disabled)'], title: 'Sign In with GitHub' },
			signedIn: { menu: ['@octocat (GitHub)', 'Sign Out of GitHub', 'Claude: Pro > Log Out', 'Other: Checking (disabled)'], title: '@octocat (GitHub)' },
			ran: ['klawly.profile.open', 'klawly.github.signOut'],
			left: [],
		});
	});
});
