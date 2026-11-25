/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toAction } from '../../../../base/common/actions.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { CLAUDE_WORKERS_FINISHED_MINUTES_SETTING, CLAUDE_WORKERS_HUNG_MINUTES_SETTING, CLAUDE_WORKERS_VIEW_DEFAULTS, ClaudeWorkersViewThresholds, readClaudeWorkersMinutes } from '../../../../platform/claude/common/claudeWorkersViewSettings.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IClaudeBackgroundAgentService } from '../../../services/claude/common/claudeBackgroundAgent.js';
import { IClaudeDelegationService } from '../../../services/claude/common/claudeDelegation.js';
import { IClaudeMultitaskService } from '../../../services/claude/common/claudeMultitask.js';
import { buildWorkerHandoff, canMessageWorker, canRestartWorker, canStopWorker, ClaudeWorkerControlServices, freshWorkerHint, messageWorker, messageWorkerDisabledReason, restartWorker, restartWorkerDisabledReason, stopWorker, stopWorkerDisabledReason } from '../../../services/claude/common/claudeWorkerControls.js';
import { IClaudeWorkerRegistry, IClaudeWorkerRun } from '../../../services/claude/common/claudeWorkerRegistry.js';
import { buildWorkerDetail, buildWorkerRows, ClaudeWorkerFlag, ClaudeWorkerRow, formatWorkerCost, workerFlagText } from '../../../services/claude/common/claudeWorkersView.js';
import { CLAUDE_WORKERS_VIEW_ID } from '../common/claudeBackground.js';
import '../../claude/browser/media/claude.css';

function flagChipText(flag: ClaudeWorkerFlag): string {
	switch (flag) {
		case 'idle': return localize('claudeWorkerChipIdle', "Finished, still open");
		case 'hung': return localize('claudeWorkerChipHung', "May be stuck");
		case 'messages': return localize('claudeWorkerChipMessages', "Messages waiting");
		case 'quiet': return localize('claudeWorkerChipQuiet', "No report");
	}
}

/** The Workers view (issue 840): every worker run as a live tree, and a detail page per run. */
export class ClaudeWorkersViewPane extends ViewPane {
	static readonly ID = CLAUDE_WORKERS_VIEW_ID;

