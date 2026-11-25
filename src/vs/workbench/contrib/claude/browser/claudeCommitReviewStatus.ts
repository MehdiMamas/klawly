/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CLAUDE_REVIEW_FIX_SENDS_SETTING, claudeCommitFixDraft, claudeShortSha } from '../../../../platform/claude/common/claudeCommitReview.js';
import { claudeReviewStatusDescription } from '../../../../platform/claude/common/claudeAutomationGitHub.js';
import { claudeLineReference, ClaudeReviewSeverity, readClaudeReviewSettings } from '../../../../platform/claude/common/claudeReviewLoop.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { CLAUDE_AGENT_VIEW_ID, KLAWLY_CATEGORY } from '../common/claudeViews.js';
import { ClaudeCommitFinding, IClaudeCommitReviewState } from './claudeCommitReviewState.js';

export const CLAUDE_COMMIT_REVIEW_ENTRY_ID = 'claude.commitReview';
export const CLAUDE_COMMIT_REVIEW_SHOW_COMMAND_ID = 'claude.commitReview.show';
export const CLAUDE_COMMIT_REVIEW_FIX_ALL_COMMAND_ID = 'claude.commitReview.fixAll';
export const CLAUDE_COMMIT_REVIEW_DISMISS_ALL_COMMAND_ID = 'claude.commitReview.dismissAll';
export const CLAUDE_COMMIT_REVIEW_RETRY_COMMAND_ID = 'claude.commitReview.retry';
export const CLAUDE_COMMIT_REVIEW_HIDE_COMMAND_ID = 'claude.commitReview.hide';
export const CLAUDE_COMMIT_REVIEW_REVIEW_ALL_COMMAND_ID = 'claude.commitReview.reviewAll';

/**
 * Opens a new chat with `findings` written into its composer, and shows it.
 * Nothing is sent: the user reads the draft and sends it, so the chat's own
 * permission mode and approval cards decide what runs (issue 876, DL-93).
 * With `send` (the user turned on Send Review Fixes at Once, issue 960) the
 * draft is submitted in `send.cwd` right away; the same permission mode and
 * approval cards still decide what runs.
 */
export async function draftClaudeCommitFix(agent: IClaudeAgentService, views: IViewsService, sha: string, findings: readonly ClaudeCommitFinding[], send?: { readonly cwd: string }): Promise<void> {
	if (findings.length === 0) {
		return;
	}
	const draft = claudeCommitFixDraft(sha, findings.map(item => item.finding));
	const session = agent.createSession(send ? undefined : { draft });
	agent.selectSession(session.id);
	await views.openView(CLAUDE_AGENT_VIEW_ID, true);
	if (send) {
		await agent.submit(session.id, draft, send.cwd);
	}
}

/** Whether a fix is sent at once, and in which folder: the setting is on and the review has a folder. Exported for tests. */
export function claudeCommitFixSend(enabled: unknown, root: URI | undefined): { readonly cwd: string } | undefined {
	return enabled === true && root ? { cwd: root.fsPath } : undefined;
}

/**
 * The status bar item of review after commit: a spinner while a commit is
 * reviewed, then the count of findings left until they are all dismissed.
 * Undefined hides it. Exported for tests.
 */
/**
 * The states the pull request status "Klawly review" has (issue 928), for a
 * local review: `failed` is the error, `clean` the success, `summary` the
 * description the status would carry.
 */
export interface ClaudeCommitReviewOutcome {
	readonly failed?: string;
	/** Why it failed, when known (issue 1046). */
	readonly reason?: string;
	readonly clean?: boolean;
	readonly summary?: string;
	/** Findings later commits addressed, out of those not dismissed (issue 927). */
	readonly progress?: { readonly addressed: number; readonly total: number };
}

