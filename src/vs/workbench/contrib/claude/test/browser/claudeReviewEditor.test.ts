/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { constObservable, ValueWithChangeEventFromObservable } from '../../../../../base/common/observable.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeReviewResult, IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { AgentActionRequest, IClaudeActionService } from '../../../../../platform/claude/common/claudeActions.js';
import { ClaudeReviewRequest } from '../../../../../platform/claude/common/claudeReviewLoop.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewDelegate, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IResourceEditorInput, TextEditorSelectionRevealType } from '../../../../../platform/editor/common/editor.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { ClaudeVerifyEvidenceService, IClaudeVerifyEvidenceService } from '../../../../services/claude/common/claudeVerifyEvidenceService.js';
import { buildTurnReview, IClaudeReviewService, ReviewPendingSummary, ReviewScope, TurnReview } from '../../../../services/claude/common/claudeReview.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { TestEditorGroupView, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IMultiDiffSourceResolverService, MultiDiffSourceResolverService } from '../../../multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { ClaudeReviewEditor, ClaudeReviewInput, REVIEW_DIFF_OPTIONS } from '../../browser/review/claudeReviewEditor.js';
import { IClaudeReviewBotService } from '../../browser/review/claudeReviewBotService.js';
import { claudeReviewEntries, claudeReviewSourceUri, ClaudeReviewSourceResolver, parseClaudeReviewSourceUri } from '../../browser/review/claudeReviewSource.js';
import { CLAUDE_COMMIT_ACCEPTED_COMMAND_ID } from '../../common/claudeViews.js';

const A = URI.file('/repo/src/todo.ts');
const B = URI.file('/repo/src/list.ts');
const C = URI.file('/repo/src/clear.ts');

/** Turn 1 edits todo.ts and list.ts; turn 2 edits todo.ts again and creates clear.ts. */
function reviews(): TurnReview[] {
	return [
		buildTurnReview('s1', 't1', [
			{ uri: A, originalText: 'a\nb\n', modifiedText: 'a\nB\n', existed: true },
			{ uri: B, originalText: 'x\n', modifiedText: 'x\ny\n', existed: true },
		]),
		buildTurnReview('s1', 't2', [
			{ uri: A, originalText: 'a\nB\n', modifiedText: 'a\nB\nc\n', existed: true },
			{ uri: C, originalText: '', modifiedText: 'clear\n', existed: false },
		]),
	];
}

class FakeReviewService {
	readonly calls: string[] = [];
	private readonly _onDidChangeReview = new Emitter<{ readonly sessionId: string }>();
	readonly onDidChangeReview = this._onDidChangeReview.event;
	readonly onDidChangeSignals = Event.None;

	setSignals(): void { }

	signals(): never[] {
		return [];
	}

	recordFindingSignal(): undefined {
		return undefined;
	}

	resolveFindingSignal(): void { }

	constructor(private readonly _reviews: TurnReview[]) { }

	dispose(): void {
		this._onDidChangeReview.dispose();
	}

	reviewsFor(): readonly TurnReview[] {
		return this._reviews;
	}

	async ensureTurn(_sessionId: string, turnId: string): Promise<TurnReview | undefined> {
		return this.get('s1', turnId);
	}

	get(_sessionId: string, turnId: string): TurnReview | undefined {
		return this._reviews.find(review => review.turnId === turnId);
	}

	acceptFile(_sessionId: string, turnId: string, uri: URI): void {
		this.setState(turnId, uri, 'accepted', 'keep');
	}

	async rejectFile(_sessionId: string, turnId: string, uri: URI): Promise<void> {
		this.setState(turnId, uri, 'rejected', 'undo');
	}

	acceptAll(_sessionId: string, turnId: string): void {
		this.calls.push(`keep all ${turnId}`);
	}

	async rejectAll(_sessionId: string, turnId: string): Promise<void> {
		this.calls.push(`undo all ${turnId}`);
	}