	private readonly _rows = this._register(new DisposableStore());
	private readonly _openIds = new Set<string>();
	private _body: HTMLElement | undefined;
	private _detailId: string | undefined;
	/** The worker the Stop Worker and Restart Worker commands act on: the open detail, else the last row focused or clicked. */
	private _selectedId: string | undefined;
	private readonly _controls: ClaudeWorkerControlServices;
	/** Flags depend on the clock, so the view redraws once a minute even when nothing changed. */
	private readonly _tick = this._register(new RunOnceScheduler(() => { this._render(); this._tick.schedule(); }, 60_000));

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IClaudeWorkerRegistry private readonly _registry: IClaudeWorkerRegistry,
		@IClaudeDelegationService delegation: IClaudeDelegationService,
		@IClaudeBackgroundAgentService background: IClaudeBackgroundAgentService,
		@IClaudeMultitaskService multitask: IClaudeMultitaskService,
		@IDialogService private readonly _dialogs: IDialogService,
		@INotificationService private readonly _notifications: INotificationService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@IClipboardService private readonly _clipboard: IClipboardService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._controls = { delegation, background, multitask };
		this._register(this._registry.onDidChange(() => this._render()));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CLAUDE_WORKERS_FINISHED_MINUTES_SETTING) || e.affectsConfiguration(CLAUDE_WORKERS_HUNG_MINUTES_SETTING)) {
				this._render();
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const pane = append(container, $('.claude-pane.claude-root.claude-workers'));
		pane.setAttribute('aria-label', localize('claudeWorkersPane', "Workers"));
		this._body = append(pane, $('.claude-workers-body'));
		this._render();
		this._tick.schedule();
	}

	/** The worker the Stop Worker and Restart Worker commands act on, if it is still in the registry. */
	selectedWorker(): IClaudeWorkerRun | undefined {
		const id = this._detailId ?? this._selectedId;
		return id ? this._registry.get(id) : undefined;
	}

	/** Stops a worker through the service that started it (issue 1100). */
	async stopWorker(run: IClaudeWorkerRun): Promise<void> {
		if (run.state === 'working' && !(await this._confirm(
			localize('claudeWorkerStopConfirm', "Stop {0}?", run.name),
			localize('claudeWorkerStopConfirmDetail', "Its work in progress is lost."),
			localize('claudeWorkerStopConfirmButton', "Stop Worker")))) {
			return;
		}
		await stopWorker(run, this._controls);
		this._notifications.info(localize('claudeWorkerStoppedNamed', "{0} stopped.", run.name));
	}

	/** Stops a hung worker and sends its task again (issue 1100). */
	async restartWorker(run: IClaudeWorkerRun): Promise<void> {
		if (!canRestartWorker(run)) {
			this._notifications.info(restartWorkerDisabledReason(run));
			return;
		}
		if (!(await this._confirm(
			localize('claudeWorkerRestartConfirm', "Restart {0}?", run.name),
			localize('claudeWorkerRestartConfirmDetail', "Its work in progress is lost and its task is sent again in the chat."),
			localize('claudeWorkerRestartConfirmButton', "Restart Worker")))) {
			return;
		}
		const sent = await restartWorker(run, this._controls);
		this._notifications.info(sent
			? localize('claudeWorkerRestartedNamed', "{0} restarted. Its task was sent again in the chat.", run.name)
			: localize('claudeWorkerRestartNotSentNamed', "{0} stopped, but its task could not be sent again. Send it again from the chat.", run.name));
	}

	/** Asks for a message and sends it to the worker; a busy worker queues it and a finished one resumes (issue 841). */
	async messageWorker(run: IClaudeWorkerRun): Promise<void> {
		if (!canMessageWorker(run)) {
			this._notifications.info(messageWorkerDisabledReason(run));
			return;
		}
		const text = await this._quickInput.input({
			prompt: localize('claudeWorkerMessagePrompt', "Message to {0}", run.name),
			placeHolder: freshWorkerHint(run) || localize('claudeWorkerMessagePlaceholder', "What should it do next?"),
		});
		if (!text?.trim()) {
			return;
		}
		const sent = await messageWorker(run, text, this._controls);
		this._notifications.info(sent
			? localize('claudeWorkerMessagedNamed', "Message sent to {0}.", run.name)
			: localize('claudeWorkerMessageNotSentNamed', "The message could not be sent to {0}.", run.name));
	}

	/** Copies the worker's handoff checkpoint for a new session to start from (issue 841). */
	async copyHandoff(run: IClaudeWorkerRun): Promise<void> {
		await this._clipboard.writeText(buildWorkerHandoff(run));
		this._notifications.info(localize('claudeWorkerHandoffCopied', "Handoff for {0} copied. Paste it into a new chat.", run.name));
	}

	private async _confirm(message: string, detail: string, primaryButton: string): Promise<boolean> {
		const { confirmed } = await this._dialogs.confirm({ message, detail, primaryButton });
		return confirmed;
	}

	private _thresholds(): ClaudeWorkersViewThresholds {
		return {
			finishedMinutes: readClaudeWorkersMinutes(this.configurationService.getValue(CLAUDE_WORKERS_FINISHED_MINUTES_SETTING), CLAUDE_WORKERS_VIEW_DEFAULTS.finishedMinutes),
			hungMinutes: readClaudeWorkersMinutes(this.configurationService.getValue(CLAUDE_WORKERS_HUNG_MINUTES_SETTING), CLAUDE_WORKERS_VIEW_DEFAULTS.hungMinutes),
		};
	}

	private _render(): void {
		if (!this._body) {
			return;
		}
		this._rows.clear();
		clearNode(this._body);
		if (this._detailId && this._registry.get(this._detailId)) {
			this._renderDetail(this._body, this._detailId);
			return;
		}
		this._detailId = undefined;
		const thresholds = this._thresholds();
		const rows = buildWorkerRows(this._registry, Date.now(), thresholds, this._openIds);
		if (rows.length === 0) {
			append(this._body, $('.claude-history-empty')).textContent = localize('claudeWorkersEmpty', "No workers yet. When Claude hands work to a worker, it shows here.");
			return;
		}
		const list = append(this._body, $('.claude-workers-list'));
		list.setAttribute('role', 'tree');
		for (const row of rows) {
			this._renderRow(list, row, thresholds);
		}
	}

	private _renderRow(list: HTMLElement, row: ClaudeWorkerRow, thresholds: ClaudeWorkersViewThresholds): void {
		const el = append(list, $('.claude-worker-row'));
		el.classList.add(`is-${row.state}`);
		if (row.collapsed) {
			el.classList.add('is-collapsed');
		}
		el.setAttribute('role', 'treeitem');
		el.setAttribute('aria-level', String(row.depth + 1));
		el.style.marginLeft = `calc(var(--claude-space-4) * ${row.depth})`;
		el.tabIndex = 0;
		const head = append(el, $('.claude-worker-head'));
		append(head, $('span.claude-worker-number')).textContent = row.number;
		append(head, $('span.claude-worker-name')).textContent = row.name;
		append(head, $('span.claude-worker-state')).textContent = row.stateText;
		const run = this._registry.get(row.id);
		for (const flag of row.flags) {
			const chip = append(head, $(`span.claude-worker-flag.is-${flag}`));
			chip.textContent = flagChipText(flag);
			if (run) {
				chip.title = workerFlagText(flag, run, thresholds);
			}
		}
		if (!row.collapsed) {
			if (row.templateText) {
				append(el, $('.claude-worker-meta')).textContent = row.templateText;
			}
			const meta = append(el, $('.claude-worker-meta'));
			meta.textContent = localize('claudeWorkerMeta', "{0} · context {1}k tokens · {2}", row.modelText, Math.round(row.contextTokens / 1000), row.hasChildren
				? localize('claudeWorkerMetaCostTree', "{0}, {1} with its workers", formatWorkerCost(row.costUsd), formatWorkerCost(row.subtreeCostUsd))
				: formatWorkerCost(row.costUsd));
		}
		this._rows.add(addDisposableListener(el, EventType.FOCUS, () => { this._selectedId = row.id; }));
		this._rows.add(addDisposableListener(el, EventType.CONTEXT_MENU, e => {
			e.preventDefault();
			e.stopPropagation();
			this._selectedId = row.id;
			if (run) {
				this._showRowMenu(e, run);
			}
		}));
		this._rows.add(addDisposableListener(el, EventType.CLICK, () => {
			this._selectedId = row.id;
			if (row.collapsed) {
				this._openIds.add(row.id);
			} else {
				this._detailId = row.id;
			}
			this._render();
		}));
	}

	private _showRowMenu(e: MouseEvent, run: IClaudeWorkerRun): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: e.clientX, y: e.clientY }),
			getActions: () => [
				toAction({ id: 'claude.workers.stop', label: localize('claudeWorkerStopMenu', "Stop Worker"), enabled: canStopWorker(run), tooltip: stopWorkerDisabledReason(run), run: () => this.stopWorker(run) }),
				toAction({ id: 'claude.workers.message', label: localize('claudeWorkerMessageMenu', "Message Worker"), enabled: canMessageWorker(run), tooltip: messageWorkerDisabledReason(run), run: () => this.messageWorker(run) }),
				toAction({ id: 'claude.workers.handoff', label: localize('claudeWorkerHandoffMenu', "Copy Handoff"), run: () => this.copyHandoff(run) }),
				toAction({ id: 'claude.workers.restart', label: localize('claudeWorkerRestartMenu', "Restart Worker"), enabled: canRestartWorker(run), tooltip: restartWorkerDisabledReason(run), run: () => this.restartWorker(run) }),
			],
		});
	}

	private _renderDetail(body: HTMLElement, id: string): void {
		const run = this._registry.get(id)!;
		const detail = buildWorkerDetail(run, [], this._registry.subtreeCost(id), Date.now(), this._thresholds());
		const back = append(body, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
		back.type = 'button';
		append(back, $(ThemeIcon.asCSSSelector(Codicon.arrowLeft)));
		append(back, $('span')).textContent = localize('claudeWorkersBack', "All workers");
		this._rows.add(addDisposableListener(back, EventType.CLICK, () => { this._detailId = undefined; this._render(); }));
		const card = append(body, $('.claude-worker-detail'));
		append(card, $('.claude-worker-detail-title')).textContent = detail.title;
		for (const fact of detail.facts) {
			append(card, $('.claude-worker-detail-fact')).textContent = fact;
		}
		if (detail.flags.length > 0) {
			append(card, $('.claude-worker-detail-heading')).textContent = localize('claudeWorkerAttentionHeading', "Needs attention");
			for (const flag of detail.flags) {
				append(card, $('.claude-worker-detail-flag')).textContent = flag;
			}
		}
		const hint = freshWorkerHint(run);
		if (hint) {
			append(card, $('.claude-worker-detail-flag')).textContent = hint;
		}
		{
			const actions = append(card, $('.claude-worker-detail-actions'));
			if (canMessageWorker(run)) {
				const message = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small'));
				message.type = 'button';
				message.textContent = localize('claudeWorkerMessageButton', "Message Worker");
				this._rows.add(addDisposableListener(message, EventType.CLICK, () => { void this.messageWorker(run); }));
			}
			const handoff = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
			handoff.type = 'button';
			handoff.textContent = localize('claudeWorkerHandoffButton', "Copy Handoff");
			this._rows.add(addDisposableListener(handoff, EventType.CLICK, () => { void this.copyHandoff(run); }));
			if (canStopWorker(run)) {
				const stop = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small'));
				stop.type = 'button';
				stop.textContent = localize('claudeWorkerStopButton', "Stop Worker");
				this._rows.add(addDisposableListener(stop, EventType.CLICK, () => { void this.stopWorker(run); }));
			}
			if (canRestartWorker(run)) {
				const restart = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
				restart.type = 'button';
				restart.textContent = localize('claudeWorkerRestartButton', "Restart Worker");
				this._rows.add(addDisposableListener(restart, EventType.CLICK, () => { void this.restartWorker(run); }));
			}
		}
		append(card, $('.claude-worker-detail-heading')).textContent = localize('claudeWorkerStepsHeading', "What it did");
		append(card, $('.claude-worker-detail-text')).textContent = detail.steps;
		append(card, $('.claude-worker-detail-heading')).textContent = localize('claudeWorkerReportHeading', "Report");
		append(card, $('.claude-worker-detail-text')).textContent = detail.report;
	}
}