export function claudeCommitReviewEntry(reviewing: string | undefined, sha: string | undefined, count: number, outcome: ClaudeCommitReviewOutcome = {}): IStatusbarEntry | undefined {
	const name = localize('claudeCommitReviewEntryName', "Claude Commit Review");
	if (reviewing) {
		const text = localize('claudeCommitReviewEntryReviewing', "Reviewing {0}", reviewing);
		return {
			name,
			text: `$(loading~spin) ${text}`,
			ariaLabel: text,
			tooltip: localize('claudeCommitReviewEntryReviewingTooltip', "Claude is reviewing commit {0}. Its findings show here, in the Problems panel and on the lines they are about.", reviewing),
			command: count > 0 ? CLAUDE_COMMIT_REVIEW_SHOW_COMMAND_ID : undefined,
		};
	}
	if (outcome.failed) {
		const text = localize('claudeCommitReviewEntryFailed', "Review of {0} failed", outcome.failed);
		return {
			name,
			text: `$(error) ${text}`,
			ariaLabel: text,
			tooltip: outcome.reason
				? localize('claudeCommitReviewEntryFailedReasonTooltip', "Claude couldn't review commit {0}: {1}. Click to try again; the next commit also tries again.", outcome.failed, outcome.reason)
				// Without a reason the likeliest cause is the sign-in (issue 1079).
				: localize('claudeCommitReviewEntryFailedTooltip', "Claude couldn't review commit {0}. Check the Claude sign-in. Click to try again; the next commit also tries again.", outcome.failed),
			kind: 'error',
			role: 'button',
			command: CLAUDE_COMMIT_REVIEW_RETRY_COMMAND_ID,
		};
	}
	if (sha && count === 0 && outcome.clean) {
		const short = claudeShortSha(sha);
		const text = localize('claudeCommitReviewEntryClean', "No findings in {0}", short);
		return {
			name,
			text: `$(check) ${text}`,
			ariaLabel: text,
			tooltip: `${outcome.summary ?? text}. ${localize('claudeCommitReviewEntryCleanHide', "Click to hide this.")}`,
			role: 'button',
			command: CLAUDE_COMMIT_REVIEW_HIDE_COMMAND_ID,
		};
	}
	if (!sha || count === 0) {
		return undefined;
	}
	const short = claudeShortSha(sha);
	const progress = outcome.progress;
	// Issue 927, DL-99: once a later commit addressed some, the item says how far the review has come.
	const text = progress && progress.addressed > 0
		? localize('claudeCommitReviewEntryProgress', "{0} open, {1}/{2} addressed", count, progress.addressed, progress.total)
		: count === 1
			? localize('claudeCommitReviewEntryOne', "1 finding in {0}", short)
			: localize('claudeCommitReviewEntryMany', "{0} findings in {1}", count, short);
	return {
		name,
		text: `$(comment-discussion) ${text}`,
		ariaLabel: text,
		tooltip: outcome.summary
			? localize('claudeCommitReviewEntrySummaryTooltip', "Claude's review, up to commit {0}: {1}. Show the findings, then Fix All with Agent or Dismiss All.", short, outcome.summary)
			: localize('claudeCommitReviewEntryTooltip', "Claude's review, up to commit {0}. Show the findings, then Fix All with Agent or Dismiss All.", short),
		role: 'button',
		command: CLAUDE_COMMIT_REVIEW_SHOW_COMMAND_ID,
	};
}

/** What one row of the status bar item's menu does. */
export type ClaudeCommitReviewMenuAction =
	| { readonly kind: 'finding'; readonly id: string }
	| { readonly kind: 'fix-all' }
	| { readonly kind: 'problems' }
	| { readonly kind: 'dismiss-all' }
	| { readonly kind: 'review-all' }
	| { readonly kind: 'settings' };

/** One row of the status bar item's menu. */
export interface ClaudeCommitReviewPick extends IQuickPickItem {
	readonly action: ClaudeCommitReviewMenuAction;
}

function severityIcon(severity: ClaudeReviewSeverity): string {
	return severity === 'critical' || severity === 'high' ? '$(error)' : severity === 'medium' ? '$(warning)' : '$(info)';
}

