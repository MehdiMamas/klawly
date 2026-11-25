/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { OS } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { claudeTerminalLastOutput, ClaudeTerminalRunRequest, ClaudeTerminalRunResult, claudeTerminalShellArgs } from '../../../../platform/claude/common/claudeTerminalRun.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITerminalLaunchError } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { ITerminalProfileResolverService } from '../../terminal/common/terminal.js';
import { ClaudeTerminalRunView, IClaudeTerminalRunService } from '../common/claudeTerminalRuns.js';

/** Longest command shown in the terminal tab's name. */
const MAX_TERMINAL_NAME = 40;

interface PendingRun {
	readonly view: ClaudeTerminalRunView;
	instance?: ITerminalInstance;
	settled: boolean;
}

/**
 * Runs Claude's `run_in_terminal` calls (issue 452). The shared process holds
 * the tool call until this window answers, so every request this window owns
 * is answered exactly once: when the command exits, when the user closes the
 * terminal or presses Cancel, or when the terminal cannot start.
 */
export class ClaudeTerminalRunService extends Disposable implements IClaudeTerminalRunService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _runs = new Map<string, PendingRun>();
	private readonly _stores = this._register(new DisposableMap<string, DisposableStore>());

	constructor(
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@ITerminalService private readonly _terminals: ITerminalService,
		@ITerminalProfileResolverService private readonly _profiles: ITerminalProfileResolverService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		const onRequest = this._runtime.onDidRequestTerminalRun;
		if (onRequest) {
			this._register(onRequest(request => void this.handle(request)));
		}
	}

	get pending(): readonly ClaudeTerminalRunView[] {
		return [...this._runs.values()].map(run => run.view);
	}

	find(runtimeSessionId: string, command: string): ClaudeTerminalRunView | undefined {
		const wanted = command.trim();
		return this.pending.find(view => view.runtimeSessionId === runtimeSessionId && view.command === wanted);
	}

	async open(requestId: string): Promise<void> {
		const instance = this._runs.get(requestId)?.instance;
		if (instance) {
			await this._terminals.revealTerminal(instance);
			await instance.focusWhenReady(true);
		}
	}

	cancel(requestId: string): void {
		const run = this._runs.get(requestId);
		if (!run) {
			return;
		}
		const lastOutput = run.instance ? this.lastOutput(run.instance) : undefined;
		void this.settle(run, { kind: 'cancelled', lastOutput });
		run.instance?.dispose();
	}

	override dispose(): void {
		for (const run of [...this._runs.values()]) {
			void this.settle(run, { kind: 'cancelled' });
		}
		super.dispose();
	}

	private async handle(request: ClaudeTerminalRunRequest): Promise<void> {
		// Every window hears the request. Only the window that started the session runs it.
		if (!this._agent.getSessions().some(session => this._agent.getRuntimeSessionId(session.id) === request.sessionId)) {
			return;
		}
		const run: PendingRun = {
			view: { requestId: request.requestId, runtimeSessionId: request.sessionId, command: request.command, reason: request.reason },
			settled: false,
		};
		this._runs.set(request.requestId, run);
		const store = new DisposableStore();
		this._stores.set(request.requestId, store);
		this._onDidChange.fire();
		try {
			const shell = await this._profiles.getDefaultShell({ remoteAuthority: undefined, os: OS });
			const instance = await this._terminals.createTerminal({
				config: {
					name: localize('claudeTerminalRunName', "Claude: {0}", shortCommand(request.command)),
					executable: shell,
					args: claudeTerminalShellArgs(shell, request.command),
					cwd: request.cwd,
					waitOnExit: localize('claudeTerminalRunDone', "The command ended. Claude continues in the chat. Press any key to close this terminal."),
				},
			});
			if (run.settled) {
				instance.dispose();
				return;
			}
			run.instance = instance;
			store.add(instance.onExit(exit => void this.settle(run, this.exitResult(instance, exit))));
			store.add(instance.onDisposed(() => void this.settle(run, { kind: 'cancelled', lastOutput: this.lastOutput(instance) })));
			await this._terminals.revealTerminal(instance);
			await instance.focusWhenReady(true);
		} catch (error) {
			this._log.warn('[claude] Could not open a terminal for run_in_terminal.', error);
			await this.settle(run, { kind: 'failed', message: error instanceof Error ? error.message : String(error) });
		}
	}

	private exitResult(instance: ITerminalInstance, exit: number | ITerminalLaunchError | undefined): ClaudeTerminalRunResult {
		if (typeof exit === 'object') {
			return { kind: 'failed', message: exit.message };
		}
		const exitCode = exit ?? instance.exitCode;
		const lastOutput = this.lastOutput(instance);
		return exitCode === undefined ? { kind: 'cancelled', lastOutput } : { kind: 'exited', exitCode, lastOutput };
	}

	private lastOutput(instance: ITerminalInstance): string {
		const xterm = instance.xterm;
		return xterm ? claudeTerminalLastOutput(xterm.getBufferReverseIterator()) : '';
	}

	private async settle(run: PendingRun, result: ClaudeTerminalRunResult): Promise<void> {
		if (run.settled) {
			return;
		}
		run.settled = true;
		this._runs.delete(run.view.requestId);
		this._stores.deleteAndDispose(run.view.requestId);
		this._onDidChange.fire();
		try {
			await this._runtime.resolveTerminalRun?.(run.view.runtimeSessionId, run.view.requestId, result);
		} catch (error) {
			this._log.warn('[claude] Could not answer run_in_terminal.', error);
		}
	}
}

/** Instantiates the service once the window is up, so it hears requests. */
export class ClaudeTerminalRunContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeTerminalRun';

	constructor(@IClaudeTerminalRunService _runs: IClaudeTerminalRunService) { }
}

function shortCommand(command: string): string {
	const line = command.split(/\r?\n/, 1)[0].trim();
	return line.length > MAX_TERMINAL_NAME ? `${line.slice(0, MAX_TERMINAL_NAME - 1)}…` : line;
}
