/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getTotalHeight, getWindow, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICodeEditor, IViewZone } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { MultiDiffEditorWidget } from '../../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IEditorDecorationsCollection } from '../../../../../editor/common/editorCommon.js';
import { IModelDeltaDecoration, ITextModel } from '../../../../../editor/common/model.js';
import { localize } from '../../../../../nls.js';
import { ClaudeFindingReply } from '../../../../../platform/claude/common/claudeReviewReply.js';
import { CLAUDE_DISMISS_REASONS, ClaudeDismissReason, claudeReviewCategoryLabel } from '../../../../../platform/claude/common/claudeReviewLearning.js';
import { claudeLinesHash } from '../../../../../platform/claude/common/claudeReviewFix.js';
import { claudeReviewReproduceChip, ClaudeReviewTestState } from '../../../../../platform/claude/common/claudeReviewTests.js';
import { CLAUDE_REVIEW_CATEGORIES, CLAUDE_REVIEW_SEVERITIES, claudeLineReference, compareClaudeReviewFindings, ClaudeReviewCategory, ClaudeReviewFilter, ClaudeReviewFinding, ClaudeReviewSeverity, filterClaudeReviewFindings } from '../../../../../platform/claude/common/claudeReviewLoop.js';

/** A finding of the review pass, on the changed file the Review editor shows (issue 431). */
export interface ClaudeShownFinding {
	readonly id: string;
	readonly finding: ClaudeReviewFinding;
	/** The file as the Review editor's diff shows it on its modified side. */
	readonly uri: URI;
}

export interface ClaudeReviewFindingsHost {
	/** Fix with Agent: sends the finding to the agent as a line comment. */
	fix(id: string): void;
	/** Fix on PR Branch (issue 872): a new chat in a worktree of the pull request's branch; missing hides the button. */
	fixOnBranch?(id: string): void;
	/** Reproduce with a Test (issue 936): asks the agent for a failing test that shows the finding; missing hides the button. */
	reproduceWithTest?(id: string): void;
	/** Where a finding's Reproduce with a Test stands (issue 1398); missing shows no chip. */
	reproduceState?(id: string): ClaudeReviewTestState;
	/** Re-run Review, offered when a file changed since the review; missing hides the button. */
	rerun?(): void;
	/** Dismisses a finding; a reason counts toward learning (issue 923). */
	dismiss(id: string, reason?: ClaudeDismissReason): void;
	/** Thumbs up or down on a finding; feeds the same counters as dismissals (issue 923). Missing hides the buttons. */
	rate?(id: string, up: boolean): void;
	reveal(id: string): void;
	/** The conversation of a finding's thread (issue 929); missing means replies are off. */
	conversation?(id: string): ClaudeFindingConversation | undefined;
	cancel(): void;
	dismissAll(): void;
	/** The filter that hides findings (issue 921); hiding never deletes. */
	filter(): ClaudeReviewFilter;
	setFilter(filter: ClaudeReviewFilter): void;
}

/** What a finding thread needs from where it is shown: the Review editor, or a file after a commit review (issue 876). */
export type ClaudeFindingThreadHost = Pick<ClaudeReviewFindingsHost, 'fix' | 'dismiss' | 'rate' | 'rerun'>;

/**
 * The conversation of one finding thread (issue 929): replies go to Claude as a
 * read-only turn; the answer lands in the thread. Mark as Intended counts as a
 * dismissal (issue 923); Continue in Chat opens the finding in the agent pane.
 */
export interface ClaudeFindingConversation {
	readonly onDidChange: Event<void>;
	replies(): readonly ClaudeFindingReply[];
	/** True while Claude is answering. */
	busy(): boolean;
	send(text: string): void;
	/** Missing until learning from intended findings lands (issue 923): the button stays hidden. */
	markIntended?(): void;
	continueInChat(): void;
}

/**
 * Applies one finding's suggestion to the file the thread sits in (issue 925).
 * `lines` are the file's lines the suggestion replaces now; `stale` is true when
 * they are no longer what the review saw.
 */
export interface ClaudeSuggestionApplier {
	readonly onDidChange: Event<void>;
	lines(): readonly string[];
	stale(): boolean;
	apply(): boolean;
	/** Undoes the applied edit in the editor; missing means the thread is dismissed on apply instead. */
	undo?(): void;
}

