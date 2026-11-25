/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { ClaudeTerminalRunRequest, ClaudeTerminalRunResult } from '../../../../../platform/claude/common/claudeTerminalRun.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ITerminalLaunchError } from '../../../../../platform/terminal/common/terminal.js';
import { ICreateTerminalOptions, ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { XtermTerminal } from '../../../terminal/browser/xterm/xtermTerminal.js';
import { ITerminalProfileResolverService } from '../../../terminal/common/terminal.js';
import { ClaudeAgentSession, IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { ClaudeTerminalRunService } from '../../browser/claudeTerminalRuns.js';

suite('Claude terminal runs (issue 452)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options: { failCreate?: boolean } = {}) {
		const requests = store.add(new Emitter<ClaudeTerminalRunRequest>());
		const exits = store.add(new Emitter<number | ITerminalLaunchError | undefined>());
		const disposed = store.add(new Emitter<ITerminalInstance>());
		const log: string[] = [];
		let answered: () => void = () => { };
		const runtime = {
			onDidRequestTerminalRun: requests.event,
			resolveTerminalRun: async (sessionId: string, requestId: string, result: ClaudeTerminalRunResult) => {
				log.push(`resolve ${sessionId} ${requestId} ${JSON.stringify(result)}`);
				answered();
			},
		} as Partial<IClaudeRuntimeService> as IClaudeRuntimeService;
		const agent = {
			getSessions: () => [{ id: 'pane-1' } as ClaudeAgentSession],
			getRuntimeSessionId: (id: string) => id === 'pane-1' ? 'runtime-1' : undefined,
		} as Partial<IClaudeAgentService> as IClaudeAgentService;
		const instance = {
			onExit: exits.event,
			onDisposed: disposed.event,
			exitCode: undefined,
			xterm: { getBufferReverseIterator: () => ['', 'Logged in as octocat', '? Authenticate Git with your GitHub credentials? Yes'][Symbol.iterator]() } as Partial<XtermTerminal> as XtermTerminal,
			focusWhenReady: async (force?: boolean) => { log.push(`focus ${force}`); },
			dispose: () => {
				log.push('dispose terminal');
				disposed.fire(instance);
			},
		} as Partial<ITerminalInstance> as ITerminalInstance;
		const terminals = {
			createTerminal: async (created?: ICreateTerminalOptions) => {
				if (options.failCreate) {
					throw new Error('no pty host');
				}
				const config = created?.config as { name?: string; executable?: string; args?: string[]; cwd?: string; waitOnExit?: unknown };
				log.push(`create ${JSON.stringify({ name: config.name, executable: config.executable, args: config.args, cwd: config.cwd, waitOnExit: typeof config.waitOnExit })}`);
				return instance;
			},
			revealTerminal: async () => { log.push('reveal'); },
		} as Partial<ITerminalService> as ITerminalService;
		const profiles = {
			getDefaultShell: async () => '/bin/zsh',
		} as Partial<ITerminalProfileResolverService> as ITerminalProfileResolverService;
		const service = store.add(new ClaudeTerminalRunService(runtime, agent, terminals, profiles, new NullLogService()));
		const changes: string[][] = [];
		const listeners = store.add(new DisposableStore());
		listeners.add(service.onDidChange(() => changes.push(service.pending.map(view => `${view.requestId} ${view.command}`))));
		const fire = (request: ClaudeTerminalRunRequest) => new Promise<void>(resolve => {
			answered = resolve;
			requests.fire(request);
		});
		const opened = async () => {
			// The request handler opens the terminal over a few awaits.
			for (let i = 0; i < 10 && !log.includes('focus true'); i++) {
				await new Promise(resolve => setTimeout(resolve, 0));
			}
		};
		return { requests, exits, log, changes, service, fire, opened };
	}

	const request: ClaudeTerminalRunRequest = { sessionId: 'runtime-1', requestId: 'r1', command: 'gh auth login', reason: 'Finish signing in to GitHub.', cwd: '/work/app' };

	test('opens a visible terminal in the session cwd, shows the wait, and answers once with the exit code and last output', async () => {
		const h = setup();
		const answered = h.fire(request);
		await h.opened();
		const waiting = { found: h.service.find('runtime-1', '  gh auth login '), other: h.service.find('runtime-2', 'gh auth login') };
		h.exits.fire(0);
		await answered;
		h.exits.fire(1);
		assert.deepStrictEqual({ log: h.log, waiting, changes: h.changes, pending: h.service.pending }, {
			log: [
				'create {"name":"Claude: gh auth login","executable":"/bin/zsh","args":["-c","gh auth login"],"cwd":"/work/app","waitOnExit":"string"}',
				'reveal',
				'focus true',
				'resolve runtime-1 r1 {"kind":"exited","exitCode":0,"lastOutput":"? Authenticate Git with your GitHub credentials? Yes\\nLogged in as octocat"}',
			],
			waiting: {
				found: { requestId: 'r1', runtimeSessionId: 'runtime-1', command: 'gh auth login', reason: 'Finish signing in to GitHub.' },
				other: undefined,
			},
			changes: [['r1 gh auth login'], []],
			pending: [],
		});
	});

	test('Open reveals the terminal again; Cancel answers cancelled and closes it; closing the terminal answers cancelled', async () => {
		const h = setup();
		const cancelled = h.fire(request);
		await h.opened();
		h.log.length = 0;
		await h.service.open('r1');
		h.service.cancel('r1');
		await cancelled;
		h.service.cancel('r1');
		const closed = setup();
		const closedAnswer = closed.fire({ ...request, requestId: 'r2' });
		await closed.opened();
		closed.log.length = 0;
		closed.exits.fire(undefined);
		await closedAnswer;
		assert.deepStrictEqual([h.log, closed.log], [
			[
				'reveal',
				'focus true',
				'resolve runtime-1 r1 {"kind":"cancelled","lastOutput":"? Authenticate Git with your GitHub credentials? Yes\\nLogged in as octocat"}',
				'dispose terminal',
			],
			['resolve runtime-1 r2 {"kind":"cancelled","lastOutput":"? Authenticate Git with your GitHub credentials? Yes\\nLogged in as octocat"}'],
		]);
	});

	test('a terminal that cannot start answers failed, and a request for another window\'s session is ignored', async () => {
		const failed = setup({ failCreate: true });
		await failed.fire(request);
		const elsewhere = setup();
		elsewhere.requests.fire({ ...request, sessionId: 'runtime-elsewhere' });
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.deepStrictEqual([failed.log, failed.changes, elsewhere.log, elsewhere.service.pending], [
			['resolve runtime-1 r1 {"kind":"failed","message":"no pty host"}'],
			[['r1 gh auth login'], []],
			[],
			[],
		]);
	});
});
