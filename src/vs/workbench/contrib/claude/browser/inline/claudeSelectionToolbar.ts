/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/claude.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { ContentWidgetPositionPreference, IContentWidget, IContentWidgetPosition, ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../../editor/browser/editorExtensions.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { IPosition } from '../../../../../editor/common/core/position.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { IEditorContribution } from '../../../../../editor/common/editorCommon.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { localize } from '../../../../../nls.js';
import { CLAUDE_AGENT_ENABLED_SETTING, CLAUDE_SELECTION_TOOLBAR_SETTING, readClaudeAgentEnabled } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { CLAUDE_ADD_SELECTION_COMMAND_ID, CLAUDE_INLINE_EDIT_COMMAND_ID } from '../../common/claudeViews.js';
import { ClaudeInlineController } from './claudeInlineController.js';

/** How long a keyboard selection has to stay still before the toolbar shows. */
export const SELECTION_TOOLBAR_SETTLE_MS = 250;

/** Past this many characters the whitespace check is skipped. */
const SELECTION_TEXT_CHECK_LIMIT = 10_000;

/** The room the toolbar needs above a line, band included. */
const SELECTION_TOOLBAR_HEIGHT = 40;

/**
 * Where the toolbar sits for a selection: at the start of the text on the first
 * selected line, or on the last one when it opens below, so it lines up with the
 * code instead of floating past it. A selection that starts mid-line anchors at
 * its start. Nowhere when the selection is empty, multiple or blank.
 */
export function selectionToolbarAnchor(model: ITextModel, selections: readonly Selection[], side: 'above' | 'below' = 'above'): IPosition | undefined {
	if (selections.length !== 1 || selections[0].isEmpty()) {
		return undefined;
	}
	const selection = selections[0];
	const length = model.getValueLengthInRange(selection);
	if (length <= SELECTION_TEXT_CHECK_LIMIT && model.getValueInRange(selection).trim().length === 0) {
		return undefined;
	}
	let lineNumber: number;
	if (side === 'above') {
		lineNumber = selection.startLineNumber;
		// A selection that starts after the last character of a line really starts on the next one.
		if (lineNumber < selection.endLineNumber && selection.startColumn >= model.getLineMaxColumn(lineNumber)) {
			lineNumber++;
		}
	} else {
		lineNumber = selection.endLineNumber;
		// A selection that ends before the first character of a line really ends on the line before.
		if (lineNumber > selection.startLineNumber && selection.endColumn === 1) {
			lineNumber--;
		}
	}
	// A blank line has no text start; its end keeps the toolbar at the indentation.
	const textStart = model.getLineFirstNonWhitespaceColumn(lineNumber) || model.getLineMaxColumn(lineNumber);
	const column = lineNumber === selection.startLineNumber ? Math.max(textStart, selection.startColumn) : textStart;
	return { lineNumber, column };
}

/**
 * Shows Add to Agent and Edit above a selection once it settles. The buttons
 * run the same commands as their keys; the toolbar never takes focus.
 */
export class ClaudeSelectionToolbar extends Disposable implements IEditorContribution {
	static readonly ID = 'editor.contrib.claudeSelectionToolbar';

	private readonly _widget: SelectionToolbarWidget;
	private readonly _settle: RunOnceScheduler;
	private _mouseDown = false;

	constructor(
		private readonly _editor: ICodeEditor,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IKeybindingService private readonly _keybindings: IKeybindingService,
		@IContextKeyService private readonly _contextKeys: IContextKeyService,
		@ICommandService private readonly _commands: ICommandService,
	) {
		super();
		this._widget = this._register(new SelectionToolbarWidget(this._editor, commandId => this._run(commandId)));
		this._settle = this._register(new RunOnceScheduler(() => this._update(), SELECTION_TOOLBAR_SETTLE_MS));
		this._register(this._editor.onDidChangeCursorSelection(() => {
			if (!this._anchor()) {
				this.hide();
				return;
			}
			if (this._widget.visible) {
				// A selection that grows while shown moves the toolbar with it.
				this._update();
			} else if (!this._mouseDown) {
				this._settle.schedule();
			}
		}));
		this._register(this._editor.onMouseDown(event => {
			// A press on the toolbar itself must not rebuild it, or the click never lands.
			if (this._widget.getDomNode().contains(event.event.target)) {
				return;
			}
			this._mouseDown = event.event.leftButton;
			if (this._mouseDown) {
				this.hide();
			}
		}));
		this._register(this._editor.onMouseUp(() => {
			if (this._mouseDown) {
				this._mouseDown = false;
				this._update();
			}
		}));
		this._register(this._editor.onDidScrollChange(event => {
			if (event.scrollTopChanged && this._widget.visible) {
				this._update();
			}
		}));
		this._register(this._editor.onDidChangeModel(() => this.hide()));
		this._register(this._editor.onDidChangeModelContent(() => this.hide()));
		this._register(this._editor.onDidBlurEditorWidget(() => {
			this._mouseDown = false;
			this.hide();
		}));
		this._register(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_SELECTION_TOOLBAR_SETTING) || event.affectsConfiguration(CLAUDE_AGENT_ENABLED_SETTING)) {
				this._update();
			}
		}));
	}

	/** Where the toolbar is shown, or undefined while it is hidden. */
	get position(): IPosition | undefined {
		return this._widget.position;
	}

	get domNode(): HTMLElement {
		return this._widget.getDomNode();
	}

	hide(): void {
		this._settle.cancel();
		this._widget.hide();
	}

	private _anchor(side: 'above' | 'below' = 'above'): IPosition | undefined {
		const model = this._editor.getModel();
		if (!model || this._editor.isSimpleWidget || !this._editor.hasTextFocus()) {
			return undefined;
		}
		if (!this._configuration.getValue<boolean>(CLAUDE_SELECTION_TOOLBAR_SETTING) || !readClaudeAgentEnabled(this._configuration.getValue(CLAUDE_AGENT_ENABLED_SETTING))) {
			return undefined;
		}
		if (this._editor.getContribution<ClaudeInlineController>(ClaudeInlineController.ID)?.active) {
			return undefined;
		}
		return selectionToolbarAnchor(model, this._editor.getSelections() ?? [], side);
	}

	private _update(): void {
		this._settle.cancel();
		const above = this._anchor();
		if (!above) {
			this._widget.hide();
			return;
		}
		// Without room above the first line the toolbar goes under the last one, not over the selection.
		const roomAbove = this._editor.getTopForLineNumber(above.lineNumber) - this._editor.getScrollTop() >= SELECTION_TOOLBAR_HEIGHT;
		const anchor = roomAbove ? above : this._anchor('below') ?? above;
		const readOnly = this._editor.getOption(EditorOption.readOnly);
		this._widget.show(anchor, roomAbove ? ContentWidgetPositionPreference.ABOVE : ContentWidgetPositionPreference.BELOW, [
			{ commandId: CLAUDE_ADD_SELECTION_COMMAND_ID, icon: Codicon.commentDiscussion, label: localize('claudeSelectionAddToAgent', "Add to Agent"), keys: this._keyLabel(CLAUDE_ADD_SELECTION_COMMAND_ID) },
			...(readOnly ? [] : [{ commandId: CLAUDE_INLINE_EDIT_COMMAND_ID, icon: Codicon.edit, label: localize('claudeSelectionEdit', "Edit"), keys: this._keyLabel(CLAUDE_INLINE_EDIT_COMMAND_ID) }]),
		]);
	}

	private _keyLabel(commandId: string): string | undefined {
		return this._keybindings.lookupKeybinding(commandId, this._contextKeys)?.getLabel() ?? undefined;
	}

	private _run(commandId: string): void {
		this.hide();
		this._editor.focus();
		void this._commands.executeCommand(commandId);
	}
}

