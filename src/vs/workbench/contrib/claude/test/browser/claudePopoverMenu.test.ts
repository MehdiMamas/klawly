/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { getWindow } from '../../../../../base/browser/dom.js';
import { AnchorPosition, IAnchor } from '../../../../../base/browser/ui/contextview/contextview.js';
import { IDelayedHoverOptions } from '../../../../../base/browser/ui/hover/hover.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextViewDelegate, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { ClaudePopoverEntry, ClaudePopoverMenu, ClaudePopoverOptions } from '../../browser/widgets/claudePopoverMenu.js';
import { moveClaudeTestFocus } from './claudeFocusTestUtils.js';

suite('Claude popover menu (Phase 32)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let host: HTMLElement;
	let anchor: HTMLButtonElement;
	let delegates: IContextViewDelegate[];
	let hovers: { target: HTMLElement; options: IDelayedHoverOptions }[];
	let hoversHidden: number;
	let ran: string[];

	setup(() => {
		host = document.createElement('div');
		host.style.position = 'fixed';
		host.style.top = '40px';
		host.style.left = '8px';
		anchor = document.createElement('button');
		document.body.append(anchor, host);
		delegates = [];
		hovers = [];
		hoversHidden = 0;
		ran = [];
		store.add(toDisposable(() => { host.remove(); anchor.remove(); }));
	});

	function menu(): ClaudePopoverMenu {
		const contextView = {
			showContextView: (delegate: IContextViewDelegate) => {
				delegates.push(delegate);
				const rendered = delegate.render(host);
				return { close: () => { rendered?.dispose(); host.textContent = ''; delegate.onHide?.(); } };
			},
		} as unknown as IContextViewService;
		const hoverService = {
			setupDelayedHover: (target: HTMLElement, options: IDelayedHoverOptions) => {
				hovers.push({ target, options });
				return toDisposable(() => undefined);
			},
			hideHover: () => { hoversHidden++; },
		} as unknown as IHoverService;
		return store.add(new ClaudePopoverMenu(contextView, hoverService));
	}

	function item(id: string, extra: Partial<ClaudePopoverEntry> = {}): ClaudePopoverEntry {
		return { id, label: id, run: () => ran.push(id), ...extra } as ClaudePopoverEntry;
	}

	function show(popover: ClaudePopoverMenu, entries: ClaudePopoverEntry[], options: Partial<ClaudePopoverOptions> = {}): void {
		popover.show({ anchor, entries, label: 'Test', ...options });
	}

	function key(key: string, target: Element = document.activeElement!): void {
		target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
	}

	function rows(level = '.claude-menu:not(.claude-submenu)'): HTMLButtonElement[] {
		return [...host.querySelectorAll<HTMLButtonElement>(`${level} > .claude-menu-body > .claude-menu-item`)];
	}

	function focused(): string | undefined {
		return (document.activeElement as HTMLElement | null)?.querySelector('.label')?.textContent ?? undefined;
	}

	test('arrow keys skip disabled rows and wrap, a letter jumps, and Enter runs the row and refocuses the anchor', () => {
		const popover = menu();
		show(popover, [
			{ kind: 'header', label: 'Group' },
			item('alpha'),
			item('beta', { role: 'menuitemradio', checked: true }),
			item('gamma', { disabled: true }),
			{ kind: 'separator' },
			item('delta'),
		]);
		const path = [focused()];
		for (const step of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'g', 'a']) {
			key(step);
			path.push(focused());
		}
		key('Enter');
		assert.deepStrictEqual({
			path,
			ran,
			open: popover.isOpen,
			anchorFocused: document.activeElement === anchor,
			expanded: anchor.getAttribute('aria-expanded'),
		}, {
			// gamma is disabled, so `g` finds nothing and stays on delta.
			path: ['beta', 'delta', 'alpha', 'delta', 'alpha', 'delta', 'delta', 'alpha'],
			ran: ['alpha'],
			open: false,
			anchorFocused: true,
			expanded: 'false',
		});
	});

	test('rows render their parts: icon, two lines, detail, key chips, value with chevron, switch, check and data', () => {
		const popover = menu();
		show(popover, [
			item('plain', { icon: Codicon.gear, detail: 'grey', keybinding: 'Ctrl+K' }),
			item('tall', { description: 'second line', role: 'menuitemradio', checked: true, dataset: { mode: 'ask' } }),
			item('value', { value: 'High', submenu: () => [item('low')] }),
			item('toggle', { toggle: true, checked: true }),
		]);
		const parts = rows().map(row => ({
			role: row.getAttribute('role'),
			checked: row.getAttribute('aria-checked'),
			tall: row.classList.contains('is-tall'),
			text: [...row.children].map(child => child.className.replace(/codicon(-\S+)?/g, '').trim() || 'icon'),
			mode: row.dataset.mode,
			popup: row.getAttribute('aria-haspopup'),
		}));
		assert.deepStrictEqual(parts, [
			{ role: 'menuitem', checked: null, tall: false, text: ['icon', 'label', 'detail', 'claude-kbd'], mode: undefined, popup: null },
			{ role: 'menuitemradio', checked: 'true', tall: true, text: ['label', 'check'], mode: 'ask', popup: null },
			{ role: 'menuitem', checked: null, tall: false, text: ['label', 'value', 'chevron'], mode: undefined, popup: 'menu' },
			{ role: 'menuitemcheckbox', checked: 'true', tall: false, text: ['label', 'claude-switch is-on'], mode: undefined, popup: null },
		]);
		popover.close();
	});

	test('a switch row flips in place and keeps the menu open', () => {
		const popover = menu();
		show(popover, [item('fast', { toggle: true, checked: false })]);
		const row = rows()[0];
		row.click();
		const first = [row.getAttribute('aria-checked'), row.querySelector('.claude-switch')?.classList.contains('is-on'), popover.isOpen];
		key(' ');
		assert.deepStrictEqual({ first, second: row.getAttribute('aria-checked'), ran }, { first: ['true', true, true], second: 'false', ran: ['fast', 'fast'] });
		popover.close();
	});

	test('a switch row with a role override still flips off again', () => {
		const popover = menu();
		show(popover, [item('thinking', { toggle: true, checked: true, role: 'menuitem' })]);
		const row = rows()[0];
		const states: (boolean | undefined)[] = [];
		for (let i = 0; i < 3; i++) {
			row.click();
			states.push(row.querySelector('.claude-switch')?.classList.contains('is-on'));
		}
		assert.deepStrictEqual({ states, checked: row.getAttribute('aria-checked') }, { states: [false, true, false], checked: null });
		popover.close();
	});

	test('a click outside, focus leaving, Tab and Escape each close the menu; only Tab and Escape give focus back to the anchor', () => {
		const outside = document.createElement('button');
		document.body.append(outside);
		store.add(toDisposable(() => outside.remove()));
		const popover = menu();
		const results: Record<string, { open: boolean; anchorFocused: boolean; expanded: string | null }> = {};
		const record = (name: string) => {
			results[name] = { open: popover.isOpen, anchorFocused: document.activeElement === anchor, expanded: anchor.getAttribute('aria-expanded') };
		};

		show(popover, [item('a'), item('b')]);
		const anchorClick = new MouseEvent('click', { bubbles: true });
		anchor.dispatchEvent(anchorClick);
		delegates.at(-1)!.onDOMEvent!(anchorClick, anchor);
		const anchorClickKeepsOpen = popover.isOpen;
		const click = new MouseEvent('click', { bubbles: true });
		outside.dispatchEvent(click);
		delegates.at(-1)!.onDOMEvent!(click, outside);
		record('outside click');

		show(popover, [item('a'), item('b')]);
		moveClaudeTestFocus(outside);
		record('focus out');

		show(popover, [item('a'), item('b')]);
		key('Tab');
		record('Tab');

		show(popover, [item('a'), item('b')]);
		key('Escape');
		record('Escape');

		assert.deepStrictEqual({ anchorClickKeepsOpen, results, ran }, {
			anchorClickKeepsOpen: true,
			results: {
				'outside click': { open: false, anchorFocused: false, expanded: 'false' },
				'focus out': { open: false, anchorFocused: false, expanded: 'false' },
				'Tab': { open: false, anchorFocused: true, expanded: 'false' },
				'Escape': { open: false, anchorFocused: true, expanded: 'false' },
			},
			ran: [],
		});
	});

	test('a menu driven from outside ignores focus moving between its owner and other elements', () => {
		const input = document.createElement('textarea');
		const other = document.createElement('button');
		document.body.append(input, other);
		store.add(toDisposable(() => { input.remove(); other.remove(); }));
		input.focus();
		const popover = menu();
		show(popover, [item('a.ts', { role: 'option' })], { focus: 'external', anchor: input });
		moveClaudeTestFocus(other);
		assert.deepStrictEqual({ open: popover.isOpen, outsideClickHandler: delegates.at(-1)!.onDOMEvent }, { open: true, outsideClickHandler: undefined });
		popover.close();
	});

	test('Right opens a submenu on its first row, Escape goes back to the parent row, and a submenu pick closes everything', () => {
		const popover = menu();
		show(popover, [
			item('effort', { value: 'High', submenu: () => [item('low'), item('high', { role: 'menuitemradio', checked: true })] }),
			item('model'),
		]);
		const parent = rows()[0];
		key('ArrowRight');
		const opened = { focus: focused(), expanded: parent.getAttribute('aria-expanded'), sub: rows('.claude-submenu').map(row => row.textContent) };
		key('Escape');
		const back = { focus: focused(), open: popover.isOpen, sub: host.querySelector('.claude-submenu') === null };
		key('Enter');
		key('ArrowUp');
		key('Enter');
		assert.deepStrictEqual({ opened, back, ran, open: popover.isOpen }, {
			opened: { focus: 'high', expanded: 'true', sub: ['low', 'high'] },
			back: { focus: 'effort', open: true, sub: true },
			ran: ['low'],
			open: false,
		});
	});

	test('a row menu cascades beside its row inside the menu, survives a repaint, and a pick closes everything (issue 746)', () => {
		const popover = menu();
		show(popover, [item('chat'), item('other')]);
		const opened = popover.openRowMenu('chat', () => [item('rename'), { kind: 'separator' }, item('delete')]);
		const first = { open: popover.isOpen, focus: focused(), sub: rows('.claude-submenu').map(row => row.textContent), expanded: rows()[0].getAttribute('aria-expanded') };
		popover.update([item('chat'), item('other'), item('new')]);
		const repainted = rows('.claude-submenu').map(row => row.textContent);
		key('ArrowDown');
		key('Enter');
		assert.deepStrictEqual({ opened, first, repainted, missing: popover.openRowMenu('gone', () => []), ran, open: popover.isOpen }, {
			opened: true,
			first: { open: true, focus: 'rename', sub: ['rename', 'delete'], expanded: 'true' },
			repainted: ['rename', 'delete'],
			missing: false,
			ran: ['delete'],
			open: false,
		});
	});

	test('a submenu opens on the side with room', () => {
		const popover = menu();
		const sides: string[] = [];
		const width = getWindow(host).innerWidth;
		for (const left of [8, width - 330]) {
			host.style.left = `${left}px`;
			show(popover, [item('effort', { submenu: () => [item('low')] })]);
			key('ArrowRight');
			const sub = host.querySelector<HTMLElement>('.claude-submenu')!;
			const parentBox = host.querySelector('.claude-menu')!.getBoundingClientRect();
			const box = sub.getBoundingClientRect();
			sides.push(`${sub.classList.contains('is-right') ? 'right' : 'left'}:${box.left >= parentBox.right || box.right <= parentBox.left}`);
			popover.close();
		}
		assert.deepStrictEqual(sides, ['right:true', 'left:true']);
	});

	test('the search box filters rows, hides headers, keeps pinned rows, and Enter runs the first match', () => {
		const popover = menu();
		show(popover, [
			{ kind: 'header', label: 'Opus' },
			item('Opus 5.5', { detail: 'claude-opus-5-5' }),
			{ kind: 'header', label: 'Sonnet' },
			item('Sonnet 5', { detail: 'claude-sonnet-5' }),
			{ kind: 'separator' },
			item('Manage', { pinned: true }),
		], { search: 'Search models' });
		const input = host.querySelector<HTMLInputElement>('.claude-menu-search input')!;
		const focusedInput = document.activeElement === input;
		input.value = 'sonnet';
		input.dispatchEvent(new Event('input'));
		const filtered = { rows: rows().map(row => row.textContent), headers: host.querySelectorAll('.claude-menu-group').length, active: input.getAttribute('aria-activedescendant') === rows()[0].id };
		key('Enter', input);
		assert.deepStrictEqual({ focusedInput, filtered, ran }, {
			focusedInput: true,
			filtered: { rows: ['Sonnet 5claude-sonnet-5', 'Manage'], headers: 0, active: true },
			ran: ['Sonnet 5'],
		});
	});

	test('a menu driven from outside keeps focus where it is and returns the active row on accept', () => {
		const popover = menu();
		const input = document.createElement('textarea');
		document.body.append(input);
		store.add(toDisposable(() => input.remove()));
		input.focus();
		show(popover, [{ kind: 'header', label: 'Files' }, item('a.ts', { role: 'option' }), item('b.ts', { role: 'option' })], { focus: 'external', anchor: input });
		popover.move(1);
		const selected = rows().map(row => row.getAttribute('aria-selected'));
		const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		rows()[0].dispatchEvent(mouseDown);
		const accepted = popover.accept();
		assert.deepStrictEqual({
			role: delegates[0].onDOMEvent === undefined,
			selected,
			keptFocus: document.activeElement === input,
			mouseDownKeepsFocus: mouseDown.defaultPrevented,
			accepted: accepted?.id,
			open: popover.isOpen,
			expanded: input.getAttribute('aria-expanded'),
		}, { role: true, selected: ['false', 'true'], keptFocus: true, mouseDownKeepsFocus: true, accepted: 'b.ts', open: false, expanded: null });
	});

	test('a menu driven from outside opens and closes submenus by key and shows the active row in a side preview', () => {
		const popover = menu();
		show(popover, [
			item('/compact', { role: 'option', hint: '[instructions]', description: 'Summarize the conversation' }),
			item('todo.ts', { role: 'option', detail: 'src/very/long/folder', truncate: 'start' }),
			item('Files & Folders', { role: 'option', submenu: () => [item('src', { role: 'option' })] }),
		], { focus: 'external', preview: entry => entry.id === 'todo.ts' ? 'src/very/long/folder/todo.ts' : undefined });
		const first = rows()[0];
		const line = [first.querySelector('.name > .text')?.textContent, first.querySelector('.name > .hint')?.textContent, first.querySelector('.desc')?.textContent, first.classList.contains('is-tall')];
		const preview = host.querySelector<HTMLElement>('.claude-popover > .claude-menu-preview')!;
		const emptyAtFirst = preview.classList.contains('is-empty');
		popover.move(1);
		const path = [preview.textContent, preview.classList.contains('is-empty'), rows()[1].querySelector('.detail.is-start > bdi')?.textContent];
		const notOnFile = popover.expand();
		popover.move(1);
		const opened = popover.expand();
		const submenu = host.querySelectorAll('.claude-submenu').length;
		const collapsed = popover.collapse();
		const collapsedAgain = popover.collapse();
		assert.deepStrictEqual({ line, emptyAtFirst, path, notOnFile, opened, submenu, collapsed, collapsedAgain, left: host.querySelectorAll('.claude-submenu').length }, {
			line: ['/compact', '[instructions]', 'Summarize the conversation', true],
			emptyAtFirst: true,
			path: ['src/very/long/folder/todo.ts', false, 'src/very/long/folder'],
			notOnFile: false,
			opened: true,
			submenu: 1,
			collapsed: true,
			collapsedAgain: false,
			left: 0,
		});
	});

	test('a row with a hover gets a hover card beside it that carries the Claude tokens', () => {
		const popover = menu();
		show(popover, [item('opus', { hover: 'Opus 5.5: 200K context' }), item('plain')]);
		assert.deepStrictEqual(hovers.map(hover => [hover.target.textContent, hover.options.content, hover.options.additionalClasses?.includes('claude-root')]), [['opus', 'Opus 5.5: 200K context', true]]);
		popover.close();
	});

	test('a menu opened from the composer spans it and opens inside the pane, above it or below it when the pane has more room there', () => {
		const pane = document.createElement('div');
		pane.className = 'claude-pane';
		pane.style.cssText = 'position: fixed; top: 0; left: 0; width: 400px; height: 300px;';
		const composer = document.createElement('div');
		composer.className = 'claude-composer';
		composer.style.cssText = 'position: absolute; left: 20px; width: 360px; height: 60px;';
		const pill = document.createElement('button');
		composer.append(pill);
		pane.append(composer);
		document.body.append(pane);
		store.add(toDisposable(() => pane.remove()));
		const popover = menu();
		const open = (top: number) => {
			composer.style.top = `${top}px`;
			show(popover, [item('agent')], { anchor: pill, position: AnchorPosition.BELOW });
			const delegate = delegates[delegates.length - 1];
			const wrapper = host.querySelector<HTMLElement>('.claude-popover')!;
			const anchorBox = delegate.getAnchor() as IAnchor;
			const placed = [
				delegate.anchorPosition,
				[anchorBox.x, anchorBox.y, anchorBox.width, anchorBox.height],
				wrapper.classList.contains('is-composer'),
				wrapper.style.getPropertyValue('--claude-popover-width'),
				wrapper.style.getPropertyValue('--claude-popover-max-height'),
			];
			popover.close();
			return placed;
		};
		assert.deepStrictEqual({ bottom: open(220), top: open(10) }, {
			bottom: [AnchorPosition.ABOVE, [20, 214, 360, 72], true, '360px', '208px'],
			top: [AnchorPosition.BELOW, [20, 4, 360, 72], true, '360px', '218px'],
		});
	});

	test('a menu outside the composer keeps its own anchor and width', () => {
		const popover = menu();
		show(popover, [item('alpha')], { position: AnchorPosition.BELOW });
		const delegate = delegates[0];
		assert.deepStrictEqual([delegate.getAnchor() === anchor, delegate.anchorPosition, host.querySelector('.claude-popover')!.classList.contains('is-composer')], [true, AnchorPosition.BELOW, false]);
		popover.close();
	});

	test('the anchor tooltip stays hidden while its menu is open', () => {
		const popover = menu();
		show(popover, [item('alpha')]);
		const onOpen = hoversHidden;
		anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
		const onHover = hoversHidden;
		popover.close();
		anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
		assert.deepStrictEqual([onOpen, onHover, hoversHidden], [1, 2, 2]);
	});
});
