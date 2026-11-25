/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClaudeWorktreeService, pathsInDiff } from '../../../../platform/claude/common/claudeBackground.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { filterClaudeReviewFindings, readClaudeReviewSettings } from '../../../../platform/claude/common/claudeReviewLoop.js';
import { planClaudeReviewRun } from '../../../../platform/claude/common/claudeReviewDepth.js';
import { CLAUDE_REVIEW_AFTER_COMMIT_SETTING, CLAUDE_REVIEW_NOTES_FILES, claudeCommitReviewDiff, claudeDiffWithoutIgnored, claudeShortSha, lastClaudeReflogCommit, readClaudeReviewAfterCommit } from '../../../../platform/claude/common/claudeCommitReview.js';
import { claudeReviewInstructionsWithKnowledge } from '../../../../platform/claude/common/claudeReviewKnowledge.js';
import { readClaudeReviewKnowledge } from './claudeReviewKnowledgeReader.js';
import { gatherClaudeReviewContext } from './claudeReviewContextGatherer.js';
import { CLAUDE_REVIEW_IMPACT_CONTEXT_SETTING, claudeReviewInstructionsWithContext, readClaudeReviewImpactContext } from '../../../../platform/claude/common/claudeReviewContext.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { CLAUDE_REVIEW_CONFIG_FILE_SETTING, ClaudeReviewConfigLayer, claudeReviewInstructionsWithRules, filterClaudeFindingsByConfig, readClaudeReviewConfigFile, readClaudeReviewConfigLayers, resolveClaudeReviewConfig, resolveClaudeReviewConfigForFile } from '../../../../platform/claude/common/claudeReviewConfig.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IClaudeCommitReviewState } from './claudeCommitReviewState.js';
import { CLAUDE_COMMIT_REVIEW_FIX_ALL_COMMAND_ID } from './claudeCommitReviewStatus.js';

/** Changes to the reflog that come close together are read once. */
const REFLOG_DELAY_MS = 1000;

/**
 * Review after each commit (issue 502). It watches the first folder's
 * `.git/logs/HEAD`; when its last line records a new commit, and the setting is
 * Quick or Deep in a trusted workspace, the commit's patch goes to Claude's
 * read-only review pass (with REVIEW.md as notes) and the findings replace the
 * last review's in the Problems panel, the inline threads and the status bar item (issue 876). Checkouts, resets and rebase steps do not count.
 */
