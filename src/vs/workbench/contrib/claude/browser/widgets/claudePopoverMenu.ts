/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getActiveElement, getWindow, isHTMLElement, isSVGElement } from '../../../../../base/browser/dom.js';
import { AnchorAlignment, AnchorPosition, IAnchor } from '../../../../../base/browser/ui/contextview/contextview.js';
import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { appendClaudeKbd } from '../chat/claudeKbd.js';
import '../media/claude.css';

/** One selectable row. */
export interface ClaudePopoverItem {
	readonly kind?: 'item';
	readonly id: string;
	readonly label: string;
	/** A second line under the label; the row grows to two lines. */
	readonly description?: string;
	/** Grey text right after the label, on the same line, such as a command's arguments. */
	readonly hint?: string;
	/** Grey text on the right. */
	readonly detail?: string;
	/** `start` cuts a long detail at its start, so a path keeps its file end. */
	readonly truncate?: 'start';
	/** The current value on the right, before a submenu chevron (as in "High" plus the chevron). */
	readonly value?: string;
	readonly icon?: ThemeIcon;
	/** Defaults to `menuitem`, or `option` when the menu is driven from outside. */
	readonly role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox' | 'option';
	readonly checked?: boolean;
	/** Shows a switch instead of a check; picking it flips the switch and keeps the menu open. */
	readonly toggle?: boolean;
	readonly disabled?: boolean;
	/** A keybinding label shown as key chips, such as "Ctrl+Shift+K". */
	readonly keybinding?: string;
	/** A hover card shown beside the row. */
	readonly hover?: string | IMarkdownString;
	/** Extra classes on the row, separated by spaces. */
	readonly className?: string;
	readonly dataset?: Readonly<Record<string, string>>;
	/** Rows that open a cascading menu beside this one. */
	readonly submenu?: () => readonly ClaudePopoverEntry[];
	/** Stays visible while the search box filters the menu. */
	readonly pinned?: boolean;
	/** More text the search box matches, which the row does not show. */
	readonly keywords?: string;
	/** Small icon buttons at the row's end, shown while the row is hovered or active. */
	readonly actions?: readonly ClaudePopoverRowAction[];
	/** Shift+F10, the context menu key or a right click on the row. */
	readonly contextMenu?: (anchor: HTMLElement | IAnchor) => void;
	/** Picking the row runs it and leaves the menu open, as for a group that expands. */
	readonly keepOpen?: boolean;
	readonly run?: () => void;
}

/** An icon button at the end of a row. The menu stays open unless the action closes it. */
export interface ClaudePopoverRowAction {
	readonly id: string;
	readonly icon: ThemeIcon;
	readonly label: string;
	/** Gets the button, to anchor a menu on. */
	readonly run: (anchor: HTMLElement) => void;
}

export interface ClaudePopoverHeader {
	readonly kind: 'header';
	readonly label: string;
	/** Stays visible while the search box filters the menu, above rows the owner found for the search. */
	readonly pinned?: boolean;
}

export interface ClaudePopoverSeparator {
	readonly kind: 'separator';
}

export type ClaudePopoverEntry = ClaudePopoverItem | ClaudePopoverHeader | ClaudePopoverSeparator;

export interface ClaudePopoverOptions {
	readonly anchor: HTMLElement;
	readonly entries: readonly ClaudePopoverEntry[];
	/** The accessible name of the menu. */
	readonly label: string;
	/** Extra classes on the top-level menu, separated by spaces. */
	readonly className?: string;
	readonly position?: AnchorPosition;
	readonly alignment?: AnchorAlignment;
	/**
	 * `menu` (default): focus moves into the menu and the arrow keys move it between rows.
	 * `external`: focus stays where it is (the composer) and the owner drives the menu
	 * with {@link ClaudePopoverMenu.move}, {@link ClaudePopoverMenu.accept} and `close`.
	 */
	readonly focus?: 'menu' | 'external';
	/** The row that starts active. Defaults to the first checked row, then the first enabled one. */
	readonly activeId?: string;
	/** A search box at the top that filters the rows; the text is its placeholder. */
	readonly search?: string;
	/** A quiet line at the bottom with a key hint. */
	readonly footer?: { readonly label: string; readonly keybinding: string };
	/** Shown when there are no rows, or none match the search. */
	readonly emptyLabel?: string;
	/** A strip under the rows that shows more about the active row, such as its full path. */
	readonly preview?: (item: ClaudePopoverItem) => string | undefined;
	/** Runs with the trimmed search text as it changes, so the owner can add rows it finds (issue 489). */
	readonly onSearch?: (query: string) => void;
	readonly onHide?: () => void;
}

