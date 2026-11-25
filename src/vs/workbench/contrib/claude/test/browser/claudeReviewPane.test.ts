/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditor, IOverlayWidget } from '../../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { EndOfLinePreference, IModelDeltaDecoration, ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorPane, IEditorCloseEvent } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService, IUntypedEditorReplacement } from '../../../../services/editor/common/editorService.js';
import { IClaudeCheckpointService } from '../../../../services/claude/common/claudeCheckpointService.js';
import { ClaudeReviewService, claudeSnapshotUri } from '../../../../services/claude/common/claudeReview.js';
import { ClaudeReviewDecorationContribution, ClaudeReviewPane, ClaudeSnapshotContentProvider } from '../../browser/review/claudeReviewPane.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';

suite('Claude review pane', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('the snapshot provider resolves the pre-turn text and the overlay leaves when the input closes', async () => {
		const uri = URI.file('C:/repo/src/auth.ts');
		const live = disposables.add(createTextModel('after\n', null, undefined, uri));
		const review = disposables.add(new ClaudeReviewService(emptyCheckpoints(), {
			createModelReference: async () => ({ object: { textEditorModel: live }, dispose() { } }),
		} as unknown as ITextModelService, { del: async () => undefined } as never, { isDirty: () => false, revert: async () => undefined } as never, new TestConfigurationService()));
		review.replaceTurn('session-1', 'turn-1', [{ uri, originalText: 'before\n', modifiedText: 'after\n', existed: true }]);
		const snapshot = claudeSnapshotUri(uri, 'session-1', 'turn-1');

		const models = new Map<string, ReturnType<typeof createTextModel>>();
		const registered: string[] = [];
		const provider = disposables.add(new ClaudeSnapshotContentProvider(
			{
				registerTextModelContentProvider: (scheme: string) => {
					registered.push(scheme);
					return { dispose() { } };
				},
			} as unknown as ITextModelService,
			{
				getModel: (resource: URI) => models.get(resource.toString()) ?? null,
				createModel: (value: string, _language: unknown, resource: URI) => {
					const model = disposables.add(createTextModel(value, null, undefined, resource));
					models.set(resource.toString(), model);
					return model;
				},
			} as unknown as IModelService,
			review,
		));
		assert.deepStrictEqual(registered, ['claude-snapshot']);
		const resolved = await provider.provideTextContent(snapshot);
		assert.strictEqual(resolved?.getValue(EndOfLinePreference.LF), 'before\n');

		const onDidCloseEditor = disposables.add(new Emitter<IEditorCloseEvent>());
		const onDidActiveEditorChange = disposables.add(new Emitter<void>());
		const onWillDispose = disposables.add(new Emitter<void>());
		const container = document.createElement('div');
		const input = { onWillDispose: onWillDispose.event, resource: snapshot } as unknown as EditorInput;
		const pane = {
			input,
			getControl: () => ({ getContainerDomNode: () => container }),
		} as unknown as IEditorPane;
		let opened: { original?: { resource?: URI }; modified?: { resource?: URI } } | undefined;
		const editors = {
			onDidCloseEditor: onDidCloseEditor.event,
			onDidActiveEditorChange: onDidActiveEditorChange.event,
			visibleEditorPanes: [pane],
			openEditor: async (editor: { original?: { resource?: URI }; modified?: { resource?: URI } }) => {
				opened = editor;
				const model = await provider.provideTextContent(editor.original!.resource!);
				assert.strictEqual(model?.getValue(EndOfLinePreference.LF), 'before\n');
				return pane;
			},
		} as unknown as IEditorService;
		const notifications: string[] = [];
		const surface = disposables.add(new ClaudeReviewPane(
			editors,
			{ getModel: (resource: URI) => models.get(resource.toString()) ?? null } as unknown as IModelService,
			review,
			{ error: (message: string) => { notifications.push(message); } } as unknown as INotificationService,
			{ executeCommand: async () => undefined } as unknown as ICommandService,
			{ exists: async () => true } as unknown as IFileService,
			{ lookupKeybinding: () => undefined } as unknown as IKeybindingService,
		));
		await surface.openFile('session-1', 'turn-1', uri, false);
		assert.strictEqual(opened?.original?.resource?.scheme, 'claude-snapshot');
		assert.strictEqual(opened?.modified?.resource?.toString(), uri.toString());
		assert.ok(container.querySelector('.claude-review-overlay'));
		assert.strictEqual(notifications.length, 0);

		onWillDispose.fire();
		assert.strictEqual(container.querySelector('.claude-review-overlay'), null);
		assert.strictEqual(models.get(snapshot.toString())?.isDisposed(), true);
	});

	test('a pending change gets a tint and an Undo / Keep chip at its top, which follow the cursor keys', async () => {
		const uri = URI.file('C:/repo/src/auth.ts');
		const live = disposables.add(createTextModel('a\nB\nX\nc\n', null, undefined, uri));
		const review = disposables.add(new ClaudeReviewService(emptyCheckpoints(), {
			createModelReference: async () => ({ object: { textEditorModel: live }, dispose() { } }),
		} as unknown as ITextModelService, { del: async () => undefined } as never, { isDirty: () => false, revert: async () => undefined } as never, new TestConfigurationService()));
		review.replaceTurn('session-1', 'turn-1', [{ uri, originalText: 'a\nb\nc\n', modifiedText: 'a\nB\nX\nc\n', existed: true }]);
		const editor = fakeCodeEditor(live, false);
		const keyValues: boolean[] = [];
		const contextKeys = {
			createKey: () => ({ set: (value: boolean) => { keyValues.push(value); }, get: () => keyValues.at(-1), reset: () => { keyValues.push(false); } }),
			getContextKeyValue: () => undefined,
		} as unknown as IContextKeyService;
		const keybindings = {
			lookupKeybinding: (id: string) => ({ getLabel: () => id.includes('keep') ? 'Alt+Y' : 'Alt+N' }),
		} as unknown as IKeybindingService;
		const warnings: string[] = [];
		const notifications = { warn: (message: string) => { warnings.push(message); } } as unknown as INotificationService;
		const contribution = disposables.add(new ClaudeReviewDecorationContribution(editor.editor, review, contextKeys, keybindings, notifications));

		const chips = () => editor.widgets().map(node => [node.className, ...[...node.getElementsByTagName('button')].map(button => `${button.className}:${button.getElementsByClassName('label')[0]?.textContent}:${button.getAttribute('aria-keyshortcuts')}`)].join(' '));
		const initial = {
			decorations: editor.decorations().map(decoration => `${decoration.range.startLineNumber}-${decoration.range.endLineNumber} ${decoration.options.className}`),
			chips: chips(),
			top: editor.tops(),
			atCursor: keyValues.at(-1),
		};
		editor.moveCursor(3);
		const onLine3 = keyValues.at(-1);
		editor.moveCursor(4);
		const underChange = keyValues.at(-1);
		editor.moveCursor(5);
		const pastChips = keyValues.at(-1);

		editor.moveCursor(2);
		const changed = Event.toPromise(review.onDidChangeReview);
		assert.strictEqual(contribution.undoAtCursor(), true);
		await changed;
		const undone = { text: live.getValue(EndOfLinePreference.LF), chips: chips(), decorations: editor.decorations().length, atCursor: keyValues.at(-1), warnings };

		assert.deepStrictEqual({ initial, onLine3, underChange, pastChips, undone }, {
			initial: {
				decorations: ['2-3 claude-review-added'],
				chips: ['claude-hunk-actions is-chip :Undo:Alt+N accept:Keep:Alt+Y'],
				top: [18 + 2],
				atCursor: false,
			},
			onLine3: true,
			underChange: true,
			pastChips: false,
			undone: { text: 'a\nb\nc\n', chips: [], decorations: 0, atCursor: false, warnings: [] },
		});
	});

	test('the chip of a deletion sits at the top of the line after the removed text', () => {
		const uri = URI.file('C:/repo/src/auth.ts');
		const live = disposables.add(createTextModel('a\nc\nd\n', null, undefined, uri));
		const review = disposables.add(new ClaudeReviewService(emptyCheckpoints(), {
			createModelReference: async () => ({ object: { textEditorModel: live }, dispose() { } }),
		} as unknown as ITextModelService, { del: async () => undefined } as never, { isDirty: () => false, revert: async () => undefined } as never, new TestConfigurationService()));
		review.replaceTurn('session-1', 'turn-1', [{ uri, originalText: 'a\nb\nc\nd\n', modifiedText: 'a\nc\nd\n', existed: true }]);
		const contextKeys = { createKey: () => ({ set() { }, get: () => false, reset() { } }), getContextKeyValue: () => undefined } as unknown as IContextKeyService;
		const keybindings = { lookupKeybinding: () => undefined } as unknown as IKeybindingService;
		const editor = fakeCodeEditor(live, false);
		disposables.add(new ClaudeReviewDecorationContribution(editor.editor, review, contextKeys, keybindings, {} as INotificationService));

		assert.deepStrictEqual(editor.tops(), [18 + 2]);
	});

	test('Keep accepts the change, and the diff editor gets only the gutter mark', () => {
		const uri = URI.file('C:/repo/src/auth.ts');
		const live = disposables.add(createTextModel('a\nB\nc\n', null, undefined, uri));
		const review = disposables.add(new ClaudeReviewService(emptyCheckpoints(), {
			createModelReference: async () => ({ object: { textEditorModel: live }, dispose() { } }),
		} as unknown as ITextModelService, { del: async () => undefined } as never, { isDirty: () => false, revert: async () => undefined } as never, new TestConfigurationService()));
		review.replaceTurn('session-1', 'turn-1', [{ uri, originalText: 'a\nb\nc\n', modifiedText: 'a\nB\nc\n', existed: true }]);
		const contextKeys = { createKey: () => ({ set() { }, get: () => false, reset() { } }), getContextKeyValue: () => undefined } as unknown as IContextKeyService;
		const keybindings = { lookupKeybinding: () => undefined } as unknown as IKeybindingService;
		const notifications = {} as INotificationService;

		const diff = fakeCodeEditor(live, true);
		disposables.add(new ClaudeReviewDecorationContribution(diff.editor, review, contextKeys, keybindings, notifications));
		const normal = fakeCodeEditor(live, false);
		disposables.add(new ClaudeReviewDecorationContribution(normal.editor, review, contextKeys, keybindings, notifications));
		const before = {
			diff: diff.decorations().map(decoration => `${decoration.options.linesDecorationsClassName}|${decoration.options.className}`),
			diffChips: diff.widgets().length,
			normalChips: normal.widgets().length,
		};
		[...normal.widgets()[0].getElementsByClassName('accept')].forEach(button => (button as HTMLElement).click());

		assert.deepStrictEqual({ before, state: review.get('session-1', 'turn-1')?.files[0].hunks.map(hunk => hunk.state), chips: normal.widgets().length, marks: normal.decorations().length }, {
			before: { diff: ['claude-review-gutter|undefined'], diffChips: 0, normalChips: 1 },
			state: ['accepted'],
			chips: 0,
			marks: 0,
		});
	});

	test('the changed side of a diff in the review editor gets chips and cursor keys but no tint (issue 355)', () => {
		const uri = URI.file('C:/repo/src/auth.ts');
		const live = disposables.add(createTextModel('a\nB\nc\n', null, undefined, uri));
		const review = disposables.add(new ClaudeReviewService(emptyCheckpoints(), {
			createModelReference: async () => ({ object: { textEditorModel: live }, dispose() { } }),
		} as unknown as ITextModelService, { del: async () => undefined } as never, { isDirty: () => false, revert: async () => undefined } as never, new TestConfigurationService()));
		review.replaceTurn('session-1', 'turn-1', [{ uri, originalText: 'a\nb\nc\n', modifiedText: 'a\nB\nc\n', existed: true }]);
		const keyValues: boolean[] = [];
		const contextKeys = {
			createKey: () => ({ set: (value: boolean) => { keyValues.push(value); }, get: () => keyValues.at(-1), reset() { } }),
			getContextKeyValue: (key: string) => key === 'klawlyReviewEditor' ? true : undefined,
		} as unknown as IContextKeyService;
		const keybindings = { lookupKeybinding: (id: string) => ({ getLabel: () => id.includes('keep') ? 'Alt+Y' : 'Alt+N' }) } as unknown as IKeybindingService;
		const diff = fakeCodeEditor(live, true);
		const contribution = disposables.add(new ClaudeReviewDecorationContribution(diff.editor, review, contextKeys, keybindings, {} as INotificationService));
		const before = {
			marks: diff.decorations().map(decoration => `${decoration.options.linesDecorationsClassName}|${decoration.options.className}`),
			chips: diff.widgets().map(node => [...node.getElementsByTagName('button')].map(button => button.getAttribute('aria-keyshortcuts')).join(' ')),
		};
		diff.moveCursor(2);
		const atCursor = keyValues.at(-1);
		const kept = contribution.keepAtCursor();

		assert.deepStrictEqual({ before, atCursor, kept, state: review.get('session-1', 'turn-1')?.files[0].hunks.map(hunk => hunk.state), chips: diff.widgets().length }, {
			before: { marks: ['claude-review-gutter|undefined'], chips: ['Alt+N Alt+Y'] },
			atCursor: true,
			kept: true,
			state: ['accepted'],
			chips: 0,
		});
	});

	test('Reject File moves the review on to the next file even when undoing deletes the file, and Accept File on the last one leaves the plain file open', async () => {
		const { log, review, click, open } = reviewPaneHarness(disposables, { firstIsNew: true });

		await open();
		await click('Reject File', 3);
		await click('Accept File', 4);

		assert.deepStrictEqual({
			log,
			states: review.get('session-1', 'turn-1')?.files.map(file => file.state),
		}, {
			log: ['open a.ts (review)', 'delete a.ts', 'open b.ts (review)', 'replace b.ts (review) with b.ts'],
			states: ['rejected', 'accepted'],
		});
	});

	test('leaving a settled file with unsaved edits swaps its diff for the plain file without a save prompt (issue 349)', async () => {
		const { log, click, open } = reviewPaneHarness(disposables, { dirty: true });
		await open();
		await click('Accept File', 3);

		assert.deepStrictEqual(log, ['open a.ts (review)', 'replace a.ts (review) with a.ts', 'open b.ts (review)']);
	});

	test('Accept File puts the next diff in place of the settled one, so it stays in that group even when the diff was its only editor', async () => {
		const { log, click, open } = reviewPaneHarness(disposables, {});
		await open();
		await click('Accept File', 3);
		await click('Accept File', 4);

		assert.deepStrictEqual(log, ['open a.ts (review)', 'replace a.ts (review) with b.ts (review)', 'open b.ts (review) in group 1', 'replace b.ts (review) with b.ts']);
	});
});

