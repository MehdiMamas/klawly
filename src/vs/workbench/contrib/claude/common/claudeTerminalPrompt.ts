/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OperatingSystem } from '../../../../base/common/platform.js';

/** How a shell chains commands; it decides the separator when Claude replies with several lines. */
export type ClaudeTerminalShellFamily = 'posix' | 'pwsh' | 'cmd';

/** What Claude is told about the terminal it writes for. */
export interface ClaudeTerminalContext {
	/** The shell type the terminal reports, e.g. `bash`, `pwsh` or `cmd`. */
	readonly shell: string | undefined;
	readonly os: OperatingSystem | undefined;
	readonly cwd: string | undefined;
}

/** Longest command Klawly inserts; anything longer is not a single command. */
const MAX_COMMAND_LENGTH = 2000;

/** The shell family for a terminal's shell type, falling back to the OS default. */
export function terminalShellFamily(shell: string | undefined, os: OperatingSystem | undefined): ClaudeTerminalShellFamily {
	switch (shell) {
		case 'pwsh':
			return 'pwsh';
		case 'cmd':
			return 'cmd';
		case undefined:
		case '':
			return os === OperatingSystem.Windows ? 'pwsh' : 'posix';
		default:
			return 'posix';
	}
}

/** The prompt that asks Claude for one command and nothing else. */
export function buildTerminalCommandPrompt(instruction: string, context: ClaudeTerminalContext): string {
	return [
		'Write one shell command for the terminal described below.',
		'Reply with the command only, on one line. No explanation, no Markdown, no code fence.',
		'If the request needs several steps, chain them in that one line.',
		...describeTerminal(context),
		`Request: ${instruction.trim()}`,
	].join('\n');
}

/** The prompt for a quick question: a short plain-text answer, nothing is inserted. */
export function buildTerminalQuestionPrompt(question: string, context: ClaudeTerminalContext): string {
	return [
		'Answer a question about working in the terminal described below.',
		'Use at most three short sentences of plain text. Put any command in backticks.',
		...describeTerminal(context),
		`Question: ${question.trim()}`,
	].join('\n');
}

function describeTerminal(context: ClaudeTerminalContext): string[] {
	const lines = [`Shell: ${shellName(context.shell, context.os)}`, `Operating system: ${osName(context.os)}`];
	if (context.cwd) {
		lines.push(`Working directory: ${context.cwd}`);
	}
	return lines;
}

function shellName(shell: string | undefined, os: OperatingSystem | undefined): string {
	switch (shell) {
		case 'pwsh':
			return 'PowerShell';
		case 'cmd':
			return 'Command Prompt (cmd.exe)';
		case 'gitbash':
			return 'Git Bash';
		case 'wsl':
			return 'WSL bash';
		case undefined:
		case '':
			return os === OperatingSystem.Windows ? 'PowerShell' : 'a POSIX shell';
		default:
			return shell;
	}
}

function osName(os: OperatingSystem | undefined): string {
	switch (os) {
		case OperatingSystem.Windows:
			return 'Windows';
		case OperatingSystem.Macintosh:
			return 'macOS';
		case OperatingSystem.Linux:
			return 'Linux';
		default:
			return 'unknown';
	}
}

/**
 * Turns Claude's reply into a single line the terminal can take as input.
 * Fences, prompt markers and comment lines are dropped, several lines are
 * chained, and every control character (including CR and LF) is removed, so
 * the text can be inserted but never runs on its own.
 */
export function parseTerminalCommand(raw: string, family: ClaudeTerminalShellFamily): string | undefined {
	const lines = unfence(raw)
		.split(/\r\n|\r|\n|\u2028|\u2029/)
		.map(line => stripPromptMarker(line.trim()))
		.filter(line => line.length > 0 && !isComment(line, family));
	if (!lines.length) {
		return undefined;
	}
	const command = lines
		.join(family === 'pwsh' ? '; ' : ' && ')
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
		.trim();
	if (!command || command.length > MAX_COMMAND_LENGTH) {
		return undefined;
	}
	return command;
}

/** The body of the first code fence, an inline-code reply without its backticks, or the text as is. */
function unfence(raw: string): string {
	const text = raw.trim();
	const fence = /```[^\n`]*\n(?<body>[\s\S]*?)(?:```|$)/.exec(text);
	if (fence?.groups) {
		return fence.groups.body;
	}
	const inline = /^`(?<body>[^`\n]+)`$/.exec(text);
	return inline?.groups ? inline.groups.body : text;
}

function stripPromptMarker(line: string): string {
	return line
		.replace(/^\$\s+/, '')
		.replace(/^PS(?: [^>\n]*)?>\s*/, '')
		.replace(/^[A-Za-z]:\\[^>\n]*>\s*/, '');
}

function isComment(line: string, family: ClaudeTerminalShellFamily): boolean {
	if (family === 'cmd') {
		return /^(?:rem\b|::)/i.test(line);
	}
	return line.startsWith('#');
}

/**
 * How far the terminal output moves up so the cursor's line ends above the
 * card docked under it, as if the card took its own room in the panel. Zero
 * while the rows below the cursor already leave room for the card.
 */
export function terminalOutputLift(cursorRow: number, rows: number, cellHeight: number, cardSpace: number): number {
	return Math.max(0, Math.ceil(cardSpace - (rows - cursorRow - 1) * cellHeight));
}

/** A terminal selection in buffer cells, 0-based; the end column is exclusive. */
export interface TerminalSelectionCells {
	readonly startColumn: number;
	readonly startRow: number;
	readonly endColumn: number;
	readonly endRow: number;
}

/** The terminal screen the selection bar floats over, in rows and pixels. */
export interface TerminalSelectionScreen {
	/** The first buffer row in view. */
	readonly viewportY: number;
	readonly rows: number;
	readonly cellWidth: number;
	readonly cellHeight: number;
	readonly width: number;
}

/**
 * Where the floating Add to Agent bar sits for a terminal selection, in pixels
 * from the top left of the terminal screen: above the first selected row at
 * the selection's start when there is room, otherwise under the last selected
 * row, otherwise over the top of the part in view. Nowhere when no selected
 * row is in view.
 */
export function terminalSelectionBarPlace(selection: TerminalSelectionCells, screen: TerminalSelectionScreen, barWidth: number, barHeight: number): { top: number; left: number } | undefined {
	const first = selection.startRow - screen.viewportY;
	// A selection that ends at the start of a row really ends on the row before.
	const endRow = selection.endColumn === 0 && selection.endRow > selection.startRow ? selection.endRow - 1 : selection.endRow;
	const last = endRow - screen.viewportY;
	if (last < 0 || first >= screen.rows) {
		return undefined;
	}
	const left = Math.max(0, Math.min(first >= 0 ? selection.startColumn * screen.cellWidth : 0, screen.width - barWidth));
	if (first >= 0 && first * screen.cellHeight >= barHeight) {
		return { top: first * screen.cellHeight - barHeight, left };
	}
	if (last < screen.rows && (last + 1) * screen.cellHeight + barHeight <= screen.rows * screen.cellHeight) {
		return { top: (last + 1) * screen.cellHeight, left };
	}
	return { top: Math.max(0, first) * screen.cellHeight, left };
}
