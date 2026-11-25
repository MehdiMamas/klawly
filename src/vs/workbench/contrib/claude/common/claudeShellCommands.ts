/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Fence languages whose code runs in a shell (issue 733). */
const SHELL_LANGUAGES = new Set(['sh', 'bash', 'zsh', 'fish', 'shell', 'shellscript', 'console', 'shell-session', 'shellsession', 'terminal', 'powershell', 'pwsh', 'ps1', 'ps', 'cmd', 'bat', 'batch']);

/** Fence languages that show a session: commands behind a prompt, then their output. */
const SESSION_LANGUAGES = new Set(['console', 'shell-session', 'shellsession', 'terminal']);

/** A prompt in front of a command: `$ `, `% ` or `PS C:\repo> `. A bare `> ` is not one: npm prints it before a script. */
const PROMPT = /^\s*(?:PS [^>]*>|[$%])\s+/;

/**
 * Programs whose name starts an inline command Claude suggests, such as
 * `npm run lint && npm test` or `kill 8284`. Inline code that starts with
 * anything else stays plain code, so names and values never look runnable.
 */
const COMMAND_PROGRAMS = new Set([
	'npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx', 'deno', 'node', 'tsc', 'vite', 'next', 'turbo', 'nx',
	'git', 'gh', 'cd', 'ls', 'mkdir', 'rm', 'cp', 'mv', 'cat', 'touch', 'chmod', 'echo', 'export', 'source',
	'python', 'python3', 'pip', 'pip3', 'uv', 'poetry', 'pytest', 'ruff',
	'cargo', 'rustup', 'go', 'make', 'cmake', 'gradle', './gradlew', 'mvn', 'dotnet', 'swift', 'xcodebuild', 'pod', 'flutter', 'dart',
	'docker', 'kubectl', 'helm', 'terraform', 'brew', 'apt', 'apt-get', 'sudo', 'curl', 'wget', 'ssh', 'scp',
	'kill', 'pkill', 'killall', 'lsof', 'ps', 'which', 'claude', 'code', 'klawly', 'supabase', 'vercel', 'firebase', 'expo', 'eas',
]);

/** Whether a fenced block in `languageId` holds shell commands. */
export function isShellLanguage(languageId: string): boolean {
	return SHELL_LANGUAGES.has(languageId.trim().toLowerCase());
}

/**
 * The commands a shell code block runs, or `undefined` when it has none.
 * A session block (`console`) keeps only the lines behind a prompt, without
 * the prompt, so its output never runs; a script keeps every line and loses
 * a leading prompt only.
 */
export function shellCommandFromBlock(languageId: string, code: string): string | undefined {
	if (!isShellLanguage(languageId)) {
		return undefined;
	}
	const lines = code.replace(/\r\n?/g, '\n').split('\n');
	const prompted = lines.filter(line => PROMPT.test(line));
	const session = SESSION_LANGUAGES.has(languageId.trim().toLowerCase()) || (prompted.length > 0 && prompted.length < lines.filter(line => line.trim()).length);
	const commands = (session ? prompted : lines).map(line => line.replace(PROMPT, '').replace(/\s+$/, ''));
	const text = commands.join('\n').replace(/^\n+|\n+$/g, '');
	return text.trim() ? text : undefined;
}

/**
 * The command an inline code span suggests, or `undefined` when it does not
 * read as one: a single line that starts with a known program and has more
 * after it (`npm test`, `kill 8284`), or that chains commands with `&&`.
 */
export function inlineShellCommand(text: string): string | undefined {
	const command = text.replace(PROMPT, '').trim();
	if (!command || command.length > 300 || /[\r\n`]/.test(command)) {
		return undefined;
	}
	const [program, ...rest] = command.split(/\s+/);
	if (COMMAND_PROGRAMS.has(program) && rest.length > 0) {
		return command;
	}
	return /\s&&\s/.test(command) && command.split(/\s&&\s/).every(part => COMMAND_PROGRAMS.has(part.trim().split(/\s+/)[0])) ? command : undefined;
}
