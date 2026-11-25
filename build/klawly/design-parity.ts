/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks the app against the design prototype by what both render, not by tokens.
// Usage: npm run design-parity [-- --theme dark|light] [--only <page.html,...>] [--exe <path>] [--browser msedge|chrome]
//
// 1. Builds a fixture workspace that mirrors the prototype's klawly-demo, the fake-runtime
//    scripts for the chat and inline edit states, the Tab suggestion (completion.txt) and Claude
//    Code's model list (models.json), in design/.parity/env/ (gitignored).
// 2. Launches the dev build (or --exe) on it at 1440x900 with `claude.agent.runtime: fake`, once
//    per theme. KLAWLY_FAKE_FIXTURE_DIR points the fake runtime at the scripts (dev builds only,
//    see src/vs/platform/claude/node/claudeFixtureDirectory.ts); their file writes land on disk
//    and in the turn's checkpoint, so the review shows them as pending.
// 3. Drives the app to each state in STATES and shoots it; shoots the matching design/ page in a
//    browser at the same size.
// 4. Pairs the prototype's [data-label] regions with app selectors (REGIONS) and compares x, y,
//    width, height (2px tolerance), background and font size.
// 5. Writes side-by-side images to design/.parity/pairs/ (prototype left, app right, regions with
//    a delta outlined) and the deltas to the "Parity" section of design/STALE.md.
//
// Extending: add a region to REGIONS (prototype data-label → app CSS selector), list it in a
// state's `regions`, or add a state with a `drive` step that brings the app to what the page draws.
// Not part of the compile: it launches Electron. Exit code 1 when the app cannot be launched.
//
// Clicks: npm run design-parity -- --clicks [--theme dark] [--only <page.html|area/,...>] [--keys <regex>]
// Clicks every unique click design/.accepts lists, once in the prototype and once in the app, in
// the state of the first page it appears on, and records what each click does in both. Writes
// design/.parity/clicks/clicks.json (a run with --only or --keys replaces only its own entries) and
// a side-by-side image per click (before above, after below, prototype left, app right). It
// records outcomes only; it does not judge them. Controls that the label does not find go in CLICKS.

import { _electron, chromium, type Browser, type ElectronApplication, type Page } from 'playwright-core';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, posix, relative, resolve } from 'path';
import { readAccepts } from './design-accepts.ts';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(import.meta.dirname, '../..');
const DESIGN = join(ROOT, 'design');
const STALE_MD = join(DESIGN, 'STALE.md');
const OUT = join(DESIGN, '.parity');
const ENV = join(OUT, 'env');
export const WORKSPACE = join(ENV, 'ws', 'klawly-demo');
export const FIXTURES = join(ENV, 'fixtures');
const WIDTH = 1440;
const HEIGHT = 900;
/** Pixels a region may move or grow before it counts as a delta. */
const TOLERANCE = 2;
const PARITY_HEADING = '## Parity';

export type Theme = 'dark' | 'light';

/** Prototype `data-label` → the app element that draws the same region. */
const REGIONS: Record<string, string> = {
	'Title bar': '.part.titlebar',
	'Menu bar': '.part.titlebar .menubar',
	'Explorer': '.part.sidebar',
	'Editor area': '.part.editor > .content',
	'Editor tabs': '.part.editor .tabs-and-actions-container',
	'Breadcrumbs': '.part.editor .breadcrumbs-below-tabs',
	'Status bar': '.part.statusbar',
	'Agent pane': '.part.auxiliarybar',
	// The pane lends its header to the auxiliary bar's title row, so the tabs sit outside `.claude-pane`.
	'Chat tabs': '.part.auxiliarybar .claude-tabs',
	'Empty chat': '.claude-pane .claude-empty',
	'Conversation': '.claude-pane .claude-timeline-host',
	'Composer': '.claude-pane .claude-composer',
	'Changes bar': '.claude-pane .claude-changes-bar',
	'Klawly Settings': '.claude-settings',
	'Model menu': '.claude-model-menu',
	'Permission card': '.claude-pane .claude-permission',
	'Chat menu (VS Code context menu)': '.context-view .monaco-menu',
	'Agents window': '.claude-agent-shell > .claude-pane',
	'Agents list': '.claude-agents',
	'Change navigator': '.claude-review-bar',
	'Keep / Undo on a change': '.claude-hunk-actions',
	'Review header': '.claude-review-editor-header',
	'File diff (VS Code multi-diff)': '.multiDiffEntry',
	'Keyboard shortcuts editor': '.keybindings-editor .keybindings-table-container',
	'Queued prompts': '.claude-pane .claude-queue',
	'Inline edit result': '.claude-inline-zone',
	'Inline edit': '.claude-inline-zone .claude-inline',
	'Tab suggestion (ghost text)': 'line:.part.editor .ghost-text-decoration',
};

// macOS draws the menu bar natively, outside the window, so the page's menu bar has nothing to match there.
const FRAME = ['Title bar', ...(process.platform === 'darwin' ? [] : ['Menu bar']), 'Explorer', 'Editor area', 'Status bar', 'Agent pane'];

export interface Driver {
	readonly page: Page;
	wait(ms: number): Promise<void>;
	command(text: string, settle?: number): Promise<void>;
	escape(times?: number): Promise<void>;
	openFile(name: string): Promise<void>;
	send(fixture: string, text: string, settle: number): Promise<void>;
	click(selector: string, settle?: number): Promise<void>;
	/** Drags the agent pane's edge until the pane is `width` wide. */
	widenPane(width: number): Promise<void>;
}

interface State {
	/** The design/ page this state matches. */
	readonly page: string;
	/** Brings the app from the workbench with cartService.ts open to what the page draws. */
	drive(driver: Driver): Promise<void>;
	/** Runs after the shot, so the next state starts from a clean editor. */
	cleanup?(driver: Driver): Promise<void>;
	readonly regions: readonly string[];
}

export const DISCOUNT_ASK = 'Add a discount code to the cart. Codes come from discounts.ts, matching should ignore case.';
const COMPOSER_TEXT = 'Add an expiry date to the codes in @discounts.ts and reject expired codes in @cartService.ts. Cover both with a test.';
export const CHECKOUT_ASK = 'The checkout test fails now and then. Find out why.';
export const COMPOSER_INPUT = '.claude-pane textarea.claude-composer-input';

/** Puts the cursor at the start of `line` in the active editor. */
async function goToLine(d: Driver, line: number): Promise<void> {
	await d.page.keyboard.press('Control+G');
	await d.wait(500);
	await d.page.keyboard.type(String(line));
	await d.page.keyboard.press('Enter');
	await d.wait(500);
}

/** Selects applyDiscount in cartService.ts as the `finished` turn wrote it. */
export async function selectApplyDiscount(d: Driver): Promise<void> {
	await goToLine(d, APPLY_DISCOUNT_LINE);
	for (let i = 0; i < APPLY_DISCOUNT_LENGTH; i++) {
		await d.page.keyboard.press('Shift+ArrowDown');
	}
}

/** Opens Klawly Settings on the page whose nav label matches. */
export async function openSettings(d: Driver, label: RegExp): Promise<void> {
	await d.command('Open Klawly Settings', 2500);
	await d.page.locator('button.claude-settings-nav-item').filter({ has: d.page.locator('span.label', { hasText: label }) }).first().click({ timeout: 4000 });
	await d.wait(1000);
}

/** Runs the palette command whose label is exactly `label`, where a longer label also matches the text. */
export async function runExactCommand(d: Driver, label: string, settle = 1500): Promise<void> {
	await d.page.keyboard.press('ControlOrMeta+Shift+P');
	await d.page.locator('.quick-input-widget').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });
	await d.wait(500);
	await d.page.keyboard.type(label);
	await d.wait(900);
	await d.page.locator('.quick-input-list .monaco-list-row').filter({ has: d.page.locator('.label-name').getByText(label, { exact: true }) }).first().click({ timeout: 4000 });
	await d.wait(settle);
}

/** Leaves cartService.ts as the `finished` turn wrote it, on disk and in the editor. */
export async function revertCartService(d: Driver): Promise<void> {
	await d.escape(2);
	writeFileSync(join(WORKSPACE, 'src/cart/cartService.ts'), CART_SERVICE_AFTER);
	await d.command('File: Revert File', 1000);
}

/** A new session whose turn wrote discounts.ts and edited cartService.ts and its test, all pending review. */
export async function finishTurn(d: Driver): Promise<void> {
	await d.command('New Agent Session', 1500);
	resetEdits();
	await d.send('finished', DISCOUNT_ASK, 6000);
}

const STATES: readonly State[] = [
	{
		page: 'workbench/editor.html',
		// The page's tabs: cartService.ts (active), discounts.ts, CLAUDE.md.
		drive: async d => {
			await d.openFile('discounts.ts');
			await d.openFile('CLAUDE.md');
			await d.openFile('cartService.ts');
		},
		// The page draws a finished turn in the pane; chat/turn-finished.html compares the pane's insides.
		regions: [...FRAME, 'Editor tabs', 'Breadcrumbs'],
	},
	{
		page: 'chat/new-chat.html',
		drive: async d => { await d.command('New Agent Session', 2000); },
		regions: ['Agent pane', 'Chat tabs', 'Empty chat', 'Composer'],
	},
	{
		page: 'chat/composer-typed.html',
		// The page's chips are cartService.ts, Branch diff vs main and Problems; the branch diff needs the git extension.
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.click(COMPOSER_INPUT, 300);
			for (const chip of ['cartService.ts', 'Problems']) {
				await d.page.keyboard.type(`@${chip}`);
				await d.wait(1200);
				await d.page.keyboard.press('Enter');
				await d.wait(600);
			}
			await d.page.keyboard.type(COMPOSER_TEXT);
			await d.wait(800);
		},
		regions: ['Agent pane', 'Chat tabs', 'Empty chat', 'Composer'],
	},
	{
		page: 'chat/turn-finished.html',
		drive: finishTurn,
		regions: ['Agent pane', 'Chat tabs', 'Conversation', 'Composer', 'Changes bar'],
	},
	{
		page: 'chat/turn-running.html',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.send('running', CHECKOUT_ASK, 3500);
			await d.page.keyboard.type('When it passes, run the whole checkout suite once');
			await d.page.keyboard.press('Enter');
			await d.wait(1000);
		},
		regions: ['Agent pane', 'Conversation', 'Queued prompts', 'Composer'],
	},
	{
		page: 'chat/model-menu.html',
		drive: async d => {
			await finishTurn(d);
			// The menu lists the models first; the review the turn opens can take focus and close it, so try twice.
			const menu = d.page.locator('.claude-model-menu').first();
			for (let attempt = 0; attempt < 2 && !(await menu.isVisible()); attempt++) {
				await d.click('.claude-pane button.claude-model-pill', 0);
				await menu.waitFor({ state: 'visible', timeout: 4000 }).catch(() => undefined);
			}
			// The page also draws the model list beside the menu.
			await menu.locator('[data-setting="model"]').first().hover({ timeout: 4000 });
			await d.wait(800);
		},
		regions: ['Agent pane', 'Composer', 'Model menu'],
	},
	{
		page: 'chat/more-menu.html',
		// The session's "...", not the pane container's; the session header sits in the part's title row.
		drive: async d => {
			await finishTurn(d);
			await d.click('.part.auxiliarybar .claude-pane-actions button[aria-label="More actions"]');
		},
		regions: ['Agent pane', 'Chat tabs', 'Chat menu (VS Code context menu)'],
	},
	{
		page: 'chat/permission.html',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.send('permission', CHECKOUT_ASK, 3000);
		},
		regions: ['Agent pane', 'Conversation', 'Permission card', 'Composer'],
	},
	{
		page: 'review/inline-changes.html',
		drive: async d => {
			// The page draws cartService.ts in its plain editor: the turn's review tabs are diff
			// editors, where the change navigator carries Keep and Undo and the hunks get no chips.
			await finishTurn(d);
			await d.openFile('cartService.ts');
		},
		regions: ['Editor area', 'Change navigator', 'Keep / Undo on a change', 'Agent pane', 'Changes bar'],
	},
	{
		page: 'review/review-editor.html',
		drive: async d => {
			await finishTurn(d);
			await d.command('Review Chat Changes', 2500);
		},
		regions: ['Editor area', 'Review header', 'File diff (VS Code multi-diff)', 'Keep / Undo on a change', 'Agent pane', 'Changes bar'],
	},
	{
		page: 'settings/general.html',
		drive: d => openSettings(d, /^General$/),
		regions: ['Editor area', 'Klawly Settings', 'Agent pane'],
	},
	{
		page: 'settings/keyboard-shortcuts.html',
		// Not by Ctrl+K Ctrl+S: in the editor Ctrl+K starts an inline edit. The palette also lists
		// the JSON variants under the same words, so the row is picked by its exact label.
		drive: async d => {
			await d.escape(2);
			await runExactCommand(d, 'Preferences: Open Keyboard Shortcuts', 2500);
		},
		regions: ['Editor area', 'Keyboard shortcuts editor', 'Agent pane'],
	},
	{
		page: 'editor/inline-edit-result.html',
		// The fake's `inline-edit` turn rewrites applyDiscount as one hunk, so the edit stays in the editor.
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.openFile('cartService.ts');
			await revertCartService(d);
			writeFileSync(join(FIXTURES, 'next.txt'), 'inline-edit');
			await selectApplyDiscount(d);
			await d.page.keyboard.press('ControlOrMeta+Alt+K');
			await d.wait(1000);
			await d.page.keyboard.type(INLINE_EDIT_ASK);
			await d.page.keyboard.press('Enter');
			await d.wait(5000);
		},
		cleanup: revertCartService,
		regions: ['Editor area', 'Inline edit result', 'Inline edit', 'Agent pane'],
	},
	{
		page: 'editor/tab-completion.html',
		// The fake answers a Tab request with completion.txt: the rest of remove().
		drive: async d => {
			await revertCartService(d);
			await goToLine(d, APPLY_DISCOUNT_LINE - 2);
			await d.page.keyboard.press('End');
			await d.page.keyboard.press('Enter');
			await d.page.keyboard.press('Enter');
			await d.page.keyboard.type('remove(');
			// The editor closes the bracket; the page draws the suggestion right after the "(".
			await d.page.keyboard.press('Delete');
			await d.wait(4000);
		},
		cleanup: revertCartService,
		regions: ['Editor area', 'Editor tabs', 'Tab suggestion (ghost text)'],
	},
	{
		// Last: it leaves the pane wide. The agents column shows once the pane fits it beside the chat.
		page: 'chat/agents-list.html',
		// The column is off by default (agents list on top); the toggle turns it on and cleanup turns it off.
		drive: async d => {
			await finishTurn(d);
			await d.command('Toggle Agents Sidebar', 1000);
			// The part's edge takes a pixel from the chat's width, so a 640px part can leave the
			// chat just short of the column's minimum; widen a pixel at a time until it shows.
			for (let width = 640; width <= 644; width++) {
				await d.widenPane(width);
				if (await d.page.locator('.claude-agents').isVisible()) {
					break;
				}
			}
		},
		cleanup: async d => {
			await d.escape(2);
			await d.command('Toggle Agents Sidebar', 1000);
		},
		regions: ['Agent pane', 'Agents window', 'Agents list', 'Composer', 'Changes bar'],
	},
];

