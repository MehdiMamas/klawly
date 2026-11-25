/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getActiveElement } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ClaudeGitHubReference } from '../../../../../platform/claude/common/claudeProtocol.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { renderPullRequestPill } from './claudeGitHubCard.js';
import { IClaudeGitHubDetailsService } from './claudeGitHubDetails.js';
import { ClaudeExecutionTargetInfo, claudeExecutionTargetPhrase } from '../../../../../platform/claude/common/claudeExecutionTarget.js';
import { claudeExecutionTargetIcon } from './claudeRunInPicker.js';

export interface ClaudeSessionTab {
	readonly id: string;
	readonly title: string;
	readonly running: boolean;
	/** The pull request the session created, shown as a pill after the title (issue 430). */
	readonly pullRequest?: ClaudeGitHubReference;
	/** Where Claude Code runs, as `session.started` reported it (issue 425). */
	readonly target?: ClaudeExecutionTargetInfo;
	/** What the agent last said about itself with klawly_status: a dot by kind, the text on hover (issue 1302, DL-113). */
	readonly status?: { readonly text: string; readonly kind: 'info' | 'attention' | 'done' };
}

/** Marks a drag that started on a tab of this strip, so only a tab reorders it. */
const TAB_REORDER_MIME = 'application/x-claude-tab-reorder';

export interface ClaudeSessionTabsHost {
	select(sessionId: string): void;
	/** The pull request pill: shows that session's pull request card. */
	openPullRequest(sessionId: string): void;
	close(sessionId: string): void;
	/** Fills the drag data when a tab is dragged into a composer. */
	dragStart(sessionId: string, event: DragEvent): void;
	/** Moves a tab before `beforeSessionId`, or to the end when that is undefined (issue 964). */
	reorder(sessionId: string, beforeSessionId: string | undefined): void;
	/** Opens the tab's context menu at the mouse. */
	contextMenu(sessionId: string, event: MouseEvent): void;
}

interface TabEntry {
	readonly element: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly where: HTMLElement;
	readonly dot: HTMLElement;
	readonly close: HTMLButtonElement;
	title: string;
	running: boolean;
	pullRequest: string | undefined;
	readonly pill: DisposableStore;
	/** "in dev container", "on build-box"; empty for a local session. */
	phrase: string;
	/** The agent's own status line for this tab, empty when none. */
	statusText: string;
	readonly store: DisposableStore;
	dispose(): void;
}

/**
 * Session tabs in the pane header. Each tab element is kept and patched in
 * place, so focus and hover survive a session change. Tabs that do not fit
 * scroll sideways, with the mouse wheel too, and fade at the edge (audit 13, #82).
 */
export class ClaudeSessionTabs extends Disposable {
	readonly element: HTMLElement;
	private readonly _entries = this._register(new DisposableMap<string, TabEntry>());
	private _order: readonly ClaudeSessionTab[] = [];
	private _currentId: string | undefined;
	private _width = 0;
	/** Ids, titles, spinners and the active id of the last update. */
	private _signature: string | undefined;

	constructor(
		container: HTMLElement,
		private readonly _host: ClaudeSessionTabsHost,
		@IHoverService private readonly _hovers: IHoverService,
		@IClaudeGitHubDetailsService private readonly _gitHubDetails: IClaudeGitHubDetailsService,
	) {
		super();
		this.element = append(container, $('.claude-tabs'));
		this.element.setAttribute('role', 'tablist');
		this.element.setAttribute('aria-label', localize('claudeSessions', "Agent sessions"));
		this._register(addDisposableListener(this.element, EventType.SCROLL, () => this.layout()));
		this._register(addDisposableListener(this.element, EventType.MOUSE_WHEEL, event => this.onWheel(event as WheelEvent), { passive: false }));
	}

