/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Claude Code's status line in Klawly (issue 515). A `statusLine` in the user's,
 * project's or local Claude settings names a command; Claude Code runs it with a
 * JSON description of the session on stdin and shows the first line it prints.
 * Klawly runs the same command the same way after each turn and shows the line
 * under its composer.
 */

/** Shows Claude Code's status line under the composer when the Claude settings define one. */
export const CLAUDE_STATUS_LINE_ENABLED_SETTING = 'claude.statusLine.enabled';

/** Passes the chat's cost to the status line command; off hides it from lines that print it (issue 1584). */
export const CLAUDE_STATUS_LINE_SHOW_COST_SETTING = 'claude.statusLine.showCost';

/** How long the command may run before Klawly gives up on it. */
export const CLAUDE_STATUS_LINE_TIMEOUT_MS = 5000;

/** Characters of the first line Klawly keeps. */
export const CLAUDE_STATUS_LINE_MAX_CHARS = 500;

/** The `statusLine` entry of a Claude settings file. Only `command` status lines exist. */
export interface ClaudeStatusLineConfig {
	readonly command: string;
	/** Where the entry came from; project and local entries run only in a trusted workspace. */
	readonly scope: 'user' | 'project' | 'local';
}

/** The JSON Claude Code gives a status line command on stdin; Klawly fills what it knows. */
export interface ClaudeStatusLineInput {
	readonly hook_event_name: 'Status';
	readonly session_id?: string;
	readonly cwd: string;
	readonly model?: { readonly id?: string; readonly display_name?: string };
	readonly workspace: { readonly current_dir: string; readonly project_dir: string };
	readonly version?: string;
	readonly cost?: { readonly total_cost_usd: number };
}

export interface ClaudeStatusLineRequest {
	/** The folder the command runs in, and where the project's settings are read. */
	readonly cwd: string;
	/** Project and local settings are read only when the workspace is trusted. */
	readonly trusted: boolean;
	readonly input: ClaudeStatusLineInput;
}

export type ClaudeStatusLineResult =
	/** No `statusLine` in the settings Klawly may read. */
	| { readonly kind: 'none' }
	| { readonly kind: 'line'; readonly text: string }
	| { readonly kind: 'failed'; readonly message: string };

/** The settings files' text by scope; a missing file is undefined. */
export interface ClaudeStatusLineSettingsTexts {
	readonly user?: string;
	readonly project?: string;
	readonly local?: string;
}

/**
 * The `statusLine` Claude Code would use: local wins over project, which wins
 * over user, as in Claude Code's own settings order. Project and local files
 * count only in a trusted workspace, because their command runs on this machine.
 */
export function readClaudeStatusLineConfig(texts: ClaudeStatusLineSettingsTexts, trusted: boolean): ClaudeStatusLineConfig | undefined {
	const scopes: ClaudeStatusLineConfig['scope'][] = trusted ? ['local', 'project', 'user'] : ['user'];
	for (const scope of scopes) {
		const text = texts[scope];
		if (text === undefined) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			continue;
		}
		const entry = typeof parsed === 'object' && parsed !== null ? (parsed as { statusLine?: unknown }).statusLine : undefined;
		if (entry === undefined || entry === null) {
			continue;
		}
		const record = typeof entry === 'object' ? entry as { type?: unknown; command?: unknown } : {};
		if (record.type === 'command' && typeof record.command === 'string' && record.command.trim()) {
			return { command: record.command.trim(), scope };
		}
	}
	return undefined;
}

/** The first non-empty line a status line command printed, cut to {@link CLAUDE_STATUS_LINE_MAX_CHARS}. */
export function claudeStatusLineText(stdout: string): string | undefined {
	const line = stdout.split(/\r?\n/).find(candidate => stripAnsi(candidate).trim().length > 0);
	return line === undefined ? undefined : line.replace(/\s+$/, '').slice(0, CLAUDE_STATUS_LINE_MAX_CHARS);
}

/** One run of text with the same style. `color` is an ANSI index 0 to 15, or a `#rrggbb` the command chose. */
export interface ClaudeStatusLineSegment {
	readonly text: string;
	readonly color?: number | string;
	readonly bold?: true;
	readonly dim?: true;
}

const ESCAPE = /\u001b\[(?<params>[0-9;]*)(?<command>[A-Za-z])/g;

function stripAnsi(text: string): string {
	return text.replace(ESCAPE, '');
}

/**
 * Splits a line at its ANSI color codes (SGR): the 16 colors, their bright forms,
 * 256-color indexes below 16, and 24-bit colors. Other escape codes are dropped.
 */
export function parseClaudeStatusLine(line: string): ClaudeStatusLineSegment[] {
	return parseAnsiLine(line).segments;
}

/** The style an ANSI line ends in, which the next line of the same output starts from. */
export interface AnsiStyle {
	readonly color?: number | string;
	readonly bold?: true;
	readonly dim?: true;
}

/**
 * {@link parseClaudeStatusLine} for one line of a longer output: it starts in
 * `style` and returns the style it ends in, as a terminal carries color across lines.
 */
export function parseAnsiLine(line: string, style: AnsiStyle = {}): { readonly segments: ClaudeStatusLineSegment[]; readonly style: AnsiStyle } {
	const segments: ClaudeStatusLineSegment[] = [];
	let color: number | string | undefined = style.color;
	let bold = !!style.bold;
	let dim = !!style.dim;
	let at = 0;
	const push = (text: string) => {
		if (text) {
			segments.push({ text, ...(color !== undefined ? { color } : {}), ...(bold ? { bold: true as const } : {}), ...(dim ? { dim: true as const } : {}) });
		}
	};
	for (const match of line.matchAll(ESCAPE)) {
		push(line.slice(at, match.index));
		at = match.index + match[0].length;
		if (match.groups!.command !== 'm') {
			continue;
		}
		const codes = match.groups!.params.split(';').map(code => code === '' ? 0 : Number(code));
		for (let i = 0; i < codes.length; i++) {
			const code = codes[i];
			if (code === 0) {
				color = undefined;
				bold = false;
				dim = false;
			} else if (code === 1) {
				bold = true;
			} else if (code === 2) {
				dim = true;
			} else if (code === 22) {
				bold = false;
				dim = false;
			} else if (code >= 30 && code <= 37) {
				color = code - 30;
			} else if (code >= 90 && code <= 97) {
				color = code - 90 + 8;
			} else if (code === 39) {
				color = undefined;
			} else if (code === 38 && codes[i + 1] === 5) {
				const index = codes[i + 2];
				color = index !== undefined && index < 16 ? index : undefined;
				i += 2;
			} else if (code === 38 && codes[i + 1] === 2) {
				const [r, g, b] = codes.slice(i + 2, i + 5);
				color = [r, g, b].every(value => value !== undefined && value >= 0 && value <= 255) ? `#${[r, g, b].map(value => value.toString(16).padStart(2, '0')).join('')}` : undefined;
				i += 4;
			}
		}
	}
	push(line.slice(at));
	return { segments, style: { ...(color !== undefined ? { color } : {}), ...(bold ? { bold: true as const } : {}), ...(dim ? { dim: true as const } : {}) } };
}