/** How long the pointer rests on a submenu row before the submenu opens. */
const SUBMENU_DELAY = 150;

/** The space between the composer and a menu opened from it, and between the menu and the pane's edge. */
const COMPOSER_MENU_GAP = 6;

/** Each open menu gets its own row ids, so two menus never share one. */
let menuInstances = 0;

interface Row {
	readonly item: ClaudePopoverItem;
	readonly element: HTMLButtonElement;
	readonly toggle?: HTMLElement;
	/** A toggle row's state. Kept here because a `role` override may leave the row without `aria-checked`. */
	on: boolean;
}

interface Level {
	readonly element: HTMLElement;
	/** Holds the rows, between the search box and the footer. */
	readonly body: HTMLElement;
	entries: readonly ClaudePopoverEntry[];
	readonly parent: Level | undefined;
	readonly store: DisposableStore;
	rows: Row[];
	active: number;
	/** `entries` gives the submenu's rows: the row's own submenu, or a row menu (issue 746). */
	child?: { readonly level: Level; readonly row: Row; readonly entries: () => readonly ClaudePopoverEntry[] };
}

function isItem(entry: ClaudePopoverEntry): entry is ClaudePopoverItem {
	return entry.kind === undefined || entry.kind === 'item';
}

function isOutsideClaudeMenu(target: EventTarget | null, menu: HTMLElement | undefined, anchor: HTMLElement): boolean {
	const node = isHTMLElement(target) || isSVGElement(target) ? target : undefined;
	return !node || !(menu?.contains(node) || anchor.contains(node));
}

/**
 * Closes a menu when focus leaves it for anything but its anchor
 * (the anchor toggles the menu itself). Pair it with {@link closeClaudeMenuOnOutsideClick}.
 */
function closeClaudeMenuOnFocusOut(menu: HTMLElement, anchor: HTMLElement, close: () => void): IDisposable {
	return addDisposableListener(menu, EventType.FOCUS_OUT, event => {
		if (isOutsideClaudeMenu(event.relatedTarget, menu, anchor)) {
			close();
		}
	});
}

/**
 * The context view's `onDOMEvent`: a click outside the menu and its anchor closes
 * it. The default only closes on clicks outside the workbench container.
 */
function closeClaudeMenuOnOutsideClick(menu: () => HTMLElement | undefined, anchor: HTMLElement, close: () => void): (event: Event) => void {
	return event => {
		if (event.type === EventType.CLICK && isOutsideClaudeMenu(event.target, menu(), anchor)) {
			close();
		}
	};
}

/** Where a menu opened from the composer goes: over the composer's width, on one side of it. */
interface ComposerFrame {
	readonly composer: HTMLElement;
	readonly position: AnchorPosition;
	readonly width: number;
	/** The height the menu may take on that side and stay inside the pane. */
	readonly room: number;
}

/**
 * Menus opened from the composer (mode, model, `@` and `/`) span the composer and open
 * inside the pane: above the composer, or below it when more of the pane is below,
 * as when the composer sits at the top of a new chat (issue 131).
 */
function composerFrame(anchor: HTMLElement): ComposerFrame | undefined {
	const composer = anchor.closest<HTMLElement>('.claude-composer');
	if (!composer) {
		return undefined;
	}
	const box = composer.getBoundingClientRect();
	const pane = composer.closest('.claude-pane')?.getBoundingClientRect();
	const window = getWindow(composer);
	const above = box.top - Math.max(pane?.top ?? 0, 0) - 2 * COMPOSER_MENU_GAP;
	const below = Math.min(pane?.bottom ?? window.innerHeight, window.innerHeight) - box.bottom - 2 * COMPOSER_MENU_GAP;
	return above >= below
		? { composer, position: AnchorPosition.ABOVE, width: box.width, room: above }
		: { composer, position: AnchorPosition.BELOW, width: box.width, room: below };
}

/** The composer's box, grown by the gap so the menu keeps clear of it. */
function composerAnchor(composer: HTMLElement): IAnchor {
	const box = composer.getBoundingClientRect();
	return { x: box.left, y: box.top - COMPOSER_MENU_GAP, width: box.width, height: box.height + 2 * COMPOSER_MENU_GAP };
}

