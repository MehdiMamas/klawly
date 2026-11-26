/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode, EventType, addDisposableListener } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { claudeAllowRule } from '../../../../platform/claude/common/claudeConversation.js';
import { ClaudeAgent, ClaudeAgentRow, ClaudeAgentStatus, claudeGroupStatusLine, claudeGroupTitle, ClaudeNeedsYouItem } from '../../../../platform/claude/common/claudeAgents.js';
import { IClaudeAgentsService } from '../../../services/claude/browser/claudeAgentsService.js';

function sectionTitle(status: ClaudeAgentStatus): string {
	switch (status) {
		case 'needsYou': return localize('claude.agents.section.needsYou', "NEEDS YOU");
		case 'running': return localize('claude.agents.section.running', "RUNNING");
		case 'done': return localize('claude.agents.section.done', "DONE");
	}
}

function waited(since: number): string {
	return localize('claude.agents.waiting', "waiting {0} min", Math.max(1, Math.round((Date.now() - since) / 60000)));
}

/**
 * The Agents list of v5-S25 and the Needs you list of v5-S26, in the column left of the chat. Rows are rebuilt from
 * {@link IClaudeAgentsService} on every change, so the list and the pane's own cards always show the same state.
 */
export class ClaudeAgentsList extends Disposable {

	private query = '';
	private readonly rows = this._register(new MutableDisposable<DisposableStore>());
	private readonly ticker = this._register(new IntervalTimer());
	private search: HTMLInputElement | undefined;

	constructor(
		private readonly parent: HTMLElement,
		private readonly service: IClaudeAgentsService,
		private readonly hoverService: IHoverService,
		/** Called after a row selected an agent, so the pane can focus its composer. */
		private readonly onDidSelect: () => void,
	) {
		super();
		this.ticker.cancelAndSet(() => this.render(), 15000);
		this.render();
	}

	render(): void {
		const store = new DisposableStore();
		this.rows.value = store;
		const focused = this.search && this.parent.ownerDocument.activeElement === this.search;
		clearNode(this.parent);
		this.parent.classList.toggle('hidden', !this.service.listVisible);
		if (this.service.needsYouOpen) {
			this.renderNeedsYou(store);
		} else {
			this.renderAgents(store);
		}
		if (focused && this.search) {
			this.search.focus();
			this.search.setSelectionRange(this.query.length, this.query.length);
		}
	}

	private renderAgents(store: DisposableStore): void {
		const head = append(this.parent, $('.claude-agents-head'));
		const add = append(head, $('button.claude-button.claude-primary.claude-new-agent')) as HTMLButtonElement;
		append(add, $('span' + ThemeIcon.asCSSSelector(Codicon.add)));
		append(add, $('span')).textContent = localize('claude.agents.newAgent', "New agent");
		store.add(addDisposableListener(add, EventType.CLICK, () => { this.service.create(); this.onDidSelect(); }));
		const search = this.search = append(head, $('input.claude-agents-search')) as HTMLInputElement;
		search.type = 'search';
		search.placeholder = localize('claude.agents.search', "Search agents");
		search.setAttribute('aria-label', localize('claude.agents.search', "Search agents"));
		search.value = this.query;
		store.add(addDisposableListener(search, EventType.INPUT, () => { this.query = search.value; this.render(); }));

		const needs = this.service.needsYou();
		if (needs.length) {
			const entry = append(this.parent, $('button.claude-needs-entry')) as HTMLButtonElement;
			append(entry, $('span' + ThemeIcon.asCSSSelector(Codicon.bell)));
			append(entry, $('span')).textContent = localize('claude.agents.needsYouEntry', "Needs you · {0}", needs.length);
			store.add(addDisposableListener(entry, EventType.CLICK, () => this.service.setNeedsYouOpen(true)));
		}

		const list = append(this.parent, $('.claude-agents-rows'));
		const sections = this.service.sections(this.query);
		if (!sections.length) {
			append(list, $('.claude-agents-none')).textContent = this.query ? localize('claude.agents.noMatch', "No agent matches") : localize('claude.agents.none', "No agents yet");
		}
		for (const section of sections) {
			append(list, $('.claude-section-title')).textContent = sectionTitle(section.status);
			section.rows.forEach(row => this.renderRow(list, row, store));
		}
	}

