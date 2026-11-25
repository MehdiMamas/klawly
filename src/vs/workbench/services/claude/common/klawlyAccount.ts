/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { AuthenticationSession, AuthenticationSessionAccount, IAuthenticationService } from '../../authentication/common/authentication.js';

/** The authentication provider of Klawly's profile: the built-in GitHub sign-in. */
export const KLAWLY_PROFILE_PROVIDER_ID = 'github';

/**
 * The GitHub scopes Klawly's profile asks for. Scopes are asked for in steps: `read:user` is
 * enough to show who you are. Settings sync (issue 447) and the feedback reporter (issue 444)
 * ask for more with {@link IKlawlyAccountService.getSession} when the user turns them on.
 */
export const KLAWLY_PROFILE_SCOPES: readonly string[] = ['read:user'];

export const KLAWLY_GITHUB_SIGN_IN_COMMAND_ID = 'klawly.github.signIn';
export const KLAWLY_GITHUB_SIGN_OUT_COMMAND_ID = 'klawly.github.signOut';
/** Opens Klawly Settings on the profile. Registered by the Klawly workbench contribution. */
export const KLAWLY_PROFILE_OPEN_COMMAND_ID = 'klawly.profile.open';

/** The GitHub account that is the user's Klawly profile (issue 446). */
export interface IKlawlyGitHubAccount {
	/** The GitHub username, without the `@`. */
	readonly login: string;
	/** GitHub's numeric user id, as a string. */
	readonly id: string;
	readonly avatarUrl: string | undefined;
}

/** A command a service account row offers, such as Log Out. */
export interface IKlawlyServiceAccountAction {
	readonly commandId: string;
	readonly label: string;
	readonly args?: readonly unknown[];
}

/**
 * An account of a service Klawly uses, shown as a smaller row under the profile (DL-69):
 * Claude now, more Claude accounts later (issue 450).
 */
export interface IKlawlyServiceAccount {
	readonly id: string;
	/** The row's text, such as "Claude: Pro". */
	readonly label: string;
	readonly signedIn: boolean;
	readonly actions: readonly IKlawlyServiceAccountAction[];
}

export const IKlawlyAccountService = createDecorator<IKlawlyAccountService>('klawlyAccountService');

/**
 * Klawly's profile: who the user is (their GitHub account), and the service accounts under it.
 * Tokens stay in the GitHub authentication provider's secret storage; this service only keeps
 * the account's username, so it never writes a token to settings, storage or logs.
 */
export interface IKlawlyAccountService {
	readonly _serviceBrand: undefined;

	/** The signed-in GitHub account, or undefined while signed out or not yet resolved. */
	readonly account: IKlawlyGitHubAccount | undefined;
	readonly onDidChangeAccount: Event<IKlawlyGitHubAccount | undefined>;

	/** Rows under the profile, in the order they were set. */
	readonly serviceAccounts: readonly IKlawlyServiceAccount[];
	readonly onDidChangeServiceAccounts: Event<void>;

	/** Signs in with GitHub (device code). Resolves undefined when the user cancels. */
	signIn(): Promise<IKlawlyGitHubAccount | undefined>;
	/** Signs the profile's GitHub account out of Klawly. The Claude sign-in is untouched. */
	signOut(): Promise<void>;
	/** The profile's session with {@link KLAWLY_PROFILE_SCOPES}, without asking the user. */
	getSessionSilently(): Promise<AuthenticationSession | undefined>;
	/**
	 * The profile's session with more scopes, asking the user only when `createIfNone` is set.
	 * The incremental step for sync (issue 447) and the feedback reporter (issue 444).
	 */
	getSession(scopes: readonly string[], createIfNone: boolean): Promise<AuthenticationSession | undefined>;

	/** Adds or replaces the row with this id. Disposing the result removes it. */
	setServiceAccount(account: IKlawlyServiceAccount): IDisposable;
}

/** The profile account a GitHub session describes. */
export function klawlyGitHubAccount(account: AuthenticationSessionAccount): IKlawlyGitHubAccount {
	return {
		login: account.label,
		id: account.id,
		avatarUrl: account.icon?.toString(true),
	};
}

/** Whether a sign-in failed only because the user closed it. */
export function isKlawlySignInCancelled(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /cancel/i.test(message);
}

function sameAccount(a: IKlawlyGitHubAccount | undefined, b: IKlawlyGitHubAccount | undefined): boolean {
	return a?.id === b?.id && a?.login === b?.login && a?.avatarUrl === b?.avatarUrl;
}

const PROFILE_ACCOUNT_KEY = 'klawly.profile.githubAccount';

