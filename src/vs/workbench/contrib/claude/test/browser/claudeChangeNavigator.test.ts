/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditor, IOverlayWidget } from '../../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IClaudeCheckpointService } from '../../../../services/claude/common/claudeCheckpointService.js';
import { ClaudeReviewService } from '../../../../services/claude/common/claudeReview.js';
import { ClaudeChangeNavigatorContribution, renderClaudeChangeNavigator } from '../../browser/review/claudeChangeNavigator.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';

suite('Claude change navigator', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('a normal editor gets the navigator with file buttons only, steps through its changes and opens the next file or the review editor, also after Accept File', () => {
		const uri = URI.file('C:/repo/src/cart.ts');
		const other = URI.file('C:/repo/src/price.ts');
		const live = disposables.add(createTextModel('a\nB\nkeep this line\nD\ne\n', null, undefined, uri));
		const review = disposables.add(new ClaudeReviewService(emptyCheckpoints(), {
			createModelReference: async () => ({ object: { textEditorModel: live }, dispose() { } }),
		} as unknown as ITextModelService, { del: async () => undefined } as never, { isDirty: () => false, revert: async () => undefined } as never, new TestConfigurationService()));
		review.replaceTurn('session-1', 'turn-1', [
			{ uri, originalText: 'a\nb\nkeep this line\nd\ne\n', modifiedText: 'a\nB\nkeep this line\nD\ne\n', existed: true },
			{ uri: other, originalText: 'x\n', modifiedText: 'y\n', existed: true },
		]);
		const opened: { resource?: URI; options?: { selection?: { startLineNumber: number } } }[] = [];
		const editors = { openEditor: async (input: { resource?: URI; options?: { selection?: { startLineNumber: number } } }) => { opened.push(input); return undefined; } } as unknown as IEditorService;
		const commands: unknown[][] = [];
		const commandService = { executeCommand: async (...args: unknown[]) => { commands.push(args); return undefined; } } as unknown as ICommandService;
		const notifications = {} as INotificationService;

		const diff = fakeCodeEditor(live, true, disposables);
		disposables.add(new ClaudeChangeNavigatorContribution(diff.editor, review, editors, commandService, notifications));
		const normal = fakeCodeEditor(live, false, disposables);
		const navigator = disposables.add(new ClaudeChangeNavigatorContribution(normal.editor, review, editors, commandService, notifications));
		const initial = { diff: diff.widgets().length, bar: normal.widgets().map(summarize), position: normal.positions() };

		const lines: number[] = [];
		navigator.next();
		lines.push(normal.line());
		navigator.next();
		lines.push(normal.line());
		const onSecond = summarize(normal.widgets()[0])[1];
		navigator.next();
		lines.push(normal.line());
		navigator.previous();
		lines.push(normal.line());

		const button = (label: string) => [...normal.widgets()[0].getElementsByTagName('button')].find(candidate => (candidate.textContent || candidate.getAttribute('aria-label')) === label)!;
		button('Open Every Change of This Turn in the Review Editor').click();
		button('Next File').click();
		button('Accept File').click();

		assert.deepStrictEqual({
			initial,
			lines,
			onSecond,
			commands,
			opened: opened.map(input => `${input.resource && basename(input.resource)}:${input.options?.selection?.startLineNumber}`),
			states: review.get('session-1', 'turn-1')?.files.map(file => file.state),
			after: normal.widgets().length,
		}, {
			initial: {
				diff: 0,
				bar: [['Previous Change', 'Change 1 of 2', 'Next Change', '|', 'Reject File', 'Accept File (keep)', '|', 'cart.ts · 1 of 2', 'Next File', 'Open Every Change of This Turn in the Review Editor']],
				position: [{ top: 400 - 10 - 46, left: 400 }],
			},
			lines: [2, 4, 2, 4],
			onSecond: 'Change 2 of 2',
			commands: [['klawly.review.openEditor', 'session-1', 'turn-1']],
			opened: ['price.ts:1', 'price.ts:1'],
			states: ['accepted', 'pending'],
			after: 0,
		});
	});

	test('Reject File in a normal editor undoes the file and opens the next file with changes waiting, skipping settled ones (issue 350)', async () => {
		const uri = URI.file('C:/repo/src/cart.ts');
		const settled = URI.file('C:/repo/src/price.ts');
		const waiting = URI.file('C:/repo/src/tax.ts');
		const live = disposables.add(createTextModel('a\nB\n', null, undefined, uri));
		const review = disposables.add(new ClaudeReviewService(emptyCheckpoints(), {
			createModelReference: async () => ({ object: { textEditorModel: live }, dispose() { } }),
		} as unknown as ITextModelService, { del: async () => undefined } as never, { isDirty: () => false, revert: async () => undefined } as never, new TestConfigurationService()));
		review.replaceTurn('session-1', 'turn-1', [
			{ uri, originalText: 'a\nb\n', modifiedText: 'a\nB\n', existed: true },
			{ uri: settled, originalText: 'x\n', modifiedText: 'y\n', existed: true },
			{ uri: waiting, originalText: 'p\nq\n', modifiedText: 'p\nQ\n', existed: true },
		]);
		review.acceptFile('session-1', 'turn-1', settled);
		const opened: string[] = [];
		const editors = { openEditor: async (input: { resource: URI; options?: { selection?: { startLineNumber: number } } }) => { opened.push(`${basename(input.resource)}:${input.options?.selection?.startLineNumber}`); return undefined; } } as unknown as IEditorService;
		const normal = fakeCodeEditor(live, false, disposables);
		disposables.add(new ClaudeChangeNavigatorContribution(normal.editor, review, editors, { executeCommand: async () => undefined } as unknown as ICommandService, {} as INotificationService));

		[...normal.widgets()[0].getElementsByTagName('button')].find(candidate => candidate.textContent === 'Reject File')!.click();
		for (let tick = 0; tick < 20 && opened.length === 0; tick++) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}

		assert.deepStrictEqual({ opened, text: live.getValue(), states: review.get('session-1', 'turn-1')?.files.map(file => file.state), bar: normal.widgets().length }, {
			opened: ['tax.ts:2'],
			text: 'a\nb\n',
			states: ['rejected', 'accepted', 'pending'],
			bar: 0,
		});
	});

	test('the "(review)" diff editor bar also has per-change Reject / Accept', () => {
		const store = disposables.add(new DisposableStore());
		const bar = document.createElement('div');
		const noop = () => { };
		renderClaudeChangeNavigator(bar, {
			position: 2,
			total: 3,
			file: { name: 'cart.ts', index: 1, count: 2 },
			previous: noop, next: noop, rejectFile: noop, acceptFile: noop, nextFile: noop, openReview: noop,
			change: { reject: noop, accept: noop },
		}, store);
		assert.deepStrictEqual({ className: bar.className, role: bar.getAttribute('role'), items: summarize(bar) }, {
			className: 'claude-review-bar claude-root',
			role: 'toolbar',
			items: ['Previous Change', 'Change 2 of 3', 'Next Change', '|', 'Reject', 'Accept (keep)', '|', 'Reject File', 'Accept File (keep)', '|', 'cart.ts · 1 of 2', 'Next File', 'Open Every Change of This Turn in the Review Editor'],
		});
	});
});

