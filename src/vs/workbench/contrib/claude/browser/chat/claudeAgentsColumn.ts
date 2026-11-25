/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow, isHTMLElement, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { toAction } from '../../../../../base/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../../base/common/scrollable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ClaudeRuntimeState } from '../../../../../platform/claude/common/claude.js';
import { CLAUDE_CHAT_DRAG_MIME, encodeChatDrag } from '../../../../../platform/claude/common/claudeChatReference.js';
import { CLAUDE_CLOUD_BRING_BACK_COMMAND_ID, CLAUDE_CLOUD_SEND_COMMAND_ID, ClaudeCloudSessionRecord, claudeCloudSessionUrl } from '../../../../../platform/claude/common/claudeCloud.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { CLAUDE_AUTO_ENABLED_SETTING } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { IClaudeDelegationService } from '../../../../services/claude/common/claudeDelegation.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IKlawlySyncService, KlawlySyncImportedSession } from '../../../../../platform/claude/common/klawlySyncService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { markClaudeHandoffOpened, readClaudeHandoffs, CLAUDE_DEPARTMENT_INBOX_KEY } from '../../../../services/claude/common/claudeDepartmentInbox.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ClaudeAgentSession, IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudeAutomationService } from '../../../../services/claude/common/claudeAutomationService.js';
import { IClaudeBackgroundAgentService } from '../../../../services/claude/common/claudeBackgroundAgent.js';
import { IClaudeProjectIndex } from '../claudeProjects.js';
import { claudeAgentRowAuto, claudeAgentRowIcon, claudeImportedSessionInput, claudeMachineBadgeHover, ClaudeAgentRow, ClaudeAgentRowInput, ClaudeAgentRowState, ClaudeAgentsFilter, groupClaudeAgentRows, moveClaudeAgentRow } from '../../common/claudeAgentsList.js';
import { claudeAutomationTriggerIcon } from '../../common/claudeAutomationDraft.js';
import { CLAUDE_NEW_SESSION_COMMAND_ID, CLAUDE_OPEN_SETTINGS_COMMAND_ID, CLAUDE_SHOW_STATUS_COMMAND_ID } from '../../common/claudeViews.js';
import { IClaudeCloudSessionsService } from '../claudeCloudSessions.js';
import { IClaudeSetupService } from '../claudeSetup.js';
import { IClaudeGoalLoopService } from '../../common/claudeGoalLoopService.js';
import { renderPullRequestBadge } from './claudeGitHubCard.js';
import { claudeRunTargetIcon } from './claudeRunInPicker.js';
import { IClaudeGitHubDetailsService } from './claudeGitHubDetails.js';
import { appendClaudeKbd } from './claudeKbd.js';
import { ClaudeSessionActions } from './claudeSessionActions.js';

/** Width of the agents column next to the chat. */
export const CLAUDE_AGENTS_COLUMN_WIDTH = 214;

/** Where the Agents list remembers the order the user gave its rows, per workspace (issue 977). */
const AGENTS_ORDER_STORAGE_KEY = 'claude.agentsOrder';

/** Marks a drag that started on a row of this list, so only a row reorders it. */
const ROW_REORDER_MIME = 'application/x-claude-agent-row-reorder';

/** The chat keeps at least this much room; below it the column hides. */
export const CLAUDE_AGENTS_COLUMN_MIN_CHAT_WIDTH = 426;

/**
 * The agents column (ide-03): every local and background agent in one list,
 * by day, each row saying what its agent is doing now. Search, New Agent and
 * Customize sit on top; the runtime and a filter sit at the bottom.
 */
export class ClaudeAgentsColumn extends Disposable {
	readonly element: HTMLElement;

	private readonly _list: HTMLElement;
	private readonly _scroll: DomScrollableElement;
	private readonly _rowStore = this._register(new DisposableStore());
	private readonly _renderFrame = this._register(new MutableDisposable());
	private readonly _sessionActions: ClaudeSessionActions;
	private readonly _account: HTMLButtonElement;
	private readonly _accountName: HTMLElement;
	private readonly _accountDetail: HTMLElement;
	private readonly _filterButton: HTMLButtonElement;
	private readonly _collapsed = new Set<string>();
	/** Section titles and rows in list order, for keyboard focus. */
	private _focusables: HTMLElement[] = [];
	private _query = '';
	private _filter: ClaudeAgentsFilter = 'all';
	private _imported: readonly KlawlySyncImportedSession[] = [];
	private _visible = false;
	private _height = 0;
	/** The row being dragged and the rows of its group, so a drop only reorders within that group. */
	private _dragging: { readonly id: string; readonly groupIds: readonly string[] } | undefined;

