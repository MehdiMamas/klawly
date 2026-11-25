/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { IActionViewItem } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { BaseActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IDropdownMenuActionViewItemOptions } from '../../../../../base/browser/ui/dropdown/dropdownActionViewItem.js';
import { IAction } from '../../../../../base/common/actions.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { CLAUDE_AGENT_HEADER_ACTION_ID, CLAUDE_AGENT_VIEW_ID, CLAUDE_MOVE_CHAT_TO_SIDE_BAR_COMMAND_ID, CLAUDE_OPEN_CHAT_IN_EDITOR_COMMAND_ID } from '../../common/claudeViews.js';
import { isClaudeChatInEditor } from './claudeAgentEditorInput.js';
import { ClaudeChatWidget } from './claudeChatWidget.js';
import '../media/claude.css';

// The Agent view's first title item. It renders the chat's header row, not a button (#106).
CommandsRegistry.registerCommand(CLAUDE_AGENT_HEADER_ACTION_ID, () => { });
MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: { id: CLAUDE_AGENT_HEADER_ACTION_ID, title: localize2('claudeAgentSessions', "Agent Sessions") },
	when: ContextKeyExpr.equals('view', CLAUDE_AGENT_VIEW_ID),
	group: 'navigation',
	order: -100,
});

/** Keys the title toolbar would take for itself; in the header row they belong to the tabs and buttons. */
const HEADER_ROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' ']);

/**
 * The slot in the view's title row that the chat lends its header row to: session tabs,
 * New, History and More then share one row with the title actions, maximize included (#106).
 */
class ClaudeAgentHeaderActionViewItem extends BaseActionViewItem {
	constructor(action: IAction, private readonly _slot: HTMLElement) {
		super(null, action);
	}

	override setFocusable(): void { /* the tabs and buttons in the row take focus themselves */ }

	override render(container: HTMLElement): void {
		this.element = container;
		container.classList.add('claude-title-header-item');
		container.appendChild(this._slot);
		for (const type of [EventType.KEY_DOWN, EventType.KEY_UP]) {
			this._register(addDisposableListener(container, type, event => {
				if (HEADER_ROW_KEYS.has(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey) {
					event.stopPropagation();
				}
			}));
		}
	}
}

/**
 * The Agent view. It hosts the chat unless the chat is open in an editor tab;
 * then it says where the chat went and offers to bring it back.
 */
export class ClaudeAgentViewPane extends ViewPane {
	static readonly ID = CLAUDE_AGENT_VIEW_ID;

	private readonly _widget = this._register(new MutableDisposable<ClaudeChatWidget>());
	private readonly _moved = this._register(new MutableDisposable<DisposableStore>());
	/** Where the chat's header row goes while the view's own header is hidden, i.e. merged into the part title. */
	private readonly _titleHeader = $('.claude-root.claude-title-header');
	private _body: HTMLElement | undefined;
	private _showChat: HTMLButtonElement | undefined;
	private _size: { height: number; width: number } | undefined;

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
		@IEditorService private readonly _editors: IEditorService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this._editors.onDidEditorsChange(() => this.syncHost()));
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (!visible) {
				this._widget.value?.hide();
			}
		}));
	}

	/** The chat this view shows, unless the chat is open in an editor tab. */
	get widget(): ClaudeChatWidget | undefined {
		return this._widget.value;
	}

	override get headerVisible(): boolean {
		return super.headerVisible;
	}

	override set headerVisible(visible: boolean) {
		super.headerVisible = visible;
		this.placeHeader();
	}

	override createActionViewItem(action: IAction, options?: IDropdownMenuActionViewItemOptions): IActionViewItem | undefined {
		if (action.id === CLAUDE_AGENT_HEADER_ACTION_ID) {
			return new ClaudeAgentHeaderActionViewItem(action, this._titleHeader);
		}
		return super.createActionViewItem(action, options);
	}

	/**
	 * The view alone in its container shows no header of its own; the part title shows its
	 * actions instead, so the chat's header row joins them there. Next to other views the
	 * row stays at the top of the chat.
	 */
	private placeHeader(): void {
		this._widget.value?.setHeaderHost(this.headerVisible ? undefined : this._titleHeader);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._body = container;
		this.syncHost();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this._size = { height, width };
		this._widget.value?.layout(height, width);
	}

	override focus(): void {
		// While the chat is in a tab, focus lands on the way to it; moving focus never moves the chat.
		if (this._widget.value) {
			this._widget.value.focus();
		} else {
			this._showChat?.focus();
		}
	}

	/** One host at a time: the chat leaves this view while its editor tab is open, and returns when the tab closes. */
	private syncHost(): void {
		if (!this._body) {
			return;
		}
		if (isClaudeChatInEditor(this._editors)) {
			this._widget.clear();
			if (!this._moved.value) {
				this._moved.value = this.renderMoved(this._body);
			}
			return;
		}
		this._moved.clear();
		if (!this._widget.value) {
			this._widget.value = this.instantiationService.createInstance(ClaudeChatWidget, this._body, 'view');
			this.placeHeader();
			if (this._size) {
				this._widget.value.layout(this._size.height, this._size.width);
			}
		}
	}

	private renderMoved(container: HTMLElement): DisposableStore {
		const store = new DisposableStore();
		const root = append(container, $('.claude-root.claude-chat-moved'));
		store.add(toDisposable(() => {
			root.remove();
			this._showChat = undefined;
		}));
		append(root, $('p')).textContent = localize('claudeChatMoved', "The chat is open in an editor tab.");
		const actions = append(root, $('.claude-chat-moved-actions'));
		const button = (label: string, primary: boolean, commandId: string) => {
			const element = append(actions, $<HTMLButtonElement>(primary ? 'button.claude-btn.is-primary' : 'button.claude-btn'));
			element.type = 'button';
			element.textContent = label;
			store.add(addDisposableListener(element, EventType.CLICK, () => void this._commandService.executeCommand(commandId)));
			return element;
		};
		this._showChat = button(localize('claudeShowChat', "Show Chat"), true, CLAUDE_OPEN_CHAT_IN_EDITOR_COMMAND_ID);
		button(localize('claudeMoveChatHere', "Move Chat Here"), false, CLAUDE_MOVE_CHAT_TO_SIDE_BAR_COMMAND_ID);
		return store;
	}
}
