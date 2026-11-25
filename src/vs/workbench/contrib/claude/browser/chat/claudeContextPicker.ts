/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { isCodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import { IOutlineModelService } from '../../../../../editor/contrib/documentSymbols/browser/outlineModel.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IMarkerService } from '../../../../../platform/markers/common/markers.js';
import { AgentActionId } from '../../../../../platform/claude/common/claudeActions.js';
import { claudeCommandsFromNames } from '../../../../../platform/claude/common/claudeCommands.js';
import { ContextAttachment, SerializedRange } from '../../../../../platform/claude/common/claudeContext.js';
import { rankContextCandidate, symbolChipRange } from '../../../../../platform/claude/common/claudePrompt.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { EditorResourceAccessor, EditorsOrder } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IHistoryService } from '../../../../services/history/common/history.js';
import { getExcludes, ISearchConfiguration, ISearchService, QueryType } from '../../../../services/search/common/search.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { getWorkspaceSymbols } from '../../../search/common/search.js';
import { ISCMService } from '../../../scm/common/scm.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { workspaceRelativePath } from '../claudeContextService.js';
import { claudeBranchBase, ClaudeCommit, claudeRecentCommits } from '../claudeGitHistory.js';
import { claudeRelativeFolder } from '../../common/claudeComposerState.js';
import { CLAUDE_REVIEW_BRANCH_COMMAND_ID } from '../claudeGitActions.js';
import { ClaudeOpenForm } from '../../common/claudeCustomizeCreate.js';
import { ClaudeSlashAction, claudeSlashCatalogForFolder, ClaudeSlashCommand, ClaudeSlashForm, ClaudeSlashGroupId, claudeSlashGroups, ClaudeSlashPrompt } from '../../common/claudeSlashMenu.js';
import { CLAUDE_VISUALIZE_COMMAND } from '../../common/claudeVisualize.js';
import { CLAUDE_CANVAS_COMMAND } from '../../common/claudeCanvasSlash.js';
import { CLAUDE_DELEGATE_TEMPLATE_LABELS } from '../../../../../platform/claude/common/claudeDelegateTemplates.js';
import { CLAUDE_MULTITASK_COMMAND } from '../../../../services/claude/common/claudeMultitask.js';
import { CLAUDE_BTW_COMMAND } from '../../../../../platform/claude/common/claudeSideQuestion.js';
import { CLAUDE_GOAL_COMMAND, CLAUDE_LOOP_COMMAND } from '../../../../../platform/claude/common/claudeGoalLoop.js';
import { ClaudePopoverEntry, ClaudePopoverItem, ClaudePopoverMenu } from '../widgets/claudePopoverMenu.js';

export type PickerKind = 'at' | 'slash';

export interface ContextPickerItem {
	readonly id: string;
	readonly group: string;
	readonly label: string;
	/** A second line under the label, such as a `/` command's description or what a context row adds. */
	readonly description?: string;
	/** Grey text right after the label, such as a command's argument hint. */
	readonly hint?: string;
	readonly detail?: string;
	/** The detail is a path: it loses its start, not its end, when the row is narrow. */
	readonly detailIsPath?: boolean;
	/** The preview panel's text while the row is active, such as the full path. */
	readonly preview?: string;
	/** `/` rows have none: the slash already says what they are. */
	readonly icon?: ThemeIcon;
	readonly attachment?: ContextAttachment;
	/** Replaces the `/query` or `@query` token in the composer. */
	readonly insert?: string;
	/** Runs an IDE action instead of inserting text. */
	readonly action?: AgentActionId;
	/** Opens a Customize add form instead of inserting text (issue 680). */
	readonly form?: ClaudeOpenForm;
	/** Runs a workbench command instead of inserting text. */
	readonly command?: string;
	/** Words a query matches by prefix without showing them, such as "terminal" on a terminal named `zsh` (issue 736). */
	readonly keywords?: readonly string[];
}

/** How many recent files the `@` menu shows before its categories. */
const RECENT_COUNT = 5;
/** How many commits the Commit submenu offers. */
const COMMIT_COUNT = 10;
/** Cached commits and folders older than this are fetched again when the menu opens. */
const CACHE_MS = 15_000;

/** The IDE actions the `/` menu offers next to Claude Code's commands. */
function slashActions(): ClaudeSlashAction[] {
	return [
		{ id: 'addSelection', name: 'add-selection', description: localize('claudeSlashAdd', "Add the editor selection to the chat") },
		{ id: 'explainSelection', name: 'explain-selection', description: localize('claudeSlashExplain', "Explain the editor selection") },
		{ id: 'reviewChanges', name: 'review-changes', description: localize('claudeSlashReview', "Review the uncommitted changes") },
		{ id: 'generateCommitMessage', name: 'commit-message', description: localize('claudeSlashCommitMessage', "Write a commit message for the staged changes, or every change when none is staged") },
		{ id: 'splitPullRequests', name: 'split-into-prs', description: localize('claudeSlashSplitPullRequests', "Split the uncommitted changes into pull requests") },
	];
}

/** The `/review-branch` row (issue 1057): the same name as the palette command. */
function slashCommands(): ClaudeSlashCommand[] {
	return [
		{ name: 'review-branch', command: CLAUDE_REVIEW_BRANCH_COMMAND_ID, description: localize('claudeSlashReviewBranch', "Review the branch against its base") },
	];
}

/** The `/create-*` rows (issue 680): each opens the Customize add form of its kind. */
function slashForms(): ClaudeSlashForm[] {
	return [
		{ name: 'create-skill', form: 'skills', description: localize('claudeSlashCreateSkill', "Add a skill in Customize") },
		{ name: 'create-subagent', form: 'subagents', description: localize('claudeSlashCreateSubagent', "Add a subagent in Customize") },
		{ name: 'create-rule', form: 'rules', description: localize('claudeSlashCreateRule', "Add a rule in Customize") },
		{ name: 'create-hook', form: 'hooks', description: localize('claudeSlashCreateHook', "Add a hook in Customize") },
	];
}

/** The `/canvas` row (issue 1039): Klawly expands it on send. */
function canvasSlashPrompt(): ClaudeSlashPrompt {
	return { name: CLAUDE_CANVAS_COMMAND, hint: localize('claudeSlashCanvasHint', "[what to build]"), description: localize('claudeSlashCanvas', "Build an HTML page in a canvas") };
}

/** The `/visualize` row (issue 492): Klawly expands it on send. */
function visualizeSlashPrompt(): ClaudeSlashPrompt {
	return { name: CLAUDE_VISUALIZE_COMMAND, hint: localize('claudeSlashVisualizeHint', "[what to show]"), description: localize('claudeSlashVisualize', "Ask Claude for a diagram or chart") };
}

/** The delegate template rows (issue 1110): plain names, small tier, failures only; Klawly expands them on send. */
function delegateTemplateSlashPrompts(): ClaudeSlashPrompt[] {
	const small = localize('claudeSlashTemplateTier', "Runs as a small worker and reports failures only");
	return [
		{ name: 'watch-ci', hint: localize('claudeSlashWatchCiHint', "[pull request or run]"), description: localize('claudeSlashWatchCi', "{0}: wait for CI and report how it ended. {1}", CLAUDE_DELEGATE_TEMPLATE_LABELS['watch-ci'], small) },
		{ name: 'run-tests', hint: localize('claudeSlashRunTestsHint', "[test command]"), description: localize('claudeSlashRunTests', "{0}: run a test command once and report what failed. {1}", CLAUDE_DELEGATE_TEMPLATE_LABELS['run-tests'], small) },
		{ name: 'merge-pr', hint: localize('claudeSlashMergePrHint', "[pull request]"), description: localize('claudeSlashMergePr', "{0}: merge a pull request once its checks pass. {1}", CLAUDE_DELEGATE_TEMPLATE_LABELS['merge-pr'], small) },
		{ name: 'find', hint: localize('claudeSlashFindHint', "[question]"), description: localize('claudeSlashFind', "{0}: search the project for an answer, read-only. {1}", CLAUDE_DELEGATE_TEMPLATE_LABELS.find, small) },
	];
}

/** The `/multitask` row (issue 487): the composer runs each line as its own background agent on send. */
function multitaskSlashPrompt(): ClaudeSlashPrompt {
	return { name: CLAUDE_MULTITASK_COMMAND, hint: localize('claudeSlashMultitaskHint', "one prompt per line"), description: localize('claudeSlashMultitask', "Run several prompts at once as parallel agents, read-only in Ask and Plan") };
}

/** The `/btw` row (issue 965): the composer asks it in the side question card on send. */
function btwSlashPrompt(): ClaudeSlashPrompt {
	return { name: CLAUDE_BTW_COMMAND, hint: localize('claudeSlashBtwHint', "[question]"), description: localize('claudeSlashBtw', "Ask a side question without interrupting the agent") };
}

/** The `/goal` and `/loop` rows (issue 486): the composer starts them in the strip above it on send. */
function goalLoopSlashPrompts(): ClaudeSlashPrompt[] {
	return [
		{ name: CLAUDE_GOAL_COMMAND, hint: localize('claudeSlashGoalHint', "[outcome] [--turns N] [--budget N]"), description: localize('claudeSlashGoal', "Keep working until an outcome is true") },
		{ name: CLAUDE_LOOP_COMMAND, hint: localize('claudeSlashLoopHint', "[interval] [prompt]"), description: localize('claudeSlashLoop', "Repeat a prompt on a timer") },
	];
}

interface Cached<T> {
	readonly at: number;
	readonly value: T;
}

/**
 * The anchored `@` and `/` menus. The composer keeps focus and drives the menu with
 * {@link move}, {@link expand}, {@link collapse} and {@link accept}; a pick, by key or
 * by pointer, comes out of {@link onDidPick}. Each keystroke cancels the previous search,
 * and rows that need no search show at once.
 */
export class ClaudeContextPicker extends Disposable {
	private readonly _searchToken = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly _cacheToken = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly _menu: ClaudePopoverMenu;
	private readonly _onDidPick = this._register(new Emitter<ContextPickerItem>());
	/** A row picked by key or pointer. The menu is closed by then. */
	readonly onDidPick: Event<ContextPickerItem> = this._onDidPick.event;
	private readonly _onDidPinCommand = this._register(new Emitter<string>());
	/** Use as Mode on a `/` row: the command or skill to pin to the chat (issue 488). */
	readonly onDidPinCommand: Event<string> = this._onDidPinCommand.event;
	private _items = new Map<string, ContextPickerItem>();
	private _open = false;
	private _anchor: HTMLElement | undefined;
	private _kind: PickerKind = 'at';
	private _query = '';
	/** `/` groups the user opened past their cap with "Show N more". */
	private readonly _expanded = new Set<ClaudeSlashGroupId>();
	private _commits: Cached<ClaudeCommit[]> | undefined;
	private _folders: Cached<ContextPickerItem[]> | undefined;

	constructor(
		@IContextViewService contextView: IContextViewService,
		@IFileService private readonly _files: IFileService,
		@ISearchService private readonly _search: ISearchService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IEditorService private readonly _editors: IEditorService,
		@IHistoryService private readonly _history: IHistoryService,
		@IOutlineModelService private readonly _outline: IOutlineModelService,
		@IMarkerService private readonly _markers: IMarkerService,
		@ISCMService private readonly _scm: ISCMService,
		@ITerminalService private readonly _terminals: ITerminalService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
	) {
		super();
		this._menu = this._register(new ClaudePopoverMenu(contextView));
	}

	/** False once a pick or another context view has closed the menu. */
	get isOpen(): boolean {
		return this._open && this._menu.isOpen;
	}

	show(anchor: HTMLElement, kind: PickerKind, query: string): void {
		if (!this.isOpen || kind !== this._kind) {
			this._expanded.clear();
		}
		this._open = true;
		this._anchor = anchor;
		this._kind = kind;
		this._query = query;
		this._searchToken.value?.cancel();
		const source = new CancellationTokenSource();
		this._searchToken.value = source;
		const token = source.token;
		if (kind === 'slash') {
			this.renderSlash();
			return;
		}
		this.refreshCaches();
		// Rows that need no search show at once; searched rows join them when they arrive.
		const quick = this.quickAtItems(query);
		if (!query) {
			this.renderAtRoot(quick);
			return;
		}
		this.renderFlat(quick);
		void this.searchAtItems(query, token).then(found => {
			if (token.isCancellationRequested || !this.isOpen) {
				return;
			}
			this.renderFlat(dedupe([...quick, ...found]).filter(item => matches(query, item)).slice(0, 40));
		});
	}

	move(delta: number): void {
		this._menu.move(delta);
	}

	/** Opens the active row's submenu. False when the row has none. */
	expand(): boolean {
		return this._menu.expand();
	}

	/** Closes the open submenu. False when none is open. */
	collapse(): boolean {
		return this._menu.collapse();
	}

	/**
	 * Picks the active row: fires {@link onDidPick} and returns it. A category row
	 * opens its submenu instead, and "Show N more" shows the rest of its group;
	 * both return nothing and keep the menu open.
	 */
	accept(): ContextPickerItem | undefined {
		const active = this._menu.accept();
		return active ? this._items.get(active.id) : undefined;
	}

	/** The command or skill the active `/` row runs, which Alt+Enter pins to the chat (issue 488). */
	activeCommand(): string | undefined {
		const id = this._kind === 'slash' ? this._menu.activeItem?.id : undefined;
		return id ? slashCommandOf(this._items.get(id)) : undefined;
	}

	close(): void {
		this._open = false;
		this._searchToken.value?.cancel();
		this._expanded.clear();
		this._menu.close();
	}

	private show_(entries: ClaudePopoverEntry[], options: { readonly label: string; readonly className: string; readonly activeId?: string }): void {
		const anchor = this._anchor;
		if (!anchor) {
			return;
		}
		this._menu.show({
			anchor,
			entries,
			focus: 'external',
			label: options.label,
			className: options.className,
			activeId: options.activeId,
			emptyLabel: localize('claudePickerEmpty', "No matches"),
			preview: item => this._items.get(item.id)?.preview,
		});
	}

	private row(item: ContextPickerItem): ClaudePopoverItem {
		this._items.set(item.id, item);
		return {
			id: item.id,
			label: item.label,
			description: item.description,
			hint: item.hint,
			detail: item.detail,
			truncate: item.detailIsPath ? 'start' : undefined,
			icon: item.icon,
			role: 'option',
			run: () => this._onDidPick.fire(item),
		};
	}

	private grouped(items: readonly ContextPickerItem[]): ClaudePopoverEntry[] {
		const entries: ClaudePopoverEntry[] = [];
		let lastGroup = '';
		for (const item of items) {
			if (item.group !== lastGroup) {
				lastGroup = item.group;
				entries.push({ kind: 'header', label: item.group });
			}
			entries.push(this.row(item));
		}
		return entries;
	}

	// --- `/` ---

	/** @param after The row before the one that starts active: the last row a group showed before "Show N more". */
	private renderSlash(after?: string): void {
		this._items.clear();
		const session = this._agent.getCurrentSession();
		const commands = session?.commands.length ? session.commands : claudeCommandsFromNames(session?.slashCommands ?? [], session?.skills ?? []);
		const hasFolder = this._workspace.getWorkspace().folders.length > 0;
		const groups = claudeSlashGroups(claudeSlashCatalogForFolder({ commands, agents: session?.agents ?? [], actions: slashActions(), forms: slashForms(), workbenchCommands: slashCommands(), prompts: [visualizeSlashPrompt(), canvasSlashPrompt(), ...delegateTemplateSlashPrompts(), multitaskSlashPrompt(), btwSlashPrompt(), ...goalLoopSlashPrompts()] }, hasFolder), this._query, this._expanded);
		const entries: ClaudePopoverEntry[] = [];
		const ids: string[] = [];
		for (const group of groups) {
			entries.push({ kind: 'header', label: group.label });
			for (const row of group.rows) {
				ids.push(row.id);
				const item: ContextPickerItem = {
					id: row.id,
					group: group.label,
					label: row.label,
					hint: row.hint,
					description: row.description || undefined,
					insert: row.insert,
					action: row.action,
					form: row.form,
					command: row.command,
				};
				const command = slashCommandOf(item);
				entries.push({
					...this.row(item),
					// The command name is set in monospace, its argument hint is not.
					className: 'claude-slash-command',
					actions: command ? [{
						id: 'useAsMode',
						icon: Codicon.pin,
						label: localize('claudeSlashUseAsMode', "Use as Mode"),
						run: () => {
							this.close();
							this._onDidPinCommand.fire(command);
						},
					}] : undefined,
				});
			}
			if (group.hidden > 0) {
				const lastShown = group.rows[group.rows.length - 1]?.id;
				entries.push({
					id: `more:${group.id}`,
					label: localize('claudeSlashMore', "Show {0} more", group.hidden),
					role: 'option',
					className: 'claude-menu-more',
					run: () => {
						// The pick closed the menu; it opens again with the whole group, on its first new row.
						this._expanded.add(group.id);
						this._open = true;
						this.renderSlash(lastShown);
					},
				});
			}
		}
		const activeId = after !== undefined ? ids[ids.indexOf(after) + 1] : undefined;
		this.show_(entries, { label: localize('claudeSlashMenu', "Commands"), className: 'claude-slash-menu', activeId });
	}

	// --- `@` ---

	/** Starts fetching commits and top-level folders for the submenus, unless fresh ones are cached. */
	private refreshCaches(): void {
		const now = Date.now();
		const commitsStale = !this._commits || now - this._commits.at > CACHE_MS;
		const foldersStale = !this._folders || now - this._folders.at > CACHE_MS;
		if (!commitsStale && !foldersStale) {
			return;
		}
		this._cacheToken.value?.cancel();
		const source = new CancellationTokenSource();
		this._cacheToken.value = source;
		const token = source.token;
		if (commitsStale) {
			void claudeRecentCommits(this._scm, COMMIT_COUNT, token).then(
				value => { if (!token.isCancellationRequested) { this._commits = { at: Date.now(), value }; } },
				() => { if (!token.isCancellationRequested) { this._commits = { at: Date.now(), value: [] }; } },
			);
		}
		if (foldersStale) {
			void this.folderItems('', token).then(value => {
				if (!token.isCancellationRequested) {
					this._folders = { at: Date.now(), value };
				}
			});
		}
	}

	private hasHistory(): boolean {
		for (const repository of this._scm.repositories) {
			if (repository.provider.historyProvider.get()) {
				return true;
			}
		}
		return false;
	}

	/** The root `@` menu: recent files, then categories and one-shot context. */
	private renderAtRoot(quick: readonly ContextPickerItem[]): void {
		this._items.clear();
		const entries: ClaudePopoverEntry[] = [];
		const recents = quick.filter(item => item.group === RECENT_GROUP()).slice(0, RECENT_COUNT);
		if (recents.length > 0) {
			entries.push(...this.grouped(recents));
			entries.push({ kind: 'separator' });
		}
		const files = dedupe([...this.openEditorItems(''), ...this.recentItems('')]).filter(item => !recents.some(recent => recent.id === item.id));
		entries.push(this.category('cat:files', localize('claudeFilesAndFolders', "Files & Folders"), Codicon.files, () => {
			const folders = this._folders?.value;
			const rows = [...files.slice(0, 20), ...(folders ?? [])];
			if (rows.length === 0) {
				return [this.placeholder(folders ? localize('claudeTypeToSearch', "Type to search files") : localize('claudeLoading', "Loading..."))];
			}
			return this.grouped(rows);
		}));
		const terminals = this.terminalItems('');
		if (terminals.length > 0) {
			entries.push(this.category('cat:terminals', localize('claudeTerminals', "Terminals"), Codicon.terminal, () => terminals.map(item => this.row(item))));
		}
		const chats = this.chatItems('');
		if (chats.length > 0) {
			entries.push(this.category('cat:chats', localize('claudePastChats', "Past chats"), Codicon.commentDiscussion, () => chats.map(item => this.row(item))));
		}
		if (this.hasHistory()) {
			entries.push(this.category('cat:commits', localize('claudeCommit', "Commit"), Codicon.gitCommit, () => {
				const commits = this._commits?.value;
				if (!commits) {
					return [this.placeholder(localize('claudeLoading', "Loading..."))];
				}
				if (commits.length === 0) {
					return [this.placeholder(localize('claudeNoCommits', "No commits"))];
				}
				return commits.map(commit => this.row(commitItem(commit)));
			}));
		}
		entries.push({ kind: 'separator' });
		for (const item of quick) {
			if (item.group === CONTEXT_GROUP()) {
				entries.push(this.row(item));
			}
		}
		this.show_(entries, { label: localize('claudeContextMenu', "Add context"), className: 'claude-mention-menu' });
	}

	private renderFlat(items: readonly ContextPickerItem[]): void {
		const active = this._menu.activeItem?.id;
		this._items.clear();
		const entries = this.grouped(items);
		this.show_(entries, {
			label: localize('claudeContextMenu', "Add context"),
			className: 'claude-mention-menu',
			activeId: active && items.some(item => item.id === active) ? active : undefined,
		});
	}

	private category(id: string, label: string, icon: ThemeIcon, submenu: () => ClaudePopoverEntry[]): ClaudePopoverItem {
		return { id, label, icon, role: 'option', submenu };
	}

	private placeholder(label: string): ClaudePopoverItem {
		return { id: `placeholder:${label}`, label, disabled: true, role: 'option' };
	}

	/** Rows that need no search: recent files, Problems, git, terminals, chats and commits. */
	private quickAtItems(query: string): ContextPickerItem[] {
		const recents = dedupe([...this.openEditorItems(query), ...this.recentItems(query)])
			.map(item => ({ ...item, group: RECENT_GROUP() }));
		const context = this.contextItems().filter(item => rankContextCandidate(query, matchText(item)) > 0);
		if (!query) {
			return [...recents, ...context];
		}
		const commits = (this._commits?.value ?? []).map(commitItem).filter(item => rankContextCandidate(query, matchText(item)) > 0);
		// Terminals lead: `@terminal` means the user's terminal, not files named "terminal" (issue 736).
		return [...this.terminalItems(query), ...recents.slice(0, 8), ...context, ...this.chatItems(query), ...commits];
	}

	private async searchAtItems(query: string, token: CancellationToken): Promise<ContextPickerItem[]> {
		const items: ContextPickerItem[] = [];
		if (!token.isCancellationRequested) {
			items.push(...await this.fileItems(query, token));
		}
		if (!token.isCancellationRequested) {
			items.push(...await this.folderItems(query, token));
		}
		if (!token.isCancellationRequested) {
			items.push(...await this.symbolItems(query, token));
		}
		return items;
	}

	private chatItems(query: string): ContextPickerItem[] {
		return this._agent.listChatMentions(query).map(item => ({
			id: `chat-${item.id}`,
			group: localize('claudeChatsGroup', "Chats"),
			label: item.title,
			detail: item.detail,
			icon: Codicon.commentDiscussion,
			attachment: item.attachment,
		}));
	}

	private terminalItems(query: string): ContextPickerItem[] {
		const keywords = [localize('claudeTerminalKeyword', "terminal"), 'terminal', 'shell'];
		return (this._terminals.instances ?? [])
			.map(terminal => ({
				id: `terminal-${terminal.instanceId}`,
				group: localize('claudeTerminalsGroup', "Terminals"),
				label: terminal.title || localize('claudeTerminal', "Terminal"),
				detail: localize('claudeTerminalLines', "last 200 lines"),
				icon: Codicon.terminal,
				keywords,
				attachment: { kind: 'terminal', terminalId: terminal.instanceId, lines: 200, title: terminal.title || undefined } satisfies ContextAttachment,
			}))
			.filter(item => matches(query, item));
	}

	/** Problems, branch diff and uncommitted changes. */
	private contextItems(): ContextPickerItem[] {
		const group = CONTEXT_GROUP();
		const items: ContextPickerItem[] = [];
		const branch = claudeBranchBase(this._scm);
		if (branch) {
			const title = localize('claudeBranchDiff', "Branch diff vs {0}", branch.base.name);
			items.push({
				id: 'git-branch',
				group,
				label: title,
				description: localize('claudeBranchDiffPreview', "Commits on {0} since it left {1}", branch.head.name, branch.base.name),
				icon: Codicon.gitBranch,
				attachment: { kind: 'git-diff', scope: 'branch', ref: branch.base.id, title },
			});
		}
		items.push(
			{
				id: 'git',
				group,
				label: localize('claudeGit', "Git changes"),
				description: localize('claudeWorkingTree', "staged, working tree, untracked"),
				icon: Codicon.gitCompare,
				attachment: { kind: 'git-diff', scope: 'all' },
			},
			{
				id: 'git-staged',
				group,
				label: localize('claudeGitStaged', "Staged changes"),
				detail: countDetail(this.stagedCount()),
				icon: Codicon.gitCompare,
				attachment: { kind: 'git-diff', scope: 'staged' },
			},
			{
				id: 'problems',
				group,
				label: localize('claudeProblems', "Problems"),
				detail: countDetail(this._markers.read({ take: 200 }).length),
				icon: Codicon.warning,
				attachment: { kind: 'diagnostics' },
			},
		);
		return items;
	}

	private stagedCount(): number {
		let count = 0;
		for (const repository of this._scm.repositories) {
			for (const group of repository.provider.groups) {
				const text = `${group.id} ${group.label}`.toLowerCase();
				if (text.includes('index') || text.includes('staged')) {
					count += group.resources.length;
				}
			}
		}
		return count;
	}

	private openEditorItems(query: string): ContextPickerItem[] {
		const items: ContextPickerItem[] = [];
		for (const editor of this._editors.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)) {
			const uri = EditorResourceAccessor.getOriginalUri(editor.editor);
			if (!uri) {
				continue;
			}
			items.push(this.fileItem(localize('claudeOpenEditors', "Open Editors"), uri));
			if (items.length >= 8) {
				break;
			}
		}
		return items.filter(item => rankContextCandidate(query, item.label) > 0);
	}

	private recentItems(query: string): ContextPickerItem[] {
		const items: ContextPickerItem[] = [];
		for (const entry of this._history.getHistory()) {
			const uri = EditorResourceAccessor.getOriginalUri(entry);
			if (!uri || uri.scheme !== 'file') {
				continue;
			}
			items.push(this.fileItem(localize('claudeRecentFiles', "Recent Files"), uri));
			if (items.length >= 8) {
				break;
			}
		}
		return items.filter(item => rankContextCandidate(query, item.label) > 0);
	}

	private async fileItems(query: string, token: CancellationToken): Promise<ContextPickerItem[]> {
		const folders = this._workspace.getWorkspace().folders;
		if (!query || folders.length === 0) {
			return [];
		}
		try {
			// Honor .gitignore, files.exclude and search.exclude, so node_modules doesn't fill the 20 rows (issue 736).
			const excludes = getExcludes(this._configuration.getValue<ISearchConfiguration>());
			const result = await this._search.fileSearch({
				type: QueryType.File,
				filePattern: query,
				folderQueries: folders.map(folder => ({ folder: folder.uri, disregardIgnoreFiles: false, ...(excludes ? { excludePattern: [{ pattern: excludes }] } : {}) })),
				maxResults: 20,
				sortByScore: true,
			}, token);
			return result.results.map(match => this.fileItem(localize('claudeFilesGroup', "Files"), match.resource));
		} catch {
			return [];
		}
	}

	private async folderItems(query: string, token: CancellationToken): Promise<ContextPickerItem[]> {
		const items: ContextPickerItem[] = [];
		for (const folder of this._workspace.getWorkspace().folders) {
			if (token.isCancellationRequested) {
				return items;
			}
			try {
				const stat = await this._files.resolve(folder.uri);
				for (const child of stat.children ?? []) {
					if (!child.isDirectory) {
						continue;
					}
					const name = basename(child.resource);
					if (rankContextCandidate(query, name) === 0) {
						continue;
					}
					const relative = workspaceRelativePath(child.resource, this._workspace);
					items.push({
						id: `folder-${child.resource.toString()}`,
						group: localize('claudeFoldersGroup', "Folders"),
						label: name,
						detail: relative,
						detailIsPath: true,
						preview: relative,
						icon: Codicon.folder,
						attachment: { kind: 'folder', uri: child.resource.toString() },
					});
					if (items.length >= 12) {
						return items;
					}
				}
			} catch {
				// A root that cannot be listed contributes no folders.
			}
		}
		return items;
	}

	private async symbolItems(query: string, token: CancellationToken): Promise<ContextPickerItem[]> {
		if (!query) {
			return [];
		}
		const group = localize('claudeSymbolsGroup', "Symbols");
		const items: ContextPickerItem[] = [];
		const control = this._editors.activeTextEditorControl;
		if (isCodeEditor(control)) {
			const model = control.getModel();
			if (model) {
				try {
					const outline = await this._outline.getOrCreate(model, token);
					for (const symbol of outline.asListOfDocumentSymbols()) {
						if (rankContextCandidate(query, symbol.name) === 0) {
							continue;
						}
						items.push({
							id: `sym-${model.uri.toString()}-${symbol.name}-${symbol.selectionRange.startLineNumber}`,
							group,
							label: symbol.name,
							detail: basename(model.uri),
							preview: `${workspaceRelativePath(model.uri, this._workspace)}:${symbol.selectionRange.startLineNumber}`,
							icon: Codicon.symbolMethod,
							attachment: outlineSymbolAttachment(model.uri.toString(), symbol.name, symbol.range, symbol.selectionRange),
						});
						if (items.length >= 12) {
							return items;
						}
					}
				} catch {
					// Outline providers can fail closed.
				}
			}
		}
		try {
			const symbols = await getWorkspaceSymbols(query, token);
			for (const item of symbols) {
				const uri = item.symbol.location.uri;
				items.push({
					id: `wsym-${uri.toString()}-${item.symbol.name}`,
					group,
					label: item.symbol.name,
					detail: basename(uri),
					preview: `${workspaceRelativePath(uri, this._workspace)}:${item.symbol.location.range.startLineNumber}`,
					icon: Codicon.symbolClass,
					attachment: outlineSymbolAttachment(uri.toString(), item.symbol.name, item.symbol.location.range, item.symbol.location.range),
				});
				if (items.length >= 20 || token.isCancellationRequested) {
					break;
				}
			}
		} catch {
			// Workspace symbols are optional.
		}
		return items;
	}

	/** A file row: its name, its folder relative to the workspace (audit 34), and its full path in the preview. */
	private fileItem(group: string, uri: URI): ContextPickerItem {
		const relative = workspaceRelativePath(uri, this._workspace);
		return {
			id: `file-${uri.toString()}`,
			group,
			label: basename(uri),
			detail: claudeRelativeFolder(relative) || undefined,
			detailIsPath: true,
			preview: relative,
			icon: Codicon.file,
			attachment: { kind: 'file', uri: uri.toString() },
		};
	}
}

