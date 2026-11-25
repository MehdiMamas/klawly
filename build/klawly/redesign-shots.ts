/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Takes the Sprint 10 redesign shots (issue 569): the same surfaces, the same way, before and after.
// Usage: npm run redesign-shots [-- --theme <name,...>] [--size large|small|wide] [--only <name|prefix*,...>] [--out <dir>] [--exe <path>] [--no-zoom]
// Themes (default dark,light): dark and light are Klawly's; hc-black, hc-light, dark-plus, light-plus,
// monokai and solarized-light are the stock themes issue 584 checks Klawly's surfaces in.
//
// Launches the dev build (or --exe) with the fake runtime on design-parity's klawly-demo workspace and
// fixtures, once per theme and size:
// - large: 1440x900, agent pane 400px wide;
// - small: 1100x750, agent pane squeezed to 300px;
// - wide (only with --size wide): 1440x900, agent pane 600px wide (issue 578).
// Drives the app to every surface in SHOTS and saves `<theme>-<size>-<name>.png` in --out
// (default design/.parity/redesign/, gitignored). A shot with a `detail` selector also saves a crop of
// that element as `...-<name>.detail.png`. Large runs end with the agent pane and Klawly Settings at
// 144% zoom (zoom level 2), unless --no-zoom. Home needs a window with no folder, so it closes the
// folder last. A shot that cannot be reached is logged and skipped; the run goes on.
// It writes `shots.md` in --out: every file with its surface, theme and size, and what failed.
// A shot with `keys` then presses each key in turn and saves a crop around the focused element per stop
// (`...-<name>.key01.png`); `keyboard.json` records what had focus and whether it drew a ring (issue 584).
// A shot with `measure` records DOM sizes (rows shown, row heights) in `metrics.json` (issue 584).

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import type { ElectronApplication, Page } from 'playwright-core';
import { CHECKOUT_ASK, COMPOSER_INPUT, devExecutable, driver, finishTurn, FIXTURES, INLINE_EDIT_ASK, launchApp, MODE_PILL, openSettings, planTurn, resetEdits, revertCartService, selectApplyDiscount, setupFixtures, WORKSPACE, type Driver, type Theme } from './design-parity.ts';

const ROOT = resolve(import.meta.dirname, '../..');

interface Size {
	readonly name: 'large' | 'small' | 'wide';
	readonly width: number;
	readonly height: number;
	/** The agent pane's width. */
	readonly pane: number;
}

/** A theme a run can take its shots in. */
interface RunTheme {
	/** The name in the file names and in --theme. */
	readonly name: string;
	/** The Klawly theme of the same kind: it names the profile, and the high contrast shots switch back to it. */
	readonly base: Theme;
	/** workbench.colorTheme, when it is not the Klawly theme. */
	readonly colorTheme?: string;
}

const THEMES: readonly RunTheme[] = [
	{ name: 'dark', base: 'dark' },
	{ name: 'light', base: 'light' },
	{ name: 'hc-black', base: 'dark', colorTheme: 'Default High Contrast' },
	{ name: 'hc-light', base: 'light', colorTheme: 'Default High Contrast Light' },
	{ name: 'dark-plus', base: 'dark', colorTheme: 'Dark+' },
	{ name: 'light-plus', base: 'light', colorTheme: 'Light+' },
	{ name: 'monokai', base: 'dark', colorTheme: 'Monokai' },
	{ name: 'solarized-light', base: 'light', colorTheme: 'Solarized Light' },
];

const SIZES: readonly Size[] = [
	{ name: 'large', width: 1440, height: 900, pane: 400 },
	{ name: 'small', width: 1100, height: 750, pane: 300 },
	{ name: 'wide', width: 1440, height: 900, pane: 600 },
];

interface Shot {
	/** `<surface>_<state>`, the file name without theme and size. */
	readonly name: string;
	readonly surface: string;
	/** Brings the app to the state; it starts from the workbench with cartService.ts open. */
	drive(d: ShotDriver): Promise<void>;
	/** An element to crop as a second, close-up file. */
	readonly detail?: string;
	/** Runs after the shot. */
	cleanup?(d: ShotDriver): Promise<void>;
	/** Starts from where the last shot left the app instead of closing every editor. */
	readonly keep?: boolean;
	/** Keys pressed one at a time after the shot; each stop is saved as a crop around the focused element. */
	readonly keys?: readonly string[];
	/** Measures the state from the DOM after the shot. */
	measure?(d: ShotDriver): Promise<Record<string, unknown>>;
}

interface ShotDriver extends Driver {
	readonly app: ElectronApplication;
	/** The Klawly theme of the run's kind. */
	readonly theme: Theme;
	readonly runTheme: RunTheme;
	readonly size: Size;
	/** Drags the agent pane's edge until the pane is `width` wide, either way. */
	paneWidth(width: number): Promise<void>;
	/** The row of the explorer that shows `name`. */
	explorerRow(name: string): ReturnType<Page['locator']>;
	/** Sets the window's content size. */
	resize(width: number, height: number): Promise<void>;
}

/** Moves the cursor to the end of the file: macOS binds Cmd+Down, other systems Ctrl+End. */
const DOCUMENT_END = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
/** A turn that delegates to a subagent and keeps its to-do list open; it never completes. */
const DELEGATE_FIXTURE = 'redesign-delegate';
/** A turn that asks the user a question with options. */
const QUESTION_FIXTURE = 'redesign-question';
/** A turn that runs a command, then starts a dev server in the background (issue 742). */
const COMMAND_FIXTURE = 'redesign-commands';
/** A failing test log, pasted into the composer (issue 737). */
const PASTED_LOG = [
	'FAIL src/cart/cartService.test.ts',
	'  CartService',
	'    x applies a valid discount code (4 ms)',
	'',
	'  Expected: 21.6',
	'  Received: 21.599999999999998',
	'',
	'    at Object.<anonymous> (src/cart/cartService.test.ts:42:27)',
	'',
	'Tests: 1 failed, 13 passed, 14 total',
].join('\n');

function writeExtraFixtures(): void {
	const S = '$session';
	const file = (path: string) => join(WORKSPACE, path);
	const started = { type: 'session.started', sessionId: S, model: 'claude-opus-5-5' };
	const fixtures: Record<string, object[]> = {
		[DELEGATE_FIXTURE]: [
			started,
			{ type: 'todo.changed', sessionId: S, items: [
				{ id: '1', content: 'Find every place that reads the cart totals', status: 'completed' },
				{ id: '2', content: 'Round the discount to cents', status: 'in_progress' },
				{ id: '3', content: 'Test a valid and an unknown code', status: 'pending' },
			] },
			{ type: 'tool.started', sessionId: S, call: { id: 'r1', name: 'Read', category: 'read', input: { file_path: file('src/cart/cartService.ts') }, display: { label: 'Read cartService.ts', file: file('src/cart/cartService.ts') } } },
			{ type: 'tool.completed', sessionId: S, callId: 'r1', result: { ok: true, output: 'ok' } },
			{ type: 'tool.started', sessionId: S, call: { id: 'a1', name: 'Agent', category: 'other', input: { subagent_type: 'Explore', description: 'Find where totals are read' }, display: { label: 'Explore: Find where totals are read' } } },
			{ type: 'subagent.started', sessionId: S, run: { id: 'a1', agentType: 'Explore', description: 'Find where totals are read', background: false, state: 'running', startedAt: Date.now(), toolCallCount: 3 } },
			{ type: 'assistant.delta', sessionId: S, text: 'An Explore subagent is looking for every caller of totals() while I round the discount.' },
		],
		[QUESTION_FIXTURE]: [
			started,
			{ type: 'assistant.delta', sessionId: S, text: 'Two ways to store the codes fit this cart.' },
			{ type: 'elicitation.requested', sessionId: S, request: {
				id: 'q1', server: 'Claude', mode: 'question', message: 'Where should the discount codes live?', expiresAt: Date.now() + 24 * 3600 * 1000,
				questions: [{
					question: 'Where should the discount codes live?', header: 'Codes', multiSelect: false, options: [
						{ label: 'A table in discounts.ts', description: 'Simple and typed; a code change ships a new build.' },
						{ label: 'A JSON file', description: 'Edited without a build; read once at start.' },
					],
				}],
			} },
		],
		[COMMAND_FIXTURE]: [
			started,
			{ type: 'tool.started', sessionId: S, call: { id: 'b1', name: 'Bash', category: 'shell', input: { command: 'npm test -- cart', description: 'Run the cart tests' }, display: { label: 'npm test -- cart' } } },
			{ type: 'tool.completed', sessionId: S, callId: 'b1', result: { ok: true, output: 'PASS src/cart/cartService.test.ts\nTests: 14 passed, 14 total' } },
			{ type: 'tool.started', sessionId: S, call: { id: 'b2', name: 'Bash', category: 'shell', input: { command: 'npm run dev', description: 'Start the dev server', run_in_background: true }, display: { label: 'npm run dev' } } },
			{ type: 'tool.completed', sessionId: S, callId: 'b2', result: { ok: true, output: 'Command running in background with ID: b2' } },
			{ type: 'assistant.completed', sessionId: S, text: 'The tests pass, and the dev server keeps running in the background.' },
			{ type: 'session.completed', sessionId: S },
		],
	};
	for (const [name, events] of Object.entries(fixtures)) {
		writeFileSync(join(FIXTURES, `${name}.jsonl`), events.map(e => JSON.stringify(e)).join('\n') + '\n');
	}
}

