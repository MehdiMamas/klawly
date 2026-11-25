/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CLAUDE_TERMINAL_MIRROR_SETTING } from '../../../../platform/claude/common/claudeConfiguration.js';
import { NormalizedClaudeEvent } from '../../../../platform/claude/common/claudeProtocol.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProcessPropertyMap, ITerminalChildProcess, ITerminalLaunchError, ITerminalLaunchResult, ProcessPropertyType, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { BasePty } from '../../terminal/common/basePty.js';
import { ClaudeCommandMirror } from '../common/claudeCommandMirror.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { KLAWLY_CATEGORY } from '../common/claudeViews.js';

export const IClaudeCommandTerminalService = createDecorator<IClaudeCommandTerminalService>('claudeCommandTerminalService');

/**
 * The "Claude" terminal (issue 742, DL-76): a read-only terminal in the Terminal panel
 * that shows every shell command Claude runs in this window, its output, and
 * which commands still run in the background.
 */
export interface IClaudeCommandTerminalService {
	readonly _serviceBrand: undefined;
	/** Opens the terminal, creating it again if the user closed it. */
	show(): Promise<void>;
}

/** A terminal process that only prints what the mirror writes; typing does nothing. */
class ClaudeCommandPty extends BasePty implements ITerminalChildProcess {
	private _started = false;
	private _closed = false;

	constructor(id: number, private readonly _history: () => string) {
		super(id, false);
	}

	async start(): Promise<ITerminalLaunchError | ITerminalLaunchResult | undefined> {
		this.handleReady({ pid: -1, cwd: '', windowsPty: undefined });
		const history = this._history();
		if (history) {
			this.handleData(history);
		}
		this._started = true;
		return undefined;
	}

	write(text: string): void {
		if (this._started && !this._closed) {
			this.handleData(text);
		}
	}

	input(_data: string): void { }

	resize(cols: number, rows: number): void {
		this._lastDimensions.cols = cols;
		this._lastDimensions.rows = rows;
	}

	shutdown(_immediate: boolean): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		// The process manager still listens while it calls shutdown, so exit comes later, as for any other pty.
		queueMicrotask(() => {
			this.handleExit(undefined);
			this.dispose();
		});
	}

	clearBuffer(): void { }

	acknowledgeDataEvent(_charCount: number): void { }

	async setUnicodeVersion(_version: '6' | '11'): Promise<void> { }

	async processBinary(_data: string): Promise<void> { }

	sendSignal(_signal: string): void { }

	async refreshProperty<T extends ProcessPropertyType>(property: T): Promise<IProcessPropertyMap[T]> {
		return this._properties[property];
	}

	async updateProperty<T extends ProcessPropertyType>(_property: T, _value: IProcessPropertyMap[T]): Promise<void> { }
}

export class ClaudeCommandTerminalService extends Disposable implements IClaudeCommandTerminalService {
	declare readonly _serviceBrand: undefined;

	private readonly _mirror = new ClaudeCommandMirror();
	private readonly _instanceListener = this._register(new MutableDisposable());
	private _pty: ClaudeCommandPty | undefined;
	private _instance: ITerminalInstance | undefined;
	private _creating: Promise<ITerminalInstance | undefined> | undefined;
	/** The user closed the terminal: it comes back only through {@link show}. */
	private _closedByUser = false;

	constructor(
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@ITerminalService private readonly _terminals: ITerminalService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this._register(this._agent.onDidReceiveEvent(event => this.onEvent(event)));
	}

	async show(): Promise<void> {
		this._closedByUser = false;
		const instance = await this.ensureTerminal();
		if (instance) {
			await this._terminals.revealTerminal(instance);
		}
	}

	private onEvent(event: NormalizedClaudeEvent): void {
		if (!this._configuration.getValue<boolean>(CLAUDE_TERMINAL_MIRROR_SETTING)) {
			return;
		}
		const text = this._mirror.accept(event, this.chatTitle(event.sessionId));
		if (!text) {
			return;
		}
		if (this._pty) {
			this._pty.write(text);
		} else if (!this._closedByUser) {
			// The new terminal prints the mirror's history, this text included. It does not take focus.
			void this.ensureTerminal();
		}
	}

	private chatTitle(runtimeSessionId: string): string | undefined {
		return this._agent.getSessions().find(session => this._agent.getRuntimeSessionId(session.id) === runtimeSessionId)?.title;
	}

	private ensureTerminal(): Promise<ITerminalInstance | undefined> {
		if (this._instance) {
			return Promise.resolve(this._instance);
		}
		this._creating ??= this.create().finally(() => this._creating = undefined);
		return this._creating;
	}

	private async create(): Promise<ITerminalInstance | undefined> {
		try {
			const instance = await this._terminals.createTerminal({
				location: TerminalLocation.Panel,
				config: {
					name: localize('claudeCommandTerminalName', "Claude"),
					icon: Codicon.terminal,
					isTransient: true,
					customPtyImplementation: id => {
						const pty = new ClaudeCommandPty(id, () => this._mirror.history);
						this._pty = pty;
						return pty;
					},
				},
			});
			this._instance = instance;
			this._instanceListener.value = instance.onDisposed(() => {
				this._instance = undefined;
				this._pty = undefined;
				this._closedByUser = true;
			});
			return instance;
		} catch (error) {
			this._pty = undefined;
			this._log.warn('[claude] Could not open the Claude terminal.', error);
			return undefined;
		}
	}
}

/** Instantiates the service once the window is up, so it hears Claude's commands. */
export class ClaudeCommandTerminalContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeCommandTerminal';

	constructor(@IClaudeCommandTerminalService _terminal: IClaudeCommandTerminalService) { }
}

export function registerClaudeCommandTerminalActions(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'claude.showCommandTerminal',
				title: localize2('claudeShowCommandTerminal', "Show Claude's Commands in Terminal"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(IClaudeCommandTerminalService).show();
		}
	});
}
