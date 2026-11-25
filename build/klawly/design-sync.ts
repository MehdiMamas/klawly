/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Keeps the design prototype (design/) in step with the app. Runs after `npm run compile`.
// Usage: node build/klawly/design-sync.ts [--accept <page.html ...>] [--accept-all] [--sync-file <path>] [--check]
//   --check: write nothing; exit 1 when a page is still to redraw or has unchecked clicks (the CI gate, #1567).
//   --sync-file: read and write the baseline at <path> instead of design/sync.json and leave STALE.md alone.
//   Used by the klawly-design-sync git merge driver (build/klawly/merge-design-sync.ts).
//
// 1. Tokens: copies the app's colors (Klawly themes) and sizes (claude.css) into the token
//    blocks of design/assets/global.css. A token is only rewritten when the prototype still
//    holds the app value from the last run, so a token changed by hand is never overwritten;
//    it is listed in design/STALE.md instead.
// 2. Pages: every page names the app files it mirrors in `data-source` attributes. When one
//    of those files changes, the page is listed in design/STALE.md, to be redrawn by hand.
//    `--accept` marks pages as redrawn (their files are the new baseline).
// 3. Assets: the logo files in design/assets/ follow the app's copies, with the same rule as
//    tokens (a file changed by hand is kept and listed).
// 4. Clicks: every link and menu trigger was checked against what a click does in the app, and
//    marked `data-app="idea|differs"` where it does not match. A click that was added or changed
//    since is listed in design/STALE.md until it is checked and the page is accepted.
// 5. Labels: pages and menus without a `data-origin` owner label are listed.
// The Parity section at the end of design/STALE.md belongs to design-parity.ts and is kept as it is.
//
// The page baselines live in design/.accepts/<page>.json (one file per page, so parallel branches never conflict; see design-accepts.ts), the token and asset baseline in design/sync.json, and design/STALE.md is generated and gitignored. With no arguments the run does nothing while a rebase or merge is in progress, so the hook never dirties files mid-pick. Never fails the compile: errors are printed and the
// exit code stays 0. No dependencies.

import { createHash } from 'crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { gitBusy, readAccepts, writeAccepts } from './design-accepts.ts';
import { dirname, join, posix, relative, resolve, sep } from 'path';

const ROOT = resolve(import.meta.dirname, '../..');
const DESIGN = join(ROOT, 'design');
const GLOBAL_CSS = join(DESIGN, 'assets', 'global.css');
const SYNC_JSON = join(DESIGN, 'sync.json');
/** One accept file per page (`design/.accepts/<page>.json`), so branches that accept different pages never touch the same file. */
const ACCEPTS = join(DESIGN, '.accepts');
const STALE_MD = join(DESIGN, 'STALE.md');
const CLAUDE_CSS = 'src/vs/workbench/contrib/claude/browser/media/claude.css';

/** Prototype asset (relative to design/) → the app file it copies. */
const ASSETS: Record<string, string> = {
	'assets/klawly-mark.svg': 'src/vs/workbench/contrib/claude/browser/media/klawly-mark.svg',
	'assets/klawly-mark-mono.svg': 'resources/klawly/klawly-mark-mono.svg',
};

type Theme = 'dark' | 'light';

const THEMES: Record<Theme, string> = {
	dark: 'extensions/theme-klawly/themes/klawly-dark.json',
	light: 'extensions/theme-klawly/themes/klawly-light.json',
};

