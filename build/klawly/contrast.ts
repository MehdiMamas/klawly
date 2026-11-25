/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks WCAG contrast from the theme tokens, not from pixels (issue 584).
// Usage: node build/klawly/contrast.ts [--theme dark|light] [--markdown]
//
// Reads Klawly Dark and Light (with the themes they include) and the way claude.css mixes its
// tokens from them (cards, states, fills, mode tints), composites every translucent color over the
// surface it sits on, and checks text against 4.5:1 and the non-text edges of fields, controls and
// focus rings against 3:1 (WCAG 2.2, 1.4.3 and 1.4.11). Disabled text is listed but exempt.
// Exit code 1 when a checked pair is below its bar. Extending: add a pair to PAIRS.

import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '../..');
const THEMES = {
	dark: join(ROOT, 'extensions/theme-klawly/themes/klawly-dark.json'),
	light: join(ROOT, 'extensions/theme-klawly/themes/klawly-light.json'),
};

type ThemeName = keyof typeof THEMES;

interface Rgba {
	readonly r: number;
	readonly g: number;
	readonly b: number;
	readonly a: number;
}

/**
 * A color: a theme key, `mix:<key>:<percent>` (claude.css's `color-mix(in srgb, <key> <percent>%, transparent)`),
 * or `#rrggbb[aa]`.
 */
type Ref = string;

interface Pair {
	readonly name: string;
	readonly fg: Ref;
	/** The surfaces under the foreground, bottom first; translucent ones are composited in order. */
	readonly bg: readonly Ref[];
	readonly kind: 'text' | 'edge' | 'exempt';
}

/** claude.css tokens in theme keys; the state steps differ in light themes (DL-15). */
function tokens(theme: ThemeName): Record<string, Ref> {
	const light = theme === 'light';
	return {
		'fg': 'foreground',
		'fg-strong': 'editor.foreground',
		'fg-muted': 'descriptionForeground',
		'fg-faint': 'disabledForeground',
		'bg-editor': 'editor.background',
		'bg-input': 'input.background',
		'bg-elevated': 'menu.background',
		// --claude-bg-card: color-mix(in srgb, fg-strong 4%, bg-editor), the same as 4% ink over the editor.
		'card': 'mix:editor.foreground:4',
		'state-hover': `mix:editor.foreground:${light ? 5 : 6}`,
		'state-selected': `mix:editor.foreground:${light ? 10 : 12}`,
		'fill-2': 'mix:editor.foreground:14',
		'mode-plan': 'mix:claude.mode.plan:24',
		'mode-ask': 'mix:claude.mode.ask:24',
		'field-edge': 'input.border',
		'focus': 'focusBorder',
	};
}

const SURFACES: readonly (readonly Ref[])[] = [['bg-editor'], ['bg-editor', 'card'], ['sideBar.background'], ['bg-elevated'], ['bg-input']];