const EXPLORER_FOCUS = 'Explorer: Focus on Files Explorer';

/** Counts the rows that match `rows` and how many lie inside `viewport`, with their heights and how many rows of the first height `viewport` fits (issue 584's density check). */
function measureRows(d: ShotDriver, rows: string, viewport: string): Promise<Record<string, unknown>> {
	return d.page.evaluate(({ rows, viewport }) => {
		const view = document.querySelector(viewport)?.getBoundingClientRect();
		const boxes = [...document.querySelectorAll(rows)].map(e => e.getBoundingClientRect()).filter(r => r.height > 0);
		const visible = view ? boxes.filter(r => r.top >= view.top - 1 && r.bottom <= view.bottom + 1) : boxes;
		const heights = boxes.map(r => Math.round(r.height * 10) / 10).sort((a, b) => a - b);
		return {
			rows: boxes.length,
			visible: visible.length,
			heights: heights.length ? { min: heights[0], median: heights[Math.floor(heights.length / 2)], max: heights[heights.length - 1] } : undefined,
			viewport: view ? Math.round(view.height) : undefined,
			fits: view && heights.length ? Math.floor(view.height / heights[0]) : undefined,
		};
	}, { rows, viewport });
}

/** Tab ten times, the way a keyboard user walks a surface (issue 584). */
const TABS = Array.from({ length: 10 }, () => 'Tab');
/**
 * Focuses the stop `count` Tabs before the composer, so the walk Tabs forward through the transcript into it:
 * Shift+Tab cycles the mode inside the composer, so it cannot walk back (issue 584).
 */
async function focusBeforeComposer(d: ShotDriver, count = 10): Promise<void> {
	// The composer is a text field, which always shows focus-visible, so the stop it hands focus to shows its ring too.
	await d.click(COMPOSER_INPUT, 300);
	await d.page.evaluate(({ composer, count }) => {
		const input = document.querySelector<HTMLElement>(composer);
		const pane = input?.closest<HTMLElement>('.claude-pane');
		if (!input || !pane) {
			return;
		}
		const stops = [...pane.querySelectorAll<HTMLElement>('a[href], button, input, textarea, select, [tabindex]')]
			.filter(e => e.tabIndex >= 0 && !e.matches(':disabled') && !e.closest('[aria-hidden="true"], [inert]') && e.getClientRects().length > 0);
		stops[Math.max(0, stops.indexOf(input) - count)]?.focus();
	}, { composer: COMPOSER_INPUT, count });
	await d.wait(300);
}

/** The surfaces #569 lists, in the order they are shot. */
/** What users type into the Command Palette for each job of the sprint UX check (issue 705's method). */
const UX_PALETTE_WORDS: readonly string[] = [
	// "I want Claude to stop asking me."
	'permissions', 'yolo', 'bypass', 'auto approve', 'allow everything', 'plan mode',
	// "Where's my usage?"
	'usage', 'limits', 'billing',
	// "Undo what the agent did."
	'undo', 'revert', 'checkpoint',
	// "Use a different model."
	'model', 'opus',
	// "Make a skill", MCP, rules.
	'skill', 'mcp', 'hooks', 'rules', 'plugin', 'customize',
	// "Send a bug report."
	'feedback', 'bug', 'report',
	// "See old chats."
	'history', 'old chats', 'resume',
	// Start, sign in, update, find help.
	'new chat', 'login', 'github', 'update', 'agents window', 'parallel', 'help', 'settings', 'voice', 'autocomplete', 'export chat', 'save chat', 'share chat', 'copy chat', 'new agent', 'keep all',
];

/** What users type into Klawly Settings' search. */
const UX_SETTINGS_WORDS: readonly string[] = ['permissions', 'yolo', 'bypass', 'auto approve', 'usage', 'skills', 'mcp', 'feedback', 'update', 'theme'];

/** What users type into the classic Settings editor's search. */
const UX_CLASSIC_SETTINGS_WORDS: readonly string[] = ['permission', 'claude', 'auto keep'];

