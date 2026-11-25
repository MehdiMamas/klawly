/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';
import { CLAUDE_REVIEW_CATEGORIES, CLAUDE_REVIEW_SEVERITIES } from '../../../../platform/claude/common/claudeReviewLoop.js';
import { ClaudeReviewSignalCounter } from '../../../../platform/claude/common/claudeReviewLearning.js';
import { CLAUDE_REVIEW_STAT_EVENT_KINDS, ClaudeReviewStatEvent } from '../../../../platform/claude/common/claudeReviewStats.js';
import { ClaudeFindingReply, ClaudeFindingThread } from '../../../../platform/claude/common/claudeReviewReply.js';
import { ReviewFile, ReviewHunk, TurnReview } from './claudeReview.js';

/** Disk form of a turn review. Reopening a session restores these hunk states. */
export function serializeReviews(reviews: readonly TurnReview[]): string {
	return JSON.stringify(reviews.map(review => ({
		sessionId: review.sessionId,
		turnId: review.turnId,
		cursor: review.cursor,
		...(review.autoKept ? { autoKept: true } : {}),
		files: review.files.map(file => ({
			uri: file.uri.toString(),
			name: file.name,
			directory: file.directory,
			isNew: file.isNew,
			originalText: file.originalText,
			added: file.added,
			removed: file.removed,
			state: file.state,
			hunks: file.hunks.map(hunk => ({
				id: hunk.id,
				uri: hunk.uri.toString(),
				originalStart: hunk.originalStart,
				originalLength: hunk.originalLength,
				modifiedStart: hunk.modifiedStart,
				modifiedLength: hunk.modifiedLength,
				originalText: hunk.originalText,
				modifiedText: hunk.modifiedText,
				state: hunk.state,
				currentRange: [hunk.currentRange.startLineNumber, hunk.currentRange.startColumn, hunk.currentRange.endLineNumber, hunk.currentRange.endColumn],
			})),
		})),
	})));
}

export function deserializeReviews(json: string): TurnReview[] {
	const parsed = JSON.parse(json) as unknown[];
	if (!Array.isArray(parsed)) {
		return [];
	}
	const reviews: TurnReview[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const record = item as { sessionId?: string; turnId?: string; cursor?: number; autoKept?: boolean; files?: unknown[] };
		if (!record.sessionId || !record.turnId || !Array.isArray(record.files)) {
			continue;
		}
		const files: ReviewFile[] = [];
		for (const file of record.files) {
			const restored = restoreFile(file);
			if (restored) {
				files.push(restored);
			}
		}
		reviews.push({ sessionId: record.sessionId, turnId: record.turnId, files, cursor: record.cursor ?? -1, ...(record.autoKept === true ? { autoKept: true } : {}) });
	}
	return reviews;
}

function restoreFile(value: unknown): ReviewFile | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const file = value as Partial<ReviewFile> & { uri?: string; hunks?: unknown[] };
	if (typeof file.uri !== 'string' || !Array.isArray(file.hunks)) {
		return undefined;
	}
	const hunks: ReviewHunk[] = [];
	for (const hunk of file.hunks) {
		const restored = restoreHunk(hunk);
		if (restored) {
			hunks.push(restored);
		}
	}
	return {
		uri: URI.parse(file.uri),
		name: String(file.name ?? ''),
		directory: String(file.directory ?? ''),
		isNew: file.isNew === true,
		originalText: String(file.originalText ?? ''),
		hunks,
		added: Number(file.added ?? 0),
		removed: Number(file.removed ?? 0),
		state: file.state ?? 'pending',
	};
}

