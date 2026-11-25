/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { joinPath } from '../../../../../base/common/resources.js';
import Severity from '../../../../../base/common/severity.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { CLAUDE_REVIEW_NOTES_FILES } from '../../../../../platform/claude/common/claudeCommitReview.js';
import { ClaudeGitHubReference } from '../../../../../platform/claude/common/claudeProtocol.js';
import { appendClaudeReviewRule, claudeFixOnBranchPrompt, ClaudeGitHubReview, claudeRememberRules, claudeReviewConfirmDetail, parseClaudePullRequestUrl } from '../../../../../platform/claude/common/claudeReviewBot.js';
import { ClaudeReviewFinding } from '../../../../../platform/claude/common/claudeReviewLoop.js';
import { removeClaudeSecrets } from '../../../../../platform/claude/common/claudeSecretScan.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { GitHubRequestError } from '../../../../../platform/github/common/githubTypes.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { AuthenticationSession, IAuthenticationService } from '../../../../services/authentication/common/authentication.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudeContextService } from '../../../../services/claude/common/claudeContextService.js';
import { IWorkbenchGitHubService } from '../../../../services/github/common/githubService.js';

const GITHUB_PROVIDER = 'github';
const REQUEST_TIMEOUT = 30_000;

/** The pull request the review bot works on. */
export interface ClaudeReviewBotPullRequest {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly url: string;
}

/** The GitHub calls the review bot makes, all with the person's own sign-in. Tests pass a fake. */
export interface ClaudeReviewBotGitHub {
	/** Posts one review with line comments; answers the review's page when GitHub gives it. */
	postReview(pullRequest: ClaudeReviewBotPullRequest, review: ClaudeGitHubReview, signal: AbortSignal): Promise<string | undefined>;
	/** The pull request's head branch. */
	headRef(pullRequest: ClaudeReviewBotPullRequest, signal: AbortSignal): Promise<string | undefined>;
	/** The bodies of the pull request's conversation and line comments. */
	comments(pullRequest: ClaudeReviewBotPullRequest, signal: AbortSignal): Promise<readonly string[]>;
}

export type ClaudeReviewPostResult = { readonly status: 'cancelled' } | { readonly status: 'posted'; readonly url?: string };

/**
 * The review bot's steps (issue 872), apart from the workbench so a test can drive them with fakes.
 * Nothing reaches GitHub before the person confirms the exact comments; a remembered rule is a local edit, never a commit.
 */
export class ClaudeReviewBot {
	constructor(
		private readonly _github: ClaudeReviewBotGitHub,
		private readonly _dialogs: Pick<IDialogService, 'confirm'>,
		private readonly _agent: Pick<IClaudeAgentService, 'createSession' | 'setExecutionTarget' | 'getSessions' | 'submit' | 'selectSession'>,
		private readonly _context: Pick<IClaudeContextService, 'preview'>,
		private readonly _files: Pick<IFileService, 'exists' | 'readFile' | 'writeFile'>,
	) { }

	/** Shows every comment in a confirm dialog, then posts them as one review. Cancel posts nothing. Secrets are removed first (rule 40). */
	async post(pullRequest: ClaudeReviewBotPullRequest, review: ClaudeGitHubReview, signal: AbortSignal): Promise<ClaudeReviewPostResult> {
		const clean: ClaudeGitHubReview = { ...review, body: removeClaudeSecrets(review.body), comments: review.comments.map(comment => ({ ...comment, body: removeClaudeSecrets(comment.body) })) };
		const { confirmed } = await this._dialogs.confirm({
			message: localize('claudeReviewBotConfirm', "Post {0} review comments to {1}/{2}#{3} as you?", clean.comments.length, pullRequest.owner, pullRequest.repo, pullRequest.number),
			detail: claudeReviewConfirmDetail(clean),
			primaryButton: localize({ key: 'claudeReviewBotConfirmButton', comment: ['&& denotes a mnemonic'] }, "&&Post"),
		});
		if (!confirmed) {
			return { status: 'cancelled' };
		}
		const url = await this._github.postReview(pullRequest, clean, signal);
		return { status: 'posted', url };
	}

