/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeCommitFixDraft } from '../../../../../platform/claude/common/claudeCommitReview.js';
import { ClaudeReviewFinding } from '../../../../../platform/claude/common/claudeReviewLoop.js';
import { MarkerService } from '../../../../../platform/markers/common/markerService.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ClaudeCommitFinding, ClaudeCommitReviewState } from '../../browser/claudeCommitReviewState.js';
import { claudeCommitFixSend, claudeCommitReviewEntry, claudeCommitReviewMenu, ClaudeCommitReviewStatusBar, draftClaudeCommitFix } from '../../browser/claudeCommitReviewStatus.js';
import { CLAUDE_AGENT_VIEW_ID } from '../../common/claudeViews.js';

const ROOT = URI.file('/repo');
const SHA = 'abcdef0123456789'.repeat(2) + 'abcdef01';

const ERROR: ClaudeReviewFinding = { file: 'src/a.ts', startLine: 3, endLine: 4, severity: 'high', category: 'bug' as const, title: 'Unchecked input', body: 'It reaches the query.' };
const WARNING: ClaudeReviewFinding = { file: 'src/b.ts', startLine: 9, endLine: 9, severity: 'medium', category: 'bug' as const, title: 'Naming', body: '' };
const INFO: ClaudeReviewFinding = { file: 'src/c.ts', startLine: 1, endLine: 1, severity: 'low', category: 'bug' as const, title: 'Style', body: 'Tidy.' };

function item(id: string, finding: ClaudeReviewFinding): ClaudeCommitFinding {
	return { id, finding, uri: URI.file('/repo/' + finding.file) };
}