	pendingSummary(scope: ReviewScope): ReviewPendingSummary {
		const turns = this._reviews.filter(review => scope.kind !== 'turn' || review.turnId === scope.turnId);
		const pending = turns.flatMap(review => review.files.filter(file => file.state !== 'accepted' && file.state !== 'rejected').map(file => ({ review, file })));
		const uris = [...new Map(pending.map(({ file }) => [file.uri.toString(), file.uri])).values()];
		return {
			hunks: pending.reduce((sum, { file }) => sum + file.hunks.length, 0),
			files: uris.length,
			turns: new Set(pending.map(({ review }) => review.turnId)).size,
			chats: pending.length ? 1 : 0,
			sessionIds: pending.length ? ['s1'] : [],
			uris,
		};
	}

	keepAllPending(scope: ReviewScope): number {
		this.calls.push(`keep ${scope.kind}`);
		return 0;
	}

	private setState(turnId: string, uri: URI, state: 'accepted' | 'rejected', verb: string): void {
		const file = this.get('s1', turnId)?.files.find(candidate => candidate.uri.toString() === uri.toString());
		if (file) {
			file.state = state;
		}
		this.calls.push(`${verb} ${turnId} ${uri.path}`);
		this._onDidChangeReview.fire({ sessionId: 's1' });
	}
}

