/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { toAction } from '../../../../base/common/actions.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { extUriBiasedIgnorePathCase, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { Schemas } from '../../../../base/common/network.js';
import { IClaudeWorktreeService } from '../../../../platform/claude/common/claudeBackground.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { claudeBranchReviewDiff, claudeBranchReviewKey, ClaudeBranchReviewScope } from '../../../../platform/claude/common/claudeBranchReview.js';
import { CLAUDE_REVIEW_NOTES_FILES } from '../../../../platform/claude/common/claudeCommitReview.js';
import { claudeReviewDepthMessage, planClaudeReviewRun } from '../../../../platform/claude/common/claudeReviewDepth.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IClaudeCommitReviewState } from './claudeCommitReviewState.js';
import { CLAUDE_COMMIT_REVIEW_FIX_ALL_COMMAND_ID } from './claudeCommitReviewStatus.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IClaudeActionService } from '../../../../platform/claude/common/claudeActions.js';
import { acceptedChangeConflict, commitMessageFromAssistant, gitAttachmentHasChanges, gitPathKey, planCommitAccepted, replaceCommitMessage } from '../../../../platform/claude/common/claudeGit.js';
import { actionTurnLabel } from '../../../../platform/claude/common/claudePrompt.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IClaudeContextService } from '../../../services/claude/common/claudeContextService.js';
import { ContextAttachment } from '../../../../platform/claude/common/claudeContext.js';
import { SplitPlan, splitBranchesPrompt, splitBranchesSummary, splitBranchParts, splitPlanPrompt } from '../../../../platform/claude/common/claudeSplitPlan.js';
import { openClaudeSplit } from './claudeSplitEditor.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { CLAUDE_REVIEW_IMPACT_CONTEXT_SETTING, claudeReviewInstructionsWithContext, readClaudeReviewImpactContext } from '../../../../platform/claude/common/claudeReviewContext.js';
import { gatherClaudeReviewContext } from './claudeReviewContextGatherer.js';
import { claudeReviewInstructionsWithKnowledge, claudeReviewKnowledgePrompt, parseClaudeReverts } from '../../../../platform/claude/common/claudeReviewKnowledge.js';
import { isClaudeReviewKnowledgeFileStale, readClaudeReviewKnowledge } from './claudeReviewKnowledgeReader.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { TurnViewModel } from '../../../services/claude/common/claudeAgentState.js';
import { ClaudeDelegateCard } from '../../../services/claude/common/claudeDelegationModel.js';
import { IClaudeReviewService, TurnReview } from '../../../services/claude/common/claudeReview.js';
import { SCMIncomingHistoryItemId, SCMOutgoingHistoryItemId } from '../../scm/common/history.js';
import { ISCMRepository, ISCMResource, ISCMService, VIEW_PANE_ID } from '../../scm/common/scm.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { registerClaudeMergeConflictActions } from './claudeMergeConflictActions.js';
import { CLAUDE_AGENT_VIEW_ID, CLAUDE_COMMIT_ACCEPTED_COMMAND_ID, CLAUDE_EXPLAIN_COMMIT_COMMAND_ID, CLAUDE_EXPLAIN_DIFF_COMMAND_ID, CLAUDE_GENERATE_COMMIT_MESSAGE_COMMAND_ID, CLAUDE_GENERATE_REVIEW_KNOWLEDGE_COMMAND_ID, CLAUDE_REVIEW_CHANGES_COMMAND_ID, CLAUDE_SPLIT_PULL_REQUESTS_COMMAND_ID, KLAWLY_CATEGORY } from '../common/claudeViews.js';

const COMMIT_MESSAGE_LABEL = actionTurnLabel('generateCommitMessage', { kind: 'prompt', templateId: 'generate-commit-message' });
/** Review Branch Against Base (issue 932): everything since the base branch, or only what is staged. */
export const CLAUDE_REVIEW_BRANCH_COMMAND_ID = 'claude.review.branchAgainstBase';

const GIT_PROVIDER = ContextKeyExpr.equals('scmProvider', 'git');

