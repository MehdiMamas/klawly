/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Application, Logger } from '../../../../automation';
import { createApp, installDiagnosticsHandler, suiteCrashPath, suiteLogsPath } from '../../utils';

/**
 * A `claude` stand-in (the same one the node tests use): `FAKE_VERSION`, `FAKE_AUTH` (`in`, `out`, `junk`) and
 * `FAKE_TURN` (`limit`, `network`, `crash`) choose what it does. It never calls a model.
 */
const FAKE_CLI = `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log((process.env.FAKE_VERSION || '2.1.0') + ' (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') {
	if (process.env.FAKE_AUTH === 'junk') { console.log('not json'); process.exit(0); }
	const loggedIn = process.env.FAKE_AUTH !== 'out';
	console.log(JSON.stringify({ loggedIn }));
	process.exit(loggedIn ? 0 : 1);
}
const id = args[args.indexOf('--session-id') + 1] || args[args.indexOf('--resume') + 1];
const out = o => console.log(JSON.stringify({ session_id: id, ...o }));
out({ type: 'system', subtype: 'init', model: 'fake-model' });
require('readline').createInterface({ input: process.stdin }).on('line', () => {
	if (process.env.FAKE_TURN === 'limit') {
		out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 7200 } });
		out({ type: 'result', is_error: true, result: 'You have hit your usage limit' });
	} else if (process.env.FAKE_TURN === 'network') {
		out({ type: 'result', is_error: true, result: 'API Error: Unable to connect to API (ENOTFOUND api.anthropic.com)' });
	} else if (process.env.FAKE_TURN === 'crash') {
		console.error('segfault');
		process.exit(1);
	}
});
`;

interface IScenario {
	readonly name: string;
	readonly env: Record<string, string | undefined>;
	/** `true`: no `claude` on PATH. */
	readonly noCli?: boolean;
	/** Typed into the composer before the state shows (the edge states come from a turn). */
	readonly prompt?: string;
	readonly expect: string;
}

const SCENARIOS: readonly IScenario[] = [
	{ name: 'S02 no CLI', env: {}, noCli: true, expect: 'Claude Code Is Not Installed' },
	{ name: 'S04 CLI too old', env: { FAKE_VERSION: '1.0.0' }, expect: 'Is Too Old' },
	{ name: 'S03 not signed in', env: { FAKE_AUTH: 'out' }, expect: 'Sign In to Claude Code' },
	{ name: 'S05 sign-in check fails', env: { FAKE_AUTH: 'junk' }, expect: 'Check Your Claude Sign-In' },
	{ name: 'S39 folder is not a Git repository', env: {}, expect: 'This Folder Is Not a Git Repository' },
	{ name: 'S35 usage limit', env: { FAKE_TURN: 'limit' }, prompt: 'hello', expect: 'Usage Limit Reached' },
	{ name: 'S36 offline', env: { FAKE_TURN: 'network' }, prompt: 'hello', expect: 'Offline' },
	{ name: 'S37 crash', env: { FAKE_TURN: 'crash' }, prompt: 'hello', expect: 'Claude Code Stopped Unexpectedly' },
];

export function setup(logger: Logger) {
	describe('Claude first run and edge states', () => {

		installDiagnosticsHandler(logger, () => app);
		let app: Application | undefined;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klawly-states-'));
		const withCli = path.join(root, 'bin');
		fs.mkdirSync(withCli);
		fs.writeFileSync(path.join(withCli, 'claude'), FAKE_CLI, { mode: 0o755 });
		const shots = process.env.KLAWLY_SCREENSHOTS ?? path.join(root, 'shots');
		fs.mkdirSync(shots, { recursive: true });

		afterEach(async () => {
			await app?.stop();
			app = undefined;
		});

		for (const scenario of SCENARIOS) {
			it(scenario.name, async function () {
				// a fresh, empty folder: not a Git repository, nothing the CLI could touch
				const folder = fs.mkdtempSync(path.join(root, 'folder-'));
				const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(dir => !fs.existsSync(path.join(dir, 'claude')));
				const PATH = [...(scenario.noCli ? [] : [withCli]), ...dirs].join(path.delimiter);
				const suite = scenario.name;
				app = createApp({
					...this.defaultOptions,
					workspacePath: folder,
					logsPath: suiteLogsPath(this.defaultOptions, suite),
					crashesPath: suiteCrashPath(this.defaultOptions, suite),
					extraEnv: { ...scenario.env, PATH },
				});
				await app.start();
				const code = app.code;
				await app.workbench.quickaccess.runCommand('claude.agent.focus');
				if (scenario.prompt) {
					await code.waitAndClick('.claude-agent textarea.claude-input');
					await code.driver.typeText('.claude-agent textarea.claude-input', scenario.prompt);
					await code.driver.pressKey('Enter');
				}
				await code.waitForElements('.claude-agent .claude-card', false, els => els.some(el => el.textContent.includes(scenario.expect)));
				// Item 0: the upstream Agent Host is off, so no copilot-runtime process runs beside Klawly
				assert.ok(!/copilot-runtime/.test(cp.execFileSync('ps', ['-A', '-o', 'args=']).toString()), 'a copilot-runtime process is running');
				fs.writeFileSync(path.join(shots, `${scenario.name.replace(/[^a-z0-9]+/ig, '-')}.png`), await code.driver.screenshotBuffer());
			});
		}
	});
}
