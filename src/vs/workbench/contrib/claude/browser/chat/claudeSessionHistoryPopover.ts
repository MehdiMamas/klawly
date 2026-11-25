/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { IAction, Separator } from '../../../../../base/common/actions.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ClaudeAgentSession, IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { CLAUDE_CHAT_SEARCH_MIN_QUERY, ClaudeChatSearchHit } from '../../../../services/claude/common/claudeChatSearch.js';
import { CLAUDE_OPEN_COMPARISON_COMMAND_ID, IClaudeComparisonService } from '../../../../services/claude/common/claudeComparison.js';
import { CLAUDE_CLOUD_BRING_BACK_COMMAND_ID } from '../../../../../platform/claude/common/claudeCloud.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { ClaudeAccountEntry } from '../../../../../platform/claude/common/claudeAccounts.js';
import { claudeChatAccountLabel } from '../../../../../platform/claude/common/claudeChatAccount.js';
import { claudeAgentRowIcon, ClaudeAgentRow, ClaudeAgentRowInput, groupClaudeAgentRows } from '../../common/claudeAgentsList.js';
import { ClaudePopoverEntry, ClaudePopoverItem, ClaudePopoverMenu } from '../widgets/claudePopoverMenu.js';
import { ClaudeSessionActions } from './claudeSessionActions.js';

/** The row that folds the archived chats away. */
const ARCHIVED_GROUP_ID = 'claude.history.archived';
/** Typing pauses this long before the chats' text is searched (issue 489). */
const CONTENT_SEARCH_DELAY_MS = 150;
/** Frames to wait for an opened chat's turns to paint before giving up on revealing one. */
const REVEAL_FRAMES = 30;

/**
 * Agent history as a dropdown under the pane's History button (#82): a search box,
 * pinned chats, day groups of one-line rows with Pin, Archive and More on hover,
 * and the archived chats folded at the end. It follows the sessions while open.
 * Search matches titles first, then the text of the chats' prompts and replies
 * ("In Chats", issue 489); such a row opens its chat at the turn.
 */
export class ClaudeSessionHistoryPopover extends Disposable {
	private readonly _menu: ClaudePopoverMenu;
	private readonly _sessionActions: ClaudeSessionActions;
	private readonly _live = this._register(new MutableDisposable<DisposableStore>());
	private readonly _refresh = this._register(new MutableDisposable());
	private _anchor: HTMLElement | undefined;
	private _showArchived = false;
	private readonly _contentSearch = this._register(new MutableDisposable());
	private readonly _reveal = this._register(new MutableDisposable());
	private _contentQuery = '';
	private _hits: readonly ClaudeChatSearchHit[] = [];
	/** The signed-in accounts while the popover is open; rows name their account only when two or more exist (issue 1350). */
	private _accounts: readonly ClaudeAccountEntry[] = [];

	constructor(
		/** Runs after a fork from the More menu opened its new chat. */
		private readonly _forked: () => void,
		/** Scrolls the open chat to a turn; false while the turn is not painted (Go to Turn, issue 433). */
		private readonly _revealTurn: (turnId: string) => boolean,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IContextViewService contextView: IContextViewService,
		@IHoverService hovers: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IClaudeComparisonService private readonly _comparisons: IClaudeComparisonService,
		@ICommandService private readonly _commands: ICommandService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
	) {
		super();
		this._menu = this._register(new ClaudePopoverMenu(contextView, hovers));
		this._sessionActions = instantiationService.createInstance(ClaudeSessionActions);
	}

	get isOpen(): boolean {
		return this._menu.isOpen;
	}

	toggle(anchor: HTMLElement): void {
		if (this._menu.isOpen) {
			this._menu.close();
		} else {
			this.show(anchor);
		}
	}

	show(anchor: HTMLElement): void {
		this._anchor = anchor;
		this._showArchived = false;
		this._contentQuery = '';
		this._hits = [];
		void this._runtime.listAccounts?.().then(accounts => {
			this._accounts = accounts.filter(account => account.signedIn);
		}, () => undefined);
		this._menu.show({
			anchor,
			entries: this.entries(),
			label: localize('claudeHistoryMenu', "Agent history"),
			className: 'claude-history-menu',
			position: AnchorPosition.BELOW,
			alignment: AnchorAlignment.RIGHT,
			search: localize('claudeSearchAgents', "Search agents"),
			emptyLabel: localize('claudeHistoryNone', "No agents found."),
			onSearch: query => this.searchContent(query),
			onHide: () => {
				this._live.clear();
				this._refresh.clear();
				this._contentSearch.clear();
			},
		});
		const live = new DisposableStore();
		live.add(this._agent.onDidChangeSession(() => this.scheduleRefresh()));
		live.add(this._agent.onDidChangeViewState(() => this.scheduleRefresh()));
		live.add(this._comparisons.onDidChangeComparisons(() => this.scheduleRefresh()));
		this._live.value = live;
	}

	close(): void {
		this._menu.close();
	}