/** Prototype color token → theme color id. Tokens not listed here are design-only. */
const COLOR_TOKENS: Record<string, string> = {
	'--k-chrome': 'titleBar.activeBackground',
	'--k-pane': 'sideBar.background',
	'--k-surface': 'editor.background',
	'--k-overlay': 'menu.background',
	'--k-input': 'input.background',
	'--k-ink': 'editor.foreground',
	'--k-ink-2': 'foreground',
	'--k-muted': 'descriptionForeground',
	'--k-faint': 'disabledForeground',
	'--k-hover': 'list.hoverBackground',
	'--k-active': 'list.activeSelectionBackground',
	'--k-line-strong': 'input.border',
	'--k-line-solid': 'widget.border',
	'--k-teal': 'editorCursor.foreground',
	'--k-brand': 'progressBar.background',
	'--k-indigo': 'button.background',
	'--k-indigo-hover': 'button.hoverBackground',
	'--k-on-accent': 'button.foreground',
	'--k-link': 'textLink.foreground',
	'--k-focus': 'focusBorder',
	'--k-red': 'errorForeground',
	'--k-git-added': 'gitDecoration.addedResourceForeground',
	'--k-git-modified': 'gitDecoration.modifiedResourceForeground',
	'--k-git-deleted': 'gitDecoration.deletedResourceForeground',
	'--k-diff-add-line': 'diffEditor.insertedLineBackground',
	'--k-diff-add-text': 'diffEditor.insertedTextBackground',
	'--k-diff-del-line': 'diffEditor.removedLineBackground',
	'--k-diff-del-text': 'diffEditor.removedTextBackground',
	'--k-selection': 'editor.selectionBackground',
	'--k-line-highlight': 'editor.lineHighlightBackground',
	'--k-ghost-text': 'editorGhostText.foreground',
	'--k-line-number': 'editorLineNumber.foreground',
	'--k-find-match': 'editor.findMatchBackground',
	'--k-find-match-other': 'editor.findMatchHighlightBackground',
	'--k-diff-hatch': 'diffEditor.diagonalFill',
	'--k-hover-highlight': 'editor.hoverHighlightBackground',
	'--k-star': 'extensionIcon.starForeground',
};

/** Prototype size token → claude.css variable. Sizes are the same in both themes. */
const SIZE_TOKENS: Record<string, string> = {
	'--k-text-2xs': '--claude-text-2xs',
	'--k-text-xs': '--claude-text-xs',
	'--k-text-sm': '--claude-text-sm',
	'--k-text-md': '--claude-text-md',
	'--k-text-chat': '--claude-text-chat',
	'--k-text-lg': '--claude-text-lg',
	'--k-text-xl': '--claude-text-xl',
	'--k-text-2xl': '--claude-text-2xl',
	'--k-leading-tight': '--claude-leading-tight',
	'--k-leading': '--claude-leading',
	'--k-leading-chat': '--claude-leading-chat',
	'--k-icon-mark': '--claude-icon-mark',
	'--k-icon-compact': '--claude-icon-compact',
	'--k-icon-md': '--claude-icon-md',
	'--k-icon-base': '--claude-icon-base',
	'--k-icon-display': '--claude-icon-display',
	'--k-radius-xs': '--claude-radius-xs',
	'--k-radius-sm': '--claude-radius-sm',
	'--k-radius-md': '--claude-radius-md',
	'--k-radius-lg': '--claude-radius-lg',
	'--k-radius-xl': '--claude-radius-xl',
	'--k-radius-2xl': '--claude-radius-2xl',
	'--k-radius-pill': '--claude-radius-pill',
	'--k-row-tree': '--claude-row-tree',
	'--k-row-menu': '--claude-row-menu',
	'--k-row': '--claude-row-h',
	'--k-row-tall': '--claude-row-tall',
	'--k-control-h': '--claude-control-h',
	'--k-icon-btn': '--claude-icon-btn',
	'--k-composer-max': '--claude-composer-max',
	'--k-menu-w': '--claude-menu-w',
	'--k-menu-w-wide': '--claude-menu-w-wide',
};

interface SyncState {
	/** App value of each token at the last run, per theme ('shared' for sizes). */
	tokens: Record<string, Record<string, string>>;
	/** Per page: hash of every app file it names in `data-source`, when it was last redrawn. */
	pages: Record<string, Record<string, string>>;
	/** Per asset: hash of the app file when it was last copied. */
	assets?: Record<string, string>;
	/** Per page: every checked click and its verdict ('app', 'idea' or 'differs'). */
	clicks?: Record<string, Record<string, string>>;
}

interface PageInfo {
	readonly page: string;
	readonly sources: Map<string, string[]>;
	/** Click signature → what the page says the app does ('app' unless marked `data-app`). */
	readonly clicks: Map<string, string>;
	/** Owner-label problems: no `data-origin` on the page, or a menu without one. */
	readonly unlabeled: string[];
}