	constructor(
		container: HTMLElement,
		/** Runs after a row opened its session, so the host can show the chat. */
		private readonly _opened: () => void,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeBackgroundAgentService private readonly _background: IClaudeBackgroundAgentService,
		@IClaudeAutomationService private readonly _automations: IClaudeAutomationService,
		@IClaudeSetupService private readonly _setup: IClaudeSetupService,
		@ICommandService private readonly _commands: ICommandService,
		@IContextMenuService private readonly _contextMenu: IContextMenuService,
		@IKeybindingService private readonly _keybindings: IKeybindingService,
		@IHoverService private readonly _hover: IHoverService,
		@IClaudeGitHubDetailsService private readonly _gitHubDetails: IClaudeGitHubDetailsService,
		@IClaudeCloudSessionsService private readonly _cloudSessions: IClaudeCloudSessionsService,
		@IClaudeGoalLoopService private readonly _goalLoop: IClaudeGoalLoopService,
		@IClaudeProjectIndex private readonly _projects: IClaudeProjectIndex,
		@IOpenerService private readonly _opener: IOpenerService,
		@IStorageService private readonly _storage: IStorageService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IClaudeDelegationService private readonly _delegation: IClaudeDelegationService,
		@IKlawlySyncService private readonly _sync: IKlawlySyncService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._sessionActions = instantiationService.createInstance(ClaudeSessionActions);
		this.element = append(container, $('.claude-agents.claude-root'));
		this.element.setAttribute('role', 'navigation');
		this.element.setAttribute('aria-label', localize('claudeAgentsColumn', "Agents"));
		this.element.hidden = true;

		const head = append(this.element, $('.claude-agents-head'));
		const search = append(head, $('.claude-field.is-wrapper.claude-agents-search'));
		append(search, $(ThemeIcon.asCSSSelector(Codicon.search)));
		const input = append(search, $<HTMLInputElement>('input'));
		input.type = 'search';
		input.placeholder = localize('claudeAgentsSearch', "Search agents...");
		input.setAttribute('aria-label', localize('claudeAgentsSearchAria', "Search agents"));
		this._register(addDisposableListener(input, EventType.INPUT, () => {
			this._query = input.value;
			this.render();
		}));
		const create = this.headRow(head, Codicon.add, localize('claudeNewAgent', "New Agent"), () => void this._commands.executeCommand(CLAUDE_NEW_SESSION_COMMAND_ID));
		const key = this._keybindings.lookupKeybinding(CLAUDE_NEW_SESSION_COMMAND_ID)?.getLabel();
		if (key) {
			appendClaudeKbd(create, key).classList.add('claude-agents-key');
		}
		this.headRow(head, Codicon.settingsGear, localize('claudeAgentsCustomize', "Customize"), () => void this._commands.executeCommand(CLAUDE_OPEN_SETTINGS_COMMAND_ID, 'customize'));

		this._list = $('.claude-agents-list');
		this._list.setAttribute('role', 'list');
		this._list.setAttribute('aria-label', localize('claudeAgentsList', "Agents"));
		this._register(addDisposableListener(this._list, EventType.KEY_DOWN, event => this.moveFocus(new StandardKeyboardEvent(event))));
		this._scroll = this._register(new DomScrollableElement(this._list, {
			vertical: ScrollbarVisibility.Auto,
			horizontal: ScrollbarVisibility.Hidden,
			consumeMouseWheelIfScrollbarIsNeeded: true,
		}));
		const scrollNode = append(this.element, this._scroll.getDomNode());
		scrollNode.classList.add('claude-agents-scroll');

		const footer = append(this.element, $('.claude-agents-footer'));
		this._account = append(footer, $<HTMLButtonElement>('button.claude-agents-account'));
		this._account.type = 'button';
		append(this._account, $('span.claude-agents-avatar' + ThemeIcon.asCSSSelector(Codicon.account)));
		const who = append(this._account, $('span.claude-agents-who'));
		this._accountName = append(who, $('span.claude-agents-name'));
		this._accountDetail = append(who, $('span.claude-agents-plan'));
		this._register(addDisposableListener(this._account, EventType.CLICK, () => void this._commands.executeCommand(CLAUDE_SHOW_STATUS_COMMAND_ID)));
		this._filterButton = append(footer, $<HTMLButtonElement>('button.claude-icon-btn.claude-agents-filter'));
		this._filterButton.type = 'button';
		this._filterButton.setAttribute('aria-haspopup', 'menu');
		append(this._filterButton, $(ThemeIcon.asCSSSelector(Codicon.filter)));
		this._register(this._hover.setupDelayedHover(this._filterButton, () => ({ content: this.filterLabel(), additionalClasses: ['claude-root'] })));
		this._register(addDisposableListener(this._filterButton, EventType.CLICK, () => this.showFilter()));
		this.renderAccount();

		this._register(this._agent.onDidChangeSession(() => this.schedule()));
		this._register(this._agent.onDidChangeViewState(() => this.schedule()));
		this._register(this._agent.onDidChangePending(() => this.schedule()));
		this._register(this._background.onDidChangeTasks(() => this.schedule()));
		// A goal or loop on a chat shows as a pill on its row (issue 687).
		this._register(this._goalLoop.onDidChange(() => this.schedule()));
		// A session's pull request state colors its badge (issue 430).
		this._register(this._gitHubDetails.onDidChange(event => {
			if (this._agent.getViewState(event.sessionId).pullRequest?.url === event.url) {
				this.schedule();
			}
		}));
		this._register(this._automations.onDidChange(() => this.schedule()));
		this._register(this._projects.onDidChange(() => this.schedule()));
		this._register(this._cloudSessions.onDidChange(() => this.schedule()));
		// A hand-off recorded or opened in any window changes the Departments timeline and unread counts (issue 1459).
		this._register(this._storage.onDidChangeValue(StorageScope.APPLICATION, CLAUDE_DEPARTMENT_INBOX_KEY, this._register(new DisposableStore()))(() => this.schedule()));
		this._register(this._setup.onDidChange(() => this.renderAccount()));
		// Issue 448: sessions other computers synced list next to the local ones; a sync pass can bring new ones.
		this._register(this._sync.onDidChangeStatus(() => void this.refreshImported()));
		void this.refreshImported();
	}