suite('Claude review editor', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiation: TestInstantiationService;
	let review: FakeReviewService;
	let runs: AgentActionRequest[];
	let commands: unknown[][];
	let selected: string[];

	setup(() => {
		instantiation = workbenchInstantiationService(undefined, store);
		review = store.add(new FakeReviewService(reviews()));
		runs = [];
		commands = [];
		selected = [];
		instantiation.stub(IClaudeReviewService, review as unknown as IClaudeReviewService);
		instantiation.stub(IClaudeVerifyEvidenceService, store.add(new ClaudeVerifyEvidenceService()));
		instantiation.stub(IClaudeAgentService, {
			onDidChangeSession: Event.None,
			getSessions: () => [{ id: 's1', title: 'Add clear()' }],
			getCurrentSession: () => ({ id: 'other' }),
			selectSession: (id: string) => { selected.push(id); },
			getViewState: () => ({ turns: [{ id: 't1', changedFiles: [A, B] }, { id: 't2', changedFiles: [A, C] }] }),
		} as unknown as IClaudeAgentService);
		instantiation.stub(IClaudeActionService, { run: async (request: AgentActionRequest) => { runs.push(request); } } as unknown as IClaudeActionService);
		instantiation.stub(ICommandService, { executeCommand: async (...args: unknown[]) => { commands.push(args); } } as unknown as ICommandService);
		instantiation.stub(IViewsService, { openView: async () => undefined } as unknown as IViewsService);
		// No structured review pass unless a test gives one: Review then asks in the chat.
		instantiation.stub(IClaudeRuntimeService, {} as unknown as IClaudeRuntimeService);
		instantiation.stub(IClaudeReviewBotService, {} as unknown as IClaudeReviewBotService);
		// The header is under test here, not the upstream diff widget, so the widget gets an empty file list.
		const resolvers = new MultiDiffSourceResolverService();
		store.add(resolvers.registerResolver({
			canHandleUri: () => true,
			resolveDiffSource: async () => ({ resources: new ValueWithChangeEventFromObservable(constObservable([])) }),
		}));
		instantiation.stub(IMultiDiffSourceResolverService, resolvers);
		instantiation.stub(IContextViewService, {
			showContextView: (delegate: IContextViewDelegate) => {
				const host = document.createElement('div');
				document.body.appendChild(host);
				const rendered = delegate.render(host);
				return { close: () => { rendered?.dispose(); host.remove(); delegate.onHide?.(); } };
			},
			hideContextView: () => undefined,
		} as unknown as IContextViewService);
	});

	async function open(turnId: string | undefined) {
		const editor = store.add(instantiation.createInstance(ClaudeReviewEditor, new TestEditorGroupView(0)));
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		store.add({ dispose: () => parent.remove() });
		editor.create(parent);
		const input = store.add(instantiation.createInstance(ClaudeReviewInput, 's1', turnId));
		await editor.setInput(input, undefined, {}, CancellationToken.None);
		store.add({ dispose: () => editor.clearInput() });
		const header = () => ({
			scope: [...parent.querySelectorAll('.claude-review-scope button')].map(button => `${button.textContent}${button.classList.contains('is-active') ? '*' : ''}`),
			summary: parent.querySelector('.claude-review-summary')?.textContent,
			commit: parent.querySelector<HTMLButtonElement>('.claude-review-commit')!.disabled,
		});
		return { editor, parent, input, header };
	}

	test('All Changes merges a file across turns from its first snapshot and leaves out files every turn undid', () => {
		const turns = reviews();
		turns[0].files[0].state = 'accepted';
		turns[0].files[1].state = 'rejected';
		assert.deepStrictEqual(claudeReviewEntries(turns).map(entry => ({
			name: entry.name,
			turns: entry.turnIds,
			original: entry.original && parseClaudeSnapshot(entry.original),
			stat: `+${entry.added} -${entry.removed}`,
			state: entry.state,
		})), [
			{ name: 'todo.ts', turns: ['t1', 't2'], original: 't1#review', stat: '+2 -1', state: 'mixed' },
			{ name: 'clear.ts', turns: ['t2'], original: undefined, stat: '+1 -0', state: 'pending' },
		]);
	});

	test('the review diff editors have no minimap, so no wide slider sits beside the change marks (#963)', () => {
		assert.deepStrictEqual(REVIEW_DIFF_OPTIONS.minimap, { enabled: false });
	});

	test('the source URI names the chat and, for one turn, the turn', () => {
		assert.deepStrictEqual([
			parseClaudeReviewSourceUri(claudeReviewSourceUri({ sessionId: 's1', turnId: 't 2' })),
			parseClaudeReviewSourceUri(claudeReviewSourceUri({ sessionId: 's1' })),
			parseClaudeReviewSourceUri(URI.file('/s1')),
		], [{ sessionId: 's1', turnId: 't 2' }, { sessionId: 's1' }, undefined]);
	});

	test('the file list follows Keep and Undo and keeps the item of an unchanged file', async () => {
		const resolvers = new MultiDiffSourceResolverService();
		instantiation.stub(IMultiDiffSourceResolverService, resolvers);
		store.add(instantiation.createInstance(ClaudeReviewSourceResolver));
		const source = await resolvers.resolve(claudeReviewSourceUri({ sessionId: 's1' }));
		const files = () => source!.resources.value.map(item => `${item.modifiedUri!.path.split('/').pop()} ${item.originalUri ? parseClaudeSnapshot(item.originalUri) : 'new'} ${item.contextKeys?.klawlyReviewFileState}`);
		const before = source!.resources.value;
		const first = files();
		review.acceptFile('s1', 't1', A);
		await review.rejectFile('s1', 't1', B);
		assert.deepStrictEqual({ first, after: files(), clearItemKept: source!.resources.value[1] === before[2] }, {
			first: ['todo.ts t1#review pending', 'list.ts t1#review pending', 'clear.ts new pending'],
			after: ['todo.ts t1#review mixed', 'clear.ts new pending'],
			clearItemKept: true,
		});
	});

	test('the file list leaves out files a nested review.json ignores, and the header names them (#1038)', async () => {
		const configs = new Map([
			['/repo/.claude/review.json', '{"ignore":["src/clear.ts"]}'],
			['/repo/src/.claude/review.json', '{"ignore":["list.ts"]}'],
		]);
		instantiation.stub(IWorkspaceContextService, { getWorkspaceFolder: () => ({ uri: URI.file('/repo') }) } as unknown as IWorkspaceContextService);
		instantiation.stub(IFileService, {
			readFile: async (resource: URI) => {
				const text = configs.get(resource.path);
				if (text === undefined) {
					throw new Error('not found');
				}
				return { value: VSBuffer.fromString(text) };
			},
		} as unknown as IFileService);
		const resolvers = new MultiDiffSourceResolverService();
		instantiation.stub(IMultiDiffSourceResolverService, resolvers);
		store.add(instantiation.createInstance(ClaudeReviewSourceResolver));
		const source = await resolvers.resolve(claudeReviewSourceUri({ sessionId: 's1' }));
		assert.deepStrictEqual(source!.resources.value.map(item => item.modifiedUri!.path), ['/repo/src/todo.ts']);
	});

	test('the header switches between the turn and every turn, and commits one turn of kept changes', async () => {
		const { editor, parent, input, header } = await open('t2');
		const turn = header();
		parent.querySelectorAll<HTMLButtonElement>('.claude-review-scope button')[1].click();
		await new Promise(resolve => setTimeout(resolve, 0));
		const all = header();
		editor.keepFile(A);
		const keptInTwoTurns = header();
		await editor.show('t2', 'turn');
		const keptInTurn = header();
		parent.querySelector<HTMLButtonElement>('.claude-review-commit')!.click();
		await Promise.resolve();
		assert.deepStrictEqual({ name: input.getName(), description: input.getDescription(), title: input.getTitle(), turn, all, keptInTwoTurns, keptInTurn, calls: review.calls, commands }, {
			name: 'Review',
			description: 'Add clear()',
			title: 'Review: Add clear()',
			turn: { scope: ['This Turn*', 'All Changes'], summary: '2 files+2', commit: true },
			all: { scope: ['This Turn', 'All Changes*'], summary: '3 files+4−1', commit: true },
			keptInTwoTurns: { scope: ['This Turn', 'All Changes*'], summary: '3 files+4−1', commit: true },
			keptInTurn: { scope: ['This Turn*', 'All Changes'], summary: '2 files+2', commit: false },
			calls: ['keep t1 /repo/src/todo.ts', 'keep t2 /repo/src/todo.ts'],
			commands: [[CLAUDE_COMMIT_ACCEPTED_COMMAND_ID, 't2', 's1']],
		});
	});

	test('Keep says what it keeps, and its menu widens the scope from the turn to the chat or everything (issue 706)', async () => {
		const { parent } = await open('t2');
		const keep = () => parent.querySelector<HTMLButtonElement>('.claude-review-keep > .main')!;
		const turn = keep().textContent;
		parent.querySelector<HTMLButtonElement>('.claude-review-keep > .more')!.click();
		const rows = [...document.querySelectorAll<HTMLButtonElement>('.claude-review-keep-menu .claude-menu-item')];
		const menu = rows.map(row => `${row.querySelector('.label')?.textContent}${row.getAttribute('aria-checked') === 'true' ? '*' : ''}`);
		rows.find(row => row.dataset.scope === 'all')!.click();
		const everything = keep().textContent;
		keep().click();
		assert.deepStrictEqual({ turn, menu, everything, calls: review.calls }, {
			turn: 'Keep 2 Changes in 2 Files',
			menu: ['This Turn*', 'This Chat', 'Everything', 'Keep 2 Changes in 2 Files', 'Undo 2 Changes in 2 Files'],
			everything: 'Keep 4 Changes in 3 Files',
			calls: ['keep all'],
		});
	});

	test('Review and Security Review send the shown diff to the review chat; Undo goes newest turn first', async () => {
		const { editor, parent } = await open(undefined);
		parent.querySelector<HTMLButtonElement>('.claude-review-ask > .main')!.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		await editor.askClaude('securityReviewChanges');
		await editor.undoFile(A);
		assert.deepStrictEqual({
			runs: runs.map(run => ({ id: run.id, kinds: run.attachments.map(attachment => attachment.kind), files: [...new Set((run.attachments[0] as { text: string }).text.match(/src\/\w+\.ts/g))] })),
			selected,
			calls: review.calls,
		}, {
			runs: [
				{ id: 'reviewTurnChanges', kinds: ['pasted-text'], files: ['src/todo.ts', 'src/list.ts', 'src/clear.ts'] },
				{ id: 'securityReviewChanges', kinds: ['pasted-text'], files: ['src/todo.ts', 'src/list.ts', 'src/clear.ts'] },
			],
			selected: ['s1', 's1'],
			calls: ['undo t2 /repo/src/todo.ts', 'undo t1 /repo/src/todo.ts'],
		});
	});

	test('Open File opens the file at the first change the shown turns made (issue 354)', async () => {
		const opened: unknown[] = [];
		instantiation.stub(IEditorService, 'openEditor', async (editor: IResourceEditorInput) => { opened.push({ path: editor.resource.path, ...editor.options }); return undefined; });
		const { editor } = await open(undefined);
		await editor.openFile(A);
		await editor.openFile(C);
		await editor.show('t2', 'turn');
		await editor.openFile(A);
		const reveal = TextEditorSelectionRevealType.CenterIfOutsideViewport;
		assert.deepStrictEqual(opened, [
			{ path: '/repo/src/todo.ts', pinned: true, selection: { startLineNumber: 2, startColumn: 1 }, selectionRevealType: reveal },
			{ path: '/repo/src/clear.ts', pinned: true, selection: { startLineNumber: 1, startColumn: 1 }, selectionRevealType: reveal },
			{ path: '/repo/src/todo.ts', pinned: true, selection: { startLineNumber: 3, startColumn: 1 }, selectionRevealType: reveal },
		]);
	});

	test('line comments collect in the tray and go to the agent as one queued message of references (issue 431)', async () => {
		const queued: unknown[] = [];
		instantiation.stub(IClaudeAgentService, 'supportsSteer', async () => false);
		instantiation.stub(IClaudeAgentService, 'queue', async (sessionId: string, text: string, cwd: string, behavior: string, options: { label?: string }) => {
			queued.push({ sessionId, text, cwd: typeof cwd, behavior, label: options.label });
		});
		const { editor, parent } = await open(undefined);
		const tray = () => ({
			shown: !parent.querySelector('.claude-review-feedback')!.classList.contains('is-empty'),
			title: parent.querySelector('.claude-review-feedback-head .title')?.textContent,
			rows: [...parent.querySelectorAll('.claude-review-feedback-item')].map(row => `${row.querySelector('.reference')?.textContent} ${row.querySelector('.text')?.textContent}`),
		});
		const empty = tray();
		editor.addFeedback({ id: 'b', path: 'src/todo.ts', startLine: 9, endLine: 9, text: 'Keep the old name.', turnId: 't2' }, undefined, A);
		editor.addFeedback({ id: 'a', path: 'src/todo.ts', startLine: 2, endLine: 3, text: 'Guard against an empty list.', turnId: 't1' }, undefined, A);
		const collected = tray();
		await editor.sendFeedback();
		assert.deepStrictEqual({ empty, collected, queued, selected, after: tray() }, {
			empty: { shown: false, title: '0 comments for Claude', rows: [] },
			collected: { shown: true, title: '2 comments for Claude', rows: ['src/todo.ts:2-3 Guard against an empty list.', 'src/todo.ts:9 Keep the old name.'] },
			queued: [{
				sessionId: 's1',
				text: 'I left review comments on your changes. Address each one, then say what you changed.\n\n- src/todo.ts:2-3\n  Guard against an empty list.\n- src/todo.ts:9\n  Keep the old name.',
				cwd: 'string',
				behavior: 'queue',
				label: '2 review comments',
			}],
			selected: ['s1'],
			after: { shown: false, title: '0 comments for Claude', rows: [] },
		});
	});

	test('the structured review lists findings worst first; Fix with Agent sends one, Dismiss drops one, prose goes to the chat (issue 431)', async () => {
		const queued: unknown[] = [];
		const diffs: boolean[] = [];
		instantiation.stub(IClaudeAgentService, 'supportsSteer', async () => false);
		instantiation.stub(IClaudeAgentService, 'queue', async (sessionId: string, text: string, _cwd: string, behavior: string, options: { label?: string }) => {
			queued.push({ sessionId, text, behavior, label: options.label });
		});
		const answers: ClaudeReviewResult[] = [
			{
				ok: true, event: {
					type: 'review.findings', sessionId: 's1', reviewId: 'r1', findings: [
						{ file: 'src/list.ts', startLine: 2, endLine: 2, severity: 'low', category: 'bug' as const, title: 'Name the constant', body: '' },
						{ file: 'src/todo.ts', startLine: 3, endLine: 3, severity: 'high', category: 'bug' as const, title: 'Index out of range', body: 'items[3] is past the end.', suggestion: 'items.at(-1)' },
					]
				}
			},
			{ ok: false, reviewId: 'r2', failure: { kind: 'malformed', text: 'Looks fine to me.' } },
		];
		instantiation.stub(IClaudeRuntimeService, {
			reviewChanges: async (request: ClaudeReviewRequest) => {
				diffs.push(request.diff.includes('src/todo.ts'));
				return answers.shift()!;
			},
		} as unknown as IClaudeRuntimeService);
		const { editor, parent } = await open(undefined);
		const bar = () => ({
			shown: !parent.querySelector('.claude-review-findings')!.classList.contains('is-empty'),
			title: parent.querySelector('.claude-review-findings-head .title')?.textContent,
			rows: [...parent.querySelectorAll('.claude-review-findings-item')].map(row => `${row.classList.contains('is-high') ? 'high' : 'low'} ${row.querySelector('.reference')?.textContent} ${row.querySelector('.text')?.textContent}`),
		});
		await editor.review();
		const found = bar();
		await editor.fixFinding(editor.findings.find(item => item.finding.severity === 'high')!.id);
		const afterFix = bar();
		parent.querySelector<HTMLButtonElement>('.claude-review-findings-item button.claude-icon-btn[aria-label="Dismiss"]')!.click();
		const afterDismiss = bar();
		await editor.review();
		assert.deepStrictEqual({ diffs, found, afterFix, afterDismiss, queued, runs: runs.map(run => run.id) }, {
			diffs: [true, true],
			found: { shown: true, title: '2 findings', rows: ['high src/todo.ts:3 Index out of range', 'low src/list.ts:2 Name the constant'] },
			afterFix: { shown: true, title: '1 finding', rows: ['low src/list.ts:2 Name the constant'] },
			afterDismiss: { shown: false, title: '0 findings', rows: [] },
			queued: [{
				sessionId: 's1',
				text: 'I left a review comment on your changes. Address it, then say what you changed.\n\n- src/todo.ts:3\n  Index out of range\n  items[3] is past the end.\n  Suggested fix:\n  items.at(-1)',
				behavior: 'queue',
				label: 'Fix: Index out of range',
			}],
			runs: ['reviewTurnChanges'],
		});
	});
	test('the readiness chip and its reason carry the whole reason as aria-label and hover, past the ellipsis (issue 1126)', async () => {
		const reason = 'Touches the auth flow and has no test covering the new token refresh path, so a person should read it first.';
		instantiation.stub(IClaudeRuntimeService, {
			reviewChanges: async () => ({ ok: true, event: { type: 'review.findings', sessionId: 's1', reviewId: 'r1', findings: [], readiness: { score: 3, reason } } }),
		} as unknown as IClaudeRuntimeService);
		const { editor, parent } = await open(undefined);
		await editor.review();
		const full = 'Merge readiness 3/5: ' + reason;
		const reasonElement = parent.querySelector<HTMLElement>('.claude-review-summary .readiness-reason');
		assert.deepStrictEqual({
			chip: parent.querySelector('.claude-review-summary .readiness')?.getAttribute('aria-label'),
			reasonName: reasonElement?.getAttribute('aria-label'),
			reasonDescription: reasonElement?.getAttribute('aria-description'),
			focusable: [reasonElement?.tabIndex, reasonElement?.getAttribute('role')],
			text: reasonElement?.textContent,
		}, { chip: null, reasonName: reason, reasonDescription: full, focusable: [0, 'note'], text: reason });
	});
});

function parseClaudeSnapshot(uri: URI): string {
	return `${new URLSearchParams(uri.query).get('turn')}#${uri.fragment}`;
}