	/** Streaming changes the view state many times a frame; the rows follow once per frame. */
	private scheduleRefresh(): void {
		if (this._refresh.value || !this._anchor) {
			return;
		}
		this._refresh.value = scheduleAtNextAnimationFrame(getWindow(this._anchor), () => {
			this._refresh.clear();
			this.refresh();
		});
	}

	private refresh(): void {
		if (this._menu.isOpen) {
			this._menu.update(this.entries());
		}
	}

	private entries(): ClaudePopoverEntry[] {
		const now = Date.now();
		// A comparison is one entry (issue 424); its runs open from the Compare editor.
		const comparisons = this._comparisons.getHistory();
		const runSessions = new Set(comparisons.flatMap(comparison => comparison.view.runs.map(run => run.sessionId)));
		const history = this._agent.getHistory().filter(session => !runSessions.has(session.id));
		const current = this._agent.getCurrentSession()?.id;
		const sessions = new Map(history.map(session => [session.id, session]));
		const rows = (list: readonly ClaudeAgentSession[]) => groupClaudeAgentRows(list.map(session => this.rowInput(session)), now, '', 'all');
		const listed = history.filter(session => !session.archived);
		const entries: ClaudePopoverEntry[] = [];
		const pinned = rows(listed.filter(session => session.pinned)).flatMap(group => group.rows);
		if (pinned.length) {
			entries.push({ kind: 'header', label: localize('claudeHistoryPinned', "Pinned") });
			entries.push(...pinned.map(row => this.item(row, sessions.get(row.id)!, current)));
		}
		if (comparisons.length) {
			entries.push({ kind: 'header', label: localize('claudeHistoryComparisons', "Comparisons") });
			entries.push(...comparisons.map(({ view, updatedAt }): ClaudePopoverItem => ({
				id: `comparison:${view.id}`,
				label: view.prompt.split('\n')[0],
				icon: Codicon.diffMultiple,
				detail: fromNow(updatedAt),
				keywords: view.runs.map(run => run.label).join(' '),
				hover: [view.prompt, view.runs.map(run => run.label).join(', ')].join('\n'),
				run: () => void this._commands.executeCommand(CLAUDE_OPEN_COMPARISON_COMMAND_ID, view.id),
			})));
		}
		for (const group of rows(listed.filter(session => !session.pinned))) {
			entries.push({ kind: 'header', label: group.label });
			entries.push(...group.rows.map(row => this.item(row, sessions.get(row.id)!, current)));
		}
		// Sessions started on claude.ai/code, in the Claude app, from Slack or from the GitHub app (issue 517).
		// Claude Code lists them only in its own picker, so the row opens Bring Back with that picker.
		entries.push({ kind: 'header', label: localize('claudeHistoryCloud', "Cloud") });
		entries.push({
			id: 'cloud:bringBack',
			label: localize('claudeHistoryBringBack', "Bring Back a Session from claude.ai..."),
			icon: Codicon.cloudDownload,
			keywords: 'cloud web phone slack github teleport',
			hover: localize('claudeHistoryBringBackHover', "Continue a Claude Code session from claude.ai/code, the Claude app, Slack or GitHub in a new worktree"),
			run: () => void this._commands.executeCommand(CLAUDE_CLOUD_BRING_BACK_COMMAND_ID),
		});
		const archived = history.filter(session => session.archived);
		if (archived.length) {
			if (entries.length) {
				entries.push({ kind: 'separator' });
			}
			entries.push({
				id: ARCHIVED_GROUP_ID,
				label: localize('claudeHistoryArchived', "Archived"),
				icon: this._showArchived ? Codicon.chevronDown : Codicon.chevronRight,
				value: String(archived.length),
				className: 'claude-history-group',
				// Stays while searching, so archived chats can be found too.
				pinned: true,
				keepOpen: true,
				run: () => {
					this._showArchived = !this._showArchived;
					this.refresh();
				},
			});
			if (this._showArchived) {
				const archivedRows = rows(archived).flatMap(group => group.rows);
				entries.push(...archivedRows.map(row => this.item(row, sessions.get(row.id)!, current)));
			}
		}
		const hits = this._hits.filter(hit => sessions.has(hit.sessionId));
		if (hits.length) {
			entries.push({ kind: 'header', label: localize('claudeHistoryInChats', "In Chats"), pinned: true });
			entries.push(...hits.map(hit => this.hitItem(hit, sessions.get(hit.sessionId)!, current)));
		}
		return entries;
	}

	/** A turn whose prompt or reply has the searched words: the chat's title over the matching line. */
	private hitItem(hit: ClaudeChatSearchHit, session: ClaudeAgentSession, current: string | undefined): ClaudePopoverItem {
		return {
			id: `hit:${hit.sessionId}:${hit.turnId}:${hit.role}`,
			label: session.title,
			description: hit.line,
			icon: hit.role === 'user' ? Codicon.account : Codicon.commentDiscussion,
			detail: session.updatedAt !== undefined ? fromNow(session.updatedAt) : undefined,
			hover: [session.title, hit.line].join('\n'),
			className: session.id === current ? 'claude-history-hit is-current' : 'claude-history-hit',
			dataset: { sessionId: hit.sessionId, turnId: hit.turnId },
			// The row was found in the chat's text, so the title filter must not hide it.
			pinned: true,
			run: () => void this.openAt(hit.sessionId, hit.turnId),
		};
	}

