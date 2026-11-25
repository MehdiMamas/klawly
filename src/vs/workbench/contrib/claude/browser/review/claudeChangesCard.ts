/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ReviewFile, TurnReview } from '../../../../services/claude/common/claudeReview.js';
import { ClaudeScopeCounts, claudeKeepAllFilesLabel, claudeScopeActionLabel } from '../../common/claudeKeepAll.js';

export interface ClaudeReviewCardController {
	get(turnId: string): TurnReview | undefined;
	openFile(turnId: string, uri: URI): void;
	acceptFile(turnId: string, uri: URI): void;
	rejectFile(turnId: string, uri: URI): void;
	acceptAll(turnId: string): void;
	rejectAll(turnId: string): void;
	reviewAll(turnId: string): void;
	openReview(turnId: string): void;
	resolve(turnId: string, uri: URI): void;
	commitAccepted(turnId: string): void | Promise<void>;
	reportCommitError?(message: string): void;
	/** What Keep All in the bar covers past this turn: the chat's other turns, else other chats (issue 706). Undefined when nothing else waits. */
	wideScope?(turnId: string): ClaudeScopeCounts | undefined;
	keepWide?(turnId: string): void;
	/** Undoes changes Auto-Keep kept: one file, or the whole turn. */
	undoKept?(turnId: string, uri?: URI): void;
}

export interface ClaudeChangesCardOptions {
	/** The folder to show for a file, relative to the workspace. Defaults to the review's folder name. */
	folderOf?(uri: URI): string;
}

/**
 * The changed-files summary at the end of a turn (spec 08): a head row with
 * the totals and Undo All / Keep All, one row per file (name, folder, a "new"
 * pill and its diff stat; Undo and Keep on hover), and a footer with one
 * Review button (step through the diffs) next to Review All Changes, which asks
 * Claude to review the whole turn (spec 34a).
 */
export function renderClaudeChangesCard(parent: HTMLElement, turnId: string, review: TurnReview, controller: ClaudeReviewCardController, store: DisposableStore, options?: ClaudeChangesCardOptions): void {
	const reviewed = review.files.filter(file => file.state === 'accepted' || file.state === 'rejected').length;
	const done = reviewed === review.files.length;
	const rest = reviewed > 0 && !done;
	const card = append(parent, $('.claude-changes'));
	card.setAttribute('role', 'region');
	card.setAttribute('aria-label', localize('claudeChangesLabel', "Changed files"));

	const head = append(card, $('.claude-changes-head'));
	append(head, $(ThemeIcon.asCSSSelector(Codicon.gitCompare)));
	append(head, $('span.title')).textContent = reviewed > 0 && !review.autoKept
		? localize('claudeReviewedCount', "{0} of {1} reviewed", reviewed, review.files.length)
		: fileCountLabel(review.files.length);
	const totals = diffTotals(review);
	appendDiffStat(head, totals.added, totals.removed);
	appendAutoKept(head, review);
	append(head, $('span.spacer'));
	if (!done) {
		textButton(head, 'button.claude-btn.is-small.is-ghost', rest ? localize('claudeUndoRest', "Undo Rest") : localize('claudeUndoAll', "Undo All"), store, () => controller.rejectAll(turnId));
		textButton(head, 'button.claude-btn.is-small', rest ? localize('claudeKeepRest', "Keep Rest") : localize('claudeKeepAll', "Keep All"), store, () => controller.acceptAll(turnId));
	}
	appendUndoKept(head, turnId, review, controller, store, localize('claudeUndoKeptTurn', "Undo Turn"));

	for (const file of review.files) {
		renderFileRow(card, turnId, review, file, controller, store, options);
	}

	const foot = append(card, $('.claude-changes-foot'));
	append(foot, $('span.spacer'));
	if (review.files.some(file => file.state === 'accepted')) {
		textButton(foot, 'button.claude-btn.is-small.is-ghost', localize('claudeCommitAccepted', "Commit accepted changes"), store, () => {
			void Promise.resolve(controller.commitAccepted(turnId)).catch(error => {
				const message = error instanceof Error ? error.message : String(error);
				controller.reportCommitError?.(message);
			});
		});
	}
	const reviewAll = textButton(foot, 'button.claude-btn.is-small.is-ghost.claude-review-all', localize('claudeReviewAllChanges', "Review All Changes"), store, () => controller.reviewAll(turnId));
	reviewAll.title = localize('claudeReviewAllHint', "Ask Claude to review every change in this turn");
	const reviewButton = textButton(foot, 'button.claude-btn.is-small.claude-review-open', localize('claudeReview', "Review"), store, () => controller.openReview(turnId));
	reviewButton.title = localize('claudeReviewHint', "Open every change of this turn in the review editor");
}

