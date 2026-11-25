/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { basename, delimiter, join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeKlawlyHookRequest, ClaudeKlawlyHookSpec } from '../../common/claudeKlawlyHooks.js';
import { claudeKlawlyHookProcess, ClaudeKlawlyHookHost, runClaudeKlawlyHooks } from '../../node/claudeKlawlyHookRunner.js';

/** Tiny hook scripts. Each reads the event JSON from stdin the way a Claude Code hook does. */
const SCRIPTS: Record<string, string> = {
	'deny-env.js': `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{if(JSON.parse(s).file_path.endsWith('.env')){process.stderr.write('no .env for Tab');process.exit(2)}process.exit(0)});`,
	'echo.js': `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const i=JSON.parse(s);process.stdout.write(JSON.stringify({systemMessage:[i.hook_event_name,i.phase,require('path').basename(i.file_path),i.cwd===process.env.CLAUDE_PROJECT_DIR].join(' ')}))});`,
	'json-deny.js': `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const i=JSON.parse(s);process.stdout.write(JSON.stringify(i.phase==='before'?{hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'no edits to '+require('path').basename(i.file_path)}}:{systemMessage:'after: '+i.instruction}))});`,
	'slow.js': `setTimeout(()=>{},20000);`,
	'crash.js': `process.stderr.write('boom');process.exit(1);`,
};

