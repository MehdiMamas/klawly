/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../base/browser/dom.js';
import { IntervalTimer } from '../../../../../base/common/async.js';
import { fromNow } from '../../../../../base/common/date.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { ClaudeUsageWindow } from '../../../../../platform/claude/common/claudeAccount.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { claudeUsageRowParts, ClaudeUsageRowPart, watchClaudePlanUsage } from '../../common/claudeUsageRow.js';
import { CLAUDE_OPEN_SETTINGS_COMMAND_ID } from '../../common/claudeViews.js';

/** How often the reset times are written again, so "in 2 hrs" does not go stale. */
const RESET_REFRESH_MS = 60_000;

/**
 * A slim row under the composer with the plan limits, such as "Session 42% ·
 * resets in 2 hrs | Week 18%". The numbers come from the runtime: what it last
 * reported when the row is built, then every `session.usageLimits` event, and
 * again when the window gets focus back (issue 704). The row hides while
 * nothing is known and for sign-ins without plan limits.
 * Clicking it opens Settings on Plan & Usage. The numbers arrive after the
 * row is built, so `onDidChangeHeight` runs after each render that shows or
 * hides it, and the host lays its timeline out again (issue 332).
 */
export class ClaudeUsageIndicator extends Disposable {
	readonly element: HTMLButtonElement;
	private _windows: readonly ClaudeUsageWindow[] | undefined;
	private _account: string | undefined;

	constructor(
		container: HTMLElement,
		private readonly _onDidChangeHeight: () => void,
		@IClaudeRuntimeService runtime: IClaudeRuntimeService,
		@ICommandService commandService: ICommandService,
		@IHostService hostService: IHostService,
	) {
		super();
		this.element = append(container, $<HTMLButtonElement>('button.claude-usage-row'));
		this.element.type = 'button';
		this.element.hidden = true;
		this._register(addDisposableListener(this.element, EventType.CLICK, () => void commandService.executeCommand(CLAUDE_OPEN_SETTINGS_COMMAND_ID, 'plan')));
		this._register(watchClaudePlanUsage(runtime, (windows, _checkedAt, account) => this.update(windows, account), hostService));
		const timer = this._register(new IntervalTimer());
		timer.cancelAndSet(() => this.render(), RESET_REFRESH_MS);
	}

	/** Shows these plan windows; none, or an empty list, hides the row. */
	update(windows: readonly ClaudeUsageWindow[] | undefined, account?: string): void {
		this._windows = windows;
		this._account = account;
		this.render();
	}

	private render(): void {
		this.element.title = this._account ? localize('claudeUsageRowAccount', "Plan usage of {0}", this._account) : '';
		const parts = claudeUsageRowParts(this._windows, Date.now());
		const wasHidden = this.element.hidden;
		this.element.hidden = parts.length === 0;
		clearNode(this.element);
		for (const part of parts) {
			const item = append(this.element, $('span.part'));
			item.dataset.kind = part.kind;
			item.classList.toggle('is-high', part.level === 'high');
			item.classList.toggle('is-full', part.level === 'full');
			append(item, $('span.name')).textContent = part.name;
			append(item, $('span.value')).textContent = localize('claudeUsageRowPercent', "{0}%", part.percent);
			if (part.resetsAt !== undefined) {
				append(item, $('span.reset')).textContent = localize('claudeUsageRowResets', "resets {0}", fromNow(part.resetsAt, true));
			}
		}
		this.element.setAttribute('aria-label', parts.length > 0
			? localize('claudeUsageRowAria', "Plan usage: {0}. Open Plan & Usage settings", parts.map(describe).join(', '))
			: '');
		if (!wasHidden || !this.element.hidden) {
			this._onDidChangeHeight();
		}
	}
}

function describe(part: ClaudeUsageRowPart): string {
	return part.resetsAt !== undefined
		? localize('claudeUsageRowAriaPartReset', "{0} {1}% used, resets {2}", part.name, part.percent, fromNow(part.resetsAt, true))
		: localize('claudeUsageRowAriaPart', "{0} {1}% used", part.name, part.percent);
}