export interface ClaudeChangesBarOptions extends ClaudeChangesCardOptions {
	/** Whether the file list is open. */
	readonly expanded: boolean;
	/** Opens or closes the file list. */
	toggle(): void;
}

/**
 * The changed-files bar docked on top of the composer (spec 08): one head row
 * with a disclosure, the file count and totals, Undo All / Keep All while
 * files are pending, Commit once some are kept, and Review (step through the
 * diffs). Opened, it lists the files with the same rows as the card. Asking
 * Claude to review the turn is an icon button, so the row stays short.
 * Returns the disclosure button, so a repaint can keep its focus.
 */
export function renderClaudeChangesBar(parent: HTMLElement, turnId: string, review: TurnReview, controller: ClaudeReviewCardController, store: DisposableStore, options: ClaudeChangesBarOptions): HTMLButtonElement {
	const reviewed = review.files.filter(file => file.state === 'accepted' || file.state === 'rejected').length;
	const done = reviewed === review.files.length;
	const rest = reviewed > 0 && !done;
	const bar = append(parent, $('.claude-changes-bar'));
	bar.classList.toggle('is-expanded', options.expanded);
	bar.setAttribute('role', 'region');
	bar.setAttribute('aria-label', localize('claudeChangesLabel', "Changed files"));

	const head = append(bar, $('.claude-changes-bar-head'));
	const toggle = append(head, $<HTMLButtonElement>('button.claude-changes-bar-toggle'));
	toggle.type = 'button';
	toggle.setAttribute('aria-expanded', String(options.expanded));
	append(toggle, $(ThemeIcon.asCSSSelector(options.expanded ? Codicon.chevronDown : Codicon.chevronRight)));
	append(toggle, $('span.title')).textContent = reviewed > 0 && !review.autoKept
		? localize('claudeReviewedCount', "{0} of {1} reviewed", reviewed, review.files.length)
		: barFileCountLabel(review.files.length);
	const totals = diffTotals(review);
	appendDiffStat(toggle, totals.added, totals.removed);
	appendAutoKept(toggle, review);
	store.add(addDisposableListener(toggle, EventType.CLICK, event => {
		event.preventDefault();
		options.toggle();
	}));

	// The actions sit in one group: a narrow pane drops what it can (CSS), then wraps the group under the count; nothing is clipped.
	const actions = append(head, $('.claude-changes-bar-actions'));
	if (!done) {
		// Short labels fit a narrow pane; the full action is the accessible name and the tooltip.
		const undo = textButton(actions, 'button.claude-btn.is-small.is-ghost', localize('claudeBarUndo', "Undo"), store, () => controller.rejectAll(turnId));
		undo.title = rest ? localize('claudeUndoRest', "Undo Rest") : localize('claudeUndoAll', "Undo All");
		undo.setAttribute('aria-label', undo.title);
		const keep = textButton(actions, 'button.claude-btn.is-small.is-ghost', localize('claudeBarKeep', "Keep"), store, () => controller.acceptAll(turnId));
		keep.title = rest ? localize('claudeKeepRest', "Keep Rest") : localize('claudeKeepAll', "Keep All");
		keep.setAttribute('aria-label', keep.title);
	}
	// Issue 706: more turns or chats wait, so one click keeps them all; the label says how many files, the tooltip the whole scope (DL-70).
	const wide = controller.wideScope?.(turnId);
	if (wide && controller.keepWide) {
		const keepWide = controller.keepWide;
		const button = textButton(actions, 'button.claude-btn.is-small.is-secondary.claude-keep-wide', '', store, () => keepWide(turnId));
		// A narrow pane shows the short label; the tooltip and accessible name keep the whole scope.
		append(button, $('span.claude-keep-wide-full')).textContent = claudeKeepAllFilesLabel(wide.files);
		append(button, $('span.claude-keep-wide-short')).textContent = localize('claudeKeepAll', "Keep All");
		button.title = claudeScopeActionLabel('keep', wide);
		button.setAttribute('aria-label', button.title);
	}
	appendUndoKept(actions, turnId, review, controller, store, localize('claudeBarUndo', "Undo"));
	if (review.files.some(file => file.state === 'accepted')) {
		textButton(actions, 'button.claude-btn.is-small.is-ghost', localize('claudeCommitKept', "Commit"), store, () => {
			void Promise.resolve(controller.commitAccepted(turnId)).catch(error => {
				const message = error instanceof Error ? error.message : String(error);
				controller.reportCommitError?.(message);
			});
		}).title = localize('claudeCommitAcceptedHint', "Commit the kept changes");
	}
	iconButton(actions, Codicon.commentDiscussion, localize('claudeReviewAllHint', "Ask Claude to review every change in this turn"), store, () => controller.reviewAll(turnId)).classList.add('claude-review-all');
	textButton(actions, 'button.claude-btn.is-small.is-secondary.claude-review-open', localize('claudeReview', "Review"), store, () => controller.openReview(turnId)).title = localize('claudeReviewHint', "Open every change of this turn in the review editor");

	if (options.expanded) {
		const files = append(bar, $('.claude-changes-bar-files'));
		for (const file of review.files) {
			renderFileRow(files, turnId, review, file, controller, store, options);
		}
	}
	return toggle;
}

