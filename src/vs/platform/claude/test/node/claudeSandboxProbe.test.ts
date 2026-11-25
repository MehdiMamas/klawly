/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { delimiter, join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeSandboxProbeHost, probeClaudeSandbox } from '../../node/claudeSandboxProbe.js';

suite('probeClaudeSandbox', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function host(platform: NodeJS.Platform, files: readonly string[], procVersion?: string, env: Record<string, string> = {}): ClaudeSandboxProbeHost {
		return {
			platform,
			env: { PATH: ['bin', 'usr'].join(delimiter), ...env },
			canRun: async path => files.includes(path),
			readText: async path => path === '/proc/version' ? procVersion : undefined,
		};
	}

	test('names what each platform is missing', async () => {
		const results = await Promise.all([
			probeClaudeSandbox(host('linux', [join('bin', 'bwrap'), join('usr', 'socat')], 'Linux version 6.8.0-generic')),
			probeClaudeSandbox(host('linux', [join('bin', 'bwrap')])),
			probeClaudeSandbox(host('linux', [join('bin', 'bwrap'), join('bin', 'socat')], 'Linux version 4.4.0-19041-Microsoft')),
			probeClaudeSandbox(host('linux', [join('bin', 'bwrap'), join('bin', 'socat')], 'Linux version 5.15.153.1-microsoft-standard-WSL2')),
			probeClaudeSandbox(host('darwin', ['/usr/bin/sandbox-exec'])),
			probeClaudeSandbox(host('win32', [join('usr', 'git.exe')])),
			probeClaudeSandbox(host('win32', [])),
			probeClaudeSandbox(host('win32', [], undefined, { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe' })),
			probeClaudeSandbox(host('freebsd', [join('bin', 'bwrap'), join('bin', 'socat')])),
		]);
		assert.deepStrictEqual(results, [
			{ state: 'ready', platform: 'linux', missing: [] },
			{ state: 'missing', platform: 'linux', missing: ['socat'] },
			{ state: 'missing', platform: 'linux', missing: ['WSL 2'] },
			{ state: 'ready', platform: 'linux', missing: [] },
			{ state: 'ready', platform: 'darwin', missing: [] },
			{ state: 'setup', platform: 'win32', missing: [] },
			{ state: 'missing', platform: 'win32', missing: ['Git for Windows'] },
			{ state: 'setup', platform: 'win32', missing: [] },
			{ state: 'unsupported', platform: 'other', missing: [] },
		]);
	});
});
