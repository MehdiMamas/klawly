/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/claudeAgentView.css';
import { $, append, clearNode, EventType, addDisposableListener } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IClaudeToolItem } from '../../../../platform/claude/common/claudeConversation.js';
import { ClaudeAgent } from '../../../../platform/claude/common/claudeAgents.js';
import { IClaudeRuntimeService, IClaudeWorktree } from '../../../../platform/claude/common/claudeRuntime.js';
import { formatBytes, worktreeKeepReason } from '../../../../platform/claude/common/claudeWorktrees.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IClaudeAgentsService } from '../../../services/claude/browser/claudeAgentsService.js';

export const CLAUDE_BACKGROUND_VIEW_CONTAINER_ID = 'workbench.view.claudeBackground';
export const CLAUDE_BACKGROUND_VIEW_ID = 'workbench.view.claudeBackground.view';
export const CLAUDE_BACKGROUND_TITLE = localize2('claude.background.title', "Background");
export const CLAUDE_WORKTREE_CLEANUP_SETTING = 'claude.agents.worktreeCleanupDays';

/** Background shell tasks an agent started with `run_in_background` (v5-S27 section 1). */
export function claudeBackgroundTasks(agents: readonly ClaudeAgent[]): { readonly agent: ClaudeAgent; readonly tool: IClaudeToolItem }[] {
	return agents.flatMap(agent => agent.conversation.items
		.filter((item): item is IClaudeToolItem => item.kind === 'tool' && item.name === 'Bash' && item.input.run_in_background === true)
		.map(tool => ({ agent, tool })));
}

/** The Background panel view (v5-S27): background shell tasks, and the worktrees agents left behind. */
export class ClaudeBackgroundViewPane extends ViewPane {

	private content!: HTMLElement;
	private worktrees: IClaudeWorktree[] = [];
	private error: string | undefined;
	private readonly rows = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IClaudeRuntimeService private readonly runtime: IClaudeRuntimeService,
		@IClaudeAgentsService private readonly agents: IClaudeAgentsService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.agents.onDidChange(() => this.content && this.renderRows()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.content = append(container, $('.claude-background'));
		this.renderRows();
		this.refresh();
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (visible && this.content) {
			this.refresh();
		}
	}

	private get cwd(): string | undefined {
		return this.workspace.getWorkspace().folders[0]?.uri.fsPath;
	}

	/** Reads the worktrees from git; sizes and dirtiness are read by the runtime, not here. */
	async refresh(): Promise<void> {
		const cwd = this.cwd;
		try {
			this.worktrees = cwd ? await this.runtime.listWorktrees(cwd) : [];
			this.error = undefined;
		} catch (error) {
			this.worktrees = [];
			this.error = error instanceof Error ? error.message : String(error);
		}
		this.renderRows();
	}

	private renderRows(): void {
		const store = new DisposableStore();
		this.rows.value = store;
		clearNode(this.content);

		append(this.content, $('.claude-section-title')).textContent = localize('claude.background.tasks', "BACKGROUND TASKS");
		const tasks = claudeBackgroundTasks(this.agents.all());
		if (!tasks.length) {
			append(this.content, $('.claude-agents-none')).textContent = localize('claude.background.noTasks', "No background tasks");
		}
		for (const { agent, tool } of tasks) {
			const row = append(this.content, $('.claude-bg-row'));
			const text = append(row, $('.claude-bg-text'));
			append(text, $('code.claude-bg-title')).textContent = typeof tool.input.command === 'string' ? tool.input.command : tool.target;
			append(text, $('.claude-need-sub')).textContent = localize('claude.background.startedBy', "started by {0}", agent.title);
			this.button(row, localize('claude.background.show', "Show"), store, () => this.agents.select(agent));
		}

		append(this.content, $('.claude-section-title')).textContent = localize('claude.background.worktrees', "WORKTREES");
		if (this.error) {
			append(this.content, $('.claude-attempt-result.error')).textContent = this.error;
		}
		if (!this.worktrees.length) {
			append(this.content, $('.claude-agents-none')).textContent = localize('claude.background.noWorktrees', "No worktrees");
		}
		for (const worktree of this.worktrees) {
			this.renderWorktree(worktree, store);
		}
		const days = this.configurationService.getValue<number>(CLAUDE_WORKTREE_CLEANUP_SETTING) ?? 7;
		const total = this.worktrees.reduce((sum, w) => sum + w.sizeBytes, 0);
		append(this.content, $('.claude-bg-footer')).textContent = days > 0
			? localize('claude.background.footer', "Worktrees use {0} · finished ones older than {1} days are cleaned up", formatBytes(total), days)
			: localize('claude.background.footer.off', "Worktrees use {0} · automatic cleanup is off", formatBytes(total));
	}

	private renderWorktree(worktree: IClaudeWorktree, store: DisposableStore): void {
		const row = append(this.content, $('.claude-bg-row'));
		const text = append(row, $('.claude-bg-text'));
		append(text, $('.claude-bg-title')).textContent = localize('claude.background.worktree', "Worktree {0}", worktree.branch ?? worktree.name);
		append(text, $('.claude-need-sub')).textContent = worktree.running
			? localize('claude.background.running', "{0} · running", formatBytes(worktree.sizeBytes))
			: localize('claude.background.done', "{0} · done {1}", formatBytes(worktree.sizeBytes), fromNow(worktree.modified, true));
		const reason = worktreeKeepReason(worktree);
		// a disabled button gets no hover, so the reason sits on its wrapper
		const holder = append(row, $('span.claude-bg-action'));
		this.button(holder, localize('claude.background.cleanUp', "Clean up"), store, async () => {
			try {
				await this.runtime.removeWorktree(this.cwd ?? '', worktree.name);
				this.error = undefined;
			} catch (error) {
				this.error = error instanceof Error ? error.message : String(error);
			}
			await this.refresh();
		}, !!reason);
		if (reason) {
			store.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), holder, reason === 'running'
				? localize('claude.background.reason.running', "An agent is still running in this worktree")
				: localize('claude.background.reason.dirty', "It has changes that are not committed")));
		}
	}

	private button(parent: HTMLElement, text: string, store: DisposableStore, run: () => void, disabled = false): void {
		const button = append(parent, $('button.claude-button')) as HTMLButtonElement;
		button.textContent = text;
		button.disabled = disabled;
		store.add(addDisposableListener(button, EventType.CLICK, run));
	}
}