/** The bar's items in order: button labels (keep-styled ones marked), texts, and `|` for separators. */
function summarize(bar: HTMLElement): string[] {
	return [...bar.children].map(child => {
		if (child.classList.contains('sep')) {
			return '|';
		}
		if (child.tagName === 'BUTTON') {
			const label = child.textContent || child.getAttribute('aria-label') || '';
			return child.classList.contains('is-keep') ? `${label} (keep)` : label;
		}
		return child.textContent ?? '';
	});
}

function emptyCheckpoints(): IClaudeCheckpointService {
	return { readCheckpointOriginals: async () => [] } as unknown as IClaudeCheckpointService;
}

/** A code editor with just what the navigator uses; 800×400 with a 10px horizontal scrollbar. */
function fakeCodeEditor(model: ITextModel, inDiffEditor: boolean, disposables: Pick<DisposableStore, 'add'>): {
	editor: ICodeEditor;
	widgets(): HTMLElement[];
	positions(): ({ top: number; left: number } | undefined)[];
	line(): number;
} {
	const widgets = new Map<string, IOverlayWidget>();
	const cursor = disposables.add(new Emitter<void>());
	let line = 1;
	const none = () => ({ dispose() { } });
	const editor = {
		getModel: () => model,
		getOption: (option: EditorOption) => option === EditorOption.inDiffEditor ? inDiffEditor : undefined,
		getPosition: () => ({ lineNumber: line, column: 1 }),
		setPosition: (position: { lineNumber: number }) => {
			line = position.lineNumber;
			cursor.fire();
		},
		revealLineInCenterIfOutsideViewport: () => undefined,
		onDidChangeModel: none,
		onDidLayoutChange: none,
		onDidChangeCursorPosition: cursor.event,
		addOverlayWidget: (widget: IOverlayWidget) => { widgets.set(widget.getId(), widget); },
		removeOverlayWidget: (widget: IOverlayWidget) => { widgets.delete(widget.getId()); },
		layoutOverlayWidget: () => undefined,
		getLayoutInfo: () => ({ width: 800, height: 400, horizontalScrollbarHeight: 10 }),
	};
	return {
		editor: editor as unknown as ICodeEditor,
		widgets: () => [...widgets.values()].map(widget => widget.getDomNode()),
		positions: () => [...widgets.values()].map(widget => {
			const preference = widget.getPosition()?.preference;
			return typeof preference === 'object' && preference ? preference : undefined;
		}),
		line: () => line,
	};
}