/**
 * A review pane on a turn that changed `a.ts` and `b.ts`, with editor fakes that
 * log what opens, closes and is replaced. `dirty` gives the review diffs unsaved
 * edits, and `firstIsNew` makes `a.ts` a file the turn created, so undoing it
 * deletes it.
 */
function reviewPaneHarness(disposables: Pick<DisposableStore, 'add'>, options: { firstIsNew?: boolean; dirty?: boolean }) {
	const log: string[] = [];
	const panes: IEditorPane[] = [];
	const closers = new Map<EditorInput, Emitter<void>>();
	const name = (resource: URI | undefined) => resource?.path.split('/').pop();
	const label = (editor: ReviewEditor) => editor.original ? `${name(editor.modified?.resource)} (review)` : name(editor.resource);
	const first = URI.file('C:/repo/src/a.ts');
	const second = URI.file('C:/repo/src/b.ts');
	const live = new Map([first, second].map(uri => [uri.toString(), disposables.add(createTextModel('after\n', null, undefined, uri))]));
	const review = disposables.add(new ClaudeReviewService(emptyCheckpoints(), {
		createModelReference: async (resource: URI) => ({ object: { textEditorModel: live.get(resource.toString()) }, dispose() { } }),
	} as unknown as ITextModelService, {
		// Deleting a file closes its editor, as the workbench does.
		del: async (resource: URI) => {
			log.push(`delete ${name(resource)}`);
			closers.get(panes[0].input!)?.fire();
		},
	} as never, { isDirty: () => false, revert: async () => undefined } as never, new TestConfigurationService()));
	review.replaceTurn('session-1', 'turn-1', [
		{ uri: first, originalText: options.firstIsNew ? '' : 'before\n', modifiedText: 'after\n', existed: !options.firstIsNew },
		{ uri: second, originalText: 'before\n', modifiedText: 'after\n', existed: true },
	]);

	const onDidCloseEditor = disposables.add(new Emitter<IEditorCloseEvent>());
	const onDidActiveEditorChange = disposables.add(new Emitter<void>());
	const group = {
		id: 1,
		closeEditor: async (editor: EditorInput) => {
			log.push(`close ${name(editor.resource)}`);
			closers.get(editor)?.fire();
			return true;
		},
	} as unknown as IEditorGroup;
	const editors = {
		onDidCloseEditor: onDidCloseEditor.event,
		onDidActiveEditorChange: onDidActiveEditorChange.event,
		get visibleEditorPanes() { return panes; },
		openEditor: async (editor: ReviewEditor, target?: IEditorGroup) => {
			log.push(`open ${label(editor)}${target ? ` in group ${target.id}` : ''}`);
			const resource = editor.modified?.resource ?? editor.resource;
			const onWillDispose = disposables.add(new Emitter<void>());
			let disposed = false;
			disposables.add(onWillDispose.event(() => { disposed = true; }));
			const input = { onWillDispose: onWillDispose.event, isDisposed: () => disposed, isDirty: () => !!options.dirty, resource } as unknown as EditorInput;
			closers.set(input, onWillDispose);
			const container = document.createElement('div');
			const pane = { input, group, getControl: () => ({ getContainerDomNode: () => container }) } as unknown as IEditorPane;
			panes.splice(0, panes.length, pane);
			return pane;
		},
		replaceEditors: async (replacements: IUntypedEditorReplacement[], target: IEditorGroup) => {
			for (const { editor, replacement, forceReplaceDirty } of replacements) {
				assert.strictEqual(target, group);
				// Only the plain file can take the place of a diff with unsaved edits.
				assert.strictEqual(forceReplaceDirty, (replacement as ReviewEditor).original ? undefined : true);
				log.push(`replace ${name(editor.resource)} (review) with ${label(replacement as ReviewEditor)}`);
				closers.get(editor)?.fire();
			}
		},
	} as unknown as IEditorService;
	const surface = disposables.add(new ClaudeReviewPane(
		editors,
		{ getModel: () => null } as unknown as IModelService,
		review,
		{ error: (message: string) => { log.push(`error ${message}`); } } as unknown as INotificationService,
		{ executeCommand: async () => undefined } as unknown as ICommandService,
		{ exists: async (resource: URI) => !options.firstIsNew || resource.toString() !== first.toString() } as unknown as IFileService,
		{ lookupKeybinding: () => undefined } as unknown as IKeybindingService,
	));
	const click = async (label: string, settledLength: number) => {
		const container = (panes[0].getControl() as unknown as { getContainerDomNode(): HTMLElement }).getContainerDomNode();
		[...container.querySelectorAll<HTMLButtonElement>('.claude-review-overlay button')].find(button => button.textContent === label)?.click();
		for (let tick = 0; tick < 20 && log.length < settledLength; tick++) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}
	};
	return { log, review, click, open: () => surface.openFile('session-1', 'turn-1', first, false) };
}