/** Pages no state can bring the app to, and why. The Parity section lists them. */
const NOT_REACHED: Record<string, string> = {
	'onboarding/first-run.html': 'the fake runtime reports Claude Code installed and signed in, so the setup card never shows',
	'chat/agents-window.html': 'it is a second window; the tool drives one',
	'workbench/source-control.html': 'the git extension does not activate in the dev build',
	'workbench/diff-editor.html': 'the git extension does not activate in the dev build',
	'workbench/run-debug.html': 'it needs a debug session',
};

interface Box {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly background: string;
	readonly fontSize: number;
}

interface RegionResult {
	readonly label: string;
	readonly proto: Box | null;
	readonly app: Box | null;
	readonly deltas: string[];
}

interface StateResult {
	readonly theme: Theme;
	readonly page: string;
	readonly regions: RegionResult[];
	readonly error?: string;
}

/**
 * Runs in the page: the first visible match of each selector, with its effective background
 * (the first ancestor that paints one) and its font size. A string so this file needs no DOM types.
 */
const MEASURE = `selectors => selectors.map(selector => {
	// 'line:' joins the matches on the first match's row: the editor draws ghost text as one span per token.
	const line = selector.startsWith('line:');
	const matches = [...document.querySelectorAll(line ? selector.slice(5) : selector)].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
	const element = matches[0];
	if (!element) {
		return null;
	}
	let rect = element.getBoundingClientRect();
	if (line) {
		const row = matches.map(e => e.getBoundingClientRect()).filter(r => Math.abs(r.y - rect.y) < 2);
		const left = Math.min(...row.map(r => r.left)), right = Math.max(...row.map(r => r.right));
		rect = { x: left, y: rect.y, width: right - left, height: rect.height };
	}
	let background = 'rgba(0, 0, 0, 0)';
	// The editor paints the current line as an overlay beside the text, not behind it.
	const overlay = line ? element.closest('.monaco-editor')?.querySelector('.current-line-exact') : null;
	for (let e = overlay ?? element; e; e = e.parentElement) {
		const color = getComputedStyle(e).backgroundColor;
		if (color && color !== 'transparent' && !/^rgba\\(.*,\\s*0\\)$/.test(color) && !/\\/\\s*0\\)$/.test(color)) {
			background = color;
			break;
		}
	}
	return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), background, fontSize: parseFloat(getComputedStyle(element).fontSize) };
})`;

async function measure(page: Page, selectors: readonly string[]): Promise<(Box | null)[]> {
	return page.evaluate(`(${MEASURE})(${JSON.stringify(selectors)})`) as Promise<(Box | null)[]>;
}

/**
 * `rgb(…)`, `rgba(…)` or `color(srgb …)` → `[r, g, b, a]` on 0-255 with alpha on 0-1. A `color-mix()`
 * background computes to `color(srgb 0.12 0.12 0.12)`, whose channels run 0-1.
 */
function channels(color: string): number[] {
	const parts = color.match(/[\d.]+/g)?.map(Number) ?? [];
	if (parts.length < 3) {
		return [];
	}
	const scale = color.startsWith('color(') ? 255 : 1;
	return [...parts.slice(0, 3).map(n => n * scale), parts.length > 3 ? parts[3] : 1];
}

/** A computed color → `#rrggbb` or `#rrggbbaa`. */
function hex(color: string): string {
	const parts = channels(color);
	if (!parts.length) {
		return color;
	}
	const rgb = parts.slice(0, 3).map(n => Math.round(n).toString(16).padStart(2, '0')).join('');
	return parts[3] < 1 ? `#${rgb}${Math.round(parts[3] * 255).toString(16).padStart(2, '0')}` : `#${rgb}`;
}

function sameColor(a: string, b: string): boolean {
	const pa = channels(a);
	const pb = channels(b);
	return pa.length && pb.length ? [0, 1, 2].every(i => Math.abs(pa[i] - pb[i]) <= 1) && Math.abs(pa[3] - pb[3]) <= 0.02 : false;
}

function compare(label: string, proto: Box | null, app: Box | null): RegionResult {
	const deltas: string[] = [];
	if (!proto) {
		deltas.push('not drawn in the prototype');
	} else if (!app) {
		deltas.push(`not found in the app (\`${REGIONS[label]}\`)`);
	} else {
		for (const key of ['x', 'y', 'width', 'height'] as const) {
			if (Math.abs(proto[key] - app[key]) > TOLERANCE) {
				deltas.push(`${key} ${proto[key]} → ${app[key]}`);
			}
		}
		if (!sameColor(proto.background, app.background)) {
			deltas.push(`background ${hex(proto.background)} → ${hex(app.background)}`);
		}
		if (Math.abs(proto.fontSize - app.fontSize) > 0.5) {
			deltas.push(`font size ${proto.fontSize}px → ${app.fontSize}px`);
		}
	}
	return { label, proto, app, deltas };
}

function shotName(theme: Theme, page: string): string {
	return `${theme}-${page.replace(/\.html$/, '').replace(/\//g, '_')}`;
}