	/** Patches the tabs to match `tabs`, in order, with `currentId` active. */
	update(tabs: readonly ClaudeSessionTab[], currentId: string | undefined): void {
		// The pane calls this on every streamed frame; when nothing a tab shows changed,
		// leave the strip alone so a user scrolling it is not pulled back to the active tab.
		const signature = JSON.stringify([currentId ?? null, tabs.map(tab => [tab.id, tab.title, tab.running, tab.pullRequest?.url ?? null, tab.target?.kind ?? null, tab.target?.label ?? null, tab.status?.kind ?? null, tab.status?.text ?? null])]);
		if (signature === this._signature) {
			return;
		}
		this._signature = signature;
		const active = getActiveElement();
		const focusedId = this.focusedTabId(active);
		const keep = new Set(tabs.map(tab => tab.id));
		let lostFocus = false;
		for (const [id, entry] of [...this._entries]) {
			if (!keep.has(id)) {
				lostFocus ||= !!active && entry.element.contains(active);
				entry.element.remove();
				this._entries.deleteAndDispose(id);
			}
		}
		tabs.forEach((tab, index) => {
			const entry = this._entries.get(tab.id) ?? this.createTab(tab);
			this.patch(entry, tab, tab.id === currentId);
			const at = this.element.children[index];
			if (at !== entry.element) {
				this.element.insertBefore(entry.element, at ?? null);
			}
		});
		this._order = tabs;
		this._currentId = currentId;
		if (lostFocus && currentId) {
			this._entries.get(currentId)?.element.focus();
		} else if (focusedId && !keep.has(focusedId) && currentId) {
			this._entries.get(currentId)?.element.focus();
		}
		// The active tab, a title or a spinner changed, and each can move or widen a tab; keep the active one in view (audit 13).
		this.revealCurrent();
		this.layout();
	}

	/** Updates the edge fades. Call after the header resizes. */
	layout(): void {
		const strip = this.element;
		const width = strip.clientWidth;
		if (width === 0) {
			return;
		}
		if (width !== this._width) {
			this._width = width;
			this.revealCurrent();
		}
		const left = strip.scrollLeft;
		strip.classList.toggle('is-clipped-start', left > 0);
		strip.classList.toggle('is-clipped-end', strip.scrollWidth - left - width > 1);
	}

	/** A vertical wheel scrolls the strip sideways; a sideways one scrolls it natively. */
	private onWheel(event: WheelEvent): void {
		const strip = this.element;
		if (strip.scrollWidth <= strip.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
			return;
		}
		event.preventDefault();
		strip.scrollLeft += event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
		this.layout();
	}

