/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getTotalHeight } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ClaudeReviewSummary } from '../../../../../platform/claude/common/claudeReviewLoop.js';
import { claudeReviewTestChip, ClaudeReviewTestState } from '../../../../../platform/claude/common/claudeReviewTests.js';

/** Where a proposed pull request description stands. */
export interface ClaudeReviewDescriptionState {
	/** `open` waits for Accept or Dismiss; `sent` went to the chat; `dismissed` can be undone. */
	status: 'open' | 'sent' | 'dismissed';
	/** Why the last Accept failed; the proposal stays open and shows it. */
	error?: string;
}

/** What the summary card shows besides the summary itself. */
export interface ClaudeReviewSummaryView {
	description: ClaudeReviewDescriptionState;
	/** False without a local folder: Accept is disabled and says why. */
	canAccept: boolean;
	collapsed: boolean;
	/** Where the test of each gap stands, by index in `summary.testGaps` (issue 936). */
	testStates?: readonly ClaudeReviewTestState[];
	/** Set while the summary is produced, or after it failed; the card then shows that instead of a summary. */
	state?: { readonly kind: 'loading' } | { readonly kind: 'failed'; readonly message: string };
}

/** What the summary card asks its editor to do. */
export interface ClaudeReviewSummaryHost {
	/** Puts the summary, with the proposed description, on the clipboard as Markdown. */
	copy(): void;
	/** Puts only the proposed description on the clipboard. */
	copyDescription(): void;
	/** Asks Claude to update the pull request description; the chat asks the person before `gh pr edit` runs. */
	applyDescription(description: string): void;
	/** Dismisses the proposal, or brings it back when `dismissed` is false. */
	setDescriptionDismissed(dismissed: boolean): void;
	/** Shows the chat the description went to. */
	openChat(): void;
	/** Opens a file of the summary at its first finding. */
	openFile(path: string): void;
	/** Collapses or expands the card; the editor remembers it. */
	setCollapsed(collapsed: boolean): void;
	/** Runs the review again after the summary failed. */
	retry(): void;
	/** Draws Mermaid text as the diagram block; `undefined` when it cannot be drawn, so the card hides it (issue 919). */
	drawDiagram(mermaid: string, store: DisposableStore): HTMLElement | undefined;
	/** Asks which kind of diagram to draw, then runs the review again with it (Redraw Diagram). */
	redrawDiagram(): void;
	/** Write Test (issue 936): sends the gap at `index` to the agent as a fixed template turn. */
	writeTest(index: number): void;
}

/** What `submitClaudeReviewDescription` needs from the chat. */
export interface ClaudeReviewDescriptionSink {
	openChat(): Promise<unknown>;
	submit(prompt: string): Promise<unknown>;
}

/**
 * Sends an accepted description to the chat. The proposal only becomes `sent` once the
 * prompt was submitted; a failure keeps it `open` with the error and returns the message
 * so the editor can notify (issue 1087). Never throws.
 */
export async function submitClaudeReviewDescription(state: ClaudeReviewDescriptionState, sink: ClaudeReviewDescriptionSink, prompt: string): Promise<string | undefined> {
	try {
		await sink.openChat();
		await sink.submit(prompt);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		state.status = 'open';
		state.error = message;
		return message;
	}
	state.status = 'sent';
	state.error = undefined;
	return undefined;
}

/**
 * The summary of a review pass (issue 918): an overview and one row per changed
 * file with its risk, above the findings. It is a card (DL-07) at the card
 * radius (DL-03). A proposed pull request description shows as its own block
 * and only goes anywhere after Accept. The card collapses (issue 1088) and its
 * list scrolls past a cap, so it never pushes the diff off a small window.
 */
export class ClaudeReviewSummaryCard extends Disposable {
	private readonly _node: HTMLElement;
	private readonly _rows = this._register(new DisposableStore());

	constructor(container: HTMLElement, private readonly _host: ClaudeReviewSummaryHost) {
		super();
		this._node = append(container, $('.claude-review-summary-card.is-empty'));
		this._node.setAttribute('role', 'region');
		this._node.setAttribute('aria-label', localize('claudeReviewSummaryRegion', "Review Summary"));
	}

	/** Height the card takes above the diff; 0 while it is hidden. */
	get height(): number {
		return this._node.classList.contains('is-empty') ? 0 : getTotalHeight(this._node);
	}

	private button(parent: HTMLElement, label: string, cls: string, run: () => void): HTMLButtonElement {
		const button = append(parent, $<HTMLButtonElement>(`button.claude-btn.is-small.${cls}`));
		button.type = 'button';
		button.textContent = label;
		this._rows.add(addDisposableListener(button, EventType.CLICK, run));
		return button;
	}

