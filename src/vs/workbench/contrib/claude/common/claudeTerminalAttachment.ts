/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ContextAttachment } from '../../../../platform/claude/common/claudeContext.js';

/** Lines of the buffer's tail the agent gets when the terminal knows no command boundaries. */
export const CLAUDE_TERMINAL_TAIL_LINES = 200;

/** Longest command a chip names before it is cut. */
const MAX_TITLE = 60;

/** What a terminal offers to the agent when the user picks Add to Agent there (issue 734). */
export interface ClaudeTerminalCapture {
	readonly terminalId: number;
	readonly terminalTitle: string;
	/** The selected text, if any. */
	readonly selection?: string;
	/** The last finished command and its output, from shell integration. */
	readonly lastCommand?: { readonly command: string; readonly output: string };
}

/**
 * The attachment for a terminal: the selection when there is one, else the last
 * command with its output, else the tail of the buffer when shell integration is off.
 */
export function claudeTerminalAttachment(capture: ClaudeTerminalCapture): ContextAttachment {
	const terminalTitle = capture.terminalTitle || localize('claudeTerminalChip', "Terminal");
	const selection = capture.selection?.replace(/\s+$/, '');
	if (selection) {
		return {
			kind: 'terminal',
			terminalId: capture.terminalId,
			lines: lineCount(selection),
			title: localize('claudeTerminalSelectionTitle', "{0} selection", terminalTitle),
			text: selection,
		};
	}
	const last = capture.lastCommand;
	if (last && (last.command.trim() || last.output.trim())) {
		const command = last.command.trim();
		const output = last.output.replace(/\s+$/, '');
		const text = command ? `$ ${command}${output ? `\n${output}` : ''}` : output;
		return {
			kind: 'terminal',
			terminalId: capture.terminalId,
			lines: lineCount(text),
			title: command ? shortTitle(command) : terminalTitle,
			text,
		};
	}
	return { kind: 'terminal', terminalId: capture.terminalId, lines: CLAUDE_TERMINAL_TAIL_LINES, title: terminalTitle };
}

function lineCount(text: string): number {
	return text.split('\n').length;
}

function shortTitle(command: string): string {
	const line = command.split(/\r?\n/, 1)[0];
	// allow-any-unicode-next-line
	return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
}
