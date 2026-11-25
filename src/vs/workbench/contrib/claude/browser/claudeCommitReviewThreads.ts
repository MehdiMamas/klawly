/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICodeEditor, isCodeEditor, isDiffEditor } from '../../../../editor/browser/editorBrowser.js';
import { IEditor } from '../../../../editor/common/editorCommon.js';
import { localize } from '../../../../nls.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { ClaudeReviewFinding } from '../../../../platform/claude/common/claudeReviewLoop.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { CLAUDE_REVIEW_FIX_SENDS_SETTING } from '../../../../platform/claude/common/claudeCommitReview.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { deserializeFindingThreads, serializeFindingThreads } from '../../../services/claude/common/claudeReviewPersist.js';
import { ClaudeFindingConversations, ClaudeFindingConversationView } from '../common/claudeFindingConversations.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ClaudeCommitFinding, IClaudeCommitReviewState } from './claudeCommitReviewState.js';
import { claudeCommitFixSend, draftClaudeCommitFix } from './claudeCommitReviewStatus.js';
import { ClaudeEditorFindings, ClaudeFindingThreadHost, ClaudeReviewFindingsHost } from './review/claudeReviewFindings.js';

/** How long the threads wait after a keystroke before they look where their lines went. */
const FOLLOW_EDITS_DELAY = 250;

/** The threads of one editor, and where edits since the commit have moved their lines. */
class EditorCommitThreads extends Disposable {
	private _shown: ClaudeEditorFindings | undefined;
	private _items: readonly ClaudeCommitFinding[] = [];
	private _key = '';
	/** Lines of findings that edits have moved, by finding id; the review's own lines are about the commit. */
	private readonly _moved = new Map<string, { readonly startLine: number; readonly endLine: number }>();
	private readonly _follow: RunOnceScheduler;

	constructor(private readonly _editor: ICodeEditor, private readonly _host: ClaudeFindingThreadHost & Pick<ClaudeReviewFindingsHost, 'conversation'>, private readonly _fixHint: string) {
		super();
		this._follow = this._register(new RunOnceScheduler(() => this.follow(), FOLLOW_EDITS_DELAY));
		this._register(_editor.onDidChangeModelContent(() => this._follow.schedule()));
		this._register(_editor.onDidChangeModel(() => this._moved.clear()));
		this._register(toDisposable(() => this._shown?.dispose()));
	}

	/** Shows `items` (already on this editor's file); the same findings on the same lines are left alone. */
	show(items: readonly ClaudeCommitFinding[]): void {
		this._items = items;
		const placed = items.map(item => {
			const lines = this._moved.get(item.id);
			return lines ? { ...item, finding: { ...item.finding, startLine: lines.startLine, endLine: lines.endLine } } : item;
		});
		const key = `${this._editor.getModel()?.uri.toString()}|${placed.map(item => `${item.id}:${item.finding.startLine}-${item.finding.endLine}`).join(',')}`;
		if (key === this._key) {
			return;
		}
		this._key = key;
		this._shown?.dispose();
		this._shown = placed.length > 0 ? new ClaudeEditorFindings(this._editor, placed, this._host, this._fixHint) : undefined;
	}

	/**
	 * After edits, the gutter marks have moved with the text: rebuild the threads
	 * on the new lines so each one stays under the code it is about.
	 */
	private follow(): void {
		if (!this._shown) {
			return;
		}
		for (const [id, lines] of this._shown.lines()) {
			this._moved.set(id, lines);
		}
		this.show(this._items);
	}
}

/**
 * The code editors that get threads: every text editor, and the modified side of
 * a diff editor (issue 960). The Review editor is a multi-file diff the editor
 * service does not list, and it shows its own threads, so those never double.
 * Exported for tests.
 */
export function claudeCommitThreadEditors(controls: readonly IEditor[]): ICodeEditor[] {
	const editors: ICodeEditor[] = [];
	for (const control of controls) {
		if (isCodeEditor(control)) {
			editors.push(control);
		} else if (isDiffEditor(control)) {
			editors.push(control.getModifiedEditor());
		}
	}
	return editors;
}

/** What a commit finding's buttons do: Fix with Agent drafts it in a new chat, Dismiss drops it everywhere. Exported for tests. */
export function claudeCommitThreadHost(state: IClaudeCommitReviewState, agent: IClaudeAgentService, views: IViewsService, configuration: IConfigurationService, conversation?: (id: string) => ClaudeFindingConversationView | undefined): ClaudeFindingThreadHost & Pick<ClaudeReviewFindingsHost, 'conversation'> {
	return {
		conversation,
		fix: id => {
			const result = state.result;
			const item = result?.findings.find(candidate => candidate.id === id);
			if (result && item) {
				void draftClaudeCommitFix(agent, views, result.sha, [item], claudeCommitFixSend(configuration.getValue(CLAUDE_REVIEW_FIX_SENDS_SETTING), result.root));
			}
		},
		dismiss: id => state.dismiss([id]),
	};
}

/**
 * Review after commit (issue 876): each finding of the last commit review shows
 * as a thread under its lines in every text editor open on its file, with Ask
 * Agent to Fix (a new chat with the finding as a draft, or sent at once with
 * Send Review Fixes at Once) and Dismiss. Diff editors show them on the modified
 * side; the Review editor keeps its own threads, so those are not doubled.
 * The findings are about the commit, so they follow edits made after it (DL-93).
 */