	/** Shows `summary`, or its loading or failed state; `undefined` without a state hides the card. */
	render(summary: ClaudeReviewSummary | undefined, showDescription: boolean, view: ClaudeReviewSummaryView): void {
		this._rows.clear();
		clearNode(this._node);
		if (view.state) {
			// Copy Summary and Accept wait for a summary: the card says why (issue 1078, DL-112).
			this._node.classList.remove('is-empty', 'is-collapsed');
			const row = append(this._node, $('.claude-review-summary-head'));
			const status = append(row, $('.claude-review-summary-state'));
			status.setAttribute('role', view.state.kind === 'failed' ? 'alert' : 'status');
			if (view.state.kind === 'loading') {
				append(status, $(`span${ThemeIcon.asCSSSelector(Codicon.loading)}.codicon-modifier-spin`));
				append(status, $('span')).textContent = localize('claudeReviewSummaryLoading', "Summarizing the changes...");
			} else {
				append(status, $(`span${ThemeIcon.asCSSSelector(Codicon.error)}`));
				append(status, $('span')).textContent = localize('claudeReviewSummaryFailed', "Could not summarize the changes: {0}", view.state.message);
				append(row, $('span.spacer'));
				this.button(row, localize('claudeReviewSummaryRetry', "Retry"), 'is-ghost', () => this._host.retry());
			}
			return;
		}
		this._node.classList.toggle('is-empty', !summary);
		this._node.classList.toggle('is-collapsed', !!summary && view.collapsed);
		if (!summary) {
			return;
		}
		const head = append(this._node, $('.claude-review-summary-head'));
		const toggle = append(head, $<HTMLButtonElement>('button.claude-review-summary-toggle'));
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', String(!view.collapsed));
		toggle.setAttribute('aria-label', view.collapsed
			? localize('claudeReviewSummaryExpand', "Expand Summary")
			: localize('claudeReviewSummaryCollapse', "Collapse Summary"));
		append(toggle, $(`span${ThemeIcon.asCSSSelector(view.collapsed ? Codicon.chevronRight : Codicon.chevronDown)}`));
		append(toggle, $('span.title')).textContent = summary.files.length > 0
			? localize('claudeReviewSummaryTitleCount', "Summary ({0} files)", summary.files.length)
			: localize('claudeReviewSummaryTitle', "Summary");
		this._rows.add(addDisposableListener(toggle, EventType.CLICK, () => this._host.setCollapsed(!view.collapsed)));
		append(head, $('span.spacer'));
		this.button(head, localize('claudeReviewCopySummary', "Copy Summary"), 'is-ghost', () => this._host.copy());
		if (view.collapsed) {
			return;
		}

		append(this._node, $('p.claude-review-summary-overview')).textContent = summary.overview;
		this.renderDiagram(summary);
		this.renderTestGaps(summary, view);
		this.renderTicketChecks(summary);
		if (summary.files.length > 0) {
			const list = append(this._node, $('ul.claude-review-summary-files'));
			list.setAttribute('aria-label', localize('claudeReviewSummaryFiles', "{0} files changed", summary.files.length));
			for (const file of summary.files) {
				const row = append(list, $('li'));
				const open = append(row, $<HTMLButtonElement>('button.path'));
				open.type = 'button';
				open.textContent = file.path;
				open.title = localize('claudeReviewSummaryOpenFile', "Open {0}", file.path);
				this._rows.add(addDisposableListener(open, EventType.CLICK, () => this._host.openFile(file.path)));
				const risk = append(row, $(`span.risk.is-${file.risk}`));
				risk.textContent = file.risk === 'high'
					? localize('claudeReviewRiskHigh', "High")
					: file.risk === 'medium' ? localize('claudeReviewRiskMedium', "Medium") : localize('claudeReviewRiskLow', "Low");
				risk.title = localize('claudeReviewRiskLegend', "How risky this change is: High needs a careful read, Low is routine");
				append(row, $('span.change')).textContent = file.change;
			}
		}
		if (showDescription && summary.description) {
			this.renderDescription(summary.description, view);
		}
	}

	/** The diagram of the change, when it draws; an invalid one is hidden, never shown as an error (issue 919). */
	private renderDiagram(summary: ClaudeReviewSummary): void {
		if (!summary.diagram) {
			return;
		}
		const drawn = this._host.drawDiagram(summary.diagram.mermaid, this._rows);
		if (!drawn) {
			return;
		}
		const block = append(this._node, $('.claude-review-summary-diagram'));
		block.appendChild(drawn);
		const actions = append(block, $('.actions'));
		this.button(actions, localize('claudeReviewRedrawDiagram', "Redraw Diagram"), 'is-ghost', () => this._host.redrawDiagram());
	}