function RECENT_GROUP(): string {
	return localize('claudeRecentGroup', "Recent");
}

function CONTEXT_GROUP(): string {
	return localize('claudeContextGroup', "Context");
}

function commitItem(commit: ClaudeCommit): ContextPickerItem {
	const item = commit.item;
	const short = (item.displayId ?? item.id).slice(0, 7);
	return {
		id: `commit-${item.id}`,
		group: localize('claudeCommitsGroup', "Commits"),
		label: item.subject,
		detail: short,
		preview: item.author ? `${short} · ${item.author}` : short,
		icon: Codicon.gitCommit,
		attachment: { kind: 'git-diff', scope: 'commit', ref: item.id, title: `${short} ${item.subject}` },
	};
}

/** A count beside the label, shown only when there is something to count (issue 145). */
function countDetail(count: number): string | undefined {
	return count > 0 ? String(count) : undefined;
}

/** The text a query is ranked against: the label, its second line and its grey detail. */
function matchText(item: ContextPickerItem): string {
	return `${item.label} ${item.description ?? ''} ${item.detail ?? ''}`;
}

/** A row matches a query on its text, or on a hidden keyword the query starts (issue 736). */
function matches(query: string, item: ContextPickerItem): boolean {
	const needle = query.trim().toLowerCase();
	return rankContextCandidate(query, matchText(item)) > 0 || !!item.keywords?.some(word => needle.length >= 2 && word.toLowerCase().startsWith(needle));
}

/** The first row per id: an open editor is also a recent file. */
function dedupe(items: readonly ContextPickerItem[]): ContextPickerItem[] {
	const seen = new Set<string>();
	return items.filter(item => {
		if (seen.has(item.id)) {
			return false;
		}
		seen.add(item.id);
		return true;
	});
}

/** The chip range is the symbol body. `selectionRange` is only the name. */
export function outlineSymbolAttachment(uri: string, name: string, range: IRange, selectionRange: IRange): ContextAttachment {
	return {
		kind: 'symbol',
		uri,
		name,
		range: symbolChipRange({ range: toSerialized(range), selectionRange: toSerialized(selectionRange) }),
	};
}

function toSerialized(range: IRange): SerializedRange {
	return {
		startLine: range.startLineNumber,
		startColumn: range.startColumn,
		endLine: range.endLineNumber,
		endColumn: range.endColumn,
	};
}

/** The command or skill a `/` row inserts (`/name `), which can be pinned to a chat; subagents and IDE actions cannot. */
function slashCommandOf(item: ContextPickerItem | undefined): string | undefined {
	return /^\/(?<name>[^\s/]+) $/.exec(item?.insert ?? '')?.groups?.name;
}
