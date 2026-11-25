/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ClaudeComparisonRunView, ClaudeComparisonView, isClaudeComparisonSettled } from '../../../../platform/claude/common/claudeComparison.js';
import { ClaudeComparisonRanking, ClaudeComparisonRunState } from '../../../../platform/claude/common/claudeProtocol.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IEditorOpenContext, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { IClaudeBackgroundAgentService } from '../../../services/claude/common/claudeBackgroundAgent.js';
import { IClaudeComparisonService } from '../../../services/claude/common/claudeComparison.js';
import { formatElapsed } from '../../../services/claude/common/claudeToolCards.js';
import { CLAUDE_AGENT_VIEW_ID } from '../../claude/common/claudeViews.js';
import '../../claude/browser/media/claude.css';
import './media/claudeComparison.css';

/** How much of a run's last answer a column shows; Open as Chat has the rest. */
const ANSWER_LIMIT = 600;

/** A comparison opened as an editor tab. The input holds only the comparison id. */
export class ClaudeComparisonInput extends EditorInput {

	static readonly ID = 'workbench.input.klawlyComparison';

	constructor(
		readonly comparisonId: string,
		@IClaudeComparisonService private readonly _comparisons: IClaudeComparisonService,
	) {
		super();
		// The tab is named after the prompt, which a reload reads back later.
		this._register(this._comparisons.onDidChangeComparisons(() => this._onDidChangeLabel.fire()));
	}

	override get typeId(): string {
		return ClaudeComparisonInput.ID;
	}

	override get editorId(): string | undefined {
		return ClaudeComparisonEditor.ID;
	}

	override get resource(): undefined {
		return undefined;
	}

	/** The page has its own header, so the group shows no breadcrumbs row over it. */
	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.HideBreadcrumbs;
	}

	override getName(): string {
		const prompt = this._comparisons.getComparison(this.comparisonId)?.prompt.split('\n')[0].trim();
		return prompt ? localize('claudeComparisonTab', "Compare: {0}", prompt) : localize('claudeComparisonTabEmpty', "Compare Models");
	}

	override getIcon(): ThemeIcon {
		return Codicon.diffMultiple;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof ClaudeComparisonInput && other.comparisonId === this.comparisonId;
	}
}

/** The state word and icon of a run, in the Background Agents vocabulary (DL-11). */
function runStatus(state: ClaudeComparisonRunState): { readonly label: string; readonly icon: ThemeIcon; readonly tone?: 'success' | 'error' } {
	switch (state) {
		case 'starting': return { label: localize('claudeCompareStarting', "Starting"), icon: ThemeIcon.modify(Codicon.loading, 'spin') };
		case 'running': return { label: localize('claudeCompareRunning', "Running"), icon: ThemeIcon.modify(Codicon.loading, 'spin') };
		case 'waiting': return { label: localize('claudeCompareWaiting', "Waiting for Permission"), icon: Codicon.shield };
		case 'complete': return { label: localize('claudeCompareComplete', "Done"), icon: Codicon.pass, tone: 'success' };
		case 'failed': return { label: localize('claudeCompareFailed', "Failed"), icon: Codicon.error, tone: 'error' };
		case 'kept': return { label: localize('claudeCompareKept', "Kept"), icon: Codicon.gitMerge, tone: 'success' };
		case 'discarded': return { label: localize('claudeCompareDiscarded', "Discarded"), icon: Codicon.trash };
	}
}

/**
 * The Compare editor (issue 424): one column per run with its model and
 * effort, status, diff summary, cost, time and last answer. A judge's ranking
 * orders the columns and gives each its score and reasons. Keep applies one
 * run and deletes the others; Discard All deletes every run. Both ask first.
 */
export class ClaudeComparisonEditor extends EditorPane {

	static readonly ID = 'workbench.editor.klawlyComparison';

