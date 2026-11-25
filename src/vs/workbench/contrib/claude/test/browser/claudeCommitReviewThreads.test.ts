/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createTestCodeEditor, ITestCodeEditor } from '../../../../../editor/test/browser/testCodeEditor.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { CLAUDE_REVIEW_FIX_SENDS_SETTING, claudeCommitFixDraft } from '../../../../../platform/claude/common/claudeCommitReview.js';
import { ClaudeReviewFinding } from '../../../../../platform/claude/common/claudeReviewLoop.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { InMemoryStorageService, IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { MarkerService } from '../../../../../platform/markers/common/markerService.js';
import { IDiffEditor } from '../../../../../editor/browser/editorBrowser.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { claudeCommitThreadEditors, claudeCommitThreadHost, ClaudeCommitReviewThreads } from '../../browser/claudeCommitReviewThreads.js';
import { ClaudeCommitReviewState } from '../../browser/claudeCommitReviewState.js';
import { renderClaudeFindingThread } from '../../browser/review/claudeReviewFindings.js';

const ROOT = URI.file('/repo');
const SHA = 'abcdef0123456789'.repeat(2) + 'abcdef01';
const SOURCE = ['one', 'two', 'three', 'four', 'five', 'six'].join('\n');

const ON_FILE: ClaudeReviewFinding = { file: 'src/a.ts', startLine: 3, endLine: 4, severity: 'high', category: 'bug' as const, title: 'Unchecked input', body: 'It reaches the query.', suggestion: 'Validate it.' };
const ELSEWHERE: ClaudeReviewFinding = { file: 'src/b.ts', startLine: 2, endLine: 2, severity: 'medium', category: 'bug' as const, title: 'Naming', body: '' };

