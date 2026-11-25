/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { ScrollbarVisibility } from '../../../../../base/common/scrollable.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { timeout } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeTimelineScroll } from '../../browser/chat/claudeTimelineScroll.js';

/** The last observer made; the test fires its callback as the browser would after a layout. */
let fakeObserver: FakeResizeObserver | undefined;

class FakeResizeObserver implements ResizeObserver {
	readonly targets = new Set<Element>();
	constructor(private readonly _callback: ResizeObserverCallback) {
		fakeObserver = this;
	}
	observe(target: Element): void {
		this.targets.add(target);
	}
	unobserve(target: Element): void {
		this.targets.delete(target);
	}
	disconnect(): void {
		this.targets.clear();
	}
	fire(): void {
		this._callback([], this);
	}
}

suite('Claude timeline scroll (issue 318)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let host: HTMLElement;

	setup(() => {
		host = append(mainWindow.document.body, $('div'));
	});

	teardown(() => {
		host.remove();
		fakeObserver = undefined;
	});

	test('content that grows after a paint stays reachable, and the end stays in view only for a reader at the end', async () => {
		const timeline = $('.claude-timeline');
		timeline.style.height = '100px';
		const scrollable = store.add(new DomScrollableElement(timeline, { vertical: ScrollbarVisibility.Auto, horizontal: ScrollbarVisibility.Hidden }));
		const scrollNode = scrollable.getDomNode();
		scrollNode.style.height = '100px';
		host.appendChild(scrollNode);
		const turn = append(timeline, $('div'));
		turn.style.height = '300px';
		const follow = store.add(new ClaudeTimelineScroll(timeline, scrollable, mainWindow, FakeResizeObserver));
		const observer = fakeObserver!;
		const snapshot = () => ({ scrollHeight: scrollable.getScrollDimensions().scrollHeight, scrollTop: scrollable.getScrollPosition().scrollTop, atBottom: follow.isAtBottom() });
		const log: Record<string, unknown> = {};

		follow.update(true);
		log.painted = snapshot();
		// A card under the last paint grows, say a plan that finished rendering.
		turn.style.height = '500px';
		observer.fire();
		log.grewAtEnd = snapshot();
		scrollable.setScrollPosition({ scrollTop: 0 });
		turn.style.height = '700px';
		observer.fire();
		log.grewReadingAbove = snapshot();
		// A hidden pane measures zero and keeps the reader's place.
		host.style.display = 'none';
		observer.fire();
		host.style.display = '';
		log.hidden = snapshot();
		const next = append(timeline, $('div'));
		await timeout(0);
		log.watchesNewTurn = observer.targets.has(next);
		next.remove();
		await timeout(0);
		log.forgetsRemovedTurn = !observer.targets.has(next);

		assert.deepStrictEqual(log, {
			painted: { scrollHeight: 300, scrollTop: 200, atBottom: true },
			grewAtEnd: { scrollHeight: 500, scrollTop: 400, atBottom: true },
			grewReadingAbove: { scrollHeight: 700, scrollTop: 0, atBottom: false },
			hidden: { scrollHeight: 700, scrollTop: 0, atBottom: false },
			watchesNewTurn: true,
			forgetsRemovedTurn: true,
		});
	});

	test('a stray native scroll offset never outlives the scroll event: the timeline stays at the scrollable position (issue 470)', async () => {
		const timeline = $('.claude-timeline');
		timeline.style.height = '100px';
		const scrollable = store.add(new DomScrollableElement(timeline, { vertical: ScrollbarVisibility.Auto, horizontal: ScrollbarVisibility.Hidden }));
		const scrollNode = scrollable.getDomNode();
		scrollNode.style.height = '100px';
		host.appendChild(scrollNode);
		const turn = append(timeline, $('div'));
		turn.style.height = '300px';
		store.add(new ClaudeTimelineScroll(timeline, scrollable, mainWindow, FakeResizeObserver));
		scrollable.setScrollPosition({ scrollTop: 0 });
		// A focus or scroll-into-view moves the native offset behind the scrollable's back.
		timeline.scrollTop = 13;
		await timeout(50);

		assert.deepStrictEqual({ native: timeline.scrollTop, scrollable: scrollable.getScrollPosition().scrollTop }, { native: 0, scrollable: 0 });
	});

	test('a hidden pane keeps the reader\'s place through a paint or a layout', () => {
		const timeline = $('.claude-timeline');
		timeline.style.height = '100px';
		const scrollable = store.add(new DomScrollableElement(timeline, { vertical: ScrollbarVisibility.Auto, horizontal: ScrollbarVisibility.Hidden }));
		const scrollNode = scrollable.getDomNode();
		scrollNode.style.height = '100px';
		host.appendChild(scrollNode);
		append(timeline, $('div')).style.height = '700px';
		const follow = store.add(new ClaudeTimelineScroll(timeline, scrollable, mainWindow, FakeResizeObserver));
		follow.update(false);
		scrollable.setScrollPosition({ scrollTop: 100 });

		// The plan usage row re-renders every minute and lays the hidden pane out again.
		host.style.display = 'none';
		follow.update(follow.isAtBottom());
		host.style.display = '';
		// Showing the pane again resizes its content.
		fakeObserver!.fire();

		assert.deepStrictEqual({ scrollHeight: scrollable.getScrollDimensions().scrollHeight, scrollTop: scrollable.getScrollPosition().scrollTop, atBottom: follow.isAtBottom() }, { scrollHeight: 700, scrollTop: 100, atBottom: false });
	});

	/** A 100 px timeline over 700 px of turns, scanned once at the top. */
	function longTimeline(): { timeline: HTMLElement; scrollable: DomScrollableElement; follow: ClaudeTimelineScroll; turn: HTMLElement } {
		const timeline = $('.claude-timeline');
		timeline.style.height = '100px';
		const scrollable = store.add(new DomScrollableElement(timeline, { vertical: ScrollbarVisibility.Auto, horizontal: ScrollbarVisibility.Hidden }));
		const scrollNode = scrollable.getDomNode();
		scrollNode.style.height = '100px';
		host.appendChild(scrollNode);
		const turn = append(timeline, $('div'));
		turn.style.height = '700px';
		const follow = store.add(new ClaudeTimelineScroll(timeline, scrollable, mainWindow, FakeResizeObserver));
		follow.update(false);
		return { timeline, scrollable, follow, turn };
	}

	test('a pane shown again puts the reader back where they were, or at the end they followed (issue 402)', () => {
		const { timeline, scrollable, follow, turn } = longTimeline();
		const observer = fakeObserver!;
		const scrollNode = scrollable.getDomNode();
		const snapshot = () => ({ scrollTop: scrollable.getScrollPosition().scrollTop, atBottom: follow.isAtBottom() });
		// The browser forgets the scroll offset of a node that left the page.
		const hideAndShow = (whileHidden?: () => void) => {
			scrollNode.remove();
			observer.fire();
			whileHidden?.();
			host.appendChild(scrollNode);
			timeline.scrollTop = 0;
			observer.fire();
		};
		const log: Record<string, unknown> = {};

		scrollable.setScrollPosition({ scrollTop: 300 });
		hideAndShow();
		log.reading = snapshot();
		follow.update(true);
		hideAndShow(() => {
			// A turn streams in while the pane is hidden.
			turn.style.height = '900px';
			follow.update(follow.isAtBottom());
		});
		log.following = snapshot();
		// Hidden and shown in one frame: no resize, the host tells the timeline as it hides.
		scrollable.setScrollPosition({ scrollTop: 300 });
		follow.hold();
		scrollNode.remove();
		host.appendChild(scrollNode);
		timeline.scrollTop = 0;
		follow.update(follow.isAtBottom());
		log.oneFrame = snapshot();

		assert.deepStrictEqual(log, {
			reading: { scrollTop: 300, atBottom: false },
			following: { scrollTop: 800, atBottom: true },
			oneFrame: { scrollTop: 300, atBottom: false },
		});
	});

	test('a new timeline for the same session opens at the place the last one kept (issue 402)', () => {
		const first = longTimeline();
		first.scrollable.setScrollPosition({ scrollTop: 300 });
		const place = first.follow.place();
		first.scrollable.getDomNode().remove();

		const second = longTimeline();
		second.follow.restore(place);
		// The new chat paints at the end, as a chat with no saved place would.
		second.follow.update(true);

		assert.deepStrictEqual({ place, scrollTop: second.scrollable.getScrollPosition().scrollTop, atBottom: second.follow.isAtBottom() }, { place: { scrollTop: 300, atBottom: false }, scrollTop: 300, atBottom: false });
	});

	test('a place restored before late content renders waits for it, unless the reader scrolls first; the place is told only while shown (issue 402)', () => {
		const { scrollable, follow, turn } = longTimeline();
		const observer = fakeObserver!;
		const scrollNode = scrollable.getDomNode();
		const told: number[] = [];
		store.add(follow.onDidChangePlace(place => told.push(place.scrollTop)));
		const snapshot = () => ({ scrollTop: scrollable.getScrollPosition().scrollTop, atBottom: follow.isAtBottom() });
		const log: Record<string, unknown> = {};

		// A new chat paints its turns before a plan card or an image renders.
		turn.style.height = '200px';
		follow.restore({ scrollTop: 500, atBottom: false });
		follow.update(true);
		log.early = snapshot();
		turn.style.height = '700px';
		observer.fire();
		log.late = snapshot();
		turn.style.height = '200px';
		follow.restore({ scrollTop: 300, atBottom: false });
		follow.update(true);
		scrollable.setScrollPosition({ scrollTop: 40 });
		turn.style.height = '700px';
		observer.fire();
		log.readerScrolled = snapshot();
		told.length = 0;
		scrollNode.remove();
		scrollable.setScrollPosition({ scrollTop: 10 });
		host.appendChild(scrollNode);
		log.toldWhileHidden = told.length;

		assert.deepStrictEqual(log, {
			early: { scrollTop: 100, atBottom: true },
			late: { scrollTop: 500, atBottom: false },
			readerScrolled: { scrollTop: 40, atBottom: false },
			toldWhileHidden: 0,
		});
	});

	test('a restored place out of reach of the content waits a moment for late content, then the pane follows new output to the end', () => {
		const timeline = $('.claude-timeline');
		timeline.style.height = '100px';
		const scrollable = store.add(new DomScrollableElement(timeline, { vertical: ScrollbarVisibility.Auto, horizontal: ScrollbarVisibility.Hidden }));
		const scrollNode = scrollable.getDomNode();
		scrollNode.style.height = '100px';
		host.appendChild(scrollNode);
		const turn = append(timeline, $('div'));
		turn.style.height = '200px';
		let now = 0;
		const follow = store.add(new ClaudeTimelineScroll(timeline, scrollable, mainWindow, FakeResizeObserver, () => now));
		const observer = fakeObserver!;
		const told: unknown[] = [];
		store.add(follow.onDidChangePlace(place => told.push(place)));
		const snapshot = () => ({ scrollTop: scrollable.getScrollPosition().scrollTop, atBottom: follow.isAtBottom() });
		const log: Record<string, unknown> = {};

		// A wider chat wraps the same turns shorter than the place kept in a narrower one.
		follow.restore({ scrollTop: 500, atBottom: false });
		follow.update(follow.isAtBottom());
		log.restored = snapshot();
		now = 900;
		turn.style.height = '400px';
		observer.fire();
		log.lateContent = { ...snapshot(), place: follow.place() };
		// The reader sends a prompt, and its output streams in.
		now = 1000;
		turn.style.height = '500px';
		observer.fire();
		log.newOutput = snapshot();
		turn.style.height = '900px';
		observer.fire();
		log.pastThePlace = snapshot();
		log.toldLast = told.at(-1);

		assert.deepStrictEqual(log, {
			restored: { scrollTop: 100, atBottom: true },
			lateContent: { scrollTop: 300, atBottom: true, place: { scrollTop: 500, atBottom: false } },
			newOutput: { scrollTop: 400, atBottom: true },
			pastThePlace: { scrollTop: 800, atBottom: true },
			toldLast: { scrollTop: 800, atBottom: true },
		});
	});

	test('late content that reaches a restored place within the wait still shows it (issue 402)', () => {
		const { scrollable, follow, turn } = longTimeline();
		const observer = fakeObserver!;
		turn.style.height = '200px';
		follow.restore({ scrollTop: 500, atBottom: false });
		follow.update(true);
		turn.style.height = '400px';
		observer.fire();
		turn.style.height = '700px';
		observer.fire();

		assert.deepStrictEqual({ scrollTop: scrollable.getScrollPosition().scrollTop, atBottom: follow.isAtBottom() }, { scrollTop: 500, atBottom: false });
	});

	test('a child added after dispose is not observed (issue 1526)', async () => {
		const timeline = $('.claude-timeline');
		const scrollable = store.add(new DomScrollableElement(timeline, { vertical: ScrollbarVisibility.Auto, horizontal: ScrollbarVisibility.Hidden }));
		host.appendChild(scrollable.getDomNode());
		const follow = new ClaudeTimelineScroll(timeline, scrollable, mainWindow, FakeResizeObserver);
		const observer = fakeObserver!;
		follow.dispose();
		append(timeline, $('div'));
		await timeout(0);
		assert.strictEqual(observer.targets.size, 0);
	});
});
