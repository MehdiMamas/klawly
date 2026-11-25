/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Takes the two Auto shots of issue 1307 that need a delegated turn: `delegate-card.png` and
// `agents-row-cost.png` in docs/screenshots/auto-status/.
// Usage: npm run auto-status-shots [-- --exe <path>]
//
// Auto only delegates when the chat is already on a model other than the one it picks (always Opus), and the
// Auto flag is read when a session is created, so the run starts the session with Auto off, picks Sonnet,
// sends one turn, then turns Auto on with the composer's Auto pill before the second (delegated) turn.
// The delegated fixture carries the cost ($0.42) the card and the Agents row show. The Agents sidebar only
// fits in a wide pane, so the pane is maximized first.

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { devExecutable, driver, FIXTURES, launchApp, setupFixtures, WORKSPACE } from './design-parity.ts';

const OUT = join(import.meta.dirname, '..', '..', 'docs', 'screenshots', 'auto-status');
const THEME = 'dark';
const SESSION = '$session';

const exeFlag = process.argv.indexOf('--exe');
const exe = exeFlag >= 0 ? process.argv[exeFlag + 1] : devExecutable();

/** The delegated turn: a worker reads a file, answers, and reports $0.42. */
const delegated = [
	{ type: 'session.started', sessionId: SESSION, model: 'claude-sonnet-5-5' },
	{ type: 'tool.started', sessionId: SESSION, call: { id: 'r1', name: 'Read', category: 'read', input: { file_path: join(WORKSPACE, 'src/cart/cartService.ts') }, display: { label: 'Read cartService.ts', file: join(WORKSPACE, 'src/cart/cartService.ts') } } },
	{ type: 'tool.completed', sessionId: SESSION, callId: 'r1', result: { ok: true, output: 'ok' } },
	{ type: 'assistant.completed', sessionId: SESSION, text: 'The checkout test waits on a mocked clock that CI does not set.' },
	{ type: 'usage.changed', sessionId: SESSION, usage: { inputTokens: 18200, outputTokens: 2100, contextTokens: 41000, contextWindow: 200000, costUsd: 0.42 } },
	{ type: 'session.completed', sessionId: SESSION },
];

setupFixtures();
writeFileSync(join(FIXTURES, 'auto-delegated.jsonl'), delegated.map(e => JSON.stringify(e)).join('\n') + '\n');
mkdirSync(OUT, { recursive: true });

/** Sets a user setting in the run's settings file (the app reads it live). */
function setting(key: string, value: unknown): void {
	const file = join(FIXTURES, '..', `user-data-${THEME}`, 'User', 'settings.json');
	const settings = JSON.parse(readFileSync(file, 'utf8'));
	settings[key] = value;
	writeFileSync(file, JSON.stringify(settings, undefined, '\t'));
}

const { app, page } = await launchApp(exe, THEME, true, { width: 1440, height: 900 }, {});
try {
	const d = driver(page);
	// Auto off at session creation; the chat then sits on Sonnet, so Auto's Opus pick delegates.
	setting('claude.models.auto', 'off');
	await d.wait(1500);
	await d.command('New Agent Session', 1500);
	await d.click('.claude-pane button.claude-model-pill', 800);
	await page.locator('.claude-model-menu [data-setting="model"]').first().hover({ timeout: 4000 });
	await d.wait(600);
	await page.locator('[data-model-id*="sonnet" i]').first().click({ timeout: 4000 });
	await d.wait(1200);
	await d.send('finished', 'Refactor applyDiscount so codes come from discounts.ts and matching ignores case.', 6000);
	await d.click('.claude-auto-pill', 1500);
	await d.send('auto-delegated', 'Why does the checkout test fail on CI?', 4000);
	if (!await page.locator('.claude-delegate').count()) {
		throw new Error('auto-status-shots: Auto did not delegate, no .claude-delegate card');
	}
	await page.screenshot({ path: join(OUT, 'delegate-card.png') });

	// The Agents sidebar needs a wide pane: show it, then maximize the pane.
	await page.locator('[aria-label="Show Agents Sidebar"]').first().click({ timeout: 4000 });
	await d.wait(1500);
	await page.mouse.click(1421, 53);
	await d.wait(2500);
	if (!await page.locator('.claude-agents-scroll button', { hasText: '$0.42' }).count()) {
		throw new Error('auto-status-shots: no Agents row shows $0.42');
	}
	await page.screenshot({ path: join(OUT, 'agents-row-cost.png') });
} finally {
	await app.close();
}
