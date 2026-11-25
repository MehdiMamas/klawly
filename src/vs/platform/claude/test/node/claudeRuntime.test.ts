/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { selectBuiltinAgents } from '../../node/claudeBuiltinAgents.js';
import { classifyAgentFailure, classifyAssistantError } from '../../node/claudeFailure.js';
import { claudeProbeBinaryNames, claudeProcessEnvironment, claudeSearchEnvironment, probeClaudeRuntime, resolveClaudeBinary } from '../../node/claudeRuntime.js';
import { assessClaudeRuntimeVersion, claudeSupportsThinkingDisplay, compareClaudeVersions, parseClaudeVersion } from '../../node/claudeVersion.js';

suite('Claude runtime probe', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses a Claude version, warns below the tested range and notes a newer one', () => {
		assert.strictEqual(parseClaudeVersion('2.1.288 (Claude Code)'), '2.1.288');
		assert.strictEqual(compareClaudeVersions('2.1.10', '2.1.9'), 1);
		assert.strictEqual(assessClaudeRuntimeVersion('2.1.296').disposition, 'ok');
		assert.strictEqual(assessClaudeRuntimeVersion('9.0.0').disposition, 'newer');
		assert.strictEqual(assessClaudeRuntimeVersion('1.9.0').disposition, 'warn');
		assert.strictEqual(assessClaudeRuntimeVersion('1.0.0', { knownBad: ['1.0.0'] }).disposition, 'block');
	});

	test('only a Claude Code that takes --thinking-display is asked for it (issue 740)', () => {
		assert.deepStrictEqual(['2.1.280', '2.1.281', '2.1.296', undefined].map(claudeSupportsThinkingDisplay), [false, true, true, false]);
	});

	test('maps auth, usage-limit, network, and runtime failures', () => {
		assert.strictEqual(classifyAgentFailure(new Error('401 authentication failed')).kind, 'auth');
		assert.strictEqual(classifyAgentFailure(new Error('429 usage limit reached')).kind, 'usage-limit');
		assert.strictEqual(classifyAgentFailure(new Error('fetch failed: ECONNRESET')).kind, 'network');
		assert.strictEqual(classifyAgentFailure(new Error('spawn claude ENOENT')).kind, 'runtime-missing');
		assert.strictEqual(classifyAgentFailure(new Error('known incompatible version')).kind, 'runtime-version');
		assert.strictEqual(classifyAssistantError('server_error'), 'unknown');
	});

	test('probes the runtimePath override and reads auth status without keeping account fields', async () => {
		const calls: string[][] = [];
		const state = await probeClaudeRuntime({
			runtimePath: process.execPath,
			knownBadVersions: [],
			execFile: async (file, args) => {
				calls.push([file, ...args]);
				if (args[0] === '--version') {
					return { stdout: '2.1.288 (Claude Code)\n', stderr: '' };
				}
				return {
					stdout: JSON.stringify({
						loggedIn: true,
						authMethod: 'claude.ai',
						apiProvider: 'firstParty',
						email: 'person@example.com',
					}),
					stderr: '',
				};
			},
			env: { PATH: '/usr/bin' },
		});

		assert.deepStrictEqual(calls[0], [process.execPath, '--version']);
		assert.deepStrictEqual(calls[1], [process.execPath, 'auth', 'status']);
		assert.strictEqual(state.binary, process.execPath);
		assert.strictEqual(state.state.installed, true);
		assert.strictEqual(state.state.authenticated, true);
		assert.strictEqual(state.state.authMode, 'claude-account');
		assert.strictEqual(state.state.version, '2.1.288');
		assert.strictEqual(state.state.binaryPath, process.execPath);
		assert.strictEqual(JSON.stringify(state.state).includes('person@example.com'), false);
	});

	test('reports a missing runtime and copies only the environment allowlist', () => {
		const binary = resolveClaudeBinary('/missing/claude', { PATH: '/usr/bin' }, () => false);
		assert.strictEqual(binary, undefined);
		const env = claudeProcessEnvironment({
			PATH: '/usr/bin',
			HOME: '/Users/example',
			ANTHROPIC_API_KEY: 'test-key',
			SECRET_TOKEN: 'do-not-copy',
		});
		assert.strictEqual(env.PATH, '/usr/bin');
		assert.strictEqual(env.ANTHROPIC_API_KEY, 'test-key');
		assert.strictEqual(env.CLAUDE_AGENT_SDK_CLIENT_APP, 'Klawly');
		assert.strictEqual(env.SECRET_TOKEN, undefined);
	});

	test('secret-bearing variables outside the allowlist never reach the Claude process', () => {
		const env = claudeProcessEnvironment({
			PATH: '/usr/bin',
			AWS_SECRET_ACCESS_KEY: 'aws-secret',
			AWS_SESSION_TOKEN: 'aws-session',
			GITHUB_TOKEN: 'ghp_notforclaude',
			NPM_TOKEN: 'npm-token',
			OPENAI_API_KEY: 'sk-other',
			DATABASE_URL: 'postgres://user:pw@host/db',
			SSH_AUTH_SOCK: '/tmp/agent.sock',
		});
		assert.deepStrictEqual(Object.keys(env).sort(), ['CLAUDE_AGENT_SDK_CLIENT_APP', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_TELEMETRY', 'PATH']);
	});

	test('telemetry off (the default) turns off Claude Code nonessential traffic; on leaves the user choice alone', () => {
		const opted = (telemetryEnabled: boolean | undefined, source: NodeJS.ProcessEnv = {}) => {
			const env = claudeProcessEnvironment(source, telemetryEnabled === undefined ? undefined : { telemetryEnabled });
			return [env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, env.DISABLE_TELEMETRY];
		};
		assert.deepStrictEqual({
			unset: opted(undefined),
			off: opted(false),
			on: opted(true),
			onWithUserOptOut: opted(true, { DISABLE_TELEMETRY: '1' }),
		}, {
			unset: ['1', '1'],
			off: ['1', '1'],
			on: [undefined, undefined],
			onWithUserOptOut: [undefined, '1'],
		});
	});

	test('the version and auth probes run with the allowlisted environment, not the full one', async () => {
		const seen: Readonly<Record<string, string>>[] = [];
		await probeClaudeRuntime({
			runtimePath: process.execPath,
			env: { PATH: '/usr/bin', GITHUB_TOKEN: 'ghp_notforclaude', AWS_SECRET_ACCESS_KEY: 'aws-secret', ANTHROPIC_API_KEY: 'test-key' },
			execFile: async (_file, args, options) => {
				seen.push(options.env);
				return args[0] === '--version' ? { stdout: '2.1.288\n', stderr: '' } : { stdout: '{"loggedIn":false}', stderr: '' };
			},
		});
		assert.strictEqual(seen.length, 2);
		for (const env of seen) {
			assert.deepStrictEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_AGENT_SDK_CLIENT_APP', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_TELEMETRY', 'PATH']);
		}
	});

	test('a user agent file wins over the built-in definition', () => {
		const root = join(tmpdir(), `klawly-agents-${Date.now()}`);
		const agents = join(root, '.claude', 'agents');
		mkdirSync(agents, { recursive: true });
		writeFileSync(join(agents, 'reviewer.md'), '# user reviewer\n');
		const home = join(root, 'empty-home');
		mkdirSync(home, { recursive: true });
		try {
			const selected = selectBuiltinAgents(root, true, home);
			assert.ok(selected);
			assert.strictEqual(selected.reviewer, undefined);
			assert.ok(selected.explorer);
			assert.strictEqual(selectBuiltinAgents(root, false, home), undefined);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('frontmatter name and CLAUDE_CONFIG_DIR win over the file name', () => {
		const root = join(tmpdir(), `klawly-agents-name-${Date.now()}`);
		const projectAgents = join(root, '.claude', 'agents');
		const config = join(root, 'config');
		mkdirSync(projectAgents, { recursive: true });
		mkdirSync(join(config, 'agents'), { recursive: true });
		writeFileSync(join(projectAgents, 'my-review.md'), '---\nname: reviewer\n---\n# renamed\n');
		writeFileSync(join(config, 'agents', 'notes.md'), '---\nname: explorer\n---\n# config\n');
		try {
			const selected = selectBuiltinAgents(root, true, join(root, 'empty-home'), config);
			assert.ok(selected === undefined || (selected.reviewer === undefined && selected.explorer === undefined));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('a version warning keeps the auth error', async () => {
		const warnings: string[] = [];
		const state = await probeClaudeRuntime({
			runtimePath: process.execPath,
			execFile: async (_file, args) => {
				if (args[0] === '--version') {
					return { stdout: '1.9.0\n', stderr: '' };
				}
				throw new Error('auth unavailable');
			},
			log: line => warnings.push(line),
		});
		assert.strictEqual(state.state.authenticated, false);
		assert.ok(state.state.error?.includes('older than the tested range'));
		assert.ok(state.state.error?.includes('auth status is unavailable'));
		assert.ok(warnings.some(line => line.includes('older than the tested range')));
	});

	test('a newer Claude Code is only logged, never reported as an error (issues 696, 707)', async () => {
		const lines: string[] = [];
		const state = await probeClaudeRuntime({
			runtimePath: process.execPath,
			execFile: async (_file, args) => args[0] === '--version'
				? { stdout: '9.0.0 (Claude Code)\n', stderr: '' }
				: { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' },
			log: line => lines.push(line),
		});
		assert.deepStrictEqual({ error: state.state.error, logged: lines.some(line => line.includes('newer than the last version tested')) }, { error: undefined, logged: true });
	});

	test('maps the auth status method and provider to a sign-in method', async () => {
		const authMode = async (status: object) => (await probeClaudeRuntime({
			runtimePath: process.execPath,
			execFile: async (_file, args) => args[0] === '--version'
				? { stdout: '2.1.288 (Claude Code)\n', stderr: '' }
				: { stdout: JSON.stringify({ loggedIn: true, ...status }), stderr: '' },
		})).state.authMode;
		assert.deepStrictEqual([
			await authMode({ authMethod: 'claude.ai', apiProvider: 'firstParty' }),
			await authMode({ authMethod: 'api_key', apiProvider: 'firstParty' }),
			await authMode({ apiProvider: 'bedrock' }),
			await authMode({ apiProvider: 'vertex' }),
			await authMode({ apiProvider: 'gateway' }),
			await authMode({}),
		], ['claude-account', 'api-key', 'bedrock', 'vertex', 'enterprise', 'unknown']);
	});

	test('a signed-out runtime is not authenticated', async () => {
		const state = await probeClaudeRuntime({
			runtimePath: process.execPath,
			execFile: async (_file, args) => {
				if (args[0] === '--version') {
					return { stdout: '2.1.288 (Claude Code)\n', stderr: '' };
				}
				return { stdout: JSON.stringify({ loggedIn: false, authMethod: 'claude.ai', email: 'person@example.com' }), stderr: '' };
			},
		});
		assert.strictEqual(state.state.authenticated, false);
		assert.strictEqual(state.state.authMode, undefined);
		assert.strictEqual(JSON.stringify(state.state).includes('person@example.com'), false);
	});

	test('finds Claude Code in the installer folder when PATH does not have it yet (issue 91)', () => {
		const windowsHome = join('C:', 'Users', 'you');
		const unixHome = join('/home', 'you');
		const installed = new Set([join(windowsHome, '.local', 'bin', 'claude.exe'), join(unixHome, '.claude', 'local', 'claude')]);
		const exists = (file: string) => installed.has(file);
		assert.deepStrictEqual({
			windows: resolveClaudeBinary(undefined, { USERPROFILE: windowsHome }, exists, 'win32'),
			linux: resolveClaudeBinary(undefined, { HOME: unixHome, PATH: '/usr/bin' }, exists, 'linux'),
			noHome: resolveClaudeBinary(undefined, { PATH: '/usr/bin' }, exists, 'linux'),
		}, {
			windows: join(windowsHome, '.local', 'bin', 'claude.exe'),
			linux: join(unixHome, '.claude', 'local', 'claude'),
			noHome: undefined,
		});
	});

	test('on Windows, the search adds the user and machine Path saved in the registry', async () => {
		const queried: string[] = [];
		const env = await claudeSearchEnvironment({ PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\you' }, 'win32', async (_file, args) => {
			queried.push(args[1]);
			if (args[1] === 'HKCU\\Environment') {
				return { stdout: '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;%MISSING%\\bin\r\n\r\n', stderr: '' };
			}
			throw new Error('The system was unable to find the specified registry key or value.');
		});
		const posix = await claudeSearchEnvironment({ PATH: '/usr/bin' }, 'linux', async () => { throw new Error('not called'); });
		assert.deepStrictEqual({ queried, path: env.PATH, posix: posix.PATH }, {
			queried: ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'],
			path: ['C:\\Windows', 'C:\\Users\\you\\.local\\bin;%MISSING%\\bin'].join(delimiter),
			posix: '/usr/bin',
		});
	});

	test('Windows probes prefer claude.exe over the npm cmd shims, which start through cmd.exe', () => {
		assert.deepStrictEqual(claudeProbeBinaryNames('win32'), ['claude.exe', 'claude.cmd', 'claude.bat']);
		assert.deepStrictEqual(claudeProbeBinaryNames('darwin'), ['claude']);
	});
});