export function registerClaudeGitActions(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_REVIEW_CHANGES_COMMAND_ID,
				title: localize2('claudeReviewChanges', "Review Changes with Claude"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				// Its button lives in the Review with Claude section, not the Changes header (issue 749).
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const views = accessor.get(IViewsService);
			const actions = accessor.get(IClaudeActionService);
			await views.openView(CLAUDE_AGENT_VIEW_ID, true);
			await actions.run({
				id: 'reviewChanges',
				source: 'button',
				attachments: [{ kind: 'git-diff', scope: 'all' }],
			});
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_REVIEW_BRANCH_COMMAND_ID,
				title: localize2('claudeReviewBranchAgainstBase', "Review Branch Against Base"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				// Also in the Source Control title menu and as `/review-branch`, so it is found with changes present (issue 1057).
				menu: {
					id: MenuId.SCMTitle,
					group: '2_claude',
					order: 0,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, ContextKeyExpr.equals('view', VIEW_PANE_ID), ContextKeyExpr.greater('scmRepositoryCount', 0)),
				},
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await reviewBranchAgainstBase(accessor);
		}
	});

	/**
	 * Split into Pull Requests (issue 504): runs the user's `/split-to-prs` command
	 * or skill, else a built-in prompt. Claude groups the changes read-only, asks
	 * the user to confirm the groups, commits each group on its own branch in a
	 * worktree, and asks again before it pushes or opens draft pull requests.
	 * Pushing and `gh` go through the normal permission prompt (DL-65).
	 */
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_SPLIT_PULL_REQUESTS_COMMAND_ID,
				title: localize2('claudeSplitPullRequests', "Split into Pull Requests"),
				category: KLAWLY_CATEGORY,
				icon: Codicon.gitPullRequestCreate,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				menu: {
					id: MenuId.SCMTitle,
					group: '2_claude',
					order: 1,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, ContextKeyExpr.equals('view', VIEW_PANE_ID), ContextKeyExpr.greater('scmRepositoryCount', 0)),
				},
			});
		}
		async run(accessor: ServicesAccessor, sessionId?: unknown): Promise<void> {
			const views = accessor.get(IViewsService);
			const actions = accessor.get(IClaudeActionService);
			const agent = accessor.get(IClaudeAgentService);
			const context = accessor.get(IClaudeContextService);
			const editors = accessor.get(IEditorService);
			const notifications = accessor.get(INotificationService);
			const dialogs = accessor.get(IDialogService);
			const git = accessor.get(IClaudeWorktreeService);
			const log = accessor.get(ILogService);
			const trusted = accessor.get(IWorkspaceTrustManagementService).isWorkspaceTrusted();
			const root = accessor.get(IWorkspaceContextService).getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri;
			// From the Review editor: continue in the chat whose changes it shows.
			if (typeof sessionId === 'string' && agent.getCurrentSession()?.id !== sessionId) {
				agent.selectSession(sessionId);
			}
			const attachments: ContextAttachment[] = [{ kind: 'git-diff', scope: 'all' }];
			const envelope = await context.resolve('', 'agent', attachments);
			const diff = envelope.attachments.find(attachment => attachment.kind === 'git-diff');
			let patch = diff && diff.kind === 'git-diff' && gitAttachmentHasChanges(diff.stat, diff.patch) ? diff.patch : undefined;
			// Issue 971: in a trusted local repository Klawly makes the branches itself, from a diff that applies to HEAD.
			const local = !!(root && trusted && git.splitDiff && git.createSplitBranches);
			if (patch && local) {
				try {
					patch = await git.splitDiff!(root!.fsPath) || patch;
				} catch (error) {
					log.warn('[claude] split: no diff against HEAD', error);
				}
			}
			if (!patch) {
				notifications.info(localize('claudeNothingToSplitHere', "There are no uncommitted changes to split into pull requests."));
				return;
			}
			// DL-106: the groups are confirmed here, in a group editor, before Claude creates anything.
			await openClaudeSplit(editors, patch, async plan => {
				await views.openView(CLAUDE_AGENT_VIEW_ID, true);
				await actions.run({
					id: 'splitPullRequests',
					source: 'button',
					attachments,
					args: { plan: splitPlanPrompt(plan) },
				});
			}, local ? async (plan, stacked) => createSplitBranches(plan, stacked) : undefined);

			async function createSplitBranches(plan: SplitPlan, stacked: boolean): Promise<void> {
				const parts = splitBranchParts(plan);
				// DL-65: one confirmation that lists every branch and its files; nothing is pushed here.
				const { confirmed } = await dialogs.confirm({
					message: localize('claudeSplitCreateConfirm', "Create {0} branches with a worktree each?", parts.length),
					detail: `${splitBranchesSummary(plan)}\n\n${(stacked
						? localize('claudeSplitCreateDetailStacked', "Each branch starts from the one before it (the first at HEAD) in .worktrees/<branch> and gets one commit of its files. Your checkout, its branch and its changes stay as they are. Nothing is pushed.")
						: localize('claudeSplitCreateDetail', "Each branch starts at HEAD in .worktrees/<branch> and gets one commit of its files. Your checkout, its branch and its changes stay as they are. Nothing is pushed."))}`,
					primaryButton: localize({ key: 'claudeSplitCreateButton', comment: ['&& denotes a mnemonic'] }, "&&Create Branches"),
				});
				if (!confirmed) {
					return;
				}
				let results;
				try {
					results = await git.createSplitBranches!(root!.fsPath, parts, stacked);
				} catch (error) {
					log.warn('[claude] split: create branches failed', error);
					notifications.error(localize('claudeSplitCreateFailed', "Klawly could not create the branches: {0}", toErrorMessage(error)));
					return;
				}
				const made = results.filter(result => result.commit);
				const failed = results.filter(result => !result.commit);
				const failures = failed.map(result => `${result.branch}: ${result.error ?? ''}`).join('; ');
				const message = failed.length === 0
					? localize('claudeSplitCreated', "Created {0} branches, each with a worktree under .worktrees and one commit. Nothing was pushed.", made.length)
					: localize('claudeSplitCreatedSome', "Created {0} of {1} branches. Not created: {2}", made.length, results.length, failures);
				// The push is a second, separate click (DL-65); it still asks in the chat before git push and gh.
				notifications.notify({
					severity: failed.length === 0 ? Severity.Info : Severity.Warning,
					message,
					actions: made.length === 0 ? undefined : {
						primary: [toAction({
							id: 'claude.split.pushDrafts',
							label: localize('claudeSplitPushDrafts', "Push and Open Draft Pull Requests..."),
							run: async () => {
								await views.openView(CLAUDE_AGENT_VIEW_ID, true);
								await actions.run({
									id: 'splitPullRequests',
									source: 'button',
									attachments: [],
									args: { plan: splitBranchesPrompt(made) },
								});
							},
						})],
					},
				});
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_GENERATE_REVIEW_KNOWLEDGE_COMMAND_ID,
				title: localize2('claudeGenerateReviewKnowledge', "Generate Review Knowledge"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const workspace = accessor.get(IWorkspaceContextService);
			const git = accessor.get(IClaudeWorktreeService);
			const actions = accessor.get(IClaudeActionService);
			const views = accessor.get(IViewsService);
			const notifications = accessor.get(INotificationService);
			const root = workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri;
			if (!root) {
				notifications.info(localize('claudeKnowledgeNeedsFolder', "Open a local folder to generate its review knowledge."));
				return;
			}
			const reverts = parseClaudeReverts(await git.recentReverts?.(root.fsPath) ?? '');
			await views.openView(CLAUDE_AGENT_VIEW_ID, true);
			await actions.run({ id: 'generateReviewKnowledge', source: 'palette', attachments: [], args: { prompt: claudeReviewKnowledgePrompt(reverts) } });
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_GENERATE_COMMIT_MESSAGE_COMMAND_ID,
				title: localize2('claudeGenerateCommitMessage', "Generate Commit Message"),
				category: KLAWLY_CATEGORY,
				icon: Codicon.gitCommit,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				menu: {
					id: MenuId.SCMInputBox,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, GIT_PROVIDER),
					group: 'navigation',
				},
			});
		}
		async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
			const scm = accessor.get(ISCMService);
			const actions = accessor.get(IClaudeActionService);
			const agent = accessor.get(IClaudeAgentService);
			const notifications = accessor.get(INotificationService);
			const dialogs = accessor.get(IDialogService);
			const views = accessor.get(IViewsService);
			const repository = commitBoxRepository(scm, args[0]);
			if (!repository) {
				notifications.info(localize('claudeCommitMessageRoot', "Generate commit message needs the Git repository that owns this commit box."));
				return;
			}
			// Staged changes win, like the Commit button; with nothing staged the message covers the uncommitted changes (issue 748).
			const scope = commitMessageScope(repository);
			if (!scope) {
				notifications.info(localize('claudeCommitMessageNoChanges', "There are no changes to commit."));
				return;
			}
			const sessionBefore = agent.getCurrentSession();
			const priorTurnIds = new Set(sessionBefore ? agent.getViewState(sessionBefore.id).turns.map(turn => turn.id) : []);
			await views.openView(CLAUDE_AGENT_VIEW_ID, true);
			await actions.run({
				id: 'generateCommitMessage',
				source: 'button',
				attachments: [{ kind: 'git-diff', scope }],
			});
			const token = args.find(CancellationToken.isCancellationToken);
			const message = await commitMessageAfterRun(agent, token, priorTurnIds);
			// No turn started: the action service already said why, so a second notice would contradict it.
			if (message === undefined || token?.isCancellationRequested) {
				return;
			}
			if (!message) {
				notifications.info(localize('claudeCommitMessageEmpty', "Claude did not return a commit message."));
				return;
			}
			const next = await replaceCommitMessage(repository.input.value, message, async () => {
				const answer = await dialogs.confirm({
					type: 'warning',
					message: localize('claudeCommitMessageReplace', "Replace the commit message?"),
					detail: localize('claudeCommitMessageReplaceDetail', "The commit box already has text."),
					primaryButton: localize('claudeCommitMessageReplaceButton', "Replace"),
				});
				return answer.confirmed && !token?.isCancellationRequested;
			});
			if (next) {
				repository.input.setValue(next, false);
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_EXPLAIN_DIFF_COMMAND_ID,
				title: localize2('claudeExplainDiff', "Explain Diff"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				menu: {
					id: MenuId.SCMResourceContext,
					group: '0_view',
					order: 20,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, GIT_PROVIDER),
				},
			});
		}
		async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
			const resource = args.map(resourceArg).find((value): value is { uri: URI; groupId: string } => !!value);
			const notifications = accessor.get(INotificationService);
			if (!resource) {
				notifications.info(localize('claudeExplainDiffMissing', "Choose a changed file first."));
				return;
			}
			const views = accessor.get(IViewsService);
			const actions = accessor.get(IClaudeActionService);
			const scope = resource.groupId === 'index' || resource.groupId.toLowerCase().includes('stag') ? 'staged' as const : 'working-tree' as const;
			await views.openView(CLAUDE_AGENT_VIEW_ID, true);
			await actions.run({
				id: 'explainDiff',
				source: 'menu',
				attachments: [{ kind: 'git-diff', scope, path: resource.uri.toString() }],
			});
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_EXPLAIN_COMMIT_COMMAND_ID,
				title: localize2('claudeExplainCommit', "Explain Commit"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				menu: {
					id: MenuId.SCMHistoryItemContext,
					group: '0_view',
					order: 20,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, GIT_PROVIDER),
				},
			});
		}
		async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
			const item = args.map(commitArg).find((value): value is { sha: string; subject: string; message: string } => !!value);
			const notifications = accessor.get(INotificationService);
			if (!item) {
				notifications.info(localize('claudeExplainCommitMissing', "Choose a commit first."));
				return;
			}
			const views = accessor.get(IViewsService);
			const actions = accessor.get(IClaudeActionService);
			await views.openView(CLAUDE_AGENT_VIEW_ID, true);
			await actions.run({
				id: 'explainCommit',
				source: 'menu',
				attachments: [],
				args: item,
			});
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_COMMIT_ACCEPTED_COMMAND_ID,
				title: localize2('claudeCommitAcceptedChanges', "Commit Accepted Changes"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor, turnId?: string, sessionId?: string): Promise<void> {
			const scm = accessor.get(ISCMService);
			const notifications = accessor.get(INotificationService);
			const session = typeof sessionId === 'string' ? sessionId : accessor.get(IClaudeAgentService).getCurrentSession()?.id;
			const review = session && turnId ? accessor.get(IClaudeReviewService).get(session, turnId) : undefined;
			const files = accessor.get(IFileService);
			await runCommitAcceptedChanges({
				review,
				stagedPaths: groupPaths(scm, 'staged'),
				workingPaths: groupPaths(scm, 'working'),
				readText: async path => {
					try {
						return (await files.readFile(URI.file(path))).value.toString();
					} catch {
						return undefined;
					}
				},
				executeCommand: (id, ...args) => accessor.get(ICommandService).executeCommand(id, ...args),
				stagedAfter: () => groupPaths(scm, 'staged'),
				waitForStagedUpdate: timeoutMs => waitForGitResourceChange(scm, timeoutMs),
				notify: message => notifications.info(message),
				reportError: message => notifications.error(message),
			});
		}
	});

	registerClaudeMergeConflictActions();
}

