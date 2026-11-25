/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { splitRecentLabel } from '../../../../../base/common/labels.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { FileAccess, Schemas } from '../../../../../base/common/network.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { ClaudeAccountOverview } from '../../../../../platform/claude/common/claudeAccount.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILabelService, Verbosity } from '../../../../../platform/label/common/label.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IWindowOpenable } from '../../../../../platform/window/common/window.js';
import { WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { IRecentFolder, IRecentWorkspace, isRecentFolder, isRecentWorkspace, IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';
import { registerEditorGroupWatermarkContent } from '../../../../browser/parts/editor/editorGroupWatermark.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { claudeAccountSummary, claudePlanLabel } from '../../common/claudeSettingsPages.js';
import { CLAUDE_FOCUS_AGENT_COMMAND_ID, CLAUDE_NEW_SESSION_COMMAND_ID, CLAUDE_OPEN_AGENTS_WINDOW_COMMAND_ID, CLAUDE_OPEN_SETTINGS_COMMAND_ID, CLAUDE_REDETECT_RUNTIME_COMMAND_ID } from '../../common/claudeViews.js';
import { appendClaudeKbd } from '../chat/claudeKbd.js';
import '../media/claude.css';

/** The most recent projects Home lists before it offers Show All. */
const RECENT_LIMIT = 5;

/** Longest parent path Home shows before it drops the middle folders. */
const RECENT_PATH_LIMIT = 36;

/**
 * Shortens a long path by dropping its middle folders, so two projects with the same
 * name still differ by the root and by the folder next to them (DL-12).
 */
export function middleTruncatePath(path: string, limit: number): string {
	if (path.length <= limit) {
		return path;
	}
	const separator = path.includes('\\') && !path.includes('/') ? '\\' : '/';
	const segments = path.split(separator);
	if (segments.length < 3) {
		return path;
	}
	// An absolute POSIX path starts with an empty segment: keep its root as the leading separator.
	const head = segments[0];
	let tail = segments[segments.length - 1];
	for (let i = segments.length - 2; i > 0; i--) {
		const next = segments[i] + separator + tail;
		if (head.length + separator.length + 1 + separator.length + next.length > limit) {
			break;
		}
		tail = next;
	}
	return head + separator + '\u2026' + separator + tail;
}

interface ClaudeHomeStart {
	readonly id: string;
	readonly icon: ThemeIcon;
	readonly label: string;
}

/** Home's four ways to start, two by two. */
const HOME_STARTS: readonly ClaudeHomeStart[] = [
	{ id: 'workbench.action.files.openFolder', icon: Codicon.folderOpened, label: localize('claudeHomeOpenProject', "Open Project") },
	{ id: 'git.clone', icon: Codicon.repoClone, label: localize('claudeHomeClone', "Clone Repository") },
	{ id: CLAUDE_NEW_SESSION_COMMAND_ID, icon: Codicon.add, label: localize('claudeHomeNewAgent', "New Agent") },
	{ id: CLAUDE_OPEN_AGENTS_WINDOW_COMMAND_ID, icon: Codicon.window, label: localize('claudeHomeAgentsWindow', "Agents Window") },
];

interface ClaudeWatermarkShortcut {
	readonly id: string;
	readonly label: string;
	/** Listed even without a key, because it is the first thing to do in a project. */
	readonly always?: boolean;
}

/** The watermark's shortcuts in a window with a project, in a fixed order. */
const WATERMARK_SHORTCUTS: readonly ClaudeWatermarkShortcut[] = [
	{ id: CLAUDE_NEW_SESSION_COMMAND_ID, label: localize('claudeWatermarkNewAgent', "New Agent"), always: true },
	{ id: CLAUDE_FOCUS_AGENT_COMMAND_ID, label: localize('claudeWatermarkAskAgent', "Focus Agent") },
	{ id: 'workbench.action.quickOpen', label: localize('claudeWatermarkGoToFile', "Go to File") },
	{ id: 'workbench.action.terminal.toggleTerminal', label: localize({ key: 'claudeWatermarkTerminal', comment: ['toggle is a verb here'] }, "Toggle Terminal") },
	{ id: 'workbench.action.showCommands', label: localize('claudeWatermarkCommands', "Show All Commands") },
];

/**
 * What an empty editor group shows instead of the stock watermark: Home in a
 * window with no folder (ide-02), or the Klawly mark over shortcuts that run
 * on click in a window with a project (ide-03).
 */
export class ClaudeEditorWatermark extends Disposable {

	private _account: HTMLElement | undefined;
	private _recent: HTMLElement | undefined;
	private _hint: HTMLElement | undefined;
	private readonly _accountStore = this._register(new DisposableStore());
	private readonly _recentStore = this._register(new DisposableStore());

	constructor(
		container: HTMLElement,
		workbenchState: WorkbenchState,
		@ICommandService private readonly _commands: ICommandService,
		@IKeybindingService private readonly _keybindings: IKeybindingService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IWorkspacesService private readonly _workspaces: IWorkspacesService,
		@ILabelService private readonly _labels: ILabelService,
		@IHostService private readonly _host: IHostService,
		@IHoverService private readonly _hover: IHoverService,
		@IProductService private readonly _product: IProductService,
		@IFileService private readonly _files: IFileService,
	) {
		super();
		if (workbenchState === WorkbenchState.EMPTY) {
			this.renderHome(container);
		} else {
			this.renderWatermark(container);
		}
	}

	private renderWatermark(container: HTMLElement): void {
		const root = append(container, $('.claude-root.claude-watermark'));
		append(root, $('.claude-watermark-mark', { 'aria-hidden': 'true' }));
		const list = append(root, $('.claude-watermark-shortcuts'));
		const update = () => {
			clearNode(list);
			for (const shortcut of WATERMARK_SHORTCUTS) {
				const key = this._keybindings.lookupKeybinding(shortcut.id)?.getLabel();
				if (!CommandsRegistry.getCommand(shortcut.id) || (!key && !shortcut.always)) {
					continue;
				}
				const row = append(list, $<HTMLButtonElement>('button.claude-watermark-shortcut', { type: 'button', 'data-command': shortcut.id }));
				append(row, $('span.label')).textContent = shortcut.label;
				if (key) {
					appendClaudeKbd(row, key);
				}
				row.addEventListener('click', () => void this._commands.executeCommand(shortcut.id));
			}
		};
		update();
		this._register(this._keybindings.onDidUpdateKeybindings(update));
	}

	private renderHome(container: HTMLElement): void {
		const home = append(container, $('.claude-root.claude-home'));

		const brand = append(home, $('.claude-home-brand'));
		const lockup = append(brand, $('.claude-home-lockup'));
		append(lockup, $<HTMLImageElement>('img.claude-home-mark', { src: FileAccess.asBrowserUri('vs/workbench/contrib/claude/browser/media/klawly-mark.svg').toString(true), alt: '' }));
		append(lockup, $('h1.claude-home-name')).textContent = this._product.nameShort;
		this._account = append(brand, $('.claude-home-account'));

		const starts = append(home, $('.claude-home-starts', { role: 'group', 'aria-label': localize('claudeHomeStarts', "Start") }));
		for (const start of HOME_STARTS) {
			const tile = append(starts, $<HTMLButtonElement>('button.claude-home-start', { type: 'button', 'data-command': start.id }));
			append(tile, $(ThemeIcon.asCSSSelector(start.icon), { 'aria-hidden': 'true' }));
			append(tile, $('span.label')).textContent = start.label;
			tile.addEventListener('click', () => void this._commands.executeCommand(start.id));
		}

		this._recent = append(home, $('.claude-home-recent'));
		this._hint = append(home, $('.claude-home-hint-slot'));

		this._register(this._runtime.onDidChangeRuntimeState(() => void this.refreshAccount()));
		this._register(this._runtime.onDidEmitEvent(event => {
			if (event.type === 'session.catalog') {
				void this.refreshAccount();
			}
		}));
		this._register(this._workspaces.onDidChangeRecentlyOpened(() => void this.refreshRecent()));
		this._register(this._labels.onDidChangeFormatters(() => void this.refreshRecent()));
		void this.refreshAccount();
		void this.refreshRecent();
	}

	/** The plan (or sign-in state) with a Settings link, and the pill that fixes a missing install or sign-in. */
	private async refreshAccount(): Promise<void> {
		const [state, overview] = await Promise.all([
			this._runtime.getRuntimeState().catch(() => undefined),
			this._runtime.getAccountOverview?.().catch(() => undefined) ?? Promise.resolve<ClaudeAccountOverview | undefined>(undefined),
		]);
		if (this._store.isDisposed || !this._account || !this._hint) {
			return;
		}
		this._accountStore.clear();
		clearNode(this._account);
		clearNode(this._hint);

		const summary = claudeAccountSummary(state);
		const plan = state?.authenticated && overview?.account?.plan ? localize('claudeHomePlan', "{0} Plan", claudePlanLabel(overview.account.plan)) : summary.label;
		append(this._account, $('span.plan')).textContent = plan;
		append(this._account, $('span.dot', { 'aria-hidden': 'true' }));
		const settings = append(this._account, $<HTMLButtonElement>('button.claude-home-link', { type: 'button' }));
		settings.textContent = localize('claudeHomeSettings', "Settings");
		this._accountStore.add(addDisposableListener(settings, EventType.CLICK, () => void this._commands.executeCommand(CLAUDE_OPEN_SETTINGS_COMMAND_ID)));

		const action = summary.action;
		if (action) {
			const hint = append(this._hint, $<HTMLButtonElement>('button.claude-btn.claude-home-hint', { type: 'button', 'data-command': action.command }));
			append(hint, $('span')).textContent = summary.detail;
			append(hint, $('span.action')).textContent = action.label;
			append(hint, $(ThemeIcon.asCSSSelector(Codicon.arrowRight), { 'aria-hidden': 'true' }));
			this._accountStore.add(addDisposableListener(hint, EventType.CLICK, () => void this._commands.executeCommand(action.command)));
		}
		if (state && !state.installed) {
			// Claude Code installed outside Klawly is found without a restart (issue 91).
			const recheck = append(this._hint, $<HTMLButtonElement>('button.claude-home-link', { type: 'button', 'data-command': CLAUDE_REDETECT_RUNTIME_COMMAND_ID }));
			recheck.textContent = localize('claudeHomeCheckAgain', "Check Again");
			this._accountStore.add(addDisposableListener(recheck, EventType.CLICK, () => void this._commands.executeCommand(CLAUDE_REDETECT_RUNTIME_COMMAND_ID)));
		}
	}

	private async refreshRecent(): Promise<void> {
		const { workspaces } = await this._workspaces.getRecentlyOpened();
		if (this._store.isDisposed || !this._recent) {
			return;
		}
		const known = workspaces.filter((recent): recent is IRecentFolder | IRecentWorkspace => isRecentFolder(recent) || isRecentWorkspace(recent));
		// A folder that is gone from disk is hidden (DL-12); a remote or virtual one cannot be checked cheaply, so it stays.
		const present = await Promise.all(known.map(recent => this.stillExists(recent)));
		if (this._store.isDisposed || !this._recent) {
			return;
		}
		// Cleared after the last await, so two overlapping refreshes never both append a list.
		this._recentStore.clear();
		clearNode(this._recent);
		const recents = known.filter((_, index) => present[index]);
		if (!recents.length) {
			return;
		}
		const head = append(this._recent, $('.claude-home-recent-head'));
		append(head, $('span.title')).textContent = localize('claudeHomeRecent', "Recent Projects");
		if (recents.length > RECENT_LIMIT) {
			const all = append(head, $<HTMLButtonElement>('button.claude-home-link', { type: 'button' }));
			all.textContent = localize('claudeHomeShowAll', "Show All");
			this._recentStore.add(addDisposableListener(all, EventType.CLICK, () => void this._commands.executeCommand('workbench.action.openRecent')));
		}
		const list = append(this._recent, $('.claude-home-recent-list'));
		for (const recent of recents.slice(0, RECENT_LIMIT)) {
			this._recentStore.add(this.renderRecent(list, recent));
		}
	}

	private async stillExists(recent: IRecentFolder | IRecentWorkspace): Promise<boolean> {
		const uri = isRecentFolder(recent) ? recent.folderUri : recent.workspace.configPath;
		if (uri.scheme !== Schemas.file) {
			return true;
		}
		try {
			return await this._files.exists(uri);
		} catch {
			return true;
		}
	}

	private renderRecent(list: HTMLElement, recent: IRecentFolder | IRecentWorkspace): IDisposable {
		const store = new DisposableStore();
		const openable: IWindowOpenable = isRecentFolder(recent) ? { folderUri: recent.folderUri } : { workspaceUri: recent.workspace.configPath };
		const fullPath = recent.label || this._labels.getWorkspaceLabel(isRecentFolder(recent) ? recent.folderUri : recent.workspace, { verbose: Verbosity.LONG });
		const { name, parentPath } = splitRecentLabel(fullPath);
		const row = append(list, $<HTMLButtonElement>('button.claude-home-recent-item', { type: 'button' }));
		row.setAttribute('aria-label', localize('claudeHomeOpenRecent', "Open {0} in {1}", name, fullPath));
		append(row, $('span.name')).textContent = name;
		const path = append(row, $('span.path'));
		append(path, $('span')).textContent = middleTruncatePath(parentPath, RECENT_PATH_LIMIT);
		store.add(this._hover.setupManagedHover(getDefaultHoverDelegate('mouse'), row, fullPath));
		store.add(addDisposableListener(row, EventType.CLICK, event => {
			void this._host.openWindow([openable], {
				forceNewWindow: event.ctrlKey || event.metaKey,
				remoteAuthority: recent.remoteAuthority || null,
			});
		}));
		return store;
	}
}

/** Puts Home and the Klawly watermark in every empty editor group. */
export function registerClaudeEditorWatermark(): IDisposable {
	return registerEditorGroupWatermarkContent(ClaudeEditorWatermark);
}