/** What the pane opens: a review diff, or the plain file. */
type ReviewEditor = { resource?: URI; original?: { resource?: URI }; modified?: { resource?: URI } };

function emptyCheckpoints(): IClaudeCheckpointService {
	return { readCheckpointOriginals: async () => [] } as unknown as IClaudeCheckpointService;
}

/** A code editor with just what the review decorations use; 18px lines, 400px tall. */
function fakeCodeEditor(model: ITextModel, inDiffEditor: boolean): {
	editor: ICodeEditor;
	decorations(): IModelDeltaDecoration[];
	widgets(): HTMLElement[];
	tops(): (number | undefined)[];
	moveCursor(line: number): void;
} {
	let decorations: IModelDeltaDecoration[] = [];
	const widgets = new Map<string, IOverlayWidget>();
	const cursor = new Emitter<void>();
	let line = 1;
	const none = () => ({ dispose() { } });
	const editor = {
		getModel: () => model,
		getOption: (option: EditorOption) => option === EditorOption.inDiffEditor ? inDiffEditor : 18,
		getPosition: () => ({ lineNumber: line, column: 1 }),
		onDidChangeModel: none,
		onDidScrollChange: none,
		onDidLayoutChange: none,
		onDidChangeCursorPosition: cursor.event,
		createDecorationsCollection: () => ({
			set: (next: IModelDeltaDecoration[]) => { decorations = next; },
			clear: () => { decorations = []; },
		}),
		addOverlayWidget: (widget: IOverlayWidget) => { widgets.set(widget.getId(), widget); },
		removeOverlayWidget: (widget: IOverlayWidget) => { widgets.delete(widget.getId()); },
		layoutOverlayWidget: () => undefined,
		getLayoutInfo: () => ({ height: 400, contentLeft: 40, contentWidth: 600, verticalScrollbarWidth: 14 }),
		getTopForLineNumber: (lineNumber: number) => (lineNumber - 1) * 18,
		getBottomForLineNumber: (lineNumber: number) => lineNumber * 18,
		getScrollTop: () => 0,
	};
	return {
		editor: editor as unknown as ICodeEditor,
		decorations: () => decorations,
		widgets: () => [...widgets.values()].map(widget => widget.getDomNode()),
		tops: () => [...widgets.values()].map(widget => {
			const preference = widget.getPosition()?.preference;
			return typeof preference === 'object' && preference ? preference.top : undefined;
		}),
		moveCursor: next => {
			line = next;
			cursor.fire();
		},
	};
}