/**
 * The commit message of the turn the action started: `undefined` when no turn
 * started, `''` when the turn failed, was cancelled or wrote no message.
 */
export async function commitMessageAfterRun(agent: IClaudeAgentService, token: CancellationToken | undefined, priorTurnIds: ReadonlySet<string> = new Set()): Promise<string | undefined> {
	const session = agent.getCurrentSession();
	if (!session) {
		return undefined;
	}
	const turn = commitMessageTurn(agent.getViewState(session.id).turns, priorTurnIds);
	if (!turn) {
		return undefined;
	}
	if (turn.status === 'running') {
		await waitForCommitTurn(agent, session.id, turn.id, token);
	}
	if (token?.isCancellationRequested) {
		return '';
	}
	const done = agent.getViewState(session.id).turns.find(candidate => candidate.id === turn.id);
	if (done?.status !== 'complete') {
		return '';
	}
	// Auto can hand the whole turn to a delegated chat: the head turn then ends with no text of its own and the answer sits on the delegate card (issue 966).
	return commitMessageFromAssistant(done.assistantText?.trim() ? done.assistantText : delegatedAnswer(done.delegates ?? []));
}

/** The answer of the newest finished delegated chat, looking under nested cards first. */
function delegatedAnswer(cards: readonly ClaudeDelegateCard[]): string {
	for (let index = cards.length - 1; index >= 0; index--) {
		const card = cards[index];
		const nested = delegatedAnswer(card.children);
		if (card.state === 'done' && card.result?.trim()) {
			return card.result;
		}
		if (nested) {
			return nested;
		}
	}
	return '';
}