/**
 * The one popover every Claude menu is built on: the model, mode, `@` and `/` menus.
 *
 * It renders data rows (actions, radios, switches, submenus, headers and separators)
 * in a context view. Submenus cascade inside the same context view, on whichever side
 * has room, because only one context view can be open at a time. Arrow keys move,
 * Enter or Space picks, Right and Left open and close submenus, a letter jumps to the
 * next row starting with it, and Escape closes and gives focus back to the anchor.
 */
export class ClaudePopoverMenu extends Disposable {
	private readonly _open = this._register(new MutableDisposable<DisposableStore>());
	private _options: ClaudePopoverOptions | undefined;
	private _close: (() => void) | undefined;
	private _wrapper: HTMLElement | undefined;
	private _root: Level | undefined;
	private _search: HTMLInputElement | undefined;
	private _preview: HTMLElement | undefined;
	private _query = '';
	private _idPrefix = '';
	private _rowCount = 0;
	/** Closes the menu, gives focus back to the anchor, then runs the picked row. */
	private _finish: (run?: () => void) => void = () => undefined;

	constructor(
		private readonly _contextView: IContextViewService,
		private readonly _hovers?: IHoverService,
	) {
		super();
	}

	get isOpen(): boolean {
		return !!this._open.value;
	}

	/** The active row of the deepest open menu. */
	get activeItem(): ClaudePopoverItem | undefined {
		const level = this.deepest();
		return level?.rows[level.active]?.item;
	}

	show(options: ClaudePopoverOptions): void {
		this.close();
		const store = new DisposableStore();
		this._open.value = store;
		this._options = options;
		this._query = '';
		this._idPrefix = `claude-popover-${++menuInstances}`;
		this._rowCount = 0;
		const external = options.focus === 'external';
		let returnFocus = false;
		this._finish = run => {
			returnFocus = true;
			this.close();
			run?.();
		};
		// A composer menu ignores `position` and `alignment`: the composer decides where it goes.
		const frame = composerFrame(options.anchor);
		const opened = this._contextView.showContextView({
			getAnchor: () => frame ? composerAnchor(frame.composer) : options.anchor,
			anchorPosition: frame?.position ?? options.position ?? AnchorPosition.ABOVE,
			anchorAlignment: frame ? AnchorAlignment.LEFT : options.alignment ?? AnchorAlignment.LEFT,
			render: container => {
				const renderStore = new DisposableStore();
				// `.claude-root` carries the tokens into the context view, outside the pane (audit 3).
				const wrapper = append(container, $('.claude-root.claude-popover'));
				this._wrapper = wrapper;
				if (frame) {
					wrapper.classList.add('is-composer');
					wrapper.style.setProperty('--claude-popover-width', `${Math.round(frame.width)}px`);
					wrapper.style.setProperty('--claude-popover-max-height', `${Math.max(0, Math.floor(frame.room))}px`);
				}
				const root = this.createLevel(wrapper, options.entries, undefined, renderStore);
				root.element.classList.add(...(options.className?.split(/\s+/).filter(Boolean) ?? []));
				root.element.setAttribute('role', external ? 'listbox' : 'menu');
				root.element.setAttribute('aria-label', options.label);
				this._root = root;
				if (options.search !== undefined) {
					this.renderSearch(root, options.search, renderStore);
				}
				if (options.preview) {
					// A panel beside the menu, outside its scrolling box.
					this._preview = append(wrapper, $('.claude-menu-preview.is-empty'));
					this._preview.setAttribute('aria-hidden', 'true');
				}
				this.paintLevel(root);
				if (options.footer) {
					const footer = append(root.element, $('.claude-menu-footer'));
					footer.setAttribute('aria-hidden', 'true');
					append(footer, $('span')).textContent = options.footer.label;
					appendClaudeKbd(footer, options.footer.keybinding);
				}
				if (!external) {
					renderStore.add(addDisposableListener(wrapper, EventType.KEY_DOWN, event => this.onKeyDown(event)));
					renderStore.add(closeClaudeMenuOnFocusOut(wrapper, options.anchor, () => this.close()));
				}
				renderStore.add(toDisposable(() => {
					this._wrapper = undefined;
					this._root = undefined;
					this._search = undefined;
					this._preview = undefined;
				}));
				return renderStore;
			},
			onDOMEvent: external ? undefined : closeClaudeMenuOnOutsideClick(() => this._wrapper, options.anchor, () => this.close()),
			onHide: () => {
				this._close = undefined;
				this._open.clear();
				if (!external) {
					options.anchor.setAttribute('aria-expanded', 'false');
					if (returnFocus) {
						options.anchor.focus();
					}
				}
				options.onHide?.();
			},
		});
		this._close = () => opened.close();
		const hovers = this._hovers;
		if (hovers) {
			// The anchor's own tooltip would draw over the menu: hide it, and keep it hidden while the menu is open (issue 131).
			hovers.hideHover(true);
			store.add(addDisposableListener(options.anchor, EventType.MOUSE_OVER, () => hovers.hideHover(true)));
		}
		if (!external) {
			options.anchor.setAttribute('aria-expanded', 'true');
			if (this._search) {
				this._search.focus();
			} else {
				this.focusActive(this._root);
			}
		}
	}