export class KlawlyAccountService extends Disposable implements IKlawlyAccountService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeAccount = this._register(new Emitter<IKlawlyGitHubAccount | undefined>());
	readonly onDidChangeAccount = this._onDidChangeAccount.event;

	private readonly _onDidChangeServiceAccounts = this._register(new Emitter<void>());
	readonly onDidChangeServiceAccounts = this._onDidChangeServiceAccounts.event;

	private _account: IKlawlyGitHubAccount | undefined;
	private _serviceAccounts: IKlawlyServiceAccount[] = [];
	private _refresh: Promise<void> | undefined;
	private _refreshAgain = false;

	constructor(
		@IAuthenticationService private readonly _authentication: IAuthenticationService,
		@IStorageService private readonly _storage: IStorageService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this._register(this._authentication.onDidChangeSessions(e => {
			if (e.providerId === KLAWLY_PROFILE_PROVIDER_ID) {
				void this.refresh();
			}
		}));
		this._register(this._authentication.onDidRegisterAuthenticationProvider(e => {
			if (e.id === KLAWLY_PROFILE_PROVIDER_ID) {
				void this.refresh();
			}
		}));
		// Reading the sessions activates the GitHub provider, so the profile shows without a sign-in prompt.
		void this.refresh();
	}

	get account(): IKlawlyGitHubAccount | undefined {
		return this._account;
	}

	get serviceAccounts(): readonly IKlawlyServiceAccount[] {
		return this._serviceAccounts;
	}

	/** The username the user last signed in with, so a second GitHub account never takes over. */
	private get rememberedLogin(): string | undefined {
		return this._storage.get(PROFILE_ACCOUNT_KEY, StorageScope.APPLICATION);
	}

	private set rememberedLogin(login: string | undefined) {
		if (login) {
			this._storage.store(PROFILE_ACCOUNT_KEY, login, StorageScope.APPLICATION, StorageTarget.MACHINE);
		} else {
			this._storage.remove(PROFILE_ACCOUNT_KEY, StorageScope.APPLICATION);
		}
	}

	/**
	 * Re-reads the profile from the GitHub provider. Calls made while one runs share it, and a call made
	 * after that read started (a provider registering, a session change) makes it read once more, because
	 * the running read may have started before the provider existed and found no session (issue 1575).
	 */
	refresh(): Promise<void> {
		if (this._refresh) {
			this._refreshAgain = true;
			return this._refresh;
		}
		this._refresh = this.refreshUntilCurrent().finally(() => this._refresh = undefined);
		return this._refresh;
	}

	private async refreshUntilCurrent(): Promise<void> {
		do {
			this._refreshAgain = false;
			await this.doRefresh();
		} while (this._refreshAgain);
	}

	private async doRefresh(): Promise<void> {
		const session = await this.findSession(KLAWLY_PROFILE_SCOPES);
		this.setAccount(session ? klawlyGitHubAccount(session.account) : undefined);
	}

	private async findSession(scopes: readonly string[]): Promise<AuthenticationSession | undefined> {
		try {
			const sessions = await this._authentication.getSessions(KLAWLY_PROFILE_PROVIDER_ID, scopes, undefined, true);
			const remembered = this.rememberedLogin;
			return sessions.find(session => session.account.label === remembered) ?? sessions[0];
		} catch (error) {
			// The message never carries a token: the provider only reports why it could not list sessions.
			this._log.warn(`[Klawly profile] Could not read GitHub sessions: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	private setAccount(account: IKlawlyGitHubAccount | undefined): void {
		if (sameAccount(this._account, account)) {
			return;
		}
		this._account = account;
		this._onDidChangeAccount.fire(account);
	}

	async signIn(): Promise<IKlawlyGitHubAccount | undefined> {
		let session: AuthenticationSession;
		try {
			session = await this._authentication.createSession(KLAWLY_PROFILE_PROVIDER_ID, KLAWLY_PROFILE_SCOPES, { activateImmediate: true });
		} catch (error) {
			if (isKlawlySignInCancelled(error)) {
				return undefined;
			}
			throw error;
		}
		const account = klawlyGitHubAccount(session.account);
		this.rememberedLogin = account.login;
		this.setAccount(account);
		return account;
	}

	async signOut(): Promise<void> {
		const account = this._account;
		if (!account) {
			return;
		}
		// Every scope this account granted Klawly goes, so sync and feedback stop too. Claude is another provider and stays signed in.
		const sessions = await this._authentication.getSessions(KLAWLY_PROFILE_PROVIDER_ID, undefined, undefined, true);
		for (const session of sessions) {
			if (session.account.id === account.id) {
				await this._authentication.removeSession(KLAWLY_PROFILE_PROVIDER_ID, session.id);
			}
		}
		this.rememberedLogin = undefined;
		this.setAccount(undefined);
	}

	getSessionSilently(): Promise<AuthenticationSession | undefined> {
		return this.findSession(KLAWLY_PROFILE_SCOPES);
	}

	async getSession(scopes: readonly string[], createIfNone: boolean): Promise<AuthenticationSession | undefined> {
		const wanted = [...new Set([...KLAWLY_PROFILE_SCOPES, ...scopes])];
		const existing = await this.findSession(wanted);
		if (existing || !createIfNone) {
			return existing;
		}
		const account = this._account ? { label: this._account.login, id: this._account.id } : undefined;
		try {
			return await this._authentication.createSession(KLAWLY_PROFILE_PROVIDER_ID, wanted, { activateImmediate: true, account });
		} catch (error) {
			if (isKlawlySignInCancelled(error)) {
				return undefined;
			}
			throw error;
		}
	}

	setServiceAccount(account: IKlawlyServiceAccount): IDisposable {
		const index = this._serviceAccounts.findIndex(candidate => candidate.id === account.id);
		this._serviceAccounts = index === -1
			? [...this._serviceAccounts, account]
			: this._serviceAccounts.map((candidate, i) => i === index ? account : candidate);
		this._onDidChangeServiceAccounts.fire();
		return toDisposable(() => {
			if (this._serviceAccounts.includes(account)) {
				this._serviceAccounts = this._serviceAccounts.filter(candidate => candidate !== account);
				this._onDidChangeServiceAccounts.fire();
			}
		});
	}
}

// Registered here, not in a desktop entry point, so the Accounts entry that injects it has it in every build.
registerSingleton(IKlawlyAccountService, KlawlyAccountService, InstantiationType.Delayed);