function commitMessageTurn(turns: readonly TurnViewModel[], priorTurnIds: ReadonlySet<string>): TurnViewModel | undefined {
	for (let index = turns.length - 1; index >= 0; index--) {
		const turn = turns[index];
		if (priorTurnIds.has(turn.id)) {
			continue;
		}
		if (turn.user.text === COMMIT_MESSAGE_LABEL) {
			return turn;
		}
	}
	return undefined;
}

function waitForCommitTurn(agent: IClaudeAgentService, sessionId: string, turnId: string, token: CancellationToken | undefined): Promise<void> {
	const settled = () => agent.getViewState(sessionId).turns.find(candidate => candidate.id === turnId)?.status !== 'running';
	if (settled() || token?.isCancellationRequested) {
		return Promise.resolve();
	}
	return new Promise(resolve => {
		const listeners = new DisposableStore();
		const finish = () => {
			listeners.dispose();
			resolve();
		};
		if (token) {
			listeners.add(token.onCancellationRequested(finish));
		}
		listeners.add(agent.onDidChangeViewState(() => {
			if (settled()) {
				finish();
			}
		}));
	});
}

export interface CommitAcceptedRun {
	readonly review: TurnReview | undefined;
	readonly stagedPaths: readonly string[];
	readonly workingPaths: readonly string[];
	readText(path: string): Promise<string | undefined>;
	executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
	stagedAfter(): readonly string[];
	/**
	 * Resolves when the Source Control staged group changes, or when `timeoutMs`
	 * elapses. `git.stageFile` can return before that group includes the path.
	 */
	waitForStagedUpdate?(timeoutMs: number): Promise<void>;
	/** How long to wait for the staged group. Defaults to two seconds. */
	stageRefreshTimeoutMs?: number;
	notify(message: string): void;
	reportError(message: string): void;
}