	/** Reads the sessions other computers synced and redraws when they changed (issue 448). */
	private async refreshImported(): Promise<void> {
		const sessions = await this._sync.listImportedSessions().catch(() => []);
		if (JSON.stringify(sessions) !== JSON.stringify(this._imported)) {
			this._imported = sessions;
			this.schedule();
		}
	}

	get visible(): boolean {
		return this._visible;
	}

	setVisible(visible: boolean): void {
		if (this._visible === visible) {
			return;
		}
		this._visible = visible;
		this.element.hidden = !visible;
		if (visible) {
			this.render();
		}
	}

	/** Shows only the agents `filter` picks, as the filter menu at the bottom does. */
	setFilter(filter: ClaudeAgentsFilter): void {
		this._filter = filter;
		this._filterButton.classList.toggle('is-active', filter !== 'all');
		if (this._visible) {
			this.render();
		}
	}

	layout(height: number): void {
		this._height = height;
		this.element.style.height = `${height}px`;
		this.layoutList();
	}

	/** Coalesces the bursts a streaming turn sends into one paint per frame. */
	private schedule(): void {
		if (!this._visible || this._renderFrame.value) {
			return;
		}
		this._renderFrame.value = scheduleAtNextAnimationFrame(getWindow(this.element), () => {
			this._renderFrame.clear();
			this.render();
		});
	}