/** What the findings bar shows: nothing, a pass in flight, or the findings left. */
export type ClaudeReviewFindingsState =
	| { readonly kind: 'idle' }
	| { readonly kind: 'running' }
	| { readonly kind: 'done'; readonly findings: readonly ClaudeShownFinding[] };

/** Findings worst first, then by file and line: the order of the bar and of the threads on one line. */
function sortClaudeShownFindings(findings: readonly ClaudeShownFinding[]): ClaudeShownFinding[] {
	return [...findings].sort((a, b) => compareClaudeReviewFindings(a.finding, b.finding));
}

function staleReasonText(): string {
	return localize('claudeReviewFindingStale', "The file changed since this review.");
}

function severityIcon(severity: ClaudeReviewSeverity): ThemeIcon {
	switch (severity) {
		case 'critical': case 'high': return Codicon.error;
		case 'medium': return Codicon.warning;
		default: return Codicon.info;
	}
}

function severityLabel(severity: ClaudeReviewSeverity): string {
	switch (severity) {
		case 'critical': return localize('claudeReviewSeverityCritical', "Critical");
		case 'high': return localize('claudeReviewSeverityHigh', "High");
		case 'medium': return localize('claudeReviewSeverityMedium', "Medium");
		default: return localize('claudeReviewSeverityLow', "Low");
	}
}

function categoryLabel(category: ClaudeReviewCategory): string {
	return claudeReviewCategoryLabel(category);
}

function findingReference(finding: ClaudeReviewFinding): string {
	return claudeLineReference(finding.file, finding.startLine, finding.endLine);
}

function iconButton(container: HTMLElement, icon: ThemeIcon, label: string, run: () => void, store: DisposableStore): HTMLButtonElement {
	const button = append(container, $<HTMLButtonElement>('button.claude-icon-btn'));
	button.type = 'button';
	button.setAttribute('aria-label', label);
	button.title = label;
	append(button, $(ThemeIcon.asCSSSelector(icon)));
	store.add(addDisposableListener(button, EventType.CLICK, run));
	return button;
}

/**
 * One finding as a comment thread under the lines it is about: the severity in
 * the theme's problem color (DL-01), the title, the explanation, the suggested
 * code, then Fix with Agent and Dismiss.
 */