/** Stages and commits only the accepted files. Refuses a partial index or extra working edits. */
export async function runCommitAcceptedChanges(run: CommitAcceptedRun): Promise<void> {
	if (!run.review) {
		run.notify(localize('claudeCommitAcceptedNone', "Accept a change before committing it."));
		return;
	}
	const accepted = run.review.files.filter(file => file.state === 'accepted');
	const plan = planCommitAccepted({
		files: run.review.files.map(file => ({ path: file.uri.fsPath, accepted: file.state === 'accepted' })),
		stagedPaths: run.stagedPaths,
		userInitiated: true,
	});
	if (!plan.commit) {
		if (plan.reason === 'staged-user-changes') {
			run.notify(localize('claudeCommitAcceptedStaged', "Staged files that were not accepted are left as they are. Commit accepted changes did not run."));
			return;
		}
		run.notify(localize('claudeCommitAcceptedNone', "Accept a change before committing it."));
		return;
	}
	const stagedKeys = new Set(run.stagedPaths.map(gitPathKey));
	const workingKeys = new Set(run.workingPaths.map(gitPathKey));
	for (const file of accepted) {
		const key = gitPathKey(file.uri.fsPath);
		const conflict = acceptedChangeConflict({
			inIndex: stagedKeys.has(key),
			inWorking: workingKeys.has(key),
			originalText: file.originalText,
			hunks: file.hunks,
			workingText: await run.readText(file.uri.fsPath),
		});
		if (conflict === 'partly-staged') {
			run.notify(localize('claudeCommitAcceptedPartial', "Commit accepted changes did not run. {0} is partly staged.", file.name));
			return;
		}
		if (conflict === 'beyond-accepted') {
			run.notify(localize('claudeCommitAcceptedBeyond', "Commit accepted changes did not run. {0} has edits that were not accepted.", file.name));
			return;
		}
		if (conflict === 'unreadable') {
			run.reportError(localize('claudeCommitAcceptedUnreadable', "Commit accepted changes did not run. {0} could not be read.", file.name));
			return;
		}
	}
	for (const path of plan.paths) {
		try {
			await run.executeCommand('git.stageFile', URI.file(path));
		} catch (error) {
			run.reportError(localize('claudeCommitAcceptedStageFailed', "Commit accepted changes did not run. Staging failed: {0}", toErrorMessage(error)));
			return;
		}
	}
	await settleStaged(run, plan.paths);
	const stagedNow = new Set(run.stagedAfter().map(gitPathKey));
	const missing = plan.paths.filter(path => !stagedNow.has(gitPathKey(path)));
	if (missing.length > 0) {
		run.reportError(localize('claudeCommitAcceptedStageMissing', "Commit accepted changes did not run. Staging did not include {0}.", missing[0]));
		return;
	}
	try {
		await run.executeCommand('git.commitStaged');
	} catch (error) {
		run.reportError(localize('claudeCommitAcceptedCommitFailed', "Commit accepted changes did not run. {0}", toErrorMessage(error)));
	}
}