/** Calls `outside` for every run of text outside string literals and keeps the strings as they are. */
function mapOutsideStrings(text: string, outside: (chunk: string) => string): string {
	let out = '';
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') {
				j += text[j] === '\\' ? 2 : 1;
			}
			out += outside(text.slice(start, i)) + text.slice(i, j + 1);
			start = j + 1;
			i = j;
		} else if (text[i] === '/' && text[i + 1] === '/') {
			const end = text.indexOf('\n', i);
			out += outside(text.slice(start, i));
			start = i = end === -1 ? text.length : end;
		} else if (text[i] === '/' && text[i + 1] === '*') {
			out += outside(text.slice(start, i));
			start = text.indexOf('*/', i + 2) + 2;
			i = start - 1;
		}
	}
	return out + outside(text.slice(start));
}

/** Parses JSON with comments and trailing commas, as VS Code theme files allow. */
function parseJsonc(text: string): Record<string, unknown> {
	const noComments = mapOutsideStrings(text, chunk => chunk);
	return JSON.parse(mapOutsideStrings(noComments, chunk => chunk.replace(/,(?=\s*[}\]])/g, '')));
}

/** Colors of a theme file, with its `include` chain resolved (the file's own colors win). */
function themeColors(file: string): Record<string, string> {
	const json = parseJsonc(readFileSync(file, 'utf8'));
	const base = typeof json.include === 'string' ? themeColors(resolve(dirname(file), json.include)) : {};
	return { ...base, ...(json.colors as Record<string, string> | undefined) };
}

/** First declaration of each `--claude-*` variable, with `var(--x, fallback)` reduced to its fallback. */
function claudeCssSizes(): Map<string, string> {
	const result = new Map<string, string>();
	const css = readFileSync(join(ROOT, CLAUDE_CSS), 'utf8');
	for (const match of css.matchAll(/^\s*(?<name>--claude-[a-z0-9-]+):\s*(?<value>[^;]+);/gm)) {
		const { name, value } = match.groups!;
		const fallback = /^var\(--[\w-]+,\s*(?<fallback>[^)]+)\)$/.exec(value.trim())?.groups?.fallback ?? value.trim();
		if (!result.has(name) && /^\d+px$/.test(fallback)) {
			result.set(name, fallback);
		}
	}
	return result;
}

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba | undefined {
	const v = value.trim().toLowerCase();
	const hex = /^#(?<hex>[0-9a-f]{3,8})$/.exec(v)?.groups?.hex;
	if (hex) {
		const full = hex.length <= 4 ? [...hex].map(c => c + c).join('') : hex;
		const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
		return [n(0), n(2), n(4), full.length === 8 ? Math.round(n(6) / 255 * 100) / 100 : 1];
	}
	const fn = /^rgba?\((?<args>[^)]+)\)$/.exec(v)?.groups?.args;
	if (fn) {
		const parts = fn.split(/[\s,/]+/).filter(Boolean).map(Number);
		return [parts[0], parts[1], parts[2], parts.length > 3 ? Math.round(parts[3] * 100) / 100 : 1];
	}
	return undefined;
}

