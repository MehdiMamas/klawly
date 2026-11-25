/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_KLAWLY_MCP_SERVER } from './claudeTerminalRun.js';

/**
 * Canvas (issue 493): a live page beside the chat for a dashboard, an audit or a
 * table. Claude calls `klawly_canvas` on Klawly's own MCP server with one
 * self-contained HTML file; the runtime saves it under
 * `~/<data folder>/canvases/<session>/<name>.html` and the window opens it in a
 * Canvas tab that runs it sealed: no network, no workbench access. Calling the
 * tool again with the same name rewrites the file and the tab reloads.
 */
export const CLAUDE_CANVAS_TOOL = 'klawly_canvas';
export const CLAUDE_CANVAS_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_CANVAS_TOOL}`;

/** The folder under the data folder where canvases are saved, one subfolder per session. */
export const CLAUDE_CANVAS_FOLDER = 'canvases';

/** The largest page a canvas saves. A larger one is refused, so a runaway turn cannot fill the disk. */
export const CLAUDE_CANVAS_MAX_BYTES = 2 * 1024 * 1024;

export const CLAUDE_CANVAS_TOOL_DESCRIPTION = 'Show the user a live page beside the chat, such as a dashboard, an audit, a chart or a sortable table built from real data you gathered. Give one self-contained HTML file: inline CSS and JavaScript only. The page runs with no network, so it cannot load scripts, styles, fonts or images from anywhere (data: URIs work), and it cannot fetch data: put the data in the page. Klawly saves the file and opens it in a Canvas tab. To refresh the page later, call this tool again with the same name; the open tab reloads.';

/** What Claude passes to `klawly_canvas`. */
export interface ClaudeCanvasToolArgs {
	/** A short name for the file, such as "slow-tests". The same name updates the same canvas. */
	readonly name: string;
	/** The tab title. Defaults to the name. */
	readonly title?: string;
	readonly html: string;
}

export type ClaudeCanvasToolResult =
	| { readonly kind: 'saved'; readonly path: string; readonly name: string; readonly title: string; readonly updated: boolean }
	| { readonly kind: 'failed'; readonly message: string };

/** The longest file name a canvas gets, before `.html`. */
const NAME_MAX_LENGTH = 60;
/** The longest tab title a canvas keeps. */
const TITLE_MAX_LENGTH = 120;

const FILE_LINE = 'Canvas file: ';
const TITLE_LINE = 'Canvas title: ';

/**
 * The file name a canvas name saves to: lowercase letters, digits and dashes,
 * so the name never leaves the session's folder. Undefined when nothing is left.
 */
export function claudeCanvasFileName(name: string): string | undefined {
	const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, NAME_MAX_LENGTH).replace(/-+$/, '');
	return slug ? `${slug}.html` : undefined;
}

/** The tab title for a canvas: the title Claude gave on one line, else the name. */
export function claudeCanvasTitle(args: Pick<ClaudeCanvasToolArgs, 'name' | 'title'>): string {
	const title = (args.title ?? '').replace(/\s+/g, ' ').trim() || args.name.replace(/\s+/g, ' ').trim();
	return title.length > TITLE_MAX_LENGTH ? `${title.slice(0, TITLE_MAX_LENGTH - 1)}…` : title;
}

/** Why the arguments cannot become a canvas, or undefined when they can. */
export function claudeCanvasArgsProblem(args: ClaudeCanvasToolArgs): string | undefined {
	if (!claudeCanvasFileName(args.name)) {
		return 'Give the canvas a name with letters or digits, such as "slow-tests".';
	}
	if (!args.html.trim()) {
		return 'Give the HTML of the page.';
	}
	if (new TextEncoder().encode(args.html).byteLength > CLAUDE_CANVAS_MAX_BYTES) {
		return `The page is larger than ${CLAUDE_CANVAS_MAX_BYTES / (1024 * 1024)} MB. Show less data, or summarize it.`;
	}
	return undefined;
}

/**
 * The text Claude reads back. Its first two lines name the file and the title, so
 * the window that draws the call can open the canvas (see `readClaudeCanvasResult`).
 */
export function claudeCanvasToolText(result: ClaudeCanvasToolResult): { readonly text: string; readonly isError: boolean } {
	if (result.kind === 'failed') {
		return { text: result.message, isError: true };
	}
	return {
		text: [
			`${FILE_LINE}${result.path}`,
			`${TITLE_LINE}${result.title}`,
			result.updated
				? `Klawly updated the canvas and reloaded its tab. Call ${CLAUDE_CANVAS_TOOL} again with the name "${result.name}" to change it.`
				: `Klawly opened the canvas beside the chat. Call ${CLAUDE_CANVAS_TOOL} again with the name "${result.name}" to update it.`,
		].join('\n'),
		isError: false,
	};
}

/** The saved canvas a `klawly_canvas` result names, or undefined when it saved none. */
export function readClaudeCanvasResult(text: string | undefined): { readonly path: string; readonly title: string } | undefined {
	const lines = (text ?? '').split(/\r?\n/);
	const path = lines[0]?.startsWith(FILE_LINE) ? lines[0].slice(FILE_LINE.length).trim() : '';
	if (!/\.html$/i.test(path)) {
		return undefined;
	}
	const title = lines[1]?.startsWith(TITLE_LINE) ? lines[1].slice(TITLE_LINE.length).trim() : '';
	return { path, title: title || path.replace(/^.*[\\/]/, '').replace(/\.html$/i, '') };
}