function pairs(): Pair[] {
	const list: Pair[] = [];
	const on = (name: string, fg: Ref, kind: Pair['kind'], surfaces: readonly (readonly Ref[])[] = SURFACES) => {
		for (const bg of surfaces) {
			list.push({ name: `${name} on ${bg.join(' + ')}`, fg, bg, kind });
		}
	};
	// Text roles (DL-16): body, chat and code, secondary and meta, disabled.
	on('body text (fg)', 'fg', 'text');
	on('chat and code text (fg-strong)', 'fg-strong', 'text');
	on('secondary and meta text (fg-muted)', 'fg-muted', 'text');
	on('disabled text (fg-faint)', 'fg-faint', 'exempt');
	on('link', 'textLink.foreground', 'text', [['bg-editor'], ['bg-editor', 'card'], ['sideBar.background']]);
	on('placeholder', 'input.placeholderForeground', 'exempt', [['bg-input']]);
	on('input text', 'input.foreground', 'text', [['bg-input']]);
	on('error text', 'errorForeground', 'text', [['bg-editor'], ['bg-editor', 'card']]);
	on('warning text', 'editorWarning.foreground', 'text', [['bg-editor'], ['bg-editor', 'card']]);
	on('success text', 'testing.iconPassed', 'text', [['bg-editor'], ['bg-editor', 'card']]);
	on('added file name', 'gitDecoration.addedResourceForeground', 'text', [['sideBar.background']]);
	on('deleted file name', 'gitDecoration.deletedResourceForeground', 'text', [['sideBar.background']]);
	on('modified file name', 'gitDecoration.modifiedResourceForeground', 'text', [['sideBar.background']]);
	// Rows and controls with their own fills.
	on('hovered row text', 'fg', 'text', [['sideBar.background', 'list.hoverBackground'], ['bg-editor', 'state-hover']]);
	on('selected row text', 'list.activeSelectionForeground', 'text', [['sideBar.background', 'list.activeSelectionBackground'], ['bg-editor', 'state-selected']]);
	on('inactive selection text', 'fg', 'text', [['sideBar.background', 'list.inactiveSelectionBackground']]);
	on('primary button text', 'button.foreground', 'text', [['button.background']]);
	on('secondary button text', 'button.secondaryForeground', 'text', [['bg-editor', 'button.secondaryBackground'], ['bg-editor', 'card', 'button.secondaryBackground']]);
	on('menu text', 'menu.foreground', 'text', [['menu.background']]);
	on('menu selected text', 'menu.selectionForeground', 'text', [['menu.background', 'menu.selectionBackground']]);
	on('quick input text', 'quickInput.foreground', 'text', [['quickInput.background']]);
	on('mode pill text (Plan)', 'fg-strong', 'text', [['bg-input', 'mode-plan']]);
	on('mode pill text (Ask)', 'fg-strong', 'text', [['bg-input', 'mode-ask']]);
	on('mode pill text (Agent)', 'fg-strong', 'text', [['bg-input', 'fill-2']]);
	on('on switch and selected chip ink (mark-fg on mark)', 'bg-editor', 'text', [['fg-strong']]);
	on('status bar text', 'statusBar.foreground', 'text', [['statusBar.background']]);
	on('title bar text', 'titleBar.activeForeground', 'text', [['titleBar.activeBackground']]);
	on('active tab text', 'tab.activeForeground', 'text', [['tab.activeBackground']]);
	on('inactive tab text', 'tab.inactiveForeground', 'text', [['tab.inactiveBackground']]);
	on('side bar header', 'sideBarSectionHeader.foreground', 'text', [['sideBar.background', 'sideBarSectionHeader.background']]);
	on('badge text', 'badge.foreground', 'text', [['activityBar.background', 'badge.background'], ['sideBar.background', 'badge.background']]);
	on('keybinding label', 'keybindingLabel.foreground', 'text', [['bg-editor', 'keybindingLabel.background'], ['bg-elevated', 'keybindingLabel.background']]);
	on('notification text', 'notifications.foreground', 'text', [['notifications.background']]);
	// Non-text (1.4.11): field edges against the surface around them, focus rings, control boundaries and state icons.
	on('field edge (input.border)', 'field-edge', 'edge', [['bg-editor'], ['bg-editor', 'card'], ['sideBar.background'], ['bg-elevated']]);
	on('dropdown edge', 'dropdown.border', 'edge', [['bg-editor'], ['sideBar.background']]);
	on('checkbox edge', 'checkbox.border', 'edge', [['bg-editor', 'checkbox.background'], ['sideBar.background', 'checkbox.background']]);
	// Buttons draw their ring outside (offset 1 to 2px), on the surface; the split button draws it inside, in the fill's ink.
	on('focus ring', 'focus', 'edge', [...SURFACES, ['statusBar.background'], ['titleBar.activeBackground'], ['sideBar.background', 'list.activeSelectionBackground']]);
	on('focus ring inside the split button (accent-fg)', 'button.foreground', 'edge', [['button.background']]);
	on('list focus outline', 'list.focusOutline', 'edge', [['sideBar.background'], ['sideBar.background', 'list.hoverBackground']]);
	on('list focus and selection outline', 'list.focusAndSelectionOutline', 'edge', [['sideBar.background', 'list.activeSelectionBackground']]);
	on('active tab marker (tab.activeBorderTop)', 'tab.activeBorderTop', 'edge', [['tab.activeBackground']]);
	on('activity bar icon (inactive)', 'activityBar.inactiveForeground', 'edge', [['activityBar.background']]);
	on('icon', 'icon.foreground', 'edge', [['bg-editor'], ['sideBar.background'], ['bg-elevated']]);
	on('on switch (mark)', 'fg-strong', 'edge', [['bg-editor'], ['bg-editor', 'card'], ['bg-elevated']]);
	on('mode tint, Plan', 'claude.mode.plan', 'edge', [['bg-editor'], ['bg-input']]);
	on('mode tint, Ask', 'claude.mode.ask', 'edge', [['bg-editor'], ['bg-input']]);
	on('mode tint, Accept Edits', 'claude.mode.acceptEdits', 'edge', [['bg-editor'], ['bg-input']]);
	return list;
}