	private render(): void {
		this._renderFrame.clear();
		if (!this._visible) {
			return;
		}
		const focusedId = this.focusedRowId();
		this._rowStore.clear();
		clearNode(this._list);
		this._focusables = [];
		// Archived chats show only in the history popover.
		const sessions = new Map(this._agent.getHistory().filter(session => !session.archived).map(session => [session.id, session]));
		// DL-10: cloud sessions started or messaged from this workspace list next to local agents with the cloud icon (issue 532).
		const cloud = new Map(this._cloudSessions.getSessions().map(record => [`cloud:${record.id}`, record]));
		const inputs = [...sessions.values()].map(session => this.rowInput(session));
		for (const [id, record] of cloud) {
			inputs.push({ id, title: record.title, updatedAt: record.updatedAt, turns: [], runTarget: 'cloud', cloudSessionId: record.sessionId });
		}
		// Issue 448: read-only rows with the machine badge; they have no live session to open.
		const imported = new Map(this._imported.map(session => [`imported:${session.id}`, session]));
		for (const session of imported.values()) {
			inputs.push(claudeImportedSessionInput(session));
		}
		const groups = groupClaudeAgentRows(inputs, Date.now(), this._query, this._filter, this.readOrder());
		if (!groups.length) {
			append(this._list, $('.claude-agents-empty')).textContent = this._query.trim() || this._filter !== 'all'
				? localize('claudeAgentsNoMatch', "No agents match.")
				: localize('claudeAgentsNone', "No agents yet.");
		}
		const current = this._agent.getCurrentSession()?.id;
		for (const group of groups) {
			const section = append(this._list, $('.claude-agents-section'));
			const collapsed = this._collapsed.has(group.id);
			const title = append(section, $<HTMLButtonElement>('button.claude-agents-section-title'));
			title.type = 'button';
			title.setAttribute('aria-expanded', String(!collapsed));
			this._focusables.push(title);
			if (group.icon) {
				append(title, $('span.claude-agents-section-icon' + ThemeIcon.asCSSSelector(group.icon)));
			}
			append(title, $('span.claude-agents-section-label')).textContent = group.label;
			if (group.badge) {
				const badge = append(title, $('span.claude-agents-section-badge'));
				badge.textContent = String(group.badge);
				badge.title = localize('claudeAgentsDepartmentsWaiting', "{0} waiting on you", group.badge);
			}
			if (group.unread) {
				const unread = append(title, $('span.claude-agents-section-badge.is-unread'));
				unread.textContent = String(group.unread);
				unread.title = localize('claudeAgentsDepartmentsUnread', "{0} unread hand-offs", group.unread);
			}
			append(title, $('span.claude-agents-chevron' + ThemeIcon.asCSSSelector(collapsed ? Codicon.chevronRight : Codicon.chevronDown)));
			this._rowStore.add(addDisposableListener(title, EventType.CLICK, () => {
				if (!this._collapsed.delete(group.id)) {
					this._collapsed.add(group.id);
				}
				this.render();
			}));
			if (collapsed) {
				continue;
			}
			const rows = append(section, $('.claude-agents-rows'));
			const groupIds = group.rows.map(row => row.id);
			for (const row of group.rows) {
				const session = sessions.get(row.id);
				const record = cloud.get(row.id);
				const synced = imported.get(row.id);
				if (synced) {
					this.renderImportedRow(rows, row, synced, groupIds);
				} else if (session) {
					this.renderRow(rows, row, session, row.id === current, groupIds);
				} else if (record) {
					this.renderCloudRow(rows, row, record, groupIds);
				}
			}
		}
		if (focusedId) {
			this._focusables.find(element => element.dataset.sessionId === focusedId)?.focus();
		}
		this.layoutList();
	}

	private renderRow(container: HTMLElement, row: ClaudeAgentRow, session: ClaudeAgentSession, selected: boolean, groupIds: readonly string[]): void {
		const item = append(container, $('.claude-agents-item'));
		item.setAttribute('role', 'listitem');
		const button = append(item, $<HTMLButtonElement>('button.claude-agents-row'));
		button.type = 'button';
		button.draggable = true;
		button.dataset.sessionId = row.id;
		button.dataset.state = row.state;
		this._focusables.push(button);
		this.wireReorder(button, item, row.id, groupIds);
		button.classList.toggle('is-selected', selected);
		button.classList.toggle('has-subtitle', !!row.subtitle);
		button.classList.toggle('is-unread', !!row.unread);
		if (selected) {
			button.setAttribute('aria-current', 'true');
		}
		append(button, $('span.claude-agents-state' + ThemeIcon.asCSSSelector(claudeAgentRowIcon(row.state, row.background))));
		const text = append(button, $('span.claude-agents-text'));
		append(text, $('span.claude-agents-title')).textContent = row.title;
		// The pull request the session created (issue 430). The row opens the session, where its tab pill and card are.
		const pullRequest = this._agent.getViewState(session.id).pullRequest;
		const pill = pullRequest && renderPullRequestBadge(button, pullRequest, this._gitHubDetails.get(session.id, pullRequest));
		const goalLabel = this.renderGoalLoopPill(button, session.id);
		if (row.subtitle) {
			append(text, $('span.claude-agents-subtitle')).textContent = row.subtitle;
		}
		// Issue 448: a session synced from another machine says which one; the hover names it.
		const machineLabel = row.machine && this.renderMachineBadge(button, row.machine);
		const live = row.state === 'running' || row.state === 'waiting';
		if (!live) {
			append(button, $('span.claude-agents-age')).textContent = fromNow(row.handoffAt ?? row.updatedAt);
		}
		if (row.unread) {
			append(button, $('span.claude-agents-unread-dot')).title = localize('claudeAgentsUnreadHandoff', "Handed over, not opened yet");
		}
		button.setAttribute('aria-label', [row.unread ? localize('claudeAgentsUnreadLabel', "Unread hand-off") : undefined, row.title, row.subtitle, stateLabel(row.state), pill, goalLabel, machineLabel].filter(Boolean).join(', '));

		// Hover actions take the age caption's place: Stop for a live agent, else Rename; then More.
		const actions = append(item, $('.claude-agents-actions'));
		if (live) {
			this.rowAction(actions, Codicon.debugStop, localize('claudeAgentsStop', "Stop"), () => void this._agent.stop(session.id));
		} else {
			this.rowAction(actions, Codicon.edit, localize('claudeAgentsRename', "Rename"), () => void this._sessionActions.rename(session));
		}
		this.rowAction(actions, Codicon.ellipsis, localize('claudeAgentsMore', "More Actions"), anchor => this.showRowMenu(session, { getAnchor: () => anchor }));

		this._rowStore.add(addDisposableListener(button, EventType.CLICK, () => {
			this._agent.selectSession(session.id);
			markClaudeHandoffOpened(this._storage, session.id);
			void this._agent.resume(session.id).catch(() => undefined);
			this._opened();
		}));
		this._rowStore.add(addDisposableListener(button, EventType.CONTEXT_MENU, event => {
			event.preventDefault();
			event.stopPropagation();
			this.showRowMenu(session, { getAnchor: () => ({ x: event.clientX, y: event.clientY }) });
		}));
		this._rowStore.add(addDisposableListener(button, 'dragstart', event => {
			const drag = event as DragEvent;
			const asOfTurn = Math.max(1, this._agent.getViewState(session.id).turns.length);
			drag.dataTransfer?.setData(CLAUDE_CHAT_DRAG_MIME, encodeChatDrag({ sessionId: session.id, asOfTurn }));
			drag.dataTransfer?.setData('text/plain', session.title);
		}));
	}