const STAGE_REFRESH_TIMEOUT_MS = 2000;

function stagedCovers(staged: readonly string[], paths: readonly string[]): boolean {
	const now = new Set(staged.map(gitPathKey));
	return paths.every(path => now.has(gitPathKey(path)));
}

/** Waits out a late Source Control refresh. A timeout still checks `stagedAfter` once more. */
async function settleStaged(run: CommitAcceptedRun, paths: readonly string[]): Promise<void> {
	const timeoutMs = run.stageRefreshTimeoutMs ?? STAGE_REFRESH_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;
	while (!stagedCovers(run.stagedAfter(), paths)) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			return;
		}
		const started = Date.now();
		if (run.waitForStagedUpdate) {
			await run.waitForStagedUpdate(remaining);
		} else {
			await new Promise<void>(resolve => setTimeout(resolve, Math.min(20, remaining)));
		}
		if (Date.now() === started) {
			await new Promise<void>(resolve => setTimeout(resolve, Math.min(20, Math.max(0, deadline - Date.now()))));
		}
	}
}

function waitForGitResourceChange(scm: ISCMService, timeoutMs: number): Promise<void> {
	return new Promise(resolve => {
		const listeners = new DisposableStore();
		const finish = () => {
			listeners.dispose();
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		listeners.add({ dispose: () => clearTimeout(timer) });
		for (const repository of scm.repositories) {
			listeners.add(repository.provider.onDidChangeResources(finish));
		}
	});
}

/**
 * The repository whose commit box the action runs for. The SCM input toolbar passes the
 * provider's root URI, which `ISCMService.getRepository(uri)` does not match (it only
 * matches resources below a root), so roots are compared directly. Without a root (the
 * command palette) the only visible Git repository is used.
 */
function commitBoxRepository(scm: ISCMService, arg: unknown): ISCMRepository | undefined {
	const repositories = [...scm.repositories].filter(repository => repository.provider.isHidden !== true);
	if (URI.isUri(arg)) {
		return repositories.find(repository => !!repository.provider.rootUri && extUriBiasedIgnorePathCase.isEqual(repository.provider.rootUri, arg));
	}
	if (arg !== undefined && !CancellationToken.isCancellationToken(arg)) {
		return undefined;
	}
	const git = repositories.filter(repository => repository.provider.providerId === 'git');
	return git.length === 1 ? git[0] : undefined;
}

/** `staged` when the repository has staged changes, else `working-tree` when it has any other change. */
export function commitMessageScope(repository: ISCMRepository): 'staged' | 'working-tree' | undefined {
	let working = false;
	for (const group of repository.provider.groups) {
		if (group.resources.length === 0) {
			continue;
		}
		const kind = gitGroupKind(group.id, group.label);
		if (kind === 'staged') {
			return 'staged';
		}
		working ||= kind === 'working';
	}
	return working ? 'working-tree' : undefined;
}

function groupPaths(scm: ISCMService, kind: 'staged' | 'working'): string[] {
	const paths: string[] = [];
	for (const repository of scm.repositories) {
		for (const group of repository.provider.groups) {
			if (gitGroupKind(group.id, group.label) !== kind) {
				continue;
			}
			for (const resource of group.resources) {
				paths.push(resource.sourceUri.fsPath);
			}
		}
	}
	return paths;
}

function gitGroupKind(id: string, label: string): 'staged' | 'working' | 'other' {
	const text = `${id} ${label}`.toLowerCase();
	if (text.includes('index') || text.includes('staged')) {
		return 'staged';
	}
	if (text.includes('untracked') || text.includes('working') || text.includes('change')) {
		return 'working';
	}
	return 'other';
}

function resourceArg(value: unknown): { uri: URI; groupId: string } | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const resource = value as Partial<ISCMResource>;
	if (!URI.isUri(resource.sourceUri) || typeof resource.resourceGroup?.id !== 'string') {
		return undefined;
	}
	return { uri: resource.sourceUri, groupId: resource.resourceGroup.id };
}