interface SelectionToolbarAction {
	readonly commandId: string;
	readonly icon: ThemeIcon;
	readonly label: string;
	readonly keys: string | undefined;
}

class SelectionToolbarWidget extends Disposable implements IContentWidget {
	// Overflow keeps a toolbar near the right edge clear of the minimap.
	readonly allowEditorOverflow = true;
	readonly suppressMouseDown = true;

	private readonly _dom: HTMLElement;
	private readonly _bar: HTMLElement;
	private readonly _actions = this._register(new DisposableStore());
	private _position: IPosition | undefined;
	private _preference = ContentWidgetPositionPreference.ABOVE;
	private _added = false;

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _run: (commandId: string) => void,
	) {
		super();
		this._dom = $('.claude-selection-bar-anchor');
		this._bar = append(this._dom, $('.claude-selection-bar'));
		this._bar.setAttribute('role', 'toolbar');
		this._bar.setAttribute('aria-label', localize('claudeSelectionToolbar', "Selection actions"));
		this._register({
			dispose: () => {
				if (this._added) {
					this._editor.removeContentWidget(this);
				}
			}
		});
	}

	get visible(): boolean {
		return !!this._position;
	}

	get position(): IPosition | undefined {
		return this._position;
	}

	getId(): string {
		return ClaudeSelectionToolbar.ID;
	}

	getDomNode(): HTMLElement {
		return this._dom;
	}

	getPosition(): IContentWidgetPosition | null {
		if (!this._position) {
			return null;
		}
		return {
			position: this._position,
			preference: [this._preference],
		};
	}

	show(position: IPosition, preference: ContentWidgetPositionPreference, actions: readonly SelectionToolbarAction[]): void {
		this._actions.clear();
		clearNode(this._bar);
		for (const action of actions) {
			if (this._bar.firstChild) {
				append(this._bar, $('span.claude-selection-bar-separator', { 'aria-hidden': 'true' }));
			}
			const button = append(this._bar, $('button.claude-selection-bar-action', { type: 'button' }));
			append(button, renderIcon(action.icon));
			append(button, $('span.claude-selection-bar-label')).textContent = action.label;
			if (action.keys) {
				// The whole shortcut as quiet text, not a chip per key, keeps the toolbar short.
				append(append(button, $('span.claude-kbd.is-quiet')), $('kbd')).textContent = action.keys;
			}
			button.setAttribute('aria-label', action.keys ? localize('claudeSelectionActionKeys', "{0} ({1})", action.label, action.keys) : action.label);
			// The editor keeps focus and the selection while the button is pressed.
			this._actions.add(addDisposableListener(button, EventType.MOUSE_DOWN, event => event.preventDefault()));
			this._actions.add(addDisposableListener(button, EventType.CLICK, event => {
				event.preventDefault();
				this._run(action.commandId);
			}));
		}
		this._position = position;
		this._preference = preference;
		if (this._added) {
			this._editor.layoutContentWidget(this);
		} else {
			this._added = true;
			this._editor.addContentWidget(this);
		}
	}

	hide(): void {
		if (!this._position) {
			return;
		}
		this._position = undefined;
		this._actions.clear();
		this._editor.layoutContentWidget(this);
	}
}

/** Registers the toolbar on every code editor. */
export function registerClaudeSelectionToolbar(): void {
	registerEditorContribution(ClaudeSelectionToolbar.ID, ClaudeSelectionToolbar, EditorContributionInstantiation.AfterFirstRender);
}