export function renderClaudeFindingThread(item: ClaudeShownFinding, host: ClaudeFindingThreadHost, store: DisposableStore, fixHint = localize('claudeReviewFindingFixHint', "Send this finding to the agent as a review comment on these lines"), applier?: ClaudeSuggestionApplier, conversation?: ClaudeFindingConversation): HTMLElement {
	const { finding } = item;
	const isQuestion = finding.kind === 'question';
	const thread = $(`.claude-review-finding-thread.is-${finding.severity}${isQuestion ? '.is-question' : ''}`);
	thread.setAttribute('role', 'group');
	thread.setAttribute('aria-label', localize('claudeReviewFindingAria', "{0}: {1}, {2}", severityLabel(finding.severity), finding.title, findingReference(finding)));
	const head = append(thread, $('.claude-review-finding-head'));
	const icon = append(head, $(`span.severity${ThemeIcon.asCSSSelector(severityIcon(finding.severity))}`));
	icon.title = severityLabel(finding.severity);
	append(head, $('span.title')).textContent = finding.title;
	append(head, $('span.reference')).textContent = findingReference(finding);
	if (finding.body) {
		append(thread, $('.claude-review-finding-body')).textContent = finding.body;
	}
	if (finding.suggestion) {
		if (applier) {
			renderSuggestionDiff(thread, applier.lines(), finding.suggestion);
		} else {
			append(thread, $('pre.claude-review-finding-suggestion')).textContent = finding.suggestion;
		}
	}
	const actions = append(thread, $('.claude-review-finding-actions'));
	if (finding.suggestion && applier) {
		const apply = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.is-primary'));
		apply.type = 'button';
		apply.textContent = localize('claudeReviewFindingApply', "Apply Suggestion");
		// DL-11: one name per action ("Fix with Agent"). DL-12: a blocked action says why in text and offers the way out as a "Re-run Review" button.
		const stale = append(thread, $('.claude-review-finding-stale'));
		const staleReason = append(stale, $('span.claude-review-finding-stale-reason'));
		const rerun = host.rerun ? append(stale, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost')) : undefined;
		if (rerun) {
			rerun.type = 'button';
			rerun.textContent = localize('claudeReviewFindingRerun', "Re-run Review");
			store.add(addDisposableListener(rerun, EventType.CLICK, () => host.rerun?.()));
		}
		const applied = append(actions, $('span.claude-review-finding-applied'));
		const undo = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
		undo.type = 'button';
		undo.textContent = localize('claudeReviewFindingUndo', "Undo");
		undo.title = localize('claudeReviewFindingUndoHint', "Undo the edit in the editor and bring the original lines back");
		let isApplied = false;
		const refresh = () => {
			const isStale = !isApplied && applier.stale();
			apply.disabled = isStale;
			apply.title = isStale ? staleReasonText() : localize('claudeReviewFindingApplyHint', "Replace these lines with the suggestion; undo restores them");
			staleReason.textContent = isStale ? staleReasonText() : '';
			stale.hidden = !isStale;
			if (rerun) {
				rerun.hidden = !isStale;
			}
			apply.hidden = isApplied;
			applied.textContent = isApplied ? localize('claudeReviewFindingApplied', "Applied") : '';
			applied.hidden = !isApplied;
			undo.hidden = !isApplied;
		};
		refresh();
		store.add(applier.onDidChange(refresh));
		store.add(addDisposableListener(undo, EventType.CLICK, () => {
			applier.undo?.();
			isApplied = false;
			refresh();
		}));
		store.add(addDisposableListener(apply, EventType.CLICK, () => {
			if (applier.apply()) {
				if (applier.undo) {
					isApplied = true;
					refresh();
				} else {
					host.dismiss(item.id);
				}
			} else {
				refresh();
			}
		}));
	}
	const fix = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.is-primary'));
	fix.type = 'button';
	fix.textContent = localize('claudeReviewFindingFix', "Fix with Agent");
	fix.title = fixHint;
	store.add(addDisposableListener(fix, EventType.CLICK, () => host.fix(item.id)));
	const dismiss = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
	dismiss.type = 'button';
	dismiss.textContent = localize('claudeReviewFindingDismiss', "Dismiss");
	// DL-12: the reason chips and the thumbs only show where the host can use them.
	const reasons = append(thread, $('.claude-review-finding-reasons'));
	reasons.hidden = true;
	reasons.setAttribute('role', 'group');
	reasons.setAttribute('aria-label', localize('claudeReviewDismissReasons', "Why Dismiss This Finding"));
	for (const reason of CLAUDE_DISMISS_REASONS) {
		const chip = append(reasons, $<HTMLButtonElement>('button.claude-chip'));
		chip.type = 'button';
		chip.textContent = dismissReasonLabel(reason);
		chip.title = dismissReasonHint(reason);
		store.add(addDisposableListener(chip, EventType.CLICK, () => host.dismiss(item.id, reason)));
	}
	store.add(addDisposableListener(dismiss, EventType.CLICK, () => {
		if (host.rate) {
			reasons.hidden = !reasons.hidden;
			dismiss.setAttribute('aria-expanded', String(!reasons.hidden));
		} else {
			host.dismiss(item.id);
		}
	}));
	if (host.rate) {
		const rate = host.rate.bind(host);
		const thumb = (icon: ThemeIcon, label: string, up: boolean) => iconButton(actions, icon, label, () => rate(item.id, up), store);
		thumb(Codicon.thumbsup, localize('claudeReviewFindingThumbsUp', "Helpful"), true);
		thumb(Codicon.thumbsdown, localize('claudeReviewFindingThumbsDown', "Not Helpful"), false);
	}
	if (conversation) {
		renderFindingConversation(thread, actions, isQuestion, conversation, store);
	}
	return thread;
}

/** Tooltip of a dismiss reason chip (issue 1086). */
export function dismissReasonHint(reason: ClaudeDismissReason): string {
	switch (reason) {
		case 'not-a-problem': return localize("claudeDismissNotAProblemHint", "The code is fine; this finding is wrong");
		case 'wont-fix-here': return localize("claudeDismissWontFixHint", "A real issue, but not worth fixing in this project");
		case 'too-nitpicky': return localize("claudeDismissNitpickyHint", "Correct but too minor to report");
		case 'already-handled': return localize("claudeDismissHandledHint", "Handled elsewhere or already covered");
	}
}

/** Label of a dismiss reason (issue 923). */
export function dismissReasonLabel(reason: ClaudeDismissReason): string {
	switch (reason) {
		case 'not-a-problem': return localize('claudeDismissNotAProblem', "Not a Problem");
		case 'wont-fix-here': return localize('claudeDismissWontFix', "Won't Fix Here");
		case 'too-nitpicky': return localize('claudeDismissNitpicky', "Too Nitpicky");
		case 'already-handled': return localize('claudeDismissHandled', "Already Handled");
	}
}

/** The offer shown once a kind of finding reached the learn threshold (issues 923, 1086, 1108, DL-15 buttons): the sentence, then the rule text, then one hint sentence with the file and a link to the Learned Rules page. */
export function renderClaudeLearnedOffer(parent: HTMLElement, question: string, ruleText: string, targetFile: string, accept: () => void, decline: () => void, openRules: () => void, store: DisposableStore): HTMLElement {
	const offer = append(parent, $('.claude-review-learned-offer'));
	offer.setAttribute('role', 'group');
	append(offer, $('span.question')).textContent = question;
	const rule = append(offer, $('span.rule'));
	rule.textContent = ruleText;
	const hint = append(offer, $('span.hint'));
	// One localized sentence; the link sits inside it at the position the translation gives {1} (issue 1138).
	const marker = ' ';
	const [before, after = ''] = localize("claudeReviewLearnedHint", "Adds this rule to {0}. You can remove it in {1}.", targetFile, marker).split(marker);
	append(hint, $('span')).textContent = before;
	const link = append(hint, $<HTMLButtonElement>('button.claude-link'));
	link.type = 'button';
	link.textContent = localize("claudeReviewLearnedRulesLink", "Settings > Review > Learned Rules");
	store.add(addDisposableListener(link, EventType.CLICK, openRules));
	append(hint, $('span')).textContent = after;
	const yes = append(offer, $<HTMLButtonElement>('button.claude-btn.is-small.is-primary'));
	yes.type = 'button';
	yes.textContent = localize("claudeReviewLearnedYes", "Add Rule");
	store.add(addDisposableListener(yes, EventType.CLICK, accept));
	const no = append(offer, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
	no.type = 'button';
	no.textContent = localize("claudeReviewLearnedNo", "Not Now");
	store.add(addDisposableListener(no, EventType.CLICK, decline));
	return offer;
}

/** The replies, the reply box, Mark as Intended and Continue in Chat of one thread (issue 929). */
function renderFindingConversation(thread: HTMLElement, actions: HTMLElement, isQuestion: boolean, conversation: ClaudeFindingConversation, store: DisposableStore): void {
	if (conversation.markIntended) {
		const intended = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
		intended.type = 'button';
		intended.textContent = localize('claudeReviewFindingIntended', "Mark as Intended");
		intended.title = localize('claudeReviewFindingIntendedHint', "This is on purpose: dismiss it and stop reporting it");
		store.add(addDisposableListener(intended, EventType.CLICK, () => conversation.markIntended?.()));
	}
	const chat = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
	chat.type = 'button';
	chat.textContent = localize('claudeReviewFindingContinueInChat', "Continue in Chat");
	store.add(addDisposableListener(chat, EventType.CLICK, () => conversation.continueInChat()));

	const replies = append(thread, $('.claude-review-finding-replies'));
	replies.setAttribute('aria-live', 'polite');
	const box = append(thread, $('.claude-review-finding-reply-box'));
	const input = append(box, $<HTMLTextAreaElement>('textarea.claude-review-finding-reply-input'));
	input.rows = 1;
	input.placeholder = isQuestion ? localize('claudeReviewQuestionPlaceholder', "Answer the question") : localize('claudeReviewReplyPlaceholder', "Reply, or explain why this is intended");
	input.setAttribute('aria-label', input.placeholder);
	const send = append(box, $<HTMLButtonElement>('button.claude-btn.is-small.is-primary'));
	send.type = 'button';
	send.textContent = isQuestion ? localize('claudeReviewQuestionAnswer', "Answer") : localize('claudeReviewReplySend', "Reply");
	const submit = () => {
		const text = input.value.trim();
		if (text && !conversation.busy()) {
			input.value = '';
			conversation.send(text);
		}
	};
	store.add(addDisposableListener(send, EventType.CLICK, submit));
	store.add(addDisposableListener(input, EventType.KEY_DOWN, (e: KeyboardEvent) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	}));
	const refresh = () => {
		clearNode(replies);
		for (const reply of conversation.replies()) {
			append(replies, $(`.claude-review-finding-reply.is-${reply.role}`)).textContent = reply.text;
		}
		if (conversation.busy()) {
			append(replies, $('.claude-review-finding-reply.is-assistant.is-pending')).textContent = localize('claudeReviewReplyThinking', "Thinking...");
		}
		send.disabled = conversation.busy();
	};
	refresh();
	store.add(conversation.onDidChange(refresh));
}

/** The suggestion as an inline diff: the lines it replaces struck as removed, the new ones added (DL-01 problem colors). */
function renderSuggestionDiff(thread: HTMLElement, original: readonly string[], replacement: string): void {
	const diff = append(thread, $('pre.claude-review-finding-suggestion.is-diff'));
	diff.setAttribute('aria-label', localize('claudeReviewFindingDiffAria', "Suggested change"));
	const add = (kind: 'removed' | 'added', sign: string, line: string) => {
		append(diff, $(`span.claude-review-diff-line.is-${kind}`)).textContent = `${sign} ${line}`;
	};
	original.forEach(line => add('removed', '-', line));
	replacement.replace(/(\r\n|\r|\n)$/, '').split(/\r\n|\r|\n/).forEach(line => add('added', '+', line));
}

/**
 * The bar under the review header that shows a review pass in flight, then its
 * findings worst first (issue 431). Each row jumps to its thread on the diff.
 * Hidden while there is nothing to show. A raised card (DL-07) at the control
 * radius (DL-03), like the comment tray.
 */
export class ClaudeReviewFindingsBar extends Disposable {
	private readonly _node: HTMLElement;
	private readonly _icon: HTMLElement;
	private readonly _title: HTMLElement;
	private readonly _action: HTMLButtonElement;
	private readonly _filters: HTMLElement;
	private readonly _list: HTMLElement;
	private readonly _rows = this._register(new DisposableStore());
	private _state: ClaudeReviewFindingsState = { kind: 'idle' };

	constructor(container: HTMLElement, private readonly _host: ClaudeReviewFindingsHost) {
		super();
		this._node = append(container, $('.claude-review-findings'));
		this._node.setAttribute('role', 'region');
		this._node.setAttribute('aria-label', localize('claudeReviewFindingsRegion', "Review Findings"));
		const head = append(this._node, $('.claude-review-findings-head'));
		this._icon = append(head, $('span.icon'));
		this._title = append(head, $('span.title'));
		this._title.setAttribute('aria-live', 'polite');
		append(head, $('span.spacer'));
		this._action = append(head, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
		this._action.type = 'button';
		this._register(addDisposableListener(this._action, EventType.CLICK, () => this._state.kind === 'running' ? this._host.cancel() : this._host.dismissAll()));
		this._filters = append(this._node, $('.claude-review-findings-filters'));
		this._filters.setAttribute('role', 'group');
		this._filters.setAttribute('aria-label', localize('claudeReviewFindingsFilters', "Filter Findings"));
		this._list = append(this._node, $('ul.claude-review-findings-list'));
		this.render(this._state);
	}

	/** Height the bar takes above the diff; 0 while it is hidden. */
	get height(): number {
		return this._node.classList.contains('is-empty') ? 0 : getTotalHeight(this._node);
	}

	render(state: ClaudeReviewFindingsState): void {
		this._state = state;
		this._rows.clear();
		clearNode(this._list);
		clearNode(this._icon);
		clearNode(this._filters);
		const all = state.kind === 'done' ? state.findings : [];
		const filter = this._host.filter();
		const shown = new Set(filterClaudeReviewFindings(all.map(item => item.finding), filter));
		const findings = sortClaudeShownFindings(all.filter(item => shown.has(item.finding)));
		this._node.classList.toggle('is-empty', state.kind === 'idle' || (state.kind === 'done' && all.length === 0));
		this._node.classList.toggle('is-running', state.kind === 'running');
		if (state.kind === 'running') {
			append(this._icon, $(ThemeIcon.asCSSSelector(ThemeIcon.modify(Codicon.loading, 'spin'))));
			this._title.textContent = localize('claudeReviewFindingsRunning', "Claude is reviewing these changes...");
			this._action.textContent = localize('claudeReviewFindingsCancel', "Cancel");
			return;
		}
		append(this._icon, $(ThemeIcon.asCSSSelector(Codicon.commentDiscussion)));
		this._title.textContent = findings.length < all.length
			? localize('claudeReviewFindingsFiltered', "{0} of {1} findings", findings.length, all.length)
			: findings.length === 1
				? localize('claudeReviewFindingsOne', "1 finding")
				: localize('claudeReviewFindingsMany', "{0} findings", findings.length);
		this.renderFilters(filter);
		this._action.textContent = localize('claudeReviewFindingsDismissAll', "Dismiss All");
		for (const item of findings) {
			const row = append(this._list, $(`li.claude-review-findings-item.is-${item.finding.severity}`));
			const icon = append(row, $(`span.severity${ThemeIcon.asCSSSelector(severityIcon(item.finding.severity))}`));
			icon.title = severityLabel(item.finding.severity);
			const reference = append(row, $<HTMLButtonElement>('button.reference'));
			reference.type = 'button';
			reference.textContent = findingReference(item.finding);
			reference.title = localize('claudeReviewFindingReveal', "Show the finding on the diff");
			this._rows.add(addDisposableListener(reference, EventType.CLICK, () => this._host.reveal(item.id)));
			const title = append(row, $('span.text'));
			title.textContent = item.finding.title;
			title.title = item.finding.body || item.finding.title;
			iconButton(row, Codicon.wrench, localize('claudeReviewFindingFix', "Fix with Agent"), () => this._host.fix(item.id), this._rows);
			const fixOnBranch = this._host.fixOnBranch;
			if (fixOnBranch) {
				iconButton(row, Codicon.gitBranch, localize('claudeReviewFindingFixOnBranch', "Fix on PR Branch"), () => fixOnBranch(item.id), this._rows);
			}
			const reproduce = this._host.reproduceWithTest;
			if (reproduce && item.finding.kind !== 'question') {
				const chip = claudeReviewReproduceChip(this._host.reproduceState?.(item.id) ?? 'idle');
				if (chip) {
					const label = append(row, $(`span.claude-review-test-chip.is-${chip.tone}`));
					label.setAttribute('role', 'status');
					label.textContent = chip.key === 'sent'
						? localize('claudeReviewReproduceSent', "Sent")
						: chip.key === 'reproduced' ? localize('claudeReviewReproduced', "Reproduced") : localize('claudeReviewReproduceUnexpectedPass', "Passes Unexpectedly");
				}
				iconButton(row, Codicon.beaker, localize('claudeReviewFindingReproduce', "Reproduce with a Test"), () => reproduce(item.id), this._rows);
			}
			iconButton(row, Codicon.close, localize('claudeReviewFindingDismiss', "Dismiss"), () => this._host.dismiss(item.id), this._rows);
		}
	}

	/**
	 * One toggle chip per severity and per category (issue 921, DL-15). A severity
	 * chip sets the lowest severity shown; a category chip shows or hides its kind.
	 * Critical and security findings stay shown whatever the chips say.
	 */
	private renderFilters(filter: ClaudeReviewFilter): void {
		const chip = (label: string, pressed: boolean, run: () => void): void => {
			const button = append(this._filters, $<HTMLButtonElement>('button.claude-chip.is-toggle'));
			button.type = 'button';
			button.textContent = label;
			button.setAttribute('aria-pressed', String(pressed));
			this._rows.add(addDisposableListener(button, EventType.CLICK, run));
		};
		const order = CLAUDE_REVIEW_SEVERITIES.indexOf(filter.minSeverity);
		CLAUDE_REVIEW_SEVERITIES.forEach((severity, index) => chip(severityLabel(severity), index <= order, () => this._host.setFilter({ ...filter, minSeverity: severity })));
		append(this._filters, $('span.spacer'));
		for (const category of CLAUDE_REVIEW_CATEGORIES) {
			const on = filter.categories.includes(category);
			chip(categoryLabel(category), on, () => this._host.setFilter({ ...filter, categories: on ? filter.categories.filter(candidate => candidate !== category) : [...filter.categories, category] }));
		}
	}
}

/** Height a thread takes before it is measured. */
const ESTIMATED_THREAD_HEIGHT = 96;
/** Space above and below a thread inside its zone. */
const THREAD_MARGIN = 8;

/**
 * Puts each finding as a thread under its last line in the diff's modified
 * editor, and marks the lines in the gutter. The multi-diff editor creates and
 * reuses editors as files scroll in, so every model change places the threads again.
 */
export class ClaudeReviewFindingZones extends Disposable {
	private _findings: readonly ClaudeShownFinding[] = [];
	private readonly _shown = this._register(new DisposableMap<ICodeEditor, ClaudeEditorFindings>());
	private readonly _watched = this._register(new DisposableMap<string, IDisposable>());
	private readonly _scheduler = this._register(new RunOnceScheduler(() => this.update(), 0));

	constructor(
		private readonly _widget: MultiDiffEditorWidget,
		private readonly _host: ClaudeReviewFindingsHost,
		@ICodeEditorService codeEditors: ICodeEditorService,
	) {
		super();
		this._register(codeEditors.onCodeEditorAdd(editor => this.watch(editor)));
		this._register(codeEditors.onCodeEditorRemove(editor => {
			this._watched.deleteAndDispose(editor.getId());
			this._shown.deleteAndDispose(editor);
		}));
		for (const editor of codeEditors.listCodeEditors()) {
			this.watch(editor);
		}
	}

	/** Shows `findings` in place of the ones shown. */
	set(findings: readonly ClaudeShownFinding[]): void {
		this._findings = findings;
		this._scheduler.schedule();
	}

	private watch(editor: ICodeEditor): void {
		if (!this._watched.has(editor.getId())) {
			this._watched.set(editor.getId(), editor.onDidChangeModel(() => this._scheduler.schedule()));
			this._scheduler.schedule();
		}
	}

	private update(): void {
		const wanted = new Map<ICodeEditor, ClaudeShownFinding[]>();
		for (const item of sortClaudeShownFindings(this._findings)) {
			const editor = this._widget.tryGetCodeEditor(item.uri)?.editor;
			if (editor && editor.getModel()?.uri.toString() === item.uri.toString()) {
				const items = wanted.get(editor) ?? [];
				items.push(item);
				wanted.set(editor, items);
			}
		}
		for (const [editor, shown] of [...this._shown]) {
			const items = wanted.get(editor);
			if (!items || shown.key !== shownKey(editor, items)) {
				this._shown.deleteAndDispose(editor);
			}
		}
		for (const [editor, items] of wanted) {
			if (!this._shown.has(editor)) {
				this._shown.set(editor, new ClaudeEditorFindings(editor, items, this._host));
			}
		}
	}
}

function shownKey(editor: ICodeEditor, items: readonly ClaudeShownFinding[]): string {
	return `${editor.getModel()?.uri.toString()}|${items.map(item => item.id).join(',')}`;
}

/**
 * The threads and gutter marks of one editor; disposing removes them. The
 * Review editor and the commit review threads (issue 876) both use it.
 */
export class ClaudeEditorFindings implements IDisposable {
	readonly key: string;
	private readonly _store = new DisposableStore();
	private readonly _zones: string[] = [];
	private _collection: IEditorDecorationsCollection | undefined;

	constructor(private readonly _editor: ICodeEditor, private readonly _items: readonly ClaudeShownFinding[], host: ClaudeFindingThreadHost & Pick<ClaudeReviewFindingsHost, 'conversation'>, fixHint?: string) {
		this.key = shownKey(_editor, _items);
		const items = _items;
		const model = _editor.getModel();
		if (!model) {
			return;
		}
		const lineCount = model.getLineCount();
		const decorations: IModelDeltaDecoration[] = [];
		const ends: number[] = [];
		for (const item of items) {
			const start = Math.min(item.finding.startLine, lineCount);
			const end = Math.min(Math.max(item.finding.endLine, start), lineCount);
			ends.push(end);
			decorations.push({
				range: new Range(start, 1, end, 1),
				options: {
					description: 'claude-review-finding',
					isWholeLine: true,
					className: `claude-review-finding-line is-${item.finding.severity}`,
					linesDecorationsClassName: `claude-review-finding-gutter is-${item.finding.severity}`,
				},
			});
		}
		_editor.changeViewZones(accessor => {
			items.forEach((item, index) => {
				const domNode = $('.claude-review-finding-zone');
				const thread = append(domNode, renderClaudeFindingThread(item, host, this._store, fixHint, this.applier(model, item, index), host.conversation?.(item.id)));
				const measure = this._store.add(new MutableDisposable());
				const zone: IViewZone = {
					afterLineNumber: ends[index],
					heightInPx: ESTIMATED_THREAD_HEIGHT,
					domNode,
					// The editor leaves clicks alone here, so the buttons work.
					suppressMouseDown: true,
					onDomNodeTop: () => {
						measure.value = scheduleAtNextAnimationFrame(getWindow(domNode), () => this.resize(id, zone, getTotalHeight(thread) + 2 * THREAD_MARGIN));
					},
				};
				const id = accessor.addZone(zone);
				this._zones.push(id);
			});
		});
		const collection = this._collection = _editor.createDecorationsCollection(decorations);
		this._store.add(toDisposable(() => collection.clear()));
	}

	/** Apply Suggestion for one finding (issue 925): the lines are checked against what the review saw, then replaced in one undoable edit. */
	private applier(model: ITextModel, item: ClaudeShownFinding, index: number): ClaudeSuggestionApplier {
		const range = () => this._collection?.getRange(index);
		const linesOf = (start: number, end: number) => {
			const lines: string[] = [];
			for (let line = start; line <= end && line <= model.getLineCount(); line++) {
				lines.push(model.getLineContent(line));
			}
			return lines;
		};
		const seen = range() ?? new Range(item.finding.startLine, 1, item.finding.endLine, 1);
		const hash = claudeLinesHash(linesOf(seen.startLineNumber, seen.endLineNumber));
		const current = () => {
			const now = range();
			return now ? linesOf(now.startLineNumber, now.endLineNumber) : [];
		};
		return {
			onDidChange: Event.map(model.onDidChangeContent, () => undefined),
			lines: current,
			stale: () => claudeLinesHash(current()) !== hash,
			apply: () => {
				const now = range();
				const replacement = item.finding.suggestion?.replace(/(\r\n|\r|\n)$/, '');
				if (!now || replacement === undefined || claudeLinesHash(current()) !== hash) {
					return false;
				}
				const end = Math.min(now.endLineNumber, model.getLineCount());
				this._editor.pushUndoStop();
				this._editor.executeEdits('claude.review.applySuggestion', [{
					range: new Range(now.startLineNumber, 1, end, model.getLineMaxColumn(end)),
					text: replacement.replace(/\r\n|\r|\n/g, model.getEOL()),
				}]);
				this._editor.pushUndoStop();
				return true;
			},
			undo: () => {
				this._editor.focus();
				this._editor.trigger('claude.review.undoSuggestion', 'undo', null);
			},
		};
	}

	/** Where each finding's lines are now: the gutter marks move with edits above and inside them. */
	lines(): ReadonlyMap<string, { readonly startLine: number; readonly endLine: number }> {
		const lines = new Map<string, { readonly startLine: number; readonly endLine: number }>();
		this._items.forEach((item, index) => {
			const range = this._collection?.getRange(index);
			if (range) {
				lines.set(item.id, { startLine: range.startLineNumber, endLine: range.endLineNumber });
			}
		});
		return lines;
	}

	private resize(id: string, zone: IViewZone, height: number): void {
		if (height > 2 * THREAD_MARGIN && zone.heightInPx !== height) {
			zone.heightInPx = height;
			this._editor.changeViewZones(accessor => accessor.layoutZone(id));
		}
	}

	dispose(): void {
		this._store.dispose();
		const zones = this._zones.splice(0);
		if (zones.length > 0) {
			this._editor.changeViewZones(accessor => zones.forEach(id => accessor.removeZone(id)));
		}
	}
}
