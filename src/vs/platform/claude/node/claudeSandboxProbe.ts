/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { constants, promises as fs } from 'fs';
import { delimiter, join } from '../../../base/common/path.js';
import { ClaudeSandboxStatus } from '../common/claudeSecuritySettings.js';

/** How the probe looks at the machine; tests pass their own. */
export interface ClaudeSandboxProbeHost {
	readonly platform: NodeJS.Platform;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Whether the file exists and may be run. */
	canRun(path: string): Promise<boolean>;
	/** A text file's content, or undefined when it cannot be read. */
	readText(path: string): Promise<string | undefined>;
}

const nodeHost: ClaudeSandboxProbeHost = {
	platform: process.platform,
	env: process.env,
	canRun: async path => {
		try {
			await fs.access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
			return true;
		} catch {
			return false;
		}
	},
	readText: async path => {
		try {
			return await fs.readFile(path, 'utf8');
		} catch {
			return undefined;
		}
	},
};

async function onPath(host: ClaudeSandboxProbeHost, command: string): Promise<boolean> {
	const dirs = (host.env.PATH ?? host.env.Path ?? '').split(delimiter).filter(Boolean);
	const names = host.platform === 'win32' ? [`${command}.exe`, command] : [command];
	for (const dir of dirs) {
		for (const name of names) {
			if (await host.canRun(join(dir, name))) {
				return true;
			}
		}
	}
	return false;
}

/**
 * What Claude Code's sandbox needs, checked the way it checks them (from its
 * `/sandbox` dependency report): bubblewrap (`bwrap`) and `socat` on PATH on
 * Linux and WSL 2, where WSL 1 cannot sandbox; Seatbelt (`sandbox-exec`), built
 * into macOS; and on Windows Git Bash plus a one-time install that only Claude
 * Code can check (`/sandbox install`, one UAC prompt), which may not be offered
 * yet. Claude Code sandboxes on no other platform.
 */
export async function probeClaudeSandbox(host: ClaudeSandboxProbeHost = nodeHost): Promise<ClaudeSandboxStatus> {
	switch (host.platform) {
		case 'linux': {
			const version = await host.readText('/proc/version');
			if (version && /Microsoft/.test(version) && !/microsoft-standard|WSL2/i.test(version)) {
				return { state: 'missing', platform: 'linux', missing: ['WSL 2'] };
			}
			const missing: string[] = [];
			if (!await onPath(host, 'bwrap')) {
				missing.push('bubblewrap');
			}
			if (!await onPath(host, 'socat')) {
				missing.push('socat');
			}
			return { state: missing.length ? 'missing' : 'ready', platform: 'linux', missing };
		}
		case 'darwin':
			return await host.canRun('/usr/bin/sandbox-exec') ? { state: 'ready', platform: 'darwin', missing: [] } : { state: 'setup', platform: 'darwin', missing: [] };
		case 'win32': {
			const gitBash = !!host.env.CLAUDE_CODE_GIT_BASH_PATH || await onPath(host, 'git') || await onPath(host, 'bash');
			return gitBash ? { state: 'setup', platform: 'win32', missing: [] } : { state: 'missing', platform: 'win32', missing: ['Git for Windows'] };
		}
		default:
			return { state: 'unsupported', platform: 'other', missing: [] };
	}
}