suite('runClaudeKlawlyHooks', function () {
	this.timeout(30_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let home: string;
	let project: string;
	let host: ClaudeKlawlyHookHost;

	function hook(script: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
		return { type: 'command', command: process.execPath, args: [join(root, 'hooks', script)], ...extra };
	}

	async function writeSettings(folder: string, file: string, hooks: Record<string, unknown>): Promise<void> {
		await fs.mkdir(join(folder, '.claude'), { recursive: true });
		await fs.writeFile(join(folder, '.claude', file), JSON.stringify(hooks, undefined, 2));
	}

	async function run(request: ClaudeKlawlyHookRequest) {
		const result = await runClaudeKlawlyHooks(request, host);
		return { allowed: result.allowed, reason: result.reason, runs: result.runs.map(item => ({ hook: basename(item.command), outcome: item.outcome, message: item.message })) };
	}

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'klawly-hooks-'));
		home = join(root, 'home');
		project = join(root, 'project');
		await fs.mkdir(join(root, 'hooks'), { recursive: true });
		await fs.mkdir(project, { recursive: true });
		for (const [name, text] of Object.entries(SCRIPTS)) {
			await fs.writeFile(join(root, 'hooks', name), text);
		}
		const env = { ...process.env };
		delete env.CLAUDE_CONFIG_DIR;
		if (process.versions.electron) {
			// The Electron test renderer's execPath is the Electron helper: without this it starts as an app, not node.
			env.ELECTRON_RUN_AS_NODE = '1';
		}
		host = {
			platform: process.platform,
			env,
			homeDirectory: home,
			readFile: async path => fs.readFile(path, 'utf8').catch(() => undefined),
			exists: path => existsSync(path),
		};
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test('a KlawlyTabRead hook that exits 2 denies .env and lets other files through', async () => {
		// The user's hook and the project's copy of it are the same hook, so it runs once. Prompt hooks are Claude Code's only.
		await writeSettings(home, 'settings.json', { hooks: { KlawlyTabRead: [{ hooks: [hook('deny-env.js')] }] } });
		await writeSettings(project, 'settings.json', { hooks: { KlawlyTabRead: [{ hooks: [hook('deny-env.js'), hook('echo.js'), { type: 'prompt', prompt: 'Is $ARGUMENTS safe?' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [hook('crash.js')] }] } });
		const results = [
			await run({ event: 'KlawlyTabRead', cwd: project, filePath: join(project, '.env') }),
			await run({ event: 'KlawlyTabRead', cwd: project, filePath: join(project, 'app.ts') }),
		];
		const nodeName = basename(process.execPath);
		assert.deepStrictEqual(results, [
			{
				allowed: false, reason: 'no .env for Tab', runs: [
					{ hook: nodeName, outcome: 'denied', message: 'no .env for Tab' },
					{ hook: nodeName, outcome: 'allowed', message: 'KlawlyTabRead  .env true' },
					{ hook: 'prompt', outcome: 'skipped', message: 'Klawly runs only command hooks on its own events, not prompt hooks' },
				]
			},
			{
				allowed: true, reason: undefined, runs: [
					{ hook: nodeName, outcome: 'allowed', message: undefined },
					{ hook: nodeName, outcome: 'allowed', message: 'KlawlyTabRead  app.ts true' },
					{ hook: 'prompt', outcome: 'skipped', message: 'Klawly runs only command hooks on its own events, not prompt hooks' },
				]
			},
		]);
	});

	test('KlawlyInlineEdit: JSON deny, timeouts fail open unless failClosed, crashes do not block', async () => {
		await writeSettings(project, 'settings.local.json', {
			hooks: {
				KlawlyInlineEdit: [{
					hooks: [
						hook('json-deny.js'),
						hook('slow.js', { timeout: 1 }),
						hook('slow.js', { timeout: 1, failClosed: true, shell: 'bash' }),
						hook('crash.js'),
					]
				}]
			}
		});
		const nodeName = basename(process.execPath);
		const before = await run({ event: 'KlawlyInlineEdit', cwd: project, phase: 'before', filePath: join(project, '.env'), instruction: 'rename' });
		const after = await run({ event: 'KlawlyInlineEdit', cwd: project, phase: 'after', filePath: join(project, 'app.ts'), instruction: 'rename' });
		assert.deepStrictEqual([before, after.runs[0], after.allowed], [
			{
				allowed: false, reason: 'no edits to .env', runs: [
					{ hook: nodeName, outcome: 'denied', message: 'no edits to .env' },
					{ hook: nodeName, outcome: 'timedOut', message: 'timed out after 1 seconds' },
					{ hook: nodeName, outcome: 'denied', message: 'timed out after 1 seconds' },
					{ hook: nodeName, outcome: 'failed', message: 'boom' },
				]
			},
			{ hook: nodeName, outcome: 'allowed', message: 'after: rename' },
			false,
		]);
	});

	test('KlawlyWorkspaceOpen runs a shell command in the folder; disableAllHooks turns every hook off', async () => {
		const node = process.execPath.replace(/\\/g, '/');
		await writeSettings(project, 'settings.json', { hooks: { KlawlyWorkspaceOpen: [{ hooks: [{ type: 'command', command: `"${node}" -e "process.stdout.write(require('path').basename(process.cwd()))"` }] }] } });
		const opened = await run({ event: 'KlawlyWorkspaceOpen', cwd: project, folders: [project] });
		await writeSettings(project, 'settings.local.json', { disableAllHooks: true });
		const disabled = await run({ event: 'KlawlyWorkspaceOpen', cwd: project, folders: [project] });
		assert.deepStrictEqual([opened.allowed, opened.runs.map(item => [item.outcome, item.message]), disabled], [
			true,
			[['allowed', 'project']],
			{ allowed: true, reason: undefined, runs: [] },
		]);
	});

	test('hooks in ~/.klawly/claude run too, and ~/.claude hooks run only while Klawly uses it (issue 455)', async () => {
		await writeSettings(home, 'settings.json', { hooks: { KlawlyTabRead: [{ hooks: [hook('deny-env.js')] }] } });
		const layer = join(home, '.klawly', 'claude');
		await fs.mkdir(layer, { recursive: true });
		await fs.writeFile(join(layer, 'settings.json'), JSON.stringify({ hooks: { KlawlyTabRead: [{ hooks: [hook('echo.js')] }] } }));
		const request: ClaudeKlawlyHookRequest = { event: 'KlawlyTabRead', cwd: project, filePath: join(project, 'app.ts') };
		const runWith = async (useClaudeCodeSetup: boolean) => {
			host = { ...host, userLayerDirectory: layer, useClaudeCodeSetup };
			return (await run(request)).runs.map(item => item.message);
		};
		assert.deepStrictEqual({ on: await runWith(true), off: await runWith(false) }, {
			on: [undefined, 'KlawlyTabRead  app.ts true'],
			off: ['KlawlyTabRead  app.ts true'],
		});
	});

	test('picks the program the way Claude Code does', () => {
		const spec = (extra: Partial<ClaudeKlawlyHookSpec> = {}): ClaudeKlawlyHookSpec => ({ type: 'command', command: 'check', failClosed: false, ...extra });
		const files = [join('Git', 'cmd', 'git.exe'), join('Git', 'bin', 'bash.exe'), join('D', 'bash.exe')];
		const fake = (platform: NodeJS.Platform, env: Record<string, string>) => ({ platform, env, exists: (path: string) => files.includes(path) });
		assert.deepStrictEqual([
			claudeKlawlyHookProcess(spec({ args: ['a'] }), fake('win32', {})),
			claudeKlawlyHookProcess(spec(), fake('win32', { PATH: ['Windows', join('Git', 'cmd')].join(delimiter) })),
			claudeKlawlyHookProcess(spec(), fake('win32', { CLAUDE_CODE_GIT_BASH_PATH: join('D', 'bash.exe') })),
			claudeKlawlyHookProcess(spec(), fake('win32', {})),
			claudeKlawlyHookProcess(spec(), fake('darwin', { SHELL: '/bin/zsh' })),
			claudeKlawlyHookProcess(spec({ shell: 'powershell' }), fake('linux', {})),
		], [
			{ file: 'check', args: ['a'] },
			{ file: join('Git', 'bin', 'bash.exe'), args: ['-c', 'check'] },
			{ file: join('D', 'bash.exe'), args: ['-c', 'check'] },
			{ file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'check'] },
			{ file: '/bin/zsh', args: ['-c', 'check'] },
			{ file: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', 'check'] },
		]);
	});
});
