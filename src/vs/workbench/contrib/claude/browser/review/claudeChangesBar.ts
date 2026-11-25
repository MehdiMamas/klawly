/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { TurnReview } from '../../../../services/claude/common/claudeReview.js';
import { reviewSignature } from '../chat/claudeToolCardView.js';
import { ClaudeChangesCardOptions, ClaudeReviewCardController, renderClaudeChangesBar } from './claudeChangesCard.js';

/**
 * The turn whose changes dock on top of the composer: the newest turn with
 * changed files, while it still has files to review or is the latest turn.
 * Once a newer turn starts, a fully reviewed turn goes back to its card in
 * the timeline.
 */
export function claudeDockedReviewTurn(turnIds: readonly string[], get: (turnId: string) => TurnReview | undefined): string | undefined {
	for (let index = turnIds.length - 1; index >= 0; index--) {
		const review = get(turnIds[index]);
		if (!review || review.files.length === 0) {
			continue;
		}
		const pending = review.files.some(file => file.state !== 'accepted' && file.state !== 'rejected');
		return pending || index === turnIds.length - 1 ? turnIds[index] : undefined;
	}
	return undefined;
}

/**
 * Hosts the changed-files bar above the composer. It repaints only when the
 * docked turn, its review or the open state changes, remembers per turn
 * whether the file list is open, and calls `onDidResize` after each repaint.
 */
export class ClaudeChangesBar extends Disposable {
	readonly element: HTMLElement;
	private readonly _content = this._register(new MutableDisposable<DisposableStore>());
	private readonly _expanded = new Set<string>();
	private _turnId: string | undefined;
	private _key: string | undefined;

	constructor(
		parent: HTMLElement,
		private readonly _controller: ClaudeReviewCardController,
		private readonly _options: ClaudeChangesCardOptions,
		private readonly _onDidResize: () => void,
	) {
		super();
		this.element = append(parent, $('.claude-changes-dock'));
		this.element.hidden = true;
	}

	/** The turn the bar shows, if any. */
	get turnId(): string | undefined {
		return this._turnId;
	}

	/** Shows the docked turn of `turnIds` (oldest first). Returns whether the docked turn changed. */
	update(turnIds: readonly string[]): boolean {
		const turnId = claudeDockedReviewTurn(turnIds, id => this._controller.get(id));
		const changed = turnId !== this._turnId;
		this._turnId = turnId;
		this.paint();
		return changed;
	}

	/** Forgets the open state of turns that are gone. */
	retainTurns(liveTurnIds: ReadonlySet<string>): void {
		for (const turnId of [...this._expanded]) {
			if (!liveTurnIds.has(turnId)) {
				this._expanded.delete(turnId);
			}
		}
	}

	private paint(focusToggle = false): void {
		const turnId = this._turnId;
		const review = turnId ? this._controller.get(turnId) : undefined;
		if (!turnId || !review) {
			if (this._key !== undefined) {
				this._key = undefined;
				this._content.clear();
				clearNode(this.element);
				this.element.hidden = true;
				this._onDidResize();
			}
			return;
		}
		const expanded = this._expanded.has(turnId);
		const wide = this._controller.wideScope?.(turnId);
		const key = `${turnId}\n${expanded}\n${review.autoKept === true}\n${wide ? `${wide.hunks}/${wide.files}/${wide.chats}` : ''}\n${review.files.map(file => reviewSignature(file)).join('\n')}`;
		if (key === this._key) {
			return;
		}
		this._key = key;
		const store = new DisposableStore();
		this._content.value = store;
		clearNode(this.element);
		this.element.hidden = false;
		const toggle = renderClaudeChangesBar(this.element, turnId, review, this._controller, store, {
			...this._options,
			expanded,
			toggle: () => {
				if (!this._expanded.delete(turnId)) {
					this._expanded.add(turnId);
				}
				this.paint(true);
			},
		});
		if (focusToggle) {
			toggle.focus();
		}
		this._onDidResize();
	}
}