	/** The test gaps, each with Write Test and the chip of its result (issue 936). DL-12: no gaps, no section. */
	private renderTestGaps(summary: ClaudeReviewSummary, view: ClaudeReviewSummaryView): void {
		const gaps = summary.testGaps;
		if (!gaps?.length) {
			return;
		}
		const section = append(this._node, $('.claude-review-summary-tests'));
		append(section, $('.label')).textContent = localize('claudeReviewTestGaps', "Test Gaps");
		const list = append(section, $('ul'));
		gaps.forEach((gap, index) => {
			const row = append(list, $('li'));
			append(row, $('span.symbol')).textContent = gap.symbol;
			append(row, $('span.case')).textContent = gap.caseDescription;
			const state = view.testStates?.[index] ?? 'idle';
			const chip = claudeReviewTestChip(state);
			if (chip) {
				const label = append(row, $(`span.claude-review-test-chip.is-${chip.tone}`));
				label.setAttribute('role', 'status');
				label.textContent = chip.key === 'sent'
					? localize('claudeReviewTestSent', "Sent")
					: chip.key === 'passed' ? localize('claudeReviewTestPassed', "Passed") : localize('claudeReviewTestFailed', "Failed");
			}
			const write = this.button(row, localize('claudeReviewWriteTest', "Write Test"), 'is-ghost', () => this._host.writeTest(index));
			write.title = localize('claudeReviewWriteTestHint', "Ask the agent to write this test in the repo's style and run it. Nothing is kept without Keep.");
			write.disabled = state === 'sent';
		});
	}

	/** The ticket checks: one list per ticket, each criterion with its status. DL-12: no checks, no section. */
	private renderTicketChecks(summary: ClaudeReviewSummary): void {
		const checks = summary.ticketChecks;
		if (!checks?.length) {
			return;
		}
		const section = append(this._node, $('.claude-review-summary-tickets'));
		append(section, $('.label')).textContent = localize('claudeReviewTicketChecks', "Ticket Checks");
		for (const ticket of new Set(checks.map(check => check.ticket))) {
			append(section, $('.ticket')).textContent = ticket;
			const list = append(section, $('ul'));
			for (const check of checks.filter(candidate => candidate.ticket === ticket)) {
				const row = append(list, $('li'));
				const status = append(row, $(`span.claude-review-ticket-status.is-${check.status}`));
				status.textContent = check.status === 'meets' ? localize('claudeReviewTicketMeets', "Meets") : check.status === 'missing' ? localize('claudeReviewTicketMissing', "Missing") : localize('claudeReviewTicketUnclear', "Unclear");
				append(row, $('span.criterion')).textContent = check.criterion;
				if (check.evidence) {
					append(row, $('span.evidence')).textContent = check.evidence;
				}
			}
		}
	}

	private renderDescription(description: string, view: ClaudeReviewSummaryView): void {
		const state = view.description;
		const proposal = append(this._node, $('.claude-review-summary-description'));
		if (state.status !== 'open') {
			const status = append(proposal, $('.status'));
			status.setAttribute('role', 'status');
			status.textContent = state.status === 'sent'
				? localize('claudeReviewDescriptionSent', "Sent to the chat. Claude asks before it edits the pull request.")
				: localize('claudeReviewDescriptionDismissed', "Description dismissed.");
			const actions = append(proposal, $('.actions'));
			if (state.status === 'sent') {
				this.button(actions, localize('claudeReviewDescriptionOpenChat', "Open Chat"), 'is-ghost', () => this._host.openChat());
			} else {
				this.button(actions, localize('claudeReviewDescriptionUndo', "Undo"), 'is-ghost', () => this._host.setDescriptionDismissed(false));
				this.button(actions, localize('claudeReviewCopyDescription', "Copy Description"), 'is-ghost', () => this._host.copyDescription());
			}
			return;
		}
		append(proposal, $('.label')).textContent = localize('claudeReviewDescriptionProposal', "Proposed Pull Request Description");
		append(proposal, $('pre.body')).textContent = description;
		if (state.error) {
			const error = append(proposal, $('.error'));
			error.setAttribute('role', 'alert');
			error.textContent = localize('claudeReviewDescriptionFailed', "Could not send the description to the chat: {0}", state.error);
		}
		const actions = append(proposal, $('.actions'));
		const accept = this.button(actions, localize('claudeReviewDescriptionAccept', "Accept"), 'is-primary', () => this._host.applyDescription(description));
		if (view.canAccept) {
			accept.title = localize('claudeReviewDescriptionAcceptHint', "Claude updates the pull request with gh pr edit; the chat asks you before it runs");
		} else {
			accept.disabled = true;
			accept.title = localize('claudeReviewDescriptionNoFolder', "Open a local folder to update the pull request");
		}
		this.button(actions, localize('claudeReviewDescriptionDismiss', "Dismiss"), 'is-ghost', () => this._host.setDescriptionDismissed(true));
		this.button(actions, localize('claudeReviewCopyDescription', "Copy Description"), 'is-ghost', () => this._host.copyDescription());
	}
}
