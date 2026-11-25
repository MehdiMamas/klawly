/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join } from '../../../base/common/path.js';
import { CLAUDE_SETTINGS_FILES } from '../common/claudeHooks.js';
import { claudeConfigDirectory } from '../common/claudePlanFiles.js';
import { CLAUDE_USER_LAYER_FILES } from '../common/claudeUserLayer.js';
import { CLAUDE_STATUS_LINE_TIMEOUT_MS, claudeStatusLineText, ClaudeStatusLineRequest, ClaudeStatusLineResult, readClaudeStatusLineConfig } from '../common/claudeStatusLine.js';

/** What a status line command printed is read up to this size. */
const OUTPUT_LIMIT = 16 * 1024;

export interface ClaudeStatusLineHost {
	readonly env: NodeJS.ProcessEnv;
	readonly homeDirectory: string;
	/** Klawly's user layer, `~/.klawly/claude` (issue 455): its `settings.json` ranks below the project's, above Claude Code's own. */
	readonly userLayerDirectory?: string;
	/** Also read `~/.claude/settings.json`. On unless false. */
	readonly useClaudeCodeSetup?: boolean;
	readFile(path: string): Promise<string | undefined>;
	/** Runs a shell command with `input` on stdin; resolves what it printed, or why it failed. */
	run(command: string, cwd: string, input: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ readonly stdout: string; readonly error?: string }>;
}

/**
 * Runs the `statusLine` command from the Claude settings (issue 515), the way
 * Claude Code runs it: in a shell, in the session's folder, with the session's
 * JSON on stdin. Never rejects.
 */
export async function runClaudeStatusLine(request: ClaudeStatusLineRequest, host: ClaudeStatusLineHost): Promise<ClaudeStatusLineResult> {
	const [klawly, claudeCode, project, local] = await Promise.all([
		host.userLayerDirectory ? host.readFile(join(host.userLayerDirectory, CLAUDE_USER_LAYER_FILES.settings)) : Promise.resolve(undefined),
		host.useClaudeCodeSetup !== false ? host.readFile(join(claudeConfigDirectory(host.homeDirectory, host.env.CLAUDE_CONFIG_DIR), 'settings.json')) : Promise.resolve(undefined),
		request.trusted ? host.readFile(join(request.cwd, ...CLAUDE_SETTINGS_FILES.project)) : Promise.resolve(undefined),
		request.trusted ? host.readFile(join(request.cwd, ...CLAUDE_SETTINGS_FILES.local)) : Promise.resolve(undefined),
	]);
	// Local, project, Klawly's user layer, then Claude Code's own user settings.
	const config = readClaudeStatusLineConfig({ user: klawly, project, local }, request.trusted) ?? readClaudeStatusLineConfig({ user: claudeCode }, false);
	if (!config) {
		return { kind: 'none' };
	}
	const result = await host.run(config.command, request.cwd, JSON.stringify(request.input), { ...host.env, CLAUDE_PROJECT_DIR: request.input.workspace.project_dir }, CLAUDE_STATUS_LINE_TIMEOUT_MS);
	if (result.error) {
		return { kind: 'failed', message: result.error };
	}
	const text = claudeStatusLineText(result.stdout);
	return text === undefined ? { kind: 'failed', message: 'The status line command printed nothing.' } : { kind: 'line', text };
}

/** The shell a status line runs in: the user's shell, else `/bin/sh`; on Windows, the shell Node picks (cmd.exe). */
function shellFor(env: NodeJS.ProcessEnv): string | true {
	return process.platform === 'win32' ? true : env.SHELL || '/bin/sh';
}

/** {@link ClaudeStatusLineHost} on this machine. */
export function nodeClaudeStatusLineHost(env: NodeJS.ProcessEnv, homeDirectory: string, userLayerDirectory?: string, useClaudeCodeSetup?: boolean): ClaudeStatusLineHost {
	return {
		env,
		homeDirectory,
		userLayerDirectory,
		useClaudeCodeSetup,
		readFile: async path => {
			try {
				return await fs.readFile(path, 'utf8');
			} catch {
				return undefined;
			}
		},
		run: (command, cwd, input, runEnv, timeoutMs) => new Promise(resolve => {
			let stdout = '';
			let settled = false;
			const finish = (result: { readonly stdout: string; readonly error?: string }) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(result);
				}
			};
			const child = spawn(command, { cwd, env: runEnv, shell: shellFor(runEnv), stdio: 'pipe', windowsHide: true });
			const timer = setTimeout(() => {
				child.kill();
				finish({ stdout, error: `The status line command took longer than ${timeoutMs / 1000} seconds.` });
			}, timeoutMs);
			child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(0, OUTPUT_LIMIT); });
			child.on('error', error => finish({ stdout, error: error.message }));
			child.on('close', code => finish(code === 0 || stdout.trim() ? { stdout } : { stdout, error: `The status line command exited with ${code}.` }));
			// A command that exits without reading stdin closes the pipe; that is not an error.
			child.stdin.on('error', () => { });
			child.stdin.end(input);
		}),
	};
}
