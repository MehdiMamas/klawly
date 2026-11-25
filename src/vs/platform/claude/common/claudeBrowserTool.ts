/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_KLAWLY_MCP_SERVER } from './claudeTerminalRun.js';

/**
 * Claude opens and drives a browser in Klawly (issue 466). One tool on Klawly's own
 * MCP server, `klawly_browser`, with an action per step: open a page, navigate,
 * click, type, scroll, read the page (text, DOM or accessibility tree), read the
 * console and the network, run JavaScript, resize the viewport and take a screenshot.
 * The window that owns the chat runs the action in an editor tab beside the chat,
 * in a separate browser profile, so the user watches and can take over.
 */
export const CLAUDE_BROWSER_TOOL = 'klawly_browser';
export const CLAUDE_BROWSER_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_BROWSER_TOOL}`;

export const CLAUDE_BROWSER_DESCRIPTION = 'Open and drive a web page in the Agent Browser, a tab beside the chat that the user can watch and take over. Actions: open (url), navigate (url), click (selector or text), type (selector, text, optional submit), scroll (x, y or selector), snapshot (the page as an accessibility tree, or html for the DOM), console (logged messages and errors since the last read), network (requests since the last read), evaluate (JavaScript expression), resize (width, height), screenshot, close. localhost pages are allowed; other sites follow the network allow list. Use it to check a change in the running app: open the page, read the console, fix the code, then take a screenshot to verify.';

/** The actions of the browser tool. */
export const CLAUDE_BROWSER_ACTIONS = ['open', 'navigate', 'click', 'type', 'scroll', 'snapshot', 'console', 'network', 'evaluate', 'resize', 'screenshot', 'close'] as const;
export type ClaudeBrowserAction = typeof CLAUDE_BROWSER_ACTIONS[number];

/** The arguments of one browser tool call. Which fields apply depends on the action. */
export interface ClaudeBrowserToolArgs {
	readonly action: ClaudeBrowserAction;
	readonly url?: string;
	readonly selector?: string;
	readonly text?: string;
	readonly submit?: boolean;
	readonly x?: number;
	readonly y?: number;
	readonly width?: number;
	readonly height?: number;
	readonly expression?: string;
	/** For snapshot: `html` returns the DOM instead of the accessibility tree. */
	readonly format?: 'tree' | 'html';
	/** For console and network: keep the entries instead of clearing them after the read. */
	readonly keep?: boolean;
}

/** A browser request sent to the window that owns the chat. */
export type ClaudeBrowserToolRequest = ClaudeBrowserToolArgs & {
	readonly sessionId: string;
	readonly requestId: string;
};

/** A screenshot taken by the tool, as base64 PNG or JPEG. */
export interface ClaudeBrowserImage {
	readonly mimeType: 'image/png' | 'image/jpeg';
	readonly data: string;
}

export type ClaudeBrowserToolResult =
	| { readonly kind: 'done'; readonly text: string; readonly image?: ClaudeBrowserImage }
	| { readonly kind: 'refused'; readonly message: string }
	| { readonly kind: 'failed'; readonly message: string };

/** Most characters one read returns, so a big DOM cannot flood the context. */
export const CLAUDE_BROWSER_TEXT_LIMIT = 30_000;

/** Whether a URL is on this machine, where the browser tool needs no allow-list entry. */
export function isClaudeBrowserLocalUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return false;
	}
	const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
	return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
}

/** Cuts text to the limit and says so. */
export function clipClaudeBrowserText(text: string, limit: number = CLAUDE_BROWSER_TEXT_LIMIT): string {
	return text.length > limit ? `${text.slice(0, limit)}\n[cut: ${text.length - limit} more characters]` : text;
}

/** The text and error flag the tool call returns to Claude. */
export function claudeBrowserToolText(result: ClaudeBrowserToolResult): { readonly text: string; readonly isError: boolean } {
	switch (result.kind) {
		case 'done': return { text: clipClaudeBrowserText(result.text), isError: false };
		case 'refused': return { text: result.message, isError: true };
		case 'failed': return { text: `The browser could not do that: ${result.message}`, isError: true };
	}
}

/** The first localhost address in a line of terminal output, such as a dev server's "Local: http://localhost:5173/". */
export function findClaudeBrowserLocalUrl(line: string): string | undefined {
	for (const match of line.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s"'<>)\]\u001b]*)?/gi)) {
		const url = match[0].replace(/[.,;:]+$/, '').replace('0.0.0.0', 'localhost');
		if (isClaudeBrowserLocalUrl(url)) {
			return url;
		}
	}
	return undefined;
}
