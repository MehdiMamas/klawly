/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, IReference, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ClaudeGitHubReference } from '../../../../../platform/claude/common/claudeProtocol.js';
import { IGitHubAnonymousClient } from '../../../../../platform/github/common/githubService.js';
import { GitHubRequestError } from '../../../../../platform/github/common/githubTypes.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { AuthenticationSession, IAuthenticationService } from '../../../../services/authentication/common/authentication.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IWorkbenchGitHubService } from '../../../../services/github/common/githubService.js';
import { CLAUDE_AGENT_ENABLED } from '../../common/claudeContextKeys.js';
import {
	CODEOWNERS_PATHS, HISTORY_WINDOW_MS, OAUTH_RESTRICTIONS_DOCS_URL, orgAccessRestriction, orgOAuthPolicyUrl, hasRepositoryAccess, isRepositoryAccessError, pickGitHubSession, ReviewerChangedFile, ReviewerHistoryCommit, ReviewerSuggestions, filesForHistory, parseChangedFiles, parseContentsText, parseHistory,
	missingRequestedReviewers, parsePullRequestForReviewers, requestReviewersBody, reviewerRestPaths, suggestReviewers
} from '../../common/claudeReviewerSuggestions.js';
import { KLAWLY_CATEGORY } from '../../common/claudeViews.js';

export const CLAUDE_SUGGEST_REVIEWERS_COMMAND_ID = 'claude.suggestReviewers';

const GITHUB_PROVIDER = 'github';
const GITHUB_API = 'https://api.github.com';
const REQUEST_TIMEOUT = 15_000;
/** Pull requests with more changed files than this read only their first pages of files. */
const MAX_FILE_PAGES = 3;

/** What the card shows for a pull request's reviewer suggestions. */
export type ClaudeReviewerState =
	| { readonly status: 'idle' }
	| { readonly status: 'loading' }
	| { readonly status: 'unavailable' }
	/** GitHub hides this repository from the current sign-in, which lacks the `repo` scope: the card offers a sign-in with repository access. */
	| { readonly status: 'needsAccess' }
	/** The repository's organization restricts OAuth app access, so GitHub refuses Klawly until the organization grants it (issue 1519). */
	| { readonly status: 'orgRestricted'; readonly org: string }
	| {
		readonly status: 'ready';
		readonly suggestions: ReviewerSuggestions;
		readonly changedFiles: number;
		readonly now: number;
		/** Asking GitHub for the reviews: not yet, under way, done, refused, or needing a GitHub sign-in first. */
		readonly request: 'none' | 'requesting' | 'requested' | 'dropped' | 'failed' | 'signIn' | 'orgRestricted';
		readonly requested: readonly string[];
		/** With dropped: the reviewers or teams GitHub answered without adding (issue 1520). */
		readonly dropped?: readonly string[];
		/** With orgRestricted: the organization that limits third-party access (issue 1519). */
		readonly restrictedOrg?: string;
	};

export const IClaudeReviewerSuggestionService = createDecorator<IClaudeReviewerSuggestionService>('claudeReviewerSuggestionService');

/**
 * Suggest Reviewers (issues 508 and 870): reads the changed files, CODEOWNERS
 * and recent history from GitHub, names up to three reviewers with a reason
 * each and a risk note, with no model turn. Requesting the reviews is a
 * separate click on the card; nothing is approved.
 */
export interface IClaudeReviewerSuggestionService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<{ readonly sessionId: string; readonly url: string }>;
	/** What is known now for a pull request in a session. */
	get(sessionId: string, reference: ClaudeGitHubReference): ClaudeReviewerState;
	/** Reads GitHub and works out the suggestions; the card updates through `onDidChange`. */
	suggest(sessionId: string, reference: ClaudeGitHubReference): Promise<void>;
	/** Signs in to GitHub with repository access, then reads the pull request again. */
	signIn(sessionId: string, reference: ClaudeGitHubReference): Promise<void>;
	/** Opens the page that explains OAuth app access restrictions: the organization's policy for its owners, otherwise GitHub's docs. */
	openAccessHelp(org: string, owner: boolean): Promise<void>;
	/** Asks GitHub to request these reviews (users, or `org/team`). */
	request(sessionId: string, reference: ClaudeGitHubReference, logins: readonly string[]): Promise<void>;
}

