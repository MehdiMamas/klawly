/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Application, ApplicationOptions, Logger } from '../../../../automation';
import { createApp, installDiagnosticsHandler, suiteCrashPath, suiteLogsPath } from '../../utils';

/**
 * A `claude` stand-in that never calls a model. The prompt picks what a turn does: `ASK` waits on a permission card,
 * `WORK` does nothing (the agent keeps running), anything else answers. With `--worktree <name>` it makes that
 * worktree like the real command does, and attempt 2 of a parallel run fails.
 */
const FAKE_CLI = `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const cp = require('child_process'), fs = require('fs'), path = require('path');
const id = args[args.indexOf('--session-id') + 1] || args[args.indexOf('--resume') + 1];
const out = o => console.log(JSON.stringify({ session_id: id, ...o }));
const wt = args.includes('--worktree') ? args[args.indexOf('--worktree') + 1] : undefined;
let dir = process.cwd();
if (wt) {
	dir = path.join(process.cwd(), '.claude', 'worktrees', wt.replace(/[\\\\/]/g, '+'));
	cp.execFileSync('git', ['worktree', 'add', '-q', '-b', 'worktree-' + wt.replace(/[\\\\/]/g, '+'), dir]);
}
out({ type: 'system', subtype: 'init', model: 'fake-model', cwd: dir });
require('readline').createInterface({ input: process.stdin }).on('line', line => {
	if (line.includes('ASK')) {
		out({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm install zod@4' } } });
	} else if (line.includes('WORK')) {
		out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } });
	} else if (wt) {
		const n = Number(wt.slice(-1));
		if (n === 2) { out({ type: 'result', is_error: true, result: 'Test failed: expected 2, got 3' }); return; }
		fs.writeFileSync(path.join(dir, 'a.txt'), 'one\\ntwo\\nthree\\n' + 'four\\n'.repeat(n));
		out({ type: 'result', is_error: false, result: 'Done' });
	} else {
		out({ type: 'result', is_error: false, result: 'Done' });
	}
});
`;