/** Reads a theme and the themes it includes, the included ones first. */
function readColors(file: string): Record<string, string> {
	// The default themes are JSON with comments and trailing commas.
	const text = readFileSync(file, 'utf8').replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, string) => string ?? '').replace(/,(\s*[}\]])/g, '$1');
	const theme = JSON.parse(text) as { include?: string; colors?: Record<string, string> };
	return { ...(theme.include ? readColors(join(dirname(file), theme.include)) : {}), ...theme.colors };
}

function parseHex(hex: string): Rgba {
	const value = hex.replace('#', '');
	const full = value.length <= 4 ? [...value].map(c => c + c).join('') : value;
	return {
		r: parseInt(full.slice(0, 2), 16),
		g: parseInt(full.slice(2, 4), 16),
		b: parseInt(full.slice(4, 6), 16),
		a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
	};
}

function over(top: Rgba, bottom: Rgba): Rgba {
	const mix = (t: number, b: number) => t * top.a + b * (1 - top.a);
	return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

function luminance(c: Rgba): number {
	const channel = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

function ratio(a: Rgba, b: Rgba): number {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (light + 0.05) / (dark + 0.05);
}

function hex(c: Rgba): string {
	return '#' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}

interface Result {
	readonly theme: ThemeName;
	readonly pair: Pair;
	readonly ratio?: number;
	readonly fg?: string;
	readonly bg?: string;
	readonly missing?: string;
}

function check(theme: ThemeName): Result[] {
	const colors = readColors(THEMES[theme]);
	const names = tokens(theme);
	const color = (ref: Ref): Rgba | string => {
		const key = names[ref] ?? ref;
		if (key.startsWith('#')) {
			return parseHex(key);
		}
		const mix = /^mix:(?<key>[^:]+):(?<percent>\d+)$/.exec(key)?.groups;
		if (mix) {
			const base = color(mix.key);
			return typeof base === 'string' ? base : { ...base, a: base.a * Number(mix.percent) / 100 };
		}
		if (names[key]) {
			return color(names[key]);
		}
		return colors[key] ? parseHex(colors[key]) : key;
	};
	return pairs().map(pair => {
		const layers = [...pair.bg, pair.fg].map(color);
		const missing = layers.find(l => typeof l === 'string');
		if (typeof missing === 'string') {
			return { theme, pair, missing };
		}
		const [first, ...rest] = layers as Rgba[];
		const fg = rest.pop()!;
		// The bottom surface is opaque; a translucent first layer sits on the editor.
		let bg = first.a < 1 ? over(first, color('bg-editor') as Rgba) : first;
		for (const layer of rest) {
			bg = over(layer, bg);
		}
		const solid = over(fg, bg);
		return { theme, pair, ratio: ratio(solid, bg), fg: hex(solid), bg: hex(bg) };
	});
}

function bar(pair: Pair): number {
	return pair.kind === 'text' ? 4.5 : pair.kind === 'edge' ? 3 : 0;
}

function main(): number {
	const argv = process.argv.slice(2);
	const index = argv.indexOf('--theme');
	const only = index >= 0 ? argv[index + 1] : undefined;
	const themes = (Object.keys(THEMES) as ThemeName[]).filter(t => !only || t === only);
	const results = themes.flatMap(check);
	const failing = results.filter(r => r.ratio !== undefined && r.ratio < bar(r.pair));
	const lines = argv.includes('--markdown')
		? ['| Theme | Pair | Kind | Ratio | Bar | Result | Colors |', '|---|---|---|---|---|---|---|', ...results.map(r => `| ${r.theme} | ${r.pair.name} | ${r.pair.kind} | ${r.ratio?.toFixed(2) ?? '-'} | ${bar(r.pair) || '-'} | ${r.missing ? `not in the theme: ${r.missing}` : r.ratio! >= bar(r.pair) ? 'pass' : '**FAIL**'} | ${r.fg ?? ''} on ${r.bg ?? ''} |`)]
		: results.map(r => `${r.theme.padEnd(6)} ${(r.missing ? 'n/a ' : r.ratio! >= bar(r.pair) ? 'pass' : 'FAIL').padEnd(5)} ${(r.ratio?.toFixed(2) ?? '-').padStart(6)} / ${bar(r.pair) || '-'}  ${r.pair.name}${r.missing ? ` (not in the theme: ${r.missing})` : ` (${r.fg} on ${r.bg})`}`);
	console.log(lines.join('\n'));
	console.log(`\ncontrast: ${results.length} pair(s), ${failing.length} below the bar, ${results.filter(r => r.missing).length} not in the theme.`);
	return failing.length ? 1 : 0;
}

process.exitCode = main();