	private _header!: HTMLElement;
	private _title!: HTMLElement;
	private _summary!: HTMLElement;
	private _discard!: HTMLButtonElement;
	private _columns!: HTMLElement;
	private _scrollable!: DomScrollableElement;
	/** The first action of the first column, where focus lands. */
	private _firstAction: HTMLButtonElement | undefined;
	private readonly _inputStore = this._register(new DisposableStore());
	private readonly _renderStore = this._register(new DisposableStore());
	/** Streaming changes the view state many times a second; the columns follow at most every 100 ms. */
	private readonly _renderSoon = this._register(new RunOnceScheduler(() => this.render(), 100));

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IClaudeComparisonService private readonly _comparisons: IClaudeComparisonService,
		@IClaudeBackgroundAgentService private readonly _background: IClaudeBackgroundAgentService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IViewsService private readonly _views: IViewsService,
	) {
		super(ClaudeComparisonEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		const root = append(parent, $('.claude-root.claude-compare-editor'));
		this._header = append(root, $('.claude-compare-header'));
		const heading = append(this._header, $('.claude-compare-heading'));
		this._title = append(heading, $('.claude-compare-title'));
		this._summary = append(heading, $('.claude-compare-summary'));
		this._discard = append(this._header, $<HTMLButtonElement>('button.claude-btn.is-small.claude-compare-discard'));
		this._discard.type = 'button';
		this._discard.textContent = localize('claudeCompareDiscardAll', "Discard All");
		this._register(addDisposableListener(this._discard, EventType.CLICK, () => {
			const id = this.comparisonId;
			if (id) {
				void this._comparisons.discard(id);
			}
		}));

		const body = $('.claude-compare-body');
		this._columns = append(body, $('.claude-compare-columns'));
		this._scrollable = this._register(new DomScrollableElement(body, {
			horizontal: ScrollbarVisibility.Auto,
			vertical: ScrollbarVisibility.Auto,
		}));
		append(root, this._scrollable.getDomNode());
	}

	override async setInput(input: ClaudeComparisonInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this._inputStore.clear();
		this._inputStore.add(this._comparisons.onDidChangeComparisons(() => this._renderSoon.schedule()));
		this._inputStore.add(this._background.onDidChangeTasks(() => this._renderSoon.schedule()));
		this._inputStore.add(this._agent.onDidChangeViewState(event => {
			if (this._comparisons.getComparison(input.comparisonId)?.runs.some(run => run.sessionId === event.sessionId)) {
				this._renderSoon.schedule();
			}
		}));
		this.render();
	}

	override clearInput(): void {
		this._inputStore.clear();
		this._renderSoon.cancel();
		this._renderStore.clear();
		clearNode(this._columns);
		super.clearInput();
	}

	override focus(): void {
		super.focus();
		this._firstAction?.focus();
	}

	override layout(dimension: Dimension): void {
		const headerHeight = this._header.offsetHeight;
		this._scrollable.getDomNode().style.height = `${Math.max(0, dimension.height - headerHeight)}px`;
		this._scrollable.getDomNode().style.width = `${dimension.width}px`;
		this._scrollable.scanDomNode();
	}

	private get comparisonId(): string | undefined {
		return this.input instanceof ClaudeComparisonInput ? this.input.comparisonId : undefined;
	}

	private render(): void {
		this._renderStore.clear();
		clearNode(this._columns);
		this._firstAction = undefined;
		const id = this.comparisonId;
		const view = id ? this._comparisons.getComparison(id) : undefined;
		if (!id || !view) {
			this._title.textContent = localize('claudeCompareMissingTitle', "Compare Models");
			this._summary.classList.remove('is-judging');
			this._summary.textContent = localize('claudeCompareMissing', "This comparison is no longer available.");
			this._discard.hidden = true;
			this._scrollable.scanDomNode();
			return;
		}
		this._title.textContent = view.prompt;
		this._title.title = view.prompt;
		this.renderSummary(id, view);
		// DL-12: Discard All shows only while a run still has a worktree to delete.
		this._discard.hidden = !view.runs.some(run => !!this._comparisons.getRunTask(id, run.run));

		const ranking = view.verdict?.ranking;
		const ordered = ranking ? ranking.map(entry => ({ run: view.runs[entry.run - 1], entry })) : view.runs.map(run => ({ run, entry: undefined }));
		ordered.forEach(({ run, entry }, index) => this.renderRun(id, run, entry, ranking ? index + 1 : undefined));
		this._scrollable.scanDomNode();
	}

	private renderSummary(comparisonId: string, view: ClaudeComparisonView): void {
		const judging = !view.verdict && !view.judgeError && this._comparisons.isJudging(comparisonId);
		this._summary.classList.toggle('is-judging', judging);
		if (judging) {
			// DL-11: the judge's state in words, with the spinning icon a running run's status line uses.
			this._summary.textContent = '';
			append(this._summary, $(`span${ThemeIcon.asCSSSelector(ThemeIcon.modify(Codicon.loading, 'spin'))}`));
			append(this._summary, $('span.label')).textContent = localize('claudeCompareJudging', "Judging...");
			return;
		}
		this._summary.textContent = this.summary(view);
	}

	private summary(view: ClaudeComparisonView): string {
		if (view.verdict) {
			return view.verdict.summary;
		}
		if (view.judgeError) {
			return localize('claudeCompareJudgeFailed', "The judge could not rank the runs: {0}", view.judgeError);
		}
		if (!isClaudeComparisonSettled(view)) {
			const ended = view.runs.filter(run => run.state !== 'starting' && run.state !== 'running' && run.state !== 'waiting').length;
			return localize('claudeCompareProgress', "{0} of {1} runs ended.", ended, view.runs.length);
		}
		return localize('claudeCompareEnded', "Every run ended. Review the changes, then keep one.");
	}

	private renderRun(comparisonId: string, run: ClaudeComparisonRunView, entry: ClaudeComparisonRanking | undefined, rank: number | undefined): void {
		const column = append(this._columns, $('.claude-compare-run'));
		column.setAttribute('role', 'group');
		column.setAttribute('aria-label', run.label);
		column.dataset.run = String(run.run);
		if (rank === 1) {
			column.classList.add('is-top');
		}

		const head = append(column, $('.claude-compare-run-head'));
		append(head, $('span.claude-compare-model')).textContent = run.label;
		if (rank !== undefined && entry) {
			append(head, $('span.claude-compare-rank')).textContent = localize('claudeCompareRank', "Rank {0}", rank);
			append(head, $('span.claude-compare-score')).textContent = localize('claudeCompareScore', "{0}/10", entry.score);
		}

		const status = runStatus(run.state);
		const statusLine = append(column, $('.claude-compare-status'));
		if (status.tone) {
			statusLine.classList.add(`is-${status.tone}`);
		}
		append(statusLine, $(`span${ThemeIcon.asCSSSelector(status.icon)}`));
		append(statusLine, $('span.label')).textContent = status.label;

		// DL-12: each fact shows only once it is known.
		const facts: string[] = [];
		if (run.diffStat) {
			facts.push(run.diffStat.filesChanged === 1
				? localize('claudeCompareDiffStatOne', "1 file, +{0} -{1}", run.diffStat.added, run.diffStat.removed)
				: localize('claudeCompareDiffStat', "{0} files, +{1} -{2}", run.diffStat.filesChanged, run.diffStat.added, run.diffStat.removed));
		}
		if (run.costUsd !== undefined) {
			facts.push(localize('claudeCompareCost', "${0}", run.costUsd.toFixed(2)));
		}
		if (run.durationMs !== undefined) {
			facts.push(formatElapsed(0, run.durationMs, run.durationMs));
		}
		if (facts.length) {
			const stats = append(column, $('.claude-compare-stats'));
			for (const fact of facts) {
				append(stats, $('span')).textContent = fact;
			}
		}
		if (run.message) {
			append(column, $('.claude-compare-message')).textContent = run.message;
		}
		if (entry?.reasons) {
			const reasons = append(column, $('.claude-compare-reasons'));
			append(reasons, $('.claude-compare-label')).textContent = localize('claudeCompareJudgeSays', "Judge");
			append(reasons, $('p')).textContent = entry.reasons;
		}
		const answer = this.lastAnswer(run.sessionId);
		if (answer) {
			const block = append(column, $('.claude-compare-answer'));
			append(block, $('.claude-compare-label')).textContent = localize('claudeCompareLastMessage', "Last Message");
			append(block, $('p')).textContent = answer;
		}

		const actions = append(column, $('.claude-compare-actions'));
		const task = this._comparisons.getRunTask(comparisonId, run.run);
		if (task && run.state === 'complete') {
			// DL-09: only the judge's first pick wears the accent.
			this.button(actions, localize('claudeCompareKeep', "Keep"), rank === 1, () => void this._comparisons.keep(comparisonId, run.run));
		}
		if (task && run.state !== 'starting') {
			this.button(actions, localize('claudeCompareReview', "Review Changes"), false, () => void this._background.review(task.id));
		}
		const sessionId = run.sessionId;
		if (sessionId) {
			this.button(actions, localize('claudeCompareOpenChat', "Open as Chat"), false, () => void this.openAsChat(sessionId));
		}
	}

	private button(parent: HTMLElement, label: string, primary: boolean, run: () => void): void {
		const button = append(parent, $<HTMLButtonElement>(primary ? 'button.claude-btn.is-small.is-primary' : 'button.claude-btn.is-small'));
		button.type = 'button';
		button.textContent = label;
		this._firstAction ??= button;
		this._renderStore.add(addDisposableListener(button, EventType.CLICK, run));
	}

	/** The run's last answer as plain text, cut to a few lines. */
	private lastAnswer(sessionId: string | undefined): string | undefined {
		if (!sessionId) {
			return undefined;
		}
		const turns = this._agent.getViewState(sessionId).turns;
		const text = turns[turns.length - 1]?.assistantText.trim();
		if (!text) {
			return undefined;
		}
		return text.length > ANSWER_LIMIT ? `${text.slice(0, ANSWER_LIMIT).trimEnd()}…` : text;
	}

	/** A run is a normal chat: an open tab is selected, a closed one comes back from history. */
	private async openAsChat(sessionId: string): Promise<void> {
		if (this._agent.getSessions().some(session => session.id === sessionId)) {
			this._agent.selectSession(sessionId);
		} else {
			await this._agent.resume(sessionId);
			this._agent.selectSession(sessionId);
		}
		await this._views.openView(CLAUDE_AGENT_VIEW_ID, true);
	}
}