	/**
	 * Repaints an open menu with new rows. The search text and the active row stay,
	 * and an open submenu opens again from its row's new entries.
	 */
	update(entries: readonly ClaudePopoverEntry[]): void {
		const root = this._root;
		const wrapper = this._wrapper;
		if (!root || !wrapper || !this._options) {
			return;
		}
		this._options = { ...this._options, entries };
		const activeId = root.rows[root.active]?.item.id;
		const childId = root.child?.row.item.id;
		// A row menu has no submenu on its row, so it keeps its own rows across the repaint.
		const rowMenu = root.child && !root.child.row.item.submenu ? root.child.entries : undefined;
		const focused = getActiveElement();
		const hadFocus = !!focused && wrapper.contains(focused) && focused !== this._search;
		const childFocus = !!focused && !!root.child?.level.element.contains(focused);
		if (hadFocus) {
			// The focused row is about to go; focus stays inside so the menu does not close.
			root.element.focus();
		}
		this.closeChild(root);
		root.entries = entries;
		this.paintLevel(root);
		const index = root.rows.findIndex(row => row.item.id === activeId);
		if (index >= 0) {
			root.active = index;
			this.paintActive(root);
		}
		const childRow = childId !== undefined ? root.rows.find(row => row.item.id === childId && (!!row.item.submenu || !!rowMenu)) : undefined;
		if (childRow) {
			this.openChild(root, childRow, childFocus, childRow.item.submenu ?? rowMenu);
		}
		if (hadFocus && !childFocus) {
			if (this._search) {
				this._search.focus();
			} else {
				this.focusActive(root);
			}
		}
	}

	/** Moves the active row of the deepest open menu; wraps at the ends. */
	move(delta: number): void {
		const level = this.deepest();
		if (!level) {
			return;
		}
		const enabled = level.rows.map((row, index) => ({ row, index })).filter(({ row }) => !row.item.disabled);
		if (enabled.length === 0) {
			return;
		}
		const at = enabled.findIndex(({ index }) => index === level.active);
		const next = at < 0 ? (delta > 0 ? 0 : enabled.length - 1) : (at + delta + enabled.length) % enabled.length;
		this.setActive(level, enabled[next].index);
	}

	/**
	 * Picks the active row, for menus driven from outside: a submenu row opens its
	 * submenu and returns nothing; any other row closes the menu, runs and is returned.
	 */
	accept(): ClaudePopoverItem | undefined {
		const level = this.deepest();
		const row = level?.rows[level.active];
		if (!level || !row || row.item.disabled) {
			this.close();
			return undefined;
		}
		if (row.item.submenu) {
			this.openChild(level, row, false);
			return undefined;
		}
		this.activate(level, level.active);
		return row.item;
	}

	/** Opens the active row's submenu, for menus driven from outside. False when it has none. */
	expand(): boolean {
		const level = this.deepest();
		const row = level?.rows[level.active];
		if (!level || !row?.item.submenu || row.item.disabled) {
			return false;
		}
		this.openChild(level, row, false);
		return true;
	}

	/**
	 * Opens a menu of `entries` beside the top-level row `id`, the way a submenu
	 * cascades, for a row's More button or its context menu. It stays inside this
	 * menu, so the menu stays open under it (issue 746). False when the row is not shown.
	 */
	openRowMenu(id: string, entries: () => readonly ClaudePopoverEntry[]): boolean {
		const level = this._root;
		const index = level?.rows.findIndex(row => row.item.id === id) ?? -1;
		if (!level || index < 0) {
			return false;
		}
		this.setActive(level, index);
		this.openChild(level, level.rows[index], true, entries);
		return true;
	}

	/** Closes the deepest submenu, for menus driven from outside. False when none is open. */
	collapse(): boolean {
		const parent = this.deepest()?.parent;
		if (!parent) {
			return false;
		}
		this.closeChild(parent);
		return true;
	}