/** "Kept automatically": Auto-Keep kept this turn's changes as they landed (issue 706). */
function appendAutoKept(parent: HTMLElement, review: TurnReview): void {
	if (review.autoKept) {
		append(parent, $('span.claude-changes-auto-kept')).textContent = localize('claudeKeptAutomatically', "Kept automatically");
	}
}

/** Undo for a turn Auto-Keep kept, while some of its files are still kept. */
function appendUndoKept(parent: HTMLElement, turnId: string, review: TurnReview, controller: ClaudeReviewCardController, store: DisposableStore, label: string): void {
	if (!review.autoKept || !controller.undoKept || !review.files.some(file => file.state === 'accepted')) {
		return;
	}
	const undoKept = controller.undoKept;
	const button = textButton(parent, 'button.claude-btn.is-small.is-ghost.claude-undo-kept', label, store, () => undoKept(turnId));
	button.title = localize('claudeUndoKeptTurnHint', "Undo the changes Auto-Keep kept in this turn");
	button.setAttribute('aria-label', button.title);
}

function renderFileRow(parent: HTMLElement, turnId: string, review: TurnReview, file: ReviewFile, controller: ClaudeReviewCardController, store: DisposableStore, options: ClaudeChangesCardOptions | undefined): void {
	const classes = ['.claude-file-row'];
	if (file.state === 'accepted') {
		classes.push('.is-accepted');
	} else if (file.state === 'rejected') {
		classes.push('.is-rejected');
	} else if (file.isNew) {
		classes.push('.is-new');
	}
	const row = append(parent, $(classes.join('')));
	row.tabIndex = 0;
	row.setAttribute('role', 'button');

	const icon = file.state === 'accepted' ? Codicon.check : file.state === 'rejected' ? Codicon.discard : file.state === 'conflicted' ? Codicon.warning : file.isNew ? Codicon.newFile : Codicon.file;
	const iconNode = append(row, $(ThemeIcon.asCSSSelector(icon)));
	if (file.state === 'accepted') {
		iconNode.classList.add('state-ok');
	} else if (file.state === 'conflicted') {
		iconNode.classList.add('state-conflict');
	}
	append(row, $('span.name')).textContent = file.name;
	const reviewed = file.state === 'accepted' || file.state === 'rejected';
	if (file.isNew && !reviewed) {
		append(row, $('span.claude-new-pill')).textContent = localize('claudeNewFile', "new");
	}
	const folder = options?.folderOf?.(file.uri) ?? file.directory;
	const directory = file.state === 'accepted'
		? localize('claudeKeptState', "kept")
		: file.state === 'rejected'
			? localize('claudeUndoneState', "undone")
			: file.state === 'conflicted'
				? localize('claudeEditedAfter', "edited by you after the agent")
				: folder;
	append(row, $('span.dir')).textContent = directory;
	// The row's state is in its label too, not only in the icon and its color.
	const described = file.isNew && !reviewed && file.state !== 'conflicted'
		? localize('claudeNewFileIn', "new file, {0}", folder)
		: directory;
	row.setAttribute('aria-label', localize('claudeOpenDiffState', "Open diff for {0}, {1}", file.name, described));
	const right = append(row, $('span.right'));
	if (file.state === 'conflicted') {
		textButton(right, 'button.claude-btn.is-small', localize('claudeResolve', "Resolve"), store, () => controller.resolve(turnId, file.uri));
	} else if (!reviewed) {
		const actions = append(right, $('span.actions'));
		iconButton(actions, Codicon.discard, localize('claudeUndoFile', "Undo"), store, () => controller.rejectFile(turnId, file.uri));
		iconButton(actions, Codicon.check, localize('claudeKeepFile', "Keep"), store, () => controller.acceptFile(turnId, file.uri));
		appendDiffStat(right, file.added, file.removed);
	} else if (file.state === 'accepted') {
		if (review.autoKept && controller.undoKept) {
			const undoKept = controller.undoKept;
			const actions = append(right, $('span.actions'));
			iconButton(actions, Codicon.discard, localize('claudeUndoFile', "Undo"), store, () => undoKept(turnId, file.uri));
		}
		appendDiffStat(right, file.added, file.removed);
	}
	const open = () => controller.openFile(turnId, file.uri);
	store.add(addDisposableListener(row, EventType.CLICK, () => open()));
	store.add(addDisposableListener(row, EventType.KEY_DOWN, event => {
		if (event.target !== row) {
			return;
		}
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			open();
		}
	}));
}

