/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The in-process MCP server that carries Klawly's own tools into a Claude Code session. */
export const CLAUDE_KLAWLY_MCP_SERVER = 'klawly';

/** The tool that runs an interactive command in a visible terminal (issue 452). */
export const CLAUDE_TERMINAL_TOOL = 'run_in_terminal';

/** The name Claude Code gives the tool: `mcp__<server>__<tool>`. */
export const CLAUDE_TERMINAL_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_TERMINAL_TOOL}`;

/** What Claude reads before it picks the tool. */
export const CLAUDE_TERMINAL_TOOL_DESCRIPTION = [
	'Runs a command in a visible Klawly terminal so the user can type into it, and waits until the command exits.',
	'Use it instead of Bash for any command that needs the user: sign-ins (gh auth login, npm login, az login, gcloud auth login, aws sso login, docker login),',
	'a first ssh connection, sudo, password or passphrase prompts, y/n confirmations, and anything else that asks for input or opens a browser to sign in.',
	'Bash has no keyboard input, so those commands hang or fail there.',
	'Before you call it, tell the user what to do in the terminal, for example "Finish signing in to GitHub in the terminal below. I\'ll continue when you\'re done."',
	'The result gives the exit code and the last lines of output, or says the user cancelled. Continue the task from it; do not ask the user whether they are done.',
	'If the command failed or the user cancelled, say so and do not run it again unless the user asks.',
].join(' ');

/** Shown to Claude as the MCP server's instructions. */
export const CLAUDE_KLAWLY_MCP_INSTRUCTIONS = `Tools from Klawly, the IDE this session runs in. For an interactive command (a sign-in, sudo, a password prompt, a confirmation), call ${CLAUDE_TERMINAL_TOOL} instead of Bash. For the chat mode, permission level and reply style, call klawly_mode. For CI, tests, merges and helper sessions use Klawly's ci_wait, verify, merge_gate and klawly_delegate; the session-manager copies are switched off. To tell the user one short thing on the chat tab without a reply, call klawly_status. To send something to the Klawly team as feedback, call klawly_feedback: it only opens the Send Feedback form filled in, and the user sends it.`;
/** A command waiting for the window that owns the session to run it in a terminal. */
export interface ClaudeTerminalRunRequest {
	readonly sessionId: string;
	/** Id `resolveTerminalRun` answers with. */
	readonly requestId: string;
	readonly command: string;
	/** What Claude told the user to do, shown on the chat card. */
	readonly reason?: string;
	readonly cwd: string;
}

/** How a terminal run ended. Every outcome goes back to Claude as a tool result. */
export type ClaudeTerminalRunResult =
	| { readonly kind: 'exited'; readonly exitCode: number; readonly lastOutput: string }
	| { readonly kind: 'cancelled'; readonly lastOutput?: string }
	| { readonly kind: 'failed'; readonly message: string };

/** How many lines from the end of the terminal Claude reads back. */
export const CLAUDE_TERMINAL_OUTPUT_LINES = 40;

/** Upper bound for the text Claude reads back, from the end. */
export const CLAUDE_TERMINAL_OUTPUT_CHARS = 4000;

/**
 * The last lines of a terminal, from an iterator that walks the buffer from the
 * bottom up. Blank lines at the end are dropped; at most `maxLines` lines and
 * `maxChars` characters are kept, from the end.
 */
export function claudeTerminalLastOutput(linesFromBottom: Iterable<string>, maxLines = CLAUDE_TERMINAL_OUTPUT_LINES, maxChars = CLAUDE_TERMINAL_OUTPUT_CHARS): string {
	const lines: string[] = [];
	for (const line of linesFromBottom) {
		const trimmed = line.trimEnd();
		if (lines.length === 0 && trimmed.length === 0) {
			continue;
		}
		lines.push(trimmed);
		if (lines.length >= maxLines) {
			break;
		}
	}
	const text = lines.reverse().join('\n');
	return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

/** The tool result Claude reads. A failure or a cancel is an error result, so Claude does not treat it as done. */
export function claudeTerminalToolResult(command: string, result: ClaudeTerminalRunResult): { readonly text: string; readonly isError: boolean } {
	const output = (lastOutput: string | undefined) => lastOutput ? `\nLast output:\n${lastOutput}` : '\nThe terminal showed no output.';
	switch (result.kind) {
		case 'exited':
			return {
				text: `\`${command}\` ended with exit code ${result.exitCode}.${output(result.lastOutput)}`,
				isError: result.exitCode !== 0,
			};
		case 'cancelled':
			return {
				text: `The user cancelled \`${command}\` before it finished. Do not run it again unless the user asks.${output(result.lastOutput)}`,
				isError: true,
			};
		case 'failed':
			return { text: `Klawly could not run \`${command}\` in a terminal: ${result.message}`, isError: true };
	}
}

/**
 * Arguments that make `shell` run one command and exit with its status, by the
 * shell's file name. A POSIX-style `-c` is the fallback.
 */
export function claudeTerminalShellArgs(shell: string, command: string): string[] {
	const name = shell.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.exe$/, '');
	if (name === 'pwsh' || name === 'powershell') {
		return ['-NoLogo', '-Command', command];
	}
	if (name === 'cmd') {
		return ['/d', '/s', '/c', command];
	}
	return ['-c', command];
}

/**
 * The tool call the permission policy sees. The terminal tool runs a shell
 * command, so it gets the same rules as Bash; every other call is unchanged.
 */
export function claudePolicyToolCall(toolName: string, input: Record<string, unknown>): { readonly toolName: string; readonly input: Record<string, unknown> } {
	if (toolName !== CLAUDE_TERMINAL_TOOL_ID) {
		return { toolName, input };
	}
	const command = typeof input.command === 'string' ? input.command : '';
	return { toolName: 'Bash', input: typeof input.reason === 'string' ? { command, description: input.reason } : { command } };
}