function restoreHunk(value: unknown): ReviewHunk | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const hunk = value as Partial<ReviewHunk> & { uri?: string; currentRange?: number[] };
	if (typeof hunk.uri !== 'string' || typeof hunk.id !== 'string' || !Array.isArray(hunk.currentRange) || hunk.currentRange.length !== 4) {
		return undefined;
	}
	const [startLine, startColumn, endLine, endColumn] = hunk.currentRange;
	return {
		id: hunk.id,
		uri: URI.parse(hunk.uri),
		originalStart: Number(hunk.originalStart),
		originalLength: Number(hunk.originalLength),
		modifiedStart: Number(hunk.modifiedStart),
		modifiedLength: Number(hunk.modifiedLength),
		originalText: String(hunk.originalText ?? ''),
		modifiedText: String(hunk.modifiedText ?? ''),
		state: hunk.state ?? 'pending',
		currentRange: new Range(startLine, startColumn, endLine, endColumn),
	};
}

/** Disk form of the finding threads (replies and Mark as Intended) of a review (issue 929). Threads with nothing in them are not kept. */
export function serializeFindingThreads(threads: readonly ClaudeFindingThread[]): string {
	return JSON.stringify(threads
		.filter(thread => thread.replies.length > 0 || thread.intended)
		.map(thread => ({ findingId: thread.findingId, replies: thread.replies, ...(thread.intended ? { intended: true } : {}) })));
}

export function deserializeFindingThreads(json: string): ClaudeFindingThread[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	const threads: ClaudeFindingThread[] = [];
	for (const item of parsed) {
		const record = item as { findingId?: unknown; replies?: unknown; intended?: unknown } | null;
		if (!record || typeof record.findingId !== 'string' || !Array.isArray(record.replies)) {
			continue;
		}
		const replies: ClaudeFindingReply[] = [];
		for (const reply of record.replies as { role?: unknown; text?: unknown }[]) {
			if (reply && (reply.role === 'user' || reply.role === 'assistant') && typeof reply.text === 'string' && reply.text) {
				replies.push({ role: reply.role, text: reply.text });
			}
		}
		threads.push({ findingId: record.findingId, replies, ...(record.intended === true ? { intended: true } : {}) });
	}
	return threads;
}

/** Disk form of the dismissal counters that learned rules come from (issue 923). Counters of one dismissal are not kept. */
export function serializeReviewSignals(counters: readonly ClaudeReviewSignalCounter[]): string {
	return JSON.stringify(counters.filter(counter => counter.count > 0).map(counter => ({ repo: counter.repo, category: counter.category, title: counter.title, count: counter.count, sample: counter.sample })));
}

export function deserializeReviewSignals(json: string): ClaudeReviewSignalCounter[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	const counters: ClaudeReviewSignalCounter[] = [];
	for (const item of parsed) {
		const record = item as { repo?: unknown; category?: unknown; title?: unknown; count?: unknown; sample?: unknown } | null;
		const category = CLAUDE_REVIEW_CATEGORIES.find(candidate => candidate === record?.category);
		if (record && category && typeof record.repo === 'string' && typeof record.title === 'string' && typeof record.sample === 'string'
			&& typeof record.count === 'number' && Number.isInteger(record.count) && record.count > 0) {
			counters.push({ repo: record.repo, category, title: record.title, count: record.count, sample: record.sample });
		}
	}
	return counters;
}

/** Disk form of the review statistics log (issue 937). */
export function serializeReviewStats(events: readonly ClaudeReviewStatEvent[]): string {
	return JSON.stringify(events.map(event => [event.time, event.kind, event.severity, event.category, event.file]));
}

export function deserializeReviewStats(json: string): ClaudeReviewStatEvent[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	const events: ClaudeReviewStatEvent[] = [];
	for (const item of parsed) {
		if (!Array.isArray(item) || typeof item[0] !== 'number' || !Number.isFinite(item[0]) || typeof item[4] !== 'string') {
			continue;
		}
		const kind = CLAUDE_REVIEW_STAT_EVENT_KINDS.find(candidate => candidate === item[1]);
		const severity = CLAUDE_REVIEW_SEVERITIES.find(candidate => candidate === item[2]);
		const category = CLAUDE_REVIEW_CATEGORIES.find(candidate => candidate === item[3]);
		if (kind && severity && category) {
			events.push({ time: item[0], kind, severity, category, file: item[4] });
		}
	}
	return events;
}