	close(): void {
		const close = this._close;
		this._close = undefined;
		close?.();
		this._open.clear();
		this._options = undefined;
	}

	override dispose(): void {
		// A pane that goes away takes its open menu with it.
		this.close();
		super.dispose();
	}

	private createLevel(parent: HTMLElement, entries: readonly ClaudePopoverEntry[], parentLevel: Level | undefined, owner: DisposableStore): Level {
		const element = append(parent, $('.claude-menu'));
		// Focusable but out of the tab order: a click on a header, separator, gap or
		// disabled row focuses the menu itself, so focus stays inside and it stays open.
		element.tabIndex = -1;
		const body = append(element, $('.claude-menu-body'));
		const store = owner.add(new DisposableStore());
		return { element, body, entries, parent: parentLevel, store, rows: [], active: -1 };
	}

	private renderSearch(level: Level, placeholder: string, store: DisposableStore): void {
		const box = $('.claude-menu-search');
		level.element.insertBefore(box, level.body);
		append(box, $(ThemeIcon.asCSSSelector(Codicon.search)));
		const input = append(box, $<HTMLInputElement>('input'));
		input.type = 'text';
		input.placeholder = placeholder;
		input.setAttribute('aria-label', placeholder);
		input.setAttribute('role', 'combobox');
		input.setAttribute('aria-expanded', 'true');
		input.setAttribute('aria-autocomplete', 'list');
		this._search = input;
		store.add(addDisposableListener(input, EventType.INPUT, () => {
			this._query = input.value.trim().toLowerCase();
			const root = this._root;
			if (root) {
				this.closeChild(root);
				this.paintLevel(root);
			}
			this._options?.onSearch?.(input.value.trim());
		}));
	}

	/** (Re)paints a level's rows, keeping its search box and footer. */
	private paintLevel(level: Level): void {
		level.store.clear();
		const body = level.body;
		clearNode(body);
		level.rows = [];
		const external = this._options?.focus === 'external';
		const query = level.parent ? '' : this._query;
		const visible = query
			? level.entries.filter(entry => (entry.kind === 'header' && entry.pinned) || (isItem(entry) && (entry.pinned || `${entry.label} ${entry.description ?? ''} ${entry.detail ?? ''} ${entry.keywords ?? ''}`.toLowerCase().includes(query))))
			: level.entries;
		for (const entry of visible) {
			if (entry.kind === 'header') {
				const header = append(body, $('.claude-menu-group'));
				header.setAttribute('role', 'presentation');
				header.textContent = entry.label;
				continue;
			}
			if (entry.kind === 'separator') {
				append(body, $('.claude-menu-separator')).setAttribute('role', 'separator');
				continue;
			}
			level.rows.push(this.renderRow(body, level, entry, external));
		}
		if (level.rows.length === 0 && this._options?.emptyLabel) {
			append(body, $('.claude-menu-group.is-empty')).textContent = this._options.emptyLabel;
		}
		const options = this._options;
		const preferred = options?.activeId !== undefined && !level.parent ? level.rows.findIndex(row => row.item.id === options.activeId) : -1;
		const checked = level.rows.findIndex(row => row.item.checked && !row.item.toggle && !row.item.disabled);
		const first = level.rows.findIndex(row => !row.item.disabled);
		level.active = query ? first : preferred >= 0 ? preferred : checked >= 0 ? checked : first;
		level.rows.forEach((row, index) => this.wireRow(level, row, index));
		this.paintActive(level);
	}