export class ClaudeCommitReviewThreads extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeCommitReviewThreads';

	private readonly _threads = this._register(new DisposableMap<ICodeEditor, EditorCommitThreads>());
	private readonly _watched = this._register(new DisposableMap<ICodeEditor, DisposableStore>());
	private readonly _scheduler = this._register(new RunOnceScheduler(() => this.update(), 0));
	private readonly _host: ClaudeFindingThreadHost & Pick<ClaudeReviewFindingsHost, 'conversation'>;
	private readonly _conversations = this._register(new MutableDisposable<ClaudeFindingConversations>());
	private _conversationsSha = '';
	private readonly _fixHint = localize('claudeCommitReviewFixHint', "Open a new chat with this finding written as a draft");

	constructor(
		@IEditorService private readonly _editors: IEditorService,
		@IClaudeCommitReviewState private readonly _state: IClaudeCommitReviewState,
		@IClaudeAgentService agent: IClaudeAgentService,
		@IViewsService views: IViewsService,
		@IConfigurationService configuration: IConfigurationService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IStorageService private readonly _storage: IStorageService,
		@INotificationService private readonly _notifications: INotificationService,
	) {
		super();
		this._host = claudeCommitThreadHost(this._state, agent, views, configuration, id => this.conversation(id));
		this._register(this._state.onDidChange(() => this._scheduler.schedule()));
		this._register(this._editors.onDidVisibleEditorsChange(() => this._scheduler.schedule()));
		this.update();
	}

	/** The thread of a finding of the last commit review: replies run a read-only turn of Claude (issue 929). */
	private conversation(id: string): ClaudeFindingConversationView | undefined {
		const result = this._state.result;
		const item = result?.findings.find(candidate => candidate.id === id);
		if (!result || !item || !this._runtime.askSideQuestion) {
			return undefined;
		}
		if (this._conversationsSha !== result.sha || !this._conversations.value) {
			const key = `klawly.commitReview.threads.${result.sha}`;
			const saved = deserializeFindingThreads(this._storage.get(key, StorageScope.WORKSPACE, '[]'));
			this._conversationsSha = result.sha;
			this._conversations.value = new ClaudeFindingConversations({
				askReadOnly: prompt => this.askReadOnly(prompt),
				codeAround: finding => this.codeAround(finding),
				summary: () => undefined,
				save: threads => {
					const json = serializeFindingThreads(threads);
					if (json === '[]') {
						this._storage.remove(key, StorageScope.WORKSPACE);
					} else {
						this._storage.store(key, json, StorageScope.WORKSPACE, StorageTarget.MACHINE);
					}
				},
				continueInChat: findingId => this._host.fix(findingId),
				fail: message => this._notifications.error(localize('claudeCommitReviewReplyFailed', "Claude could not answer: {0}", message)),
			}, saved);
		}
		return this._conversations.value.view(id, item.finding);
	}

	private async askReadOnly(prompt: string): Promise<string> {
		const cwd = this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.fsPath;
		if (!cwd || !this._runtime.askSideQuestion) {
			throw new Error(localize('claudeCommitReviewReplyNoFolder', "Open a local folder to ask Claude."));
		}
		const result = await this._runtime.askSideQuestion({ id: generateUuid(), question: prompt, cwd });
		if (result.kind === 'answer') {
			return result.text;
		}
		throw new Error(result.kind === 'failed' ? result.message : localize('claudeCommitReviewReplyCancelled', "The answer was cancelled."));
	}

	/** The lines around a finding in the editor that shows it, for the reply prompt. */
	private codeAround(finding: ClaudeReviewFinding): string[] {
		const item = this._state.findings.find(candidate => candidate.finding === finding);
		const uri = item?.uri.toString();
		const model = this._editors.visibleTextEditorControls.filter(isCodeEditor).map(editor => editor.getModel()).find(candidate => candidate?.uri.toString() === uri);
		if (!model) {
			return [];
		}
		const first = Math.max(1, finding.startLine - 3);
		const last = Math.min(model.getLineCount(), finding.endLine + 3);
		const lines: string[] = [];
		for (let line = first; line <= last; line++) {
			lines.push(`${line}: ${model.getLineContent(line)}`);
		}
		return lines;
	}

	private update(): void {
		const editors = claudeCommitThreadEditors(this._editors.visibleTextEditorControls);
		for (const editor of [...this._watched.keys()]) {
			if (!editors.includes(editor)) {
				this._watched.deleteAndDispose(editor);
				this._threads.deleteAndDispose(editor);
			}
		}
		const findings = this._state.findings;
		for (const editor of editors) {
			if (!this._watched.has(editor)) {
				const store = new DisposableStore();
				store.add(editor.onDidChangeModel(() => this._scheduler.schedule()));
				store.add(editor.onDidDispose(() => {
					this._watched.deleteAndDispose(editor);
					this._threads.deleteAndDispose(editor);
				}));
				this._watched.set(editor, store);
			}
			const uri = editor.getModel()?.uri.toString();
			const items = uri ? findings.filter(item => item.uri.toString() === uri) : [];
			let threads = this._threads.get(editor);
			if (items.length === 0) {
				this._threads.deleteAndDispose(editor);
				continue;
			}
			if (!threads) {
				threads = new EditorCommitThreads(editor, this._host, this._fixHint);
				this._threads.set(editor, threads);
			}
			threads.show(items);
		}
	}
}