export class ClaudeCommitReview extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeCommitReview';

	private readonly _check = this._register(new RunOnceScheduler(() => void this.check(), REFLOG_DELAY_MS));
	/** The commit the reflog ended on when last read: it is never reviewed twice. */
	private _seen: string | undefined;
	private _root: URI | undefined;

	constructor(
		@IFileService private readonly _files: IFileService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IWorkspaceTrustManagementService private readonly _trust: IWorkspaceTrustManagementService,
		@IClaudeWorktreeService private readonly _git: IClaudeWorktreeService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IClaudeCommitReviewState private readonly _state: IClaudeCommitReviewState,
		@INotificationService private readonly _notifications: INotificationService,
		@ICommandService private readonly _commands: ICommandService,
		@ILogService private readonly _log: ILogService,
		@ILanguageFeaturesService private readonly _languageFeatures: ILanguageFeaturesService,
		@ITextModelService private readonly _textModels: ITextModelService,
	) {
		super();
		this._root = workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri;
		if (!this._root) {
			return;
		}
		const reflog = this.reflog();
		const watcher = this._register(this._files.createWatcher(reflog, { recursive: false, excludes: [] }));
		this._register(watcher.onDidChange(() => this._check.schedule()));
		// Retry Commit Review (issue 1046): look at the last commit again, as if it were new.
		this._register(this._state.onDidRequestRetry(() => {
			this._seen = undefined;
			void this.check();
		}));
		// What the reflog says now is the starting point: only commits made from here on are reviewed.
		void this.lastCommit().then(commit => this._seen ??= commit?.sha ?? '');
	}

	/** Reads the reflog now (tests call it; the watcher schedules it). */
	async check(): Promise<void> {
		const root = this._root;
		const commit = await this.lastCommit();
		if (!root || !commit || commit.sha === this._seen) {
			return;
		}
		this._seen = commit.sha;
		const mode = readClaudeReviewAfterCommit(this._configuration.getValue(CLAUDE_REVIEW_AFTER_COMMIT_SETTING));
		if (mode === 'off' || !this._trust.isWorkspaceTrusted() || !this._git.commitDiff || !this._runtime.reviewChanges) {
			return;
		}
		const short = claudeShortSha(commit.sha);
		// Issue 927: after a review, the next one sees only what changed since it; the
		// commit's own patch is the fallback when the reviewed commit is gone.
		const since = this._state.reviewedSha !== commit.sha ? this._state.reviewedSha : undefined;
		let diff: string | undefined;
		let incremental = false;
		if (since && this._git.rangeDiff) {
			try {
				diff = await this._git.rangeDiff(root.fsPath, since, commit.sha);
				incremental = true;
			} catch (error) {
				this._log.info(`[claude] commit review: no diff since ${claudeShortSha(since)}, reviewing ${short} alone`, error);
			}
		}
		try {
			diff ??= await this._git.commitDiff(root.fsPath, commit.sha);
		} catch (error) {
			this._log.warn(`[claude] commit review: no diff for ${short}`, error);
			return;
		}
		// The whole diff, ignored files included, is what moved the earlier findings.
		const fullDiff = diff;
		// Issue 922: .claude/review.json ignores files, adds scoped rules and turns rules off.
		const layers = await this.configLayers(root, pathsInDiff(diff));
		diff = claudeDiffWithoutIgnored(diff, path => resolveClaudeReviewConfigForFile(layers, path).ignored);
		if (!diff.trim()) {
			return;
		}
		const resolved = resolveClaudeReviewConfig(layers, pathsInDiff(diff));
		this._state.begin(commit.sha);
		const settings = readClaudeReviewSettings(key => this._configuration.getValue(key));
		const reviewDiff = claudeCommitReviewDiff(diff);
		// Issue 926: the after-commit setting is this review's depth; the model and turns come from the review settings.
		const plan = planClaudeReviewRun(reviewDiff, key => this._configuration.getValue(key), { forced: mode });
		// Issue 931: where the changed symbols are used outside the diff.
		const context = await gatherClaudeReviewContext({ files: this._files, languageFeatures: this._languageFeatures, textModels: this._textModels }, root, reviewDiff, readClaudeReviewImpactContext(this._configuration.getValue(CLAUDE_REVIEW_IMPACT_CONTEXT_SETTING)));
		const result = await this._runtime.reviewChanges({
			reviewId: `commit-${commit.sha}`,
			sessionId: `commit-${commit.sha}`,
			cwd: root.fsPath,
			diff: reviewDiff,
			model: plan.model,
			depth: plan.depth,
			maxTurns: plan.maxTurns,
			instructions: claudeReviewInstructionsWithContext(claudeReviewInstructionsWithKnowledge(claudeReviewInstructionsWithRules(await this.notes(root), resolved), await readClaudeReviewKnowledge(this._files, root)), context),
			strictness: settings.strictness,
			categories: settings.categories,
		}).finally(() => this._state.end());
		if (!result.ok) {
			if (result.failure.kind !== 'cancelled') {
				const reason = result.failure.kind === 'failed' ? result.failure.message : localize('claudeCommitReviewMalformed', "its answer had no findings list");
				this._state.fail(commit.sha, reason);
				this._notifications.warn(localize('claudeCommitReviewFailed', "Claude couldn't review {0}: {1}", short, reason));
			}
			return;
		}
		const findings = filterClaudeFindingsByConfig(filterClaudeReviewFindings(result.event.findings, settings), resolved);
		this._state.finish(root, commit.sha, findings, incremental ? fullDiff : undefined);
		if (findings.length === 0) {
			this._notifications.status(localize('claudeCommitReviewClean', "Claude found nothing in {0}.", short), { hideAfter: 5000 });
			return;
		}
		this._notifications.prompt(Severity.Info, findings.length === 1
			? localize('claudeCommitReviewOne', "Claude found 1 thing to look at in {0}.", short)
			: localize('claudeCommitReviewMany', "Claude found {0} things to look at in {1}.", findings.length, short), [{
				label: localize('claudeCommitReviewShow', "Show Problems"),
				run: () => this._commands.executeCommand('workbench.actions.view.problems'),
			}, {
				label: localize('claudeCommitReviewFixAll', "Fix All with Agent"),
				run: () => this._commands.executeCommand(CLAUDE_COMMIT_REVIEW_FIX_ALL_COMMAND_ID),
			}]);
	}

	private reflog(): URI {
		return joinPath(this._root!, '.git', 'logs', 'HEAD');
	}

	private async lastCommit(): Promise<{ readonly sha: string; readonly message: string } | undefined> {
		if (!this._root) {
			return undefined;
		}
		try {
			return lastClaudeReflogCommit((await this._files.readFile(this.reflog())).value.toString());
		} catch {
			return undefined;
		}
	}

	/** The review config files from the root down to each changed file's folder. */
	private configLayers(root: URI, files: readonly string[]): Promise<ClaudeReviewConfigLayer[]> {
		return readClaudeReviewConfigLayers(files, readClaudeReviewConfigFile(this._configuration.getValue(CLAUDE_REVIEW_CONFIG_FILE_SETTING)), async path => {
			try {
				return (await this._files.readFile(joinPath(root, ...path.split('/')))).value.toString();
			} catch {
				return undefined;
			}
		});
	}

	private async notes(root: URI): Promise<string | undefined> {
		for (const name of CLAUDE_REVIEW_NOTES_FILES) {
			try {
				return (await this._files.readFile(joinPath(root, name))).value.toString().slice(0, 20_000);
			} catch {
				// The next name, or none.
			}
		}
		return undefined;
	}
}