function parseArgs(argv: string[]): { themes: Theme[]; only?: Set<string>; exe?: string; browser: string; clicks: boolean; keys?: RegExp } {
	const value = (flag: string) => {
		const index = argv.indexOf(flag);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const theme = value('--theme');
	const only = value('--only');
	const keys = value('--keys');
	return {
		themes: theme === 'dark' || theme === 'light' ? [theme] : ['dark', 'light'],
		only: only ? new Set(only.split(',').map(p => p.replace(/\\/g, '/').replace(/^design\//, ''))) : undefined,
		exe: value('--exe'),
		browser: value('--browser') ?? (process.platform === 'win32' ? 'msedge' : 'chrome'),
		clicks: argv.includes('--clicks'),
		keys: keys ? new RegExp(keys, 'i') : undefined,
	};
}

export function devExecutable(): string {
	const product = JSON.parse(readFileSync(join(ROOT, 'product.json'), 'utf8'));
	switch (process.platform) {
		case 'darwin': return join(ROOT, '.build', 'electron', `${product.nameLong}.app`, 'Contents', 'MacOS', product.nameShort);
		case 'linux': return join(ROOT, '.build', 'electron', product.applicationName);
		default: return join(ROOT, '.build', 'electron', `${product.nameShort}.exe`);
	}
}

// --- Fixture workspace -------------------------------------------------------------------------

const CART_SERVICE_BEFORE = `import { CartItem, CartTotals } from './cartTypes';

/** Keeps the items in a cart and works out its totals. */
export class CartService {
	private readonly items = new Map<string, CartItem>();

	add(item: CartItem): void {
		const current = this.items.get(item.sku);
		this.items.set(item.sku, { ...item, quantity: (current?.quantity ?? 0) + item.quantity });
	}

	totals(): CartTotals {
		let subtotal = 0;
		for (const item of this.items.values()) {
			subtotal += item.price * item.quantity;
		}
		return { subtotal, discount: 0, total: subtotal };
	}
}
`;

const CART_SERVICE_AFTER = `import { CartItem, CartTotals } from './cartTypes';
import { findDiscount } from './discounts';

/** Keeps the items in a cart and works out its totals. */
export class CartService {
	private readonly items = new Map<string, CartItem>();
	private discountCode: string | undefined;

	add(item: CartItem): void {
		const current = this.items.get(item.sku);
		this.items.set(item.sku, { ...item, quantity: (current?.quantity ?? 0) + item.quantity });
	}

	applyDiscount(code: string): boolean {
		const discount = findDiscount(code.trim().toUpperCase());
		if (!discount) {
			return false;
		}
		this.discountCode = discount.code;
		return true;
	}

	totals(): CartTotals {
		let subtotal = 0;
		for (const item of this.items.values()) {
			subtotal += item.price * item.quantity;
		}
		const discount = this.discountCode ? findDiscount(this.discountCode) : undefined;
		const off = discount ? Math.round(subtotal * discount.percent) / 100 : 0;
		return { subtotal, discount: off, total: subtotal - off };
	}
}
`;

/** Where applyDiscount starts in CART_SERVICE_AFTER, and its line count. */
const APPLY_DISCOUNT_LINE = 14;
const APPLY_DISCOUNT_LENGTH = 8;

export const INLINE_EDIT_ASK = 'Reject expired codes';

/**
 * CART_SERVICE_AFTER after the inline edit. One hunk: an edit with more goes to the full review,
 * so the page's three hunks (DiscountResult) would never show in the editor.
 */
const CART_SERVICE_INLINE = CART_SERVICE_AFTER.replace(`			return false;
		}
`, `			return false;
		}
		if (discount.expiresAt < Date.now()) {
			return false;
		}
`);

/** The Tab suggestion after `remove(`, as the page draws it. */
const REMOVE_COMPLETION = `sku: string): void {
		this.items.delete(sku);
	}`;

const DISCOUNTS = `export interface Discount {
	readonly code: string;
	readonly percent: number;
}

const DISCOUNTS: readonly Discount[] = [
	{ code: 'SPRING10', percent: 10 },
	{ code: 'WELCOME5', percent: 5 },
];

/** Finds a discount by its upper-case code. */
export function findDiscount(code: string): Discount | undefined {
	return DISCOUNTS.find(d => d.code === code);
}
`;

const TEST_BEFORE = `import { CartService } from '../src/cart/cartService';

test('adds items', () => {
	const cart = new CartService();
	cart.add({ sku: 'MUG-01', price: 12, quantity: 2 });
	expect(cart.totals().total).toBe(24);
});
`;

const TEST_AFTER = TEST_BEFORE + `
test('applies a valid code', () => {
	const cart = new CartService();
	cart.add({ sku: 'MUG-01', price: 12, quantity: 2 });
	expect(cart.applyDiscount(' spring10 ')).toBe(true);
});
`;

const PLAN_TEXT = 'I read the cart and its tests. Here is the plan; edit it or build it when it looks right.\n\n# Add discount codes to the cart\n\nCustomers type a code at checkout. The cart looks it up in a fixed table, ignores case, and takes the percent off the subtotal.\n\n1. Add a Discount type and a code table\n   A Discount has a code and a percent. Codes are stored upper case. `cartTypes.ts` `discounts.ts`\n2. Look codes up without case\n   applyDiscount trims and upper-cases the code, then calls findDiscount. `cartService.ts`\n3. Return the discount from totals()\n   Round to cents so the total never drifts.\n4. Test a valid and an unknown code\n   `cartService.test.ts`';

const COVERAGE_COMMAND = 'npm install --save-dev @vitest/coverage-v8';
const COVERAGE_REASON = 'Coverage shows which checkout paths the test never reaches';

/** Claude Code's model list as the fake runtime reports it (models.json), so the model menu shows every row. */
const MODELS = (() => {
	const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
	const full = { supportsEffort: true, supportedEffortLevels: levels, supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true };
	const plain = { supportsEffort: true, supportedEffortLevels: levels.slice(0, 3), supportsAdaptiveThinking: true };
	return [
		{ id: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5 for most work', source: 'alias', resolvedModel: 'claude-opus-5-5', ...full },
		{ id: 'opus', displayName: 'Opus 5.5', description: 'For complex work', source: 'alias', resolvedModel: 'claude-opus-5-5', ...full },
		{ id: 'opus[1m]', displayName: 'Opus 5.5 (1M context)', description: 'For long sessions', source: 'alias', resolvedModel: 'claude-opus-5-5[1m]', ...full },
		{ id: 'sonnet', displayName: 'Sonnet 5.5', description: 'For everyday tasks', source: 'alias', resolvedModel: 'claude-sonnet-5-5', ...plain },
		{ id: 'fable', displayName: 'Fable 5.1', description: 'For writing', source: 'alias', resolvedModel: 'claude-fable-5-1', ...plain },
		{ id: 'haiku', displayName: 'Haiku 5.5', description: 'For quick answers', source: 'alias', resolvedModel: 'claude-haiku-5-5' },
		{ id: 'opusplan', displayName: 'Opus Plan', description: 'Opus 5.5 in plan mode, Sonnet 5.5 otherwise', source: 'alias', ...plain },
		{ id: 'claude-opus-5', displayName: 'Opus 5', source: 'runtime', older: true, ...plain },
		{ id: 'claude-sonnet-5', displayName: 'Sonnet 5', source: 'runtime', older: true, ...plain },
	];
})();

/** Writes the klawly-demo workspace in the state the prototype draws, and the fake-runtime scripts. */
export function setupFixtures(): void {
	rmSync(join(ENV, 'ws'), { recursive: true, force: true });
	mkdirSync(FIXTURES, { recursive: true });
	// A run that stopped mid-shot can leave Claude Code reading as missing (issue 797).
	rmSync(join(FIXTURES, 'runtime.json'), { force: true });
	const files: Record<string, string> = {
		'.claude/settings.json': '{\n\t"permissions": {}\n}\n',
		'node_modules/.keep': '',
		'src/cart/cartService.ts': CART_SERVICE_BEFORE,
		'src/cart/cartTypes.ts': 'export interface CartItem {\n\treadonly sku: string;\n\treadonly price: number;\n\treadonly quantity: number;\n}\n\nexport interface CartTotals {\n\treadonly subtotal: number;\n\treadonly discount: number;\n\treadonly total: number;\n}\n',
		'src/checkout/checkout.ts': 'export function checkout(): void { }\n',
		'src/checkout/paymentClient.ts': 'export async function charge(): Promise<void> { }\n',
		'src/ui/cartView.ts': 'export function renderCart(): void { }\n',
		'src/index.ts': 'export * from \'./cart/cartService\';\n',
		'test/cartService.test.ts': TEST_BEFORE,
		'test/checkout.test.ts': 'test(\'charges the card once\', () => { });\n',
		'CLAUDE.md': '# klawly-demo\n\nA small shop cart used to try Klawly.\n\n- Run tests with `npm test`.\n',
		'package.json': '{\n\t"name": "klawly-demo",\n\t"version": "1.0.0",\n\t"scripts": {\n\t\t"test": "vitest run"\n\t}\n}\n',
		'README.md': '# klawly-demo\n\nA shop cart.\n',
		'tsconfig.json': '{\n\t"compilerOptions": {\n\t\t"strict": true,\n\t\t"target": "ES2022"\n\t}\n}\n',
		'.gitignore': 'node_modules/\n',
	};
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(WORKSPACE, path, '..'), { recursive: true });
		writeFileSync(join(WORKSPACE, path), text);
	}
	const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', ...args], { cwd: WORKSPACE, stdio: 'pipe', windowsHide: true });
	git('init', '-q', '-b', 'main');
	git('add', '-A');
	git('commit', '-q', '-m', 'Initial cart');
	writeDrawnEdits();

	const uri = (path: string) => pathToFileURL(join(WORKSPACE, path)).href;
	const file = (path: string) => join(WORKSPACE, path);
	const S = '$session';
	const tool = (id: string, name: string, category: string, input: object, display: object) => ({ type: 'tool.started', sessionId: S, call: { id, name, category, input, display } });
	const done = (callId: string, output = 'ok', ok = true) => ({ type: 'tool.completed', sessionId: S, callId, result: { ok, output } });
	const write = (callId: string, name: string, path: string, before: string | null, after: string) => [
		tool(callId, name, 'write', { file_path: file(path) }, { label: `${name} ${path}`, file: file(path) }),
		{ type: 'file.beforeWrite', sessionId: S, uri: uri(path), before },
		{ type: 'file.afterWrite', sessionId: S, uri: uri(path), after },
		done(callId),
	];
	const started = { type: 'session.started', sessionId: S, model: 'claude-opus-5-5' };
	const fixtures: Record<string, object[]> = {
		finished: [
			started,
			{ type: 'thinking.delta', sessionId: S, text: 'The cart needs a code table and a case-insensitive lookup.', at: 0 },
			{ type: 'thinking.delta', sessionId: S, text: '', at: 4000, done: true },
			tool('r1', 'Read', 'read', { file_path: file('src/cart/cartService.ts') }, { label: 'Read cartService.ts', file: file('src/cart/cartService.ts') }), done('r1'),
			tool('g1', 'Grep', 'search', { pattern: 'discount', path: 'src' }, { label: 'Grep "discount"', query: 'discount' }), done('g1', 'src/cart/cartService.ts:3\nsrc/cart/cartTypes.ts:9\nsrc/index.ts:1\ntest/cartService.test.ts:4'),
			...write('w1', 'Write', 'src/cart/discounts.ts', null, DISCOUNTS),
			...write('e1', 'Edit', 'src/cart/cartService.ts', CART_SERVICE_BEFORE, CART_SERVICE_AFTER),
			...write('e2', 'Edit', 'test/cartService.test.ts', TEST_BEFORE, TEST_AFTER),
			tool('b1', 'Bash', 'shell', { command: 'npm test -- cart', description: 'Run the cart tests' }, { label: 'npm test -- cart', command: 'npm test -- cart' }), done('b1', ' \u001b[32m✓\u001b[39m test/cartService.test.ts \u001b[2m(14 tests)\u001b[22m\n\n \u001b[2mTest Files\u001b[22m  \u001b[1;32m1 passed\u001b[22;39m (1)\n      \u001b[2mTests\u001b[22m  \u001b[1;32m14 passed\u001b[22;39m (14)'),
			{ type: 'assistant.completed', sessionId: S, text: 'Discount codes now work in the cart.\n\n**What changed**\n\n- `applyDiscount(code)` trims and upper-cases the code before it looks it up.\n- `totals()` returns the discount and the total after it.\n- New `discounts.ts` holds the codes, and two tests cover a valid and an unknown code.\n\nApply a code before you read the totals:\n\n```typescript\nconst cart = new CartService();\ncart.add({ sku: \'MUG-01\', price: 12, quantity: 2 });\ncart.applyDiscount(\' spring10 \'); // true\ncart.totals(); // { subtotal: 24, discount: 2.4, total: 21.6 }\n```\n\n`npm test -- cart` ran 14 tests and all of them passed.' },
			{ type: 'usage.changed', sessionId: S, usage: { inputTokens: 18200, outputTokens: 2100, contextTokens: 41000, contextWindow: 200000 } },
			{ type: 'session.completed', sessionId: S },
			{ type: 'session.titled', sessionId: S, title: 'Discount codes in cart' },
		],
		// Never completes, so a prompt sent after it waits in the queue.
		running: [
			started,
			{ type: 'thinking.delta', sessionId: S, text: 'A flaky payment step usually means a timer or a retry.', at: 0 },
			{ type: 'thinking.delta', sessionId: S, text: '', at: 6000, done: true },
			tool('r1', 'Read', 'read', { file_path: file('test/checkout.test.ts') }, { label: 'Read checkout.test.ts', file: file('test/checkout.test.ts') }), done('r1'),
			tool('g1', 'Grep', 'search', { pattern: 'setTimeout', path: 'src/checkout' }, { label: 'Grep "setTimeout"', query: 'setTimeout' }), done('g1', 'src/checkout/checkout.ts:1\nsrc/checkout/paymentClient.ts:1'),
			tool('r2', 'Read', 'read', { file_path: file('src/checkout/paymentClient.ts') }, { label: 'Read paymentClient.ts', file: file('src/checkout/paymentClient.ts') }), done('r2'),
			tool('b1', 'Bash', 'shell', { command: 'npm test -- checkout --repeat 20' }, { label: 'npm test -- checkout --repeat 20', command: 'npm test -- checkout --repeat 20' }),
			{ type: 'tool.updated', sessionId: S, callId: 'b1', update: { output: Array.from({ length: 16 }, (_, i) => ` ✓ charges the card once (run ${i + 1})`).join('\n') } },
		],
		'inline-edit': [
			started,
			...write('i1', 'Edit', 'src/cart/cartService.ts', CART_SERVICE_AFTER, CART_SERVICE_INLINE),
			{ type: 'assistant.completed', sessionId: S, text: 'applyDiscount now rejects a code past its expiry date.' },
			{ type: 'session.completed', sessionId: S },
		],
		permission: [
			started,
			tool('r1', 'Read', 'read', { file_path: file('test/checkout.test.ts') }, { label: 'Read checkout.test.ts', file: file('test/checkout.test.ts') }), done('r1'),
			tool('b1', 'Bash', 'shell', { command: 'npm test -- checkout --repeat 20' }, { label: 'npm test -- checkout --repeat 20', command: 'npm test -- checkout --repeat 20' }), done('b1', '4 of 20 runs failed', false),
			{ type: 'assistant.delta', sessionId: S, text: '4 of 20 runs failed, always in the payment step. Before I change the retry I want to see which paths the test misses.' },
			// The fields the host adds to a shell request before the card shows it: the command, where it runs and why it asks.
			{ type: 'permission.requested', sessionId: S, request: { id: 'p1', toolName: 'Bash', input: { command: COVERAGE_COMMAND, description: COVERAGE_REASON }, reason: COVERAGE_REASON, category: 'shell', command: COVERAGE_COMMAND, cwd: WORKSPACE, mode: 'agent', canRemember: true, canAllowAllCommands: true, workspaceTrusted: true } },
		],
		// Stops at the step limit (issue 696): the quiet line with Continue, not an error.
		'turn-limit': [
			started,
			tool('r1', 'Read', 'read', { file_path: file('test/checkout.test.ts') }, { label: 'Read checkout.test.ts', file: file('test/checkout.test.ts') }), done('r1'),
			tool('b1', 'Bash', 'shell', { command: 'npm test -- checkout --repeat 20' }, { label: 'npm test -- checkout --repeat 20', command: 'npm test -- checkout --repeat 20' }), done('b1', '4 of 20 runs failed', false),
			{ type: 'assistant.delta', sessionId: S, text: '4 of 20 runs failed, always in the payment step. The retry in paymentClient.ts is the next thing to check.' },
			{ type: 'session.failed', sessionId: S, message: 'Claude stopped after 40 steps.', kind: 'turn-limit', turns: 40 },
		],
		// Stops on the Pro plan's 5-hour limit (issue 450, DL-86): the amber banner with Switch Account first.
		'usage-limit': [
			started,
			tool('r1', 'Read', 'read', { file_path: file('test/checkout.test.ts') }, { label: 'Read checkout.test.ts', file: file('test/checkout.test.ts') }), done('r1'),
			{ type: 'assistant.delta', sessionId: S, text: 'The flaky run fails in the payment step. Next I check the retry in paymentClient.ts.' },
			{ type: 'session.failed', sessionId: S, message: 'Claude usage limit reached.', kind: 'usage-limit', limit: { window: 'session', status: 'rejected', resetsAt: Date.now() + 2 * 60 * 60 * 1000, plan: 'pro' } },
		],
		// Sent in plan mode, so the answer shows as the plan card.
		plan: [
			started,
			tool('r1', 'Read', 'read', { file_path: file('src/cart/cartService.ts') }, { label: 'Read cartService.ts', file: file('src/cart/cartService.ts') }), done('r1'),
			{ type: 'assistant.completed', sessionId: S, text: PLAN_TEXT },
			{ type: 'session.completed', sessionId: S },
			{ type: 'session.titled', sessionId: S, title: 'Plan discount codes' },
		],
	};
	for (const [name, events] of Object.entries(fixtures)) {
		writeFileSync(join(FIXTURES, `${name}.jsonl`), events.map(e => JSON.stringify(e)).join('\n') + '\n');
	}
	writeFileSync(join(FIXTURES, 'next.txt'), 'finished');
	writeFileSync(join(FIXTURES, 'completion.txt'), REMOVE_COMPLETION);
	writeFileSync(join(FIXTURES, 'models.json'), JSON.stringify(MODELS, undefined, '\t'));
}

/** The state the prototype draws: cartService.ts and its test modified, discounts.ts new. */
function writeDrawnEdits(): void {
	writeFileSync(join(WORKSPACE, 'src/cart/cartService.ts'), CART_SERVICE_AFTER);
	writeFileSync(join(WORKSPACE, 'src/cart/discounts.ts'), DISCOUNTS);
	writeFileSync(join(WORKSPACE, 'test/cartService.test.ts'), TEST_AFTER);
}

/** Puts the files the `finished` turn edits back the way they were, so the turn snapshots and writes them again. */
export function resetEdits(): void {
	writeFileSync(join(WORKSPACE, 'src/cart/cartService.ts'), CART_SERVICE_BEFORE);
	writeFileSync(join(WORKSPACE, 'test/cartService.test.ts'), TEST_BEFORE);
	rmSync(join(WORKSPACE, 'src/cart/discounts.ts'), { force: true });
}

// --- App -----------------------------------------------------------------------------------------

/** Launches the app on the fixture workspace, or with no folder open when `folder` is false. */
export async function launchApp(exe: string, theme: Theme, folder = true, size = { width: WIDTH, height: HEIGHT }, settings: Record<string, unknown> = {}): Promise<{ app: ElectronApplication; page: Page }> {
	const userData = join(ENV, `user-data-${theme}`);
	rmSync(userData, { recursive: true, force: true });
	mkdirSync(join(userData, 'User'), { recursive: true });
	writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify({
		'claude.agent.runtime': 'fake',
		'workbench.colorTheme': theme === 'light' ? 'Klawly Light' : 'Klawly Dark',
		'telemetry.telemetryLevel': 'off',
		'update.mode': 'none',
		'extensions.autoCheckUpdates': false,
		'git.openRepositoryInParentFolders': 'always',
		// The prototype's model pill reads "Opus 5.5 High".
		'claude.models.default': 'opus',
		'claude.models.effort': { opus: 'high' },
		...settings,
	}, undefined, '\t'));
	const dev = exe === devExecutable();
	const app = await _electron.launch({
		executablePath: exe,
		args: [...(dev ? [ROOT] : []), '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust', `--user-data-dir=${userData}`, `--extensions-dir=${join(ENV, 'extensions')}`, ...(folder ? [WORKSPACE] : [])],
		env: { ...process.env, ...(dev ? { NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1' } : {}), KLAWLY_FAKE_FIXTURE_DIR: FIXTURES },
		cwd: ROOT,
		timeout: 180000,
	});
	const page = await app.firstWindow({ timeout: 180000 });
	await app.evaluate(({ BrowserWindow }, size) => {
		const window = BrowserWindow.getAllWindows()[0];
		window.setContentSize(size.width, size.height);
		window.center();
	}, size);
	await page.waitForSelector('.monaco-workbench', { timeout: 180000 });
	await page.waitForTimeout(8000);
	return { app, page };
}

export function driver(page: Page): Driver {
	const wait = (ms: number) => page.waitForTimeout(ms);
	const d: Driver = {
		page,
		wait,
		command: async (text, settle = 1500) => {
			await page.keyboard.press('ControlOrMeta+Shift+P');
			// The first palette of a run can take seconds to open; typing before it lands in the editor.
			await page.locator('.quick-input-widget').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });
			await wait(500);
			await page.keyboard.type(text);
			await wait(900);
			await page.keyboard.press('Enter');
			await wait(settle);
		},
		escape: async (times = 1) => {
			for (let i = 0; i < times; i++) {
				await page.keyboard.press('Escape');
				await wait(250);
			}
		},
		openFile: async name => {
			await page.keyboard.press('ControlOrMeta+P');
			await wait(500);
			await page.keyboard.type(name);
			await wait(900);
			await page.keyboard.press('Enter');
			await wait(1500);
		},
		send: async (fixture, text, settle) => {
			writeFileSync(join(FIXTURES, 'next.txt'), fixture);
			await page.locator(COMPOSER_INPUT).first().click();
			await page.keyboard.press('ControlOrMeta+A');
			await page.keyboard.press('Backspace');
			await page.keyboard.type(text);
			await wait(300);
			await page.keyboard.press('Enter');
			await wait(settle);
		},
		click: async (selector, settle = 1000) => {
			await page.locator(selector).first().click({ timeout: 4000 });
			await wait(settle);
		},
		widenPane: async width => {
			// The sash sits on the pane's left edge; a drag can land a pixel short, so measure and drag again.
			for (let attempt = 0; attempt < 3; attempt++) {
				const pane = await page.locator('.part.auxiliarybar').boundingBox();
				if (!pane) {
					throw new Error('Agent pane: not found in the app');
				}
				if (Math.round(pane.width) >= width) {
					return;
				}
				const y = pane.y + pane.height / 2;
				await page.mouse.move(pane.x, y);
				await page.mouse.down();
				await page.mouse.move(pane.x - (width - pane.width), y, { steps: 10 });
				await page.mouse.up();
				await wait(1000);
			}
		},
	};
	return d;
}

async function shootApp(exe: string, theme: Theme, states: readonly State[]): Promise<Map<string, { boxes: (Box | null)[]; error?: string }>> {
	const results = new Map<string, { boxes: (Box | null)[]; error?: string }>();
	const { app, page } = await launchApp(exe, theme);
	try {
		const d = driver(page);
		await d.command('Notifications: Clear All Notifications', 500);
		for (const state of states) {
			try {
				// A menu or picker the last state left open would take the keys below.
				await d.escape(2);
				await d.command('View: Close All Editors', 800);
				await d.openFile('cartService.ts');
				await state.drive(d);
				await page.screenshot({ path: join(OUT, 'app', `${shotName(theme, state.page)}.png`) });
				results.set(state.page, { boxes: await measure(page, state.regions.map(label => REGIONS[label])) });
				await state.cleanup?.(d);
				console.log(`design-parity: app ${theme} ${state.page}`);
			} catch (error) {
				results.set(state.page, { boxes: [], error: String(error instanceof Error ? error.message : error).split('\n')[0] });
				await d.escape(3).catch(() => { });
			}
		}
	} finally {
		await app.close().catch(() => { });
	}
	return results;
}

// --- Prototype -----------------------------------------------------------------------------------

async function shootPrototype(browser: Browser, theme: Theme, states: readonly State[]): Promise<Map<string, (Box | null)[]>> {
	const results = new Map<string, (Box | null)[]>();
	const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
	// The prototype's own theme switch and overlays (origin labels, app marks) are off.
	await context.addInitScript({ content: `try { localStorage.setItem('klawly-proto-theme', ${JSON.stringify(theme)}); localStorage.setItem('klawly-proto-app', '0'); localStorage.setItem('klawly-proto-origins', '0'); } catch { }` });
	const page = await context.newPage();
	for (const state of states) {
		await page.goto(pathToFileURL(join(DESIGN, state.page)).href);
		await page.addStyleTag({ content: '.proto-fab, .proto-drawer { display: none !important; }' });
		await page.waitForTimeout(700);
		await page.screenshot({ path: join(OUT, 'proto', `${shotName(theme, state.page)}.png`) });
		results.set(state.page, await measure(page, state.regions.map(label => `[data-label="${label}"]`)));
	}
	await context.close();
	return results;
}

/** Prototype on the left, app on the right, at 60%; regions with a delta are outlined in both. */
async function composePair(browser: Browser, theme: Theme, result: StateResult): Promise<void> {
	const name = shotName(theme, result.page);
	const scale = 0.6;
	const box = (b: Box | null, label: string) => b ? `<div class="box" style="left:${b.x * scale}px;top:${b.y * scale}px;width:${b.width * scale}px;height:${b.height * scale}px"><span>${label}</span></div>` : '';
	const cell = (caption: string, image: string, side: 'proto' | 'app') => {
		const src = existsSync(image) ? `<img src="${pathToFileURL(image).href}">` : '<div class="none">Not reached</div>';
		const boxes = result.regions.filter(r => r.deltas.length).map(r => box(r[side], r.label)).join('');
		return `<figure><figcaption>${caption}</figcaption><div class="shot">${src}${boxes}</div></figure>`;
	};
	const html = `<!doctype html><style>
body { margin: 0; background: #111; color: #ddd; font: 600 14px system-ui; display: flex; gap: 16px; padding: 12px; }
figure { margin: 0; width: ${WIDTH * scale}px; }
figcaption { padding: 0 0 6px; }
.shot { position: relative; width: ${WIDTH * scale}px; height: ${HEIGHT * scale}px; outline: 1px solid #444; }
.shot img { width: 100%; display: block; }
.none { height: 100%; display: grid; place-items: center; }
.box { position: absolute; box-sizing: border-box; border: 2px solid #f14c4c; }
.box span { position: absolute; top: 0; left: 0; background: #f14c4c; color: #fff; font: 600 10px system-ui; padding: 0 3px; white-space: nowrap; }
</style>${cell(`Prototype: design/${result.page}`, join(OUT, 'proto', `${name}.png`), 'proto')}${cell(`App (${theme})`, join(OUT, 'app', `${name}.png`), 'app')}`;
	const page = await browser.newPage({ viewport: { width: Math.ceil(WIDTH * scale * 2 + 40), height: Math.ceil(HEIGHT * scale + 50) } });
	const file = join(OUT, 'pairs', `${name}.html`);
	writeFileSync(file, html);
	await page.goto(pathToFileURL(file).href);
	await page.waitForFunction('[...document.images].every(i => i.complete)');
	await page.screenshot({ path: join(OUT, 'pairs', `${name}.png`), fullPage: true });
	await page.close();
	rmSync(file);
}

// --- Clicks --------------------------------------------------------------------------------------

const CLICKS_OUT = join(OUT, 'clicks');
export const MODE_PILL = '.claude-pane button.claude-pill:not(.claude-model-pill)';

/** One unique click from design/.accepts, in the state of the first page it appears on. */
interface Click {
	readonly key: string;
	readonly page: string;
	/** app, differs or idea: what the prototype claims about the app. */
	readonly mark: string;
	readonly label: string;
	readonly icon: string;
	/** Names its screenshots. */
	readonly name: string;
}

/** A click the app needs help with: where its control is, or what to open first. */
interface ClickMapping {
	/** The app control, when its label does not find it. */
	readonly selector?: string;
	/** Runs after the state's drive, to bring the control into view (open a menu, hover a row). */
	drive?(driver: Driver): Promise<void>;
	/** Why the click is not tried in the app. */
	readonly skip?: string;
}

/** Click key → how to find its control in the app, where finding it by its label does not work. */
const CLICKS: Record<string, ClickMapping> = {
	// The title bar's agent toggle is the secondary side bar's layout control.
	'k-icon-btn | Toggle Agent | layout-sidebar-right-off -> chat/turn-finished.html': { selector: '.part.titlebar .action-label[class*="codicon-auxiliarybar-right"]' },
	'k-icon-btn | Toggle Agent | layout-sidebar-right-off -> chat/new-chat.html': { selector: '.part.titlebar .action-label[class*="codicon-auxiliarybar-right"]' },
	// Its label carries the real usage, which the fake runtime does not make 72%.
	'k-context-ring | Context: 72% used (144,000 of 200,000 tokens) |  -> chat/context-window.html': { selector: 'button.claude-context-ring' },
	// The count is a badge beside the label; the fixture may have no problems.
	'k-panel-tab | Problems 1 |  -> workbench/panel.html': { selector: '.part.panel .composite-bar .action-label[aria-label^="Problems"]' },
	'k-panel-tab | Problems 1 |  -> #': { selector: '.part.panel .composite-bar .action-label[aria-label^="Problems"]' },
	'k-panel-tab | Problems 1 |  -> workbench/panel.html#problems': { selector: '.part.panel .composite-bar .action-label[aria-label^="Problems"]' },
};

/** How to bring the app to a page that STATES does not cover (or covers differently), for its clicks. */
interface ClickState {
	/** `proto` tells what the prototype opened first so the control shows (a tab, a menu). */
	drive(driver: Driver, click: Click, proto: ProtoClick | undefined): Promise<void>;
	/** Launch with no folder open. */
	readonly noFolder?: boolean;
	/** The drive depends on the click, so the next click on the page cannot reuse it. */
	readonly perClick?: boolean;
}

export async function planTurn(d: Driver): Promise<void> {
	await d.command('New Agent Session', 1500);
	await d.click(MODE_PILL, 600);
	await d.page.locator('.claude-mode-menu, .context-view .monaco-menu').getByText('Plan', { exact: true }).first().click({ timeout: 4000 });
	await d.wait(400);
	await d.send('plan', 'Plan how to add discount codes to the cart. Codes come from discounts.ts and matching should ignore case.', 4000);
}

/** Types into the composer of a new session, so its `@` or `/` menu opens. */
async function composerMenu(d: Driver, trigger: string): Promise<void> {
	await d.command('New Agent Session', 1500);
	await d.click(COMPOSER_INPUT, 300);
	await d.page.keyboard.type(trigger);
	await d.wait(900);
}

const CLICK_STATES: Record<string, ClickState> = {
	'chat/agent-editor.html': { drive: async d => { await finishTurn(d); await d.command('Open Chat in Editor', 2500); } },
	'chat/context-menu.html': { drive: d => composerMenu(d, '@') },
	'chat/slash-menu.html': { drive: d => composerMenu(d, '/') },
	'chat/mode-menu.html': { drive: async d => { await d.command('New Agent Session', 1500); await d.click(MODE_PILL, 700); } },
	'chat/context-window.html': { drive: finishTurn },
	'editor/selection-toolbar.html': { drive: async d => { await selectApplyDiscount(d); await d.wait(1200); } },
	'editor/inline-edit.html': {
		drive: async d => {
			await selectApplyDiscount(d);
			await d.page.keyboard.press('ControlOrMeta+Alt+K');
			await d.wait(1000);
			await d.page.keyboard.type(INLINE_EDIT_ASK);
			await d.wait(500);
		},
	},
	'editor/terminal-prompt.html': {
		drive: async d => {
			await d.page.keyboard.press('Control+`');
			await d.wait(2500);
			await d.command('Ask Claude for a Terminal Command', 1500);
			await d.page.keyboard.type('find the slowest test');
			await d.wait(500);
		},
	},
	'home/empty-editor.html': { drive: d => d.command('View: Close All Editors', 800) },
	'home/home.html': { noFolder: true, drive: d => d.wait(500) },
	'plan/plan-card.html': { drive: planTurn },
	'plan/plan-editor.html': { drive: async d => { await planTurn(d); await d.command('Open Chat Plan as File', 2500); } },
	'settings/agents.html': { drive: d => openSettings(d, /^Agents?$/) },
	'settings/beta.html': { drive: d => openSettings(d, /^Beta$/) },
	'settings/customize.html': { drive: d => openSettings(d, /^Customi[sz]e$/) },
	'settings/git.html': { drive: d => openSettings(d, /^Git/) },
	'settings/models.html': { drive: d => openSettings(d, /^Models$/) },
	'settings/plan-usage.html': { drive: d => openSettings(d, /Plan|Usage/) },
	'settings/tab.html': { drive: d => openSettings(d, /^Tab$/) },
	'settings/classic-settings.html': { drive: d => d.command('Preferences: Open Settings (UI)', 2500) },
	// The page filters by ">agent"; typing the row's first words keeps its row on screen.
	'workbench/command-palette.html': {
		perClick: true,
		drive: async (d, click) => {
			await d.page.keyboard.press('ControlOrMeta+Shift+P');
			await d.wait(500);
			await d.page.keyboard.type(click.label.split(' ').slice(0, 3).join(' '));
			await d.wait(900);
		},
	},
	'workbench/quick-open.html': {
		drive: async d => {
			await d.page.keyboard.press('ControlOrMeta+P');
			await d.wait(500);
			await d.page.keyboard.type('cart');
			await d.wait(900);
		},
	},
	'workbench/search.html': {
		drive: async d => {
			await d.page.keyboard.press('ControlOrMeta+Shift+F');
			await d.wait(500);
			await d.page.keyboard.type('discount');
			await d.wait(2500);
		},
	},
	'workbench/run-debug.html': { drive: async d => { await d.page.keyboard.press('ControlOrMeta+Shift+D'); await d.wait(1500); } },
	'workbench/extensions.html': { drive: async d => { await d.page.keyboard.press('ControlOrMeta+Shift+X'); await d.wait(2500); } },
	// The page draws the File menu, and the Explorer context menu on its second tab.
	'workbench/menus.html': {
		perClick: true,
		drive: async (d, _click, proto) => {
			if (proto?.prep.some(p => p.includes('Explorer context menu'))) {
				await d.page.locator('.part.sidebar .explorer-folders-view .monaco-list-row').filter({ hasText: /^\s*cartService\.ts/ }).first().click({ button: 'right', timeout: 4000 });
				await d.wait(800);
			} else if (proto?.regions.includes('Menu')) {
				await d.click('.part.titlebar .menubar-menu-button[aria-label="File"]', 800);
			}
		},
	},
	'workbench/editor-widgets.html': {
		drive: async d => {
			await d.click('.part.editor .monaco-editor .view-lines', 300);
			await d.page.keyboard.press('ControlOrMeta+F');
			await d.wait(300);
			await d.page.keyboard.type('discount');
			await d.wait(800);
		},
	},
	'workbench/notifications.html': { drive: d => d.command('Notifications: Show Notifications', 800) },
	'workbench/panel.html': { drive: async d => { await d.page.keyboard.press('Control+`'); await d.wait(3000); } },
};

/** The state a page's clicks run in, or why the app cannot reach it. */
function clickState(page: string): ClickState | string {
	const state = CLICK_STATES[page] ?? STATES.find(s => s.page === page);
	return state ?? (NOT_REACHED[page] ? `the app cannot reach ${page}: ${NOT_REACHED[page]}` : `no state drives the app to ${page}`);
}

function decodeEntities(text: string): string {
	return text.replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** The unique clicks design/.accepts lists, each with the first page (in its order) it appears on. */
function readClickList(only: Set<string> | undefined, keys: RegExp | undefined): Click[] {
	const sync = readAccepts(join(DESIGN, '.accepts'));
	const clicks = new Map<string, Click>();
	for (const [page, marks] of Object.entries(sync?.clicks ?? {})) {
		for (const [key, mark] of Object.entries(marks)) {
			const parts = /^(?<classes>[^ |]*) \| (?<label>.*) \| (?<icon>[a-z0-9-]*) -> (?<target>.*)$/.exec(key)?.groups;
			if (clicks.has(key) || !parts) {
				continue;
			}
			const label = decodeEntities(parts.label);
			const slug = `${page.replace(/\.html$/, '').replace(/\//g, '_')}--${label.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
			clicks.set(key, { key, page, mark, label, icon: parts.icon, name: `${slug}-${createHash('sha1').update(key).digest('hex').slice(0, 6)}` });
		}
	}
	// An --only entry ending in / names an area: chat/, settings/.
	const picked = (page: string) => !only || [...only].some(o => o.endsWith('/') ? page.startsWith(o) : o === page);
	return [...clicks.values()].filter(c => picked(c.page) && (!keys || keys.test(c.key)));
}

// --- Clicks: prototype ---------------------------------------------------------------------------

interface Rect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

interface ProtoTrigger {
	readonly tag: string;
	readonly href?: string;
	readonly menu?: string;
	readonly classes: string[];
	readonly title: string;
	readonly text: string;
}

interface ProtoClick {
	readonly found: boolean;
	/** page, popover, tab, toggle or none. */
	readonly kind?: string;
	readonly outcome: string[];
	/** What the tool did first so the control shows: a tab or menu it opened. */
	readonly prep: string[];
	/** The labels of the buttons that open the menus the control sits in, outermost first. */
	readonly openers: string[];
	/** The prototype regions (data-label) around the control, nearest first. */
	readonly regions: string[];
	/** Which of the page's controls with the same label it is, and how many there are. */
	readonly nth: number;
	readonly count: number;
	readonly box?: Rect;
	readonly before?: string;
	readonly after?: string;
	readonly error?: string;
}

/**
 * The element a click key names, read from the page's HTML with the pattern design-sync.ts reads
 * clicks with (readClicks), so the two stay in step.
 */
function protoTrigger(click: Click): ProtoTrigger | undefined {
	const html = readFileSync(join(DESIGN, click.page), 'utf8');
	const pattern = /<(?<tag>a|button|span|div|li)\b(?<attrs>[^>]*?(?:href="(?<href>[^"]+)"|data-popover-target="(?<menu>[^"]+)")[^>]*)>(?<body>[\s\S]{0,200}?)<\/\k<tag>>/g;
	for (const match of html.matchAll(pattern)) {
		const { tag, attrs, href, menu, body } = match.groups!;
		const classes = (/class="(?<value>[^"]*)"/.exec(attrs)?.groups?.value ?? '').split(' ').filter(c => c.startsWith('k-'));
		const title = /title="(?<value>[^"]*)"/.exec(attrs)?.groups?.value ?? '';
		const icon = /codicon-(?<name>[a-z0-9-]+)/.exec(body)?.groups?.name ?? '';
		const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
		let target = href ?? '#' + menu;
		if (href && !href.startsWith('#') && !href.startsWith('http')) {
			target = posix.normalize(posix.join(posix.dirname(click.page), href));
		}
		if (`${classes.join('.')} | ${title || text} | ${icon} -> ${target}` === click.key) {
			return { tag, href: href && decodeEntities(href), menu, classes, title: decodeEntities(title), text: decodeEntities(text) };
		}
	}
	return undefined;
}

/**
 * Runs in the prototype: marks the trigger with data-click-parity and opens the tab or menu it sits
 * in. Returns the regions around it and which of the same-labelled controls it is.
 */
const PROTO_LOCATE = `({ tag, href, menu, classes, title, text }) => {
	const norm = s => (s || '').toLowerCase().replace(/\\s+/g, '');
	const titleOf = e => (e.getAttribute('title') || '').split('\\n')[0];
	const all = [...document.getElementsByTagName(tag)].filter(e => (href ? e.getAttribute('href') === href : e.getAttribute('data-popover-target') === menu) && classes.every(c => e.classList.contains(c)));
	const labelled = e => title ? titleOf(e) === title : norm(e.textContent).startsWith(norm(text));
	const match = all.find(labelled) || all[0];
	if (!match) {
		return null;
	}
	const same = [...document.getElementsByTagName(tag)].filter(e => classes.every(c => e.classList.contains(c)) && (title ? titleOf(e) === title : norm(e.textContent) === norm(match.textContent)));
	const prep = [];
	const openers = [];
	const ancestors = [];
	for (let e = match.parentElement; e; e = e.parentElement) {
		ancestors.unshift(e);
	}
	for (const e of ancestors) {
		if (e.hasAttribute('data-tab-panel') && e.hidden) {
			const tab = e.closest('[data-tabs]')?.querySelector('[data-tab="' + e.getAttribute('data-tab-panel') + '"]');
			if (tab) {
				tab.click();
				prep.push('clicked the "' + tab.textContent.trim() + '" tab');
			}
		}
		if (e.hasAttribute('data-popover') && !e.classList.contains('is-open')) {
			const opener = e.id ? document.querySelector('[data-popover-target="' + e.id + '"]') : null;
			if (opener) {
				opener.click();
				prep.push('opened #' + e.id + ' with its button');
				openers.push(titleOf(opener) || (opener.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40));
			} else {
				e.classList.add('is-open');
				prep.push('showed #' + e.id);
			}
		}
		if (e.hidden) {
			e.hidden = false;
			prep.push('unhid ' + (e.getAttribute('data-label') || e.id || e.className));
		}
	}
	const regions = [];
	for (let e = match; e; e = e.parentElement) {
		const label = e.getAttribute('data-label');
		if (label) {
			regions.push(label);
		}
	}
	document.querySelectorAll('[data-click-parity]').forEach(e => e.removeAttribute('data-click-parity'));
	match.setAttribute('data-click-parity', '');
	const r = match.getBoundingClientRect();
	return { regions, prep, openers, nth: Math.max(0, same.indexOf(match)), count: same.length, box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } };
}`;

/** Runs in the prototype: the page, its open menus, active tabs and toggled controls. */
const PROTO_SNAPSHOT = `() => {
	const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
	const text = e => (e.textContent || '').replace(/\\s+/g, ' ').trim();
	const items = root => [...new Set([...root.querySelectorAll('[role^="menuitem"], [role="option"], .k-menu-item, [role="tab"], a, button')].filter(visible).map(e => text(e).slice(0, 60)).filter(Boolean))].slice(0, 20);
	return {
		url: location.href.split('#')[0],
		title: document.title,
		popovers: [...document.querySelectorAll('[data-popover].is-open')].filter(visible).map(e => '#' + e.id + ' "' + (e.getAttribute('data-label') || e.getAttribute('aria-label') || '') + '": ' + items(e).join(' | ')),
		tabs: [...document.querySelectorAll('[data-tab].is-active')].map(e => text(e) || e.getAttribute('data-tab')),
		toggles: [...document.querySelectorAll('[data-toggle-class]')].map(e => (e.getAttribute('data-label') || text(e).slice(0, 40)) + (e.classList.contains(e.getAttribute('data-toggle-class')) ? ' on' : ' off')),
	};
}`;

interface ProtoSnapshot {
	readonly url: string;
	readonly title: string;
	readonly popovers: string[];
	readonly tabs: string[];
	readonly toggles: string[];
}

/** The page a prototype URL shows, as a path under design/. */
function designPath(url: string): string {
	return relative(DESIGN, fileURLToPath(url)).replace(/\\/g, '/');
}

function protoChanges(before: ProtoSnapshot, after: ProtoSnapshot): { kind: string; outcome: string[] } {
	if (after.url !== before.url) {
		return { kind: 'page', outcome: [`page: ${designPath(after.url)} "${after.title}"`, ...after.popovers.map(p => `shows open: ${p}`)] };
	}
	const outcome = [
		...after.popovers.filter(p => !before.popovers.includes(p)).map(p => `opened popover ${p}`),
		...before.popovers.filter(p => !after.popovers.includes(p)).map(p => `closed popover ${p}`),
	];
	if (outcome.length) {
		return { kind: 'popover', outcome };
	}
	const tabs = after.tabs.filter(t => !before.tabs.includes(t));
	if (tabs.length) {
		return { kind: 'tab', outcome: tabs.map(t => `tab: ${t}`) };
	}
	const toggles = after.toggles.filter(t => !before.toggles.includes(t));
	if (toggles.length) {
		return { kind: 'toggle', outcome: toggles.map(t => `toggled: ${t}`) };
	}
	return { kind: 'none', outcome: ['nothing changed'] };
}

async function clickPrototype(browser: Browser, theme: Theme, clicks: readonly Click[]): Promise<Map<string, ProtoClick>> {
	const results = new Map<string, ProtoClick>();
	const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
	await context.addInitScript({ content: `try { localStorage.setItem('klawly-proto-theme', ${JSON.stringify(theme)}); localStorage.setItem('klawly-proto-app', '0'); localStorage.setItem('klawly-proto-origins', '0'); } catch { }` });
	const page = await context.newPage();
	const snapshot = async () => page.evaluate(`(${PROTO_SNAPSHOT})()`) as Promise<ProtoSnapshot>;
	for (const click of clicks) {
		const shot = (suffix: string) => `proto/${theme}-${click.name}${suffix}.png`;
		try {
			const trigger = protoTrigger(click);
			await page.goto(pathToFileURL(join(DESIGN, click.page)).href);
			await page.addStyleTag({ content: '.proto-fab, .proto-drawer { display: none !important; }' });
			await page.waitForTimeout(400);
			const located = trigger && await page.evaluate(`(${PROTO_LOCATE})(${JSON.stringify(trigger)})`) as { regions: string[]; prep: string[]; openers: string[]; nth: number; count: number; box: Rect } | null;
			if (!located) {
				results.set(click.key, { found: false, outcome: [], prep: [], openers: [], regions: [], nth: 0, count: 0, error: `no element on ${click.page} has this key` });
				continue;
			}
			await page.waitForTimeout(300);
			const before = await snapshot();
			await page.screenshot({ path: join(CLICKS_OUT, shot('-before')) });
			const control = page.locator('[data-click-parity]').first();
			await control.click({ timeout: 3000 }).catch(() => control.click({ force: true, timeout: 3000 }));
			await page.waitForTimeout(500);
			await page.waitForLoadState('load');
			if (page.url().split('#')[0] !== before.url) {
				await page.addStyleTag({ content: '.proto-fab, .proto-drawer { display: none !important; }' });
				await page.waitForTimeout(300);
			}
			const { kind, outcome } = protoChanges(before, await snapshot());
			await page.screenshot({ path: join(CLICKS_OUT, shot('')) });
			results.set(click.key, { found: true, kind, outcome, prep: located.prep, openers: located.openers, regions: located.regions, nth: located.nth, count: located.count, box: located.box, before: shot('-before'), after: shot('') });
		} catch (error) {
			results.set(click.key, { found: false, outcome: [], prep: [], openers: [], regions: [], nth: 0, count: 0, error: firstLine(error) });
		}
	}
	await context.close();
	return results;
}

function firstLine(error: unknown): string {
	return String(error instanceof Error ? error.message : error).split('\n')[0];
}

// --- Clicks: app ---------------------------------------------------------------------------------

/** Prototype regions with no entry in REGIONS → where their controls live in the app. */
const CLICK_SCOPES: Record<string, string> = {
	'View switcher': '.part.activitybar, .part.sidebar .composite-bar-container, .part.sidebar .title-actions',
	'Panel': '.part.panel',
	'Menu': '.context-view, .monaco-menu-container',
};

interface AppFound {
	readonly method: string;
	readonly control: string;
	/** How many controls scored as well as the one clicked. */
	readonly matches: number;
	readonly box: Rect;
}

/**
 * Runs in the app: finds the control for a label (by aria-label, title or text, in the region the
 * prototype draws it in when that region is known) and marks it with data-click-parity.
 */
const APP_FIND = `({ label, icon, scope, nth, count, selector }) => {
	document.querySelectorAll('[data-click-parity]').forEach(e => e.removeAttribute('data-click-parity'));
	const visible = e => {
		const r = e.getBoundingClientRect();
		if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) {
			return false;
		}
		const s = getComputedStyle(e);
		return s.visibility !== 'hidden' && s.display !== 'none';
	};
	const norm = s => (s || '').toLowerCase().replace(/\\u2026/g, '...').replace(/[\\s+]/g, '');
	const base = s => norm((s || '').replace(/\\s*\\([^)]*\\)\\s*$/, ''));
	const clickable = 'a, button, input, select, textarea, [role], [tabindex], .action-label, .monaco-list-row, .statusbar-item, li';
	const mark = (e, method, matches) => {
		e.setAttribute('data-click-parity', '');
		const r = e.getBoundingClientRect();
		const aria = e.getAttribute('aria-label');
		const classes = [...e.classList].slice(0, 2).map(c => '.' + c).join('');
		const text = (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 50);
		return { method, matches, control: e.tagName.toLowerCase() + classes + (aria ? ' aria-label="' + aria + '"' : '') + (text ? ' "' + text + '"' : ''), box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } };
	};
	if (selector) {
		const e = [...document.querySelectorAll(selector)].find(visible);
		return e ? mark(e, 'hand mapping', 1) : null;
	}
	const scopes = scope ? [...document.querySelectorAll(scope)].filter(visible) : [];
	const want = norm(label);
	const wantBase = base(label);
	// design-sync cuts a control's text at 40 characters.
	const truncated = label.length >= 40;
	const found = new Map();
	for (const e of document.body.querySelectorAll('*')) {
		const aria = e.getAttribute('aria-label');
		const title = e.getAttribute('title');
		let score = 0;
		let method = '';
		if (aria && norm(aria) === want) {
			score = 100; method = 'aria-label';
		} else if (title && norm(title) === want) {
			score = 95; method = 'title';
		} else if (wantBase && aria && base(aria) === wantBase) {
			score = 85; method = 'aria-label without its key';
		} else if (wantBase && title && base(title) === wantBase) {
			score = 80; method = 'title without its key';
		} else {
			const text = norm(e.textContent);
			if (text === want) {
				score = 90; method = 'text';
			} else if (wantBase && wantBase !== want && text === wantBase) {
				score = 75; method = 'text without its key';
			} else if (truncated && text.startsWith(want)) {
				score = 70; method = 'text prefix';
			} else if (want.length >= 6 && ((aria && norm(aria).startsWith(want)) || (title && norm(title).startsWith(want)))) {
				// "Source Control (Ctrl+Shift+G) - 3 pending changes"
				score = 60; method = 'aria-label or title prefix';
			}
		}
		if (!score || !visible(e)) {
			continue;
		}
		const target = e.closest(clickable) || e;
		if (scopes.some(s => s.contains(target))) {
			score += 20;
		}
		if (icon && (target.classList.contains('codicon-' + icon) || target.querySelector('.codicon-' + icon))) {
			score += 5;
		}
		const known = found.get(target);
		if (!known || known.score < score) {
			found.set(target, { score, method });
		}
	}
	let candidates = [...found.entries()];
	if (!candidates.length && icon && scopes.length) {
		for (const e of document.querySelectorAll('.codicon-' + icon)) {
			const target = e.closest(clickable) || e;
			if (visible(target) && scopes.some(s => s.contains(target)) && !found.has(target)) {
				found.set(target, { score: 1, method: 'icon in its region' });
			}
		}
		candidates = [...found.entries()];
	}
	if (!candidates.length) {
		return null;
	}
	const top = Math.max(...candidates.map(([, c]) => c.score));
	// The innermost of the best: a row and the button inside it can both carry the label.
	const best = candidates.filter(([, c]) => c.score === top).map(([e]) => e);
	const inner = best.filter(e => !best.some(o => o !== e && e.contains(o)));
	inner.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
	const pick = count > 1 && inner.length === count ? inner[nth] : inner[0];
	return mark(pick, found.get(pick).method, inner.length);
}`;

/** Runs in the app: what is open and visible, to tell what a click changed. */
const APP_SNAPSHOT = `() => {
	const visible = e => {
		if (!e) {
			return false;
		}
		const r = e.getBoundingClientRect();
		if (r.width < 1 || r.height < 1) {
			return false;
		}
		const s = getComputedStyle(e);
		return s.visibility !== 'hidden' && s.display !== 'none';
	};
	const text = e => (e ? e.textContent || '' : '').replace(/\\s+/g, ' ').trim();
	const shown = selector => [...document.querySelectorAll(selector)].filter(visible);
	const labels = (root, selector, max) => [...new Set([...root.querySelectorAll(selector)].filter(visible).map(e => (e.getAttribute('aria-label') || text(e)).slice(0, 80)).filter(Boolean))].slice(0, max);
	const overlays = [];
	const seen = [];
	const add = (e, what, detail) => {
		if (!seen.some(s => s.contains(e))) {
			seen.push(e);
			overlays.push(what + ': ' + detail);
		}
	};
	shown('.monaco-menu').forEach(e => add(e, 'menu', labels(e, '.action-menu-item .action-label', 30).join(' | ')));
	shown('.action-widget').forEach(e => add(e, 'action widget', labels(e, '.monaco-list-row', 30).join(' | ')));
	shown('.quick-input-widget').forEach(e => {
		const input = e.querySelector('input');
		add(e, 'quick input', (input ? '"' + (input.getAttribute('placeholder') || '') + '" [' + input.value + '] ' : '') + labels(e, '.monaco-list-row', 12).join(' | '));
	});
	shown('.monaco-dialog-box').forEach(e => add(e, 'dialog', text(e).slice(0, 200)));
	shown('.notifications-center').forEach(e => add(e, 'notification center', labels(e, '.notification-list-item-message', 8).join(' | ')));
	shown('.notification-toast').forEach(e => add(e, 'notification', text(e.querySelector('.notification-list-item-message')).slice(0, 160)));
	shown('.workbench-hover, .monaco-hover:not(.hidden)').forEach(e => add(e, 'hover', text(e).slice(0, 160)));
	shown('.suggest-widget').forEach(e => add(e, 'suggestions', labels(e, '.monaco-list-row', 12).join(' | ')));
	shown('[role="menu"], [role="dialog"], [role="tooltip"], [class*="claude-"][class*="menu"], [class*="claude-"][class*="popover"], [class*="claude-"][class*="picker"]').forEach(e => {
		const items = labels(e, '[role^="menuitem"], [role="option"], button', 20).join(' | ');
		add(e, (e.getAttribute('role') || 'overlay') + ' .' + [...e.classList].slice(0, 2).join('.'), items || text(e).slice(0, 120));
	});
	const group = document.querySelector('.part.editor .editor-group-container.active');
	const tab = group && group.querySelector('.tab.active');
	const pane = group ? [...group.querySelectorAll('.editor-instance')].find(visible) : undefined;
	const kind = pane && pane.firstElementChild ? [...pane.firstElementChild.classList].slice(0, 2).join('.') : '';
	const heading = pane ? text([...pane.querySelectorAll('h1, h2, h3')].find(visible)).slice(0, 60) : '';
	const part = (selector, title) => {
		const p = document.querySelector(selector);
		if (!visible(p)) {
			return 'hidden';
		}
		const t = [...p.querySelectorAll(title)].find(visible);
		return ((t && (t.getAttribute('aria-label') || text(t))) || 'shown').slice(0, 60) + ' (' + Math.round(p.getBoundingClientRect().width) + 'px)';
	};
	const agentTabs = shown('.claude-pane .claude-tab');
	const activeTab = agentTabs.find(t => t.getAttribute('aria-selected') === 'true' || /(^|\\s)(is-)?active(\\s|$)/.test(t.className));
	const composer = shown('textarea.claude-composer-input')[0];
	const focus = document.activeElement;
	return {
		overlays,
		facets: {
			'editor': tab ? (tab.getAttribute('aria-label') || text(tab)) + (kind ? ' (' + kind + ')' : '') : (kind || 'none'),
			'editor tabs': [...document.querySelectorAll('.part.editor .tab')].map(t => t.getAttribute('aria-label') || text(t)).join(', '),
			'editor groups': String(document.querySelectorAll('.part.editor .editor-group-container').length),
			'editor heading': heading,
			'side bar': part('.part.sidebar', '.composite.title .title-label'),
			'panel': part('.part.panel', '.composite-bar .action-item.checked .action-label'),
			'agent pane': part('.part.auxiliarybar', '.composite.title .title-label'),
			'agent tabs': agentTabs.map(text).join(', '),
			'active agent tab': activeTab ? text(activeTab) : '',
			'agent views': ['claude-empty', 'claude-timeline-host', 'claude-agents', 'claude-permission', 'claude-changes-bar', 'claude-queue', 'claude-review-bar', 'claude-inline-zone', 'claude-settings'].filter(c => shown('.' + c).length).join(', '),
			'composer': composer ? composer.value : '',
			'pills': shown('.claude-pane button.claude-pill').map(text).join(', '),
		},
		quiet: {
			'window title': document.title,
			'focus': focus && focus !== document.body ? (focus.getAttribute('aria-label') || focus.getAttribute('placeholder') || [...focus.classList].slice(0, 2).join('.') || focus.tagName.toLowerCase()) : '',
		},
	};
}`;

interface AppSnapshot {
	readonly overlays: string[];
	readonly facets: Record<string, string>;
	readonly quiet: Record<string, string>;
}

function appChanges(before: AppSnapshot, after: AppSnapshot): string[] {
	const facets = (b: Record<string, string>, a: Record<string, string>) => Object.keys(a).filter(name => b[name] !== a[name]).map(name => `${name}: ${b[name] || 'none'} → ${a[name] || 'none'}`);
	const lines = [
		...after.overlays.filter(o => !before.overlays.includes(o)).map(o => `opened ${o}`),
		...before.overlays.filter(o => !after.overlays.includes(o)).map(o => `closed ${o}`),
		...facets(before.facets, after.facets),
	];
	// The window title and focus follow most changes; they only tell something when nothing else changed.
	return lines.length ? lines : facets(before.quiet, after.quiet);
}

/** Runs in the app: the layout a click must not leave changed for the next one. */
const APP_LAYOUT = `() => {
	const width = selector => {
		const e = document.querySelector(selector);
		const r = e ? e.getBoundingClientRect() : undefined;
		return r && r.width > 0 && r.height > 0 ? Math.round(r.width) : 0;
	};
	return { workbench: !!document.querySelector('.monaco-workbench'), title: document.title, sidebar: width('.part.sidebar'), panel: width('.part.panel'), aux: width('.part.auxiliarybar'), groups: document.querySelectorAll('.part.editor .editor-group-container').length, agentTabs: document.querySelectorAll('.claude-pane .claude-tab').length };
}`;

interface Layout {
	readonly workbench: boolean;
	readonly title: string;
	readonly sidebar: number;
	readonly panel: number;
	readonly aux: number;
	readonly groups: number;
	readonly agentTabs: number;
}

interface AppSession {
	readonly app: ElectronApplication;
	readonly page: Page;
	readonly d: Driver;
	readonly folder: boolean;
	readonly baseline: Layout;
	/** The page whose state the app still shows after the last click, and what it showed. */
	driven?: { readonly page: string; readonly snapshot: AppSnapshot };
}

async function layout(page: Page): Promise<Layout> {
	return page.evaluate(`(${APP_LAYOUT})()`) as Promise<Layout>;
}

/**
 * Answers the main process's native dialogs (and keeps links from opening a browser) and records
 * them: an open-folder dialog is cancelled, a message box gets "Don't Save" or its cancel button.
 */
async function stubHost(app: ElectronApplication): Promise<void> {
	await app.evaluate(({ dialog, shell }) => {
		interface Options { title?: string; message?: string; buttons?: string[]; cancelId?: number }
		const calls: string[] = [];
		Object.assign(globalThis, { clickParityCalls: calls });
		const options = (args: unknown[]) => (args.find(a => typeof a === 'object' && a !== null && !(a as { webContents?: object }).webContents) ?? {}) as Options;
		const answer = (o: Options) => {
			const buttons = o.buttons ?? [];
			const dontSave = buttons.findIndex(b => /don.?t save/i.test(b.replace('&', '')));
			return dontSave >= 0 ? dontSave : o.cancelId ?? Math.max(0, buttons.length - 1);
		};
		const messageBox = (args: unknown[]) => {
			const o = options(args);
			calls.push(`native message box: ${o.message ?? o.title ?? ''} [${(o.buttons ?? []).join(', ')}]`);
			return answer(o);
		};
		const openDialog = (kind: string, args: unknown[]) => calls.push(`native ${kind} dialog: ${options(args).title ?? ''}`);
		Object.assign(dialog, {
			showMessageBox: async (...args: unknown[]) => ({ response: messageBox(args), checkboxChecked: false }),
			showMessageBoxSync: (...args: unknown[]) => messageBox(args),
			showOpenDialog: async (...args: unknown[]) => { openDialog('open', args); return { canceled: true, filePaths: [] }; },
			showOpenDialogSync: (...args: unknown[]) => { openDialog('open', args); return undefined; },
			showSaveDialog: async (...args: unknown[]) => { openDialog('save', args); return { canceled: true, filePath: '' }; },
			showSaveDialogSync: (...args: unknown[]) => { openDialog('save', args); return undefined; },
		});
		Object.assign(shell, { openExternal: async (url: string) => { calls.push(`open external: ${url}`); } });
	});
}

/** The native dialogs and external links since the last call. */
async function hostCalls(app: ElectronApplication): Promise<string[]> {
	return app.evaluate(() => ((globalThis as { clickParityCalls?: string[] }).clickParityCalls ?? []).splice(0));
}

async function openSession(exe: string, theme: Theme, folder: boolean): Promise<AppSession> {
	const { app, page } = await launchApp(exe, theme, folder);
	await stubHost(app);
	const d = driver(page);
	await d.command('Notifications: Clear All Notifications', 500);
	if (folder) {
		await d.openFile('cartService.ts');
	}
	return { app, page, d, folder, baseline: await layout(page) };
}

/**
 * Why the app cannot start the next click (a window closed, the folder closed, a part resized), or
 * undefined. `samePage`: the click before ran on the same page, whose drive may have resized the agent pane.
 */
async function unhealthy(s: AppSession, samePage: boolean): Promise<string | undefined> {
	if (s.page.isClosed()) {
		return 'the window closed';
	}
	const now = await layout(s.page).catch(() => undefined);
	const resized = (a: number, b: number) => a > 0 && b > 0 && Math.abs(a - b) > 4;
	if (!now?.workbench) {
		return 'no workbench';
	}
	if (s.folder && !now.title.includes('klawly-demo')) {
		return `the folder is no longer open (${now.title})`;
	}
	if (resized(now.sidebar, s.baseline.sidebar) || (!samePage && resized(now.aux, s.baseline.aux))) {
		return 'a side bar was resized';
	}
	return now.agentTabs > s.baseline.agentTabs + 5 ? 'too many agent tabs' : undefined;
}

/** Shows and hides the side bar (on the Explorer), panel and agent pane as they were at launch, in one editor group. */
async function restoreLayout(s: AppSession): Promise<void> {
	const { d } = s;
	await d.command('View: Close All Editor Groups', 800);
	if (s.folder) {
		// Back to the Explorer, which also shows the side bar when a click hid it.
		await d.page.keyboard.press('ControlOrMeta+Shift+E');
		await d.wait(300);
	}
	const now = await layout(s.page);
	if (!now.panel !== !s.baseline.panel) {
		await d.page.keyboard.press('ControlOrMeta+J');
	}
	if (!now.sidebar !== !s.baseline.sidebar) {
		await d.page.keyboard.press('ControlOrMeta+B');
	}
	if (!now.aux !== !s.baseline.aux) {
		await d.page.keyboard.press('ControlOrMeta+Alt+B');
	}
	await d.wait(400);
}

async function closeExtraWindows(s: AppSession): Promise<string[]> {
	const titles: string[] = [];
	for (const window of s.app.windows()) {
		if (window !== s.page) {
			await window.waitForLoadState().catch(() => { });
			titles.push(await window.title().catch(() => '(no title)'));
			await window.close().catch(() => { });
		}
	}
	return titles;
}

interface AppClick {
	/** False when the click was not tried: its page cannot be reached, or CLICKS skips it. */
	readonly run: boolean;
	readonly found: boolean;
	readonly method?: string;
	readonly control?: string;
	readonly matches?: number;
	readonly outcome: string[];
	readonly reason?: string;
	readonly error?: string;
	readonly box?: Rect;
	readonly before?: string;
	readonly after?: string;
}

/** True when the app shows what it showed right after the state's drive (the quiet facets aside). */
function sameState(a: AppSnapshot, b: AppSnapshot): boolean {
	return JSON.stringify([a.overlays, a.facets]) === JSON.stringify([b.overlays, b.facets]);
}

async function clickInApp(s: AppSession, theme: Theme, click: Click, state: ClickState, mapping: ClickMapping | undefined, proto: ProtoClick | undefined): Promise<AppClick> {
	const { app, page, d } = s;
	const shot = (suffix: string) => `app/${theme}-${click.name}${suffix}.png`;
	// The mouse rests where the last click left it; park it on the agent pane's right edge so its hover goes.
	const park = async () => {
		await page.mouse.move(WIDTH - 2, HEIGHT / 2);
		await page.waitForTimeout(300);
	};
	await park();
	// The previous click on this page left the app as the drive did: start from there and skip the drive.
	const reuse = s.driven?.page === click.page && !state.perClick && !mapping?.drive && sameState(s.driven.snapshot, await page.evaluate(`(${APP_SNAPSHOT})()`) as AppSnapshot);
	s.driven = undefined;
	if (!reuse) {
		// Back to the workbench with cartService.ts open, the files as the prototype draws them.
		await d.escape(3);
		await closeExtraWindows(s);
		writeDrawnEdits();
		await restoreLayout(s);
		if (s.folder) {
			await d.openFile('cartService.ts');
		}
		await state.drive(d, click, proto);
		await mapping?.drive?.(d);
	}
	// A drive that clicked leaves a hover too.
	await park();
	const scope = (proto?.regions ?? []).map(label => REGIONS[label] ?? CLICK_SCOPES[label]).find(Boolean);
	const find = async (label: string, icon: string, nth: number, count: number, selector?: string) => page.evaluate(`(${APP_FIND})(${JSON.stringify({ label, icon, scope, nth, count, selector })})`) as Promise<AppFound | null>;
	let found = await find(click.label, click.icon, proto?.nth ?? 0, proto?.count ?? 1, mapping?.selector);
	// The prototype opened a menu to show the control: open the app's menu by its button's label and look again.
	const opened: string[] = [];
	for (const opener of found ? [] : proto?.openers ?? []) {
		if (await find(opener, '', 0, 1)) {
			await page.locator('[data-click-parity]').first().click({ timeout: 4000 });
			await page.waitForTimeout(700);
			opened.push(`opened "${opener}" first`);
		}
	}
	if (opened.length) {
		found = await find(click.label, click.icon, proto?.nth ?? 0, proto?.count ?? 1, mapping?.selector);
	}
	if (!found) {
		s.driven = { page: click.page, snapshot: await page.evaluate(`(${APP_SNAPSHOT})()`) as AppSnapshot };
		await page.screenshot({ path: join(CLICKS_OUT, shot('-before')) });
		const where = scope ? ` (looked first in \`${scope}\`)` : '';
		return { run: true, found: false, outcome: opened, reason: mapping?.selector ? `nothing visible matches \`${mapping.selector}\`` : `no visible control has the aria-label, title or text "${click.label}"${where}`, before: shot('-before') };
	}
	await hostCalls(app);
	const before = await page.evaluate(`(${APP_SNAPSHOT})()`) as AppSnapshot;
	await page.screenshot({ path: join(CLICKS_OUT, shot('-before')) });
	const driven = { page: click.page, snapshot: before };
	const control = page.locator('[data-click-parity]').first();
	await control.click({ timeout: 4000 }).catch(() => control.click({ force: true, timeout: 4000 }));
	await page.waitForTimeout(1500);
	if (app.windows().length > 1) {
		await page.waitForTimeout(3000);
	}
	const outcome = [...(await closeExtraWindows(s)).map(title => `opened a window: ${title}`), ...await hostCalls(app)];
	if (page.isClosed()) {
		return { run: true, found: true, ...found, outcome: [...outcome, 'the window closed'], before: shot('-before') };
	}
	const after = await page.evaluate(`(${APP_SNAPSHOT})()`) as AppSnapshot;
	outcome.unshift(...appChanges(before, after));
	if (sameState(before, after)) {
		s.driven = driven;
	}
	await page.screenshot({ path: join(CLICKS_OUT, shot('')) });
	return { run: true, found: true, ...found, outcome: outcome.length ? outcome : ['nothing visible changed'], before: shot('-before'), after: shot('') };
}

/**
 * When Electron exits before it is up (low memory), Playwright rejects the launch and also leaves a
 * second copy of the same error unhandled, which would end the whole run. The launch's own
 * rejection is handled where it is awaited, so only that copy is ignored.
 */
function ignoreFailedLaunch(error: unknown): void {
	if (error instanceof Error && error.message === 'Process failed to launch!') {
		console.log('design-parity: the app failed to launch');
		return;
	}
	throw error;
}

/** Opens a session, and once more after a pause when the first launch fails. */
async function openSessionWithRetry(exe: string, theme: Theme, folder: boolean): Promise<AppSession> {
	try {
		return await openSession(exe, theme, folder);
	} catch (error) {
		console.log(`design-parity: launching again: ${firstLine(error)}`);
		await new Promise(resolve => setTimeout(resolve, 15000));
		return openSession(exe, theme, folder);
	}
}

async function clickApp(exe: string, theme: Theme, clicks: readonly Click[], protos: ReadonlyMap<string, ProtoClick>, onResult: (key: string, result: AppClick) => void): Promise<void> {
	process.on('unhandledRejection', ignoreFailedLaunch);
	let session: AppSession | undefined;
	let lastPage: string | undefined;
	const close = async () => {
		await session?.app.close().catch(() => { });
		session = undefined;
	};
	try {
		for (const click of clicks) {
			const state = clickState(click.page);
			const mapping = CLICKS[click.key];
			let result: AppClick;
			if (typeof state === 'string' || mapping?.skip) {
				result = { run: false, found: false, outcome: [], reason: mapping?.skip ?? String(state) };
			} else {
				const folder = !state.noFolder;
				try {
					const reason = session && (session.folder !== folder ? 'the folder changes' : await unhealthy(session, lastPage === click.page));
					if (!session || reason) {
						if (reason) {
							console.log(`design-parity: relaunching the app: ${reason}`);
						}
						await close();
						session = await openSessionWithRetry(exe, theme, folder);
					}
					result = await clickInApp(session, theme, click, state, mapping, protos.get(click.key));
				} catch (error) {
					result = { run: true, found: false, outcome: [], error: firstLine(error) };
					await close();
				}
			}
			lastPage = click.page;
			onResult(click.key, result);
			console.log(`design-parity: click ${theme} ${click.page} ${click.label}: ${result.found ? result.outcome.join('; ') : result.error ?? result.reason}`);
		}
	} finally {
		await close();
		process.off('unhandledRejection', ignoreFailedLaunch);
	}
}

// --- Clicks: report ------------------------------------------------------------------------------

interface ClickResult {
	readonly theme: Theme;
	readonly page: string;
	readonly key: string;
	readonly mark: string;
	readonly label: string;
	readonly proto: ProtoClick;
	readonly app?: AppClick;
	readonly pair?: string;
}

/** Before above, after below; prototype left, app right; the clicked control outlined in the before row. */
async function composeClickPair(browser: Browser, result: ClickResult, name: string): Promise<string> {
	const scale = 0.5;
	const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
	const cell = (caption: string, image: string | undefined, box: Rect | undefined, notes: string[]) => {
		const file = image && join(CLICKS_OUT, image);
		const src = file && existsSync(file) ? `<img src="${pathToFileURL(file).href}">` : '<div class="none">No shot</div>';
		const outline = box ? `<div class="box" style="left:${box.x * scale}px;top:${box.y * scale}px;width:${box.width * scale}px;height:${box.height * scale}px"></div>` : '';
		return `<figure><figcaption>${escape(caption)}</figcaption><div class="shot">${src}${outline}</div>${notes.map(n => `<p>${escape(n)}</p>`).join('')}</figure>`;
	};
	const app = result.app;
	const appNotes = !app ? ['not run'] : app.found ? [`found by ${app.method}${app.matches && app.matches > 1 ? ` (${app.matches} matches)` : ''}: ${app.control}`] : [app.error ?? app.reason ?? 'not found'];
	const html = `<!doctype html><meta charset="utf-8"><style>
body { margin: 0; background: #111; color: #ddd; font: 13px system-ui; padding: 12px; width: ${Math.ceil(WIDTH * scale * 2 + 16)}px; }
h1 { font-size: 14px; margin: 0 0 8px; }
.row { display: flex; gap: 16px; margin-bottom: 10px; }
figure { margin: 0; width: ${WIDTH * scale}px; }
figcaption { font-weight: 600; padding: 0 0 4px; }
figure p { margin: 4px 0 0; }
.shot { position: relative; width: ${WIDTH * scale}px; height: ${HEIGHT * scale}px; outline: 1px solid #444; }
.shot img { width: 100%; display: block; }
.none { height: 100%; display: grid; place-items: center; }
.box { position: absolute; box-sizing: border-box; border: 2px solid #f14c4c; }
</style><h1>${escape(`${result.page}  ·  ${result.key}  ·  marked "${result.mark}"`)}</h1>
<div class="row">${cell('Prototype, before', result.proto.before, result.proto.box, result.proto.prep.map(p => `first ${p}`))}${cell('App, before', app?.before, app?.box, appNotes)}</div>
<div class="row">${cell('Prototype, after', result.proto.after, undefined, result.proto.found ? result.proto.outcome : [result.proto.error ?? 'not found'])}${cell('App, after', app?.after, undefined, app?.outcome ?? [])}</div>`;
	const page = await browser.newPage({ viewport: { width: Math.ceil(WIDTH * scale * 2 + 40), height: 600 } });
	const file = join(CLICKS_OUT, 'pairs', `${name}.html`);
	writeFileSync(file, html);
	await page.goto(pathToFileURL(file).href);
	await page.waitForFunction('[...document.images].every(i => i.complete)');
	const pair = `pairs/${name}.png`;
	await page.screenshot({ path: join(CLICKS_OUT, pair), fullPage: true });
	await page.close();
	rmSync(file);
	return pair;
}

/** Writes this run's results over the same theme and key in clicks.json, keeping the other entries. */
function writeClicksJson(results: readonly ClickResult[]): void {
	const file = join(CLICKS_OUT, 'clicks.json');
	const fresh = new Set(results.map(r => `${r.theme} ${r.key}`));
	const kept = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ClickResult[]).filter(r => !fresh.has(`${r.theme} ${r.key}`)) : [];
	const all = [...kept, ...results].sort((a, b) => a.theme.localeCompare(b.theme) || a.page.localeCompare(b.page) || a.key.localeCompare(b.key));
	writeFileSync(file, JSON.stringify(all, undefined, '\t') + '\n');
}

async function runClicks(exe: string, args: ReturnType<typeof parseArgs>): Promise<number> {
	const clicks = readClickList(args.only, args.keys);
	// Workspace states first and the one that widens the agent pane last among them; then the no-folder ones.
	const order = (c: Click) => {
		const state = clickState(c.page);
		return typeof state !== 'string' && state.noFolder ? 2 : c.page === 'chat/agents-list.html' ? 1 : 0;
	};
	clicks.sort((a, b) => order(a) - order(b));
	for (const dir of ['proto', 'app', 'pairs']) {
		mkdirSync(join(CLICKS_OUT, dir), { recursive: true });
	}
	setupFixtures();
	const results: ClickResult[] = [];
	const browser = await chromium.launch({ channel: args.browser });
	try {
		for (const theme of args.themes) {
			const protos = await clickPrototype(browser, theme, clicks);
			const start = results.length;
			for (const click of clicks) {
				results.push({ theme, page: click.page, key: click.key, mark: click.mark, label: click.label, proto: protos.get(click.key)! });
			}
			await clickApp(exe, theme, clicks, protos, (key, app) => {
				const index = results.findIndex((r, i) => i >= start && r.key === key);
				results[index] = { ...results[index], app };
				writeClicksJson(results);
			});
			for (const [i, click] of clicks.entries()) {
				results[start + i] = { ...results[start + i], pair: await composeClickPair(browser, results[start + i], `${theme}-${click.name}`) };
			}
		}
	} finally {
		await browser.close();
	}
	writeClicksJson(results);
	const ran = results.filter(r => r.proto.found && r.app?.found).length;
	const notFound = results.filter(r => r.app?.run && !r.app.found && !r.app.error).length;
	const notRun = results.filter(r => !r.app?.run).length;
	const errored = results.filter(r => r.app?.error || r.proto.error).length;
	console.log(`design-parity: ${results.length} click(s): ${ran} clicked in both, ${notFound} not found in the app, ${notRun} not run in the app, ${errored} errored. See design/.parity/clicks/clicks.json and design/.parity/clicks/pairs/.`);
	return 0;
}

// --- Report --------------------------------------------------------------------------------------

function renderSection(result: StateResult): string[] {
	const lines = [`### ${result.theme}: [${result.page}](${result.page})`, ''];
	if (result.error) {
		lines.push(`- Not reached in the app: ${result.error}`);
	} else {
		const off = result.regions.filter(r => r.deltas.length);
		lines.push(...(off.length ? off.map(r => `- ${r.label}: ${r.deltas.join('; ')}`) : ['None.']));
	}
	return lines;
}

/** The prototype's screens: `<area>/<page>.html` under design/. */
function designPages(): string[] {
	return readdirSync(DESIGN, { withFileTypes: true })
		.filter(entry => entry.isDirectory() && entry.name !== 'assets' && !entry.name.startsWith('.'))
		.flatMap(entry => readdirSync(join(DESIGN, entry.name)).filter(name => name.endsWith('.html')).map(name => `${entry.name}/${name}`))
		.sort();
}

/** Rewrites the Parity section of design/STALE.md; states this run did not cover keep their entries. */
function writeParity(results: readonly StateResult[]): void {
	const old = existsSync(STALE_MD) ? readFileSync(STALE_MD, 'utf8') : '';
	const text = old.replace(/\r\n/g, '\n');
	const start = text.indexOf(`\n${PARITY_HEADING}\n`);
	const head = (start >= 0 ? text.slice(0, start) : text).replace(/\n+$/, '');
	const sections = new Map<string, string[]>();
	if (start >= 0) {
		for (const chunk of text.slice(start).split(/\n(?=### )/).slice(1)) {
			sections.set(chunk.split('\n')[0], chunk.replace(/\n+$/, '').split('\n'));
		}
	}
	for (const result of results) {
		const lines = renderSection(result);
		sections.set(lines[0], lines);
	}
	const order = (key: string) => {
		const index = STATES.findIndex(s => key.includes(`[${s.page}]`));
		return (key.startsWith('### light') ? 1000 : 0) + (index < 0 ? 999 : index);
	};
	const body = [...sections.keys()].sort((a, b) => order(a) - order(b)).flatMap(key => ['', ...sections.get(key)!]);
	const next = [
		head,
		'',
		PARITY_HEADING,
		'',
		`Written by \`npm run design-parity\` (\`build/klawly/design-parity.ts\`). Each design page and the app in the same state, region by region: a line is a region whose x, y, width or height is off by more than ${TOLERANCE}px, or whose background or font size differs (prototype → app). Side-by-side images: \`design/.parity/pairs/\` (not committed). A UI change must not add lines here.`,
		'',
		'Not reached in the app:',
		'',
		...Object.entries(NOT_REACHED).map(([page, why]) => `- [${page}](${page}): ${why}.`),
		'- Git: the branch, the M/U decorations and the "Branch diff vs main" chip need the git extension, which does not activate in the dev build.',
		'',
		`No state yet: ${designPages().filter(page => !NOT_REACHED[page] && !STATES.some(s => s.page === page)).map(page => `\`${page}\``).join(', ')}.`,
		...body,
	].join('\n') + '\n';
	if (old.replace(/\r\n/g, '\n') !== next) {
		writeFileSync(STALE_MD, old.includes('\r\n') ? next.replace(/\n/g, '\r\n') : next);
	}
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	const exe = args.exe ?? devExecutable();
	if (!existsSync(exe)) {
		console.error(`design-parity: ${exe} not found. Run \`npm run electron\` and \`npm run compile\` first, or pass --exe.`);
		return 1;
	}
	if (args.clicks) {
		return runClicks(exe, args);
	}
	const states = STATES.filter(s => !args.only || args.only.has(s.page));
	for (const dir of ['app', 'proto', 'pairs']) {
		mkdirSync(join(OUT, dir), { recursive: true });
	}
	setupFixtures();
	const browser = await chromium.launch({ channel: args.browser });
	const results: StateResult[] = [];
	try {
		for (const theme of args.themes) {
			const proto = await shootPrototype(browser, theme, states);
			const app = await shootApp(exe, theme, states);
			for (const state of states) {
				const shot = app.get(state.page);
				const regions = shot?.error ? [] : state.regions.map((label, i) => compare(label, proto.get(state.page)?.[i] ?? null, shot?.boxes[i] ?? null));
				const result: StateResult = { theme, page: state.page, regions, error: shot?.error };
				results.push(result);
				await composePair(browser, theme, result);
			}
		}
	} finally {
		await browser.close();
	}
	writeParity(results);
	const deltas = results.reduce((n, r) => n + r.regions.filter(region => region.deltas.length).length, 0);
	const unreached = results.filter(r => r.error).length;
	console.log(`design-parity: ${results.length} state(s), ${deltas} region(s) with a delta, ${unreached} state(s) not reached. See design/STALE.md and design/.parity/pairs/.`);
	return 0;
}

// build/klawly/redesign-shots.ts imports the fixtures and the app driver; only a direct run checks parity.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = await main();
	} catch (error) {
		console.error(`design-parity: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
