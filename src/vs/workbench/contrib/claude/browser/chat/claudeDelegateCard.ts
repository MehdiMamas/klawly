/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { renderAsPlaintext } from '../../../../../base/browser/markdownRenderer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { IntervalTimer } from '../../../../../base/common/async.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ClaudeDelegateCard, ClaudeDelegateState, claudeEscalationSentence } from '../../../../services/claude/common/claudeDelegationModel.js';
import { ClaudeDelegateTier } from '../../../../../platform/claude/common/claudeDelegateContract.js';
import { formatElapsed } from '../../../../services/claude/common/claudeToolCards.js';
import { claudeEffortLabel } from '../../common/claudeModelControls.js';
import { ClaudeAutoStatusState, claudeAutoStatus } from '../../common/claudeAutoStatus.js';

/**
 * The Auto status a card shows (DL-109, #1307), or undefined for a stopped card: Waiting for you while the helper
 * needs an answer, Limit reached once its budget stopped it, else Working, Done or Failed.
 */
export function claudeDelegateAutoState(card: Pick<ClaudeDelegateCard, 'waiting' | 'budgetState'>, state: ClaudeDelegateState): ClaudeAutoStatusState | undefined {
	if (state === 'running' && card.waiting) {
		return 'waiting';
	}
	if (card.budgetState === 'stop' && (state === 'running' || state === 'failed')) {
		return 'guard';
	}
	return state === 'running' ? 'working' : state === 'done' || state === 'failed' ? state : undefined;
}

/** What the buttons on a delegate card do (issue 693). */
export interface ClaudeDelegateCardActions {
	/** Opens the read-only delegated chat. */
	open(childSessionId: string): void;
	/** Stops the delegated chat and every chat under it. */
	stop(cardId: string): void;
	/** Sends the stopped task to the top-level chat again. Only offered after the user kept Auto. */
	rerun(cardId: string): void;
	/** Failed card: sends the task again (DL-109). Offered only when the surface wires it. */
	retry?(cardId: string): void;
	/** Failed card: sends the task again on Opus. Not offered once Opus was tried. */
	retryOnOpus?(cardId: string): void;
	/** Failed card: opens the delegated chat's log. */
	openLog?(childSessionId: string): void;
	/** Shows the full text in a hover over the element. */
	hover?(target: HTMLElement, content: string): IDisposable;
}

const RESULT_LINES = 3;

/**
 * DL-71: a delegated chat is a card in its parent's turn: the task as its
 * title, "Model · effort" and how long it ran, its state as a tone in the icon
 * and one word, and the start of its answer. Open Chat reads the whole chat;
 * Stop sits on the card while it works. Chats it delegated to nest under it.
 * `parentRunning` false paints a card still marked running as stopped: the
 * turn that started it ended without it.
 */
