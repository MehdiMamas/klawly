/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { access, constants } from 'fs/promises';
import { delimiter, join } from '../../../base/common/path.js';
import { IClaudeCliStatus } from '../common/claudeRuntime.js';

const MIN_MAJOR = 2;

/** Finds an executable named `claude` on PATH, or in the folder the tests point `KLAWLY_CLAUDE_BIN` at. */
export async function findClaudeOnPath(env: NodeJS.ProcessEnv): Promise<string | undefined> {
	if (env.KLAWLY_CLAUDE_BIN) {
		return env.KLAWLY_CLAUDE_BIN;
	}
	const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
	for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
		for (const name of names) {
			const candidate = join(dir, name);
			try {
				await access(candidate, constants.X_OK);
				return candidate;
			} catch {
				// not here, try the next folder
			}
		}
	}
	return undefined;
}

/** Finds the CLI and reads `claude --version`. Never throws; a missing or old CLI comes back as `found: false` with a message. */
export async function checkClaudeCli(env: NodeJS.ProcessEnv): Promise<IClaudeCliStatus> {
	const path = await findClaudeOnPath(env);
	if (!path) {
		return { found: false, error: 'Claude Code is not installed. Install it from https://code.claude.com/docs and run Detect Again.' };
	}
	return new Promise(resolve => {
		execFile(path, ['--version'], { env, timeout: 15000, windowsHide: true }, (error, stdout) => {
			if (error) {
				resolve({ found: false, path, error: `Could not run ${path}: ${error.message}` });
				return;
			}
			const version = /(\d+)\.(\d+)\.(\d+)/.exec(stdout)?.[0];
			if (!version || Number(version.split('.')[0]) < MIN_MAJOR) {
				resolve({ found: false, path, version, error: `Claude Code ${version ?? '(unknown version)'} is too old. Update it and run Detect Again.` });
				return;
			}
			resolve({ found: true, path, version });
		});
	});
}