	/** Fix on PR Branch: a new chat in a new worktree, told to check out the pull request's head branch and fix only this finding. Answers the chat's id. */
	async startFix(finding: ClaudeReviewFinding, pullRequest: ClaudeReviewBotPullRequest, cwd: string, signal: AbortSignal): Promise<string> {
		const headRef = await this._github.headRef(pullRequest, signal).catch(() => undefined);
		const text = removeClaudeSecrets(claudeFixOnBranchPrompt(finding, { ...pullRequest, headRef }));
		const session = this._agent.createSession();
		this._agent.setExecutionTarget(session.id, { kind: 'worktree' });
		this._agent.selectSession(session.id);
		const mode = this._agent.getSessions().find(candidate => candidate.id === session.id)?.mode ?? 'agent';
		const compiled = await this._context.preview(text, mode, [], session.id);
		await this._agent.submit(session.id, text, cwd, { compiled });
		return session.id;
	}

	/**
	 * Reads the pull request's comments and appends every `@klawly remember <rule>` that is not there yet to the
	 * project's review notes (REVIEW.md, or .claude/review.md when only that one exists). A local edit: nothing is
	 * committed. Answers the rules it added and the file.
	 */
	async remember(pullRequest: ClaudeReviewBotPullRequest, folder: URI, signal: AbortSignal): Promise<{ readonly added: readonly string[]; readonly file: URI }> {
		const rules = claudeRememberRules(await this._github.comments(pullRequest, signal));
		let file = joinPath(folder, CLAUDE_REVIEW_NOTES_FILES[0]);
		for (const name of CLAUDE_REVIEW_NOTES_FILES) {
			if (await this._files.exists(joinPath(folder, name))) {
				file = joinPath(folder, name);
				break;
			}
		}
		if (!rules.length) {
			return { added: [], file };
		}
		let text = await this._files.readFile(file).then(content => content.value.toString(), () => undefined);
		const added: string[] = [];
		for (const rule of rules) {
			const next = appendClaudeReviewRule(text, rule);
			if (next.added) {
				text = next.text;
				added.push(rule);
			}
		}
		if (added.length && text !== undefined) {
			await this._files.writeFile(file, VSBuffer.fromString(text));
		}
		return { added, file };
	}
}

/** The pull request a chat is about: the one it made, else the last one it linked. */
export function claudeSessionPullRequest(agent: Pick<IClaudeAgentService, 'getViewState'>, sessionId: string): ClaudeReviewBotPullRequest | undefined {
	const state = agent.getViewState(sessionId);
	if (state.pullRequest?.kind === 'pullRequest') {
		return state.pullRequest;
	}
	let found: ClaudeGitHubReference | undefined;
	for (const turn of state.turns) {
		for (const part of turn.parts ?? []) {
			if (part.kind === 'github' && part.reference.kind === 'pullRequest') {
				found = part.reference;
			}
		}
	}
	return found;
}

/** The person's own GitHub sign-in from the accounts menu (issue 872). */
class SessionReviewBotGitHub implements ClaudeReviewBotGitHub {
	constructor(
		private readonly _github: IWorkbenchGitHubService,
		private readonly _authentication: IAuthenticationService,
	) { }

	async postReview(pullRequest: ClaudeReviewBotPullRequest, review: ClaudeGitHubReview, signal: AbortSignal): Promise<string | undefined> {
		const response = await this.rest('POST', pullRequest, `pulls/${pullRequest.number}/reviews`, signal, review);
		const url = (response.data as { html_url?: unknown } | undefined)?.html_url;
		return typeof url === 'string' ? url : undefined;
	}

	async headRef(pullRequest: ClaudeReviewBotPullRequest, signal: AbortSignal): Promise<string | undefined> {
		const response = await this.rest('GET', pullRequest, `pulls/${pullRequest.number}`, signal);
		const ref = (response.data as { head?: { ref?: unknown } } | undefined)?.head?.ref;
		return typeof ref === 'string' ? ref : undefined;
	}