export function renderClaudeDelegateCard(parent: HTMLElement, card: ClaudeDelegateCard, parentRunning: boolean, actions: ClaudeDelegateCardActions, store: DisposableStore, now = Date.now()): HTMLElement {
	const state: ClaudeDelegateState = card.state === 'running' && !parentRunning ? 'stopped' : card.state;
	const element = append(parent, $(`.claude-delegate.is-${state}`));
	element.setAttribute('data-delegate-id', card.id);
	element.setAttribute('role', 'group');
	// DL-109: a helper reads with the same plain words, model and cost as the Auto strip, in all five states of #1307.
	const autoState = claudeDelegateAutoState(card, state);
	const mapped = autoState
		? claudeAutoStatus({ state: autoState, modelLabel: card.modelLabel, costUsd: card.costUsd, question: card.waitingQuestion, guard: 'cost', reason: card.message, hasLog: !!actions.openLog, opusTried: card.modelLabel === 'Opus', filesChanged: 0 })
		: undefined;
	const attention = autoState === 'waiting' || autoState === 'guard' ? autoState : undefined;
	if (attention) {
		element.classList.add(`is-${attention}`);
	}
	const stateText = attention && mapped ? mapped.label : claudeDelegateStateLabel(state, !!card.stoppedByUser);
	element.setAttribute('aria-label', mapped && state !== 'done'
		? localize('claudeDelegateCardStatusLabel', "Delegated to {0}: {1}. {2}", card.modelLabel, card.title, mapped.aria)
		: localize('claudeDelegateCardLabel', "Delegated to {0}: {1}, {2}", card.modelLabel, card.title, stateText));

	const head = append(element, $('.claude-delegate-head'));
	const icon = attention === 'waiting' ? Codicon.bellDot : attention === 'guard' ? Codicon.warning : state === 'running' ? Codicon.loading : state === 'failed' ? Codicon.error : state === 'stopped' ? Codicon.debugStop : Codicon.check;
	append(head, $(ThemeIcon.asCSSSelector(icon) + (state === 'running' && !attention ? '.codicon-modifier-spin' : '') + '.status'));
	const body = append(head, $('.body'));
	const title = append(body, $('span.title'));
	// DL-71: the kind word leads, as on subagent and command rows, so a worker never reads as a subagent (issue 1258).
	append(title, $('span.kind')).textContent = localize('claudeDelegateKind', "Worker");
	title.append(' ', card.title);
	if (card.routeReason?.trim()) {
		// DL-16 secondary role: why the router sent it to this model, one muted line; the hover holds all of it (issue 987).
		const reason = append(body, $('span.reason'));
		reason.textContent = localize('claudeDelegateRouteReason', "{0}: {1}", card.modelLabel, card.routeReason.trim());
		const full = card.routeWhy ? localize('claudeDelegateRouteReasonFull', "{0} ({1})", reason.textContent, card.routeWhy) : reason.textContent;
		if (actions.hover) {
			store.add(actions.hover(reason, full));
		}
	}
	const meta = append(body, $('span.meta'));
	meta.textContent = claudeDelegateMeta(card, now);
	if (card.endedAt === undefined && card.state === 'running') {
		// The time ticks while the helper works; it stops at the end (issue 730).
		const timer = new IntervalTimer();
		timer.cancelAndSet(() => { meta.textContent = claudeDelegateMeta(card, Date.now()); }, 1000);
		store.add(timer);
	}
	append(head, $('span.state')).textContent = stateText;

	const contract = append(element, $('.claude-delegate-contract'));
	appendContractLine(contract, localize('claudeDelegateObjective', "Objective"), card.objective);
	appendContractLine(contract, localize('claudeDelegateAcceptance', "Done when"), card.acceptance);
	const budget = claudeDelegateBudgetText(card);
	if (budget) {
		const line = appendContractLine(contract, localize('claudeDelegateBudget', "Budget"), budget);
		line.classList.toggle('is-notice', card.budgetState === 'notice');
		line.classList.toggle('is-stop', card.budgetState === 'stop');
	}
		// DL-105: each move up a tier is a line on the card, with its cause and count.
	for (const escalation of card.escalations ?? []) {
		appendContractLine(contract, localize('claudeDelegateMovedUp', "Moved up"), claudeEscalationSentence(escalation));
	}
	if (!contract.hasChildNodes()) {
		contract.remove();
	} else if (state !== 'running') {
		// A finished worker folds its contract behind a toggle so the card is as quiet as a background command row (issue 1260).
		contract.classList.add('is-folded');
		const toggle = append(head, $<HTMLButtonElement>('button.claude-delegate-toggle'));
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', 'false');
		toggle.setAttribute('aria-label', localize('claudeDelegateDetailsNamed', "Show the Contract of the Delegated Chat: {0}", card.title));
		append(toggle, $(ThemeIcon.asCSSSelector(Codicon.chevronRight)));
		store.add(addDisposableListener(toggle, EventType.CLICK, () => {
			const open = contract.classList.toggle('is-folded') === false;
			toggle.setAttribute('aria-expanded', String(open));
			toggle.classList.toggle('is-open', open);
		}));
	}

	if (card.quiet && state !== 'running') {
		append(element, $('.claude-delegate-result.is-quiet')).textContent = localize('claudeDelegateQuietText', "Nothing to report.");
	} else if (card.report?.trim() && state !== 'running') {
		// A report is at most 300 words: it wraps in full instead of being cut to lines.
		append(element, $('.claude-delegate-result.is-report')).textContent = card.report.trim();
	} else if (state === 'done' && card.result?.trim()) {
		append(element, $('.claude-delegate-result')).textContent = firstLines(card.result, RESULT_LINES);
	} else if (state === 'failed') {
		// DL-109: Failed always says why.
		append(element, $('.claude-delegate-result.is-error')).textContent = (attention ? card.message : undefined) ?? mapped?.detail ?? card.message ?? null;
	}

	if (state !== 'running') {
		// The card always ends on its outcome, even when the head has scrolled away (issue 1260).
		append(element, $('.claude-delegate-end')).textContent = stateText;
	}

	const foot = append(element, $('.claude-delegate-actions'));
	const open = append(foot, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
	open.type = 'button';
	open.textContent = localize('claudeDelegateOpen', "Open Chat");
	open.setAttribute('aria-label', localize('claudeDelegateOpenNamed', "Open the Delegated Chat: {0}", card.title));
	store.add(addDisposableListener(open, EventType.CLICK, () => actions.open(card.childSessionId)));
	if (state === 'running') {
		const stop = append(foot, $<HTMLButtonElement>('button.claude-btn.is-small.is-secondary'));
		stop.type = 'button';
		stop.textContent = localize('claudeDelegateStop', "Stop");
		stop.setAttribute('aria-label', localize('claudeDelegateStopNamed', "Stop the Delegated Chat: {0}", card.title));
		store.add(addDisposableListener(stop, EventType.CLICK, event => {
			event.preventDefault();
			actions.stop(card.id);
		}));
	} else if (state === 'failed' && mapped) {
		// DL-109: Retry on Opus is the main action; Retry and Open Log follow when wired.
		const handlers: Partial<Record<string, () => void>> = {
			retry: actions.retry && (() => actions.retry!(card.id)),
			retryOnOpus: actions.retryOnOpus && (() => actions.retryOnOpus!(card.id)),
			openLog: actions.openLog && (() => actions.openLog!(card.childSessionId)),
		};
		for (const entry of mapped.actions) {
			const run = handlers[entry.id];
			if (!run) {
				continue;
			}
			const button = append(foot, $<HTMLButtonElement>(entry.primary ? 'button.claude-btn.is-small.is-primary' : 'button.claude-btn.is-small.is-secondary'));
			button.type = 'button';
			button.textContent = entry.label;
			button.setAttribute('aria-label', localize('claudeDelegateActionNamed', "{0}: {1}", entry.label, card.title));
			store.add(addDisposableListener(button, EventType.CLICK, run));
		}
	} else if (card.rerun) {
		const rerun = append(foot, $<HTMLButtonElement>('button.claude-btn.is-small.is-secondary'));
		rerun.type = 'button';
		rerun.textContent = localize('claudeDelegateRerun', "Rerun");
		rerun.setAttribute('aria-label', localize('claudeDelegateRerunNamed', "Rerun the Stopped Task: {0}", card.title));
		store.add(addDisposableListener(rerun, EventType.CLICK, () => actions.rerun(card.id)));
	}

	if (card.children.length > 0) {
		const nested = append(element, $('.claude-delegate-children'));
		for (const child of card.children) {
			renderClaudeDelegateCard(nested, child, state === 'running', actions, store, now);
		}
	}
	return element;
}

/** "Working", "Done", "Stopped by you", "Stopped" or "Failed". */
export function claudeDelegateStateLabel(state: ClaudeDelegateState, stoppedByUser: boolean): string {
	switch (state) {
		case 'running': return localize('claudeDelegateWorking', "Working");
		case 'done': return localize('claudeDelegateDone', "Done");
		case 'failed': return localize('claudeDelegateFailed', "Failed");
		default: return stoppedByUser ? localize('claudeDelegateStoppedByYou', "Stopped by you") : localize('claudeDelegateStopped', "Stopped");
	}
}

/** "Sonnet · High · 12s · $0.04": the model, the effort when set, and once it ended how long it ran and what it cost. */
export function claudeDelegateMeta(card: Pick<ClaudeDelegateCard, 'modelLabel' | 'tier' | 'effort' | 'startedAt' | 'endedAt' | 'costUsd'>, now: number): string {
	const parts = [card.modelLabel];
	if (card.tier) {
		parts.push(claudeDelegateTierLabel(card.tier));
	}
	if (card.effort) {
		parts.push(claudeEffortLabel(card.effort));
	}
	parts.push(formatElapsed(card.startedAt, card.endedAt ?? now, now));
	if (card.costUsd !== undefined && card.costUsd > 0) {
		parts.push(`$${card.costUsd.toFixed(2)}`);
	}
	return parts.join(' · ');
}

function appendContractLine(parent: HTMLElement, label: string, text: string | undefined): HTMLElement {
	const line = append(parent, $('.claude-delegate-contract-line'));
	if (!text?.trim()) {
		line.remove();
		return line;
	}
	append(line, $('span.label')).textContent = label;
	append(line, $('span.text')).textContent = text.trim();
	return line;
}

/** "Small tier", "Medium tier" or "Large tier". */
export function claudeDelegateTierLabel(tier: ClaudeDelegateTier): string {
	switch (tier) {
		case 'small': return localize('claudeDelegateTierSmall', "Small tier");
		case 'large': return localize('claudeDelegateTierLarge', "Large tier");
		default: return localize('claudeDelegateTierMedium', "Medium tier");
	}
}

/** "$0.04 of $0.50 · 12 of 40 calls", or undefined when the worker has no budget. */
export function claudeDelegateBudgetText(card: Pick<ClaudeDelegateCard, 'budget' | 'costUsd' | 'callsUsed'>): string | undefined {
	const parts: string[] = [];
	if (card.budget?.usd) {
		parts.push(localize('claudeDelegateBudgetUsd', "${0} of ${1}", (card.costUsd ?? 0).toFixed(2), card.budget.usd.toFixed(2)));
	}
	if (card.budget?.calls) {
		parts.push(localize('claudeDelegateBudgetCalls', "{0} of {1} calls", card.callsUsed ?? 0, card.budget.calls));
	}
	return parts.length ? parts.join(' · ') : undefined;
}

/** The answer's first `count` lines as plain text, without Markdown syntax. */
function firstLines(text: string, count: number): string {
	const lines = text.trim().split(/\r?\n/)
		.map(line => renderAsPlaintext(new MarkdownString(line), { omitMarkdownSyntax: true }).trim())
		.filter(line => line.length > 0);
	const shown = lines.slice(0, count).join('\n');
	return lines.length > count ? `${shown}…` : shown;
}
