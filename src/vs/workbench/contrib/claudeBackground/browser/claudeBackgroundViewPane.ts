/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { backgroundAgentCard, BackgroundCardAction } from '../../../services/claude/common/claudeBackgroundCards.js';
import { IClaudeBackgroundAgentService } from '../../../services/claude/common/claudeBackgroundAgent.js';
import { CLAUDE_BACKGROUND_VIEW_ID } from '../common/claudeBackground.js';
import '../../claude/browser/media/claude.css';
import { renderBackgroundAgentCard } from './claudeBackgroundCard.js';

/** Background agent cards. Each agent keeps its own git worktree. */
export class ClaudeBackgroundViewPane extends ViewPane {
	static readonly ID = CLAUDE_BACKGROUND_VIEW_ID;

	private readonly _cards = this._register(new DisposableStore());
	private _list: HTMLElement | undefined;

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
		@IClaudeBackgroundAgentService private readonly _background: IClaudeBackgroundAgentService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@INotificationService private readonly _notifications: INotificationService,
		@ICommandService private readonly _commands: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this._background.onDidChangeTasks(() => this.renderCards()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const pane = append(container, $('.claude-pane.claude-root.claude-background'));
		pane.setAttribute('aria-label', localize('claudeBackgroundPane', "Background agents"));
		const bar = append(pane, $('.claude-background-bar'));
		// A ghost button: the Agent view leads, this view supports it (audit 4).
		const start = append(bar, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
		start.type = 'button';
		append(start, $(ThemeIcon.asCSSSelector(Codicon.add)));
		append(start, $('span')).textContent = localize('claudeBackgroundStart', "New background agent");
		this._register(addDisposableListener(start, EventType.CLICK, () => void this.startAgent()));
		this._list = append(pane, $('.claude-background-list'));
		this._list.setAttribute('role', 'list');
		this.renderCards();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	private renderCards(): void {
		if (!this._list) {
			return;
		}
		this._cards.clear();
		clearNode(this._list);
		const tasks = this._background.getTasks();
		const summary = append(this._list, $('.claude-background-summary'));
		summary.textContent = localize('claudeBackgroundCount', "{0} of {1} running", tasks.filter(task => task.status === 'starting' || task.status === 'running' || task.status === 'waiting').length, this._background.maxParallelSessions());
		if (tasks.length === 0) {
			const empty = append(this._list, $('.claude-history-empty'));
			empty.textContent = localize('claudeBackgroundEmptyList', "No background agents yet.");
			return;
		}
		for (const task of tasks) {
			const card = backgroundAgentCard(task);
			renderBackgroundAgentCard(this._list, card, this._cards, action => void this.runAction(task.id, task.worktreePath, action));
		}
	}

	private async startAgent(): Promise<void> {
		const prompt = await this._quickInput.input({
			prompt: localize('claudeBackgroundPrompt', "What should the background agent do?"),
		});
		if (!prompt?.trim()) {
			return;
		}
		try {
			await this._background.start(prompt.trim());
		} catch (error) {
			this._notifications.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async runAction(taskId: string, worktreePath: string, action: BackgroundCardAction): Promise<void> {
		try {
			switch (action) {
				case 'review':
					await this._background.review(taskId);
					break;
				case 'apply':
					await this._background.apply(taskId);
					break;
				case 'resolve':
					await this._background.openConflicts(taskId);
					break;
				case 'open':
					await this._commands.executeCommand('vscode.openFolder', URI.file(worktreePath), { forceNewWindow: true });
					break;
				case 'stop':
					await this._background.stop(taskId);
					break;
				case 'delete':
					await this._background.delete(taskId);
					break;
			}
		} catch (error) {
			this._notifications.error(error instanceof Error ? error.message : String(error));
		}
	}
}