	private renderRow(body: HTMLElement, level: Level, item: ClaudePopoverItem, external: boolean): Row {
		// A row with actions sits in a wrapper with them: a button cannot hold other buttons.
		const host = item.actions?.length ? append(body, $('.claude-menu-row')) : body;
		const element = append(host, $<HTMLButtonElement>('button.claude-menu-item'));
		element.type = 'button';
		element.tabIndex = -1;
		element.id = `${this._idPrefix}-${this._rowCount++}`;
		const role = item.role ?? (item.toggle ? 'menuitemcheckbox' : external ? 'option' : 'menuitem');
		element.setAttribute('role', role);
		if (role === 'menuitemradio' || role === 'menuitemcheckbox') {
			element.setAttribute('aria-checked', String(!!item.checked));
		}
		if (item.className) {
			element.classList.add(...item.className.split(/\s+/).filter(Boolean));
		}
		for (const [key, value] of Object.entries(item.dataset ?? {})) {
			element.dataset[key] = value;
		}
		if (item.description) {
			element.classList.add('is-tall');
		}
		if (item.disabled) {
			element.disabled = true;
			element.setAttribute('aria-disabled', 'true');
		}
		if (item.icon) {
			append(element, $(ThemeIcon.asCSSSelector(item.icon)));
		}
		const label = append(element, $('span.label'));
		const name = item.description ? append(label, $('span.name')) : label;
		if (item.hint) {
			append(name, $('span.text')).textContent = item.label;
			append(name, $('span.hint')).textContent = item.hint;
		} else {
			name.textContent = item.label;
		}
		if (item.description) {
			append(label, $('span.desc')).textContent = item.description;
		}
		if (item.detail) {
			const detail = append(element, $('span.detail'));
			if (item.truncate === 'start') {
				// Right-to-left overflow puts the ellipsis first; the isolate keeps the text in order.
				detail.classList.add('is-start');
				append(detail, $('bdi')).textContent = item.detail;
			} else {
				detail.textContent = item.detail;
			}
		}
		if (item.keybinding) {
			appendClaudeKbd(element, item.keybinding);
		}
		if (item.value !== undefined) {
			append(element, $('span.value')).textContent = item.value;
		}
		let toggle: HTMLElement | undefined;
		if (item.submenu) {
			element.setAttribute('aria-haspopup', 'menu');
			element.setAttribute('aria-expanded', 'false');
			append(element, $('span.chevron' + ThemeIcon.asCSSSelector(Codicon.chevronRight)));
		} else if (item.toggle) {
			toggle = append(element, $('span.claude-switch'));
			toggle.classList.toggle('is-on', !!item.checked);
		} else if (item.checked) {
			append(element, $('span.check' + ThemeIcon.asCSSSelector(Codicon.check)));
		}
		if (item.hover && this._hovers) {
			const content = item.hover;
			level.store.add(this._hovers.setupDelayedHover(element, {
				content,
				additionalClasses: ['claude-root', 'claude-hover-card'],
				position: { hoverPosition: HoverPosition.RIGHT },
			}));
		}
		if (item.actions?.length) {
			element.classList.add('has-actions');
			this.renderActions(host, level, item.actions);
		}
		return { item, element, toggle, on: !!item.checked };
	}

