/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../../base/common/async.js';
import { fromNow } from '../../../../base/common/date.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { ClaudeUsageRefresh, ClaudeUsageWindow } from '../../../../platform/claude/common/claudeAccount.js';

/** How close a plan window is to its limit, with the thresholds of the Settings meters. */
export type ClaudeUsageLevel = 'normal' | 'high' | 'full';

/** One window the usage row under the composer shows. */
export interface ClaudeUsageRowPart {
	readonly kind: ClaudeUsageWindow['kind'];
	/** The short name the row shows, such as "Session" or "Week". */
	readonly name: string;
	/** Rounded percentage used, 0 to 100. */
	readonly percent: number;
	readonly level: ClaudeUsageLevel;
	/** When the window resets, in epoch milliseconds, if the row should say so. */
	readonly resetsAt?: number;
}

/** At or above this rounded percentage a window is high, as on the Settings meters. */
const HIGH_PERCENT = 80;

/** The usage level of a rounded percentage. */
export function claudeUsageLevel(percent: number): ClaudeUsageLevel {
	return percent >= 100 ? 'full' : percent >= HIGH_PERCENT ? 'high' : 'normal';
}

function shortName(window: ClaudeUsageWindow): string {
	switch (window.kind) {
		case 'session': return localize('claudeUsageRowSession', "Session");
		case 'week': return localize('claudeUsageRowWeek', "Week");
		case 'weekOpus': return localize('claudeUsageRowWeekOpus', "Opus Week");
		case 'weekSonnet': return localize('claudeUsageRowWeekSonnet', "Sonnet Week");
		case 'model': return window.label ?? localize('claudeUsageRowModel', "Model Week");
	}
}

/**
 * What the usage row under the composer shows: the five-hour session and the
 * weekly window, or the first two windows when the plan reports neither. The
 * session window says when it resets; another window says so only once it is
 * full. Unknown or no plan limits (an API key, a cloud provider) give an empty
 * list, and the row hides.
 */
export function claudeUsageRowParts(windows: readonly ClaudeUsageWindow[] | undefined, now: number): readonly ClaudeUsageRowPart[] {
	if (!windows || windows.length === 0) {
		return [];
	}
	const main = windows.filter(window => window.kind === 'session' || window.kind === 'week');
	return (main.length > 0 ? main : windows).slice(0, 2).map(window => {
		const percent = Math.round(Math.min(100, Math.max(0, window.percent)));
		const level = claudeUsageLevel(percent);
		const showReset = window.resetsAt !== undefined && window.resetsAt > now && (window.kind === 'session' || level === 'full');
		return { kind: window.kind, name: shortName(window), percent, level, resetsAt: showReset ? window.resetsAt : undefined };
	});
}

/** What Plan & Usage says about the limits (issue 942): numbers, a wait, a failure, or truly none. */
export type ClaudeUsageState = 'windows' | 'loading' | 'failed' | 'none' | 'unknown';

/**
 * "None" is only for an answer Claude Code gave: an empty list, as an API key or
 * cloud provider has. No answer yet is loading while an ask runs and unknown
 * after; a failed ask is failed, so neither ever reads as "no usage limits".
 */
export function claudeUsageState(overview: { readonly usage?: readonly ClaudeUsageWindow[]; readonly usageFailed?: boolean } | undefined, loading: boolean): ClaudeUsageState {
	if (overview?.usage && overview.usage.length > 0) {
		return 'windows';
	}
	if (loading) {
		return 'loading';
	}
	if (overview?.usageFailed) {
		return 'failed';
	}
	return overview?.usage ? 'none' : 'unknown';
}

/**
 * How old the plan limits on show are, such as "Updated 3 mins ago", for the
 * Plan & Usage page (issue 704). Under a minute reads "Updated just now".
 */
export function claudeUsageUpdatedLabel(checkedAt: number, now: number): string {
	return now - checkedAt < 60_000
		? localize('claudeUsageUpdatedNow', "Updated just now")
		: localize('claudeUsageUpdated', "Updated {0}", fromNow(checkedAt, true));
}

/** A window's focus, as the host service has it. */
export interface ClaudeUsageFocus {
	readonly hasFocus: boolean;
	readonly onDidChangeFocus: Event<boolean>;
}

/**
 * How often a focused window asks for the plan limits again while nothing else
 * does (issue 704). With no agent running each ask starts a short Claude Code
 * query, so this stays slow; the Plan & Usage page asks more often while it shows.
 */
export const CLAUDE_USAGE_POLL_MS = 5 * 60_000;

/**
 * Calls `onWindows` with the plan windows Claude Code reports and when it
 * reported them: the account overview's first, then each `session.usageLimits`
 * event (a session reports after each turn). With `focus`, it asks again when
 * the window gets focus back and every {@link CLAUDE_USAGE_POLL_MS} while it has
 * focus, so the numbers do not go stale while no agent runs (issue 704). The
 * runtime answers from what it read in the last minute, so several watchers
 * make one call. An answer older than one already shown is dropped. The third
 * argument names the account the limits belong to, its email when Claude Code
 * reported one (issue 1270).
 */
export function watchClaudePlanUsage(runtime: IClaudeRuntimeService, onWindows: (windows: readonly ClaudeUsageWindow[] | undefined, checkedAt: number | undefined, account?: string) => void, focus?: ClaudeUsageFocus): IDisposable {
	const store = new DisposableStore();
	let shown = false;
	let shownAt: number | undefined;
	let account: string | undefined;
	// A usage event is always the newest; only an overview answer can be older than what shows.
	const show = (windows: readonly ClaudeUsageWindow[] | undefined, checkedAt: number | undefined, live = false) => {
		if (store.isDisposed || (!live && shown && (checkedAt === undefined || (shownAt !== undefined && checkedAt <= shownAt)))) {
			return;
		}
		shown = true;
		shownAt = checkedAt;
		onWindows(windows, checkedAt, account);
	};
	// A new sign-in or account drops answers still on the way for the old one (issue 942).
	let generation = 0;
	const ask = (refresh: ClaudeUsageRefresh | undefined) => {
		const asked = generation;
		void runtime.getAccountOverview?.(refresh).then(overview => {
			if (asked === generation) {
				account = overview.account?.email;
				show(overview.usage, overview.usageCheckedAt);
			}
		}, () => undefined);
	};
	// Issue 942: a sign-in, log out or account switch clears the old account's limits at once and asks for the new one's.
	store.add(runtime.onDidChangeRuntimeState(() => {
		generation++;
		shown = false;
		shownAt = undefined;
		account = undefined;
		onWindows(undefined, undefined);
		ask('now');
	}));
	store.add(runtime.onDidEmitEvent(event => {
		if (event.type === 'session.usageLimits') {
			show(event.windows, Date.now(), true);
		}
	}));
	ask(undefined);
	if (focus) {
		const timer = store.add(new IntervalTimer());
		timer.cancelAndSet(() => {
			if (focus.hasFocus) {
				ask('stale');
			}
		}, CLAUDE_USAGE_POLL_MS);
		store.add(focus.onDidChangeFocus(focused => {
			if (focused) {
				ask('stale');
			}
		}));
	}
	return store;
}