suite('Claude commit review status bar item (issue 876)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the entry spins while reviewing, hides without findings and counts them after', () => {
		const strip = (entry: IStatusbarEntry | undefined) => entry && { text: entry.text, command: typeof entry.command === 'string' ? entry.command : entry.command?.id };
		assert.deepStrictEqual([
			strip(claudeCommitReviewEntry('abcdef0', undefined, 0)),
			strip(claudeCommitReviewEntry(undefined, SHA, 0)),
			strip(claudeCommitReviewEntry(undefined, SHA, 1)),
			strip(claudeCommitReviewEntry(undefined, SHA, 3)),
			strip(claudeCommitReviewEntry(undefined, SHA, 0, { clean: true })),
			strip(claudeCommitReviewEntry(undefined, SHA, 0, { failed: 'abcdef0' })),
		], [
			{ text: '$(loading~spin) Reviewing abcdef0', command: undefined },
			undefined,
			{ text: '$(comment-discussion) 1 finding in abcdef0', command: 'claude.commitReview.show' },
			{ text: '$(comment-discussion) 3 findings in abcdef0', command: 'claude.commitReview.show' },
			{ text: '$(check) No findings in abcdef0', command: 'claude.commitReview.hide' },
			{ text: '$(error) Review of abcdef0 failed', command: 'claude.commitReview.retry' },
		]);
	});

	test('a failed review without a reason points at the sign-in, and a finding tooltip uses the menu wording (issue 1079)', () => {
		const failed = claudeCommitReviewEntry(undefined, SHA, 0, { failed: 'abcdef0' });
		const found = claudeCommitReviewEntry(undefined, SHA, 1);
		assert.deepStrictEqual([failed?.tooltip, found?.tooltip], [
			`Claude couldn't review commit abcdef0. Check the Claude sign-in. Click to try again; the next commit also tries again.`,
			`Claude's review, up to commit abcdef0. Show the findings, then Fix All with Agent or Dismiss All.`,
		]);
	});

	test('the menu lists the findings, then fix all, problems and dismiss all', () => {
		const rows = claudeCommitReviewMenu(SHA, [item('1', ERROR), item('2', INFO)]);
		assert.deepStrictEqual(rows.map(row => row.type !== 'separator'
			? `${row.label} | ${row.description ?? ''} | ${row.detail ?? ''} | ${JSON.stringify(row.action)}`
			: `--- ${row.label ?? ''}`), [
			'--- Findings in abcdef0',
			'$(error) Unchecked input | src/a.ts:3-4 | It reaches the query. | {"kind":"finding","id":"1"}',
			'$(info) Style | src/c.ts:1 | Tidy. | {"kind":"finding","id":"2"}',
			'--- ',
			'$(sparkle) Fix All with Agent |  |  | {"kind":"fix-all"}',
			'$(warning) Show Problems |  |  | {"kind":"problems"}',
			'$(close-all) Dismiss All |  |  | {"kind":"dismiss-all"}',
			'$(refresh) Review Everything Again | Forget what was reviewed and look at the last commit from scratch |  | {"kind":"review-all"}',
			'--- ',
			'$(settings-gear) Open Review Settings | Review after commit, and whether Fix All sends at once or only drafts |  | {"kind":"settings"}',
		]);
	});

	test('drafting a fix opens a new chat with the draft, selects it and shows the chat view', async () => {
		const calls: string[] = [];
		const agent = {
			createSession: (options?: { readonly draft?: string }) => {
				calls.push(`create ${options?.draft}`);
				return { id: 'chat-1' };
			},
			selectSession: (id: string) => calls.push(`select ${id}`),
		} as unknown as IClaudeAgentService;
		const views = {
			openView: async (id: string, focus?: boolean) => {
				calls.push(`open ${id} ${focus}`);
				return null;
			},
		} as unknown as IViewsService;
		await draftClaudeCommitFix(agent, views, SHA, []);
		await draftClaudeCommitFix(agent, views, SHA, [item('1', ERROR), item('2', WARNING)]);
		assert.deepStrictEqual(calls, [
			`create ${claudeCommitFixDraft(SHA, [ERROR, WARNING])}`,
			'select chat-1',
			`open ${CLAUDE_AGENT_VIEW_ID} true`,
		]);
	});

	test('with sending on, the fix is submitted in the review folder instead of left as a draft', async () => {
		const calls: string[] = [];
		const agent = {
			createSession: (options?: { readonly draft?: string }) => {
				calls.push(`create ${options?.draft}`);
				return { id: 'chat-1' };
			},
			selectSession: (id: string) => calls.push(`select ${id}`),
			submit: async (id: string, text: string, cwd: string) => { calls.push(`submit ${id} ${cwd} ${text}`); },
		} as unknown as IClaudeAgentService;
		const views = { openView: async () => null } as unknown as IViewsService;
		await draftClaudeCommitFix(agent, views, SHA, [item('1', ERROR)], claudeCommitFixSend(true, ROOT));
		assert.deepStrictEqual(calls, [
			'create undefined',
			'select chat-1',
			`submit chat-1 ${ROOT.fsPath} ${claudeCommitFixDraft(SHA, [ERROR])}`,
		]);
	});

	test('a fix is sent only when the setting is exactly on and the review has a folder', () => {
		assert.deepStrictEqual([
			claudeCommitFixSend(true, ROOT),
			claudeCommitFixSend(false, ROOT),
			claudeCommitFixSend('true', ROOT),
			claudeCommitFixSend(undefined, ROOT),
			claudeCommitFixSend(true, undefined),
		], [{ cwd: ROOT.fsPath }, undefined, undefined, undefined, undefined]);
	});

	test('the status bar item follows the review: hidden, spinning, counted, updated, removed', () => {
		const log: string[] = [];
		const statusbar = {
			addEntry: (entry: IStatusbarEntry, id: string): IStatusbarEntryAccessor => {
				log.push(`add ${id} ${entry.text}`);
				return { update: (next: IStatusbarEntry) => log.push(`update ${next.text}`), dispose: () => log.push('remove') };
			},
		} as Partial<IStatusbarService> as IStatusbarService;
		const markers = new MarkerService();
		store.add(toDisposable(() => markers.dispose()));
		const state = store.add(new ClaudeCommitReviewState(markers, store.add(new InMemoryStorageService())));
		store.add(new ClaudeCommitReviewStatusBar(statusbar, state, { getValue: () => undefined } as Partial<IConfigurationService> as IConfigurationService));
		const seen: string[][] = [log.splice(0)];
		state.begin(SHA);
		seen.push(log.splice(0));
		state.finish(ROOT, SHA, [ERROR, WARNING]);
		seen.push(log.splice(0));
		state.dismiss([state.findings[0].id]);
		seen.push(log.splice(0));
		state.dismissAll();
		seen.push(log.splice(0));
		state.begin(SHA);
		state.end();
		state.fail(SHA);
		seen.push(log.splice(0));
		state.finish(ROOT, SHA, []);
		seen.push(log.splice(0));
		assert.deepStrictEqual(seen, [
			[],
			['add claude.commitReview $(loading~spin) Reviewing abcdef0'],
			['update $(comment-discussion) 2 findings in abcdef0'],
			['update $(comment-discussion) 1 finding in abcdef0'],
			['remove'],
			['add claude.commitReview $(loading~spin) Reviewing abcdef0', 'remove', 'add claude.commitReview $(error) Review of abcdef0 failed'],
			['update $(check) No findings in abcdef0'],
		]);
	});
});
