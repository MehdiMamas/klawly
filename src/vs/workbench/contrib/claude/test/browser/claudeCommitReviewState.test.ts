/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CLAUDE_COMMIT_REVIEW_MARKER_OWNER } from '../../../../../platform/claude/common/claudeCommitReview.js';
import { ClaudeReviewFinding } from '../../../../../platform/claude/common/claudeReviewLoop.js';
import { MarkerService } from '../../../../../platform/markers/common/markerService.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { ClaudeCommitReviewState } from '../../browser/claudeCommitReviewState.js';

const ROOT = URI.file('/repo');
const SHA = 'abcdef0123456789'.repeat(2) + 'abcdef01';

const WARNING: ClaudeReviewFinding = { file: 'src/b.ts', startLine: 9, endLine: 9, severity: 'medium', category: 'bug' as const, title: 'Naming', body: 'Rename it.' };
const ERROR: ClaudeReviewFinding = { file: 'src/a.ts', startLine: 3, endLine: 4, severity: 'high', category: 'bug' as const, title: 'Unchecked input', body: 'It reaches the query.', suggestion: 'Validate it.' };

suite('Claude commit review state (issue 876)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(storage = store.add(new InMemoryStorageService())) {
		const markers = new MarkerService();
		store.add(toDisposable(() => markers.dispose()));
		const state = store.add(new ClaudeCommitReviewState(markers, storage));
		let changes = 0;
		store.add(state.onDidChange(() => changes++));
		const read = () => markers.read({ owner: CLAUDE_COMMIT_REVIEW_MARKER_OWNER })
			.map(marker => `${marker.resource.path}:${marker.startLineNumber}-${marker.endLineNumber} ${marker.severity} ${marker.message.split('\n')[0]}`)
			.sort();
		return { state, read, changes: () => changes };
	}

	test('finish puts findings worst first and writes a marker on each file, relative or absolute', () => {
		const { state, read } = setup();
		state.finish(ROOT, SHA, [WARNING, { ...ERROR, file: URI.file('/elsewhere/a.ts').fsPath }]);
		assert.deepStrictEqual({
			findings: state.findings.map(item => `${item.uri.path} ${item.finding.severity}`),
			sha: state.result?.sha,
			markers: read(),
		}, {
			findings: ['/elsewhere/a.ts high', '/repo/src/b.ts medium'],
			sha: SHA,
			markers: ['/elsewhere/a.ts:3-4 8 Unchecked input', '/repo/src/b.ts:9-9 4 Naming'],
		});
	});

	test('dismiss removes one finding and its marker, dismissAll the rest', () => {
		const { state, read, changes } = setup();
		state.finish(ROOT, SHA, [ERROR, WARNING]);
		const before = changes();
		state.dismiss([state.findings[0].id]);
		const afterOne = { findings: state.findings.map(item => item.finding.title), markers: read(), fired: changes() - before };
		state.dismissAll();
		assert.deepStrictEqual({ afterOne, fired: changes() - before, findings: state.findings.length, markers: read() }, {
			afterOne: { findings: ['Naming'], markers: ['/repo/src/b.ts:9-9 4 Naming'], fired: 1 },
			fired: 2,
			findings: 0,
			markers: [],
		});
	});

	test('begin shows the short sha until end or finish', () => {
		const { state } = setup();
		state.begin(SHA);
		const started = state.reviewing;
		state.end();
		const ended = state.reviewing;
		state.begin(SHA);
		state.finish(ROOT, SHA, []);
		assert.deepStrictEqual([started, ended, state.reviewing], ['abcdef0', undefined, undefined]);
	});

	test('a second review replaces the markers of the first', () => {
		const { state, read } = setup();
		state.finish(ROOT, SHA, [ERROR, WARNING]);
		state.finish(ROOT, 'f'.repeat(40), [WARNING]);
		assert.deepStrictEqual({ markers: read(), sha: state.result?.sha }, { markers: ['/repo/src/b.ts:9-9 4 Naming'], sha: 'f'.repeat(40) });
	});

	test('a failed review keeps its reason until hidden, and Retry asks for another look (issue 1046)', () => {
		const { state } = setup();
		let retries = 0;
		store.add(state.onDidRequestRetry(() => retries++));
		state.fail(SHA, 'rate limited');
		const failed = { failed: state.failed, reason: state.failedReason };
		state.retry();
		state.hideOutcome();
		assert.deepStrictEqual({ failed, retries, after: { failed: state.failed, reason: state.failedReason } }, {
			failed: { failed: SHA.slice(0, 7), reason: 'rate limited' },
			retries: 1,
			after: { failed: undefined, reason: undefined },
		});
	});

	test('hiding a clean review clears it, but one with findings stays (issue 1046)', () => {
		const { state } = setup();
		state.finish(ROOT, SHA, []);
		state.hideOutcome();
		const clean = state.result;
		state.finish(ROOT, SHA, [ERROR]);
		state.hideOutcome();
		assert.deepStrictEqual({ clean, kept: state.findings.length }, { clean: undefined, kept: 1 });
	});

	test('a review is kept between windows: a new state restores its findings and where it stopped (issue 927)', () => {
		const storage = store.add(new InMemoryStorageService());
		const first = setup(storage).state;
		first.finish(ROOT, SHA, [ERROR, WARNING]);
		first.dismiss([first.findings.find(item => item.finding.title === 'Naming')!.id]);
		const { state, read } = setup(storage);
		assert.deepStrictEqual({ sha: state.reviewedSha, findings: state.findings.map(item => item.finding.title), total: state.result?.total, markers: read() }, {
			sha: SHA,
			findings: ['Unchecked input'],
			total: 2,
			markers: ['/repo/src/a.ts:3-4 8 Unchecked input'],
		});
	});

	test('a review of only the diff since carries findings over it: addressed, moved, new (issue 927)', () => {
		const { state } = setup();
		state.finish(ROOT, SHA, [ERROR, WARNING]);
		const kept = state.findings.find(item => item.finding.title === 'Naming')!.id;
		const next = 'f'.repeat(40);
		const diff = [
			'diff --git a/src/a.ts b/src/a.ts',
			'--- a/src/a.ts',
			'+++ b/src/a.ts',
			'@@ -3,2 +3,2 @@',
			'-bad',
			'-bad',
			'+good',
			'+good',
			'diff --git a/src/b.ts b/src/b.ts',
			'--- a/src/b.ts',
			'+++ b/src/b.ts',
			'@@ -1,0 +2,2 @@',
			'+one',
			'+two',
		].join('\n');
		state.finish(ROOT, next, [{ ...WARNING, file: 'src/c.ts', title: 'New' }], diff);
		assert.deepStrictEqual({
			sha: state.result?.sha,
			findings: state.findings.map(item => `${item.finding.file}:${item.finding.startLine} ${item.finding.title}`),
			keptId: state.findings.some(item => item.id === kept),
			progress: state.result?.progress,
		}, {
			sha: next,
			findings: ['src/b.ts:11 Naming', 'src/c.ts:9 New'],
			keptId: true,
			progress: { addressed: 1, total: 3 },
		});
	});

	test('Review Everything Again forgets the stored review and asks for a full one (issue 927)', () => {
		const storage = store.add(new InMemoryStorageService());
		const { state, read } = setup(storage);
		let retries = 0;
		store.add(state.onDidRequestRetry(() => retries++));
		state.finish(ROOT, SHA, [ERROR]);
		state.reviewAll();
		assert.deepStrictEqual({ sha: state.reviewedSha, result: state.result, markers: read(), retries, restored: setup(storage).state.reviewedSha }, {
			sha: undefined,
			result: undefined,
			markers: [],
			retries: 1,
			restored: undefined,
		});
	});
});
