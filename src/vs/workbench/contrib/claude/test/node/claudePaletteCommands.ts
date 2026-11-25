/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readdirSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from '../../../../../base/common/path.js';

/**
 * A source-level reader for the Klawly commands in the Command Palette (issue 1504). It reads the
 * `super({ ... f1: true ... })` blocks of the Action2 classes under `contrib/claude`, so a node test
 * can see every command's title, alias and the keys that decide whether the palette lists it,
 * without starting the workbench. The palette hides an action whose `precondition` is false, so the
 * precondition is what the palette depends on.
 */
export interface IClaudePaletteCommand {
	readonly id: string;
	readonly file: string;
	/** The palette label, "Klawly: Stop Agent". */
	readonly label: string;
	/** The English "Category: original" the palette also matches. */
	readonly commandAlias: string;
	/** The context key names the palette listing depends on, after following key constants. */
	readonly keys: readonly string[];
}

const CATEGORY = 'Klawly';

// The compiled test sits in out/vs/workbench/contrib/claude/test/node; the sources are under src/.
const claudeRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../src/vs/workbench/contrib/claude');

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap(name => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			return name === 'test' ? [] : sourceFiles(path);
		}
		return name.endsWith('.ts') ? [path] : [];
	});
}

function closingQuote(text: string, open: number): number {
	for (let i = open + 1; i < text.length; i++) {
		if (text[i] === '\\') {
			i++;
		} else if (text[i] === text[open]) {
			return i;
		}
	}
	return -1;
}

/** The index of the bracket that closes the one at `open`, skipping strings and comments. */
function closing(text: string, open: number): number {
	const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
	const stack: string[] = [];
	for (let i = open; i < text.length; i++) {
		const ch = text[i];
		if (ch === '/' && text[i + 1] === '/') {
			i = text.indexOf('\n', i);
			if (i < 0) {
				break;
			}
		} else if (ch === '/' && text[i + 1] === '*') {
			i = text.indexOf('*/', i) + 1;
		} else if (ch === '\'' || ch === '"' || ch === '`') {
			const end = closingQuote(text, i);
			if (end < 0) {
				break;
			}
			i = end;
		} else if (pairs[ch]) {
			stack.push(pairs[ch]);
		} else if (ch === stack[stack.length - 1]) {
			stack.pop();
			if (!stack.length) {
				return i;
			}
		}
	}
	return -1;
}

/** The top level `key: value` properties of an object literal body. */
function properties(body: string): Map<string, string> {
	const result = new Map<string, string>();
	let start = 0;
	for (let i = 0; i <= body.length; i++) {
		const ch = body[i];
		if (ch === undefined || ch === ',') {
			const part = body.slice(start, i).trim();
			const match = /^(?<key>[A-Za-z_]\w*)\s*:\s*(?<value>[\s\S]*)$/.exec(part);
			if (match?.groups) {
				result.set(match.groups.key, match.groups.value.trim());
			} else if (/^[A-Za-z_]\w*$/.test(part)) {
				result.set(part, part);
			}
			start = i + 1;
		} else if (ch === '{' || ch === '(' || ch === '[') {
			const end = closing(body, i);
			i = end < 0 ? body.length : end;
		} else if (ch === '\'' || ch === '"' || ch === '`') {
			const end = closingQuote(body, i);
			i = end < 0 ? body.length : end;
		}
	}
	return result;
}

/** Every top level `const NAME = ...;` in the claude contrib, to follow a name to the keys it stands for. */
function constants(files: Map<string, string>): Map<string, string> {
	const result = new Map<string, string>();
	for (const text of files.values()) {
		for (const match of text.matchAll(/^(?:export\s+)?const\s+(?<name>[A-Za-z_]\w*)(?:\s*:\s*[^=]+)?\s*=\s*(?<value>[^;]*);/gm)) {
			if (match.groups && !result.has(match.groups.name)) {
				result.set(match.groups.name, match.groups.value);
			}
		}
	}
	return result;
}

/**
 * The context key names an expression mentions: constants it uses, followed to their definitions
 * (`new RawContextKey('claude.agentRunning', ...)`), plus the string keys of `ContextKeyExpr.equals('key', ...)`.
 */