/** Same color, compared at 2-decimal alpha, so `#2dd4bf99` equals `rgba(45, 212, 191, 0.6)`. */
function sameValue(a: string, b: string): boolean {
	const ca = parseColor(a);
	const cb = parseColor(b);
	if (ca && cb) {
		return ca.every((x, i) => x === cb[i]);
	}
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** A theme color written the way global.css writes it: `#rrggbb`, or `rgba(...)` when translucent. */
function cssColor(value: string): string {
	const c = parseColor(value);
	if (!c) {
		return value;
	}
	if (c[3] === 1) {
		return '#' + c.slice(0, 3).map(x => x.toString(16).padStart(2, '0')).join('');
	}
	return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3].toFixed(2)})`;
}

function hashFile(path: string): string | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
	return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function listPages(dir: string): string[] {
	const pages: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory() && entry.name !== 'assets') {
			pages.push(...listPages(path));
		} else if (entry.isFile() && entry.name.endsWith('.html') && dir !== DESIGN) {
			pages.push(relative(DESIGN, path).split(sep).join('/'));
		}
	}
	return pages.sort();
}

/** The app files each page mirrors, and the labels of the regions that name each file. */
function readPage(page: string): PageInfo {
	const html = readFileSync(join(DESIGN, page), 'utf8');
	const sources = new Map<string, string[]>();
	for (const tag of html.matchAll(/<[a-z][^>]*\bdata-source="(?<src>[^"]+)"[^>]*>/g)) {
		const label = /\bdata-label="(?<label>[^"]+)"/.exec(tag[0])?.groups?.label ?? '';
		for (const src of tag.groups!.src.split(/\s+/).filter(Boolean)) {
			const labels = sources.get(src) ?? [];
			if (label && !labels.includes(label)) {
				labels.push(label);
			}
			sources.set(src, labels);
		}
	}
	return { page, sources, clicks: readClicks(page, html), unlabeled: readUnlabeled(html) };
}

/**
 * Every link and menu trigger on a page, keyed by a signature that stays the same when the
 * page is restyled: its `k-` classes, title or text, icon and target.
 */
function readClicks(page: string, html: string): Map<string, string> {
	const clicks = new Map<string, string>();
	const pattern = /<(?<tag>a|button|span|div|li)\b(?<attrs>[^>]*?(?:href="(?<href>[^"]+)"|data-popover-target="(?<menu>[^"]+)")[^>]*)>(?<body>[\s\S]{0,200}?)<\/\k<tag>>/g;
	for (const match of html.matchAll(pattern)) {
		const { attrs, href, menu, body } = match.groups!;
		const classes = (/class="(?<value>[^"]*)"/.exec(attrs)?.groups?.value ?? '').split(' ').filter(c => c.startsWith('k-')).join('.');
		const title = /title="(?<value>[^"]*)"/.exec(attrs)?.groups?.value ?? '';
		const icon = /codicon-(?<name>[a-z0-9-]+)/.exec(body)?.groups?.name ?? '';
		const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
		let target = href ?? '#' + menu;
		if (href && !href.startsWith('#') && !href.startsWith('http')) {
			target = posix.normalize(posix.join(posix.dirname(page), href));
		}
		const verdict = /\bdata-app="(?<verdict>[a-z]+)"/.exec(attrs)?.groups?.verdict ?? 'app';
		clicks.set(`${classes} | ${title || text} | ${icon} -> ${target}`, verdict);
	}
	return clicks;
}

function readUnlabeled(html: string): string[] {
	const problems: string[] = [];
	if (!/\bdata-origin="/.test(html)) {
		problems.push('the page has no `data-origin` label');
	}
	for (const tag of html.matchAll(/<[a-z]+\b[^>]*\sdata-popover(?=[\s>])[^>]*>/g)) {
		if (!/\bdata-origin="/.test(tag[0])) {
			const id = /\bid="(?<id>[^"]+)"/.exec(tag[0])?.groups?.id ?? tag[0].slice(0, 40);
			problems.push(`menu \`#${id}\` has no \`data-origin\` label`);
		}
	}
	return problems;
}

interface TokenReport {
	readonly updated: string[];
	readonly designOnly: string[];
	readonly conflicts: string[];
	readonly missing: string[];
}

/**
 * Rewrites the token values in the top-level `:root` (dark) and `[data-theme="light"]` blocks.
 * Untouched tokens follow the app; tokens edited by hand are reported, never overwritten.
 */
