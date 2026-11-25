/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, Dimension } from '../../../../../base/browser/dom.js';
import { IActionViewItem } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { IBaseActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { AnchorAlignment } from '../../../../../base/browser/ui/contextview/contextview.js';
import { DropdownMenuActionViewItem } from '../../../../../base/browser/ui/dropdown/dropdownActionViewItem.js';
import { IAction } from '../../../../../base/common/actions.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { MenuEntryActionViewItem } from '../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { MenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { ClaudeAgentEditorInput } from './claudeAgentEditorInput.js';
import { ClaudeChatWidget } from './claudeChatWidget.js';

/** The chat tab's History button: drops the Agent history popover down under it, as the view's does. */
export const CLAUDE_AGENT_EDITOR_HISTORY_COMMAND_ID = 'claude.agentEditor.toggleHistory';

/** The chat tab's More button: the editor shows the chat's More menu under it. */
export const CLAUDE_AGENT_EDITOR_MORE_COMMAND_ID = 'claude.agentEditor.more';

/**
 * The chat in an editor tab, in the main window or a window of its own. The
 * widget lives while the tab shows; the session's draft and transcript live in
 * the agent service, so hiding the tab loses nothing.
 */
export class ClaudeAgentEditor extends EditorPane {

	static readonly ID = ClaudeAgentEditorInput.EDITOR_ID;

	private readonly _widget = this._register(new MutableDisposable<ClaudeChatWidget>());
	private _container: HTMLElement | undefined;
	private _dimension: Dimension | undefined;
	private _historyItem: ClaudeAgentHistoryActionViewItem | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly _instantiation: IInstantiationService,
		@IContextMenuService private readonly _contextMenu: IContextMenuService,
		@IKeybindingService private readonly _keybindings: IKeybindingService,
	) {
		super(ClaudeAgentEditor.ID, group, telemetryService, themeService, storageService);
	}

	/** The chat this tab shows, while it shows one. */
	get widget(): ClaudeChatWidget | undefined {
		return this._widget.value;
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = append(parent, $('.claude-agent-editor'));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested || !this._container || this._widget.value) {
			return;
		}
		this._widget.value = this._instantiation.createInstance(ClaudeChatWidget, this._container, 'editor');
		this._widget.value.setHistoryAnchor(() => this.historyAnchor());
		if (this._dimension) {
			this._widget.value.layout(this._dimension.height, this._dimension.width);
		}
	}

	override clearInput(): void {
		// Tab hidden, closed or moved: the next host builds its own widget.
		this._widget.clear();
		super.clearInput();
	}

	layout(dimension: Dimension): void {
		this._dimension = dimension;
		this._widget.value?.layout(dimension.height, dimension.width);
	}

	/**
	 * More opens the chat's own More menu, with its live enablement and checks (issue 142).
	 * History keeps its button so the history popover drops down under it (issue 356).
	 */
	override getActionViewItem(action: IAction, options: IBaseActionViewItemOptions): IActionViewItem | undefined {
		if (action.id === CLAUDE_AGENT_EDITOR_HISTORY_COMMAND_ID && action instanceof MenuItemAction) {
			return this._historyItem = this._instantiation.createInstance(ClaudeAgentHistoryActionViewItem, action, options);
		}
		if (action.id !== CLAUDE_AGENT_EDITOR_MORE_COMMAND_ID) {
			return super.getActionViewItem(action, options);
		}
		return new DropdownMenuActionViewItem(action, { getActions: () => this._widget.value?.getMoreActions() ?? [] }, this._contextMenu, {
			...options,
			classNames: ThemeIcon.asClassNameArray(Codicon.ellipsis),
			keybindingProvider: candidate => this._keybindings.lookupKeybinding(candidate.id),
			anchorAlignmentProvider: () => AnchorAlignment.RIGHT,
		});
	}

	/** The editor title's History button while it shows; the toolbar renders a new one on each update. */
	private historyAnchor(): HTMLElement | undefined {
		const anchor = this._historyItem?.anchor;
		return anchor?.isConnected ? anchor : undefined;
	}

	override focus(): void {
		super.focus();
		this._widget.value?.focus();
	}
}

/** The editor title's History button, which the history popover anchors on. */
class ClaudeAgentHistoryActionViewItem extends MenuEntryActionViewItem {
	get anchor(): HTMLElement | undefined {
		return this.label ?? this.element;
	}
}
