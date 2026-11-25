/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { localize } from '../../../../../nls.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { CLAUDE_STATUS_LINE_ENABLED_SETTING, CLAUDE_STATUS_LINE_SHOW_COST_SETTING, ClaudeStatusLineInput, parseClaudeStatusLine } from '../../../../../platform/claude/common/claudeStatusLine.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudeWorkerRegistry } from '../../../../services/claude/common/claudeWorkerRegistry.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'claude',
	order: 102,
	title: localize('claudeConfigurationTitle', "AI / Claude"),
	type: 'object',
	properties: {
		[CLAUDE_STATUS_LINE_ENABLED_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeStatusLineEnabled', "Shows Claude Code's status line under the composer when your Claude settings define a statusLine command. Klawly runs the command after each turn, as Claude Code does; a project's command runs only in a trusted workspace."),
		},
		[CLAUDE_STATUS_LINE_SHOW_COST_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeStatusLineShowCost', "Gives the status line command the chat's cost, so lines that print it show it. Turn it off to keep the cost out of the line."),
		},
	},
});

/** Changes that come close together run the command once. */
const REFRESH_DELAY_MS = 300;

/**
 * Claude Code's status line under the composer (issue 515): the first line the
 * user's `statusLine` command prints, in its ANSI colors mapped to the theme's
 * terminal colors. It runs again when the chat changes, when a turn ends and when
 * the model changes, and hides while there is no status line or it failed.
 */
export class ClaudeStatusLine extends Disposable {
	readonly element: HTMLElement;
	private readonly _refresh = this._register(new RunOnceScheduler(() => void this.run(), REFRESH_DELAY_MS));
	/** What the last run was for, so only a real change runs the command again. */
	private _key: string | undefined;
	private _generation = 0;

	constructor(
		container: HTMLElement,
		private readonly _onDidChangeHeight: () => void,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly _trust: IWorkspaceTrustManagementService,
		@IClaudeWorkerRegistry private readonly _workers: IClaudeWorkerRegistry,
	) {
		super();
		this.element = append(container, $('.claude-status-line'));
		this.element.hidden = true;
		this.element.setAttribute('role', 'status');
		this._register(this._agent.onDidChangeSession(() => this.schedule()));
		this._register(this._agent.onDidChangeViewState(event => {
			if (event.sessionId === this._agent.getCurrentSession()?.id) {
				this.schedule();
			}
		}));
		this._register(this._trust.onDidChangeTrust(() => this.schedule(true)));
		this._register(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_STATUS_LINE_ENABLED_SETTING) || event.affectsConfiguration(CLAUDE_STATUS_LINE_SHOW_COST_SETTING)) {
				this.schedule(true);
			}
		}));
		this.schedule(true);
	}

	/** Runs the command soon, if what it describes changed (or always when `force`). */
	private schedule(force = false): void {
		if (force) {
			this._key = undefined;
		}
		this._refresh.schedule();
	}

	private async run(): Promise<void> {
		const session = this._agent.getCurrentSession();
		const folder = this._workspace.getWorkspace().folders.find(candidate => candidate.uri.scheme === Schemas.file)?.uri.fsPath;
		if (!session || !folder || !this._runtime.runStatusLine || this._configuration.getValue<boolean>(CLAUDE_STATUS_LINE_ENABLED_SETTING) === false) {
			this.show(undefined);
			return;
		}
		const state = this._agent.getViewState(session.id);
		const last = state.turns.at(-1);
		// Like Claude Code, the line updates when a turn ends, not while it streams.
		if (last?.status === 'running') {
			return;
		}
		const cwd = session.worktreePath ?? folder;
		// What every run the chat started cost (delegates, background, multitask and subagents) rolls up into the chat's cost (issues 693, 836).
		const workers = this._workers.sessionTotals(session.id);
		const showCost = this._configuration.getValue<boolean>(CLAUDE_STATUS_LINE_SHOW_COST_SETTING) !== false;
		const cost = showCost && (state.usage?.costUsd !== undefined || workers.runs > 0) ? (state.usage?.costUsd ?? 0) + workers.costUsd : undefined;
		const key = JSON.stringify([session.id, session.modelId, last?.id, last?.status, cwd, cost]);
		if (key === this._key) {
			return;
		}
		this._key = key;
		const generation = ++this._generation;
		const input: ClaudeStatusLineInput = {
			hook_event_name: 'Status',
			session_id: session.claudeSessionId,
			cwd,
			model: session.modelId || session.modelName ? { id: session.modelId, display_name: session.modelName } : undefined,
			workspace: { current_dir: cwd, project_dir: folder },
			version: (await this._runtime.getRuntimeState().catch(() => undefined))?.version,
			cost: cost !== undefined ? { total_cost_usd: cost } : undefined,
		};
		const result = await this._runtime.runStatusLine({ cwd, trusted: this._trust.isWorkspaceTrusted(), input }).catch(() => undefined);
		if (generation !== this._generation || this._store.isDisposed) {
			return;
		}
		this.show(result?.kind === 'line' ? result.text : undefined);
	}

	private show(text: string | undefined): void {
		const wasHidden = this.element.hidden;
		clearNode(this.element);
		this.element.hidden = text === undefined;
		for (const segment of text === undefined ? [] : parseClaudeStatusLine(text)) {
			const span = append(this.element, $('span'));
			span.textContent = segment.text;
			if (typeof segment.color === 'number') {
				span.classList.add(`ansi-${segment.color}`);
			} else if (segment.color) {
				span.style.color = segment.color;
			}
			span.classList.toggle('is-bold', !!segment.bold);
			span.classList.toggle('is-dim', !!segment.dim);
		}
		this.element.title = text === undefined ? '' : this.element.textContent ?? '';
		if (!wasHidden || !this.element.hidden) {
			this._onDidChangeHeight();
		}
	}
}
