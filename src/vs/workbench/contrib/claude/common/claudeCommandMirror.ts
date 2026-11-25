/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { NormalizedClaudeEvent } from '../../../../platform/claude/common/claudeProtocol.js';
import { CLAUDE_TERMINAL_TOOL_ID } from '../../../../platform/claude/common/claudeTerminalRun.js';

/** Claude Code's `task_type` for a shell command it moved to the background. */
const BACKGROUND_SHELL_TYPE = 'local_bash';

/** Tools that read a background command's output. */
const OUTPUT_TOOLS = new Set(['BashOutput', 'TaskOutput']);

/** Most output one command writes to the terminal; the chat card keeps all of it. */
const MAX_OUTPUT = 100_000;

/** Most text the mirror keeps for a terminal opened later. */
const MAX_HISTORY = 400_000;

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

/** True for a background shell command: a command, not a subagent or a chat (issue 1257). */
export function isBackgroundCommand(agentType: string): boolean {
	return agentType === BACKGROUND_SHELL_TYPE;
}

/** Minutes a background command runs before its row offers Stop as the main action (issue 1247). */
export const STUCK_COMMAND_MINUTES = 5;

/**
 * "Still running for 7 min" once a background command has run past the
 * threshold, else undefined (issue 1247). Only running commands qualify.
 */
export function describeStillRunning(elapsedMs: number, thresholdMinutes: number = STUCK_COMMAND_MINUTES): string | undefined {
	const minutes = Math.floor(elapsedMs / 60_000);
	return minutes >= thresholdMinutes ? localize('claudeStillRunning', "Still running for {0} min", minutes) : undefined;
}

/**
 * The words for a subagent row's kind: background shells say what they are
 * instead of Claude Code's `local_bash` (issue 742). Other kinds keep their name.
 */
export function claudeSubagentKindLabel(agentType: string): string {
	return agentType === BACKGROUND_SHELL_TYPE ? localize('claudeBackgroundCommand', "Background command") : localize('claudeSubagentKind', "Subagent ({0})", agentType);
}

interface MirroredCommand {
	readonly command: string;
	readonly background: boolean;
}

/**
 * Turns Claude's shell tool events into terminal text (issue 742): each command
 * as `$ command`, its output, and whether it finished, failed or went to the
 * background, under the chat's name. It keeps the text, so a terminal opened
 * later shows what already ran.
 */
export class ClaudeCommandMirror {
	private readonly _commands = new Map<string, MirroredCommand>();
	private readonly _outputReads = new Set<string>();
	private _lastChat: string | undefined;
	private _history = '';

	/** Everything written so far, at most {@link MAX_HISTORY} characters. */
	get history(): string {
		return this._history;
	}

	/** The text for one event, or '' when the event is not about a shell command. */
	accept(event: NormalizedClaudeEvent, chatTitle: string | undefined): string {
		const text = this.format(event, chatTitle);
		if (text) {
			this._history = (this._history + text).slice(-MAX_HISTORY);
		}
		return text;
	}

	private format(event: NormalizedClaudeEvent, chatTitle: string | undefined): string {
		switch (event.type) {
			case 'tool.started': {
				const call = event.call;
				if (OUTPUT_TOOLS.has(call.name)) {
					this._outputReads.add(call.id);
					return '';
				}
				// run_in_terminal already runs in a terminal of its own (issue 452).
				if (call.category !== 'shell' || call.name === CLAUDE_TERMINAL_TOOL_ID) {
					return '';
				}
				const input = (call.input ?? {}) as { command?: unknown; description?: unknown; run_in_background?: unknown };
				const command = typeof input.command === 'string' ? input.command : call.display.command ?? '';
				if (!command.trim()) {
					return '';
				}
				const background = input.run_in_background === true;
				this._commands.set(call.id, { command, background });
				const description = typeof input.description === 'string' ? input.description.trim() : '';
				return this.chatHeader(chatTitle)
					+ (description ? `${DIM}# ${oneLine(description)}${RESET}\r\n` : '')
					+ `${BOLD}$ ${terminalText(command)}${RESET}\r\n`;
			}
			case 'tool.completed': {
				if (this._outputReads.delete(event.callId)) {
					const output = (event.result.output ?? '').trimEnd();
					return output ? `${DIM}# ${localize('claudeMirrorBackgroundOutput', "Output of a background command")}${RESET}\r\n${terminalText(clip(output))}\r\n` : '';
				}
				const command = this._commands.get(event.callId);
				if (!command) {
					return '';
				}
				if (!command.background) {
					this._commands.delete(event.callId);
				}
				const output = (event.result.ok ? event.result.output ?? '' : event.result.error ?? event.result.output ?? '').trimEnd();
				const status = command.background
					? `${DIM}[${localize('claudeMirrorInBackground', "running in the background")}]${RESET}`
					: event.result.ok
						? `${GREEN}[${localize('claudeMirrorDone', "done")}]${RESET}`
						: `${RED}[${localize('claudeMirrorFailed', "failed")}]${RESET}`;
				return `${output ? `${terminalText(clip(output))}\r\n` : ''}${status}\r\n\r\n`;
			}
			case 'subagent.started': {
				// Claude Code moved a running command to the background: the run's id is the Bash call's.
				const command = this._commands.get(event.run.id);
				if (event.run.agentType !== BACKGROUND_SHELL_TYPE || !command || command.background) {
					return '';
				}
				this._commands.set(event.run.id, { ...command, background: true });
				return `${DIM}[${localize('claudeMirrorMovedToBackground', "moved to the background")}]${RESET}\r\n`;
			}
			case 'subagent.finished': {
				const command = this._commands.get(event.runId);
				if (!command?.background) {
					return '';
				}
				this._commands.delete(event.runId);
				const failed = event.state === 'failed';
				const status = failed
					? `${RED}[${localize('claudeMirrorBackgroundFailed', "background command failed")}]${RESET}`
					: event.state === 'stopped'
						? `${DIM}[${localize('claudeMirrorBackgroundStopped', "background command stopped")}]${RESET}`
						: `${GREEN}[${localize('claudeMirrorBackgroundDone', "background command finished")}]${RESET}`;
				return `${this.chatHeader(chatTitle)}${DIM}$ ${oneLine(command.command)}${RESET}\r\n${status}\r\n\r\n`;
			}
			default:
				return '';
		}
	}

	/** The chat's name, once each time another chat starts writing. */
	private chatHeader(chatTitle: string | undefined): string {
		const title = chatTitle?.trim() || localize('claudeMirrorChat', "Chat");
		if (title === this._lastChat) {
			return '';
		}
		this._lastChat = title;
		return `${DIM}# ${localize('claudeMirrorChatHeader', "Claude in {0}", oneLine(title))}${RESET}\r\n`;
	}
}

/** Line breaks a terminal draws as new lines. */
function terminalText(text: string): string {
	return text.replace(/\r?\n/g, '\r\n');
}

function oneLine(text: string): string {
	return text.replace(/\s*\r?\n\s*/g, ' ');
}

/** The end of a long output, which holds the result and the error. */
function clip(text: string): string {
	if (text.length <= MAX_OUTPUT) {
		return text;
	}
	const skipped = text.length - MAX_OUTPUT;
	return `${DIM}${localize('claudeMirrorClipped', "({0} earlier characters are in the chat)", skipped)}${RESET}\n${text.slice(-MAX_OUTPUT)}`;
}