	async comments(pullRequest: ClaudeReviewBotPullRequest, signal: AbortSignal): Promise<readonly string[]> {
		const bodies: string[] = [];
		for (const route of [`issues/${pullRequest.number}/comments?per_page=100`, `pulls/${pullRequest.number}/comments?per_page=100`]) {
			const data = (await this.rest('GET', pullRequest, route, signal)).data;
			for (const comment of Array.isArray(data) ? data : []) {
				const body = (comment as { body?: unknown } | null)?.body;
				if (typeof body === 'string') {
					bodies.push(body);
				}
			}
		}
		return bodies;
	}

	private async rest(method: 'GET' | 'POST', pullRequest: ClaudeReviewBotPullRequest, route: string, signal: AbortSignal, body?: object): Promise<{ readonly data: unknown }> {
		const session = await this.githubSession();
		if (!session) {
			throw new GitHubRequestError('Sign in to GitHub from the accounts menu first', 'authentication');
		}
		const reference = await this._github.acquireSessionClient(GITHUB_PROVIDER, session.id, signal);
		try {
			const client = reference.object;
			const credential = await client.credentials.getCredential(signal);
			if (credential.account.host.toLowerCase() !== 'api.github.com') {
				throw new GitHubRequestError('The GitHub sign-in is not for github.com', 'authentication');
			}
			const url = `${client.endpoint.getApiBaseUri()}/repos/${pullRequest.owner}/${pullRequest.repo}/${route}`;
			const response = await client.transport.rest<unknown>(credential.account, credential.token, method === 'POST'
				? { caller: 'github.mutations', method, url, body, priority: 'mutation' }
				: { caller: 'github.query', method, url, priority: 'interactive' }, signal);
			if (response.statusCode < 200 || response.statusCode >= 300) {
				throw new GitHubRequestError(`GitHub answered ${response.statusCode}`, 'unknown', response.statusCode);
			}
			return response;
		} finally {
			reference.dispose();
		}
	}

	/** Prefers a sign-in that can reach private repositories; never prompts. */
	private async githubSession(): Promise<AuthenticationSession | undefined> {
		try {
			const sessions = await this._authentication.getSessions(GITHUB_PROVIDER, [], { silent: true }, true);
			return sessions.find(session => session.scopes.includes('repo')) ?? sessions[0];
		} catch {
			return undefined;
		}
	}
}

export interface IClaudeReviewBotService {
	readonly _serviceBrand: undefined;
	/** Post as Review Comments for a chat's review: asks which pull request when the chat names none, confirms, posts. */
	post(sessionId: string, review: ClaudeGitHubReview): Promise<void>;
	/** Fix on PR Branch for one finding of a chat's review. */
	fix(sessionId: string, finding: ClaudeReviewFinding): Promise<void>;
	/** Picks up `@klawly remember` rules from a pull request's comments into the review notes; quiet when there are none. */
	remember(reference: ClaudeReviewBotPullRequest): Promise<void>;
	/** The same for a chat's pull request, asking for it when the chat names none; says so when nothing was new. */
	rememberForSession(sessionId: string): Promise<void>;
}

export const IClaudeReviewBotService = createDecorator<IClaudeReviewBotService>('claudeReviewBotService');

export class ClaudeReviewBotService implements IClaudeReviewBotService {
	declare readonly _serviceBrand: undefined;

	private readonly _bot: ClaudeReviewBot;

	constructor(
		@IWorkbenchGitHubService github: IWorkbenchGitHubService,
		@IAuthenticationService authentication: IAuthenticationService,
		@IDialogService dialogs: IDialogService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeContextService context: IClaudeContextService,
		@IFileService files: IFileService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@INotificationService private readonly _notifications: INotificationService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IOpenerService private readonly _opener: IOpenerService,
	) {
		this._bot = new ClaudeReviewBot(new SessionReviewBotGitHub(github, authentication), dialogs, _agent, context, files);
	}

