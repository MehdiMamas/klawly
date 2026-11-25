/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_REVIEW_CATEGORIES, CLAUDE_REVIEW_SEVERITIES, ClaudeReviewCategory, ClaudeReviewSeverity } from './claudeReviewLoop.js';

/** What happened to a finding (issue 937). `ignored`: a new review replaced it with no answer from the user. */
export type ClaudeReviewStatEventKind = 'raised' | 'fixed' | 'dismissed' | 'ignored';

export const CLAUDE_REVIEW_STAT_EVENT_KINDS: readonly ClaudeReviewStatEventKind[] = ['raised', 'fixed', 'dismissed', 'ignored'];

/** One finding status change. Kept on this machine only; never sent anywhere (rule 40). */
export interface ClaudeReviewStatEvent {
	/** Epoch milliseconds. */
	readonly time: number;
	readonly kind: ClaudeReviewStatEventKind;
	readonly severity: ClaudeReviewSeverity;
	readonly category: ClaudeReviewCategory;
	/** Workspace path of the file the finding names. */
	readonly file: string;
}

export type ClaudeReviewStatPeriod = '7d' | '30d' | '90d';

export const CLAUDE_REVIEW_STAT_PERIODS: readonly ClaudeReviewStatPeriod[] = ['7d', '30d', '90d'];

const DAY = 24 * 60 * 60 * 1000;

/** The workspace storage key the event log is kept under. */
export const CLAUDE_REVIEW_STATS_STORAGE_KEY = 'klawly.review.stats';

/** How long events are kept. */
export const CLAUDE_REVIEW_STATS_RETENTION_MS = 90 * DAY;

/** Upper bound on kept events, so the stored log stays small. */
export const CLAUDE_REVIEW_STATS_MAX_EVENTS = 2000;

export function claudeReviewStatPeriodDays(period: ClaudeReviewStatPeriod): number {
	return period === '7d' ? 7 : period === '30d' ? 30 : 90;
}

/** Drops events older than the retention and keeps the newest `CLAUDE_REVIEW_STATS_MAX_EVENTS`. */
export function trimClaudeReviewStats(events: readonly ClaudeReviewStatEvent[], now: number): readonly ClaudeReviewStatEvent[] {
	const kept = events.filter(event => event.time > now - CLAUDE_REVIEW_STATS_RETENTION_MS);
	return kept.length > CLAUDE_REVIEW_STATS_MAX_EVENTS ? kept.slice(kept.length - CLAUDE_REVIEW_STATS_MAX_EVENTS) : kept;
}

/** Appends events and trims. */
export function recordClaudeReviewStats(events: readonly ClaudeReviewStatEvent[], added: readonly ClaudeReviewStatEvent[], now: number): readonly ClaudeReviewStatEvent[] {
	return trimClaudeReviewStats([...events, ...added], now);
}

export interface ClaudeReviewStatCounts {
	readonly raised: number;
	readonly fixed: number;
	readonly dismissed: number;
	readonly ignored: number;
}

export interface ClaudeReviewStatsSummary {
	readonly total: ClaudeReviewStatCounts;
	/** Fixed or dismissed, as a share of raised findings from 0 to 1; 0 when nothing was raised. */
	readonly addressedRate: number;
	readonly bySeverity: readonly { readonly severity: ClaudeReviewSeverity; readonly counts: ClaudeReviewStatCounts }[];
	readonly byCategory: readonly { readonly category: ClaudeReviewCategory; readonly counts: ClaudeReviewStatCounts }[];
	/** Categories by dismissals, most first, only those dismissed at least once (they point at learned rules, issue 923). */
	readonly mostDismissed: readonly { readonly category: ClaudeReviewCategory; readonly dismissed: number }[];
	/** Files by raised findings, most first; at most 5. */
	readonly topFiles: readonly { readonly file: string; readonly raised: number }[];
}

type MutableCounts = { raised: number; fixed: number; dismissed: number; ignored: number };

function emptyCounts(): MutableCounts {
	return { raised: 0, fixed: 0, dismissed: 0, ignored: 0 };
}

function hasAny(counts: ClaudeReviewStatCounts): boolean {
	return counts.raised + counts.fixed + counts.dismissed + counts.ignored > 0;
}

/** Counts of the events inside `period` before `now`. Pure. */
export function summarizeClaudeReviewStats(events: readonly ClaudeReviewStatEvent[], period: ClaudeReviewStatPeriod, now: number): ClaudeReviewStatsSummary {
	const since = now - claudeReviewStatPeriodDays(period) * DAY;
	const total = emptyCounts();
	const severities = new Map(CLAUDE_REVIEW_SEVERITIES.map(severity => [severity, emptyCounts()]));
	const categories = new Map(CLAUDE_REVIEW_CATEGORIES.map(category => [category, emptyCounts()]));
	const files = new Map<string, number>();
	for (const event of events) {
		if (event.time <= since || event.time > now) {
			continue;
		}
		total[event.kind]++;
		const severity = severities.get(event.severity);
		if (severity) {
			severity[event.kind]++;
		}
		const category = categories.get(event.category);
		if (category) {
			category[event.kind]++;
		}
		if (event.kind === 'raised') {
			files.set(event.file, (files.get(event.file) ?? 0) + 1);
		}
	}
	return {
		total,
		addressedRate: total.raised === 0 ? 0 : Math.min(1, (total.fixed + total.dismissed) / total.raised),
		bySeverity: CLAUDE_REVIEW_SEVERITIES.map(severity => ({ severity, counts: severities.get(severity)! })).filter(item => hasAny(item.counts)),
		byCategory: CLAUDE_REVIEW_CATEGORIES.map(category => ({ category, counts: categories.get(category)! })).filter(item => hasAny(item.counts)),
		mostDismissed: CLAUDE_REVIEW_CATEGORIES
			.map(category => ({ category, dismissed: categories.get(category)!.dismissed }))
			.filter(item => item.dismissed > 0)
			.sort((a, b) => b.dismissed - a.dismissed),
		topFiles: [...files].map(([file, raised]) => ({ file, raised })).sort((a, b) => b.raised - a.raised || a.file.localeCompare(b.file)).slice(0, 5),
	};
}

function csvCell(value: string): string {
	// A cell starting with = + - @ would run as a formula in a spreadsheet.
	const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
	return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The events as CSV text with a header row; time is ISO 8601. */
export function claudeReviewStatsCsv(events: readonly ClaudeReviewStatEvent[]): string {
	const rows = events.map(event => [new Date(event.time).toISOString(), event.kind, event.severity, event.category, event.file].map(csvCell).join(','));
	return ['time,event,severity,category,file', ...rows].join('\n') + '\n';
}
