/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import { homedir } from 'os';
import { delimiter, dirname, join } from '../../../base/common/path.js';
import { killTree } from '../../../base/node/processes.js';
import { CLAUDE_SETTINGS_FILES } from '../common/claudeHooks.js';
import { claudeKlawlyHookDefaultTimeout, claudeKlawlyHookInput, ClaudeKlawlyHookExit, ClaudeKlawlyHookRequest, ClaudeKlawlyHookResult, ClaudeKlawlyHookRun, ClaudeKlawlyHookSpec, collectClaudeKlawlyHooks, combineClaudeKlawlyHookRuns, decideClaudeKlawlyHook } from '../common/claudeKlawlyHooks.js';
import { claudeConfigDirectory } from '../common/claudePlanFiles.js';
import { CLAUDE_USER_LAYER_FILES } from '../common/claudeUserLayer.js';

const OUTPUT_LIMIT = 64 * 1024;

export interface ClaudeKlawlyHookHost {
	readonly platform: NodeJS.Platform;
	readonly env: NodeJS.ProcessEnv;
	readonly homeDirectory: string;
	/** Klawly's user layer, `~/.klawly/claude` (issue 455), whose `settings.json` hooks run too. */
	readonly userLayerDirectory?: string;
	/** Also run `~/.claude/settings.json`'s hooks. On unless false. */
	readonly useClaudeCodeSetup?: boolean;
	readFile(path: string): Promise<string | undefined>;
	exists(path: string): boolean;
}

/** {@link ClaudeKlawlyHookHost} on this machine, with the user layers the session uses. */
export function nodeClaudeKlawlyHookHost(userLayerDirectory?: string, useClaudeCodeSetup?: boolean): ClaudeKlawlyHookHost {
	return { ...nodeHost, userLayerDirectory, useClaudeCodeSetup };
}

const nodeHost: ClaudeKlawlyHookHost = {
	platform: process.platform,
	env: process.env,
	homeDirectory: homedir(),
	readFile: async path => {
		try {
			return await fs.readFile(path, 'utf8');
		} catch {
			return undefined;
		}
	},
	exists: path => existsSync(path),
};

/**
 * Runs the request's event hooks from the user, project and local Claude
 * settings files (issue 514), in parallel, each in the workspace folder with
 * the event's JSON on stdin. Never rejects; a hook that cannot start is a
 * non-blocking error, as in Claude Code.
 */
export async function runClaudeKlawlyHooks(request: ClaudeKlawlyHookRequest, host: ClaudeKlawlyHookHost = nodeHost): Promise<ClaudeKlawlyHookResult> {
	const files = [
		...host.useClaudeCodeSetup !== false ? [join(claudeConfigDirectory(host.homeDirectory, host.env.CLAUDE_CONFIG_DIR), 'settings.json')] : [],
		...host.userLayerDirectory ? [join(host.userLayerDirectory, CLAUDE_USER_LAYER_FILES.settings)] : [],
		join(request.cwd, ...CLAUDE_SETTINGS_FILES.project),
		join(request.cwd, ...CLAUDE_SETTINGS_FILES.local),
	];
	const texts = (await Promise.all(files.map(file => host.readFile(file)))).filter((text): text is string => text !== undefined);
	const specs = collectClaudeKlawlyHooks(texts, request.event);
	if (specs.length === 0) {
		return { allowed: true, runs: [] };
	}
	const input = JSON.stringify(claudeKlawlyHookInput(request));
	const runs = await Promise.all(specs.map(spec => runOne({ ...spec, timeout: spec.timeout ?? claudeKlawlyHookDefaultTimeout(request.event) }, request.cwd, input, host)));
	return combineClaudeKlawlyHookRuns(runs);
}

async function runOne(spec: ClaudeKlawlyHookSpec, cwd: string, input: string, host: ClaudeKlawlyHookHost): Promise<ClaudeKlawlyHookRun> {
	const started = Date.now();
	if (spec.type !== 'command') {
		return { command: spec.command, outcome: 'skipped', message: `Klawly runs only command hooks on its own events, not ${spec.type} hooks`, durationMs: 0 };
	}
	const exit = await execute(spec, cwd, input, host);
	const decided = decideClaudeKlawlyHook(spec, exit);
	return { command: spec.command, outcome: decided.outcome, message: decided.message, durationMs: Date.now() - started };
}

/** The program and arguments that run a hook: exec form, PowerShell, or bash as Claude Code picks it. */
export function claudeKlawlyHookProcess(spec: ClaudeKlawlyHookSpec, host: Pick<ClaudeKlawlyHookHost, 'platform' | 'env' | 'exists'>): { readonly file: string; readonly args: readonly string[] } {
	if (spec.args) {
		return { file: spec.command, args: spec.args };
	}
	const windows = host.platform === 'win32';
	const bash = spec.shell === 'powershell' ? undefined : windows ? findGitBash(host) : host.env.SHELL || '/bin/sh';
	if (!bash) {
		return { file: windows ? 'powershell.exe' : 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', spec.command] };
	}
	return { file: bash, args: ['-c', spec.command] };
}

/** Git Bash on Windows: `CLAUDE_CODE_GIT_BASH_PATH`, else next to the `git` on PATH. */
function findGitBash(host: Pick<ClaudeKlawlyHookHost, 'env' | 'exists'>): string | undefined {
	const configured = host.env.CLAUDE_CODE_GIT_BASH_PATH;
	if (configured && host.exists(configured)) {
		return configured;
	}
	const path = host.env.PATH ?? host.env.Path ?? '';
	for (const folder of path.split(delimiter)) {
		if (!folder || !host.exists(join(folder, 'git.exe'))) {
			continue;
		}
		const root = dirname(folder);
		for (const candidate of [join(root, 'bin', 'bash.exe'), join(root, 'usr', 'bin', 'bash.exe')]) {
			if (host.exists(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

function execute(spec: ClaudeKlawlyHookSpec, cwd: string, input: string, host: ClaudeKlawlyHookHost): Promise<ClaudeKlawlyHookExit> {
	return new Promise(resolve => {
		const { file, args } = claudeKlawlyHookProcess(spec, host);
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let settled = false;
		const finish = (exit: ClaudeKlawlyHookExit) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(exit);
			}
		};
		const child = spawn(file, [...args], {
			cwd,
			env: { ...host.env, CLAUDE_PROJECT_DIR: cwd },
			stdio: 'pipe',
			windowsHide: true,
		});
		const timer = setTimeout(async () => {
			timedOut = true;
			// On Windows the hook's shell (Git Bash, PowerShell) leaves its own children running, so end the whole tree.
			if (host.platform === 'win32' && child.pid !== undefined) {
				await killTree(child.pid, true).catch(() => child.kill());
			} else {
				child.kill();
			}
			finish({ exitCode: undefined, stdout, stderr, timedOut });
		}, (spec.timeout ?? 60) * 1000);
		child.stdout.on('data', (chunk: Buffer) => stdout = (stdout + chunk.toString()).slice(0, OUTPUT_LIMIT));
		child.stderr.on('data', (chunk: Buffer) => stderr = (stderr + chunk.toString()).slice(0, OUTPUT_LIMIT));
		child.on('error', error => finish({ exitCode: undefined, stdout, stderr, timedOut, error: error.message }));
		child.on('close', code => finish({ exitCode: code ?? undefined, stdout, stderr, timedOut }));
		// A hook that exits without reading stdin closes the pipe; that is not an error.
		child.stdin.on('error', () => { });
		child.stdin.end(input);
	});
}
