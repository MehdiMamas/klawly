/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { ClaudeReproductionAnswer, ClaudeReproductionRequest } from '../../../../platform/claude/common/claudeDebugMode.js';
import { IDebugService, IDebugSession } from '../../debug/common/debug.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { onDidPreviewConsole } from '../common/claudePreview.js';
import { ClaudeDebugSourceBuffer } from '../../../../platform/claude/common/claudeDebugSources.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { CLAUDE_DEBUG_TERMINAL_LINES_SETTING } from '../../../../platform/claude/common/claudeConfiguration.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { ClaudeReproductionView, IClaudeReproductionService } from '../common/claudeReproductions.js';

/**
 * The window side of Debug mode's Reproduce card (issue 484). The shared
 * process holds the `request_reproduction` call until this window answers it,
 * and keeps the log lines; this service only tracks what the card shows.
 */
export class ClaudeReproductionService extends Disposable implements IClaudeReproductionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _views = new Map<string, ClaudeReproductionView>();
	private readonly _sources = new ClaudeDebugSourceBuffer();
	private readonly _sessionWatchers = this._register(new DisposableMap<string, DisposableStore>());

	constructor(
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@ILogService private readonly _log: ILogService,
		@IDebugService debugService: IDebugService,
		@ITerminalService terminalService: ITerminalService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();
		// Debug mode also reads the debug adapter's output, the terminals and the preview console (issue 881).
		// They are read only while the user's capture runs, and only the lines of that window go to Claude.
		const watch = (session: IDebugSession) => {
			const store = new DisposableStore();
			store.add(session.onDidChangeReplElements(element => element && this._sources.add('debug', element.toString())));
			store.add(session.onDidEndAdapter(() => this._sessionWatchers.deleteAndDispose(session.getId())));
			this._sessionWatchers.set(session.getId(), store);
		};
		debugService.getModel().getSessions().forEach(watch);
		this._register(debugService.onDidNewSession(watch));
		// Terminals can show secrets, so a setting leaves them out (issue 1061).
		this._register(terminalService.onAnyInstanceData(e => {
			if (configurationService.getValue(CLAUDE_DEBUG_TERMINAL_LINES_SETTING) !== false) {
				this._sources.add('terminal', e.data);
			}
		}));
		this._register(onDidPreviewConsole(message => this._sources.add('console', message)));
		const onRequest = this._runtime.onDidRequestReproduction;
		if (onRequest) {
			this._register(onRequest(request => this.handle(request)));
		}
	}

	find(runtimeSessionId: string): ClaudeReproductionView | undefined {
		return [...this._views.values()].reverse().find(view => view.runtimeSessionId === runtimeSessionId);
	}

	start(requestId: string): void {
		const view = this._views.get(requestId);
		if (!view || view.capturing) {
			return;
		}
		this._sources.start();
		this._views.set(requestId, { ...view, capturing: true });
		this._onDidChange.fire();
		this._runtime.startDebugCapture?.(view.runtimeSessionId, requestId).catch(error => this._log.warn('[claude] Could not start the debug capture.', error));
	}

	finish(requestId: string): void {
		this.settle(requestId, 'reproduced');
	}

	cancel(requestId: string): void {
		this.settle(requestId, 'cancelled');
	}

	override dispose(): void {
		for (const requestId of [...this._views.keys()]) {
			this.settle(requestId, 'cancelled');
		}
		super.dispose();
	}

	private handle(request: ClaudeReproductionRequest): void {
		// Every window hears the request. Only the window that started the session shows the card.
		if (!this._agent.getSessions().some(session => this._agent.getRuntimeSessionId(session.id) === request.sessionId)) {
			return;
		}
		// Claude waits on one reproduction at a time; an older one of the session ended with its tool call.
		for (const [requestId, view] of [...this._views]) {
			if (view.runtimeSessionId === request.sessionId) {
				this._views.delete(requestId);
			}
		}
		this._views.set(request.requestId, { requestId: request.requestId, runtimeSessionId: request.sessionId, steps: request.steps, capturing: false });
		this._onDidChange.fire();
	}

	private settle(requestId: string, answer: ClaudeReproductionAnswer): void {
		const view = this._views.get(requestId);
		if (!view) {
			return;
		}
		this._views.delete(requestId);
		this._onDidChange.fire();
		this._runtime.resolveReproduction?.(view.runtimeSessionId, requestId, answer, this._sources.take()).catch(error => this._log.warn('[claude] Could not answer request_reproduction.', error));
	}
}

/** Instantiates the service once the window is up, so it hears requests. */
export class ClaudeReproductionContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeReproduction';

	constructor(@IClaudeReproductionService _reproductions: IClaudeReproductionService) { }
}