function fileCountLabel(count: number): string {
	return count === 1
		? localize('claudeOneFileChanged', "1 file changed")
		: localize('claudeFilesChanged', "{0} files changed", count);
}

function barFileCountLabel(count: number): string {
	return count === 1
		? localize('claudeOneFile', "1 File")
		: localize('claudeFileCount', "{0} Files", count);
}

function diffTotals(review: TurnReview): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const file of review.files) {
		added += file.added;
		removed += file.removed;
	}
	return { added, removed };
}

/** Appends a `+N -M` diff stat. Nothing is added when both counts are 0. */
export function appendDiffStat(parent: HTMLElement, added: number, removed: number): void {
	if (added === 0 && removed === 0) {
		return;
	}
	const stat = append(parent, $('span.claude-diffstat'));
	if (added > 0) {
		append(stat, $('span.add')).textContent = `+${added}`;
	}
	if (removed > 0) {
		append(stat, $('span.del')).textContent = `\u2212${removed}`;
	}
}

function textButton(parent: HTMLElement, className: string, label: string, store: DisposableStore, run: () => void): HTMLButtonElement {
	const button = append(parent, $<HTMLButtonElement>(className));
	button.type = 'button';
	button.textContent = label;
	store.add(addDisposableListener(button, EventType.CLICK, event => {
		event.preventDefault();
		event.stopPropagation();
		run();
	}));
	return button;
}

function iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, store: DisposableStore, run: () => void): HTMLButtonElement {
	const button = append(parent, $<HTMLButtonElement>('button.claude-icon-btn'));
	button.type = 'button';
	button.setAttribute('aria-label', label);
	button.title = label;
	append(button, $(ThemeIcon.asCSSSelector(icon)));
	store.add(addDisposableListener(button, EventType.CLICK, event => {
		event.preventDefault();
		event.stopPropagation();
		run();
	}));
	return button;
}