function syncTokens(state: SyncState, report: TokenReport): void {
	const app: Record<string, Map<string, string>> = { dark: new Map(), light: new Map(), shared: new Map() };
	for (const theme of Object.keys(THEMES) as Theme[]) {
		const colors = themeColors(join(ROOT, THEMES[theme]));
		for (const [token, id] of Object.entries(COLOR_TOKENS)) {
			if (colors[id]) {
				app[theme].set(token, cssColor(colors[id]));
			} else if (theme === 'dark') {
				report.missing.push(`\`${token}\` (${id} is not set in the Klawly themes)`);
			}
		}
	}
	const sizes = claudeCssSizes();
	for (const [token, variable] of Object.entries(SIZE_TOKENS)) {
		const value = sizes.get(variable);
		if (value) {
			app.shared.set(token, value);
		} else {
			report.missing.push(`\`${token}\` (${variable} is not a px size in claude.css)`);
		}
	}

	const css = readFileSync(GLOBAL_CSS, 'utf8');
	const seen: Record<string, Set<string>> = { dark: new Set(), light: new Set() };
	const next = css.replace(/^(?<selector>:root|\[data-theme="light"\]) \{\r?\n(?<body>[\s\S]*?)^\}/gm, (block, selector: string, body: string) => {
		const theme: Theme = selector === ':root' ? 'dark' : 'light';
		const newBody = body.replace(/^(?<lead>\t(?<token>--k-[a-z0-9-]+):\s*)(?<value>[^;]+);/gm, (decl, lead: string, token: string, value: string) => {
			seen[theme].add(token);
			const scope = SIZE_TOKENS[token] ? 'shared' : theme;
			if (scope === 'shared' && theme === 'light') {
				return decl;
			}
			const appValue = app[scope].get(token);
			if (appValue === undefined) {
				return decl;
			}
			const baseline = state.tokens[scope]?.[token];
			const name = scope === 'shared' ? `\`${token}\`` : `\`${token}\` (${theme})`;
			if (sameValue(value, appValue)) {
				return decl;
			}
			if (baseline === undefined || sameValue(value, baseline)) {
				report.updated.push(`${name}: ${value.trim()} → ${appValue}`);
				return `${lead}${appValue};`;
			}
			if (sameValue(baseline, appValue)) {
				report.designOnly.push(`${name}: app ${appValue}, prototype ${value.trim()}`);
			} else {
				report.conflicts.push(`${name}: app changed ${baseline} → ${appValue}, prototype has ${value.trim()}`);
			}
			return decl;
		});
		return block.replace(body, () => newBody);
	});
	if (next !== css) {
		writeFileSync(GLOBAL_CSS, next);
	}
	for (const scope of Object.keys(app)) {
		state.tokens[scope] = Object.fromEntries([...app[scope]].sort());
	}
}

/** Copies the app's logo files into design/assets/, unless the prototype copy was changed by hand. */
function syncAssets(state: SyncState, report: TokenReport): void {
	const baselines = state.assets ?? {};
	for (const [asset, source] of Object.entries(ASSETS)) {
		const appHash = hashFile(join(ROOT, source));
		if (!appHash) {
			report.missing.push(`\`${asset}\` (${source} does not exist)`);
			continue;
		}
		const path = join(DESIGN, asset);
		const designHash = hashFile(path);
		const baseline = baselines[asset];
		if (designHash !== appHash) {
			if (designHash === undefined || baseline === undefined || designHash === baseline) {
				copyFileSync(join(ROOT, source), path);
				report.updated.push(`\`${asset}\` copied from ${source}`);
			} else if (baseline === appHash) {
				report.designOnly.push(`\`${asset}\`: changed in the prototype`);
			} else {
				report.conflicts.push(`\`${asset}\`: ${source} changed in the app and the prototype copy was changed too`);
				continue;
			}
		}
		baselines[asset] = appHash;
	}
	state.assets = baselines;
}

interface PageReport {
	readonly page: string;
	readonly changes: string[];
	readonly unchecked: string[];
	readonly unlabeled: string[];
}

