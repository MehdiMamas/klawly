/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeReviewFinding, normalizeClaudeFindingPath, readClaudeReviewFindings } from './claudeReviewLoop.js';

/**
 * Reviews that remember what they covered (issue 927). A review keeps the commit it
 * reviewed up to; the next one looks only at what changed since, carries the open
 * findings forward and marks those a later commit touched as addressed.
 */

/** Open: still to look at. Addressed: a later commit changed its lines. Dismissed: the person hid it. */
export type ClaudePersistedFindingStatus = 'open' | 'addressed' | 'dismissed';

export interface ClaudePersistedFinding {
	readonly finding: ClaudeReviewFinding;
	readonly status: ClaudePersistedFindingStatus;
}

/** One review as it is stored: the commit it covered and every finding it has had. */
export interface ClaudePersistedReview {
	readonly reviewedSha: string;
	readonly findings: readonly ClaudePersistedFinding[];
}

/** The stored format; a record of another version is read as no review. */
const PERSISTED_REVIEW_VERSION = 1;

/** Stored text of a review. */
export function serializeClaudePersistedReview(review: ClaudePersistedReview): string {
	return JSON.stringify({ version: PERSISTED_REVIEW_VERSION, reviewedSha: review.reviewedSha, findings: review.findings });
}

/** Reads a stored review; anything malformed, or of another version, is no review. Pure. */
export function parseClaudePersistedReview(raw: string | undefined): ClaudePersistedReview | undefined {
	if (!raw) {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as { version?: unknown; reviewedSha?: unknown; findings?: unknown };
	if (record.version !== PERSISTED_REVIEW_VERSION || typeof record.reviewedSha !== 'string' || !/^[0-9a-f]{7,64}$/.test(record.reviewedSha) || !Array.isArray(record.findings)) {
		return undefined;
	}
	const findings: ClaudePersistedFinding[] = [];
	for (const item of record.findings) {
		const status = item && typeof item === 'object' ? (item as { status?: unknown }).status : undefined;
		const finding = readClaudeReviewFindings({ findings: [item && typeof item === 'object' ? (item as { finding?: unknown }).finding : undefined] })?.[0];
		if (finding && (status === 'open' || status === 'addressed' || status === 'dismissed')) {
			findings.push({ finding, status });
		}
	}
	return { reviewedSha: record.reviewedSha, findings };
}

/** One hunk of a unified diff, in old-file lines. */
interface ClaudeDiffHunk {
	readonly oldStart: number;
	readonly oldCount: number;
	readonly newCount: number;
}

/** What a diff did to one file: its hunks, a rename, or its removal. */
interface ClaudeDiffFileChange {
	readonly newPath: string | undefined;
	readonly hunks: readonly ClaudeDiffHunk[];
}

const HUNK_HEADER = /^@@ -(?<oldStart>\d+)(?:,(?<oldCount>\d+))? \+(?<newStart>\d+)(?:,(?<newCount>\d+))? @@/;

/** The changes of a unified diff by old path. A removed file has no new path. Pure. */
function claudeDiffFileChanges(diff: string): Map<string, ClaudeDiffFileChange> {
	const changes = new Map<string, { newPath: string | undefined; hunks: ClaudeDiffHunk[] }>();
	let current: { newPath: string | undefined; hunks: ClaudeDiffHunk[] } | undefined;
	for (const line of diff.split(/\r?\n/)) {
		const header = /^diff --git a\/(?<oldPath>.+) b\/(?<newPath>.+)$/.exec(line);
		if (header?.groups) {
			current = { newPath: header.groups.newPath, hunks: [] };
			changes.set(header.groups.oldPath, current);
		} else if (current && line.startsWith('deleted file mode')) {
			current.newPath = undefined;
		} else if (current) {
			const hunk = HUNK_HEADER.exec(line);
			if (hunk?.groups) {
				current.hunks.push({
					oldStart: Number(hunk.groups.oldStart),
					oldCount: hunk.groups.oldCount === undefined ? 1 : Number(hunk.groups.oldCount),
					newCount: hunk.groups.newCount === undefined ? 1 : Number(hunk.groups.newCount),
				});
			}
		}
	}
	return changes;
}

/**
 * Where a finding is after a diff: moved by the lines added or removed above it, or
 * `undefined` when the diff changed its lines or removed its file (it is addressed). Pure.
 */
function claudeShiftFinding(finding: ClaudeReviewFinding, change: ClaudeDiffFileChange | undefined): ClaudeReviewFinding | undefined {
	if (!change) {
		return finding;
	}
	if (change.newPath === undefined) {
		return undefined;
	}
	let shift = 0;
	for (const hunk of change.hunks) {
		// A pure insertion (no old lines) sits after `oldStart`; anything else covers its old lines.
		const first = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;
		const last = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart + hunk.oldCount - 1;
		if (hunk.oldCount > 0 && first <= finding.endLine && last >= finding.startLine) {
			return undefined;
		}
		if (last < finding.startLine) {
			shift += hunk.newCount - hunk.oldCount;
		}
	}
	const file = change.newPath === normalizeClaudeFindingPath(finding.file) ? finding.file : change.newPath;
	return shift === 0 && file === finding.file ? finding : { ...finding, file, startLine: finding.startLine + shift, endLine: finding.endLine + shift };
}

/** Whether two findings are the same problem: same file, same title, lines that meet. */
function claudeSameFinding(a: ClaudeReviewFinding, b: ClaudeReviewFinding): boolean {
	return normalizeClaudeFindingPath(a.file) === normalizeClaudeFindingPath(b.file)
		&& a.title.trim().toLowerCase() === b.title.trim().toLowerCase()
		&& a.startLine <= b.endLine + 3 && b.startLine <= a.endLine + 3;
}

/**
 * Carries a review forward over the diff since it (issue 927). Open findings move with
 * the lines around them; one whose lines the diff changed, or whose file it removed, is
 * addressed. The new review's findings come after; one that repeats a carried or addressed
 * finding is that finding still open, so it reopens in place of a duplicate (that is the
 * check that it was really fixed). Dismissed findings stay dismissed and are not reported again. Pure.
 */
export function reconcileClaudeFindings(previous: readonly ClaudePersistedFinding[], diff: string, newFindings: readonly ClaudeReviewFinding[]): readonly ClaudePersistedFinding[] {
	const changes = claudeDiffFileChanges(diff);
	const carried: ClaudePersistedFinding[] = previous.map(item => {
		if (item.status !== 'open') {
			return item;
		}
		const moved = claudeShiftFinding(item.finding, changes.get(normalizeClaudeFindingPath(item.finding.file)));
		return moved ? { finding: moved, status: 'open' } : { finding: item.finding, status: 'addressed' };
	});
	const added: ClaudePersistedFinding[] = [];
	for (const finding of newFindings) {
		const index = carried.findIndex(item => claudeSameFinding(item.finding, finding));
		if (index === -1) {
			added.push({ finding, status: 'open' });
		} else if (carried[index].status === 'addressed') {
			carried[index] = { finding, status: 'open' };
		}
	}
	return [...carried, ...added];
}

/** How far a review has come: findings addressed out of those not dismissed. Pure. */
export function claudeReviewProgress(findings: readonly ClaudePersistedFinding[]): { readonly addressed: number; readonly total: number } {
	const counted = findings.filter(item => item.status !== 'dismissed');
	return { addressed: counted.filter(item => item.status === 'addressed').length, total: counted.length };
}

/** The hidden line a posted review ends with, so the next review knows where this one stopped. */
export function claudeReviewedShaMarker(sha: string): string {
	return `<!-- klawly-reviewed-sha: ${sha} -->`;
}

/** The commit the last of these comments says it reviewed up to, or undefined. Pure. */
export function readClaudeReviewedSha(comments: readonly string[]): string | undefined {
	for (let index = comments.length - 1; index >= 0; index--) {
		const match = /<!-- klawly-reviewed-sha: (?<sha>[0-9a-f]{7,64}) -->/.exec(comments[index]);
		if (match?.groups) {
			return match.groups.sha;
		}
	}
	return undefined;
}