function commitArg(value: unknown): { sha: string; subject: string; message: string } | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const item = value as { id?: unknown; subject?: unknown; message?: unknown };
	if (typeof item.id !== 'string' || item.id === SCMIncomingHistoryItemId || item.id === SCMOutgoingHistoryItemId) {
		return undefined;
	}
	if (typeof item.subject !== 'string' || typeof item.message !== 'string') {
		return undefined;
	}
	return { sha: item.id, subject: item.subject, message: item.message };
}

interface BasePick extends IQuickPickItem {
	readonly scope: ClaudeBranchReviewScope;
	readonly base?: string;
}

/**
 * Picks a base (the default branch first) or the staged changes, sends the diff to the
 * review query and shows the findings through the same state as review after commit.
 */
async function reviewBranchAgainstBase(accessor: ServicesAccessor): Promise<void> {
	const git = accessor.get(IClaudeWorktreeService);
	const runtime = accessor.get(IClaudeRuntimeService);
	const state = accessor.get(IClaudeCommitReviewState);
	const notifications = accessor.get(INotificationService);
	const quickInput = accessor.get(IQuickInputService);
	const commands = accessor.get(ICommandService);
	const files = accessor.get(IFileService);
	const languageFeatures = accessor.get(ILanguageFeaturesService);
	const textModels = accessor.get(ITextModelService);
	const log = accessor.get(ILogService);
	const progress = accessor.get(IProgressService);
	const trust = accessor.get(IWorkspaceTrustManagementService);
	const configuration = accessor.get(IConfigurationService);
	const root = accessor.get(IWorkspaceContextService).getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri;
	if (!root || !git.branchReviewBases || !git.branchReviewDiff || !runtime.reviewChanges) {
		notifications.info(localize('claudeBranchReviewUnavailable', "Open a local Git folder to review a branch."));
		return;
	}
	if (!trust.isWorkspaceTrusted()) {
		notifications.info(localize('claudeBranchReviewUntrusted', "Trust this folder to let Claude review its branch."));
		return;
	}
	let bases: string[];
	try {
		bases = await git.branchReviewBases(root.fsPath);
	} catch (error) {
		log.warn('[claude] branch review: no branches', error);
		notifications.warn(localize('claudeBranchReviewNoBranches', "Claude could not list the branches of this folder. Check that this is a Git repository and try again."));
		return;
	}
	const picks: (BasePick | IQuickPickSeparator)[] = bases.map((base, index): BasePick => ({
		label: base,
		description: index === 0 ? localize('claudeBranchReviewDefault', "Default Branch") : undefined,
		scope: 'branch',
		base,
	}));
	picks.push({ type: 'separator' }, { label: localize('claudeBranchReviewStaged', "Staged Changes Only"), description: localize('claudeBranchReviewStagedDesc', "Review only what is staged, not a branch"), scope: 'staged' });
	const pick = await quickInput.pick(picks, { placeHolder: localize('claudeBranchReviewPick', "Review the changes against which branch?") });
	if (!pick) {
		return;
	}
	let raw: string;
	try {
		raw = await git.branchReviewDiff(root.fsPath, pick.scope, pick.base);
	} catch (error) {
		log.warn('[claude] branch review: no diff', error);
		notifications.warn(localize('claudeBranchReviewNoDiff', "Claude could not read the changes to review: {0}", toErrorMessage(error)));
		return;
	}
	if (!raw.trim()) {
		notifications.info(pick.scope === 'staged'
			? localize('claudeBranchReviewNothingStaged', "No changes to review: nothing is staged. Stage some changes and run Review Branch Against Base again.")
			: localize('claudeBranchReviewNothing', "No changes to review: this branch has no changes against {0}. Pick another base branch to compare with.", pick.base ?? ''));
		return;
	}
	const { diff, truncated } = claudeBranchReviewDiff(raw);
	if (truncated) {
		notifications.info(localize('claudeBranchReviewTruncated', "The diff is large: Claude reviews its first part only."));
	}
	const key = claudeBranchReviewKey(pick.scope);
	let notes: string | undefined;
	for (const name of CLAUDE_REVIEW_NOTES_FILES) {
		try {
			notes = (await files.readFile(joinPath(root, name))).value.toString().slice(0, 20_000);
			break;
		} catch {
			// The next name, or none.
		}
	}
	// Issue 926: Quick, Deep or Auto, and say which one runs and why.
	const plan = planClaudeReviewRun(diff, setting => configuration.getValue(setting));
	notifications.status(claudeReviewDepthMessage(plan), { hideAfter: 8000 });
	// Issue 931: where the changed symbols are used outside the diff.
	const context = await gatherClaudeReviewContext({ files, languageFeatures, textModels }, root, diff, readClaudeReviewImpactContext(configuration.getValue(CLAUDE_REVIEW_IMPACT_CONTEXT_SETTING)));
	if (context) {
		notifications.status(context.summary, { hideAfter: 8000 });
	}
	const instructions = claudeReviewInstructionsWithContext(claudeReviewInstructionsWithKnowledge(notes, await readClaudeReviewKnowledge(files, root)), context);
	if (await isClaudeReviewKnowledgeFileStale(files, git, root)) {
		notifications.notify({
			severity: Severity.Info,
			message: localize('claudeKnowledgeStale', "The review knowledge file is out of date: many files changed since it was written."),
			actions: { primary: [toAction({ id: 'claude.review.regenerateKnowledge', label: localize('claudeKnowledgeRegenerate', "Regenerate"), run: () => commands.executeCommand(CLAUDE_GENERATE_REVIEW_KNOWLEDGE_COMMAND_ID) })] },
		});
	}
	state.begin(key);
	const reviewId = `branch-${key}-${Date.now()}`;
	const result = await progress.withProgress({
		location: ProgressLocation.Notification,
		title: localize('claudeBranchReviewProgress', "Claude is reviewing {0}", pick.scope === 'staged' ? localize('claudeBranchReviewProgressStaged', "the staged changes") : localize('claudeBranchReviewProgressBranch', "the changes against {0}", pick.base ?? '')),
		cancellable: true,
	}, () => {
		return runtime.reviewChanges!({
			reviewId,
			sessionId: `branch-${key}`,
			cwd: root.fsPath,
			diff,
			model: plan.model,
			depth: plan.depth,
			maxTurns: plan.maxTurns,
			instructions,
		});
	}, () => void runtime.cancelReview?.(reviewId)).finally(() => state.end());
	if (!result.ok) {
		if (result.failure.kind !== 'cancelled') {
			notifications.warn(result.failure.kind === 'failed' ? localize('claudeBranchReviewFailed', "Claude could not review the branch: {0}", result.failure.message) : localize('claudeBranchReviewMalformed', "Claude's answer could not be read. Try again."));
		}
		return;
	}
	const findings = result.event.findings;
	state.finish(root, key, findings);
	if (findings.length === 0) {
		notifications.status(truncated
			? localize('claudeBranchReviewCleanPartial', "Claude found no findings in the first part of this diff. The rest was not reviewed.")
			: localize('claudeBranchReviewClean', "Claude found no findings in this branch."), { hideAfter: 5000 });
		return;
	}
	const partial = truncated ? localize('claudeBranchReviewPartial', " (first part of the diff only)") : '';
	notifications.prompt(Severity.Info, findings.length === 1
		? localize('claudeBranchReviewOne', "Claude found 1 finding in this branch{0}.", partial)
		: localize('claudeBranchReviewMany', "Claude found {0} findings in this branch{1}.", findings.length, partial), [{
			label: localize('claudeBranchReviewShow', "Show Problems"),
			run: () => commands.executeCommand('workbench.actions.view.problems'),
		}, {
			label: localize('claudeBranchReviewFixAll', "Fix All with Agent"),
			run: () => commands.executeCommand(CLAUDE_COMMIT_REVIEW_FIX_ALL_COMMAND_ID),
		}]);
}
