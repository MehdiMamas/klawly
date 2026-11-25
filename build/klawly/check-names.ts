/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks that Klawly's own files talk about Klawly and never name the AI editor
// the UX captures were taken from (issue 553). "cursor" meaning the text cursor
// is a different word and is never flagged.
// Usage: node build/klawly/check-names.ts
// Reads the tracked files under KLAWLY_PATHS. Exit code 1 on a hit. No dependencies.

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

/** Files and folders Klawly owns. Upstream Code - OSS files are not checked. */
const KLAWLY_PATHS = [
	'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'FEATURES.md', 'KLAWLY_MASTER_PLAN.md', 'README.md', 'UPSTREAM.md',
	'build/klawly', 'design', 'docs', 'extensions/theme-klawly', '.github/skills/design-philosophy',
	'src/vs/platform/claude', 'src/vs/workbench/services/claude', 'src/vs/workbench/contrib/claude',
];

/** Files exempt from the name check (none). */
const SKIPPED_FILES = /^$/;

/** References to the product: its name in product phrases, its old-derived names, and its folders. */
const PRODUCT = new RegExp([
	String.raw`\bCursor(?:'s|-like|-style|-Style|-class|-Replica| IDE| Settings| Dark| Light| Rules| Agent| does| has| uses)\b`,
	String.raw`\b(?:like|than|vs\.?|versus|and|or|from|beside|next to) Cursor\b`,
	String.raw`\bCursor (?:and|or) `,
	String.raw`[Cc]ursify|CURSIFY|cursorLike|CURSOR_LIKE|CURSOR_IDE`,
	String.raw`\.cursor/(?:rules|skills|plans|agents)|\.cursorignore`,
].join('|'));

/**
 * Lines that must keep the name: the import reads that editor's settings
 * folder and is labeled by it (issue 553 kept it), and the settings migration
 * has to name the key it moves.
 */
const ALLOWED_LINE = /[Ii]mport|VS Code or Cursor|CLAUDE_LEGACY_KEYBINDINGS_PRESET_SETTING = /;

/** The import feature and its tests, which name that editor throughout. */
const IMPORT_FILES = /\/claudeImport(?:Fixtures)?(?:\.test)?\.ts$/;

/** This script names the patterns it looks for. */
const SELF = 'build/klawly/check-names.ts';

const files = execFileSync('git', ['ls-files', '-z', '--', ...KLAWLY_PATHS], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
	.split('\0')
	.filter(f => f && f !== SELF && !SKIPPED_FILES.test(f) && !IMPORT_FILES.test(f) &&!/\.(png|jpe?g|gif|ico|icns|woff2?|ttf|zip|gz)$/.test(f));

const hits: string[] = [];
for (const file of files) {
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		continue; // deleted in the working tree
	}
	text.split(/\r?\n/).forEach((line, i) => {
		// DL-11: user-facing strings (nls) end in three dots, never the single ellipsis character (issue 999).
		if (/\blocalize2?\(/.test(line) && line.includes('\u2026')) {
			hits.push(`${file}:${i + 1}: use "..." in a localized string, not the ellipsis character`);
		}
		const match = PRODUCT.exec(line);
		if (match && !ALLOWED_LINE.test(line)) {
			hits.push(`${file}:${i + 1}: "${match[0]}"`);
		}
	});
}

/**
 * Public branding (issue 1654): the product and packaging files and every
 * single-line localized string say Klawly, never the upstream product names.
 * The import feature names the editor it reads from, and the guide compares
 * Klawly with it, so those stay.
 */
const BRAND = /Visual Studio Code|VS Code|Code - OSS/;
const BRAND_PRODUCT_FILES = ['product.json', 'resources/linux/code.desktop', 'resources/linux/code.appdata.xml', 'resources/linux/snap/snapcraft.yaml', 'resources/linux/code-url-handler.desktop', 'build/win32/i18n', 'cli/src/commands/args.rs'];
const BRAND_ALLOWED = /[Ii]mport|"label": "VS Code"|klawlyGuideText|localize\('VS Code for Web'/;
const brandSource = execFileSync('git', ['ls-files', '-z', '--', 'src/**/*.ts', ':!src/**/test/**', ...BRAND_PRODUCT_FILES], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
	.split('\0')
	.filter(f => f && f !== SELF && !/claudeImport|klawlyGuideText/.test(f));
for (const file of brandSource) {
	const isCode = file.endsWith('.ts');
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		continue;
	}
	text.split(/\r?\n/).forEach((line, i) => {
		if (BRAND.test(line) && !BRAND_ALLOWED.test(line) && (!isCode || /\blocalize2?\(/.test(line))) {
			hits.push(`${file}:${i + 1}: "${BRAND.exec(line)![0]}" in a user-visible string; say Klawly`);
		}
	});
}

if (hits.length) {
	console.error(`Klawly files break a naming rule (issue 553 names, issue 999 ellipsis, issue 1654 branding):\n${hits.join('\n')}`);
	process.exit(1);
}
console.log(`check-names: ${files.length} Klawly files, no references to another AI editor.`);
