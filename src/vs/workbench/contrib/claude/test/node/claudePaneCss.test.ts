/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Claude pane CSS', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('shell styles use theme variables', () => {
		const cssPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../src/vs/workbench/contrib/claude/browser/media/claude.css');
		const css = readFileSync(cssPath, 'utf8');
		assert.match(css, /\.claude-pane-header/);
		assert.match(css, /\.claude-title-header > \.claude-pane-header\s*\{[^}]*height:\s*100%;/);
		// In an editor tab the tab row is the header; group chevrons always show (issue 142).
		assert.match(css, /\.claude-agent-editor \.claude-pane-header:empty\s*\{\s*display:\s*none;/);
		assert.doesNotMatch(css, /\.claude-agents-chevron\s*\{[^}]*visibility:\s*hidden/);
		assert.match(css, /\.claude-timeline/);
		assert.match(css, /\.claude-composer/);
		assert.match(css, /\.claude-chip/);
		assert.match(css, /\.claude-menu/);
		assert.match(css, /\.claude-history-menu\b/);
		assert.match(css, /\.claude-session-row\b/);
		assert.match(css, /\.claude-banner\b/);
		assert.match(css, /\.claude-pane \[hidden\]\s*\{\s*display:\s*none !important;/);
		assert.match(css, /\.claude-bg-agent\b/);
		assert.match(css, /\.claude-background-list\b/);
		assert.strictEqual(css.includes('data-theme'), false);
		assert.match(css, /\.claude-terminal\s*\{[^}]*white-space:\s*pre;/);
		assert.strictEqual(/\.claude-terminal\s*\{[^}]*white-space:\s*pre-wrap/.test(css), false);

		let stripped = css;
		while (stripped.includes('var(')) {
			const next = stripped.replace(/var\((?:[^()]|\([^()]*\))*\)/g, '');
			assert.notStrictEqual(next, stripped);
			stripped = next;
		}
		assert.strictEqual(/#[0-9a-fA-F]{3,8}\b/.test(stripped), false, stripped);
		assert.strictEqual(/\brgba?\(/.test(stripped), false, stripped);
		assert.strictEqual(/\bhsla?\(/.test(stripped), false, stripped);
	});

	test('animations stop under reduced motion; focus, contrast and setup styles exist', () => {
		const cssPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../src/vs/workbench/contrib/claude/browser/media/claude.css');
		const css = readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
		const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
		const reducedBlock = reduced.slice(0, reduced.indexOf('\n}\n') + 2);
		const animated = [...css.matchAll(/([^{}]+)\{[^}]*\banimation:(?!\s*none\b)[^;]+;/g)].flatMap(match => match[1].split(',').map(selector => selector.trim()));
		assert.ok(animated.length > 0);
		for (const selector of animated) {
			assert.ok(reducedBlock.includes(selector), `${selector} keeps animating under reduced motion`);
		}
		// Upstream spins only some glyphs with the spin modifier, so the pane spins its own, the compact one included (#92).
		const spinning = [...css.matchAll(/([^{}]+)\{[^}]*\banimation:\s*codicon-spin\b[^}]*\}/g)].flatMap(match => match[1].split(',').map(selector => selector.trim()));
		assert.deepStrictEqual(spinning, ['.claude-root .codicon-modifier-spin', '.claude-pane .codicon-modifier-spin']);
		const settingRule = css.slice(css.indexOf('.monaco-workbench.monaco-reduce-motion .claude-popover > .claude-menu'));
		for (const selector of ['.claude-root .codicon-modifier-spin', '.claude-pane .codicon-modifier-spin', '.statusbar-item[id="claude.status"] .codicon-modifier-spin']) {
			assert.ok(reducedBlock.includes(selector), selector);
			assert.ok(settingRule.slice(0, settingRule.indexOf('}')).includes(`.monaco-workbench.monaco-reduce-motion ${selector}`), selector);
		}
		for (const required of ['.claude-btn:focus-visible', '.claude-tool-row:focus-visible', '.claude-sr-only', '.monaco-workbench.hc-black .claude-pane', '--vscode-contrastBorder', '.claude-setup', '.claude-step', '.claude-setup-host']) {
			assert.ok(css.includes(required), required);
		}
	});

	test('workbench.reduceMotion stops everything the OS reduced-motion setting stops (issue 787)', () => {
		const media = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../src/vs/workbench/contrib/claude/browser/media');
		const declarationsOf = (text: string) => text.split(';').map(declaration => declaration.trim().replace(/\s+/g, ' ')).filter(Boolean);
		const rulesOf = (text: string) => [...text.matchAll(/(?<selectors>[^{}]+)\{(?<declarations>[^{}]*)\}/g)].map(match => ({ selectors: match.groups!.selectors.split(',').map(selector => selector.trim()), declarations: declarationsOf(match.groups!.declarations) }));
		const missing: string[] = [];
		let mirrored = 0;
		for (const file of readdirSync(media).filter(name => name.endsWith('.css'))) {
			const css = readFileSync(join(media, file), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
			const rules = rulesOf(css);
			for (let start = css.indexOf('@media (prefers-reduced-motion: reduce)'); start !== -1; start = css.indexOf('@media (prefers-reduced-motion: reduce)', start + 1)) {
				const open = css.indexOf('{', start);
				let end = open + 1;
				for (let depth = 1; depth > 0; end++) {
					depth += css[end] === '{' ? 1 : css[end] === '}' ? -1 : 0;
				}
				for (const rule of rulesOf(css.slice(open + 1, end - 1))) {
					for (const selector of rule.selectors) {
						const twin = `.monaco-workbench.monaco-reduce-motion ${selector}`;
						mirrored++;
						if (!rules.some(candidate => candidate.selectors.includes(twin) && rule.declarations.every(declaration => candidate.declarations.includes(declaration)))) {
							missing.push(`${file}: ${twin} { ${rule.declarations.join('; ')} }`);
						}
					}
				}
			}
		}
		assert.ok(mirrored > 0);
		assert.deepStrictEqual(missing, []);
	});

	test('the Phase 27 permission styles use theme variables and keep focus and contrast styles', () => {
		const cssPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../src/vs/workbench/contrib/claude/browser/media/claudePermissions.css');
		const css = readFileSync(cssPath, 'utf8');
		for (const required of ['.claude-permission-why', '.claude-permission-level:focus-visible', '.claude-session-switch.is-everything', '.claude-session-switch:focus-visible', '.claude-mode-menu', '.claude-permission-auto', '--vscode-contrastBorder', 'var(--claude-warning)']) {
			assert.ok(css.includes(required), required);
		}
		let stripped = css;
		while (stripped.includes('var(')) {
			const next = stripped.replace(/var\((?:[^()]|\([^()]*\))*\)/g, '');
			assert.notStrictEqual(next, stripped);
			stripped = next;
		}
		assert.strictEqual(/#[0-9a-fA-F]{3,8}\b/.test(stripped), false, stripped);
		assert.strictEqual(/\b(rgba?|hsla?)\(/.test(stripped), false, stripped);
		assert.strictEqual(/\banimation:/.test(css), false);
	});

	test('the permission card keeps its amber edge on focus and has 24px buttons', () => {
		const media = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../src/vs/workbench/contrib/claude/browser/media');
		const css = ['claude.css', 'claudePermissions.css'].map(file => readFileSync(join(media, file), 'utf8').replace(/\r\n/g, '\n')).join('\n');
		assert.deepStrictEqual({
			focusBorder: /\.claude-permission:focus-within\s*\{[^}]*border-color/.test(css),
			buttonHeight: /\n\.claude-permission-actions \.claude-btn \{\s*height: 24px;/.test(css),
		}, { focusBorder: false, buttonHeight: true });
	});

	test('timeline cards follow the radius, icon and weight ramps, theme their scrollbar and separate code in light themes', () => {
		const cssPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../src/vs/workbench/contrib/claude/browser/media/claude.css');
		const source = readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n');
		const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
		// Every declaration block whose selector is exactly `selector`.
		const rules = (selector: string) => css.split(`\n${selector} {`).slice(1).map(rest => rest.slice(0, rest.indexOf('\n}'))).join('\n');
		// DL-03: one radius ramp for every Klawly surface, from the workbench sizes; the timeline does not redefine it.
		const ramp = rules('.monaco-workbench,\n.claude-pane,\n.claude-root');
		const radius = (size: string) => ramp.split(`--claude-radius-${size}:`)[1]?.split(';')[0].trim();
		const phase28 = (source.split('Timeline parts and cards (Phase 28)')[1] ?? '').split('Phase 29: composer and pane chrome')[0];
		assert.deepStrictEqual({
			radii: ['xs', 'sm', 'md', 'lg', 'xl', '2xl'].map(radius),
			localRadii: (css.match(/--claude-radius-[a-z0-9]+:/g) ?? []).length,
			icon: /font-size:\s*var\(--vscode-codiconFontSize-compact, 12px\)/.test(rules('.claude-timeline .codicon')),
			heavyWeight: /font-weight:\s*500/.test(phase28),
			scrollbar: /scrollbar-color:\s*var\(--vscode-scrollbarSlider-background\b/.test(rules('.claude-terminal')),
			lightCode: /--claude-bg-code:/.test(rules('.monaco-workbench.vs .claude-timeline')),
		}, {
			radii: ['var(--vscode-cornerRadius-small, 4px)', 'var(--vscode-cornerRadius-medium, 6px)', 'var(--vscode-cornerRadius-large, 8px)', 'var(--vscode-cornerRadius-xLarge, 12px)', '14px', '18px'],
			localRadii: 7,
			icon: true,
			heavyWeight: false,
			scrollbar: true,
			lightCode: true,
		});
	});

	test('the Phase 32 tokens follow the measured scales and the shared controls exist', () => {
		const cssPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../src/vs/workbench/contrib/claude/browser/media/claude.css');
		const css = readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
		const root = css.slice(css.indexOf('.claude-root,\n.claude-pane {'), css.indexOf('\n}\n', css.indexOf('.claude-root,\n.claude-pane {')));
		const shared = css.split('\n.monaco-workbench,\n.claude-pane,\n.claude-root {').slice(1).map(rest => rest.slice(0, rest.indexOf('\n}'))).join('\n');
		const token = (name: string) => (root.split(`--claude-${name}:`)[1] ?? shared.split(`--claude-${name}:`)[1])?.split(';')[0].trim();
		const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
		assert.deepStrictEqual({
			space: [1, 2, 3, 4, 5, 6, 7, 8].map(step => token(`space-${step}`)),
			rows: ['row-compact', 'row-tree', 'row-menu', 'row-h', 'row-tall'].map(token),
			text: ['text-2xs', 'text-xs', 'text-sm', 'text-md', 'text-chat', 'text-xl', 'text-2xl', 'leading-tight', 'leading', 'leading-chat'].map(token),
			widths: ['menu-w', 'menu-w-wide', 'submenu-min', 'hover-w'].map(token),
			motion: ['dur-press', 'dur-fast', 'dur', 'dur-slow', 'ease-out', 'ease-in-out'].map(token),
			fills: [1, 2, 3, 4, 5].map(step => /^color-mix\(in srgb, var\(--claude-fg-strong\) \d+%, transparent\)$/.test(token(`fill-${step}`) ?? '')),
			modes: ['mode-plan-solid', 'mode-ask-solid'].map(token),
			reducedMotion: ['--claude-dur-press: 0ms', '--claude-dur-slow: 0ms', '.claude-popover > .claude-menu'].map(part => reduced.slice(0, reduced.indexOf('\n}\n')).includes(part)),
			reduceMotionClass: css.includes('.monaco-workbench.monaco-reduce-motion .claude-root'),
			controls: ['.claude-switch {', '.claude-switch.is-on::after {', '.claude-split {', '.claude-split.is-compact {', '.claude-btn.is-ghost:hover:not(:disabled)', '.claude-badge.is-tag {', '.claude-kbd.is-quiet kbd', '.monaco-workbench.hc-black .claude-switch'].map(part => css.includes(part)),
			keyChip: /\.claude-kbd kbd \{[^}]*height: 18px;[^}]*var\(--vscode-keybindingLabel-background\b/.test(css),
			menuRow: /\n\.claude-menu-item \{[^}]*height: var\(--claude-row-menu\);[^}]*border-radius: var\(--claude-radius-md\);/.test(css),
			// A long detail ellipsizes inside the row instead of running past the menu edge.
			menuText: ['label', 'detail'].map(part => new RegExp(`\\n\\.claude-menu-item \\.${part} \\{[^}]*min-width: 0;[^}]*text-overflow: ellipsis;`).test(css)),
			oldTokens: ['--claude-shadow-menu', '--claude-shadow-card', 'var(--claude-ease)'].map(part => css.includes(part)),
		}, {
			space: ['2px', '4px', '6px', '8px', '12px', '16px', '24px', '32px'],
			rows: ['22px', '22px', '24px', '28px', '42px'],
			text: ['10px', '11px', '12px', '13px', '14px', '17px', '22px', '16px', '18px', '22px'],
			widths: ['240px', '320px', '200px', '240px'],
			motion: ['50ms', '100ms', '150ms', '200ms', 'cubic-bezier(0.16, 1, 0.3, 1)', 'cubic-bezier(0.77, 0, 0.175, 1)'],
			fills: [true, true, true, true, true],
			modes: ['var(--vscode-claude-mode-plan, #dd8f52)', 'var(--vscode-claude-mode-ask, #7cba92)'],
			reducedMotion: [true, true, true],
			reduceMotionClass: true,
			controls: [true, true, true, true, true, true, true, true],
			keyChip: true,
			menuRow: true,
			menuText: [true, true],
			oldTokens: [false, false, false],
		});
	});

	test('the pinned prompt is flush with the pane top and its hover toolbar sits off the text (#134)', () => {
		const cssPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../src/vs/workbench/contrib/claude/browser/media/claude.css');
		const css = readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
		const rule = (selector: string) => {
			const start = css.indexOf(`\n${selector} {`);
			return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
		};
		const sticky = rule('.claude-part[data-part="user"]');
		const bubble = rule('.claude-msg-user');
		const toolbar = rule('.claude-msg-toolbar');
		assert.deepStrictEqual({
			sticky: /position: sticky;/.test(sticky) && /top: 0;/.test(sticky),
			stickyOffsets: /margin-top|padding-top/.test(sticky),
			opaque: /background: var\(--vscode-sideBar-background/.test(sticky) && /box-shadow:/.test(sticky),
			bubble: [/padding: var\(--claude-space-4\) 10px;/, /border: 1px solid var\(--claude-border\);/, /box-shadow: inset 0 0 0 100vmax var\(--claude-fill-4\);/].map(pattern => pattern.test(bubble)),
			toolbar: [/top: 100%;/, /border-top: none;/].map(pattern => pattern.test(toolbar)),
			sentOpenRow: /\n\.claude-msg-user\.is-sent-open \.claude-msg-toolbar \{[^}]*position: static;/.test(css),
		}, {
			sticky: true,
			stickyOffsets: false,
			opaque: true,
			bubble: [true, false, true],
			toolbar: [true, false],
			sentOpenRow: true,
		});
	});

	test('the inline and terminal submit arrow takes the button color, not the workbench icon color (#125)', () => {
		const cssPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../src/vs/workbench/contrib/claude/browser/media/claude.css');
		const css = readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
		const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split('}')[0] ?? '';
		assert.deepStrictEqual({
			circle: /background: var\(--claude-fg-strong\);/.test(rule('.claude-inline-submit')),
			arrow: /color: var\(--vscode-editor-background\);/.test(rule('.claude-inline-submit')),
			icon: /color: inherit;/.test(rule('.claude-inline .claude-inline-submit .codicon')),
		}, { circle: true, arrow: true, icon: true });
	});

	test('issue 531: the composer Send arrow is opaque in every theme, and disabled dims the circle, not the arrow', () => {
		const cssPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../src/vs/workbench/contrib/claude/browser/media/claude.css');
		const css = readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
		const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split('}')[0] ?? '';
		assert.deepStrictEqual({
			arrow: /color: var\(--claude-send-fg\);/.test(rule('.claude-send')),
			icon: /color: inherit;/.test(rule('.claude-composer-toolbar .claude-send .codicon')),
			disabledFill: /background: var\(--claude-fill-1\);/.test(rule('.claude-send:disabled')),
			disabledArrow: /color: var\(--claude-fg-muted\);/.test(rule('.claude-send:disabled')),
			fadesButton: /opacity/.test(rule('.claude-send:disabled')),
			translucentArrow: /\.claude-send[^{]*\{[^}]*\scolor: var\(--claude-bg-input\)/.test(css),
		}, { arrow: true, icon: true, disabledFill: true, disabledArrow: true, fadesButton: false, translucentArrow: false });
	});

	test('issue 531: composer pills clip at their edge and the model effort truncates instead of drawing over Run In', () => {
		const cssPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../src/vs/workbench/contrib/claude/browser/media/claude.css');
		const css = readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
		const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split('}')[0] ?? '';
		assert.deepStrictEqual({
			pillClips: /overflow: hidden;/.test(rule('.claude-composer-toolbar > .claude-pill')),
			effortTruncates: /min-width: 0;[^}]*text-overflow: ellipsis;/.test(rule('.claude-model-pill .qualifier')),
			effortFixed: /flex: none;/.test(rule('.claude-model-pill .qualifier')),
			runInShrinks: rule('.claude-composer-toolbar > .claude-run-in-pill') !== '',
			busyRunInIcon: /@container claude-composer \(max-width: 600px\) \{\s*\.claude-composer-toolbar:has\(> \.claude-send-group:not\(\[hidden\]\)\) > \.claude-run-in-pill \.label \{\s*display: none;/.test(css),
			// Issue 793: at 420px the mode pill keeps only its icon before the model's name runs out of room (DL-52).
			modePillIcon: /@container claude-composer \(max-width: 420px\) \{[^@]*\.claude-composer-toolbar > \.claude-mode-pill > \.label \{\s*display: none;/.test(css),
			// Then, below 360px, the effort qualifier and the mode pill's chevron go so the model's name keeps the room.
			qualifierHidden: /@container claude-composer \(max-width: 360px\) \{\s*\.claude-composer-toolbar > \.claude-model-pill \.qualifier,\s*\.claude-composer-toolbar > \.claude-mode-pill > \.codicon-chevron-down \{\s*display: none;/.test(css),
		}, { pillClips: true, effortTruncates: true, effortFixed: false, runInShrinks: false, busyRunInIcon: true, modePillIcon: true, qualifierHidden: true });
	});

	test('the Klawly themes include the stock syntax themes, use the Klawly accent and set the mode colors', () => {
		const themes = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../extensions/theme-klawly');
		const manifest = JSON.parse(readFileSync(join(themes, 'package.json'), 'utf8'));
		const read = (file: string) => {
			const theme = JSON.parse(readFileSync(join(themes, file), 'utf8'));
			const colors = theme.colors as Record<string, string>;
			return {
				name: theme.name,
				type: theme.type,
				includeExists: (() => { try { readFileSync(join(themes, dirname(file), theme.include)); return true; } catch { return false; } })(),
				accent: [colors['button.background'], colors.focusBorder, colors['progressBar.background']],
				modes: ['plan', 'agent', 'ask', 'debug', 'multitask'].map(mode => colors[`claude.mode.${mode}`]),
				noCoral: Object.values(colors).every(value => !/^#(d97757|cc785c|da7756)/i.test(value)),
				matches: [colors['list.focusHighlightForeground'], colors['quickInputList.focusHighlightForeground']],
			};
		};
		assert.deepStrictEqual({
			themes: manifest.contributes.themes.map((theme: { id: string; uiTheme: string; path: string }) => [theme.id, theme.uiTheme, theme.path]),
			dark: read('themes/klawly-dark.json'),
			light: read('themes/klawly-light.json'),
		}, {
			themes: [['Klawly Dark', 'vs-dark', './themes/klawly-dark.json'], ['Klawly Light', 'vs', './themes/klawly-light.json']],
			dark: { name: 'Klawly Dark', type: 'dark', includeExists: true, accent: ['#dd8f52', '#93a0f0', '#dd8f52'], modes: ['#dd8f52', '#a3a3a3', '#7cba92', '#ec7a8b', '#a891e6'], noCoral: true, matches: ['#93a0f0', '#93a0f0'] },
			light: { name: 'Klawly Light', type: 'light', includeExists: true, accent: ['#dd8f52', '#4d5bc9', '#dd8f52'], modes: ['#9e5522', '#5c5c5c', '#2a754c', '#b4283d', '#6b52c0'], noCoral: true, matches: ['#4d5bc9', '#4d5bc9'] },
		});
	});

	test('the inline edit card is at most 500px wide, with no older width left on the base rule', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claude.css'), 'utf8');
		assert.deepStrictEqual({
			zone: /\n\.claude-inline-zone > \.claude-inline \{\s*width: min\(500px, calc\(100% - var\(--claude-space-5\)\)\);/.test(css),
			baseWidth: /\n\.claude-inline \{[^}]*\swidth:/.test(css),
		}, { zone: true, baseWidth: false });
	});

	test('the title bar shows the bare Klawly mark, not the app icon', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claude.css'), 'utf8');
		assert.match(css, /\.part\.titlebar > \.titlebar-container > \.titlebar-left > \.window-appicon:not\(\.codicon\) \{\s*background-image: url\('\.\/klawly-mark\.svg'\);/);
	});

	test('the chrome restyle leaves high contrast stock, uses theme variables, gives the quick input 24px rows and drops the "+" between keycaps', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claudeChrome.css'), 'utf8');
		const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(rule => rule.trim()).filter(Boolean);
		const selectors = rules.flatMap(rule => rule.split('{')[0].split(',').map(selector => selector.trim()));
		assert.deepStrictEqual({
			scoped: selectors.every(selector => selector.startsWith('.monaco-workbench:not(.hc-black):not(.hc-light) ')),
			literalColors: /#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?)\(/.test(rules.join('}')),
			quickInput: ['.quick-input-header', '.quick-input-filter .monaco-inputbox', '.quick-input-list .monaco-list-row'].map(part => selectors.some(selector => selector.includes(part))),
			iconHeight: /\.quick-input-list-icon \{[^}]*height: 24px;/.test(css),
			keycapsWithoutPlus: /:not\(\.keybindings-editor \.monaco-keybinding\) > \.monaco-keybinding-key-separator \{\s*display: none;/.test(css),
		}, { scoped: true, literalColors: false, quickInput: [true, true, true], iconHeight: true, keycapsWithoutPlus: true });
	});

	test('the classic Settings table of contents shows no chevrons and indents its entries 12px', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claudeChrome.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
		const toc = '.monaco-workbench:not(.hc-black):not(.hc-light) .settings-editor > .settings-body .settings-toc-container';
		const block = (selector: string) => css.split('}').find(rule => rule.split('{')[0].trim() === `${toc} ${selector}`) ?? '';
		assert.deepStrictEqual({
			twistie: /width: 0;[\s\S]*padding-right: 0;/.test(block('.monaco-tl-twistie')),
			chevron: /display: none;/.test(block('.monaco-tl-twistie::before')),
			entry: /padding-left: 4px;/.test(block('.monaco-list-row[aria-level="3"] .monaco-tl-contents')),
		}, { twistie: true, chevron: true, entry: true });
	});

	test('every Klawly font size is a role, a ramp step or an icon size, and weights are 400 or 600 (issue 577)', () => {
		const media = join(dirname(fileURLToPath(import.meta.url)), '../../browser/media');
		const sheets = readdirSync(media).filter(name => name.endsWith('.css')).map(name => readFileSync(join(media, name), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ''));
		const css = sheets.join('\n');
		const shared = css.split('\n.monaco-workbench,\n.claude-pane,\n.claude-root {').slice(1).map(rest => rest.slice(0, rest.indexOf('\n}'))).join('\n');
		const token = (name: string) => shared.split(`--claude-${name}:`)[1]?.split(';')[0].trim();
		const roles = ['title', 'heading', 'label', 'body', 'chat', 'secondary', 'meta', 'tool', 'code', 'status'];
		assert.deepStrictEqual({
			literalSizes: css.match(/\tfont-size:\s*\d[^;]*;/g) ?? [],
			heavyWeights: css.match(/font-weight:\s*(?:500|700|bold)\b/g) ?? [],
			roles: roles.map(role => [token(`text-${role}`), token(`text-${role}-weight`), token(`text-${role}-ink`)].join(' ')),
			icons: ['mark', 'compact', 'md', 'base', 'display'].map(size => token(`icon-${size}`)),
		}, {
			literalSizes: [],
			heavyWeights: [],
			roles: [
				'var(--claude-text-2xl) var(--claude-weight-strong) var(--claude-fg-strong)',
				'var(--claude-text-lg) var(--claude-weight-strong) var(--claude-fg-strong)',
				'var(--claude-text-sm) var(--claude-weight-strong) var(--claude-fg)',
				'var(--claude-text-md) 400 var(--claude-fg)',
				'14px 400 var(--claude-fg-strong)',
				'var(--claude-text-sm) 400 var(--claude-fg-muted)',
				'var(--claude-text-xs) 400 var(--claude-fg-muted)',
				'var(--claude-text-sm) 400 var(--claude-fg)',
				'var(--claude-text-sm) 400 var(--claude-fg-strong)',
				'var(--claude-text-xs) 400 var(--claude-fg)',
			],
			icons: ['8px', 'var(--vscode-codiconFontSize-compact, 12px)', '14px', 'var(--vscode-codiconFontSize, 16px)', '28px'],
		});
	});

	test('quick input rows hide their split and gear buttons, keeping only the X', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claudeChrome.css'), 'utf8');
		const hidden = (icon: string) => new RegExp(`\\.quick-input-list-entry-action-bar \\.action-item:has\\(> \\.action-label\\.codicon-${icon}\\)[^{]*\\{[^}]*display: none;`).test(css);
		assert.deepStrictEqual(['split-horizontal', 'split-vertical', 'gear', 'close'].map(hidden), [true, true, true, false]);
	});

	test('the classic Settings editor has 17px group titles, 12px scope tabs, 200px selects and 300px fields', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claudeChrome.css'), 'utf8').replace(/\r\n/g, '\n');
		const block = (selector: string) => css.split(`${selector} {\n`)[1]?.split('\n}')[0] ?? '';
		assert.deepStrictEqual({
			groupTitle: block('.settings-group-title-label.settings-group-level-1'),
			scopeTab: /\bfont-size: var\(--claude-text-sm\);/.test(block('.settings-tabs-widget > .monaco-action-bar .action-item .action-label')),
			select: block('.setting-item-enum .setting-item-value > .setting-item-control > select'),
			field: block('.setting-item-number .setting-item-value > .setting-item-control'),
		}, {
			groupTitle: '\tfont-size: var(--claude-text-xl);\n\tline-height: 26px;',
			scopeTab: true,
			select: '\twidth: 200px;\n\theight: 26px;',
			field: '\twidth: 300px;',
		});
	});

	test('menus are 320px wide with a 10px label gutter and tight separators', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claudeChrome.css'), 'utf8');
		assert.deepStrictEqual({
			width: /\.monaco-menu \{[^}]*box-sizing: border-box;[^}]*min-width: 320px;/.test(css),
			gutter: /\.action-label:not\(\.separator\),\s*[^{]*\.keybinding \{[^}]*padding: 0 6px;/.test(css),
			checkGutter: /:has\(> \.action-item > \.action-menu-item\.checked\)[^{]*\{[^}]*padding-left: 28px;/.test(css),
			separator: /\.action-label\.separator \{[^}]*margin: 2px 0 3px !important;/.test(css),
		}, { width: true, gutter: true, checkGutter: true, separator: true });
	});

	test('the inline and terminal cards use a 13px field, a 12px footer and a 14px close glyph', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claude.css'), 'utf8');
		// The last declaration of a property for a selector is the one that applies.
		const last = (selector: string, property: string) => {
			const values = [...css.matchAll(/\n([^{}\n]+)\{([^}]*)\}/g)]
				.filter(match => match[1].trim() === selector)
				.map(match => new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+);`).exec(match[2])?.[1].trim())
				.filter(value => value !== undefined);
			return values[values.length - 1];
		};
		assert.deepStrictEqual({
			field: last('.claude-inline-input .field', 'font-size'),
			inset: last('.claude-inline-input', 'padding-left'),
			footer: last('.claude-inline-toolbar', 'font-size'),
			footerColor: last('.claude-inline-toolbar', 'color'),
			action: last('.claude-inline-text', 'color'),
			close: last('.claude-inline-input > .claude-inline-icon .codicon', 'font-size'),
			closeInset: [last('.claude-inline-input > .claude-inline-icon', 'top'), last('.claude-inline-input > .claude-inline-icon', 'right')],
		}, {
			field: 'var(--claude-text-md)',
			inset: 'var(--claude-space-2)',
			footer: 'var(--claude-text-sm)',
			footerColor: 'var(--claude-fg-muted)',
			action: 'var(--claude-fg)',
			close: 'var(--claude-icon-md)',
			closeInset: ['3px', '3px'],
		});
	});

	test('issue 580: editor overlays share one recipe, the next-edit hint is a quiet chip, and high contrast keeps the old edges', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claude.css'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
		const blocks = (selector: string) => css.split('}').filter(rule => rule.split('{')[0].split(',').some(part => part.trim() === selector)).join('}');
		const overlays = ['.claude-inline', '.claude-selection-bar', '.claude-hunk-actions', '.claude-review-bar'];
		const recipe = css.split('}').find(rule => overlays.every(selector => rule.split('{')[0].split(',').some(part => part.trim() === selector)))?.split('{')[1].trim().split(/\s*\n\s*/);
		assert.deepStrictEqual({
			recipe,
			ownSurface: overlays.filter(selector => css.split('}').some(rule => rule.split('{')[0].trim() === selector && /\b(border|background|box-shadow|border-radius):/.test(rule))),
			chipEdge: /\bborder:/.test(blocks('.claude-hunk-actions.is-chip')),
			innerRadius: ['.claude-selection-bar-action', '.claude-hunk-actions button', '.claude-review-bar .claude-review-bar-btn'].map(selector => /border-radius: (?<value>[^;]+);/.exec(blocks(selector))?.groups?.value),
			focusRing: /border-color: var\(--claude-focus\);/.test(blocks('.claude-inline:focus-within')),
			nextEdit: [/\bborder(-left)?:/.test(blocks('.claude-next-edit')), /font-size: var\(--claude-text-meta\);/.test(blocks('.claude-next-edit')), /color: var\(--claude-text-meta-ink\);/.test(blocks('.claude-next-edit'))],
			threadRadius: /border-radius: var\(--claude-radius-xl\);/.test(blocks('.claude-review-finding-thread')),
			highContrast: ['hc-black', 'hc-light'].map(theme => [
				/border-color: var\(--claude-border-strong\);/.test(blocks(`.monaco-workbench.${theme} .claude-inline`)),
				/border: 0;/.test(blocks(`.monaco-workbench.${theme} .claude-hunk-actions:not(.is-chip)`)),
				/border-left: 2px solid var\(--claude-hint\);/.test(blocks(`.monaco-workbench.${theme} .claude-next-edit`)),
			]),
		}, {
			recipe: ['border: 1px solid var(--claude-border);', 'border-radius: var(--claude-radius-lg);', 'background: var(--claude-bg-elevated);', 'box-shadow: var(--claude-shadow-popup);'],
			ownSurface: [],
			chipEdge: false,
			innerRadius: ['var(--claude-radius-md)', 'var(--claude-radius-md)', 'var(--claude-radius-md)'],
			focusRing: true,
			nextEdit: [false, true, true],
			threadRadius: true,
			highContrast: [[true, true, true], [true, true, true]],
		});
	});

	test('the prompt\'s Stop is a filled 20px ink circle with an ink-colored glyph, not the red debug square (#135)', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claude.css'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
		const rule = (selector: string) => {
			const start = css.indexOf(`\n${selector} {`);
			return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
		};
		const stop = rule('.claude-msg-user .claude-msg-stop');
		const glyph = rule('.monaco-workbench .claude-msg-user .claude-msg-stop .codicon');
		assert.deepStrictEqual({
			size: /width: 20px;[^]*height: 20px;/.test(stop),
			round: stop.includes('border-radius: var(--claude-radius-pill);'),
			filled: stop.includes('background: var(--claude-fg-strong);'),
			glyph: glyph.includes('color: inherit;'),
		}, { size: true, round: true, filled: true, glyph: true });
	});

	test('notification toasts show the source as an 11px faint line and use 20px buttons (issue 164)', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claudeChrome.css'), 'utf8').replace(/\r\n/g, '\n');
		const item = '.monaco-workbench:not(.hc-black):not(.hc-light) .notifications-list-container .notification-list-item';
		const block = (selector: string) => css.split(`\n${item} ${selector} {\n`)[1]?.split('\n}')[0].trim().split('\n').map(line => line.trim()) ?? [];
		assert.deepStrictEqual({
			source: block('.notification-list-item-source'),
			button: block('.notification-list-item-buttons-container .monaco-text-button'),
		}, {
			source: ['font-size: var(--claude-text-meta);', 'color: var(--vscode-disabledForeground);'],
			button: ['padding: 0 6px;', 'border-radius: var(--claude-radius-sm);', 'line-height: 18px;', 'font-size: var(--claude-text-sm);'],
		});
	});

	test('issue 583: VS Code overlays take the overlay recipe, rows stay md and dialog titles are headings', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claudeChrome.css'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
		const scope = '.monaco-workbench:not(.hc-black):not(.hc-light) ';
		// Every declaration of a selector, from every rule that lists it.
		const blocks = (selector: string) => css.split('}').filter(rule => rule.split('{')[0].split(',').some(part => part.trim() === `${scope}${selector}`)).map(rule => rule.split('{')[1]).join('');
		const has = (selector: string, declaration: string) => blocks(selector).includes(declaration);
		const overlays = ['.monaco-menu-container', '.quick-input-widget', '> .notifications-center', '> .notifications-toasts .notifications-list-container', '.monaco-hover.workbench-hover', '.monaco-editor .monaco-resizable-hover', '.monaco-dialog-modal-block .dialog-shadow'];
		assert.deepStrictEqual({
			radius: overlays.filter(selector => !has(selector, 'border-radius: var(--claude-radius-lg)')),
			shadow: overlays.filter(selector => !has(selector, 'box-shadow: var(--claude-shadow-popup)')),
			rows: ['.monaco-menu .monaco-action-bar.vertical .action-menu-item', '.quick-input-list .monaco-list-row'].map(selector => has(selector, 'border-radius: var(--claude-radius-md)')),
			literalRadii: css.match(/border-radius:[^;]*\d+px[^;]*;/g) ?? [],
			dialogTitle: has('.monaco-dialog-box .dialog-message-row .dialog-message-container .dialog-message', 'font-size: var(--claude-text-heading);'),
			dialogButton: has('.monaco-dialog-box > .dialog-buttons-row > .dialog-buttons .monaco-text-button', 'border-radius: var(--claude-radius-md);'),
		}, { radius: [], shadow: [], rows: [true, true], literalRadii: [], dialogTitle: true, dialogButton: true });
	});

	test('the settings buttons and the Agents Window pill use weight 400 and the pill pads 8px on both sides', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claude.css'), 'utf8').replace(/\r\n/g, '\n');
		const block = (selector: string) => css.split(`\n${selector} {\n`)[1]?.split('\n}')[0] ?? '';
		const pill = block('.monaco-workbench .part.titlebar .action-toolbar-container .monaco-action-bar .action-item.claude-titlebar-pill-item > .action-label.claude-titlebar-pill');
		assert.deepStrictEqual({
			button: /\bfont-weight: 400;/.test(block('.claude-btn')),
			pillWeight: /\bfont-weight: 400;/.test(pill),
			pillPadding: /\bpadding: 0 var\(--claude-space-4\);/.test(pill),
		}, { button: true, pillWeight: true, pillPadding: true });
	});

	test('settings nav items are 13px text in 24px rows with 8px side padding', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claude.css'), 'utf8');
		const rule = css.split('\n.claude-settings-nav-item {')[1]?.split('}')[0] ?? '';
		const value = (property: string) => new RegExp(`\\n\\t${property}: ([^;]+);`).exec(rule)?.[1];
		assert.deepStrictEqual({
			height: value('height'),
			padding: value('padding'),
			gap: value('gap'),
			fontSize: value('font-size'),
		}, { height: '24px', padding: '0 var(--claude-space-4)', gap: 'var(--claude-space-4)', fontSize: 'var(--claude-text-md)' });
	});

	test('the selection keeps its active color while the inline edit card has focus', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claude.css'), 'utf8');
		assert.strictEqual(/\n\.monaco-editor:has\(\.claude-inline-zone:focus-within\) \.selected-text \{\s*background-color: var\(--vscode-editor-selectionBackground\);\s*\}/.test(css), true);
	});

	test('the inline edit card sits 4px below the line above it', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claude.css'), 'utf8');
		assert.match(css, /\n\.claude-inline-zone \{\s*box-sizing: border-box;\s*padding-top: var\(--claude-space-2\);\s*\}/);
	});

	test('a clicked settings control has no focus ring, a keyboard-focused one keeps it', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claude.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
		const block = (selector: string) => css.split('}').find(rule => rule.split('{')[0].split(',').some(part => part.trim() === selector)) ?? '';
		const controls = ['.claude-settings-nav-item', '.claude-settings-switch', '.claude-settings .claude-icon-btn', '.claude-btn'];
		assert.deepStrictEqual({
			click: controls.map(control => /outline:\s*none;/.test(block(`${control}:focus:not(:focus-visible)`))),
			keyboard: controls.map(control => /outline:\s*1px solid var\(--claude-focus\);/.test(block(`${control}:focus-visible`))),
		}, { click: [true, true, true, true], keyboard: [true, true, true, true] });
	});

	test('issue 533: the settings body fills the scrollable and the page column cannot outgrow the editor', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claude.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
		const blocks = (selector: string) => css.split('}').filter(rule => rule.split('{')[0].split(',').some(part => part.trim() === selector)).join('}');
		assert.deepStrictEqual({
			body: /height:\s*100%;/.test(blocks('.claude-settings-body')),
			main: /min-height:\s*0;/.test(blocks('.claude-settings-main')),
		}, { body: true, main: true });
	});

	test('issue 581: settings rows size from their content on the ramp, with faint dividers, type roles and one control height', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claude.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
		const blocks = (selector: string) => css.split('}').filter(rule => rule.split('{')[0].split(',').some(part => part.trim() === selector)).join('}');
		const value = (selector: string, property: string) => new RegExp(`(?:^|[\\s;{])${property}:\\s*(?<value>[^;]+);`).exec(blocks(selector))?.groups?.value;
		assert.deepStrictEqual({
			row: [value('.claude-settings-row', 'min-height'), value('.claude-settings-row', 'gap'), value('.claude-settings-row.is-model', 'min-height')],
			divider: value('.claude-settings-row + .claude-settings-row', 'border-top'),
			title: [value('.claude-settings-row-title', 'font-size'), value('.claude-settings-row-title', 'font-weight'), value('.claude-settings-row-title', 'color')],
			description: [value('.claude-settings-row-description', 'font-size'), value('.claude-settings-row-description', 'margin-top'), value('.claude-settings-row-description', 'color')],
			section: [value('.claude-settings-section-label', 'font-size'), value('.claude-settings-section-label', 'font-weight'), value('.claude-settings-section + .claude-settings-section', 'margin-top')],
			control: [value('.claude-settings-row-control', 'min-height'), value('.claude-settings-row-control', 'justify-content')],
			compactSelect: blocks('.claude-settings-select.is-compact') !== '',
			homeHint: value('.claude-home-hint', 'border-radius'),
			homeTile: value('.claude-home-start', 'border'),
			highContrast: ['hc-black', 'hc-light'].map(theme => value(`.monaco-workbench.${theme} .claude-settings-row + .claude-settings-row`, 'border-top-color')),
		}, {
			row: [undefined, 'var(--claude-space-6)', undefined],
			divider: '1px solid var(--claude-border-faint)',
			title: ['var(--claude-text-label)', 'var(--claude-text-label-weight)', 'var(--claude-text-label-ink)'],
			description: ['var(--claude-text-secondary)', 'var(--claude-space-1)', 'var(--claude-text-secondary-ink)'],
			section: ['var(--claude-text-heading)', 'var(--claude-text-heading-weight)', 'var(--claude-space-7)'],
			control: ['var(--claude-control-h)', 'flex-end'],
			compactSelect: false,
			homeHint: 'var(--claude-radius-pill)',
			homeTile: 'none',
			highContrast: ['var(--claude-border)', 'var(--claude-border)'],
		});
	});

	test('issue 579: the plan card and plan editor have no inner boxes, ramp spacing, type roles, one action height and an orange progress bar', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claude.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
		const blocks = (selector: string) => css.split('}').filter(rule => rule.split('{')[0].split(',').some(part => part.trim() === selector)).join('}');
		const value = (selector: string, property: string) => new RegExp(`(?:^|[\\s;{])${property}:\\s*(?<value>[^;]+);`).exec(blocks(selector))?.groups?.value;
		assert.deepStrictEqual({
			head: value('.claude-plan-head', 'padding'),
			summary: [value('.claude-plan-summary', 'font-size'), value('.claude-plan-summary', 'line-height')],
			step: value('.claude-plan .claude-todo', 'padding'),
			notesDivider: value('.claude-plan .claude-todos:has(+ .claude-plan-notes)', 'border-bottom'),
			notes: [value('.claude-plan-notes', 'border'), value('.claude-plan-notes:hover', 'border-color')],
			build: [value('.claude-split.is-plan', 'height'), value('.claude-split.is-plan', 'border-radius')],
			progress: value('.claude-plan-progress .fill', 'background'),
			section: [value('.claude-plan-section', 'margin-top'), value('.claude-plan-section-head .label', 'font-size'), value('.claude-plan-title', 'font-size')],
			todo: value('.claude-plan-todo', 'padding'),
			highContrast: ['hc-black', 'hc-light'].map(theme => value(`.monaco-workbench.${theme} .claude-plan-notes`, 'border')),
		}, {
			head: 'var(--claude-space-5) var(--claude-space-5) 0',
			summary: ['var(--claude-text-body)', 'var(--claude-text-body-leading)'],
			step: 'var(--claude-space-3) 0',
			notesDivider: '1px solid var(--claude-border-faint)',
			notes: ['1px solid transparent', 'var(--claude-field-edge)'],
			build: ['20px', 'var(--claude-radius-sm)'],
			progress: 'var(--claude-accent)',
			section: ['var(--claude-space-7)', 'var(--claude-text-heading)', 'var(--claude-text-title)'],
			todo: 'var(--claude-space-1) var(--claude-space-2)',
			highContrast: ['1px dashed var(--claude-field-edge)', '1px dashed var(--claude-field-edge)'],
		});
	});

	test('issue 576: one recipe per control, on the shared state ramp, with the one-offs gone', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claude.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
		const blocks = (selector: string) => css.split('}').filter(rule => rule.split('{')[0].split(',').some(part => part.trim() === selector)).join('}');
		assert.deepStrictEqual({
			states: [...new Set([...css.matchAll(/--claude-state-(?<state>[a-z-]+): color-mix\(in srgb, var\(--claude-fg-strong\) \d+%, transparent\);/g)].map(match => match.groups?.state))],
			disabled: /--claude-state-disabled: \.4;/.test(css),
			button: /height: var\(--claude-control-h\);[^}]*border: 1px solid transparent;[^}]*background: var\(--vscode-button-secondaryBackground/.test(blocks('.claude-btn')),
			sizes: ['.claude-btn.is-medium', '.claude-btn.is-small'].map(size => /height: \d+px;/.exec(blocks(size))?.[0]),
			ghostHover: /var\(--claude-state-hover\)/.test(blocks('.claude-btn.is-ghost:hover:not(:disabled)')),
			field: /height: var\(--claude-control-h\);[^}]*border: 1px solid var\(--claude-field-edge\);/.test(blocks('.claude-field')),
			fieldFocus: /border-color: var\(--claude-focus\);/.test(blocks('.claude-field:focus-visible')),
			toggle: /var\(--claude-state-selected\)/.test(blocks('.claude-chip.is-toggle[aria-pressed="true"]')),
			segmented: [/border-radius: var\(--claude-radius-md\);/.test(blocks('.claude-segmented')), /border-radius: var\(--claude-radius-sm\);/.test(blocks('.claude-segmented > button'))],
			gone: ['.claude-btn.is-outline', '.claude-btn.is-secondary:hover', '.claude-customize-chip {', '.claude-settings-select:hover', '.claude-agents-search {', '.claude-settings-head-button.is-outlined'].map(part => css.includes(part)),
		}, {
			states: ['hover', 'pressed', 'selected', 'selected-hover'],
			disabled: true,
			button: true,
			sizes: ['height: 24px;', 'height: 20px;'],
			ghostHover: true,
			field: true,
			fieldFocus: true,
			toggle: true,
			segmented: [true, true],
			gone: [false, false, false, false, false, false],
		});
	});

	test('issue 575: cards separate by tone, not an outline, one box deep, and high contrast keeps every edge', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claude.css'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
		const blocks = (selector: string) => css.split('}').filter(rule => rule.split('{')[0].split(',').some(part => part.trim() === selector)).join('}');
		const cards = ['.claude-msg-user', '.claude-msg-toolbar', '.claude-codeblock', '.claude-banner', '.claude-permission', '.claude-plan', '.claude-tool.is-boxed', '.claude-subagent', '.claude-changes', '.claude-changes-bar', '.claude-bg-agent', '.claude-new-problems', '.claude-side-question', '.claude-todo-strip', '.claude-goal-strip', '.claude-review-findings', '.claude-review-feedback', '.claude-home-start', '.claude-github-card', '.claude-tool:not(.is-boxed) > .claude-tool-body.is-diff'];
		const dividers = ['.claude-codeblock-header', '.claude-tool-footer', '.claude-inspector', '.claude-changes-head', '.claude-changes-foot', '.claude-plan-section-head', '.claude-goal-strip-row + .claude-goal-strip-row', '.claude-inline-answer', '.claude-terminal-reply', '.claude-terminal-wait'];
		assert.deepStrictEqual({
			outlined: [...cards, '.claude-review-finding-thread', '.claude-banner.is-error', '.claude-banner.is-warning', '.claude-permission.is-danger'].filter(card => /\bborder(-color)?: (1px|color-mix)/.test(blocks(card))),
			floating: cards.filter(card => /box-shadow: var\(--claude-shadow/.test(blocks(card))),
			severityEdge: /border-left: 3px solid var\(--claude-info\);/.test(blocks('.claude-review-finding-thread')),
			dividers: dividers.filter(divider => !/: 1px solid var\(--claude-border-faint\);/.test(blocks(divider))),
			dashed: ['.claude-readonly-hint', '.claude-plan-notes'].map(selector => /dashed/.test(blocks(selector))),
			notesField: /border-color: var\(--claude-field-edge\);/.test(blocks('.claude-plan-notes:hover')),
			lightCard: /--claude-bg-card: color-mix\(in srgb, var\(--claude-fg-strong\) 5%, var\(--vscode-sideBar-background/.test(blocks('.monaco-workbench.vs .claude-pane')),
			highContrast: cards.filter(card => !['hc-black', 'hc-light'].every(theme => /border: 1px solid var\(--claude-border\);/.test(blocks(`.monaco-workbench.${theme} ${card}`)))),
		}, {
			outlined: [],
			floating: [],
			severityEdge: true,
			dividers: [],
			dashed: [false, false],
			notesField: true,
			lightCard: true,
			highContrast: [],
		});
	});

	test('issue 578: the composer has no edge at rest, a command is an unboxed row over one tonal block, the chat rhythm is three tokens, and high contrast keeps the box', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claude.css'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
		const blocks = (selector: string) => css.split('}').filter(rule => rule.split('{')[0].split(',').some(part => part.trim() === selector)).join('}');
		const highContrast = (selector: string, pattern: RegExp) => ['hc-black', 'hc-light'].every(theme => pattern.test(blocks(`.monaco-workbench.${theme} ${selector}`)));
		assert.deepStrictEqual({
			composer: [/border: 1px solid transparent;/.test(blocks('.claude-composer')), /border-color: var\(--claude-border\);/.test(blocks('.claude-composer:hover')), /border-color: var\(--claude-focus\);/.test(blocks('.claude-composer:focus-within'))],
			composerShadow: /box-shadow/.test(blocks('.monaco-workbench.vs .claude-composer')),
			commandBox: /background|border/.test(blocks('.claude-tool.is-boxed')) || /min-height: 30px/.test(blocks('.claude-tool.is-boxed > .claude-tool-row')),
			commandBlock: [/margin-left: 22px;/.test(blocks('.claude-tool.is-boxed > :not(.claude-tool-row)')), /background: var\(--claude-bg-card\);/.test(blocks('.claude-tool.is-boxed > :not(.claude-tool-row)')), !/background: transparent;/.test(blocks('.claude-tool.is-boxed > .claude-terminal'))],
			diffFill: /background: transparent;/.test(blocks('.claude-mini-diff')),
			rhythm: ['--claude-gap-turn: var(--claude-space-6);', '--claude-gap-block: var(--claude-space-5);', '--claude-gap-tool: var(--claude-space-4);'].map(token => css.includes(token)),
			gaps: [/gap: var\(--claude-gap-turn\);/.test(blocks('.claude-timeline')), /gap: var\(--claude-gap-block\);/.test(blocks('.claude-turn')), /calc\(var\(--claude-gap-tool\) - var\(--claude-gap-block\)\)/.test(blocks('.claude-turn > .claude-part.is-row + .claude-part:not(.is-row)'))],
			meta: ['.claude-thinking-line', '.claude-work-toggle', '.claude-turn-meta .time'].filter(selector => !/font-size: var\(--claude-text-meta\);/.test(blocks(selector))),
			highContrast: [
				highContrast('.claude-composer', /border-color: var\(--claude-border-strong\);/),
				highContrast('.claude-tool.is-boxed', /border: 1px solid var\(--claude-border\);/),
				highContrast('.claude-tool.is-boxed > .claude-tool-row', /min-height: 30px;/),
				highContrast('.claude-tool.is-boxed.is-open > .claude-tool-row', /border-bottom: 1px solid var\(--claude-border-faint\);/),
				highContrast('.claude-tool.is-boxed > :not(.claude-tool-row)', /margin: 0;/),
				highContrast('.claude-mini-diff', /background: var\(--claude-bg-code\);/),
			],
		}, {
			composer: [true, true, true],
			composerShadow: false,
			commandBox: false,
			commandBlock: [true, true, true],
			diffFill: true,
			rhythm: [true, true, true],
			gaps: [true, true, true],
			meta: [],
			highContrast: [true, true, true, true, true, true],
		});
	});

	test('issue 147: the Try Plan hint never shrinks and shortcut labels stay on one line', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claude.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
		const blocks = (selector: string) => css.split('}').filter(rule => rule.split('{')[0].split(',').some(part => part.trim() === selector)).join('}');
		assert.deepStrictEqual({
			hint: /flex:\s*none;/.test(blocks('.claude-composer-hint > span:first-child')),
			columns: /grid-template-columns:\s*minmax\(0, 1fr\) auto;/.test(blocks('.claude-shortcuts')),
			label: /white-space:\s*nowrap;/.test(blocks('.claude-shortcuts dt')),
			keys: /white-space:\s*nowrap;/.test(blocks('.claude-shortcuts dd')),
		}, { hint: true, columns: true, label: true, keys: true });
	});

	test('issue 584: in a narrow pane the changes bar drops its extras, then wraps its actions, and never clips the count or Review', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../browser/media/claude.css'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
		const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split('}')[0] ?? '';
		assert.deepStrictEqual({
			head: /flex-wrap: wrap;[^}]*min-height: 28px;/.test(rule('.claude-changes-bar-head')),
			countWhole: /flex: none;/.test(rule('.claude-changes-bar-toggle')) && !/min-width: 0;/.test(rule('.claude-changes-bar-toggle')),
			actionsWrapRight: /flex-wrap: wrap;[^}]*margin-inline-start: auto;/.test(rule('.claude-changes-bar-actions')),
			shortKeepAll: /@container claude-changes \(max-width: 440px\) \{\s*\.claude-keep-wide-full \{\s*display: none;\s*\}\s*\.claude-keep-wide-short \{\s*display: inline;/.test(css),
			noteGoes: /@container claude-changes \(max-width: 440px\) \{\s*\.claude-changes-bar-toggle \.claude-changes-auto-kept \{\s*display: none;/.test(css),
			totalsGo: /@container claude-changes \(max-width: 360px\) \{\s*\.claude-changes-bar-toggle \.claude-diffstat \{\s*display: none;/.test(css),
		}, { head: true, countWhole: true, actionsWrapRight: true, shortKeepAll: true, noteGoes: true, totalsGo: true });
	});

	test('each mode icon takes its own color from a token (DL-94)', () => {
		const cssPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../src/vs/workbench/contrib/claude/browser/media/claude.css');
		const css = readFileSync(cssPath, 'utf8');
		const solid = (name: string) => new RegExp(String.raw`--claude-mode-${name}-solid:\s*var\(--vscode-claude-mode-${name}, (#[0-9a-f]{6})\)`).exec(css)?.[1];
		assert.deepStrictEqual(['plan', 'agent', 'ask', 'debug', 'multitask'].map(solid), ['#dd8f52', '#a3a3a3', '#7cba92', '#ec7a8b', '#a891e6']);
		for (const mode of ['agent', 'plan', 'ask', 'debug']) {
			assert.match(css, new RegExp(String.raw`\.claude-pill\.is-${mode} > \.codicon:first-child`));
			assert.match(css, new RegExp(String.raw`data-mode="${mode}"\] > \.codicon`));
		}
		assert.match(css, /\.claude-multitask-header > \.codicon:first-child\s*\{[^}]*--claude-mode-multitask-solid/);
	});
});