const SHOTS: readonly Shot[] = [
	// Shell: a folder, two editor tabs, the terminal panel and the agent pane.
	{
		name: 'shell_window', surface: 'Shell',
		drive: async d => {
			await d.openFile('discounts.ts');
			await d.openFile('cartService.ts');
			await d.page.keyboard.press('Control+`');
			await d.wait(3000);
			await d.command('New Agent Session', 1500);
		},
		cleanup: d => d.command('View: Close Panel', 500),
	},
	// Explorer: selection with focus, a hovered row, then the selection without focus.
	{
		name: 'explorer_focused-selection', surface: 'Explorer', detail: '.part.sidebar',
		drive: async d => {
			await d.command(EXPLORER_FOCUS, 800);
			// Focus leaves the tree first, so the row click is a mouse focus, as a user's is (DL-28).
			await d.click('.part.editor .monaco-editor .view-lines', 300);
			await d.explorerRow('cartService.ts').click();
			await d.wait(500);
		},
		measure: d => measureRows(d, '.part.sidebar .explorer-folders-view .monaco-list-row', '.part.sidebar .explorer-folders-view .monaco-list'),
	},
	{
		// DL-28: a mouse click shows the fill only; the arrow key brings the focus ring back.
		name: 'explorer_keyboard-focus', surface: 'Explorer', detail: '.part.sidebar', keep: true,
		drive: async d => {
			await d.page.keyboard.press('ArrowDown');
			await d.wait(500);
		},
	},
	{
		name: 'explorer_hover', surface: 'Explorer', detail: '.part.sidebar', keep: true,
		drive: async d => {
			await d.explorerRow('cartTypes.ts').hover();
			await d.wait(700);
		},
	},
	{
		name: 'explorer_inactive-selection', surface: 'Explorer', detail: '.part.sidebar', keep: true,
		drive: async d => {
			await d.page.mouse.move(5, 5);
			await d.click('.part.editor .monaco-editor .view-lines', 500);
		},
	},
	// Editor chrome: tabs active, inactive, dirty and preview, and breadcrumbs.
	{
		name: 'editor_tabs', surface: 'Editor chrome', detail: '.part.editor .title',
		drive: async d => {
			await d.openFile('CLAUDE.md');
			await d.page.keyboard.press(DOCUMENT_END);
			await d.page.keyboard.type('- Keep the cart pure.');
			await d.openFile('discounts.ts');
			await d.command(EXPLORER_FOCUS, 600);
			// A single click opens a preview tab.
			await d.explorerRow('README.md').click();
			await d.wait(1200);
		},
		cleanup: async d => {
			await d.openFile('CLAUDE.md');
			await d.command('File: Revert File', 800);
		},
	},
	{
		name: 'editor_selection-toolbar', surface: 'Editor chrome',
		drive: async d => {
			await revertCartService(d);
			await selectApplyDiscount(d);
			await d.wait(1200);
		},
	},
	{
		name: 'editor_inline-edit', surface: 'Editor chrome',
		drive: async d => {
			await revertCartService(d);
			await selectApplyDiscount(d);
			await d.page.keyboard.press('ControlOrMeta+Alt+K');
			await d.wait(1000);
			await d.page.keyboard.type(INLINE_EDIT_ASK);
			await d.wait(500);
		},
		cleanup: d => d.escape(2),
	},
	// Agent pane.
	{ name: 'agent_empty', surface: 'Agent pane', drive: d => d.command('New Agent Session', 2000) },
	{
		name: 'agent_composer-focused', surface: 'Agent pane', detail: '.claude-pane .claude-composer',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.click(COMPOSER_INPUT, 300);
			await d.page.keyboard.type('Add an expiry date to the discount codes');
			await d.wait(500);
		},
	},
	{
		name: 'agent_mode-menu', surface: 'Agent pane',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.click(MODE_PILL, 700);
		},
	},
	{
		// Allow Everything in Agent mode is Claude Code's bypass permissions mode: the pill, the badge and the menu row say so (issue 694, DL-85).
		name: 'agent_bypass-mode-menu', surface: 'Agent pane',
		drive: async d => {
			userSetting(d.theme, 'claude.agent.allowEverythingConfirm', false);
			userSetting(d.theme, 'claude.agent.defaultPermissionMode', 'allowEverything');
			await d.wait(1500);
			await d.command('New Agent Session', 1500);
			await d.click(MODE_PILL, 700);
		},
		cleanup: async d => {
			await d.page.keyboard.press('Escape');
			userSetting(d.theme, 'claude.agent.defaultPermissionMode', undefined);
			userSetting(d.theme, 'claude.agent.allowEverythingConfirm', undefined);
			await d.wait(1000);
		},
	},
	{
		name: 'agent_model-menu', surface: 'Agent pane',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.click('.claude-pane button.claude-model-pill', 700);
		},
	},
	{
		name: 'agent_effort-menu', surface: 'Agent pane', keep: true,
		drive: async d => {
			await d.page.locator('.claude-model-menu [data-setting="effort"]').first().hover({ timeout: 4000 });
			await d.wait(800);
		},
	},
	{
		// A finished turn: the user message, thinking, read, search, edit and command rows, a code block and the changes bar.
		name: 'agent_turn-finished', surface: 'Agent pane',
		drive: async d => {
			await finishTurn(d);
			await d.click('.claude-pane button.claude-model-pill', 0).catch(() => { });
			await d.escape();
		},
		measure: d => measureRows(d, '.claude-pane .claude-tool-row', '.claude-pane .claude-timeline-host'),
	},
	{
		// Another model picked after a finished turn: the notice above the composer, never blocking Send (issue 703).
		name: 'agent_model-switch-notice', surface: 'Agent pane', detail: '.claude-pane .claude-model-switch-notice',
		drive: async d => {
			await finishTurn(d);
			await pickOtherModel(d);
		},
	},
	{
		name: 'agent_model-switch-notice-hc', surface: 'Agent pane', detail: '.claude-pane .claude-model-switch-notice',
		drive: async d => {
			highContrast(d, true);
			await finishTurn(d);
			await pickOtherModel(d);
		},
		cleanup: async d => {
			highContrast(d, false);
			await d.wait(1200);
		},
	},
	{
		// An inline command in the reply, hovered: its Run in Terminal button shows (issue 733).
		name: 'agent_reply-run-command', surface: 'Agent pane', keep: true,
		drive: async d => {
			// The finished-turn shot can leave the model menu open over the reply; close it first.
			for (let attempt = 0; attempt < 3 && await d.page.locator('.claude-model-menu').first().isVisible(); attempt++) {
				await d.escape();
			}
			const command = d.page.locator('.claude-pane .claude-inline-command').last();
			await command.scrollIntoViewIfNeeded({ timeout: 4000 });
			// The command can wrap, so the middle of its box may be the paragraph: point at its first line.
			const line = await command.locator('code').evaluate(code => {
				const rect = code.getClientRects()[0];
				return { x: rect.left + 4, y: rect.top + rect.height / 2 };
			});
			await d.page.mouse.move(line.x, line.y);
			await d.wait(300);
		},
	},
	{ name: 'agent_turn-finished-top', surface: 'Agent pane', keep: true, drive: d => scrollTranscript(d, -1), measure: d => measureRows(d, '.claude-pane .claude-tool-row', '.claude-pane .claude-timeline-host') },
	{
		// Find in Chat: the inline bar over the transcript, the match painted in the text, in tool output too (issue 890, DL-91).
		name: 'agent_find-in-chat', surface: 'Agent pane', keep: true,
		drive: async d => {
			await d.command('Find in Chat', 800);
			await d.page.keyboard.type('cart');
			await d.page.keyboard.press('Enter');
			await d.wait(600);
		},
		cleanup: async d => { await d.escape(); },
	},
	{
		// A drag across the reply selects its text, inline code included (issue 732).
		name: 'agent_reply-selected', surface: 'Agent pane', keep: true,
		drive: async d => {
			const reply = d.page.locator('.claude-pane .claude-msg-assistant').last();
			await reply.scrollIntoViewIfNeeded({ timeout: 4000 });
			const box = await reply.boundingBox();
			if (box) {
				await d.page.mouse.move(box.x + 4, box.y + 6);
				await d.page.mouse.down();
				await d.page.mouse.move(box.x + box.width - 8, box.y + Math.min(box.height - 6, 60), { steps: 8 });
				await d.page.mouse.up();
			}
			await d.wait(500);
		},
		cleanup: async d => { await d.page.evaluate('getSelection().removeAllRanges()'); },
	},
	{
		// A right-click on the selection offers Copy and Quote in Reply (issue 468, DL-88).
		name: 'agent_reply-selection-menu', surface: 'Agent pane', keep: true,
		drive: async d => {
			const reply = d.page.locator('.claude-pane .claude-msg-assistant').last();
			await reply.scrollIntoViewIfNeeded({ timeout: 4000 });
			const box = await reply.boundingBox();
			if (box) {
				await d.page.mouse.move(box.x + 4, box.y + 6);
				await d.page.mouse.down();
				await d.page.mouse.move(box.x + box.width - 8, box.y + Math.min(box.height - 6, 60), { steps: 8 });
				await d.page.mouse.up();
				await d.page.mouse.click(box.x + box.width / 2, box.y + 10, { button: 'right' });
			}
			await d.page.locator('.context-view .monaco-menu').first().waitFor({ timeout: 4000 }).catch(() => { });
			await d.wait(500);
		},
		cleanup: async d => {
			await d.page.keyboard.press('Escape');
			await d.page.evaluate('getSelection().removeAllRanges()');
		},
	},
	{
		// The edit row opened on its diff, and the command row on its output.
		name: 'agent_tool-rows-open', surface: 'Agent pane', keep: true,
		drive: async d => {
			for (const label of ['Edit cartService.ts', /Run the cart tests|npm test -- cart/]) {
				await d.page.locator('.claude-pane').getByText(label, { exact: false }).first().click({ timeout: 4000 }).catch(() => { });
				await d.wait(600);
			}
		},
	},
	{
		// Edit on a sent message: its text is back in the composer under the editing strip; the toolbar stays hovered (issue 702, DL-84).
		name: 'agent_edit-message', surface: 'Agent pane',
		drive: async d => {
			await finishTurn(d);
			const prompt = d.page.locator('.claude-pane .claude-msg-user').first();
			await prompt.scrollIntoViewIfNeeded({ timeout: 4000 });
			await prompt.hover({ timeout: 4000 });
			await prompt.locator('.claude-msg-toolbar button[aria-label="Edit"]').click({ timeout: 4000 });
			await prompt.hover({ timeout: 4000 });
			await d.wait(600);
		},
		cleanup: async d => { await d.escape(); },
	},
	{
		// A pasted image: a thumbnail chip named "Pasted image", not a stored id (issue 743, DL-74).
		name: 'agent_image-attached', surface: 'Agent pane', detail: '.claude-pane .claude-composer',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await pasteImage(d);
			await d.page.keyboard.type('Make the cart match this mockup');
			await d.wait(500);
		},
	},
	{
		// The chip's hover shows the image up to 240x160 (issue 743); it opens after the hover delay, so the shot waits for it (issue 791).
		name: 'agent_image-attached-hover', surface: 'Agent pane', keep: true,
		drive: async d => {
			await d.page.locator('.claude-pane .claude-chip.is-image').first().hover({ timeout: 4000 });
			await d.page.locator('.claude-image-thumb.is-preview.is-loaded').first().waitFor({ state: 'visible', timeout: 6000 });
			await d.wait(400);
		},
	},
	{
		// The sent message shows its image, which opens in an editor (issue 744, DL-74).
		name: 'agent_image-sent', surface: 'Agent pane',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			resetEdits();
			await pasteImage(d);
			writeFileSync(join(FIXTURES, 'next.txt'), 'finished');
			await d.page.keyboard.type('Make the cart match this mockup');
			await d.page.keyboard.press('Enter');
			await d.wait(6000);
			await scrollTranscript(d, -1);
		},
	},
	{
		// Claude reads the pasted image: alone it folds into "Viewed attached image Pasted image" (issue 744, 791).
		name: 'agent_image-read', surface: 'Agent pane',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			resetEdits();
			await pasteImage(d);
			writeImageReadFixture(d.theme);
			writeFileSync(join(FIXTURES, 'next.txt'), 'image-read');
			await d.page.keyboard.type('Make the cart match this mockup');
			await d.page.keyboard.press('Enter');
			await d.wait(5000);
			await scrollTranscript(d, -1);
		},
	},
	{
		// The same image inside a "Read 3 files" group, opened: it keeps its name and image icon.
		name: 'agent_image-read-group', surface: 'Agent pane', keep: true,
		drive: async d => {
			await d.page.locator('.claude-pane .claude-tool.is-file').filter({ hasText: /3 files/ }).locator('button').first().click({ timeout: 4000 });
			await d.wait(600);
		},
	},
	// The Install Claude Code card while the fake runtime's stand-in installer runs, stalls after 15s and fails at 40s (issue 797).
	{ name: 'agent_setup-installing', surface: 'Agent pane', detail: '.claude-pane .claude-setup-view', drive: d => waitForStandInInstall(d, 5000, true) },
	{ name: 'agent_setup-stalled', surface: 'Agent pane', detail: '.claude-pane .claude-setup-view', keep: true, drive: d => waitForStandInInstall(d, 22000) },
	{
		name: 'agent_setup-failed', surface: 'Agent pane', detail: '.claude-pane .claude-setup-view', keep: true,
		drive: d => waitForStandInInstall(d, 48000),
		cleanup: async d => {
			standInInstallStartedAt = undefined;
			rmSync(join(FIXTURES, 'runtime.json'), { force: true });
			await d.command('Terminal: Kill All Terminals', 800);
			await d.command('View: Close Panel', 500);
			await d.command('Re-detect Claude Runtime', 1500);
		},
	},
	{
		name: 'agent_turn-running', surface: 'Agent pane',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.send('running', CHECKOUT_ASK, 2500);
		},
		cleanup: d => d.command('Stop Agent', 800),
	},
	{
		// A turn that reached its step limit (issue 696).
		name: 'agent_turn-limit', surface: 'Agent pane',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.send('turn-limit', CHECKOUT_ASK, 3500);
		},
	},
	{
		// A turn that stopped on a plan limit (issue 450, DL-86).
		name: 'agent_usage-limit', surface: 'Agent pane',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.send('usage-limit', CHECKOUT_ASK, 3500);
		},
	},
	{
		name: 'agent_subagent-todos', surface: 'Agent pane',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.send(DELEGATE_FIXTURE, 'Round the discount to cents and check every caller of totals().', 3500);
		},
		cleanup: d => d.command('Stop Agent', 800),
	},
	// Auto delegation (issue 693, DL-71): a chat on Auto whose first message ran on Opus hands a short
	// question to a read-only chat on a lighter model. The fake runtime rates prompts with the local estimate.
	{
		name: 'agent_delegate-working', surface: 'Agent pane', detail: '.claude-pane .claude-delegate',
		drive: async d => {
			await delegateTurn(d, 'running');
		},
	},
	{
		name: 'agent_delegate-chat', surface: 'Agent pane', keep: true,
		drive: async d => {
			await delegateButton(d, 'Open Chat');
		},
	},
	{
		// Stop on the card: the card says "Stopped by you" and the chat asks once, above the composer.
		name: 'agent_delegate-stopped', surface: 'Agent pane', detail: '.claude-pane .claude-delegate', keep: true,
		drive: async d => {
			await d.click('.claude-pane-header .claude-subagent-back', 1000);
			await delegateButton(d, 'Stop');
		},
	},
	{
		name: 'agent_delegate-question', surface: 'Agent pane', detail: '.claude-pane .claude-delegate-question', keep: true,
		drive: d => d.wait(300),
		cleanup: async d => {
			await d.page.locator('.claude-pane .claude-delegate-question button', { hasText: 'No, Keep Auto' }).first().click({ timeout: 4000 }).catch(() => { });
			await endDelegateTurn(d);
		},
	},
	{
		name: 'agent_delegate-done', surface: 'Agent pane', detail: '.claude-pane .claude-delegate',
		drive: async d => {
			await delegateTurn(d, 'finished');
		},
		cleanup: endDelegateTurn,
	},
	{
		name: 'agent_permission', surface: 'Agent pane',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.send('permission', CHECKOUT_ASK, 3000);
		},
	},
	{
		name: 'agent_question', surface: 'Agent pane',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.send(QUESTION_FIXTURE, 'Add discount codes to the cart.', 3000);
		},
	},
	// Multitask (issue 686): sent in Ask, the tasks run read-only in the folder; the cards come back after a reload.
	{
		name: 'agent_multitask-read-only', surface: 'Agent pane', detail: '.claude-pane .claude-multitask',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await pickMode(d, 'Ask');
			await sendMultitask(d, 'running', ['Explain how the cart applies a discount', 'List every test that covers checkout'], 3500);
		},
	},
	{
		name: 'agent_multitask-reload', surface: 'Agent pane', detail: '.claude-pane .claude-multitask', keep: true,
		drive: async d => {
			// Wait for the new page: the old one still shows the cards until it unloads.
			const reloaded = d.page.waitForEvent('domcontentloaded', { timeout: 60000 });
			await d.command('Developer: Reload Window', 0);
			await reloaded;
			await d.page.locator('.claude-pane .claude-multitask').first().waitFor({ state: 'visible', timeout: 60000 });
			await d.wait(3000);
		},
		cleanup: d => d.click('.claude-pane .claude-multitask-header button[aria-label="Dismiss"]', 600),
	},
	{
		// A chip goes to the line that names it; the task's sent prompt carries the file.
		name: 'agent_multitask-attachment', surface: 'Agent pane',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await pickMode(d, 'Ask');
			await d.openFile('cartService.ts');
			await d.command('Add File to Agent', 1000);
			await sendMultitask(d, 'finished', ['Explain what cartService.ts exports', 'List every test that covers checkout'], 6000);
			await d.click('.claude-pane .claude-multitask-group:last-child .claude-multitask-run', 2000);
			await d.page.locator('.claude-pane .claude-msg-user').first().hover();
			await d.click('.claude-pane .claude-msg-user .claude-show-sent', 1000);
			await scrollTranscript(d, -1);
		},
	},
	{
		// `@terminal` lists the open terminal first, whatever it is named (issue 736).
		name: 'agent_at-terminal', surface: 'Agent pane',
		drive: async d => {
			await d.page.keyboard.press('Control+`');
			await d.wait(3000);
			await d.command('New Agent Session', 1500);
			await d.click(COMPOSER_INPUT, 300);
			await d.page.keyboard.type('Why did this fail? @terminal');
			await d.wait(1500);
		},
		cleanup: async d => {
			await d.escape();
			await d.command('View: Close Panel', 500);
		},
	},
	{
		// A long paste sits in the message as a pill the user types around (issue 737).
		name: 'agent_paste-pill', surface: 'Agent pane', detail: '.claude-pane .claude-composer',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.click(COMPOSER_INPUT, 300);
			await d.page.keyboard.type('Why does this fail? ');
			await d.page.evaluate(({ composer, text }) => {
				const input = document.querySelector<HTMLTextAreaElement>(composer);
				const data = new DataTransfer();
				data.setData('text/plain', text);
				// A synthetic paste has no default action: insert the text when the composer leaves it to the browser.
				if (input?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))) {
					document.execCommand('insertText', false, text);
				}
			}, { composer: COMPOSER_INPUT, text: PASTED_LOG });
			await d.wait(300);
			await d.page.keyboard.type(' It started after the discount change.');
			await d.wait(600);
		},
	},
	{
		// Claude's commands and what still runs in the background show in a terminal (issue 742).
		name: 'agent_command-terminal', surface: 'Agent pane',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.send(COMMAND_FIXTURE, 'Run the cart tests, then start the dev server.', 3000);
			await d.page.keyboard.press('Control+`');
			await d.wait(3000);
		},
		cleanup: d => d.command('View: Close Panel', 500),
	},
	{
		// The terminal's context menu sends its selection or last command to the agent (issue 734).
		name: 'overlay_terminal-menu', surface: 'Overlays',
		drive: async d => {
			await d.page.keyboard.press('Control+`');
			await d.wait(3000);
			await d.page.locator('.part.panel .terminal-wrapper .xterm').first().click({ button: 'right', timeout: 4000 });
			await d.wait(900);
		},
		cleanup: async d => {
			await d.escape();
			await d.command('View: Close Panel', 500);
		},
	},
	{
		// A settled terminal selection gets a floating Add to Agent bar, like the editor's (issue 780).
		name: 'overlay_terminal-selection-bar', surface: 'Overlays', detail: '.part.panel',
		drive: async d => {
			await d.page.keyboard.press('Control+`');
			await d.wait(3000);
			await d.page.keyboard.type('echo Add this line to the agent');
			await d.page.keyboard.press('Enter');
			await d.wait(1500);
			// Drag across the first rows, as a user selects a command and its output.
			const box = await d.page.locator('.part.panel .terminal-wrapper .xterm-screen').first().boundingBox({ timeout: 4000 });
			if (box) {
				await d.page.mouse.move(box.x + 4, box.y + 6);
				await d.page.mouse.down();
				await d.page.mouse.move(box.x + Math.min(box.width - 4, 320), box.y + 26, { steps: 8 });
				await d.page.mouse.up();
			}
			// The bar shows once the selection settles; without it the shot is not reached.
			await d.page.locator('.claude-terminal-selection-bar .claude-selection-bar').first().waitFor({ state: 'visible', timeout: 4000 });
			await d.wait(300);
		},
		cleanup: async d => {
			await d.escape();
			await d.command('View: Close Panel', 500);
		},
	},
	// Plan.
	{ name: 'plan_card', surface: 'Plan', drive: planTurn },
	{ name: 'plan_editor', surface: 'Plan', keep: true, drive: d => d.command('Open Chat Plan as File', 2500) },
	// Review: the changes bar and hunk chips in the editor, then the Review editor.
	{
		name: 'review_inline-changes', surface: 'Review',
		drive: async d => {
			await finishTurn(d);
			await d.click('.claude-review-bar button[aria-label="Next File"]', 1500).catch(() => { });
		},
	},
	{ name: 'review_review-editor', surface: 'Review', keep: true, drive: d => d.command('Review Chat Changes', 2500) },
	// Keep All (issue 706): the review editor's Keep scope menu, the changes bar with two turns waiting, and Auto-Keep.
	{ name: 'review_keep-options', surface: 'Review', keep: true, drive: d => d.click('.claude-review-keep > .more', 800) },
	{
		name: 'review_keep-all-two-turns', surface: 'Review', detail: '.claude-pane .claude-changes-dock',
		drive: async d => {
			await finishTurn(d);
			await d.send('inline-edit', INLINE_EDIT_ASK, 4000);
		},
	},
	{
		name: 'review_auto-keep', surface: 'Review', detail: '.claude-pane .claude-changes-dock',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.command('Toggle Auto-Keep for This Chat', 1000);
			resetEdits();
			await d.send('finished', 'Add discount codes to the cart.', 6000);
		},
	},
	{ name: 'review_auto-keep-menu', surface: 'Review', keep: true, drive: d => d.click(MODE_PILL, 700) },
	{
		// The same in the high contrast theme of the run's theme: the changes bar's Keep All, the Keep menu and the status bar item.
		name: 'review_keep-all-hc', surface: 'Review',
		drive: async d => {
			highContrast(d, true);
			await finishTurn(d);
			await d.send('inline-edit', INLINE_EDIT_ASK, 4000);
			await d.command('Review Chat Changes', 2500);
			await d.click('.claude-review-keep > .more', 800);
		},
		cleanup: async d => {
			highContrast(d, false);
			await d.wait(1200);
		},
	},
	{
		name: 'review_auto-keep-hc', surface: 'Review',
		drive: async d => {
			highContrast(d, true);
			await d.command('New Agent Session', 1500);
			await d.command('Toggle Auto-Keep for This Chat', 1000);
			resetEdits();
			await d.send('finished', 'Add discount codes to the cart.', 6000);
			await d.click(MODE_PILL, 700);
		},
		cleanup: async d => {
			highContrast(d, false);
			await d.wait(1200);
		},
	},
	{
		name: 'settings_auto-keep', surface: 'Settings',
		drive: async d => {
			await openSettings(d, /^Agents?$/);
			await d.page.getByText('Auto-Keep', { exact: true }).first().scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => { });
			await d.wait(600);
		},
	},
	// Settings.
	{ name: 'settings_agents', surface: 'Settings', drive: d => openSettings(d, /^Agents?$/), measure: d => measureRows(d, '.claude-settings .claude-settings-row', '.claude-settings') },
	{ name: 'settings_models', surface: 'Settings', drive: d => openSettings(d, /^Models$/) },
	// The account page: the GitHub profile row with the Claude row nested under it (issue 446).
	{ name: 'settings_general', surface: 'Settings', drive: d => d.command('Open Klawly Profile', 2500) },
	{ name: 'settings_customize', surface: 'Settings', drive: d => openSettings(d, /^Customi[sz]e$/) },
	// Plan & Usage with the note on how old the limits are (issue 704).
	{ name: 'settings_plan-usage', surface: 'Settings', drive: d => openSettings(d, /^Plan & Usage$/) },
	{
		// Below 720px the nav folds to an icon rail: the window shrinks until the editor is that narrow.
		name: 'settings_narrow-rail', surface: 'Settings',
		drive: async d => {
			await openSettings(d, /^Agents?$/);
			await d.resize(d.size.width - 380, d.size.height);
			await d.wait(1200);
		},
		cleanup: async d => {
			await d.resize(d.size.width, d.size.height);
			await d.wait(800);
			await d.paneWidth(d.size.pane);
		},
	},
	{ name: 'settings_classic', surface: 'Settings', drive: d => d.command('Preferences: Open Settings (UI)', 2500) },
	// Overlays.
	{
		name: 'overlay_command-palette', surface: 'Overlays',
		drive: async d => {
			await d.page.keyboard.press('ControlOrMeta+Shift+P');
			await d.wait(500);
			await d.page.keyboard.type('agent');
			await d.wait(900);
		},
		cleanup: d => d.escape(),
	},
	{
		name: 'overlay_context-submenu', surface: 'Overlays',
		drive: async d => {
			await d.page.locator('.part.editor .monaco-editor .view-lines').first().click({ button: 'right' });
			await d.wait(800);
			await d.page.locator('.context-view .monaco-menu .action-label').getByText(/^Peek$/).first().hover({ timeout: 4000 });
			await d.wait(900);
		},
		cleanup: d => d.escape(2),
	},
	{
		// The Accounts menu: the GitHub profile first, the Claude row under it (issue 446).
		name: 'overlay_accounts-menu', surface: 'Overlays',
		drive: async d => {
			await d.page.locator('.action-item:has(.codicon-accounts-view-bar-icon), .action-item:has(.has-avatar)').first().click({ timeout: 4000 });
			await d.wait(900);
		},
		cleanup: d => d.escape(),
	},
	{
		name: 'overlay_hover', surface: 'Overlays',
		drive: async d => {
			await d.page.locator('.part.editor .monaco-editor .view-lines').getByText('CartService', { exact: true }).first().hover({ timeout: 4000 });
			await d.wait(2500);
		},
	},
	{
		// Ask About Klawly asks to turn the built-in subagents back on when they are off: a notification with a button.
		name: 'overlay_notification', surface: 'Overlays',
		drive: async d => {
			userSetting(d.theme, 'claude.subagents.builtInAgents', false);
			await d.wait(1500);
			await d.command('Ask About Klawly', 1500);
		},
		cleanup: async d => {
			userSetting(d.theme, 'claude.subagents.builtInAgents', undefined);
			await d.wait(1000);
		},
	},
	{ name: 'overlay_notification-center', surface: 'Overlays', keep: true, drive: d => d.command('Notifications: Show Notifications', 800), cleanup: d => d.command('Notifications: Clear All Notifications', 500) },
	{
		// Closing a file with unsaved changes asks to save it (window.dialogStyle is custom, so the dialog is in the page).
		name: 'overlay_dialog', surface: 'Overlays',
		drive: async d => {
			await d.openFile('CLAUDE.md');
			await d.page.keyboard.press(DOCUMENT_END);
			await d.page.keyboard.type('- Draft');
			await d.command('View: Close Editor', 1200);
		},
		cleanup: async d => {
			await d.page.getByRole('button', { name: /Don't Save/ }).first().click({ timeout: 3000 }).catch(() => d.escape());
			await d.wait(500);
		},
	},
	{
		// Send Feedback with an email in the username field (issue 698): the reason under the field, Send off.
		name: 'overlay_feedback', surface: 'Overlays',
		drive: async d => {
			await d.command('Send Feedback', 2500);
			await d.page.getByPlaceholder(/^your-username$|GitHub username or email/).fill('me@example.com');
			await d.wait(400);
		},
		cleanup: async d => {
			await d.escape();
			await d.wait(500);
		},
	},
	// Keyboard only (issue 584): each surface walked with keys, a crop of the focused element at every stop.
	{ name: 'keyboard_shell', surface: 'Keyboard', keys: Array.from({ length: 6 }, () => 'F6'), drive: d => d.click('.part.editor .monaco-editor .view-lines', 300) },
	{ name: 'keyboard_explorer', surface: 'Keyboard', keys: ['ArrowDown', 'ArrowDown', 'ArrowDown', 'Tab'], drive: d => d.command(EXPLORER_FOCUS, 800) },
	{
		name: 'keyboard_agent-empty', surface: 'Keyboard', keys: TABS,
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.click(COMPOSER_INPUT, 300);
		},
	},
	{
		name: 'keyboard_agent-turn', surface: 'Keyboard', keys: TABS,
		drive: async d => {
			await finishTurn(d);
			await focusBeforeComposer(d);
		},
	},
	{
		name: 'keyboard_permission', surface: 'Keyboard', keys: TABS,
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.send('permission', CHECKOUT_ASK, 3000);
			await focusBeforeComposer(d);
		},
	},
	{
		name: 'keyboard_question', surface: 'Keyboard', keys: TABS,
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.send(QUESTION_FIXTURE, 'Add discount codes to the cart.', 3000);
			await focusBeforeComposer(d);
		},
	},
	{
		name: 'keyboard_plan', surface: 'Keyboard', keys: TABS,
		drive: async d => {
			await planTurn(d);
			await focusBeforeComposer(d);
		},
	},
	{
		name: 'keyboard_review', surface: 'Keyboard', keys: TABS,
		drive: async d => {
			await finishTurn(d);
			await d.command('Review Chat Changes', 2500);
			// The review opens in its code editor, where Tab types; a keyboard user starts from its header.
			await d.page.locator('.claude-review-editor-header').locator('button, a[href], [tabindex="0"]').first().focus();
			await d.wait(300);
		},
	},
	{ name: 'keyboard_settings', surface: 'Keyboard', keys: [...TABS, ...TABS], drive: d => openSettings(d, /^Agents?$/) },
	{
		name: 'keyboard_command-palette', surface: 'Keyboard', keys: ['ArrowDown', 'ArrowDown', 'ArrowDown'],
		drive: async d => {
			await d.page.keyboard.press('ControlOrMeta+Shift+P');
			await d.wait(500);
			await d.page.keyboard.type('agent');
			await d.wait(900);
		},
		cleanup: d => d.escape(),
	},
	{
		name: 'keyboard_feedback', surface: 'Keyboard', keys: TABS,
		drive: d => d.command('Send Feedback', 2500),
		cleanup: async d => {
			await d.escape();
			await d.wait(500);
		},
	},
	// Home with a project: the watermark over an empty editor group.
	{ name: 'home_empty-editor', surface: 'Home', drive: d => d.command('View: Close All Editors', 800) },
	// The sprint UX check (issue 723): what a user finds with their own words, and where each job starts.
	...UX_PALETTE_WORDS.map(paletteSearch),
	...UX_SETTINGS_WORDS.map(words => settingsSearch(words, false)),
	...UX_CLASSIC_SETTINGS_WORDS.map(words => settingsSearch(words, true)),
	{
		name: 'ux_history', surface: 'UX check',
		drive: async d => {
			await finishTurn(d);
			await d.click(chatHeaderButton('Agent History'), 900);
		},
		cleanup: d => d.escape(),
	},
	{
		name: 'ux_chat-more-menu', surface: 'UX check', keep: true,
		// Opens the pane itself, so the shot also works alone (`--only ux_chat-more-menu`).
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.click(chatHeaderButton('More actions'), 900);
		},
		cleanup: d => d.escape(),
	},
	// macOS keeps the native menu bar, so the Help menu is shot on Windows only.
	...(process.platform === 'darwin' ? [] : [{
		name: 'ux_help-menu', surface: 'UX check',
		drive: async (d: ShotDriver) => {
			await d.page.locator('.menubar .menubar-menu-button[aria-label="Help"], .menubar .menubar-menu-button:has-text("Help")').first().click({ timeout: 4000 });
			await d.wait(900);
		},
		cleanup: (d: ShotDriver) => d.escape(),
	} satisfies Shot]),
	{
		name: 'ux_status-bar', surface: 'UX check', detail: '.part.statusbar',
		drive: async d => {
			await d.command('New Agent Session', 1500);
			await d.wait(500);
		},
	},
];