	private renderRow(parent: HTMLElement, row: ClaudeAgentRow, store: DisposableStore): void {
		const now = Date.now();
		const title = row.kind === 'agent' ? row.agent.title : claudeGroupTitle(row.group);
		const line = row.kind === 'agent' ? row.agent.statusLine(now) : claudeGroupStatusLine(row.group);
		const selected = row.kind === 'agent' ? this.service.selected === row.agent && !this.service.selectedGroup : this.service.selectedGroup === row.group;
		const button = append(parent, $('button.claude-agent-row')) as HTMLButtonElement;
		button.classList.toggle('selected', selected);
		button.setAttribute('aria-current', String(selected));
		append(button, $('span.claude-agent-title')).textContent = title;
		append(button, $('span.claude-agent-status')).textContent = line;
		// the title is cut with an ellipsis at the end only; the whole title is on hover (D08)
		store.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), button, title));
		store.add(addDisposableListener(button, EventType.CLICK, () => {
			if (row.kind === 'agent') {
				this.service.select(row.agent);
			} else {
				this.service.selectGroup(row.group);
			}
			this.onDidSelect();
		}));
	}

	private renderNeedsYou(store: DisposableStore): void {
		const items = this.service.needsYou();
		const head = append(this.parent, $('.claude-agents-head'));
		const back = append(head, $('button.claude-button.claude-ghost.claude-needs-back')) as HTMLButtonElement;
		append(back, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronLeft)));
		append(back, $('span')).textContent = localize('claude.agents.back', "Agents");
		store.add(addDisposableListener(back, EventType.CLICK, () => this.service.setNeedsYouOpen(false)));
		append(head, $('.claude-needs-title')).textContent = localize('claude.agents.needsYouTitle', "Needs you · {0}", items.length);
		const list = append(this.parent, $('.claude-agents-rows'));
		if (!items.length) {
			append(list, $('.claude-agents-none')).textContent = localize('claude.agents.needsNothing', "Nothing needs you");
		}
		for (const item of items) {
			this.renderNeed(list, item, store);
		}
	}

	private renderNeed(parent: HTMLElement, item: ClaudeNeedsYouItem, store: DisposableStore): void {
		const card = append(parent, $('.claude-need'));
		card.setAttribute('role', 'group');
		const buttons = (): HTMLElement => append(card, $('.claude-permission-buttons'));
		const button = (row: HTMLElement, text: string, className: string, run: () => void) => {
			const element = append(row, $('button.claude-button' + className)) as HTMLButtonElement;
			element.textContent = text;
			store.add(addDisposableListener(element, EventType.CLICK, run));
		};
		const select = (agent: ClaudeAgent) => { this.service.select(agent); this.onDidSelect(); };
		switch (item.kind) {
			case 'permission': {
				const input = item.card.input;
				const title = item.card.toolName === 'Bash' && typeof input.command === 'string' ? localize('claude.needs.run', "Run {0}?", input.command) : localize('claude.needs.use', "Allow {0} {1}?", item.card.toolName, item.card.target).trim();
				append(card, $('.claude-need-title')).textContent = title;
				append(card, $('.claude-need-sub')).textContent = `${item.agent.title} · ${waited(item.card.askedAt)}`;
				const row = buttons();
				button(row, localize('claude.permission.allow', "Allow once"), '.claude-primary', () => this.service.answerPermission(item.agent, item.card, true));
				button(row, localize('claude.needs.always', "Always allow"), '', () => this.service.answerPermission(item.agent, item.card, true, { always: true }));
				button(row, localize('claude.permission.deny', "Deny"), '.claude-ghost', () => this.service.answerPermission(item.agent, item.card, false));
				store.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), row.children[1] as HTMLElement, localize('claude.permission.always', "Always allow {0}", claudeAllowRule(item.card.toolName, input).label)));
				break;
			}
			case 'question':
				append(card, $('.claude-need-title')).textContent = item.question;
				append(card, $('.claude-need-sub')).textContent = `${item.agent.title} · ${waited(item.card.askedAt)}`;
				button(buttons(), localize('claude.needs.answer', "Answer"), '.claude-primary', () => select(item.agent));
				break;
			case 'limit':
				append(card, $('.claude-need-title')).textContent = item.resetsAt
					? localize('claude.needs.limit', "Usage limit resets {0}", new Date(item.resetsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))
					: localize('claude.needs.limit.unknown', "Usage limit reached");
				append(card, $('.claude-need-sub')).textContent = localize('claude.needs.paused', "{0} agents paused until the limit resets", item.agents.length);
				button(buttons(), localize('claude.needs.details', "Details"), '', () => select(item.agents[0]));
				break;
		}
	}
}
