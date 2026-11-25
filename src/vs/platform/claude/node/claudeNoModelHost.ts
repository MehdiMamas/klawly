/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { dirname, join } from '../../../base/common/path.js';
import { claudeNoModelGitHub } from './claudeGitHubApi.js';
import { ClaudeNoModelHost, ClaudeNoModelProcessResult } from './claudeNoModelTools.js';

/** A test run may take a while; the log keeps what it printed. */
const PROCESS_TIMEOUT_MS = 30 * 60 * 1000;
const PROCESS_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * The real host of the no-model tools (issue 844), for the shared process:
 * GitHub through the user's `gh` sign-in, `git`, `node` and `npm` as child
 * processes, and logs under `logFolder`.
 * `notify` is the caller's: it puts one message into a chat.
 */
export function createClaudeNoModelHost(logFolder: string, notify: (sessionId: string, text: string) => void): ClaudeNoModelHost {
	return {
		github: claudeNoModelGitHub(),
		run: (command, args, cwd) => new Promise<ClaudeNoModelProcessResult>(resolve => {
			// npm is a script on Windows, which only a shell starts.
			execFile(command, [...args], { cwd, timeout: PROCESS_TIMEOUT_MS, maxBuffer: PROCESS_BUFFER_BYTES, windowsHide: true, shell: process.platform === 'win32' && command === 'npm' }, (error, stdout, stderr) => {
				const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : null) : 0;
				resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error && code === null ? error.message : '') });
			});
		}),
		read: async path => {
			try {
				return await fs.readFile(path, 'utf8');
			} catch {
				return undefined;
			}
		},
		writeLog: async (name, text) => {
			const file = join(logFolder, name);
			await fs.mkdir(dirname(file), { recursive: true });
			await fs.writeFile(file, text, 'utf8');
			return file;
		},
		sleep: (ms, signal) => new Promise<void>(resolve => {
			if (signal.aborted) {
				resolve();
				return;
			}
			const done = () => {
				clearTimeout(timer);
				signal.removeEventListener('abort', done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			signal.addEventListener('abort', done);
		}),
		now: () => Date.now(),
		notify,
	};
}