	/** Searches the chats' text once typing pauses. Short text only matches titles. */
	private searchContent(query: string): void {
		this._contentSearch.clear();
		if (query.length < CLAUDE_CHAT_SEARCH_MIN_QUERY) {
			this._contentQuery = '';
			if (this._hits.length) {
				this._hits = [];
				this.refresh();
			}
			return;
		}
		this._contentQuery = query;
		this._contentSearch.value = disposableTimeout(() => void this.runContentSearch(query), CONTENT_SEARCH_DELAY_MS);
	}

	private async runContentSearch(query: string): Promise<void> {
		const hits = await this._agent.searchChats(query).catch(() => []);
		if (query !== this._contentQuery || !this._menu.isOpen) {
			return;
		}
		this._hits = hits;
		this.refresh();
	}

	/** Opens a chat, then scrolls it to the turn once the pane has painted it. */
	private async openAt(sessionId: string, turnId: string): Promise<void> {
		this._agent.selectSession(sessionId);
		try {
			await this._agent.resume(sessionId);
		} catch {
			return;
		}
		const anchor = this._anchor;
		if (!anchor) {
			return;
		}
		let frames = 0;
		const attempt = () => {
			this._reveal.clear();
			if (this._agent.getCurrentSession()?.id !== sessionId || this._revealTurn(turnId) || ++frames >= REVEAL_FRAMES) {
				return;
			}
			this._reveal.value = scheduleAtNextAnimationFrame(getWindow(anchor), attempt);
		};
		this._reveal.value = scheduleAtNextAnimationFrame(getWindow(anchor), attempt);
	}

	private item(row: ClaudeAgentRow, session: ClaudeAgentSession, current: string | undefined): ClaudePopoverItem {
		const first = this._agent.getViewState(session.id).turns[0]?.user.text ?? '';
		const accountId = this._agent.getSessionAccount(session.id);
		const account = this._accounts.length > 1 && accountId ? this._accounts.find(entry => entry.id === accountId) : undefined;
		const where = [session.workspaceName, account ? claudeChatAccountLabel(account) : undefined, session.worktreePath ? localize('claudeWorktreeBadge', "worktree") : undefined].filter(Boolean).join(' · ');
		return {
			id: session.id,
			label: row.title,
			icon: claudeAgentRowIcon(row.state, row.background),
			detail: fromNow(row.updatedAt),
			keywords: `${session.workspaceName ?? ''} ${first}`,
			hover: [row.title, row.subtitle, where].filter(Boolean).join('\n'),
			className: session.id === current ? 'is-current' : undefined,
			dataset: { sessionId: session.id },
			actions: [
				session.archived
					? { id: 'unarchive', icon: Codicon.inbox, label: localize('claudeHistoryUnarchive', "Unarchive"), run: () => this._agent.setArchived(session.id, false) }
					: { id: 'pin', icon: session.pinned ? Codicon.pinned : Codicon.pin, label: session.pinned ? localize('claudeHistoryUnpin', "Unpin") : localize('claudeHistoryPin', "Pin"), run: () => this._agent.setPinned(session.id, !session.pinned) },
				...(session.archived ? [] : [{ id: 'archive', icon: Codicon.archive, label: localize('claudeHistoryArchive', "Archive"), run: () => this._agent.setArchived(session.id, true) }]),
				{ id: 'more', icon: Codicon.ellipsis, label: localize('claudeHistoryMore', "More Actions"), run: () => this.showMore(session.id) },
			],
			contextMenu: () => this.showMore(session.id),
			run: () => this.open(session.id),
		};
	}

	private open(sessionId: string): void {
		this._agent.selectSession(sessionId);
		// A closed chat comes back as a tab; an archived one comes back to the lists.
		void this._agent.resume(sessionId).catch(() => undefined);
	}

	/**
	 * The full session menu cascades beside its row inside the popover, so the
	 * popover stays open under it (DL-20, issue 746). Picking an action closes both.
	 */
	private showMore(sessionId: string): void {
		this._menu.openRowMenu(sessionId, () => {
			// The rows follow the session as it is now: a repaint while open rebuilds them.
			const session = this._agent.getHistory().find(candidate => candidate.id === sessionId);
			return session ? claudeSessionMenuEntries(this._sessionActions.actions(session, this._forked)) : [];
		});
	}

	private rowInput(session: ClaudeAgentSession): ClaudeAgentRowInput {
		return {
			id: session.id,
			title: session.title,
			updatedAt: session.updatedAt,
			workspaceName: session.workspaceName,
			interrupted: session.interrupted,
			resumeFailed: session.resumeFailed,
			turns: this._agent.getViewState(session.id).turns,
		};
	}
}

/** The session's actions as popover rows: a separator stays a separator. */
export function claudeSessionMenuEntries(actions: readonly IAction[]): ClaudePopoverEntry[] {
	return actions.map((action): ClaudePopoverEntry => action.id === Separator.ID
		? { kind: 'separator' }
		: { id: action.id, label: action.label, disabled: !action.enabled, run: () => void action.run() });
}