	/**
	 * Issue 977, DL-104: a row drags onto another row of its group and drops
	 * before or after it; Alt+Up and Alt+Down move the focused row one place.
	 * The order is remembered per workspace.
	 */
	private wireReorder(button: HTMLElement, item: HTMLElement, rowId: string, groupIds: readonly string[]): void {
		this._rowStore.add(addDisposableListener(button, 'dragstart', event => {
			(event as DragEvent).dataTransfer?.setData(ROW_REORDER_MIME, rowId);
			this._dragging = { id: rowId, groupIds };
		}));
		this._rowStore.add(addDisposableListener(button, 'dragend', () => {
			this._dragging = undefined;
			this.clearDropMarker();
		}));
		this._rowStore.add(addDisposableListener(item, 'dragover', event => {
			const drag = event as DragEvent;
			if (!this._dragging || this._dragging.id === rowId || !this._dragging.groupIds.includes(rowId) || !drag.dataTransfer?.types.includes(ROW_REORDER_MIME)) {
				return;
			}
			drag.preventDefault();
			drag.dataTransfer.dropEffect = 'move';
			this.clearDropMarker(item);
			item.classList.remove('drop-before', 'drop-after');
			item.classList.add(this.dropsBelow(item, drag) ? 'drop-after' : 'drop-before');
		}));
		this._rowStore.add(addDisposableListener(item, 'dragleave', () => item.classList.remove('drop-before', 'drop-after')));
		this._rowStore.add(addDisposableListener(item, 'drop', event => {
			const drag = event as DragEvent;
			const dragging = this._dragging;
			this._dragging = undefined;
			this.clearDropMarker();
			if (!dragging || dragging.id === rowId || !dragging.groupIds.includes(rowId)) {
				return;
			}
			drag.preventDefault();
			const at = groupIds.indexOf(rowId);
			this.moveRow(groupIds, dragging.id, this.dropsBelow(item, drag) ? groupIds[at + 1] : rowId);
		}));
		this._rowStore.add(addDisposableListener(button, EventType.KEY_DOWN, event => {
			if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
				return;
			}
			// The list's own handler would move the focus instead.
			event.preventDefault();
			event.stopPropagation();
			const at = groupIds.indexOf(rowId);
			if (event.key === 'ArrowUp' && at > 0) {
				this.moveRow(groupIds, rowId, groupIds[at - 1]);
			} else if (event.key === 'ArrowDown' && at >= 0 && at < groupIds.length - 1) {
				this.moveRow(groupIds, rowId, groupIds[at + 2]);
			}
		}));
	}

	/** True when the pointer is on the lower half of `item`. */
	private dropsBelow(item: HTMLElement, event: DragEvent): boolean {
		const rect = item.getBoundingClientRect();
		return event.clientY > rect.top + rect.height / 2;
	}

	private clearDropMarker(except?: HTMLElement): void {
		for (const marked of Array.from(this._list.querySelectorAll('.drop-before, .drop-after'))) {
			if (marked !== except) {
				marked.classList.remove('drop-before', 'drop-after');
			}
		}
	}

	private readOrder(): string[] {
		try {
			const parsed: unknown = JSON.parse(this._storage.get(AGENTS_ORDER_STORAGE_KEY, StorageScope.WORKSPACE) ?? '[]');
			return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
		} catch {
			return [];
		}
	}

	private moveRow(groupIds: readonly string[], movedId: string, beforeId: string | undefined): void {
		const next = moveClaudeAgentRow(this.readOrder(), groupIds, movedId, beforeId);
		this._storage.store(AGENTS_ORDER_STORAGE_KEY, JSON.stringify(next), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.render();
		this._focusables.find(element => element.dataset.sessionId === movedId)?.focus();
	}

	/** The goal or loop a chat runs, as a static pill on its row (issue 687, DL-15). Returns its label for the row's aria-label. */
	private renderGoalLoopPill(button: HTMLElement, sessionId: string): string | undefined {
		const goal = this._goalLoop.getGoal(sessionId);
		const loop = goal ? undefined : this._goalLoop.getLoop(sessionId);
		const label = goal
			? (goal.status === 'met'
				? localize('claudeAgentsGoalMet', "Goal met")
				: localize('claudeAgentsGoalTurn', "Goal {0}/{1}", goal.turn, goal.maxTurns))
			: loop && localize('claudeAgentsLoopRuns', "Loop ×{0}", loop.runs);
		if (!label) {
			return undefined;
		}
		const pill = append(button, $('span.claude-pr-pill.claude-goal-pill.is-static'));
		pill.dataset.state = goal ? goal.status : loop!.status;
		append(pill, $(ThemeIcon.asCSSSelector(goal ? Codicon.target : Codicon.sync)));
		append(pill, $('span')).textContent = label;
		return label;
	}

	/**
	 * A cloud session's row (issue 532): the cloud icon, where it runs, and its
	 * age. Klawly does not stream cloud sessions, so the row opens it on
	 * claude.ai; More offers Bring Back, Send Message and Remove from List.
	 */
	private renderCloudRow(container: HTMLElement, row: ClaudeAgentRow, record: ClaudeCloudSessionRecord, groupIds: readonly string[]): void {
		const item = append(container, $('.claude-agents-item'));
		item.setAttribute('role', 'listitem');
		const button = append(item, $<HTMLButtonElement>('button.claude-agents-row.is-cloud'));
		button.type = 'button';
		button.draggable = true;
		button.dataset.sessionId = row.id;
		button.dataset.state = row.state;
		this._focusables.push(button);
		this.wireReorder(button, item, row.id, groupIds);
		button.classList.toggle('has-subtitle', !!row.subtitle);
		append(button, $('span.claude-agents-state' + ThemeIcon.asCSSSelector(claudeRunTargetIcon('cloud'))));
		const text = append(button, $('span.claude-agents-text'));
		append(text, $('span.claude-agents-title')).textContent = row.title;
		if (row.subtitle) {
			append(text, $('span.claude-agents-subtitle')).textContent = row.subtitle;
		}
		append(button, $('span.claude-agents-age')).textContent = fromNow(row.updatedAt);
		button.setAttribute('aria-label', [row.title, row.subtitle].filter(Boolean).join(', '));
		const actions = append(item, $('.claude-agents-actions'));
		this.rowAction(actions, Codicon.close, localize('claudeAgentsCloudRemove', "Remove from List"), () => this._cloudSessions.remove(record.id));
		this.rowAction(actions, Codicon.ellipsis, localize('claudeAgentsMore', "More Actions"), anchor => this.showCloudRowMenu(record, { getAnchor: () => anchor }));
		this._rowStore.add(addDisposableListener(button, EventType.CLICK, () => void this._opener.open(URI.parse(claudeCloudSessionUrl(record)), { openExternal: true })));
		this._rowStore.add(addDisposableListener(button, EventType.CONTEXT_MENU, event => {
			event.preventDefault();
			event.stopPropagation();
			this.showCloudRowMenu(record, { getAnchor: () => ({ x: event.clientX, y: event.clientY }) });
		}));
	}

	private showCloudRowMenu(record: ClaudeCloudSessionRecord, anchor: { getAnchor: () => HTMLElement | { x: number; y: number } }): void {
		this._contextMenu.showContextMenu({
			getAnchor: anchor.getAnchor,
			getActions: () => [
				toAction({ id: 'claude.agents.cloud.open', label: localize('claudeAgentsCloudOpen', "Open on claude.ai"), run: () => this._opener.open(URI.parse(claudeCloudSessionUrl(record)), { openExternal: true }) }),
				toAction({ id: 'claude.agents.cloud.bringBack', label: localize('claudeAgentsCloudBringBack', "Bring Back Here..."), run: () => this._commands.executeCommand(CLAUDE_CLOUD_BRING_BACK_COMMAND_ID, record.sessionId) }),
				toAction({ id: 'claude.agents.cloud.send', label: localize('claudeAgentsCloudSend', "Send Message..."), enabled: !!record.sessionId, run: () => this._commands.executeCommand(CLAUDE_CLOUD_SEND_COMMAND_ID, record.sessionId) }),
				toAction({ id: 'claude.agents.cloud.remove', label: localize('claudeAgentsCloudRemove', "Remove from List"), run: () => this._cloudSessions.remove(record.id) }),
			],
		});
	}

	/** A synced session from another computer (issue 448): the machine badge, its age, and no action, since only its transcript exists here. */
	private renderImportedRow(container: HTMLElement, row: ClaudeAgentRow, session: KlawlySyncImportedSession, groupIds: readonly string[]): void {
		const item = append(container, $('.claude-agents-item'));
		item.setAttribute('role', 'listitem');
		const button = append(item, $<HTMLButtonElement>('button.claude-agents-row.is-imported'));
		button.type = 'button';
		button.draggable = true;
		button.dataset.sessionId = row.id;
		button.dataset.state = row.state;
		this._focusables.push(button);
		this.wireReorder(button, item, row.id, groupIds);
		append(button, $('span.claude-agents-state' + ThemeIcon.asCSSSelector(claudeAgentRowIcon(row.state, row.background))));
		append(append(button, $('span.claude-agents-text')), $('span.claude-agents-title')).textContent = row.title;
		const machineLabel = this.renderMachineBadge(button, session.machine);
		append(button, $('span.claude-agents-age')).textContent = fromNow(row.updatedAt);
		button.setAttribute('aria-label', [row.title, machineLabel].join(', '));
	}

	/** A small badge naming the machine a synced session came from (issue 448). Returns its spoken label. */
	private renderMachineBadge(button: HTMLElement, machine: string): string {
		const badge = append(button, $('span.claude-agents-machine'));
		append(badge, $(ThemeIcon.asCSSSelector(Codicon.deviceDesktop)));
		append(badge, $('span.claude-agents-machine-name')).textContent = machine;
		const label = claudeMachineBadgeHover(machine);
		this._rowStore.add(this._hover.setupDelayedHover(badge, { content: label, additionalClasses: ['claude-root'] }));
		return label;
	}

	private rowAction(container: HTMLElement, icon: ThemeIcon, label: string, run: (anchor: HTMLElement) => void): void {
		const button = append(container, $<HTMLButtonElement>('button.claude-icon-btn.claude-agents-action'));
		button.type = 'button';
		button.tabIndex = -1;
		button.setAttribute('aria-label', label);
		append(button, $(ThemeIcon.asCSSSelector(icon)));
		this._rowStore.add(this._hover.setupDelayedHover(button, { content: label, additionalClasses: ['claude-root'] }));
		this._rowStore.add(addDisposableListener(button, EventType.CLICK, event => {
			event.preventDefault();
			event.stopPropagation();
			run(button);
		}));
	}

	private showRowMenu(session: ClaudeAgentSession, anchor: { getAnchor: () => HTMLElement | { x: number; y: number } }): void {
		this._contextMenu.showContextMenu({
			getAnchor: anchor.getAnchor,
			getActions: () => this._sessionActions.actions(session, this._opened),
		});
	}

	private rowInput(session: ClaudeAgentSession): ClaudeAgentRowInput {
		const task = this._background.getTasks().find(candidate => candidate.sessionId === session.id);
		const automation = task && this._automations.automationOfTask(task.id);
		const handoffs = readClaudeHandoffs(this._storage);
		return {
			id: session.id,
			title: session.title,
			updatedAt: session.updatedAt,
			workspaceName: session.workspaceName,
			interrupted: session.interrupted,
			resumeFailed: session.resumeFailed,
			turns: this._agent.getViewState(session.id).turns,
			auto: claudeAgentRowAuto(this._agent.getViewState(session.id).turns, this._configuration.getValue<boolean>(CLAUDE_AUTO_ENABLED_SETTING) === true, session.modelName, this._delegation.getRolledUpCost(session.id)),
			background: task && { status: task.status, filesChanged: task.filesChanged, added: task.added, removed: task.removed },
			target: session.targetInfo,
			project: this._projects.projectOf(session.id),
			handoff: handoffs.find(record => record.chatId === session.id),
			automation: automation && { key: automation.key, name: automation.name, icon: claudeAutomationTriggerIcon(automation.trigger.type) },
		};
	}

	private headRow(container: HTMLElement, icon: ThemeIcon, label: string, run: () => void): HTMLButtonElement {
		const row = append(container, $<HTMLButtonElement>('button.claude-agents-head-row'));
		row.type = 'button';
		append(row, $('span.claude-agents-state' + ThemeIcon.asCSSSelector(icon)));
		append(row, $('span.claude-agents-title')).textContent = label;
		this._register(addDisposableListener(row, EventType.CLICK, run));
		return row;
	}

	private renderAccount(): void {
		const runtime = this._setup.runtime;
		this._accountName.textContent = runtime?.version
			? localize('claudeAgentsRuntimeVersion', "Claude Code {0}", runtime.version)
			: localize('claudeAgentsRuntime', "Claude Code");
		this._accountDetail.textContent = accountDetail(runtime);
		this._account.setAttribute('aria-label', `${this._accountName.textContent}, ${this._accountDetail.textContent}`);
	}

	private showFilter(): void {
		const option = (filter: ClaudeAgentsFilter, label: string) => toAction({
			id: `claude.agents.filter.${filter}`,
			label,
			checked: this._filter === filter,
			run: () => this.setFilter(filter),
		});
		this._contextMenu.showContextMenu({
			getAnchor: () => this._filterButton,
			getActions: () => [
				option('all', localize('claudeAgentsFilterAll', "All Agents")),
				option('local', localize('claudeAgentsFilterLocal', "Local Agents")),
				option('background', localize('claudeAgentsFilterBackground', "Background Agents")),
				option('cloud', localize('claudeAgentsFilterCloud', "Cloud Agents")),
			],
		});
	}

	private filterLabel(): string {
		switch (this._filter) {
			case 'local': return localize('claudeAgentsShowingLocal', "Showing local agents");
			case 'background': return localize('claudeAgentsShowingBackground', "Showing background agents");
			case 'cloud': return localize('claudeAgentsShowingCloud', "Showing cloud agents");
			default: return localize('claudeAgentsShowingAll', "Filter agents");
		}
	}

	private layoutList(): void {
		if (!this._visible || !this._height) {
			return;
		}
		const head = this.element.firstElementChild as HTMLElement;
		const footer = this.element.lastElementChild as HTMLElement;
		const height = Math.max(0, this._height - head.offsetHeight - footer.offsetHeight);
		this._scroll.getDomNode().style.height = `${height}px`;
		this._list.style.height = `${height}px`;
		this._scroll.scanDomNode();
	}

	private focusedRowId(): string | undefined {
		const active = this.element.ownerDocument.activeElement;
		return isHTMLElement(active) && this._list.contains(active) ? active.dataset.sessionId : undefined;
	}

	/** Up and Down walk the rows, Home and End jump to the ends. */
	private moveFocus(event: StandardKeyboardEvent): void {
		const rows = this._focusables;
		const index = rows.findIndex(row => row === this.element.ownerDocument.activeElement);
		let next: number;
		if (event.keyCode === KeyCode.DownArrow) {
			next = Math.min(rows.length - 1, index + 1);
		} else if (event.keyCode === KeyCode.UpArrow) {
			next = Math.max(0, index - 1);
		} else if (event.keyCode === KeyCode.Home) {
			next = 0;
		} else if (event.keyCode === KeyCode.End) {
			next = rows.length - 1;
		} else {
			return;
		}
		event.preventDefault();
		rows[next]?.focus();
	}
}

function stateLabel(state: ClaudeAgentRowState): string | undefined {
	switch (state) {
		case 'running': return localize('claudeAgentsStateRunning', "running");
		case 'done': return localize('claudeAgentsStateDone', "done");
		default: return undefined;
	}
}

function accountDetail(runtime: ClaudeRuntimeState | undefined): string {
	if (!runtime) {
		return localize('claudeAgentsChecking', "Checking...");
	}
	if (!runtime.installed) {
		return localize('claudeAgentsNotInstalled', "Not installed");
	}
	if (!runtime.authenticated) {
		return localize('claudeAgentsSignedOut', "Not signed in");
	}
	switch (runtime.authMode) {
		case 'claude-account': return localize('claudeAgentsAccount', "Claude account");
		case 'api-key': return localize('claudeAgentsApiKey', "API key");
		case 'enterprise': return localize('claudeAgentsEnterprise', "Enterprise");
		case 'bedrock': return localize('claudeAgentsBedrock', "Amazon Bedrock");
		case 'vertex': return localize('claudeAgentsVertex', "Google Vertex AI");
		default: return localize('claudeAgentsSignedIn', "Signed in");
	}
}
