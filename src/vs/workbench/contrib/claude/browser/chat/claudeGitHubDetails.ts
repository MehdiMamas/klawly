/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, IReference, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ClaudeGitHubReference } from '../../../../../platform/claude/common/claudeProtocol.js';
import { PullRequestCheck, PullRequestSnapshot } from '../../../../../platform/github/common/githubPullRequestService.js';
import { IGitHubAnonymousClient } from '../../../../../platform/github/common/githubService.js';
import { GitHubRequestError } from '../../../../../platform/github/common/githubTypes.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IURLService } from '../../../../../platform/url/common/url.js';
import { AuthenticationSession, IAuthenticationService } from '../../../../services/authentication/common/authentication.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IWorkbenchGitHubService } from '../../../../services/github/common/githubService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { hasRepositoryAccess, isRepositoryAccessError, pickGitHubSession } from '../../common/claudeReviewerSuggestions.js';
import { checksFromRest, ClaudeGitHubChecks, ClaudeGitHubDetails, ClaudeGitHubDetailsState, issueFromRest, pullRequestFromRest } from '../../common/claudeGitHubCards.js';

/** The accounts menu's GitHub sign-in (the built-in GitHub Authentication extension). */
const GITHUB_PROVIDER = 'github';
const GITHUB_API = 'https://api.github.com';
/** GitHub Pull Requests (`GitHub.vscode-pull-request-github`); its URI handler opens a pull request or issue in its own view. */
const PULL_REQUESTS_EXTENSION = 'GitHub.vscode-pull-request-github';
/** Focus refreshes a card only when its data is older than this. */
const REFRESH_AFTER = 30_000;
const REQUEST_TIMEOUT = 10_000;

export const IClaudeGitHubDetailsService = createDecorator<IClaudeGitHubDetailsService>('claudeGitHubDetailsService');

/**
 * The details of the pull requests and issues in Claude sessions (issue 430):
 * title, state, checks, branches and author. They come from upstream's GitHub
 * service with the accounts menu's GitHub sign-in, or anonymously for public
 * repositories; never through a Copilot account. Cached per session and
 * refreshed when the session or the window gets focus.
 */
export interface IClaudeGitHubDetailsService {
	readonly _serviceBrand: undefined;
	/** A pull request or issue's details changed in a session. */
	readonly onDidChange: Event<{ readonly sessionId: string; readonly url: string }>;
	/** What is known now; asks GitHub the first time. */
	get(sessionId: string, reference: ClaudeGitHubReference): ClaudeGitHubDetailsState;
	/** Signs in to GitHub from the accounts menu's provider, then asks GitHub again. */
	signIn(): Promise<void>;
	/** Opens it in GitHub Pull Requests when that extension is installed, otherwise in the browser. */
	open(reference: ClaudeGitHubReference): Promise<void>;
}

interface CacheEntry {
	readonly reference: ClaudeGitHubReference;
	state: ClaudeGitHubDetailsState;
	fetchedAt: number;
	request?: AbortController;
}