	private renderActions(host: HTMLElement, level: Level, actions: readonly ClaudePopoverRowAction[]): void {
		const bar = append(host, $('.claude-menu-actions'));
		for (const action of actions) {
			const button = append(bar, $<HTMLButtonElement>('button.claude-icon-btn.claude-menu-action'));
			button.type = 'button';
			button.tabIndex = -1;
			button.dataset.action = action.id;
			button.setAttribute('aria-label', action.label);
			append(button, $(ThemeIcon.asCSSSelector(action.icon)));
			if (this._hovers) {
				level.store.add(this._hovers.setupDelayedHover(button, { content: action.label, additionalClasses: ['claude-root'] }));
			}
			// Focus stays where it is (the search box), so the menu does not close.
			level.store.add(addDisposableListener(button, EventType.MOUSE_DOWN, event => event.preventDefault()));
			level.store.add(addDisposableListener(button, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				action.run(button);
			}));
		}
	}

	private wireRow(level: Level, row: Row, index: number): void {
		const external = this._options?.focus === 'external';
		const store = level.store;
		const submenuTimer = store.add(new MutableDisposable());
		if (external) {
			// The composer keeps focus while the pointer picks a row.
			store.add(addDisposableListener(row.element, EventType.MOUSE_DOWN, event => event.preventDefault()));
		}
		store.add(addDisposableListener(row.element, EventType.MOUSE_MOVE, () => {
			if (row.item.disabled) {
				return;
			}
			if (level.active !== index || (!external && !this._search && getActiveElement() !== row.element)) {
				this.setActive(level, index);
			}
			if (level.child?.row !== row && !submenuTimer.value) {
				const handle = setTimeout(() => {
					submenuTimer.clear();
					if (level.rows[level.active] === row) {
						if (row.item.submenu) {
							this.openChild(level, row, false);
						} else if (level.child?.row !== row) {
							// A row menu opened while the pointer rested here stays open.
							this.closeChild(level);
						}
					}
				}, SUBMENU_DELAY);
				submenuTimer.value = toDisposable(() => clearTimeout(handle));
			}
		}));
		store.add(addDisposableListener(row.element, EventType.CLICK, event => {
			event.preventDefault();
			this.activate(level, index);
		}));
		const contextMenu = row.item.contextMenu;
		if (contextMenu) {
			store.add(addDisposableListener(row.element, EventType.CONTEXT_MENU, event => {
				event.preventDefault();
				event.stopPropagation();
				this.setActive(level, index);
				contextMenu({ x: event.clientX, y: event.clientY });
			}));
		}
	}

	private activate(level: Level, index: number): void {
		const row = level.rows[index];
		if (!row || row.item.disabled) {
			return;
		}
		this.setActive(level, index);
		if (row.item.submenu) {
			this.openChild(level, row, true);
			return;
		}
		if (row.item.toggle) {
			row.on = !row.on;
			if (row.element.hasAttribute('aria-checked')) {
				row.element.setAttribute('aria-checked', String(row.on));
			}
			row.toggle?.classList.toggle('is-on', row.on);
			row.item.run?.();
			return;
		}
		if (row.item.keepOpen) {
			row.item.run?.();
			return;
		}
		this._finish(row.item.run);
	}

	private openChild(level: Level, row: Row, focus: boolean, entries = row.item.submenu): void {
		if (level.child?.row === row && level.child.entries === entries) {
			if (focus) {
				this.focusActive(level.child.level);
			}
			return;
		}
		this.closeChild(level);
		const wrapper = this._wrapper;
		if (!wrapper || !entries) {
			return;
		}
		const child = this.createLevel(wrapper, entries(), level, level.store);
		child.element.classList.add('claude-submenu');
		child.element.setAttribute('role', 'menu');
		child.element.setAttribute('aria-label', row.item.label);
		level.child = { level: child, row, entries };
		row.element.setAttribute('aria-expanded', 'true');
		row.element.classList.add('is-open');
		this.paintLevel(child);
		this.placeChild(level, row, child);
		if (focus) {
			this.focusActive(child);
		}
	}

	/** Puts a submenu beside its row, on the right unless only the left has room. */
	private placeChild(level: Level, row: Row, child: Level): void {
		const wrapper = this._wrapper!;
		const window = getWindow(wrapper);
		const origin = wrapper.getBoundingClientRect();
		const parentBox = level.element.getBoundingClientRect();
		const rowBox = row.element.getBoundingClientRect();
		const box = child.element.getBoundingClientRect();
		const gap = 4;
		const roomRight = window.innerWidth - parentBox.right - gap;
		const roomLeft = parentBox.left - gap;
		const right = roomRight >= box.width || roomRight >= roomLeft;
		child.element.classList.toggle('is-left', !right);
		child.element.classList.toggle('is-right', right);
		const left = right ? parentBox.right + gap : parentBox.left - gap - box.width;
		const top = Math.max(gap, Math.min(rowBox.top - (box.height > 0 ? 5 : 0), window.innerHeight - box.height - gap));
		child.element.style.left = `${Math.round(left - origin.left)}px`;
		child.element.style.top = `${Math.round(top - origin.top)}px`;
	}

	private closeChild(level: Level): void {
		const open = level.child;
		if (!open) {
			return;
		}
		this.closeChild(open.level);
		level.child = undefined;
		open.row.element.setAttribute('aria-expanded', 'false');
		open.row.element.classList.remove('is-open');
		// Removes the submenu's store from its parent's as well as disposing it.
		level.store.delete(open.level.store);
		open.level.element.remove();
		this.paintPreview();
	}

	/** Shows the deepest open menu's active row in the preview strip. */
	private paintPreview(): void {
		const strip = this._preview;
		const preview = this._options?.preview;
		if (!strip || !preview) {
			return;
		}
		const item = this.activeItem;
		const text = item ? preview(item) : undefined;
		strip.textContent = text ?? '';
		strip.classList.toggle('is-empty', !text);
		if (text && this._wrapper) {
			// Beside the menu on the right, or on the left when the window ends first.
			strip.classList.remove('is-left');
			const box = strip.getBoundingClientRect();
			strip.classList.toggle('is-left', box.right > getWindow(this._wrapper).innerWidth);
		}
	}

	private onKeyDown(event: KeyboardEvent): void {
		const level = this.focusedLevel();
		if (!level) {
			return;
		}
		const inSearch = !!this._search && getActiveElement() === this._search;
		switch (event.key) {
			case 'ArrowDown':
			case 'ArrowUp':
				event.preventDefault();
				this.closeChild(level);
				this.moveIn(level, event.key === 'ArrowDown' ? 1 : -1);
				break;
			case 'Home':
			case 'End':
				if (inSearch) {
					return;
				}
				event.preventDefault();
				this.moveIn(level, 0, event.key === 'Home' ? 'first' : 'last');
				break;
			case 'ArrowRight': {
				const row = level.rows[level.active];
				if (row?.item.submenu && !inSearch) {
					event.preventDefault();
					this.openChild(level, row, true);
				}
				break;
			}
			case 'ArrowLeft':
				if (level.parent) {
					event.preventDefault();
					this.backTo(level.parent);
				}
				break;
			case 'Enter':
				event.preventDefault();
				this.activate(level, level.active);
				break;
			case ' ':
				if (inSearch) {
					return;
				}
				event.preventDefault();
				this.activate(level, level.active);
				break;
			case 'Escape':
				event.preventDefault();
				event.stopPropagation();
				if (level.parent) {
					this.backTo(level.parent);
				} else {
					this._finish();
				}
				break;
			case 'Tab':
				event.preventDefault();
				this._finish();
				break;
			case 'ContextMenu':
			case 'F10': {
				const row = level.rows[level.active];
				if (row?.item.contextMenu && (event.key === 'ContextMenu' || event.shiftKey)) {
					event.preventDefault();
					row.item.contextMenu(row.element);
				}
				break;
			}
			default:
				if (!inSearch && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
					this.jumpTo(level, event.key.toLowerCase());
				}
		}
	}

	private backTo(parent: Level): void {
		// Focus first: removing the focused submenu would otherwise blur out of the menu and close it.
		this.focusActive(parent);
		this.closeChild(parent);
	}

	private moveIn(level: Level, delta: number, to?: 'first' | 'last'): void {
		const enabled = level.rows.map((row, index) => ({ row, index })).filter(({ row }) => !row.item.disabled);
		if (enabled.length === 0) {
			return;
		}
		let next: number;
		if (to) {
			next = to === 'first' ? 0 : enabled.length - 1;
		} else {
			const at = enabled.findIndex(({ index }) => index === level.active);
			next = at < 0 ? (delta > 0 ? 0 : enabled.length - 1) : (at + delta + enabled.length) % enabled.length;
		}
		this.setActive(level, enabled[next].index);
	}

	/** A letter jumps to the next enabled row whose label starts with it. */
	private jumpTo(level: Level, key: string): void {
		const count = level.rows.length;
		for (let step = 1; step <= count; step++) {
			const index = (level.active + step + count) % count;
			const row = level.rows[index];
			if (!row.item.disabled && row.item.label.replace(/^[/@]/, '').toLowerCase().startsWith(key)) {
				this.setActive(level, index);
				return;
			}
		}
	}

	private setActive(level: Level, index: number): void {
		level.active = index;
		this.paintActive(level);
		const external = this._options?.focus === 'external';
		if (!external && !this._search) {
			level.rows[index]?.element.focus();
		} else if (!external && level.parent) {
			level.rows[index]?.element.focus();
		}
		level.rows[index]?.element.scrollIntoView?.({ block: 'nearest' });
	}

	private paintActive(level: Level): void {
		const external = this._options?.focus === 'external';
		level.rows.forEach((row, index) => {
			const active = index === level.active;
			row.element.classList.toggle('is-active', active);
			if (external) {
				row.element.setAttribute('aria-selected', String(active));
			}
		});
		if (level === this.deepest()) {
			this.paintPreview();
		}
		const activeId = level.rows[level.active]?.element.id;
		const owner = !level.parent && this._search ? this._search : external ? level.element : undefined;
		if (owner) {
			if (activeId) {
				owner.setAttribute('aria-activedescendant', activeId);
			} else {
				owner.removeAttribute('aria-activedescendant');
			}
		}
	}

	private focusActive(level: Level | undefined): void {
		if (!level) {
			return;
		}
		const row = level.rows[level.active];
		(row?.element ?? level.element).focus();
	}

	private deepest(): Level | undefined {
		let level = this._root;
		while (level?.child) {
			level = level.child.level;
		}
		return level;
	}

	/** The level that holds focus, or the deepest open one when focus is elsewhere. */
	private focusedLevel(): Level | undefined {
		const focused = getActiveElement();
		let level = this._root;
		while (level) {
			if (focused && level.element.contains(focused)) {
				return level;
			}
			level = level.child?.level;
		}
		return this.deepest();
	}
}
