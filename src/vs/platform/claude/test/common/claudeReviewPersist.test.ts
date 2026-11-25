/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeReviewFinding } from '../../common/claudeReviewLoop.js';
import { ClaudePersistedFinding, claudeReviewedShaMarker, claudeReviewProgress, parseClaudePersistedReview, readClaudeReviewedSha, reconcileClaudeFindings, serializeClaudePersistedReview } from '../../common/claudeReviewPersist.js';

const SHA = 'a'.repeat(40);

function finding(extra: Partial<ClaudeReviewFinding>): ClaudeReviewFinding {
	return { file: 'src/a.ts', startLine: 10, endLine: 12, severity: 'high', category: 'bug', title: 'Off by one', body: 'The loop skips the last item.', ...extra };
}

function open(extra: Partial<ClaudeReviewFinding>): ClaudePersistedFinding {
	return { finding: finding(extra), status: 'open' };
}

/** A diff of one file with the given hunk headers. */
function diff(file: string, hunks: readonly string[], extra: readonly string[] = [], to = file): string {
	return [`diff --git a/${file} b/${to}`, ...extra, `--- a/${file}`, `+++ b/${to}`, ...hunks].join('\n');
}

/** A finding in short: file, lines, title and status. */
function short(items: readonly ClaudePersistedFinding[]): string[] {
	return items.map(item => `${item.finding.file}:${item.finding.startLine}-${item.finding.endLine} ${item.finding.title} ${item.status}`);
}

suite('Klawly reviews that remember what they covered (issue 927)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('open findings move with the lines added or removed above them; one whose lines changed is addressed', () => {
		const previous = [open({}), open({ startLine: 30, endLine: 30, title: 'Leak' }), open({ startLine: 2, endLine: 2, title: 'Above' })];
		const result = reconcileClaudeFindings(previous, diff('src/a.ts', ['@@ -4,0 +5,3 @@', '@@ -30,1 +33,1 @@']), []);
		assert.deepStrictEqual(short(result), [
			'src/a.ts:13-15 Off by one open',
			'src/a.ts:30-30 Leak addressed',
			'src/a.ts:2-2 Above open',
		]);
	});

	test('a removed file addresses its findings, a renamed one carries them to the new path', () => {
		const previous = [open({}), open({ file: 'src/b.ts', title: 'Leak' })];
		const changes = [
			diff('src/a.ts', ['@@ -1,20 +0,0 @@'], ['deleted file mode 100644']),
			diff('src/b.ts', [], ['similarity index 100%', 'rename from src/b.ts', 'rename to src/c.ts'], 'src/c.ts'),
		].join('\n');
		assert.deepStrictEqual(short(reconcileClaudeFindings(previous, changes, [])), [
			'src/a.ts:10-12 Off by one addressed',
			'src/c.ts:10-12 Leak open',
		]);
	});

	test('a new finding that repeats an open one is dropped, one that repeats an addressed one reopens it, dismissed stays dismissed', () => {
		const previous: ClaudePersistedFinding[] = [
			open({}),
			{ finding: finding({ file: 'src/b.ts', title: 'Leak' }), status: 'addressed' },
			{ finding: finding({ file: 'src/d.ts', title: 'Hidden' }), status: 'dismissed' },
		];
		const result = reconcileClaudeFindings(previous, '', [
			finding({ startLine: 11, endLine: 11, title: 'off by one ' }),
			finding({ file: 'src/b.ts', startLine: 14, endLine: 14, title: 'Leak' }),
			finding({ file: 'src/d.ts', title: 'Hidden' }),
			finding({ file: 'src/e.ts', title: 'New' }),
		]);
		assert.deepStrictEqual({ findings: short(result), progress: claudeReviewProgress(result) }, {
			findings: [
				'src/a.ts:10-12 Off by one open',
				'src/b.ts:14-14 Leak open',
				'src/d.ts:10-12 Hidden dismissed',
				'src/e.ts:10-12 New open',
			],
			progress: { addressed: 0, total: 3 },
		});
	});

	test('a stored review reads back; another version, a bad sha or garbage is no review', () => {
		const review = { reviewedSha: SHA, findings: [open({}), { finding: finding({ title: 'Leak' }), status: 'addressed' as const }] };
		const stored = serializeClaudePersistedReview(review);
		assert.deepStrictEqual({
			roundTrip: parseClaudePersistedReview(stored),
			version: parseClaudePersistedReview(stored.replace('"version":1', '"version":2')),
			sha: parseClaudePersistedReview(stored.replace(SHA, '--output=x')),
			garbage: parseClaudePersistedReview('{not json'),
			empty: parseClaudePersistedReview(undefined),
			badItem: parseClaudePersistedReview(JSON.stringify({ version: 1, reviewedSha: SHA, findings: [{ finding: finding({}), status: 'maybe' }, 3] }))?.findings.length,
		}, { roundTrip: review, version: undefined, sha: undefined, garbage: undefined, empty: undefined, badItem: 0 });
	});

	test('the last reviewed-sha marker in the comments wins', () => {
		const other = 'b'.repeat(40);
		assert.deepStrictEqual([
			readClaudeReviewedSha([`first\n${claudeReviewedShaMarker(SHA)}`, 'a reply', `second\n${claudeReviewedShaMarker(other)}`, 'no marker']),
			readClaudeReviewedSha(['<!-- klawly-reviewed-sha: not-a-sha -->', 'nothing']),
		], [other, undefined]);
	});
});