suite('Claude commit review threads (issue 876)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const markers = new MarkerService();
		store.add(toDisposable(() => markers.dispose()));
		const state = store.add(new ClaudeCommitReviewState(markers, store.add(new InMemoryStorageService())));
		const model = store.add(createTextModel(SOURCE, null, undefined, URI.file('/repo/src/a.ts')));
		const editor: ITestCodeEditor = store.add(createTestCodeEditor(model));
		const visible = store.add(new Emitter<void>());
		const editors = {
			visibleTextEditorControls: [editor],
			onDidVisibleEditorsChange: visible.event,
		} as unknown as IEditorService;
		const drafts: string[] = [];
		const agent = {
			createSession: (options?: { readonly draft?: string }) => {
				drafts.push(options?.draft ?? '');
				return { id: 'chat-1' };
			},
			selectSession: () => { },
		} as unknown as IClaudeAgentService;
		const views = { openView: async () => null } as unknown as IViewsService;
		const configuration = new TestConfigurationService();
		store.add(new ClaudeCommitReviewThreads(editors, state, agent, views, configuration, {} as IClaudeRuntimeService, {} as IWorkspaceContextService, {} as IStorageService, {} as INotificationService));
		const lines = () => model.getAllDecorations()
			.filter(decoration => decoration.options.description === 'claude-review-finding')
			.map(decoration => `${decoration.range.startLineNumber}-${decoration.range.endLineNumber}`);
		return { state, editor, lines, drafts, agent, views, configuration };
	}

	test('a finding on the open file shows under its lines, one on another file does not', async () => {
		const { state, lines } = setup();
		state.finish(ROOT, SHA, [ON_FILE, ELSEWHERE]);
		await timeout(0);
		assert.deepStrictEqual(lines(), ['3-4']);
	});

	test('the threads follow edits made after the commit', async () => {
		const { state, editor, lines } = setup();
		state.finish(ROOT, SHA, [ON_FILE]);
		await timeout(0);
		editor.executeEdits('test', [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: 'a\nb\n' }]);
		await timeout(400);
		assert.deepStrictEqual(lines(), ['5-6']);
	});

	test('dismissing a finding takes its thread away', async () => {
		const { state, lines } = setup();
		state.finish(ROOT, SHA, [ON_FILE]);
		await timeout(0);
		const before = lines();
		state.dismiss([state.findings[0].id]);
		await timeout(0);
		assert.deepStrictEqual({ before, after: lines() }, { before: ['3-4'], after: [] });
	});

	test('Fix with Agent drafts that one finding, Dismiss drops it from the review', async () => {
		const { state, drafts, agent, views, configuration } = setup();
		state.finish(ROOT, SHA, [ON_FILE, ELSEWHERE]);
		const shown = state.findings.find(item => item.finding.title === 'Naming')!;
		const buttons = new DisposableStore();
		store.add(buttons);
		const element = renderClaudeFindingThread(shown, claudeCommitThreadHost(state, agent, views, configuration), buttons);
		const press = (label: string) => Array.from(element.querySelectorAll('button')).find(button => button.textContent?.includes(label))?.click();
		press('Fix with Agent');
		const afterFix = drafts.slice();
		press('Dismiss');
		assert.deepStrictEqual({ afterFix, left: state.findings.map(item => item.finding.title) }, {
			afterFix: [claudeCommitFixDraft(SHA, [ELSEWHERE])],
			left: ['Unchecked input'],
		});
	});

	test('a suggestion shows as a diff and Apply Suggestion edits the file, once, until the file changes (issue 925)', async () => {
		const { state, agent, views, editor, configuration } = setup();
		state.finish(ROOT, SHA, [ON_FILE]);
		await timeout(0);
		const shown = state.findings.find(item => item.finding.title === 'Unchecked input')!;
		const model = editor.getModel()!;
		const original = [model.getLineContent(3), model.getLineContent(4)];
		const changed = new Emitter<void>();
		store.add(toDisposable(() => changed.dispose()));
		let stale = false;
		const buttons = new DisposableStore();
		store.add(buttons);
		const element = renderClaudeFindingThread(shown, claudeCommitThreadHost(state, agent, views, configuration), buttons, undefined, {
			onDidChange: changed.event,
			lines: () => original,
			stale: () => stale,
			apply: () => { model.applyEdits([{ range: { startLineNumber: 3, startColumn: 1, endLineNumber: 4, endColumn: 5 }, text: 'Validate it.' }]); return true; },
		});
		const button = (label: string) => Array.from(element.querySelectorAll('button')).find(candidate => candidate.textContent === label)!;
		const diff = Array.from(element.querySelectorAll('.claude-review-diff-line')).map(line => line.textContent);
		stale = true;
		changed.fire();
		const afterStale = { disabled: button('Apply Suggestion').disabled, note: element.querySelector('.claude-review-finding-stale-reason')?.textContent, ask: button('Fix with Agent').textContent };
		stale = false;
		changed.fire();
		button('Apply Suggestion').click();
		assert.deepStrictEqual({ diff, afterStale, text: model.getValue(), left: state.findings.length }, {
			diff: ['- three', '- four', '+ Validate it.'],
			afterStale: { disabled: true, note: 'The file changed since this review.', ask: 'Fix with Agent' },
			text: ['one', 'two', 'Validate it.', 'five', 'six'].join('\n'),
			left: 0,
		});
	});
	test('a stale suggestion offers Re-run Review, and an applied one shows Applied with an Undo that says what it undoes (issue 1045)', async () => {
		const { state, agent, views, configuration } = setup();
		state.finish(ROOT, SHA, [ON_FILE]);
		await timeout(0);
		const shown = state.findings.find(item => item.finding.title === 'Unchecked input')!;
		const changed = new Emitter<void>();
		store.add(toDisposable(() => changed.dispose()));
		let stale = true;
		let reruns = 0;
		let undone = 0;
		const buttons = new DisposableStore();
		store.add(buttons);
		const host = { ...claudeCommitThreadHost(state, agent, views, configuration), rerun: () => { reruns++; } };
		const element = renderClaudeFindingThread(shown, host, buttons, undefined, {
			onDidChange: changed.event,
			lines: () => ['three', 'four'],
			stale: () => stale,
			apply: () => true,
			undo: () => { undone++; },
		});
		const button = (label: string) => Array.from(element.querySelectorAll('button')).find(candidate => candidate.textContent === label)!;
		const visible = (label: string) => !button(label).hidden;
		const reason = element.querySelector('.claude-review-finding-stale-reason')!.textContent;
		const staleState = { reason, apply: button('Apply Suggestion').title, rerun: visible('Re-run Review') };
		button('Re-run Review').click();
		stale = false;
		changed.fire();
		button('Apply Suggestion').click();
		const applied = { label: element.querySelector('.claude-review-finding-applied')!.textContent, undo: button('Undo').title, apply: visible('Apply Suggestion'), left: state.findings.length };
		button('Undo').click();
		assert.deepStrictEqual({ staleState, reruns, applied, undone, apply: visible('Apply Suggestion') }, {
			staleState: { reason: 'The file changed since this review.', apply: 'The file changed since this review.', rerun: true },
			reruns: 1,
			applied: { label: 'Applied', undo: 'Undo the edit in the editor and bring the original lines back', apply: false, left: 1 },
			undone: 1,
			apply: true,
		});
	});

	test('with sending on, Fix with Agent submits that finding in the review folder', async () => {
		const { state, agent, views, configuration } = setup();
		await configuration.setUserConfiguration(CLAUDE_REVIEW_FIX_SENDS_SETTING, true);
		const sent: string[] = [];
		const sending = Object.assign(Object.create(agent as object), { submit: async (id: string, text: string, cwd: string) => { sent.push(`${id} ${cwd} ${text}`); } }) as IClaudeAgentService;
		state.finish(ROOT, SHA, [ON_FILE]);
		claudeCommitThreadHost(state, sending, views, configuration as IConfigurationService).fix(state.findings[0].id);
		await timeout(0);
		assert.deepStrictEqual(sent, [`chat-1 ${ROOT.fsPath} ${claudeCommitFixDraft(SHA, [ON_FILE])}`]);
	});

	test('a diff editor gets its threads on the modified side, a plain editor as itself', () => {
		const model = store.add(createTextModel(SOURCE, null, undefined, URI.file('/repo/src/a.ts')));
		const plain: ITestCodeEditor = store.add(createTestCodeEditor(model));
		const modified: ITestCodeEditor = store.add(createTestCodeEditor(model));
		const diff = { getEditorType: () => 'vs.editor.IDiffEditor', getModifiedEditor: () => modified } as unknown as IDiffEditor;
		assert.deepStrictEqual(claudeCommitThreadEditors([plain, diff]).map(editor => editor === plain ? 'plain' : editor === modified ? 'modified' : 'other'), ['plain', 'modified']);
	});
});