	private createTab(tab: ClaudeSessionTab): TabEntry {
		const store = new DisposableStore();
		const element = $('.claude-tab');
		element.setAttribute('role', 'tab');
		element.setAttribute('data-session-id', tab.id);
		element.tabIndex = 0;
		element.draggable = true;
		// Only a running session shows an icon (its spinner); an idle tab is just its title.
		const icon = append(element, $('span'));
		icon.hidden = true;
		const label = append(element, $('span.label'));
		// A session that runs Claude Code elsewhere names where, after its title.
		const where = append(element, $('span.claude-tab-target'));
		where.hidden = true;
		// The agent's own status (klawly_status): a dot coloured by kind, its text on hover (DL-113).
		const dot = append(element, $('span.claude-tab-status'));
		dot.hidden = true;
		const close = append(element, $<HTMLButtonElement>('button.claude-icon-btn'));
		close.type = 'button';
		append(close, $(ThemeIcon.asCSSSelector(Codicon.closeCompact)));
		const pill = store.add(new DisposableStore());
		const entry: TabEntry = { element, icon, label, where, dot, close, title: '', running: false, pullRequest: undefined, pill, phrase: '', statusText: '', store, dispose: () => store.dispose() };
		store.add(addDisposableListener(element, 'dragstart', event => {
			(event as DragEvent).dataTransfer?.setData(TAB_REORDER_MIME, tab.id);
			this._host.dragStart(tab.id, event as DragEvent);
		}));
		// Issue 964: dropping a tab on another tab moves it before or after that tab (DL-101).
		store.add(addDisposableListener(element, 'dragover', event => {
			const drag = event as DragEvent;
			if (!drag.dataTransfer?.types.includes(TAB_REORDER_MIME)) {
				return;
			}
			drag.preventDefault();
			drag.dataTransfer.dropEffect = 'move';
			this.showDropMarker(element, this.dropsAfter(element, drag));
		}));
		store.add(addDisposableListener(element, 'dragleave', () => this.clearDropMarker(element)));
		store.add(addDisposableListener(element, 'dragend', () => this.clearDropMarker()));
		store.add(addDisposableListener(element, 'drop', event => {
			const drag = event as DragEvent;
			const dragged = drag.dataTransfer?.getData(TAB_REORDER_MIME);
			this.clearDropMarker();
			if (!dragged) {
				return;
			}
			drag.preventDefault();
			const after = this.dropsAfter(element, drag);
			const at = this._order.findIndex(candidate => candidate.id === tab.id);
			this._host.reorder(dragged, after ? this._order[at + 1]?.id : tab.id);
		}));
		store.add(addDisposableListener(element, EventType.CONTEXT_MENU, event => {
			event.preventDefault();
			event.stopPropagation();
			this._host.contextMenu(tab.id, event);
		}));
		store.add(addDisposableListener(element, EventType.CLICK, event => {
			if (event.target instanceof Node && close.contains(event.target)) {
				return;
			}
			this._host.select(tab.id);
		}));
		// Issue 701: a middle click closes the tab, as on editor and terminal tabs. Holding the
		// button down must not start the browser's autoscroll.
		store.add(addDisposableListener(element, EventType.MOUSE_DOWN, event => {
			if (event.button === 1) {
				event.preventDefault();
			}
		}));
		store.add(addDisposableListener(element, EventType.AUXCLICK, event => {
			if (event.button === 1) {
				event.preventDefault();
				event.stopPropagation();
				this._host.close(tab.id);
			}
		}));
		store.add(addDisposableListener(element, EventType.KEY_DOWN, event => {
			if (event.target instanceof Node && close.contains(event.target)) {
				return;
			}
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				this._host.select(tab.id);
			} else if (event.key === 'Delete') {
				event.preventDefault();
				this._host.close(tab.id);
			} else if (event.altKey && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
				// Issue 964: Alt+Arrow moves the tab one place, the keyboard twin of dragging it.
				event.preventDefault();
				const at = this._order.findIndex(candidate => candidate.id === tab.id);
				if (event.key === 'ArrowLeft' && at > 0) {
					this._host.reorder(tab.id, this._order[at - 1].id);
				} else if (event.key === 'ArrowRight' && at >= 0 && at < this._order.length - 1) {
					this._host.reorder(tab.id, this._order[at + 2]?.id);
				}
			} else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
				event.preventDefault();
				this.focusSibling(tab.id, event.key === 'ArrowRight' ? 1 : -1);
			}
		}));
		store.add(addDisposableListener(close, EventType.CLICK, event => {
			event.preventDefault();
			event.stopPropagation();
			this._host.close(tab.id);
		}));
		store.add(this._hovers.setupDelayedHover(element, () => ({ content: [entry.phrase ? localize('claudeTabHoverTarget', "{0} ({1})", entry.title, entry.phrase) : entry.title, entry.statusText].filter(Boolean).join('\n'), additionalClasses: ['claude-root'] }), { groupId: 'claude-tabs' }));
		// The close button has its own hover; keep the tab's title hover from replacing it.
		store.add(addDisposableListener(close, EventType.MOUSE_OVER, event => event.stopPropagation()));
		store.add(this._hovers.setupDelayedHover(close, () => ({ content: localize('claudeCloseSession', "Close {0}", entry.title), additionalClasses: ['claude-root'] }), { groupId: 'claude-tabs' }));
		this._entries.set(tab.id, entry);
		return entry;
	}

	/** True when the pointer is on the right half of `element`. */
	private dropsAfter(element: HTMLElement, event: DragEvent): boolean {
		const rect = element.getBoundingClientRect();
		return event.clientX > rect.left + rect.width / 2;
	}

	private showDropMarker(element: HTMLElement, after: boolean): void {
		this.clearDropMarker(undefined, element);
		element.classList.add(after ? 'drop-after' : 'drop-before');
	}

	private clearDropMarker(only?: HTMLElement, except?: HTMLElement): void {
		for (const marked of only ? [only] : Array.from(this.element.querySelectorAll('.drop-before, .drop-after'))) {
			if (marked !== except) {
				marked.classList.remove('drop-before', 'drop-after');
			}
		}
	}

	private patch(entry: TabEntry, tab: ClaudeSessionTab, active: boolean): void {
		if (entry.title !== tab.title) {
			entry.title = tab.title;
			entry.label.textContent = tab.title;
			entry.close.setAttribute('aria-label', localize('claudeCloseSession', "Close {0}", tab.title));
		}
		if (entry.running !== tab.running) {
			entry.running = tab.running;
			entry.icon.className = tab.running ? ThemeIcon.asClassName(ThemeIcon.modify(Codicon.loading, 'spin')) : '';
			entry.icon.hidden = !tab.running;
		}
		if (entry.pullRequest !== tab.pullRequest?.url) {
			entry.pullRequest = tab.pullRequest?.url;
			entry.pill.clear();
			if (tab.pullRequest) {
				const pill = renderPullRequestPill(entry.element, tab.pullRequest, { sessionId: tab.id, details: this._gitHubDetails, hover: this._hovers }, () => this._host.openPullRequest(tab.id), entry.pill);
				entry.element.insertBefore(pill, entry.close);
				entry.pill.add(toDisposable(() => pill.remove()));
				entry.pill.add(addDisposableListener(pill, EventType.KEY_DOWN, event => event.stopPropagation()));
			}
		}
		const phrase = claudeExecutionTargetPhrase(tab.target) ?? '';
		if (entry.phrase !== phrase) {
			entry.phrase = phrase;
			entry.where.className = tab.target ? `claude-tab-target ${ThemeIcon.asClassName(claudeExecutionTargetIcon(tab.target.kind))}` : 'claude-tab-target';
			entry.where.hidden = !phrase;
		}
		const statusText = tab.status?.text ?? '';
		if (entry.statusText !== statusText || entry.dot.dataset.kind !== tab.status?.kind) {
			entry.statusText = statusText;
			entry.dot.hidden = !tab.status;
			entry.dot.dataset.kind = tab.status?.kind ?? '';
		}
		entry.element.classList.toggle('is-active', active);
		entry.element.setAttribute('aria-selected', String(active));
		const named = phrase ? localize('claudeTabHoverTarget', "{0} ({1})", tab.title, phrase) : tab.title;
		const labelled = tab.running ? localize('claudeTabRunning', "{0}, running", named) : named;
		entry.element.setAttribute('aria-label', statusText ? localize('claudeTabStatus', "{0}: {1}", labelled, statusText) : labelled);
	}

	/** The tab's span inside the strip's scrolled content. */
	private extent(entry: TabEntry): { start: number; end: number } {
		const strip = this.element.getBoundingClientRect();
		const tab = entry.element.getBoundingClientRect();
		const start = tab.left - strip.left + this.element.scrollLeft;
		return { start, end: start + tab.width };
	}

	private focusedTabId(active: Element | null): string | undefined {
		for (const [id, entry] of this._entries) {
			if (active && entry.element.contains(active)) {
				return id;
			}
		}
		return undefined;
	}

	private focusSibling(id: string, delta: number): void {
		const index = this._order.findIndex(tab => tab.id === id);
		const next = this._order[index + delta];
		if (next) {
			this._entries.get(next.id)?.element.focus();
		}
	}

	/** Scrolls the strip so the active tab is fully visible. */
	private revealCurrent(): void {
		const entry = this._currentId ? this._entries.get(this._currentId) : undefined;
		const strip = this.element;
		if (!entry || strip.clientWidth === 0) {
			return;
		}
		const { start, end } = this.extent(entry);
		if (start < strip.scrollLeft) {
			strip.scrollLeft = start;
		} else if (end > strip.scrollLeft + strip.clientWidth) {
			strip.scrollLeft = end - strip.clientWidth;
		}
	}
}