/** The menu: the findings worst first (each opens its lines), then the actions on all of them. Exported for tests. */
export function claudeCommitReviewMenu(sha: string, findings: readonly ClaudeCommitFinding[], progress?: { readonly addressed: number; readonly total: number }): (ClaudeCommitReviewPick | IQuickPickSeparator)[] {
	const fixAll = localize('claudeCommitReviewMenuFixAll', "Fix All with Agent");
	const problems = localize('claudeCommitReviewMenuProblems', "Show Problems");
	const dismissAll = localize('claudeCommitReviewMenuDismissAll', "Dismiss All");
	const reviewAll = localize('claudeCommitReviewMenuReviewAll', "Review Everything Again");
	const settings = localize('claudeCommitReviewMenuSettings', "Open Review Settings");
	const short = claudeShortSha(sha);
	return [
		{
			type: 'separator',
			label: progress && progress.addressed > 0
				? localize('claudeCommitReviewMenuFindingsProgress', "Reviewed up to {0}, {1}/{2} addressed", short, progress.addressed, progress.total)
				: localize('claudeCommitReviewMenuFindings', "Findings in {0}", short),
		},
		...findings.map((item): ClaudeCommitReviewPick => ({
			label: `${severityIcon(item.finding.severity)} ${item.finding.title}`,
			description: claudeLineReference(item.finding.file, item.finding.startLine, item.finding.endLine),
			detail: item.finding.body || undefined,
			ariaLabel: item.finding.title,
			action: { kind: 'finding', id: item.id },
		})),
		{ type: 'separator' },
		{ label: `$(sparkle) ${fixAll}`, ariaLabel: fixAll, action: { kind: 'fix-all' } },
		{ label: `$(warning) ${problems}`, ariaLabel: problems, action: { kind: 'problems' } },
		{ label: `$(close-all) ${dismissAll}`, ariaLabel: dismissAll, action: { kind: 'dismiss-all' } },
		{
			label: `$(refresh) ${reviewAll}`,
			description: localize('claudeCommitReviewMenuReviewAllHint', "Forget what was reviewed and look at the last commit from scratch"),
			ariaLabel: reviewAll,
			action: { kind: 'review-all' },
		},
		{ type: 'separator' },
		{
			label: `$(settings-gear) ${settings}`,
			description: localize('claudeCommitReviewMenuSettingsHint', "Review after commit, and whether Fix All sends at once or only drafts"),
			ariaLabel: settings,
			action: { kind: 'settings' },
		},
	];
}

/** Shows {@link claudeCommitReviewEntry} on the right of the status bar, next to Claude's own item (DL-93). */
export class ClaudeCommitReviewStatusBar extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeCommitReviewStatus';

	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly _statusbar: IStatusbarService,
		@IClaudeCommitReviewState private readonly _state: IClaudeCommitReviewState,
		@IConfigurationService private readonly _configuration: IConfigurationService,
	) {
		super();
		this._register(this._state.onDidChange(() => this.update()));
		this.update();
	}

	private update(): void {
		const threshold = readClaudeReviewSettings(key => this._configuration.getValue(key)).minSeverity;
		const findings = this._state.findings;
		const summary = claudeReviewStatusDescription(findings.map(item => item.finding), threshold).description;
		const entry = claudeCommitReviewEntry(this._state.reviewing, this._state.result?.sha, findings.length, { failed: this._state.failed, reason: this._state.failedReason, clean: this._state.result?.total === 0, summary, progress: this._state.result?.progress });
		if (!entry) {
			this._entry.clear();
		} else if (this._entry.value) {
			this._entry.value.update(entry);
		} else {
			this._entry.value = this._statusbar.addEntry(entry, CLAUDE_COMMIT_REVIEW_ENTRY_ID, StatusbarAlignment.RIGHT, 99);
		}
	}
}

