/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import '../media/claude.css';
import { $, addDisposableListener, append, EventType, getTotalHeight, getTotalWidth, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { CLAUDE_AGENT_ENABLED_SETTING, CLAUDE_SELECTION_TOOLBAR_SETTING, readClaudeAgentEnabled } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ITerminalContribution, ITerminalService, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { ITerminalContributionContext, registerTerminalContribution } from '../../../terminal/browser/terminalExtensions.js';
import { terminalSelectionBarPlace } from '../../common/claudeTerminalPrompt.js';
import { CLAUDE_ADD_TERMINAL_COMMAND_ID } from '../../common/claudeViews.js';
import { SELECTION_TOOLBAR_SETTLE_MS } from '../inline/claudeSelectionToolbar.js';

/**
 * A small Add to Agent bar over a terminal selection, like the editor's
 * selection toolbar (DL-07, issue 780). It shows once the selection settles,
 * runs the same command as the terminal's right-click menu and never takes
 * focus from the terminal.
 */
class ClaudeTerminalSelectionBar extends Disposable implements ITerminalContribution {
	static readonly ID = 'klawly.terminalSelectionBar';

	private _xterm: RawXtermTerminal | undefined;
	private _anchor: HTMLElement | undefined;
	private _mouseDown = false;
	private readonly _settle = this._register(new RunOnceScheduler(() => this._update(), SELECTION_TOOLBAR_SETTLE_MS));
	private readonly _listeners = this._register(new DisposableStore());

	constructor(
		private readonly _ctx: ITerminalContributionContext,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@ICommandService private readonly _commands: ICommandService,
		@ITerminalService private readonly _terminals: ITerminalService,
	) {
		super();
		this._register(toDisposable(() => this._anchor?.remove()));
	}

	/** xterm has its element only once it is attached; a terminal that moves is attached again. */
	xtermOpen(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		this._listeners.clear();
		const raw = xterm.raw;
		const element = raw.element;
		if (!element) {
			return;
		}
		this._xterm = raw;
		this._listeners.add(raw.onSelectionChange(() => {
			if (!this._enabled() || !raw.hasSelection()) {
				this._hide();
			} else if (this._visible) {
				// A selection that grows while shown moves the bar with it.
				this._update();
			} else if (!this._mouseDown) {
				this._settle.schedule();
			}
		}));
		this._listeners.add(raw.onScroll(() => this._visible && this._update()));
		this._listeners.add(raw.onResize(() => this._visible && this._update()));
		this._listeners.add(addDisposableListener(element, EventType.MOUSE_DOWN, event => {
			// A press on the bar itself must not hide it, or the click never lands.
			if (this._anchor?.contains(event.target as Node)) {
				return;
			}
			this._mouseDown = event.button === 0;
			if (this._mouseDown) {
				this._hide();
			}
		}, true));
		// A drag can end outside the terminal.
		this._listeners.add(addDisposableListener(getWindow(element), EventType.MOUSE_UP, () => {
			if (this._mouseDown) {
				this._mouseDown = false;
				this._update();
			}
		}));
		this._listeners.add(this._ctx.instance.onDidBlur(() => {
			this._mouseDown = false;
			this._hide();
		}));
		this._listeners.add(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_SELECTION_TOOLBAR_SETTING) || event.affectsConfiguration(CLAUDE_AGENT_ENABLED_SETTING)) {
				this._update();
			}
		}));
	}

	private get _visible(): boolean {
		return !!this._anchor?.isConnected && this._anchor.style.display !== 'none';
	}

	private _enabled(): boolean {
		return !!this._configuration.getValue<boolean>(CLAUDE_SELECTION_TOOLBAR_SETTING) && readClaudeAgentEnabled(this._configuration.getValue(CLAUDE_AGENT_ENABLED_SETTING));
	}

	private _hide(): void {
		this._settle.cancel();
		if (this._anchor) {
			this._anchor.style.display = 'none';
		}
	}

	private _update(): void {
		this._settle.cancel();
		const raw = this._xterm;
		const element = raw?.element;
		const screen = element && xtermScreen(element);
		const selection = raw?.getSelectionPosition();
		if (!raw || !element || !screen || !selection || !this._enabled() || !this._ctx.instance.hasFocus || raw.getSelection().trim().length === 0) {
			this._hide();
			return;
		}
		const anchor = this._render(element);
		anchor.style.display = '';
		const place = terminalSelectionBarPlace(
			{ startColumn: selection.start.x, startRow: selection.start.y, endColumn: selection.end.x, endRow: selection.end.y },
			{ viewportY: raw.buffer.active.viewportY, rows: raw.rows, cellWidth: screen.clientWidth / raw.cols, cellHeight: screen.clientHeight / raw.rows, width: screen.clientWidth },
			getTotalWidth(anchor),
			getTotalHeight(anchor),
		);
		if (!place) {
			this._hide();
			return;
		}
		// The screen can sit inset in the terminal element; place the bar against the screen.
		const elementBox = element.getBoundingClientRect();
		const screenBox = screen.getBoundingClientRect();
		anchor.style.top = `${screenBox.top - elementBox.top + place.top}px`;
		anchor.style.left = `${screenBox.left - elementBox.left + place.left}px`;
	}

	private _render(element: HTMLElement): HTMLElement {
		if (this._anchor) {
			if (this._anchor.parentElement !== element) {
				element.appendChild(this._anchor);
			}
			return this._anchor;
		}
		const anchor = this._anchor = append(element, $('.claude-selection-bar-anchor.claude-terminal-selection-bar'));
		const bar = append(anchor, $('.claude-selection-bar'));
		bar.setAttribute('role', 'toolbar');
		bar.setAttribute('aria-label', localize('claudeTerminalSelectionBar', "Terminal selection actions"));
		const button = append(bar, $('button.claude-selection-bar-action', { type: 'button' }));
		append(button, renderIcon(Codicon.commentDiscussion));
		append(button, $('span.claude-selection-bar-label')).textContent = localize('claudeTerminalSelectionAddToAgent', "Add to Agent");
		button.setAttribute('aria-label', localize('claudeTerminalSelectionAddToAgentLabel', "Add Selection to Agent"));
		// The terminal keeps focus and the selection while the button is pressed.
		this._register(addDisposableListener(button, EventType.MOUSE_DOWN, event => {
			event.preventDefault();
			event.stopPropagation();
		}));
		this._register(addDisposableListener(button, EventType.CLICK, event => {
			event.preventDefault();
			this._hide();
			// The command adds the active terminal's selection; make sure that is this one.
			this._terminals.setActiveInstance(this._ctx.instance);
			void this._commands.executeCommand(CLAUDE_ADD_TERMINAL_COMMAND_ID);
		}));
		return anchor;
	}
}

/** The rendered rows inside the terminal element: a child of it, or of the scrollable element xterm wraps them in. */
function xtermScreen(element: HTMLElement, depth = 2): HTMLElement | undefined {
	for (let i = 0; i < element.children.length; i++) {
		const child = element.children[i];
		if (!isHTMLElement(child)) {
			continue;
		}
		if (child.classList.contains('xterm-screen')) {
			return child;
		}
		const nested = depth > 1 ? xtermScreen(child, depth - 1) : undefined;
		if (nested) {
			return nested;
		}
	}
	return undefined;
}

/** Registers the bar on every terminal. */
export function registerClaudeTerminalSelectionBar(): void {
	registerTerminalContribution(ClaudeTerminalSelectionBar.ID, ClaudeTerminalSelectionBar);
}