/** Pages whose app files changed since they were last redrawn. New pages and new sources start current. */
function syncPages(state: SyncState, accept: Set<string> | 'all'): PageReport[] {
	const stale: PageReport[] = [];
	const firstClickRun = !state.clicks;
	const clickBaselines = state.clicks ??= {};
	for (const page of Object.keys(clickBaselines)) {
		if (!existsSync(join(DESIGN, page))) {
			delete clickBaselines[page];
		}
	}
	const pages = listPages(DESIGN);
	for (const page of Object.keys(state.pages)) {
		if (!pages.includes(page)) {
			delete state.pages[page];
		}
	}
	for (const page of pages) {
		const info = readPage(page);
		const accepted = accept === 'all' || accept.has(page);
		const baseline = state.pages[page] ?? {};
		const nextBaseline: Record<string, string> = {};
		const changes: string[] = [];
		for (const [src, labels] of [...info.sources].sort()) {
			const hash = hashFile(join(ROOT, src)) ?? 'missing';
			const where = labels.length ? ` (${labels.join(', ')})` : '';
			if (hash === 'missing') {
				changes.push(`\`${src}\` no longer exists${where}`);
			} else if (!accepted && baseline[src] && baseline[src] !== hash) {
				changes.push(`\`${src}\` changed${where}`);
				nextBaseline[src] = baseline[src];
				continue;
			}
			nextBaseline[src] = hash;
		}
		state.pages[page] = nextBaseline;

		const checked = clickBaselines[page] ?? {};
		const nextChecked: Record<string, string> = {};
		const unchecked: string[] = [];
		for (const [sig, verdict] of [...info.clicks].sort()) {
			if (accepted || firstClickRun) {
				nextChecked[sig] = verdict;
			} else if (checked[sig]) {
				nextChecked[sig] = checked[sig];
			} else {
				unchecked.push(sig);
			}
		}
		clickBaselines[page] = nextChecked;
		if (changes.length || unchecked.length || info.unlabeled.length) {
			stale.push({ page, changes, unchecked, unlabeled: info.unlabeled });
		}
	}
	return stale;
}

function renderStale(tokens: TokenReport, pages: PageReport[]): string {
	const lines = [
		'# Design prototype: what is out of date',
		'',
		'Written by `build/klawly/design-sync.ts` after every `npm run compile` (or `npm run design-sync`). Do not edit it by hand.',
		'',
		'## Pages to redraw',
		'',
	];
	const redraw = pages.filter(p => p.changes.length);
	if (redraw.length) {
		lines.push('The app files these pages mirror changed since the page was last drawn. Redraw what changed, re-check its clicks against the app, then run `npm run design-sync -- --accept <page>`.', '');
		for (const { page, changes } of redraw) {
			lines.push(`- [${page}](${page})`, ...changes.map(change => `  - ${change}`));
		}
	} else {
		lines.push('None. Every page matches the app files it mirrors.');
	}
	lines.push('', '## Clicks not checked against the app', '');
	const unchecked = pages.filter(p => p.unchecked.length);
	if (unchecked.length) {
		lines.push('These links and menu triggers are new or changed. Check what the same click does in the app: mark it `data-app="idea"` (not in the app) or `data-app="differs"` with a `data-app-note`, or leave it unmarked when the app does the same. Then accept the page.', '');
		for (const { page, unchecked: sigs } of unchecked) {
			lines.push(`- [${page}](${page})`, ...sigs.map(sig => `  - \`${sig}\``));
		}
	} else {
		lines.push('None. Every click is checked.');
	}
	lines.push('', '## Parts without an owner label', '');
	const unlabeled = pages.filter(p => p.unlabeled.length);
	if (unlabeled.length) {
		lines.push('Give each one `data-origin` (klawly, mixed or vscode), `data-label` and `data-source`.', '');
		for (const { page, unlabeled: problems } of unlabeled) {
			lines.push(`- [${page}](${page})`, ...problems.map(problem => `  - ${problem}`));
		}
	} else {
		lines.push('None. Every page and menu says who owns it.');
	}
	lines.push('', '## Tokens and assets changed in the prototype', '');
	if (tokens.designOnly.length || tokens.conflicts.length) {
		lines.push('These differ from the app on purpose (a design change) and are not overwritten.', '');
		lines.push(...tokens.designOnly.map(t => `- ${t}`));
		if (tokens.conflicts.length) {
			lines.push('', 'Changed in both the app and the prototype; decide which one wins:', '', ...tokens.conflicts.map(t => `- ${t}`));
		}
	} else {
		lines.push('None. Every synced token and asset holds the app value.');
	}
	if (tokens.missing.length) {
		lines.push('', '## Tokens and assets the sync could not read', '', ...tokens.missing.map(t => `- ${t}`));
	}
	return lines.join('\n') + '\n' + parityFrom(existsSync(STALE_MD) ? readFileSync(STALE_MD, 'utf8') : '');
}