	private get folder(): URI | undefined {
		return this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === 'file')?.uri;
	}

	/** The chat's pull request, or the one the person names in a box; undefined when they close it. */
	private async pullRequest(sessionId: string): Promise<ClaudeReviewBotPullRequest | undefined> {
		const known = claudeSessionPullRequest(this._agent, sessionId);
		if (known) {
			return known;
		}
		const typed = await this._quickInput.input({
			title: localize('claudeReviewBotPickTitle', "Which Pull Request?"),
			prompt: localize('claudeReviewBotPickPrompt', "This chat names no pull request. Paste its GitHub link."),
			placeHolder: 'https://github.com/owner/repo/pull/123',
			validateInput: async value => parseClaudePullRequestUrl(value) ? undefined : localize('claudeReviewBotPickInvalid', "Paste a link like https://github.com/owner/repo/pull/123."),
		});
		return typed ? parseClaudePullRequestUrl(typed) : undefined;
	}

	private withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
		return run(controller.signal).finally(() => clearTimeout(timer));
	}

	async post(sessionId: string, review: ClaudeGitHubReview): Promise<void> {
		const pullRequest = await this.pullRequest(sessionId);
		if (!pullRequest) {
			return;
		}
		try {
			const result = await this.withTimeout(signal => this._bot.post(pullRequest, review, signal));
			if (result.status === 'posted') {
				const url = result.url;
				this._notifications.prompt(Severity.Info, localize('claudeReviewBotPosted', "Posted {0} review comments to #{1}.", review.comments.length, pullRequest.number), url ? [{
					label: localize('claudeReviewBotOpenReview', "Open on GitHub"),
					run: () => void this._opener.open(URI.parse(url)),
				}] : []);
			}
		} catch (error) {
			this._notifications.error(localize('claudeReviewBotPostFailed', "Could not post the review: {0}", toErrorMessage(error)));
		}
	}

	async fix(sessionId: string, finding: ClaudeReviewFinding): Promise<void> {
		const cwd = this.folder?.fsPath;
		if (!cwd) {
			this._notifications.info(localize('claudeReviewBotFixNoFolder', "Open the pull request's repository folder to fix a finding on its branch."));
			return;
		}
		const pullRequest = await this.pullRequest(sessionId);
		if (!pullRequest) {
			return;
		}
		try {
			await this.withTimeout(signal => this._bot.startFix(finding, pullRequest, cwd, signal));
		} catch (error) {
			this._notifications.error(localize('claudeReviewBotFixFailed', "Could not start the fix: {0}", toErrorMessage(error)));
		}
	}

	async remember(reference: ClaudeReviewBotPullRequest): Promise<void> {
		await this.rememberIn(reference, false);
	}

	async rememberForSession(sessionId: string): Promise<void> {
		const pullRequest = await this.pullRequest(sessionId);
		if (pullRequest) {
			await this.rememberIn(pullRequest, true);
		}
	}

	private async rememberIn(pullRequest: ClaudeReviewBotPullRequest, sayNothingNew: boolean): Promise<void> {
		const folder = this.folder;
		if (!folder) {
			return;
		}
		try {
			const { added, file } = await this.withTimeout(signal => this._bot.remember(pullRequest, folder, signal));
			const name = file.path.slice(folder.path.length).replace(/^\//, '');
			if (added.length) {
				this._notifications.info(localize('claudeReviewBotRemembered', "Added {0} rule(s) from #{1} to {2}. It is a local edit: review and commit it yourself.", added.length, pullRequest.number, name));
			} else if (sayNothingNew) {
				this._notifications.info(localize('claudeReviewBotNothingToRemember', "No new @klawly remember rules on #{0}.", pullRequest.number));
			}
		} catch (error) {
			if (sayNothingNew) {
				this._notifications.error(localize('claudeReviewBotRememberFailed', "Could not read the pull request's comments: {0}", toErrorMessage(error)));
			}
		}
	}
}

registerSingleton(IClaudeReviewBotService, ClaudeReviewBotService, InstantiationType.Delayed);