/** A visible chat header button: alone in its container the header sits in the part title, outside the pane. */
function chatHeaderButton(label: string): string {
	return `.claude-title-header button.claude-icon-btn[aria-label="${label}"]:visible, .claude-pane button.claude-icon-btn[aria-label="${label}"]:visible`;
}

function slug(words: string): string {
	return words.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

/** The Command Palette with `words` typed, the way a user searches for a job. */
function paletteSearch(words: string): Shot {
	return {
		name: `ux_palette-${slug(words)}`, surface: 'UX check', detail: '.quick-input-widget',
		drive: async d => {
			await d.page.keyboard.press('ControlOrMeta+Shift+P');
			await d.wait(500);
			await d.page.keyboard.type(words);
			await d.wait(1200);
		},
		cleanup: d => d.escape(),
	};
}

/** Klawly Settings, or the classic Settings editor, with `words` in its search. */
function settingsSearch(words: string, classic: boolean): Shot {
	return {
		name: `ux_${classic ? 'classic-settings' : 'settings'}-${slug(words)}`, surface: 'UX check',
		drive: async d => {
			if (classic) {
				await d.command('Preferences: Open Settings (UI)', 2500);
				await d.page.keyboard.type(words);
			} else {
				await d.command('Open Klawly Settings', 2500);
				await d.page.locator('input.claude-settings-search:visible').first().fill(words, { timeout: 4000 });
			}
			await d.wait(1200);
		},
	};
}

/**
 * Starts a chat on Auto (Balance), runs a refactor on Opus with the `finished` script, then asks a short
 * question that Auto hands to a delegated chat on a lighter model, which replays `fixture` (issue 693).
 */
async function delegateTurn(d: ShotDriver, fixture: string): Promise<void> {
	userSetting(d.theme, 'claude.models.auto', 'balance');
	await d.wait(1500);
	await d.command('New Agent Session', 1500);
	resetEdits();
	await d.send('finished', 'Refactor applyDiscount so codes come from discounts.ts and matching ignores case.', 6000);
	await d.send(fixture, 'Why does the checkout test fail on CI?', 4000);
}

/** Clicks the first delegate card's button with `label`. */
async function delegateButton(d: ShotDriver, label: string): Promise<void> {
	await d.page.locator('.claude-pane .claude-delegate-actions button', { hasText: label }).first().click({ timeout: 4000 });
	await d.wait(1200);
}

/** Stops what still runs and turns Auto back off for the next shots. */
async function endDelegateTurn(d: ShotDriver): Promise<void> {
	await d.command('Stop Agent', 800);
	userSetting(d.theme, 'claude.models.auto', undefined);
	await d.wait(800);
}

/** Sets (or with `undefined` removes) a user setting in the profile launchApp wrote; the app picks the file change up. */
function userSetting(theme: Theme, key: string, value: unknown): void {
	const file = join(FIXTURES, '..', `user-data-${theme}`, 'User', 'settings.json');
	const settings = JSON.parse(readFileSync(file, 'utf8'));
	settings[key] = value;
	writeFileSync(file, JSON.stringify(settings, undefined, '	'));
}

/** Switches to the high contrast theme of the run's theme, or back (issue 706 shots). */
/** Opens the composer's model menu and picks the last model that is not the chat's own (issue 703). */
async function pickOtherModel(d: ShotDriver): Promise<void> {
	const menu = d.page.locator('.claude-model-menu').first();
	// The review the turn opens can take focus and close the menu, so try twice.
	for (let attempt = 0; attempt < 2 && !(await menu.isVisible()); attempt++) {
		await d.click('.claude-pane button.claude-model-pill', 0);
		await menu.waitFor({ state: 'visible', timeout: 4000 }).catch(() => undefined);
	}
	await menu.locator('[data-setting="model"]').first().hover({ timeout: 4000 });
	await d.wait(600);
	await d.page.locator('[data-model-id][aria-checked="false"]').last().click({ timeout: 4000 });
	await d.wait(1200);
}

function highContrast(d: ShotDriver, on: boolean): void {
	const hc = d.theme === 'light' ? 'Default High Contrast Light' : 'Default High Contrast';
	userSetting(d.theme, 'workbench.colorTheme', on ? hc : d.runTheme.colorTheme ?? (d.theme === 'light' ? 'Klawly Light' : 'Klawly Dark'));
}

/** The shots retaken at 150% zoom. */
const ZOOM_SHOTS = ['agent_turn-finished', 'settings_agents'];
/** Zoom level 2 is 1.2 squared, 144%. */
const ZOOM_SUFFIX = '.zoom144';

/** Picks a mode in the composer's mode menu. */
async function pickMode(d: ShotDriver, label: string): Promise<void> {
	await d.click(MODE_PILL, 600);
	await d.page.locator('.claude-mode-menu, .context-view .monaco-menu').getByText(label, { exact: true }).first().click({ timeout: 4000 });
	await d.wait(400);
}

/** Starts `/multitask` from the Command Palette (issue 686), types one prompt per line and sends it; every task replays `fixture`. */
async function sendMultitask(d: ShotDriver, fixture: string, prompts: readonly string[], settle: number): Promise<void> {
	writeFileSync(join(FIXTURES, 'next.txt'), fixture);
	await d.command('Run Parallel Agents (Multitask)', 800);
	for (const [index, prompt] of prompts.entries()) {
		if (index > 0) {
			await d.page.keyboard.press('Shift+Enter');
		}
		await d.page.keyboard.type(prompt);
	}
	await d.wait(300);
	await d.page.keyboard.press('Enter');
	await d.wait(settle);
}

/** Pastes a drawn image into an empty composer, the way a screenshot paste arrives. */
async function pasteImage(d: ShotDriver): Promise<void> {
	await d.click(COMPOSER_INPUT, 300);
	await d.page.evaluate(async selector => {
		const canvas = document.createElement('canvas');
		canvas.width = 320;
		canvas.height = 200;
		const context = canvas.getContext('2d')!;
		const gradient = context.createLinearGradient(0, 0, 320, 200);
		gradient.addColorStop(0, '#3b6fb6');
		gradient.addColorStop(1, '#8fc1a9');
		context.fillStyle = gradient;
		context.fillRect(0, 0, 320, 200);
		context.fillStyle = '#ffffff';
		context.fillRect(24, 24, 180, 18);
		context.fillRect(24, 56, 272, 96);
		const blob = await new Promise<Blob>(done => canvas.toBlob(b => done(b!), 'image/png'));
		const data = new DataTransfer();
		data.items.add(new File([blob], 'image.png', { type: 'image/png' }));
		document.querySelector(selector)!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
	}, COMPOSER_INPUT);
	await d.wait(1500);
}

/**
 * The `image-read` turn: Claude reads the image the last paste stored, first alone, then
 * with two source files. The path is the real one, so the row is named as the app names it.
 */
function writeImageReadFixture(theme: Theme): void {
	const folder = join(FIXTURES, '..', `user-data-${theme}`, 'User', 'claude-attachments');
	const image = readdirSync(folder).map(name => join(folder, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
	const source = (path: string) => join(WORKSPACE, path);
	const S = '$session';
	const read = (id: string, path: string) => [
		{ type: 'tool.started', sessionId: S, call: { id, name: 'Read', category: 'read', input: { file_path: path }, display: { label: `Read ${path}`, file: path } } },
		{ type: 'tool.completed', sessionId: S, callId: id, result: { ok: true, output: 'ok' } },
	];
	const events = [
		{ type: 'session.started', sessionId: S, model: 'claude-opus-5-5' },
		...read('r1', image),
		{ type: 'assistant.delta', sessionId: S, text: 'The mockup shows the discount under the subtotal. I will check how the cart builds its totals.\n\n' },
		...read('r2', image),
		...read('r3', source('src/cart/cartService.ts')),
		...read('r4', source('src/cart/cartTypes.ts')),
		{ type: 'assistant.completed', sessionId: S, text: 'The mockup shows the discount under the subtotal. I will check how the cart builds its totals.\n\n`totals()` already returns the discount, so the view only needs a row for it under the subtotal.' },
		{ type: 'session.completed', sessionId: S },
	];
	writeFileSync(join(FIXTURES, 'image-read.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

/** When the stand-in installer of the setup shots started, so each shot waits from the same start. */
let standInInstallStartedAt: number | undefined;

/**
 * Brings the setup card to `ms` after the fake runtime's stand-in installer started. It starts
 * one when none runs (or `restart` is set): Claude Code reads as missing through `runtime.json`,
 * and Install runs a command that downloads nothing.
 */
async function waitForStandInInstall(d: ShotDriver, ms: number, restart = false): Promise<void> {
	if (restart || standInInstallStartedAt === undefined) {
		// These can be a run's first shots, before anything has drawn the agent pane.
		await d.command('New Agent Session', 1500);
		await d.page.locator('.claude-pane').first().waitFor({ state: 'visible', timeout: 10000 });
		writeFileSync(join(FIXTURES, 'runtime.json'), JSON.stringify({ installed: false, authenticated: false }));
		await d.command('Re-detect Claude Runtime', 1500);
		await d.command('Install Claude Code', 1200);
		await d.page.locator('.monaco-dialog-box .monaco-button').filter({ hasText: 'Run Installer' }).first().click({ timeout: 4000 });
		standInInstallStartedAt = Date.now();
	}
	await d.wait(Math.max(0, standInInstallStartedAt + ms - Date.now()));
	// Without the setup card the shot is not reached.
	await d.page.locator('.claude-pane .claude-setup-view').first().waitFor({ state: 'visible', timeout: 4000 });
}

async function scrollTranscript(d: ShotDriver, direction: -1 | 1): Promise<void> {
	await d.page.locator('.claude-pane .monaco-scrollable-element').first().hover();
	for (let i = 0; i < 15; i++) {
		await d.page.mouse.wheel(0, direction * 1200);
		await d.wait(60);
	}
	await d.wait(600);
}

function shotDriver(app: ElectronApplication, page: Page, runTheme: RunTheme, size: Size): ShotDriver {
	const d = driver(page);
	const resize = async (width: number, height: number) => {
		await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.width, s.height), { width, height });
		await page.waitForTimeout(800);
	};
	return {
		...d,
		app,
		theme: runTheme.base,
		runTheme,
		size,
		resize,
		explorerRow: name => page.locator('.part.sidebar .explorer-folders-view .monaco-list-row').filter({ hasText: new RegExp(`^\\s*${name.replace(/\./g, '\\.')}`) }).first(),
		paneWidth: async width => {
			for (let attempt = 0; attempt < 4; attempt++) {
				const pane = await page.locator('.part.auxiliarybar').boundingBox();
				if (!pane) {
					throw new Error('Agent pane: not found in the app');
				}
				if (Math.abs(Math.round(pane.width) - width) <= 1) {
					return;
				}
				const y = pane.y + pane.height / 2;
				await page.mouse.move(pane.x + 1, y);
				await page.mouse.down();
				await page.mouse.move(pane.x + 1 + (pane.width - width), y, { steps: 10 });
				await page.mouse.up();
				await page.waitForTimeout(800);
			}
		},
	};
}

interface Args {
	themes: RunTheme[];
	sizes: Size[];
	/** Shot names to take; `name*` takes every shot whose name starts with `name` (`keyboard_*`). */
	only?: (name: string) => boolean;
	out: string;
	exe: string;
	zoom: boolean;
}

function parseArgs(argv: string[]): Args {
	const value = (flag: string) => {
		const index = argv.indexOf(flag);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const theme = value('--theme');
	const size = value('--size');
	const only = value('--only');
	const themes = (theme ?? 'dark,light').split(',');
	const unknown = themes.filter(name => !THEMES.some(t => t.name === name));
	if (unknown.length) {
		throw new Error(`unknown theme ${unknown.join(', ')}; use ${THEMES.map(t => t.name).join(', ')}`);
	}
	return {
		themes: THEMES.filter(t => themes.includes(t.name)),
		sizes: SIZES.filter(s => size ? s.name === size : s.name !== 'wide'),
		only: only ? name => only.split(',').some(p => p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p) : undefined,
		out: resolve(value('--out') ?? join(ROOT, 'design', '.parity', 'redesign')),
		exe: value('--exe') ?? devExecutable(),
		zoom: !argv.includes('--no-zoom'),
	};
}

interface Taken {
	readonly file: string;
	readonly surface: string;
	readonly name: string;
	readonly theme: string;
	readonly size: string;
}

/** One stop of a `keys` shot. */
interface KeyStop {
	readonly file: string;
	readonly key: string;
	/** The focused element: tag, first classes and its label. */
	readonly focus: string;
	/** Whether focus shows on the focused element, or on the row it stands for (see `focusStop`). */
	readonly ring: boolean;
	readonly how?: string;
}

interface Records {
	readonly taken: Taken[];
	readonly failed: string[];
	readonly keys: Record<string, KeyStop[]>;
	readonly metrics: Record<string, Record<string, unknown>>;
}

interface FocusStop {
	readonly focus: string;
	readonly ring: boolean;
	/** How focus shows: `ring`, `focus-within`, `indicator` or `fill`. */
	readonly how?: string;
	readonly box?: { x: number; y: number; width: number; height: number };
}

/**
 * Describes the focused element, whether focus shows on it, and its box. Focus counts as shown by an outline or ring
 * shadow on it, an edge in a focus color on it or on a `:focus-within` ancestor (the composer card), a focus-colored
 * indicator line (a composite bar tab), or the fill of the row an input points at with `aria-activedescendant`.
 */
function focusStop(page: Page): Promise<FocusStop> {
	return page.evaluate(() => {
		let element = document.activeElement as HTMLElement | null;
		// A list keeps focus on its container; the focused row is what draws the ring.
		const row = element?.querySelector<HTMLElement>('.monaco-list-row.focused');
		// A picker keeps focus in its input; the active row it points at is the indicator.
		const active = element?.getAttribute('aria-activedescendant');
		const pointed = active ? document.getElementById(active) : null;
		if (row) {
			element = row;
		} else if (pointed) {
			element = pointed;
		}
		if (!element || element === document.body) {
			return { focus: 'body', ring: false };
		}
		const target = element;
		const focusColors = new Set<string>();
		const probe = document.createElement('span');
		target.parentElement?.appendChild(probe);
		for (const name of ['--vscode-focusBorder', '--claude-focus', '--vscode-list-focusOutline', '--vscode-contrastActiveBorder']) {
			if (getComputedStyle(probe).getPropertyValue(name).trim()) {
				probe.style.color = `var(${name})`;
				focusColors.add(getComputedStyle(probe).color);
			}
		}
		probe.remove();
		const draws = (e: Element, pseudo?: string) => {
			const style = getComputedStyle(e, pseudo);
			const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
			const shadow = style.boxShadow !== 'none' && /(?:^|, )(?:inset )?(?:rgba?\([^)]*\) )?0px 0px 0px [1-9]/.test(style.boxShadow);
			return outline || shadow;
		};
		const focusEdge = (e: Element, pseudo?: string) => {
			const style = getComputedStyle(e, pseudo);
			return (['Top', 'Right', 'Bottom', 'Left'] as const).some(side =>
				style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none' && parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0
				&& focusColors.has(style.getPropertyValue(`border-${side.toLowerCase()}-color`)));
		};
		let how = draws(target) || draws(target, '::before') || draws(target, '::after') || focusEdge(target) ? 'ring' : '';
		for (let e = target.parentElement, depth = 0; !how && e && depth < 4 && !e.classList.contains('part'); e = e.parentElement, depth++) {
			if (e.matches(':focus-within') && focusEdge(e)) {
				how = 'focus-within';
			}
		}
		const indicator = target.querySelector('.active-item-indicator');
		if (!how && indicator && focusEdge(indicator, '::before')) {
			how = 'indicator';
		}
		if (!how && pointed === target && getComputedStyle(target).backgroundColor !== 'rgba(0, 0, 0, 0)') {
			how = 'fill';
		}
		const label = target.getAttribute('aria-label') ?? target.getAttribute('title') ?? target.textContent ?? '';
		const classes = [...target.classList].slice(0, 3).join('.');
		const rect = target.getBoundingClientRect();
		return {
			focus: `${target.tagName.toLowerCase()}${classes ? '.' + classes : ''} "${label.trim().replace(/\s+/g, ' ').slice(0, 50)}"`,
			ring: how !== '',
			how: how || undefined,
			box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
		};
	});
}

async function run(args: Args, runTheme: RunTheme, size: Size, records: Records): Promise<void> {
	const { taken, failed } = records;
	const theme = runTheme.name;
	const log = (line: string) => {
		console.log(`redesign-shots: ${line}`);
		appendFileSync(join(args.out, 'log.txt'), `${theme} ${size.name} ${line}\n`);
	};
	const { app, page } = await launchApp(args.exe, runTheme.base, true, { width: size.width, height: size.height }, {
		// Dialogs render in the page, where a screenshot sees them.
		'window.dialogStyle': 'custom',
		'workbench.startupEditor': 'none',
		...(runTheme.colorTheme ? { 'workbench.colorTheme': runTheme.colorTheme } : {}),
	});
	const d = shotDriver(app, page, runTheme, size);
	const save = async (shot: Shot, suffix = '') => {
		const base = `${theme}-${size.name}-${shot.name}${suffix}`;
		if (suffix === ZOOM_SUFFIX) {
			// Zoom shrinks the page's CSS viewport, so a page screenshot would come out at 1000x625; the window's own capture keeps every pixel.
			const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
			writeFileSync(join(args.out, `${base}.png`), Buffer.from(png, 'base64'));
		} else {
			await page.screenshot({ path: join(args.out, `${base}.png`) });
		}
		taken.push({ file: `${base}.png`, surface: shot.surface, name: shot.name + suffix, theme, size: `${size.width}x${size.height}, pane ${size.pane}px` });
		if (shot.detail) {
			const element = page.locator(shot.detail).first();
			if (await element.isVisible().catch(() => false)) {
				await element.screenshot({ path: join(args.out, `${base}.detail.png`) });
				taken.push({ file: `${base}.detail.png`, surface: shot.surface, name: `${shot.name}${suffix} (close-up)`, theme, size: `${size.width}x${size.height}, pane ${size.pane}px` });
			}
		}
		log(`shot ${shot.name}${suffix}`);
		if (shot.keys) {
			const stops: KeyStop[] = [];
			for (const [index, key] of shot.keys.entries()) {
				await page.keyboard.press(key);
				await d.wait(350);
				const stop = await focusStop(page);
				const file = `${base}.key${String(index + 1).padStart(2, '0')}.png`;
				// A crop around the focused element, so its ring is plain to see.
				const box = stop.box && stop.box.width > 0 && stop.box.height > 0 ? stop.box : undefined;
				const x = box ? Math.max(0, Math.floor(box.x) - 32) : 0;
				const y = box ? Math.max(0, Math.floor(box.y) - 32) : 0;
				const clip = box ? { x, y, width: Math.max(1, Math.min(size.width - x, Math.ceil(box.width) + 64)), height: Math.max(1, Math.min(size.height - y, Math.ceil(box.height) + 64)) } : undefined;
				await page.screenshot({ path: join(args.out, file), clip });
				taken.push({ file, surface: shot.surface, name: `${shot.name}${suffix} (${key} ${index + 1})`, theme, size: `${size.width}x${size.height}, pane ${size.pane}px` });
				stops.push({ file, key, focus: stop.focus, ring: stop.ring, how: stop.how });
			}
			records.keys[base] = stops;
			log(`keys ${shot.name}${suffix}: ${stops.length} stop(s), ${stops.filter(s => !s.ring).length} without a ring`);
		}
		if (shot.measure) {
			records.metrics[base] = await shot.measure(d);
		}
	};
	const take = async (shot: Shot, suffix = '') => {
		try {
			if (!shot.keep) {
				// A menu or picker the last shot left open would take the keys below.
				await d.escape(2);
				await d.command('View: Close All Editors', 800);
				await d.openFile('cartService.ts');
			}
			await shot.drive(d);
			await save(shot, suffix);
		} catch (error) {
			const message = String(error instanceof Error ? error.message : error).split('\n')[0];
			failed.push(`${theme} ${size.name} ${shot.name}${suffix}: ${message}`);
			log(`FAILED ${shot.name}${suffix}: ${message}`);
			await d.escape(3).catch(() => { });
		}
		await shot.cleanup?.(d).catch(() => { });
	};
	try {
		await d.command('Notifications: Clear All Notifications', 500);
		await d.paneWidth(size.pane);
		const shots = SHOTS.filter(s => !args.only || args.only(s.name));
		for (const shot of shots) {
			await take(shot);
		}
		if (args.zoom && size.name === 'large') {
			await d.command('View: Zoom In', 800);
			await d.command('View: Zoom In', 1500);
			for (const shot of SHOTS.filter(s => ZOOM_SHOTS.includes(s.name) && (!args.only || args.only(s.name)))) {
				await take(shot, ZOOM_SUFFIX);
			}
			await d.command('View: Reset Zoom', 1000);
		}
		if (!args.only || args.only('home_window')) {
			// Home is what a window with no folder shows.
			const home: Shot = { name: 'home_window', surface: 'Home', keep: true, drive: async () => {
				await d.command('Workspaces: Close Workspace', 500).catch(() => { });
				await d.command('File: Close Folder', 6000);
				await page.waitForSelector('.monaco-workbench', { timeout: 60000 });
				await d.wait(3000);
			} };
			await take(home);
		}
	} finally {
		await app.close().catch(() => { });
	}
}

function writeIndex(args: Args, { taken, failed, keys, metrics }: Records): void {
	const lines = [
		'# Redesign shots',
		'',
		`Taken by \`npm run redesign-shots\` (build/klawly/redesign-shots.ts) on ${process.platform}, ${new Date().toISOString()}.`,
		'',
		'| File | Surface | State | Theme | Size |',
		'|---|---|---|---|---|',
		...taken.map(t => `| ${t.file} | ${t.surface} | ${t.name.replace(/^[a-z]+_/, '')} | ${t.theme} | ${t.size} |`),
		'',
		failed.length ? '## Not reached' : 'Every shot was reached.',
		'',
		...failed.map(f => `- ${f}`),
	];
	writeFileSync(join(args.out, 'shots.md'), lines.join('\n') + '\n');
	if (Object.keys(keys).length) {
		writeFileSync(join(args.out, 'keyboard.json'), JSON.stringify(keys, undefined, '\t'));
	}
	if (Object.keys(metrics).length) {
		writeFileSync(join(args.out, 'metrics.json'), JSON.stringify(metrics, undefined, '\t'));
	}
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (!existsSync(args.exe)) {
		console.error(`redesign-shots: ${args.exe} not found. Run \`npm run electron\` and \`npm run compile\` (or transpile-client) first, or pass --exe.`);
		return 1;
	}
	mkdirSync(args.out, { recursive: true });
	setupFixtures();
	writeExtraFixtures();
	const records: Records = { taken: [], failed: [], keys: {}, metrics: {} };
	const { taken, failed } = records;
	for (const size of args.sizes) {
		for (const theme of args.themes) {
			await run(args, theme, size, records);
			// Each run starts from the drawn edits and the first fixture again.
			setupFixtures();
			writeExtraFixtures();
		}
	}
	writeIndex(args, records);
	console.log(`redesign-shots: ${taken.length} file(s), ${failed.length} not reached. See ${join(args.out, 'shots.md')}.`);
	return taken.length ? 0 : 1;
}

try {
	process.exitCode = await main();
} catch (error) {
	console.error(`redesign-shots: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