class UnavailableError extends Error { }

export class ClaudeReviewerSuggestionService extends Disposable implements IClaudeReviewerSuggestionService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<{ readonly sessionId: string; readonly url: string }>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _states = new Map<string, ClaudeReviewerState>();
	private readonly _running = new Map<string, AbortController>();
	private readonly _anonymous = this._register(new MutableDisposable<IReference<IGitHubAnonymousClient>>());

	constructor(
		@IWorkbenchGitHubService private readonly _github: IWorkbenchGitHubService,
		@IAuthenticationService private readonly _authentication: IAuthenticationService,
		@IOpenerService private readonly _opener: IOpenerService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this._register(toDisposable(() => this._running.forEach(controller => controller.abort())));
	}

	get(sessionId: string, reference: ClaudeGitHubReference): ClaudeReviewerState {
		return this._states.get(key(sessionId, reference)) ?? { status: 'idle' };
	}

	private set(sessionId: string, reference: ClaudeGitHubReference, state: ClaudeReviewerState): void {
		this._states.set(key(sessionId, reference), state);
		this._onDidChange.fire({ sessionId, url: reference.url });
	}

	async suggest(sessionId: string, reference: ClaudeGitHubReference): Promise<void> {
		if (reference.kind !== 'pullRequest' || this.get(sessionId, reference).status === 'loading') {
			return;
		}
		const id = key(sessionId, reference);
		this._running.get(id)?.abort();
		const controller = new AbortController();
		this._running.set(id, controller);
		this.set(sessionId, reference, { status: 'loading' });
		try {
			const state = await this.read(reference, controller.signal);
			if (!controller.signal.aborted) {
				this.set(sessionId, reference, state);
			}
		} catch (error) {
			this._log.debug('[Claude] Suggest Reviewers could not read GitHub', error);
			const restricted = orgAccessRestriction(error, reference.owner);
			if (restricted && !controller.signal.aborted) {
				this.set(sessionId, reference, { status: 'orgRestricted', org: restricted.org });
			} else if (!controller.signal.aborted) {
				const needsAccess = isRepositoryAccessError(error) && !hasRepositoryAccess(await this.githubSessions());
				if (!controller.signal.aborted) {
					this.set(sessionId, reference, { status: needsAccess ? 'needsAccess' : 'unavailable' });
				}
			}
		} finally {
			if (this._running.get(id) === controller) {
				this._running.delete(id);
			}
		}
	}

	async signIn(sessionId: string, reference: ClaudeGitHubReference): Promise<void> {
		try {
			await this._authentication.createSession(GITHUB_PROVIDER, ['repo']);
		} catch (error) {
			// Cancelled or failed: the card keeps offering the sign-in.
			this._log.debug('[Claude] GitHub sign-in with repository access did not complete', error);
			return;
		}
		await this.suggest(sessionId, reference);
	}

	async openAccessHelp(org: string, owner: boolean): Promise<void> {
		await this._opener.open(URI.parse(owner ? orgOAuthPolicyUrl(org) : OAUTH_RESTRICTIONS_DOCS_URL));
	}

	async request(sessionId: string, reference: ClaudeGitHubReference, logins: readonly string[]): Promise<void> {
		const state = this.get(sessionId, reference);
		if (state.status !== 'ready' || !logins.length || state.request === 'requesting') {
			return;
		}
		this.set(sessionId, reference, { ...state, request: 'requesting' });
		try {
			const dropped = await this.send(reference, logins);
			this.set(sessionId, reference, dropped.length
				? { ...state, request: 'dropped', requested: logins.filter(login => !dropped.includes(login)), dropped }
				: { ...state, request: 'requested', requested: logins });
		} catch (error) {
			this._log.debug('[Claude] Request Review failed', error);
			const restricted = orgAccessRestriction(error, reference.owner);
			this.set(sessionId, reference, restricted
				? { ...state, request: 'orgRestricted', restrictedOrg: restricted.org }
				: { ...state, request: error instanceof GitHubRequestError && error.kind === 'authentication' ? 'signIn' : 'failed' });
		}
	}

	// -- GitHub ------------------------------------------------------------

	private async read(reference: ClaudeGitHubReference, signal: AbortSignal): Promise<ClaudeReviewerState> {
		const paths = reviewerRestPaths(reference.owner, reference.repo, reference.number);
		const get = (path: string) => this.get_(path, signal);

		const pull = parsePullRequestForReviewers((await get(paths.pullRequest)).data);
		if (!pull) {
			throw new UnavailableError();
		}
		const files: ReviewerChangedFile[] = [];
		for (let page = 1; page <= MAX_FILE_PAGES; page++) {
			const pageFiles = parseChangedFiles((await get(paths.files(page))).data);
			files.push(...pageFiles);
			if (pageFiles.length < 100) {
				break;
			}
		}

		const now = Date.now();
		const since = new Date(now - HISTORY_WINDOW_MS).toISOString();
		let codeOwners: string | undefined;
		for (const path of CODEOWNERS_PATHS) {
			const response = await get(paths.codeOwners(path, pull.baseRef)).catch(error => {
				if (error instanceof GitHubRequestError && error.kind === 'notFound') {
					return undefined;
				}
				throw error;
			});
			codeOwners = response && parseContentsText(response.data, base64 => new TextDecoder().decode(Uint8Array.from(atob(base64), char => char.charCodeAt(0))));
			if (codeOwners !== undefined) {
				break;
			}
		}

		const history: ReviewerHistoryCommit[] = [];
		for (const path of filesForHistory(files)) {
			history.push(...parseHistory(path, (await get(paths.history(path, since))).data));
		}

		return {
			status: 'ready',
			suggestions: suggestReviewers({ author: pull.author, files, codeOwners, history, alreadyRequested: pull.requested, now }),
			changedFiles: files.length,
			now,
			request: 'none',
			requested: [],
		};
	}

	/** A GET with the GitHub sign-in when there is one, otherwise anonymously for public repositories. */
	private async get_(path: string, signal: AbortSignal): Promise<{ readonly data: unknown }> {
		const session = await this.githubSession();
		if (session) {
			try {
				return await this.withClient(session.id, signal, (client, credential) =>
					client.transport.rest<unknown>(credential.account, credential.token, { caller: 'github.query', method: 'GET', url: `${client.endpoint.getApiBaseUri()}${path}`, priority: 'interactive' }, signal));
			} catch (error) {
				if (orgAccessRestriction(error, '')) {
					// The organization limits third-party access: an anonymous read would only say "not found".
					throw error;
				}
				// No access with this sign-in: a public repository still answers anonymously.
				this._log.debug('[Claude] Suggest Reviewers read with the signed-in account failed', error);
			}
		}
		this._anonymous.value ??= this._github.acquireAnonymousClient({ apiBaseUri: GITHUB_API });
		const response = await this._anonymous.value.object.get<unknown>(path, signal, { caller: 'github.query', deadline: Date.now() + REQUEST_TIMEOUT });
		if (response.statusCode === 404) {
			throw new GitHubRequestError('Not found', 'notFound', 404);
		}
		if (response.statusCode === 401 || response.statusCode === 403) {
			throw new GitHubRequestError(`GitHub answered ${response.statusCode}`, response.statusCode === 401 ? 'authentication' : 'authorization', response.statusCode);
		}
		return response;
	}

	private async send(reference: ClaudeGitHubReference, logins: readonly string[]): Promise<readonly string[]> {
		const session = await this.githubSession();
		if (!session) {
			throw new GitHubRequestError('Sign in to GitHub to request reviews', 'authentication');
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
		try {
			const path = reviewerRestPaths(reference.owner, reference.repo, reference.number).requestedReviewers;
			const response = await this.withClient(session.id, controller.signal, (client, credential) =>
				client.transport.rest<unknown>(credential.account, credential.token, { caller: 'github.query', method: 'POST', url: `${client.endpoint.getApiBaseUri()}${path}`, body: requestReviewersBody(logins), priority: 'interactive' }, controller.signal));
			if (response.statusCode < 200 || response.statusCode >= 300) {
				throw new GitHubRequestError(`GitHub answered ${response.statusCode}`, 'unknown', response.statusCode, JSON.stringify(response.data));
			}
			// GitHub can answer 201 and still drop a reviewer: only what the answer lists was added (issue 1520).
			return missingRequestedReviewers(logins, response.data);
		} finally {
			clearTimeout(timeout);
		}
	}

	private async withClient<T>(sessionId: string, signal: AbortSignal, run: (client: Awaited<ReturnType<IWorkbenchGitHubService['acquireSessionClient']>>['object'], credential: Awaited<ReturnType<Awaited<ReturnType<IWorkbenchGitHubService['acquireSessionClient']>>['object']['credentials']['getCredential']>>) => Promise<T>): Promise<T> {
		const reference = await this._github.acquireSessionClient(GITHUB_PROVIDER, sessionId, signal);
		try {
			const credential = await reference.object.credentials.getCredential(signal);
			if (credential.account.host.toLowerCase() !== 'api.github.com') {
				throw new UnavailableError();
			}
			return await run(reference.object, credential);
		} finally {
			reference.dispose();
		}
	}

	private async githubSession(): Promise<AuthenticationSession | undefined> {
		return pickGitHubSession(await this.githubSessions());
	}

	private async githubSessions(): Promise<readonly AuthenticationSession[]> {
		try {
			return await this._authentication.getSessions(GITHUB_PROVIDER, [], { silent: true }, true);
		} catch {
			return [];
		}
	}
}

