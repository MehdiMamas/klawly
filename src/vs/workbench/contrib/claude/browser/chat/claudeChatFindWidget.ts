/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { claudeFindRegExp } from '../../common/claudeChatFind.js';
import { getWindow } from '../../../../../base/browser/dom.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { getChatFindHighlightRegistry, IChatFindHighlightRegistry, supportsCssHighlightApi } from '../../../chat/browser/widget/chatFind/chatFindHighlights.js';
import { findMatchRangesInDom } from '../../../chat/browser/widget/chatFind/chatFindWidget.js';
import { SimpleFindWidget } from '../../../codeEditor/browser/find/simpleFindWidget.js';

/** What the inline find bar needs from the chat pane it sits in. */
export interface ClaudeChatFindHost {
	/** The element whose text is searched: every turn, folded work and tool output included. */
	readonly timeline: HTMLElement;
	/** The element the bar is added to, a positioned parent of the timeline. */
	readonly parent: HTMLElement;
	/** Scrolls the match into view, opening the folded work it sits in. */
	reveal(range: Range): void;
	/** Measures the timeline again after the bar opened or closed changed its top inset. */
	insetChanged(): void;
	/** Gives the focus back to the composer when the bar closes. */
	restoreFocus(): void;
}

/** The most matches the bar counts and highlights, so a one-letter query cannot stall the pane. */
const MAX_MATCHES = 1000;
const CURRENT_MATCH = 'claude-find-current-match';
const OTHER_MATCH = 'claude-find-other-match';

/** Set on the bar's parent while the bar is open, so the timeline keeps a top inset below the bar (DL-90, issue 915). */
export const CLAUDE_FIND_BAR_OPEN_CLASS = 'has-find-bar';

/**
 * The inline find bar of the chat (issue 890): it searches what the timeline shows, highlights
 * every match in the text and steps through them with Enter and Shift+Enter (DL-91).
 */
export class ClaudeChatFindWidget extends SimpleFindWidget {

	private _ranges: Range[] = [];
	private _active = -1;
	private readonly _highlights: IChatFindHighlightRegistry;
	private readonly _highlightsSupported: boolean;

	constructor(
		private readonly _host: ClaudeChatFindHost,
		@IContextViewService contextViewService: IContextViewService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHoverService hoverService: IHoverService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IConfigurationService configurationService: IConfigurationService,
		@IAccessibilityService accessibilityService: IAccessibilityService,
	) {
		super({
			showCommonFindToggles: true,
			checkImeCompletionState: true,
			showResultCount: true,
			matchesLimit: MAX_MATCHES,
		}, contextViewService, contextKeyService, hoverService, keybindingService, configurationService, accessibilityService);
		const targetWindow = getWindow(_host.timeline);
		this._highlightsSupported = supportsCssHighlightApi(targetWindow);
		this._highlights = getChatFindHighlightRegistry(targetWindow);
		_host.parent.appendChild(this.getDomNode());
	}

	/** Opens the bar, seeded with the selected text, and finds the first match. */
	open(seedText?: string): void {
		this.setInset(true);
		this.reveal(seedText);
		this.search();
	}

	/** Searches again after the timeline repainted, keeping the active match where it is when it can. */
	contentChanged(): void {
		if (this.isVisible()) {
			this.search(true);
		}
	}

	find(previous: boolean): void {
		if (this._ranges.length === 0) {
			return;
		}
		const count = this._ranges.length;
		this._active = previous ? (this._active - 1 + count) % count : (this._active + 1) % count;
		this.paint();
		this._host.reveal(this._ranges[this._active]);
		void this.updateResultCount();
	}

	findFirst(): void {
		this.search();
	}

	protected _onInputChanged(): boolean {
		this.search();
		return this._ranges.length > 0;
	}

	protected async _getResultCount(): Promise<{ resultIndex: number; resultCount: number } | undefined> {
		return this.inputValue ? { resultIndex: this._active, resultCount: this._ranges.length } : undefined;
	}

	protected _onFocusTrackerFocus(): void { }
	protected _onFocusTrackerBlur(): void { }
	protected _onFindInputFocusTrackerFocus(): void { }
	protected _onFindInputFocusTrackerBlur(): void { }

	override hide(): void {
		super.hide();
		this.setInset(false);
		this._ranges = [];
		this._active = -1;
		this._highlights.clear(this);
		this._host.restoreFocus();
	}

	override dispose(): void {
		this._host.parent.classList.remove(CLAUDE_FIND_BAR_OPEN_CLASS);
		this._highlights.clear(this);
		super.dispose();
	}

	private setInset(open: boolean): void {
		const changed = this._host.parent.classList.contains(CLAUDE_FIND_BAR_OPEN_CLASS) !== open;
		this._host.parent.classList.toggle(CLAUDE_FIND_BAR_OPEN_CLASS, open);
		if (changed) {
			this._host.insetChanged();
		}
	}

	private search(keepActive = false): void {
		const regex = claudeFindRegExp(this.inputValue, { isRegex: this._getRegexValue(), matchCase: this._getCaseSensitiveValue(), wholeWord: this._getWholeWordValue() });
		const previous = keepActive ? this._ranges[this._active] : undefined;
		this._ranges = regex ? findMatchRangesInDom(this._host.timeline, regex, MAX_MATCHES, [this.getDomNode()]) : [];
		const same = previous ? this._ranges.findIndex(range => range.compareBoundaryPoints(Range.START_TO_START, previous) === 0) : -1;
		this._active = this._ranges.length === 0 ? -1 : same >= 0 ? same : 0;
		this.paint();
		if (this._active >= 0 && !keepActive) {
			this._host.reveal(this._ranges[this._active]);
		}
		this.updateButtons(this._ranges.length > 0 || !this.inputValue);
		void this.updateResultCount();
	}

	private paint(): void {
		if (!this._highlightsSupported) {
			return;
		}
		this._highlights.setRanges(this, CURRENT_MATCH, this._active >= 0 ? [this._ranges[this._active]] : [], 2);
		this._highlights.setRanges(this, OTHER_MATCH, this._ranges.filter((_, index) => index !== this._active), 1);
	}
}
