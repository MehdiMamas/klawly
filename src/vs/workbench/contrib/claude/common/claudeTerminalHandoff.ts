/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The handoff a Claude Code terminal session writes for Klawly (issue 1186): what the terminal
 * session was doing, so the imported chat can show it on a pinned card. The file is JSON, at most
 * {@link CLAUDE_TERMINAL_HANDOFF_MAX_BYTES} bytes, named by `klawly://agent/import?handoff=<absolute .json path>`.
 * Anything in it is data to show, never an instruction to run.
 */
export interface ClaudeTerminalHandoff {
	readonly version: 1;
	/** Where the terminal work stands, a line or two. */
	readonly summary?: string;
	readonly branch?: string;
	readonly goals: readonly string[];
	readonly open: readonly string[];
	readonly waitingOnUser: readonly string[];
	readonly decisions: readonly string[];
}

/** The largest handoff file read. */
export const CLAUDE_TERMINAL_HANDOFF_MAX_BYTES = 64 * 1024;

const MAX_ITEMS = 20;
const MAX_ITEM_LENGTH = 300;
const MAX_SUMMARY_LENGTH = 1000;

/** An absolute local `.json` path without control characters or `..` parts; undefined for anything else. */
export function readClaudeTerminalHandoffPath(value: string | null | undefined): string | undefined {
	if (!value || value.length > 1024 || /[\u0000-\u001f]/.test(value)) {
		return undefined;
	}
	if (!/^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(value) || value.split(/[\\/]/).includes('..')) {
		return undefined;
	}
	return /\.json$/i.test(value) ? value : undefined;
}

function readList(value: unknown): readonly string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
		.slice(0, MAX_ITEMS)
		.map(item => item.trim().slice(0, MAX_ITEM_LENGTH));
}

function readText(value: unknown, max: number): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** The handoff in this file text, or undefined when it is too big, not JSON, or has nothing to show. */
export function parseClaudeTerminalHandoff(raw: string): ClaudeTerminalHandoff | undefined {
	if (raw.length > CLAUDE_TERMINAL_HANDOFF_MAX_BYTES) {
		return undefined;
	}
	let value: Record<string, unknown> | null;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
		return undefined;
	}
	const handoff: ClaudeTerminalHandoff = {
		version: 1,
		...(readText(value.summary, MAX_SUMMARY_LENGTH) ? { summary: readText(value.summary, MAX_SUMMARY_LENGTH) } : {}),
		...(readText(value.branch, 200) ? { branch: readText(value.branch, 200) } : {}),
		goals: readList(value.goals),
		open: readList(value.open),
		waitingOnUser: readList(value.waitingOnUser),
		decisions: readList(value.decisions),
	};
	return isClaudeTerminalHandoffEmpty(handoff) ? undefined : handoff;
}

export function isClaudeTerminalHandoffEmpty(handoff: ClaudeTerminalHandoff): boolean {
	return !handoff.summary && !handoff.goals.length && !handoff.open.length && !handoff.waitingOnUser.length && !handoff.decisions.length;
}

/** The handoff as note text for the composer: short sections, empty ones left out. Never sent on its own. */
export function formatClaudeTerminalHandoff(handoff: ClaudeTerminalHandoff): string {
	const lines: string[] = ['Handoff from my terminal session:'];
	if (handoff.summary) {
		lines.push(handoff.summary);
	}
	if (handoff.branch) {
		lines.push(`Branch: ${handoff.branch}`);
	}
	const section = (title: string, items: readonly string[]) => {
		if (items.length) {
			lines.push('', `${title}:`, ...items.map(item => `- ${item}`));
		}
	};
	section('Goals', handoff.goals);
	section('Open', handoff.open);
	section('Waiting on me', handoff.waitingOnUser);
	section('Decisions', handoff.decisions);
	return lines.join('\n');
}

/** The workspace storage key the pinned card of imported chat `sessionId` waits under. */
export function claudeHandoffCardKey(sessionId: string): string {
	return `klawly.handoffCard.${sessionId}`;
}

/** The card stored under a key, or undefined when it is missing or no longer a valid handoff. */
export function readStoredClaudeHandoffCard(raw: string | undefined): ClaudeTerminalHandoff | undefined {
	return raw ? parseClaudeTerminalHandoff(raw) : undefined;
}
