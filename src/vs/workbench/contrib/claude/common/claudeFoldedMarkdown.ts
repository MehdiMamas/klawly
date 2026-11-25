/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A run of plain Markdown in a reply. */
export interface ClaudeMarkdownRun {
	readonly kind: 'markdown';
	readonly text: string;
}

/** A `<details>` section in a reply: the chat draws it collapsed, with its summary as the label. */
export interface ClaudeFoldedSection {
	readonly kind: 'details';
	/** The `<summary>` text with its tags removed. Empty when the section has none. */
	readonly summary: string;
	/** The Markdown inside the section, after the summary. It may hold more sections. */
	readonly body: string;
	/** The section was written `<details open>`. */
	readonly open: boolean;
	/** False while a streaming reply has not closed the section yet. */
	readonly closed: boolean;
}

export type ClaudeMarkdownSegment = ClaudeMarkdownRun | ClaudeFoldedSection;

const OPEN_AT_LINE_START = /^[ \t]*<details(?<open>\s+open)?\s*>/i;
const TAG = /<details(?:\s+open)?\s*>|<\/details\s*>/gi;
const FENCE = /^[ \t]*(?<marks>`{3,}|~{3,})/;
const SUMMARY = /^\s*<summary>(?<summary>[\s\S]*?)<\/summary>[ \t]*\n?/i;

/**
 * Splits a reply into Markdown runs and `<details>` sections (issue 462). The Markdown renderer
 * drops raw HTML from Claude's replies, so without this a folded section would show its detail
 * inline. Only a `<details>` tag that starts a line outside a code fence opens a section; nested
 * sections stay in the body, which the chat splits again when it draws it.
 */
export function splitClaudeFoldedMarkdown(text: string): ClaudeMarkdownSegment[] {
	if (!/<details/i.test(text)) {
		return [{ kind: 'markdown', text }];
	}
	const segments: ClaudeMarkdownSegment[] = [];
	let markdown = '';
	let body = '';
	let open = false;
	let depth = 0;
	let fence: string | undefined;
	const add = (line: string) => {
		if (depth) {
			body += line;
		} else {
			markdown += line;
		}
	};
	const pushMarkdown = () => {
		if (markdown.trim().length > 0) {
			segments.push({ kind: 'markdown', text: markdown });
		}
		markdown = '';
	};
	const pushSection = (closed: boolean) => {
		const summary = SUMMARY.exec(body);
		segments.push({
			kind: 'details',
			summary: summary?.groups?.summary.replace(/<[^>]*>/g, '').trim() ?? '',
			body: summary ? body.slice(summary[0].length) : body,
			open,
			closed,
		});
		body = '';
	};
	for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
		const marks = FENCE.exec(line)?.groups?.marks;
		if (fence) {
			if (marks && marks[0] === fence[0] && marks.length >= fence.length && line.trim() === marks) {
				fence = undefined;
			}
			add(line);
			continue;
		}
		if (marks) {
			fence = marks;
			add(line);
			continue;
		}
		let rest = line;
		if (!depth) {
			const opening = OPEN_AT_LINE_START.exec(rest);
			if (!opening) {
				markdown += rest;
				continue;
			}
			pushMarkdown();
			open = !!opening.groups?.open;
			depth = 1;
			rest = rest.slice(opening[0].length).replace(/^[ \t]*\n/, '');
		}
		TAG.lastIndex = 0;
		let start = 0;
		for (let tag = TAG.exec(rest); tag; tag = TAG.exec(rest)) {
			depth += tag[0][1] === '/' ? -1 : 1;
			if (depth === 0) {
				body += rest.slice(start, tag.index);
				pushSection(true);
				start = tag.index + tag[0].length;
				break;
			}
		}
		if (depth) {
			body += rest.slice(start);
		} else {
			markdown += rest.slice(start).replace(/^[ \t]*\n/, '');
		}
	}
	if (depth) {
		pushSection(false);
	}
	pushMarkdown();
	return segments;
}