function expressionKeys(expression: string, known: Map<string, string>, seen = new Set<string>()): string[] {
	const keys = new Set<string>();
	for (const match of expression.matchAll(/\b(?<name>[A-Za-z_]\w*)\b/g)) {
		const name = match.groups!.name;
		const definition = known.get(name);
		if (definition === undefined || seen.has(name)) {
			continue;
		}
		const rawKey = /new RawContextKey<[^>]*>\(\s*'(?<key>[^']+)'/.exec(definition)?.groups?.key;
		if (rawKey) {
			keys.add(rawKey);
		} else {
			expressionKeys(definition, known, new Set(seen).add(name)).forEach(key => keys.add(key));
		}
	}
	for (const match of expression.matchAll(/ContextKeyExpr\.(?:equals|notEquals|has|not|regex|in)\(\s*'(?<key>[^']+)'/g)) {
		keys.add(match.groups!.key);
	}
	// Keys from outside the claude contrib, written as `Owner.key`.
	for (const match of expression.matchAll(/\b(?<name>(?:ActiveEditorContext|TerminalContextKeys|EditorContextKeys)\.\w+)/g)) {
		keys.add(match.groups!.name);
	}
	return [...keys];
}

function unquote(value: string | undefined, known: Map<string, string>): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const literal = /^'(?<text>[^']*)'$/.exec(value) ?? /^"(?<text>[^"]*)"$/.exec(value);
	if (literal) {
		return literal.groups!.text;
	}
	const definition = known.get(value);
	return definition === undefined ? undefined : unquote(definition.trim(), known);
}

/** The English words of a title: `localize2('key', "Words")`, or the `original` it overrides with. */
function titleParts(title: string): { value: string; original: string } | undefined {
	const value = /localize2\(\s*'[^']*'\s*,\s*"(?<text>(?:[^"\\]|\\.)*)"/.exec(title)?.groups?.text;
	if (value === undefined) {
		return undefined;
	}
	const original = /original:\s*'(?<text>(?:[^'\\]|\\.)*)'/.exec(title)?.groups?.text;
	return { value, original: original ?? value };
}

/**
 * Reads every Klawly f1 command under `contrib/claude`. `unreadable` lists the f1 commands in the
 * Klawly category whose title or id the reader could not read, so the guard fails instead of skipping them.
 */
export function readClaudePaletteCommands(): { commands: IClaudePaletteCommand[]; unreadable: string[] } {
	const files = new Map(sourceFiles(claudeRoot).map(path => [path, readFileSync(path, 'utf8')]));
	const known = constants(files);
	const commands: IClaudePaletteCommand[] = [];
	const unreadable: string[] = [];
	for (const [path, text] of files) {
		const file = path.slice(claudeRoot.length + 1);
		for (const match of text.matchAll(/super\(\{/g)) {
			const open = match.index + match[0].length - 1;
			const close = closing(text, open);
			if (close < 0) {
				continue;
			}
			const props = properties(text.slice(open + 1, close));
			if (props.get('f1') !== 'true') {
				continue;
			}
			const category = props.get('category') ?? '';
			if (!/KLAWLY_CATEGORY/.test(category) && !(category === 'category' && /const category\b[^;]*KLAWLY_CATEGORY/.test(text))) {
				continue; // another category: upstream's, or not Klawly's palette entry
			}
			const id = unquote(props.get('id'), known) ?? props.get('id') ?? `${file}@${match.index}`;
			const title = titleParts(props.get('title') ?? '');
			if (!title) {
				// One class registered for several commands by a helper or a loop, with the id and title as
				// parameters: read each `'id', ... localize2('key', "Title")` pair written in the file.
				const keys = expressionKeys(props.get('precondition') ?? '', known);
				const keyPairs = [...text.matchAll(/'(?<id>[a-z][\w]*(?:\.\w+)+)'[^\n]{0,80}?localize2\(\s*'[^']*'\s*,\s*"(?<title>[^"]*)"/g)];
				if (!keyPairs.length || !/^[a-z]\w*$/.test(props.get('title') ?? '')) {
					unreadable.push(`${file}: ${id}`);
					continue;
				}
				for (const pair of keyPairs) {
					if (!commands.some(c => c.id === pair.groups!.id)) {
						commands.push({ id: pair.groups!.id, file, label: `${CATEGORY}: ${pair.groups!.title}`, commandAlias: `${CATEGORY}: ${pair.groups!.title}`, keys });
					}
				}
				continue;
			}
			commands.push({
				id,
				file,
				label: `${CATEGORY}: ${title.value}`,
				commandAlias: `${CATEGORY}: ${title.original}`,
				keys: expressionKeys(props.get('precondition') ?? '', known),
			});
		}
	}
	return { commands, unreadable };
}
