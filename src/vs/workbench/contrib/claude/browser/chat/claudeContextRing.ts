/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { ClaudeContextBreakdown, UsageInfo } from '../../../../../platform/claude/common/claudeProtocol.js';
import { claudeContextUsage, ClaudeContextUsage, showClaudeContextRing } from '../../common/claudeComposerState.js';
import { ClaudePopoverEntry } from '../widgets/claudePopoverMenu.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Above this share of the window the ring turns to the warning color. */
const HIGH_USAGE = 0.8;

/**
 * Small ring in the composer toolbar: how much of the context window the
 * session uses. It shows only numbers the runtime reported, and hides when
 * either the context size or the window is unknown, or while less than half
 * the window is used. Clicking it opens the context breakdown (issue 93).
 */
export class ClaudeContextRing extends Disposable {
	readonly element: HTMLButtonElement;
	private readonly _value: SVGCircleElement;
	private _label = '';
	private readonly _onDidClick = this._register(new Emitter<void>());
	/** Fires on a click, Enter or Space. */
	readonly onDidClick: Event<void> = this._onDidClick.event;

	constructor(
		container: HTMLElement,
		@IHoverService hoverService: IHoverService,
	) {
		super();
		this.element = append(container, $<HTMLButtonElement>('button.claude-context-ring'));
		this.element.type = 'button';
		this.element.setAttribute('aria-haspopup', 'menu');
		this.element.setAttribute('aria-expanded', 'false');
		this.element.hidden = true;
		this._register(addDisposableListener(this.element, EventType.CLICK, () => this._onDidClick.fire()));
		const doc = container.ownerDocument;
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('aria-hidden', 'true');
		const track = doc.createElementNS(SVG_NS, 'circle');
		track.setAttribute('class', 'track');
		this._value = doc.createElementNS(SVG_NS, 'circle');
		this._value.setAttribute('class', 'value');
		for (const circle of [track, this._value]) {
			circle.setAttribute('cx', '8');
			circle.setAttribute('cy', '8');
			circle.setAttribute('r', String(RADIUS));
			svg.appendChild(circle);
		}
		this._value.setAttribute('stroke-dasharray', String(CIRCUMFERENCE));
		this.element.appendChild(svg);
		this._register(hoverService.setupDelayedHover(this.element, () => ({
			content: this._label,
			additionalClasses: ['claude-root'],
		})));
	}

	update(usage: UsageInfo | undefined): void {
		const context = claudeContextUsage(usage);
		const shown = showClaudeContextRing(context);
		this.element.hidden = !shown;
		if (!shown) {
			this._label = '';
			this.element.removeAttribute('aria-label');
			return;
		}
		this._label = claudeContextLabel(context.used, context.window);
		this.element.setAttribute('aria-label', this._label);
		this.element.classList.toggle('is-high', context.fraction >= HIGH_USAGE);
		this._value.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE * (1 - context.fraction)));
	}
}

/** The ring's hover and the popover's header: share used, then the token counts. */
function claudeContextLabel(used: number, windowTokens: number): string {
	const percent = Math.round(Math.min(1, used / windowTokens) * 100);
	return localize('claudeContextRing', "Context: {0}% used ({1} of {2} tokens)", percent, used.toLocaleString(), windowTokens.toLocaleString());
}

/** What the context popover can do besides showing the numbers. */
export interface ClaudeContextActions {
	/** A turn is running: the commands wait until it ends. */
	readonly busy: boolean;
	readonly compact: () => void;
	readonly showFull: () => void;
}

/**
 * The popover the ring opens (issue 93): its numbers, what fills the window
 * when Claude Code reports a breakdown (as `/context` lists it), then Compact
 * Conversation (`/compact`) and Show Full Context (`/context`).
 */
export function claudeContextMenuEntries(usage: ClaudeContextUsage, breakdown: ClaudeContextBreakdown | undefined, actions: ClaudeContextActions): ClaudePopoverEntry[] {
	const windowTokens = breakdown?.windowTokens ?? usage.window;
	const entries: ClaudePopoverEntry[] = [{ kind: 'header', label: claudeContextLabel(breakdown?.usedTokens ?? usage.used, windowTokens) }];
	for (const category of breakdown?.categories ?? []) {
		entries.push({
			id: `claude.context.${category.kind}.${category.name}`,
			label: category.name,
			detail: localize('claudeContextCategory', "{0} tokens ({1}%)", category.tokens.toLocaleString(), (Math.round(category.tokens / windowTokens * 1000) / 10).toLocaleString()),
			className: `claude-context-category is-${category.kind}`,
			disabled: true,
		});
	}
	if (breakdown?.categories.length) {
		entries.push({ kind: 'separator' });
	}
	entries.push(
		{ id: 'claude.context.compact', label: localize('claudeContextCompact', "Compact Conversation"), hint: '/compact', disabled: actions.busy, run: actions.compact },
		{ id: 'claude.context.show', label: localize('claudeContextShowFull', "Show Full Context"), hint: '/context', disabled: actions.busy, run: actions.showFull },
	);
	return entries;
}
