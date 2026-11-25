/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** `off`, only the changed symbols' references, or references plus similar-pattern hints (issue 931). */
export type ClaudeReviewImpactContext = 'off' | 'symbols' | 'symbolsAndPatterns';

export const CLAUDE_REVIEW_IMPACT_CONTEXT_SETTING = 'claude.review.impactContext';
export const CLAUDE_REVIEW_IMPACT_CONTEXTS: readonly ClaudeReviewImpactContext[] = ['off', 'symbols', 'symbolsAndPatterns'];

/** The most characters the context pack adds to the review prompt. */
export const CLAUDE_REVIEW_CONTEXT_BUDGET = 8_000;
/** The most changed symbols whose references are looked up, and the most references kept per symbol. */
export const CLAUDE_REVIEW_CONTEXT_MAX_SYMBOLS = 12;
export const CLAUDE_REVIEW_CONTEXT_MAX_REFERENCES = 8;
/** The most characters of the graph summary the pack includes. */
export const CLAUDE_REVIEW_CONTEXT_GRAPH_BUDGET = 2_000;

/** A changed symbol and the file it changed in. */
export interface ClaudeChangedSymbol {
	readonly name: string;
	readonly path: string;
}

/** One place that refers to a changed symbol. `path` is relative to the repo root, `line` starts at 1. */
export interface ClaudeContextReference {
	readonly symbol: string;
	readonly path: string;
	readonly line: number;
	readonly text: string;
}

export interface ClaudeContextPack {
	readonly text: string;
	/** Shown to the user: what was examined. */
	readonly summary: string;
	readonly referenceCount: number;
}

const NOT_SYMBOLS = new Set(['constructor', 'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'import', 'export', 'default', 'else', 'this', 'super', 'new', 'get', 'set', 'main', 'test', 'describe', 'it']);

const DECLARATION = /\b(?:function\*?|class|interface|enum|type|def|fn|func|struct|trait)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/;
const METHOD = /^\s*(?:(?:public|private|protected|static|async|override|readonly|export|abstract)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/;

/** Reads `claude.review.impactContext`; anything else is `symbols`. */
export function readClaudeReviewImpactContext(value: unknown): ClaudeReviewImpactContext {
	return CLAUDE_REVIEW_IMPACT_CONTEXTS.find(known => known === value) ?? 'symbols';
}

function symbolOf(line: string): string | undefined {
	const declared = DECLARATION.exec(line);
	const name = declared?.[1] ?? declared?.[2] ?? METHOD.exec(line)?.[1];
	return name && name.length >= 3 && !NOT_SYMBOLS.has(name) ? name : undefined;
}

/** The functions, classes, types and methods a diff declares, adds, removes or sits inside, in order, without repeats. */
export function claudeChangedSymbols(diff: string, max: number = CLAUDE_REVIEW_CONTEXT_MAX_SYMBOLS): ClaudeChangedSymbol[] {
	const found: ClaudeChangedSymbol[] = [];
	const seen = new Set<string>();
	let path: string | undefined;
	const add = (name: string | undefined) => {
		const key = `${path}|${name}`;
		if (name && path && found.length < max && !seen.has(key)) {
			seen.add(key);
			found.push({ name, path });
		}
	};
	for (const line of diff.split(/\r?\n/)) {
		if (line.startsWith('+++ ')) {
			path = line.startsWith('+++ b/') ? line.slice(6) : undefined;
		} else if (line.startsWith('@@')) {
			add(symbolOf(line.replace(/^@@[^@]*@@/, '')));
		} else if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('---')) {
			add(symbolOf(line.slice(1)));
		}
	}
	return found;
}

/** Every path a diff touches. */
export function claudeDiffPaths(diff: string): Set<string> {
	const paths = new Set<string>();
	for (const line of diff.split(/\r?\n/)) {
		if (line.startsWith('+++ b/')) {
			paths.add(line.slice(6));
		}
	}
	return paths;
}

/**
 * The prompt block for what a change touches beyond its diff: where the changed symbols are used, outside the
 * changed files. The reviewer must cite `file:line`. Cut to `budget`. Undefined when there is nothing to say.
 */
export function buildClaudeReviewContextPack(symbols: readonly ClaudeChangedSymbol[], references: readonly ClaudeContextReference[], changedPaths: ReadonlySet<string>, graphSummary?: string, budget: number = CLAUDE_REVIEW_CONTEXT_BUDGET): ClaudeContextPack | undefined {
	const bySymbol = new Map<string, ClaudeContextReference[]>();
	for (const reference of references) {
		if (changedPaths.has(reference.path)) {
			continue;
		}
		const list = bySymbol.get(reference.symbol) ?? [];
		if (list.length < CLAUDE_REVIEW_CONTEXT_MAX_REFERENCES) {
			list.push(reference);
		}
		bySymbol.set(reference.symbol, list);
	}
	const graph = graphSummary?.trim().slice(0, CLAUDE_REVIEW_CONTEXT_GRAPH_BUDGET);
	if (!bySymbol.size && !graph) {
		return undefined;
	}
	const kept = [...bySymbol.values()].reduce((total, list) => total + list.length, 0);
	const files = new Set([...bySymbol.values()].flat().map(reference => reference.path));
	const summary = kept
		? `Looked at ${kept} reference${kept === 1 ? '' : 's'} to ${bySymbol.size} changed symbol${bySymbol.size === 1 ? '' : 's'} in ${files.size} other file${files.size === 1 ? '' : 's'}`
		: 'Looked at the dependency summary';
	const lines: string[] = ['<impact_context>', `${summary}. These places use symbols this change touched and are not in the diff. If one needs the same change, say so and cite it as file:line.`];
	for (const symbol of symbols) {
		const list = bySymbol.get(symbol.name);
		if (list?.length) {
			lines.push(`Changed \`${symbol.name}\` (${symbol.path}):`);
			for (const reference of list) {
				lines.push(`- ${reference.path}:${reference.line}  ${reference.text.trim().slice(0, 160)}`);
			}
		}
	}
	if (graph) {
		lines.push('Dependency summary (orientation only, may be out of date):', graph);
	}
	lines.push('</impact_context>');
	let text = lines.join('\n');
	if (text.length > budget) {
		text = `${text.slice(0, Math.max(0, budget - '\n</impact_context>'.length))}\n</impact_context>`;
	}
	return { text, summary, referenceCount: kept };
}

/** The review instructions followed by the context pack. */
export function claudeReviewInstructionsWithContext(instructions: string | undefined, pack: ClaudeContextPack | undefined): string | undefined {
	if (!pack) {
		return instructions;
	}
	return instructions ? `${instructions}\n\n${pack.text}` : pack.text;
}
