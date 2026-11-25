/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, DisposableResizeObserver, isHTMLElement } from '../../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { CodeWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../../base/common/lifecycle.js';

/** How close to the end, in pixels, still counts as reading the end of the chat. */
const FOLLOW_SLACK = 48;

/**
 * How long, in milliseconds from the first scan that can't reach it, a middle place waits for
 * late content (plan cards, images). Content that comes after that is new output, not the
 * history the place was kept in.
 */
const LATE_CONTENT_WAIT = 1000;

/** Where the reader is in the timeline: at the end, or at a scroll offset (issue 402). */
export interface IClaudeTimelinePlace {
	readonly scrollTop: number;
	readonly atBottom: boolean;
}

/**
 * Keeps the timeline's scroll dimensions true to its content (issue 318). The scrollbar only
 * knows the content's height from its last scan, so content that grows on its own (markdown
 * and plan cards that finish rendering, cards that expand or fold, images that load) left the
 * end of the chat out of reach. Every child of the timeline is watched; a change of size
 * rescans, and keeps the end in view when the reader was at the end.
 */
export class ClaudeTimelineScroll extends Disposable {

	private readonly _observed = this._register(new DisposableMap<Node>());
	private readonly _resizes: DisposableResizeObserver;
	/**
	 * The place to put back at the next scan of a shown pane. A middle offset stays until the
	 * content is tall enough to show it, the reader scrolls, or it waited `LATE_CONTENT_WAIT`:
	 * late content (plan cards, images) would otherwise clamp it to the end, which the pane then
	 * follows.
	 */
	private _pending: IClaudeTimelinePlace | undefined;
	/** When a scan of the shown pane first found the pending middle place out of reach. */
	private _waitingSince: number | undefined;
	/** True while this class moves the scroll position itself. */
	private _moving = false;
	private readonly _onDidChangePlace = this._register(new Emitter<IClaudeTimelinePlace>());
	/** The reader's place changed in a shown pane: they scrolled, or the content moved the end. */
	readonly onDidChangePlace: Event<IClaudeTimelinePlace> = this._onDidChangePlace.event;

	constructor(
		private readonly _content: HTMLElement,
		private readonly _scrollable: DomScrollableElement,
		targetWindow: CodeWindow,
		resizeObserverCtor?: typeof ResizeObserver,
		private readonly _now: () => number = Date.now,
	) {
		super();
		this._resizes = this._register(new DisposableResizeObserver('claudeTimelineScroll', () => this.onContentResized(), targetWindow, { resizeObserverCtor }));
		for (const child of _content.children) {
			this.observe(child);
		}
		const mutations = new targetWindow.MutationObserver(records => {
			if (this._store.isDisposed) {
				return;
			}
			for (const record of records) {
				record.removedNodes.forEach(node => this._observed.deleteAndDispose(node));
				record.addedNodes.forEach(node => {
					if (isHTMLElement(node) && node.parentElement === this._content) {
						this.observe(node);
					}
				});
			}
		});
		mutations.observe(_content, { childList: true });
		this._register(toDisposable(() => mutations.disconnect()));
		// Focus or scroll-into-view can move the native offset of the content, which is `overflow: hidden`
		// and owned by the scrollable. Fold it into the scrollable position so the two never disagree and
		// the pinned prompt stays flush with the top (issue 470).
		this._register(addDisposableListener(_content, 'scroll', () => {
			if (!this._moving && _content.scrollTop !== Math.round(this._scrollable.getScrollPosition().scrollTop)) {
				this._scrollable.setScrollPosition({ scrollTop: _content.scrollTop });
				_content.scrollTop = this._scrollable.getScrollPosition().scrollTop;
			}
		}));
		this._register(_scrollable.onScroll(() => {
			if (!this.isShown()) {
				return;
			}
			if (!this._moving) {
				// The reader scrolled: a place still waiting for its content is theirs no more.
				this.setPending(undefined);
			}
			this._onDidChangePlace.fire(this.place());
		}));
	}

	/** Whether the end of the content is in view, by the dimensions of the last scan. */
	isAtBottom(): boolean {
		const position = this._scrollable.getScrollPosition();
		const dimensions = this._scrollable.getScrollDimensions();
		return dimensions.scrollHeight - position.scrollTop - dimensions.height < FOLLOW_SLACK;
	}

	/** Where the reader is, or was when the pane was last shown. */
	place(): IClaudeTimelinePlace {
		return this._pending ?? { scrollTop: this._scrollable.getScrollPosition().scrollTop, atBottom: this.isAtBottom() };
	}

	/**
	 * Keeps the reader's place for the next scan of the shown pane. The host calls it as the pane
	 * hides, while the content still measures: a hide and a show in one frame resize nothing.
	 */
	hold(): void {
		this.setPending(this.place());
	}

	/**
	 * Puts the reader at `place` at the next scan of the shown pane: a chat tab back from the
	 * background or a moved view builds a new timeline for the same session (issue 402).
	 */
	restore(place: IClaudeTimelinePlace | undefined): void {
		this.setPending(place);
	}

	/**
	 * Rescans the content and, when `follow`, scrolls to its end. A hidden pane measures zero, and
	 * scanning it would throw away the reader's place, so the paint, layout and resize paths all
	 * keep the last scan until the pane shows again. The browser drops the scroll offset of a
	 * detached node, so the first scan after the pane shows again puts the reader back where
	 * they were: at the end when they followed it, else at the same offset (issue 402). A middle
	 * offset the content can't reach yet waits for late content, but not for new output: once it
	 * waited `LATE_CONTENT_WAIT`, the scan goes by `follow` as if no place was kept.
	 */
	update(follow: boolean): void {
		if (!this.isShown()) {
			this._pending = this.place();
			return;
		}
		this._moving = true;
		try {
			this._scrollable.scanDomNode();
			const dimensions = this._scrollable.getScrollDimensions();
			let pending = this._pending;
			if (pending && !pending.atBottom && dimensions.scrollHeight < pending.scrollTop + dimensions.height) {
				this._waitingSince ??= this._now();
				if (this._now() - this._waitingSince >= LATE_CONTENT_WAIT) {
					pending = undefined;
					this.setPending(undefined);
				}
			}
			if (pending ? pending.atBottom : follow) {
				this.setPending(undefined);
				this._scrollable.setScrollPosition({ scrollTop: dimensions.scrollHeight });
			} else if (pending) {
				if (dimensions.scrollHeight >= pending.scrollTop + dimensions.height) {
					this.setPending(undefined);
				}
				this._scrollable.setScrollPosition({ scrollTop: pending.scrollTop });
			}
		} finally {
			this._moving = false;
		}
	}

	/** Sets the place to put back, which waits afresh for content to reach it. */
	private setPending(place: IClaudeTimelinePlace | undefined): void {
		this._pending = place;
		this._waitingSince = undefined;
	}

	/** A hidden pane measures zero, and a detached one has no layout. */
	private isShown(): boolean {
		return this._content.isConnected && this._scrollable.getDomNode().clientHeight !== 0;
	}

	private observe(child: Element): void {
		// A late mutation record must not register a resize observation nobody will dispose.
		if (!this._store.isDisposed && !this._observed.has(child)) {
			this._observed.set(child, this._resizes.observe(child));
		}
	}

	private onContentResized(): void {
		this.update(this.isAtBottom());
	}
}