function git(cwd: string, ...args: string[]): void {
	cp.execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

export function setup(logger: Logger) {
	describe('Claude agents layout', () => {

		installDiagnosticsHandler(logger, () => app);
		let app: Application | undefined;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klawly-agents-'));
		const bin = path.join(root, 'bin');
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLI, { mode: 0o755 });
		const shots = process.env.KLAWLY_SCREENSHOTS ?? path.join(root, 'shots');
		fs.mkdirSync(shots, { recursive: true });

		afterEach(async () => {
			await app?.stop();
			app = undefined;
		});

		async function start(suite: string, defaultOptions: ApplicationOptions, prepare: (folder: string) => void = () => { }): Promise<Application> {
			const folder = fs.mkdtempSync(path.join(root, 'folder-'));
			git(folder, 'init', '-q', '-b', 'main');
			fs.writeFileSync(path.join(folder, 'a.txt'), 'one\ntwo\nthree\n');
			git(folder, 'add', '.');
			git(folder, 'commit', '-q', '-m', 'init');
			prepare(folder);
			const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(dir => !fs.existsSync(path.join(dir, 'claude')));
			app = createApp({
				...defaultOptions,
				workspacePath: folder,
				logsPath: suiteLogsPath(defaultOptions, suite),
				crashesPath: suiteCrashPath(defaultOptions, suite),
				extraEnv: { PATH: [bin, ...dirs].join(path.delimiter) },
			});
			await app.start();
			return app;
		}

		async function shoot(application: Application, name: string): Promise<void> {
			fs.writeFileSync(path.join(shots, `${name}.png`), await application.code.driver.screenshotBuffer());
		}

		async function send(application: Application, prompt: string): Promise<void> {
			const code = application.code;
			await code.waitAndClick('.claude-agent textarea.claude-input');
			await code.driver.typeText('.claude-agent textarea.claude-input', prompt);
			await code.driver.pressKey('Enter');
		}

		it('S25 and S26 list of agents and Needs you', async function () {
			const application = await start('S25', this.defaultOptions);
			const code = application.code;
			await application.workbench.quickaccess.runCommand('claude.agent.focus');
			await application.workbench.quickaccess.runCommand('claude.layout.toggle');
			await send(application, 'ASK install zod');
			await code.waitForElements('.claude-agent .claude-permission', false, els => els.some(el => el.textContent.includes('npm install zod@4')));
			await code.waitAndClick('.claude-new-agent');
			await send(application, 'WORK run the tests');
			await code.waitAndClick('.claude-new-agent');
			await send(application, 'say hello');
			try {
				await code.waitForElements('.claude-agent-row', false, els => els.length >= 3);
			} catch (error) {
				await shoot(application, 'S25-failed');
				const lists = await code.driver.getElements('.claude-agents-list', false);
				throw new Error(`${error}; list: ${JSON.stringify(lists?.map(el => el.textContent))}`);
			}
			await code.waitForElements('.claude-agent-row', false, els => els.some(el => el.textContent.includes('Permission')));
			await shoot(application, 'S25-agents-list');

			await code.waitAndClick('.claude-needs-entry');
			await code.waitForElements('.claude-agents-list', false, els => els.some(el => el.textContent.includes('Run npm install zod@4')));
			await shoot(application, 'S26-needs-you');
			await code.waitAndClick('.claude-agents-list .claude-primary');
			await code.waitForElements('.claude-agents-list', false, els => els.every(el => !el.textContent.includes('Run npm install zod@4')));
		});

		it('S28 and S30 parallel attempts and compare', async function () {
			const application = await start('S28', this.defaultOptions);
			const code = application.code;
			await application.workbench.quickaccess.runCommand('claude.agents.multitask', { keepOpen: true });
			await application.workbench.quickinput.waitForQuickInputOpened();
			await application.workbench.quickinput.type('Fix the flaky test');
			await code.dispatchKeybinding('enter', async () => { });
			await application.workbench.quickinput.waitForQuickInputOpened();
			await code.dispatchKeybinding('enter', async () => { });
			// the Editor | Agents switch and the count label are there in the Editor layout too
			await code.waitForElements('.claude-layout-switch .claude-layout-segment', false, els => els.length === 2 && els[0].attributes['aria-pressed'] === 'true');
			await code.waitForElements('.claude-layout-label', false, els => els.some(el => /\d+ agents/.test(el.textContent)));
			await code.waitForElements('.claude-attempt', false, els => els.some(el => el.textContent.includes('failed at turn')) && els.some(el => /\+\d+ −\d+/.test(el.textContent)));
			await shoot(application, 'S28-attempts-one-failed');
			await code.waitAndClick('.claude-attempts .claude-attempt button.claude-primary:not([disabled])');
			await code.waitForElements('.claude-compare-headline', false, els => els.some(el => el.textContent.includes('2 attempts passed')));
			await shoot(application, 'S30-compare');
		});

		it('S27 background agents and worktrees', async function () {
			const application = await start('S27', this.defaultOptions, folder => {
				git(folder, 'worktree', 'add', '-q', '-b', 'worktree-fix-zod-v4', path.join(folder, '.claude', 'worktrees', 'fix-zod-v4'));
				git(folder, 'worktree', 'add', '-q', '-b', 'worktree-wip', path.join(folder, '.claude', 'worktrees', 'wip'));
				fs.writeFileSync(path.join(folder, '.claude', 'worktrees', 'wip', 'a.txt'), 'changed\n');
			});
			const code = application.code;
			await application.workbench.quickaccess.runCommand('claude.agents.background');
			await code.waitForElements('.claude-background', false, els => els.some(el => el.textContent.includes('Worktree worktree-fix-zod-v4') && el.textContent.includes('Worktrees use')));
			await application.workbench.quickaccess.runCommand('workbench.action.toggleMaximizedPanel');
			await code.waitForElements('.claude-bg-footer', false, els => els.length === 1);
			await code.driver.hoverSelector('.claude-bg-action:has(button:disabled)');
			await code.waitForElements('.monaco-hover', false, els => els.some(el => el.textContent.includes('not committed')));
			await shoot(application, 'S27-background');
		});
	});
}
