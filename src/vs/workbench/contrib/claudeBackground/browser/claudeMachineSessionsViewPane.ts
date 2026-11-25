/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { toAction } from '../../../../base/common/actions.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { buildMachineSessionRows, IClaudeMachineSession, IClaudeMachineSessionResult, IClaudeMachineSessionService, IMachineSessionRow, planMachineCleanup } from '../../../../platform/claude/common/claudeMachineSessions.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { CLAUDE_SESSIONS_VIEW_ID } from '../common/claudeBackground.js';
import '../../claude/browser/media/claude.css';

/** Refresh period. The shared list is cached for 10 s machine-wide, so a faster tick would only re-read the cache. */
const REFRESH_MS = 15_000;

/**
 * The Agents window list (issue 1251): every Claude Code session on this PC, managers with their
 * workers underneath, each row readable at a glance (what it is, its state in plain words, next step).
 */
export class ClaudeMachineSessionsViewPane extends ViewPane {
	static readonly ID = CLAUDE_SESSIONS_VIEW_ID;

	private readonly _rows = this._register(new DisposableStore());
	private _body: HTMLElement | undefined;
	private _sessions: readonly IClaudeMachineSession[] = [];
	private _error: string | undefined;
	private _loaded = false;
	private readonly _refresh = this._register(new RunOnceScheduler(() => { void this.refresh(); }, REFRESH_MS));

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
		@IClaudeMachineSessionService private readonly _service: IClaudeMachineSessionService,
		@IDialogService private readonly _dialogs: IDialogService,
		@INotificationService private readonly _notifications: INotificationService,
		@IHostService private readonly _host: IHostService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const pane = append(container, $('.claude-pane.claude-root.claude-sessions'));
		pane.setAttribute('aria-label', localize('claudeSessionsPane', "Sessions"));
		this._body = append(pane, $('.claude-sessions-body'));
		this._render();
		void this.refresh();
	}

	/** Reads the list again and redraws. Called on a timer and after every command. */
	async refresh(): Promise<void> {
		try {
			this._sessions = await this._service.list();
			this._error = undefined;
		} catch (error) {
			this._error = error instanceof Error ? error.message : String(error);
		}
		this._loaded = true;
		this._render();
		this._refresh.schedule();
	}

	async stop(session: IClaudeMachineSession): Promise<void> {
		await this._run(
			localize('claudeSessionStopConfirm', "Stop {0}?", session.name),
			localize('claudeSessionStopDetail', "It stops working now. Its conversation is kept."),
			localize('claudeSessionStopButton', "Stop"),
			() => this._service.stop(session.id));
	}

	async kill(session: IClaudeMachineSession): Promise<void> {
		await this._run(
			localize('claudeSessionKillConfirm', "Kill {0}?", session.name),
			localize('claudeSessionKillDetail', "Its process ends at once, without a chance to save. Use this only when Stop does not work."),
			localize('claudeSessionKillButton', "Kill"),
			() => this._service.kill(session.id));
	}

	async remove(session: IClaudeMachineSession): Promise<void> {
		await this._run(
			localize('claudeSessionDeleteConfirm', "Delete {0}?", session.name),
			localize('claudeSessionDeleteDetail', "The session and its folder are removed. Claude Code refuses if the folder holds unpushed commits."),
			localize('claudeSessionDeleteButton', "Delete"),
			() => this._service.remove(session.id));
	}

	async resume(session: IClaudeMachineSession): Promise<void> {
		await this._run(undefined, undefined, undefined, () => this._service.resume(session.id));
	}

	/** Opens the folder the session works in, in its own window. */
	async open(session: IClaudeMachineSession): Promise<void> {
		await this._host.openWindow([{ folderUri: URI.file(session.cwd) }], { forceNewWindow: true });
	}

	/** Deletes every finished or idle background session cleanup may take, and says what it kept and why. */
	async cleanUp(): Promise<void> {
		const now = Date.now();
		const plan = planMachineCleanup(buildMachineSessionRows(this._sessions, now), now);
		const kept = plan.kept.map(entry => localize('claudeSessionKeptLine', "{0}: {1}", entry.session.name, entry.reason));
		if (plan.steps.length === 0) {
			this._notifications.info(kept.length > 0
				? localize('claudeSessionsCleanNothingKept', "Nothing to clean up. Kept: {0}", kept.join('; '))
				: localize('claudeSessionsCleanNothing', "Nothing to clean up."));
			return;
		}
		const detail = [
			localize('claudeSessionsCleanList', "Deletes: {0}", plan.steps.map(step => step.session.name).join(', ')),
			...(kept.length > 0 ? [localize('claudeSessionsCleanKept', "Keeps: {0}", kept.join('; '))] : []),
		].join('\n');
		const { confirmed } = await this._dialogs.confirm({
			message: localize('claudeSessionsCleanConfirm', "Delete {0} finished or idle sessions?", plan.steps.length),
			detail,
			primaryButton: localize('claudeSessionsCleanButton', "Clean Up"),
		});
		if (!confirmed) {
			return;
		}
		let removed = 0;
		const failed: string[] = [];
		for (const step of plan.steps) {
			if (step.stopFirst) {
				await this._service.stop(step.session.id);
			}
			const result = await this._service.remove(step.session.id);
			if (result.ok) {
				removed++;
			} else {
				failed.push(`${step.session.name}: ${result.message}`);
			}
		}
		this._notifications.info(failed.length > 0
			? localize('claudeSessionsCleanPartial', "Deleted {0}. Could not delete: {1}", removed, failed.join('; '))
			: localize('claudeSessionsCleanDone', "Deleted {0} sessions.", removed));
		await this.refresh();
	}

	private async _run(message: string | undefined, detail: string | undefined, primaryButton: string | undefined, command: () => Promise<IClaudeMachineSessionResult>): Promise<void> {
		if (message && !(await this._dialogs.confirm({ message, detail, primaryButton })).confirmed) {
			return;
		}
		try {
			const result = await command();
			if (result.ok) {
				this._notifications.info(result.message);
			} else {
				this._notifications.error(result.message);
			}
		} catch (error) {
			this._notifications.error(error instanceof Error ? error.message : String(error));
		}
		await this.refresh();
	}

	private _render(): void {
		if (!this._body) {
			return;
		}
		this._rows.clear();
		clearNode(this._body);
		if (this._error) {
			append(this._body, $('.claude-history-empty')).textContent = localize('claudeSessionsError', "Could not list sessions: {0}. It tries again shortly.", this._error);
			return;
		}
		if (!this._loaded) {
			append(this._body, $('.claude-history-empty')).textContent = localize('claudeSessionsLoading', "Looking for Claude sessions on this PC...");
			return;
		}
		const rows = buildMachineSessionRows(this._sessions, Date.now());
		if (rows.length === 0) {
			append(this._body, $('.claude-history-empty')).textContent = localize('claudeSessionsEmpty', "No Claude sessions are running on this PC.");
			return;
		}
		const bar = append(this._body, $('.claude-sessions-bar'));
		const clean = append(bar, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
		clean.type = 'button';
		clean.textContent = localize('claudeSessionsCleanUp', "Clean Up Finished and Idle");
		this._rows.add(addDisposableListener(clean, EventType.CLICK, () => { void this.cleanUp(); }));
		const list = append(this._body, $('.claude-workers-list'));
		list.setAttribute('role', 'tree');
		for (const row of rows) {
			this._renderRow(list, row);
		}
	}

	private _renderRow(list: HTMLElement, row: IMachineSessionRow): void {
		const { session } = row;
		const el = append(list, $('.claude-worker-row'));
		el.classList.add(`is-${row.state.phase}`);
		el.setAttribute('role', 'treeitem');
		el.setAttribute('aria-level', String(row.depth + 1));
		el.style.marginLeft = `calc(var(--claude-space-4) * ${row.depth})`;
		el.tabIndex = 0;
		const head = append(el, $('.claude-worker-head'));
		append(head, $('span.claude-worker-name')).textContent = session.name;
		append(head, $('span.claude-worker-state')).textContent = row.state.text;
		append(head, $('span.claude-worker-number')).textContent = session.kind === 'interactive'
			? localize('claudeSessionKindTerminal', "Terminal session")
			: row.workerCount > 0
				? localize('claudeSessionKindManagerOf', "Manager of {0}", row.workerCount)
				: localize('claudeSessionKindWorker', "Background session");
		append(el, $('.claude-worker-meta')).textContent = localize('claudeSessionFolder', "{0} · {1}", basename(session.cwd), row.meta);
		append(el, $('.claude-worker-meta')).textContent = localize('claudeSessionNext', "Next: {0}", row.next);
		const actions = append(el, $('.claude-sessions-actions'));
		const button = (label: string, run: () => Promise<void>, ghost = true) => {
			const b = append(actions, $<HTMLButtonElement>(ghost ? 'button.claude-btn.is-small.is-ghost' : 'button.claude-btn.is-small'));
			b.type = 'button';
			b.textContent = label;
			this._rows.add(addDisposableListener(b, EventType.CLICK, e => { e.stopPropagation(); void run(); }));
		};
		button(localize('claudeSessionOpenButton', "Open"), () => this.open(session));
		if (row.canStop) {
			button(localize('claudeSessionStopLabel', "Stop"), () => this.stop(session), false);
		}
		if (row.canResume) {
			button(localize('claudeSessionResumeLabel', "Resume"), () => this.resume(session), false);
		}
		if (row.canDelete) {
			button(localize('claudeSessionDeleteLabel', "Delete"), () => this.remove(session));
		}
		this._rows.add(addDisposableListener(el, EventType.CONTEXT_MENU, e => {
			e.preventDefault();
			e.stopPropagation();
			this.contextMenuService.showContextMenu({
				getAnchor: () => ({ x: e.clientX, y: e.clientY }),
				getActions: () => [
					toAction({ id: 'claude.sessions.open', label: localize('claudeSessionOpenMenu', "Open"), run: () => this.open(session) }),
					toAction({ id: 'claude.sessions.stop', label: localize('claudeSessionStopMenu', "Stop"), enabled: row.canStop, run: () => this.stop(session) }),
					toAction({ id: 'claude.sessions.kill', label: localize('claudeSessionKillMenu', "Kill"), enabled: row.canKill, run: () => this.kill(session) }),
					toAction({ id: 'claude.sessions.resume', label: localize('claudeSessionResumeMenu', "Resume"), enabled: row.canResume, run: () => this.resume(session) }),
					toAction({ id: 'claude.sessions.delete', label: localize('claudeSessionDeleteMenu', "Delete"), enabled: row.canDelete, run: () => this.remove(session) }),
				],
			});
		}));
	}
}