function key(sessionId: string, reference: ClaudeGitHubReference): string {
	return `${sessionId}\n${reference.url}`;
}

registerSingleton(IClaudeReviewerSuggestionService, ClaudeReviewerSuggestionService, InstantiationType.Delayed);

/** Suggest Reviewers for the pull request the current session opened (its pill); the answer shows on its card. */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CLAUDE_SUGGEST_REVIEWERS_COMMAND_ID,
			title: localize2('claudeSuggestReviewers', "Suggest Reviewers"),
			category: KLAWLY_CATEGORY,
			precondition: CLAUDE_AGENT_ENABLED,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const agent = accessor.get(IClaudeAgentService);
		const reviewers = accessor.get(IClaudeReviewerSuggestionService);
		const notifications = accessor.get(INotificationService);
		const session = agent.getCurrentSession();
		const pullRequest = session ? agent.getViewState(session.id).pullRequest : undefined;
		if (!session || !pullRequest) {
			notifications.info(localize('claudeSuggestReviewersNoPullRequest', "This chat hasn't opened a pull request. Use Suggest Reviewers on a pull request card instead."));
			return;
		}
		await reviewers.suggest(session.id, pullRequest);
		const state = reviewers.get(session.id, pullRequest);
		if (state.status === 'needsAccess') {
			notifications.prompt(Severity.Info, localize('claudeSuggestReviewersNeedsAccess', "Klawly needs access to this repository to suggest reviewers."), [{
				label: localize('claudeSuggestReviewersSignIn', "Sign In with Repository Access"),
				run: () => reviewers.signIn(session.id, pullRequest),
			}]);
		} else if (state.status === 'unavailable') {
			notifications.info(localize('claudeSuggestReviewersUnavailable', "Couldn't read this pull request from GitHub. Try again in a moment."));
		} else {
			notifications.info(localize('claudeSuggestReviewersOnCard', "The suggested reviewers are on the pull request card in the chat."));
		}
	}
});