/** Registers Show Commit Review Findings, Commit Review: Fix All with Agent and Commit Review: Dismiss All (the menu says Fix All with Agent and Dismiss All). */
export function registerClaudeCommitReviewCommands(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_COMMIT_REVIEW_SHOW_COMMAND_ID,
				title: localize2('claudeCommitReviewShowFindings', "Show Commit Review Findings"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const state = accessor.get(IClaudeCommitReviewState);
			const quickInput = accessor.get(IQuickInputService);
			const editors = accessor.get(IEditorService);
			const commands = accessor.get(ICommandService);
			const agent = accessor.get(IClaudeAgentService);
			const views = accessor.get(IViewsService);
			const configuration = accessor.get(IConfigurationService);
			const result = state.result;
			const findings = state.findings;
			if (!result || findings.length === 0) {
				await quickInput.pick([], {
					placeHolder: state.reviewing
						? localize('claudeCommitReviewMenuReviewing', "Claude is reviewing {0}", state.reviewing)
						: localize('claudeCommitReviewMenuNone', "No commit review findings"),
				});
				return;
			}
			const picked = await quickInput.pick<ClaudeCommitReviewPick>(claudeCommitReviewMenu(result.sha, findings, result.progress), {
				placeHolder: localize('claudeCommitReviewMenuPlaceholder', "Pick a finding to open its lines, or an action"),
				matchOnDescription: true,
			});
			const action = picked?.action;
			switch (action?.kind) {
				case 'finding': {
					const item = findings.find(candidate => candidate.id === action.id);
					if (item) {
						await editors.openEditor({ resource: item.uri, options: { selection: { startLineNumber: item.finding.startLine, startColumn: 1 }, revealIfOpened: true } });
					}
					break;
				}
				case 'fix-all':
					await draftClaudeCommitFix(agent, views, result.sha, findings, claudeCommitFixSend(configuration.getValue(CLAUDE_REVIEW_FIX_SENDS_SETTING), result.root));
					break;
				case 'problems':
					await commands.executeCommand('workbench.actions.view.problems');
					break;
				case 'dismiss-all':
					state.dismissAll();
					break;
				case 'review-all':
					state.reviewAll();
					break;
				case 'settings':
					// Both commit review settings start with this prefix, so the editor lists the two together.
					await commands.executeCommand('workbench.action.openSettings', 'claude.git.review');
					break;
			}
		}
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_COMMIT_REVIEW_FIX_ALL_COMMAND_ID,
				title: localize2('claudeCommitReviewFixAll', "Commit Review: Fix All with Agent"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const state = accessor.get(IClaudeCommitReviewState);
			if (state.result) {
				await draftClaudeCommitFix(accessor.get(IClaudeAgentService), accessor.get(IViewsService), state.result.sha, state.findings, claudeCommitFixSend(accessor.get(IConfigurationService).getValue(CLAUDE_REVIEW_FIX_SENDS_SETTING), state.result.root));
			}
		}
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_COMMIT_REVIEW_RETRY_COMMAND_ID,
				title: localize2('claudeCommitReviewRetry', "Retry Commit Review"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		run(accessor: ServicesAccessor): void {
			accessor.get(IClaudeCommitReviewState).retry();
		}
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_COMMIT_REVIEW_HIDE_COMMAND_ID,
				title: localize2('claudeCommitReviewHide', "Hide Commit Review Status"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		run(accessor: ServicesAccessor): void {
			accessor.get(IClaudeCommitReviewState).hideOutcome();
			// Nothing is left to click once it is hidden: say how to bring it back (issue 1079).
			accessor.get(INotificationService).info(localize('claudeCommitReviewHidden', "Commit review status hidden. Run \"Show Commit Review Findings\" from the Command Palette to see it again."));
		}
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_COMMIT_REVIEW_DISMISS_ALL_COMMAND_ID,
				title: localize2('claudeCommitReviewDismissAll', "Commit Review: Dismiss All"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		run(accessor: ServicesAccessor): void {
			accessor.get(IClaudeCommitReviewState).dismissAll();
		}
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_COMMIT_REVIEW_REVIEW_ALL_COMMAND_ID,
				title: localize2('claudeCommitReviewReviewAll', "Commit Review: Review Everything Again"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		run(accessor: ServicesAccessor): void {
			accessor.get(IClaudeCommitReviewState).reviewAll();
		}
	});
}