export class ClaudeGitHubDetailsService extends Disposable implements IClaudeGitHubDetailsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<{ readonly sessionId: string; readonly url: string }>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _cache = new Map<string, Map<string, CacheEntry>>();
	private readonly _anonymous = this._register(new MutableDisposable<IReference<IGitHubAnonymousClient>>());

	constructor(
		@IWorkbenchGitHubService private readonly _github: IWorkbenchGitHubService,
		@IAuthenticationService private readonly _authentication: IAuthenticationService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IHostService hostService: IHostService,
		@IExtensionService private readonly _extensions: IExtensionService,
		@IURLService private readonly _urls: IURLService,
		@IProductService private readonly _product: IProductService,
		@IOpenerService private readonly _opener: IOpenerService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this._register(toDisposable(() => {
			for (const entries of this._cache.values()) {
				for (const entry of entries.values()) {
					entry.request?.abort();
				}
			}
			this._cache.clear();
		}));
		this._register(hostService.onDidChangeFocus(focused => {
			const session = focused ? this._agent.getCurrentSession() : undefined;
			if (session) {
				this.refresh(session.id, false);
			}
		}));
		this._register(this._agent.onDidChangeSession(change => {
			if (change.reason === 'selected' && change.session) {
				this.refresh(change.session.id, false);
			}
			if (change.reason === 'closed') {
				const open = new Set(change.sessions.map(session => session.id));
				for (const [sessionId, entries] of this._cache) {
					if (!open.has(sessionId)) {
						entries.forEach(entry => entry.request?.abort());
						this._cache.delete(sessionId);
					}
				}
			}
		}));
		// A new or removed GitHub sign-in changes what the cards can see.
		this._register(this._authentication.onDidChangeSessions(event => {
			if (event.providerId === GITHUB_PROVIDER) {
				for (const sessionId of this._cache.keys()) {
					this.refresh(sessionId, true);
				}
			}
		}));
	}

	get(sessionId: string, reference: ClaudeGitHubReference): ClaudeGitHubDetailsState {
		let entries = this._cache.get(sessionId);
		if (!entries) {
			entries = new Map();
			this._cache.set(sessionId, entries);
		}
		let entry = entries.get(reference.url);
		if (!entry) {
			entry = { reference, state: { status: 'loading' }, fetchedAt: 0 };
			entries.set(reference.url, entry);
			this.load(sessionId, entry);
		}
		return entry.state;
	}

	async signIn(): Promise<void> {
		try {
			await this._authentication.createSession(GITHUB_PROVIDER, ['repo']);
		} catch (error) {
			// Cancelled or failed: the cards keep asking the user to sign in.
			this._log.debug('[Claude] GitHub sign-in did not complete', error);
		}
	}

	async open(reference: ClaudeGitHubReference): Promise<void> {
		if (this._product.urlProtocol && await this._extensions.getExtension(PULL_REQUESTS_EXTENSION)) {
			// The extension's own URI shape (`toOpenPullRequestWebviewUri` and `toOpenIssueWebviewUri` in its `src/common/uri.ts`).
			const query = reference.kind === 'pullRequest'
				? { owner: reference.owner, repo: reference.repo, pullRequestNumber: reference.number }
				: { owner: reference.owner, repo: reference.repo, issueNumber: reference.number };
			const uri = URI.from({ scheme: this._product.urlProtocol, authority: PULL_REQUESTS_EXTENSION, path: reference.kind === 'pullRequest' ? '/open-pull-request-webview' : '/open-issue-webview', query: JSON.stringify(query) });
			// The user clicked it, so there is nothing to confirm.
			if (await this._urls.open(uri, { trusted: true })) {
				return;
			}
		}
		await this._opener.open(URI.parse(reference.url), { openExternal: true });
	}

	/** Asks GitHub again for a session's references; `all` includes ones fetched just now. */
	private refresh(sessionId: string, all: boolean): void {
		const now = Date.now();
		for (const entry of this._cache.get(sessionId)?.values() ?? []) {
			if (!entry.request && (all || now - entry.fetchedAt > REFRESH_AFTER)) {
				this.load(sessionId, entry);
			}
		}
	}

	/** Fetches one reference; the card keeps showing what it had until the answer comes. */
	private load(sessionId: string, entry: CacheEntry): void {
		const request = entry.request = new AbortController();
		void this.fetch(entry.reference, request.signal).then(state => {
			if (request.signal.aborted) {
				return;
			}
			entry.request = undefined;
			entry.fetchedAt = Date.now();
			// A failed refresh keeps the details already shown.
			if (state.status === 'unavailable' && entry.state.status === 'loaded') {
				return;
			}
			entry.state = state;
			this._onDidChange.fire({ sessionId, url: entry.reference.url });
		});
	}

	private async fetch(reference: ClaudeGitHubReference, signal: AbortSignal): Promise<ClaudeGitHubDetailsState> {
		const sessions = await this.githubSessions();
		const session = pickGitHubSession(sessions);
		if (session) {
			try {
				const details = await this.fetchWithSession(session.id, reference, signal);
				if (details) {
					return { status: 'loaded', details };
				}
			} catch (error) {
				// No access with this sign-in (or another failure): a public repository still answers anonymously.
				this._log.debug('[Claude] GitHub details with the signed-in account failed', error);
			}
		}
		try {
			const details = await this.fetchAnonymously(reference, signal);
			return details ? { status: 'loaded', details } : { status: 'unavailable' };
		} catch (error) {
			this._log.debug('[Claude] GitHub details failed', error);
			// GitHub answers 404 for a private repository it hides from anonymous reads, and from a sign-in without the repo scope.
			return !hasRepositoryAccess(sessions) && isRepositoryAccessError(error)
				? { status: 'signIn' }
				: { status: 'unavailable' };
		}
	}

	/** The accounts menu's GitHub sign-in, preferring one that can read private repositories; never prompts. */
	private async githubSessions(): Promise<readonly AuthenticationSession[]> {
		try {
			return await this._authentication.getSessions(GITHUB_PROVIDER, [], { silent: true }, true);
		} catch {
			return [];
		}
	}

	private async fetchWithSession(sessionId: string, reference: ClaudeGitHubReference, signal: AbortSignal): Promise<ClaudeGitHubDetails | undefined> {
		const cancellation = new CancellationTokenSource();
		const abort = Event.once(Event.fromDOMEventEmitter(signal, 'abort'))(() => cancellation.cancel());
		let clientReference: Awaited<ReturnType<IWorkbenchGitHubService['acquireSessionClient']>> | undefined;
		try {
			clientReference = await this._github.acquireSessionClient(GITHUB_PROVIDER, sessionId, signal);
			const client = clientReference.object;
			const credential = await client.credentials.getCredential(signal);
			if (credential.account.host.toLowerCase() !== 'api.github.com') {
				return undefined;
			}
			const target = { ...credential.account, owner: reference.owner, repo: reference.repo, number: reference.number };
			if (reference.kind === 'issue') {
				const subscription = client.query.subscribeIssue(target, { priority: 'interactive' });
				try {
					await subscription.refresh(cancellation.token);
					const issue = subscription.resource.state.get().value;
					return issue && { kind: 'issue', title: issue.title, body: issue.body, state: issue.state, notPlanned: issue.stateReason === 'not_planned', author: issue.author.login };
				} finally {
					subscription.dispose();
				}
			}
			const subscription = client.pullRequests.subscribePullRequest(target, { priority: 'interactive', core: true });
			try {
				await subscription.refresh('core', cancellation.token);
				signal.throwIfAborted();
				subscription.update({ priority: 'interactive', core: true, checks: { includeOptional: true } });
				await subscription.refresh('checks', cancellation.token).catch(error => this._log.debug('[Claude] GitHub checks failed', error));
				signal.throwIfAborted();
				const snapshot = subscription.resource.snapshot.get();
				const core = snapshot.core.value;
				if (!core) {
					const error = snapshot.core.error;
					throw new GitHubRequestError(error?.message ?? 'GitHub returned no pull request', error?.kind ?? 'unknown', error?.statusCode);
				}
				return { kind: 'pullRequest', title: core.title, body: core.body ?? '', state: core.state, draft: core.draft, author: core.author?.login ?? '', headRef: core.headRef, baseRef: core.baseRef, checks: snapshotChecks(snapshot) };
			} finally {
				subscription.dispose();
			}
		} finally {
			clientReference?.dispose();
			abort.dispose();
			cancellation.dispose();
		}
	}

	private async fetchAnonymously(reference: ClaudeGitHubReference, signal: AbortSignal): Promise<ClaudeGitHubDetails | undefined> {
		this._anonymous.value ??= this._github.acquireAnonymousClient({ apiBaseUri: GITHUB_API });
		const client = this._anonymous.value.object;
		const repository = `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}`;
		const read = async (path: string) => {
			const response = await client.get<unknown>(path, signal, { caller: 'github.query', deadline: Date.now() + REQUEST_TIMEOUT });
			if (response.statusCode === 404) {
				throw new GitHubRequestError('Not found', 'notFound', 404);
			}
			return response.data;
		};
		if (reference.kind === 'issue') {
			return issueFromRest(await read(`${repository}/issues/${reference.number}`));
		}
		const pullRequest = pullRequestFromRest(await read(`${repository}/pulls/${reference.number}`));
		if (!pullRequest) {
			return undefined;
		}
		let checks: ClaudeGitHubChecks | undefined;
		if (pullRequest.headSha && pullRequest.details.state === 'open') {
			try {
				checks = checksFromRest(await read(`${repository}/commits/${encodeURIComponent(pullRequest.headSha)}/check-runs?per_page=100`));
			} catch (error) {
				this._log.debug('[Claude] GitHub checks failed', error);
			}
		}
		return { ...pullRequest.details, checks };
	}
}

/** The checks of a pull request's head commit, as upstream's pull request hover sums them up. */
function snapshotChecks(snapshot: PullRequestSnapshot): ClaudeGitHubChecks | undefined {
	const value = snapshot.checks.value;
	if (!value || value.headSha !== snapshot.core.value?.headSha || !value.checks.length) {
		return undefined;
	}
	if (value.checks.some(isPendingCheck)) {
		return 'pending';
	}
	return value.checks.some(isFailingCheck) ? 'failure' : 'success';
}

function isPendingCheck(check: PullRequestCheck): boolean {
	return check.type === 'checkRun'
		? check.status !== 'COMPLETED'
		: check.status === 'PENDING' || check.status === 'EXPECTED';
}

function isFailingCheck(check: PullRequestCheck): boolean {
	return check.type === 'checkRun'
		? check.conclusion === 'FAILURE' || check.conclusion === 'TIMED_OUT' || check.conclusion === 'CANCELLED' || check.conclusion === 'ACTION_REQUIRED' || check.conclusion === 'STARTUP_FAILURE'
		: check.status === 'FAILURE' || check.status === 'ERROR';
}

registerSingleton(IClaudeGitHubDetailsService, ClaudeGitHubDetailsService, InstantiationType.Delayed);