/** The Parity section `design-parity.ts` writes at the end of STALE.md; the sync keeps it as it is. */
function parityFrom(stale: string): string {
	const text = stale.replace(/\r\n/g, '\n');
	const start = text.indexOf('\n## Parity\n');
	return start >= 0 ? text.slice(start) : '\n## Parity\n\nNot run yet. Run `npm run design-parity` (it launches the dev build).\n';
}

/** Writes only real changes, in the line endings the file already has, so a CRLF checkout stays clean. */
function writeIfChanged(path: string, text: string): void {
	const old = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
	if (old?.replace(/\r\n/g, '\n') === text) {
		return;
	}
	writeFileSync(path, old?.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text);
}


function main(): void {
	if (!existsSync(GLOBAL_CSS)) {
		return;
	}
	const args = process.argv.slice(2);
	const fileFlag = args.indexOf('--sync-file');
	const syncFile = fileFlag >= 0 ? resolve(args[fileFlag + 1]) : undefined;
	if (fileFlag >= 0) {
		args.splice(fileFlag, 2);
	}
	const accept: Set<string> | 'all' = args.includes('--accept-all') ? 'all' : new Set(args.filter(a => !a.startsWith('--')).map(a => a.replace(/\\/g, '/').replace(/^design\//, '')));
	if (!args.length && !syncFile && gitBusy(ROOT)) {
		return;
	}
	const state: SyncState = existsSync(syncFile ?? SYNC_JSON) ? JSON.parse(readFileSync(syncFile ?? SYNC_JSON, 'utf8')) : { tokens: {}, pages: {} };
	// The accept files are the only record of what each page was redrawn against. A sync.json left from
	// before them (an older rebase base) is never read for pages: its hashes are stale and made every page look changed (#1466).
	const accepts = syncFile ? undefined : readAccepts(ACCEPTS);
	state.pages = accepts?.pages ?? {};
	state.clicks = accepts?.clicks;
	if (!syncFile && !accepts) {
		console.warn('design-sync: design/.accepts is missing, so every page starts current. Restore it with `git checkout -- design/.accepts`.');
	}
	const tokens: TokenReport = { updated: [], designOnly: [], conflicts: [], missing: [] };
	syncTokens(state, tokens);
	syncAssets(state, tokens);
	const pages = syncPages(state, accept);
	// --check (CI, #1567): report only. The accept files, sync.json and STALE.md stay as they are.
	const check = args.includes('--check');
	if (!syncFile && !check) {
		writeAccepts(state, ACCEPTS);
	}
	if (!check) {
		writeIfChanged(syncFile ?? SYNC_JSON, JSON.stringify({ tokens: state.tokens, assets: state.assets }, undefined, '\t') + '\n');
	}
	if (!syncFile && !check) {
		writeIfChanged(STALE_MD, renderStale(tokens, pages));
	}
	for (const update of tokens.updated) {
		console.log(`design-sync: ${update}`);
	}
	const redraw = pages.filter(p => p.changes.length).length;
	const unchecked = pages.reduce((n, p) => n + p.unchecked.length, 0);
	const unlabeled = pages.reduce((n, p) => n + p.unlabeled.length, 0);
	console.log(`design-sync: ${tokens.updated.length} token(s) or asset(s) updated, ${redraw} page(s) to redraw, ${unchecked} click(s) to check, ${unlabeled} part(s) without an owner, ${tokens.designOnly.length + tokens.conflicts.length} changed in the prototype. See design/STALE.md.`);
	if (check) {
		const stale = pages.filter(p => p.changes.length || p.unchecked.length);
		for (const p of stale) {
			console.log(`::error file=design/${p.page}::stale: ${[...p.changes, ...p.unchecked.map(c => `click ${c}`)].join('; ').slice(0, 300)}`);
		}
		if (stale.length) {
			console.error(`design-sync --check: ${stale.length} page(s) are stale. Redraw them, then run \`npm run design-sync -- --accept <page>\` (or --accept-all) and commit design/.accepts (rule 36).`);
			process.exitCode = 1;
		}
	}
}

try {
	main();
} catch (error) {
	console.warn(`design-sync: skipped (${error instanceof Error ? error.message : String(error)})`);
}
