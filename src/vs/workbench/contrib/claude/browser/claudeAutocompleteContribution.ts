/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/claude.css';
import * as dom from '../../../../base/browser/dom.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { IPosition } from '../../../../editor/common/core/position.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelContentChangedEvent } from '../../../../editor/common/textModelEvents.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IContentWidget, IContentWidgetPosition, ContentWidgetPositionPreference, ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { getInlineCompletionsController } from '../../../../editor/contrib/inlineCompletions/browser/controller/common.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { URI } from '../../../../base/common/uri.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { contentChangeRecentEdits, isSkippedCompletionScheme, nextTextAfterContentChanges } from '../../../../platform/claude/common/claudeAutocomplete.js';
import { IClaudeAutocompleteService } from '../../../services/claude/common/claudeAutocompleteService.js';
import { IClaudeAttributionService } from '../../../services/claude/common/claudeAttribution.js';
import { CLAUDE_TAB_FILE_HASH_LIMIT, ClaudeTabCompletionProvider, claudeTabAcceptWhen, claudeTabDismissWhen, tabModelHandoff } from '../common/claudeTabProvider.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { KLAWLY_CATEGORY } from '../common/claudeViews.js';

const $ = dom.$;

export const CLAUDE_TAB_NEXT_EDIT = new RawContextKey<boolean>('klawly.tab.nextEdit', false, localize('claudeTab.nextEditContext', "Whether a next-edit jump is available at the cursor"));

const ACCEPT_NEXT_EDIT_ID = 'klawly.tab.acceptNextEdit';
const DISMISS_NEXT_EDIT_ID = 'klawly.tab.dismissNextEdit';
const SHOW_LATENCY_ID = 'klawly.tab.showLatency';

/**
 * Registers the inline-completion provider. Ghost text is the editor's own
 * rendering. A cross-file result does not insert text here.
 */
export class ClaudeTabContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeTab';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IClaudeAutocompleteService autocomplete: IClaudeAutocompleteService,
		@IClaudeAttributionService attribution: IClaudeAttributionService,
	) {
		super();
		const provider = new ClaudeTabCompletionProvider(autocomplete, attribution);
		this._register(languageFeaturesService.inlineCompletionsProvider.register({ pattern: '**' }, provider));
	}
}

/**
 * Shows the "Next edit in ..." pill. Accepting it opens the target and previews
 * the change as a replacement of that line. It does not edit that file.
 */
export class ClaudeTabEditorContribution extends Disposable implements IEditorContribution {
	static readonly ID = 'klawly.claudeTab';

	private readonly _key: IContextKey<boolean>;
	private readonly _widget: NextEditWidget;
	private readonly _watched = new Map<string, IDisposable>();
	private _previousText: string | undefined;
	private _boundUri: URI | undefined;

	constructor(
		private readonly _editor: ICodeEditor,
		@IClaudeAutocompleteService private readonly _autocomplete: IClaudeAutocompleteService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this._key = CLAUDE_TAB_NEXT_EDIT.bindTo(contextKeyService);
		this._widget = new NextEditWidget(this._editor);
		this._editor.addContentWidget(this._widget);
		this._register({ dispose: () => this._editor.removeContentWidget(this._widget) });
		this._register(this._autocomplete.onDidChangeNextEdit(() => this._sync()));
		this._register(this._editor.onDidChangeModel(() => this._attachModel()));
		this._register(this._editor.onDidFocusEditorText(() => this._onFocus()));
		this._register(this._editor.onDidChangeCursorPosition(event => this._onCursor(event.position)));
		this._register(this._editor.onDidChangeModelContent(event => this._onEdit(event)));
		this._attachModel();
	}

	override dispose(): void {
		const leaving = this._boundUri;
		this._boundUri = undefined;
		this._releaseBound(leaving);
		for (const listener of this._watched.values()) {
			listener.dispose();
		}
		this._watched.clear();
		super.dispose();
	}

	private _attachModel(): void {
		const model = this._editor.getModel();
		const leaving = tabModelHandoff(this._boundUri, model?.uri);
		this._boundUri = model?.uri;
		this._releaseBound(leaving);
		this._captureText(model);
		if (model) {
			this._watchModel(model);
		}
		this._sync();
	}

	private _releaseBound(uri: URI | undefined): void {
		if (!uri) {
			return;
		}
		const last = this._autocomplete.releaseEditor(this._editor.getId());
		if (!last) {
			return;
		}
		const key = uri.toString();
		this._watched.get(key)?.dispose();
		this._watched.delete(key);
		this._autocomplete.forgetDocument(uri);
	}

	private _watchModel(model: ITextModel): void {
		const key = model.uri.toString();
		if (this._watched.has(key)) {
			return;
		}
		const listener = model.onWillDispose(() => {
			listener.dispose();
			this._watched.delete(key);
			this._autocomplete.forgetDocument(model.uri);
		});
		this._watched.set(key, listener);
	}

	private _captureText(model: ITextModel | null): void {
		if (!model || isSkippedCompletionScheme(model.uri.scheme) || model.getValueLength() > CLAUDE_TAB_FILE_HASH_LIMIT) {
			this._previousText = undefined;
			return;
		}
		this._previousText = model.getValue();
	}

	private _editorSlot(): { readonly id: string; readonly focused: boolean } {
		return { id: this._editor.getId(), focused: this._editor.hasTextFocus() };
	}

	private _onFocus(): void {
		const model = this._editor.getModel();
		const position = this._editor.getPosition();
		if (!model || !position || isSkippedCompletionScheme(model.uri.scheme)) {
			return;
		}
		if (this._autocomplete.noteDocument(model.uri, model.getVersionId(), position, { id: this._editor.getId(), focused: true })) {
			this._autocomplete.cancelActive(model.uri);
			this._dismissIfMoved(model.uri);
		}
	}

	private _onCursor(position: IPosition): void {
		const model = this._editor.getModel();
		if (!model || isSkippedCompletionScheme(model.uri.scheme)) {
			return;
		}
		if (this._autocomplete.noteDocument(model.uri, model.getVersionId(), position, this._editorSlot())) {
			this._autocomplete.cancelActive(model.uri);
			this._dismissIfMoved(model.uri);
		}
	}

	private _onEdit(event: IModelContentChangedEvent): void {
		const model = this._editor.getModel();
		const position = this._editor.getPosition();
		if (!model || isSkippedCompletionScheme(model.uri.scheme)) {
			return;
		}
		if (!event.isFlush && this._previousText !== undefined) {
			for (const edit of contentChangeRecentEdits(model.uri.toString(), this._previousText, event.changes)) {
				this._autocomplete.recordRecentEdit(edit);
			}
			const next = nextTextAfterContentChanges(this._previousText, event.changes);
			this._previousText = next.length > CLAUDE_TAB_FILE_HASH_LIMIT ? undefined : next;
		} else {
			this._captureText(model);
		}
		this._autocomplete.noteDocument(model.uri, model.getVersionId(), position, this._editorSlot());
		this._autocomplete.cancelActive(model.uri);
		this._autocomplete.dismissNextEdit(model.uri);
	}

	private _dismissIfMoved(uri: URI): void {
		const next = this._autocomplete.peekNextEdit(uri);
		const live = this._autocomplete.notedPosition(uri);
		if (!next || !live) {
			return;
		}
		if (live.lineNumber !== next.anchor.lineNumber || live.column !== next.anchor.column) {
			this._autocomplete.dismissNextEdit(uri);
		}
	}

	private _sync(): void {
		const model = this._editor.getModel();
		const next = model && this._autocomplete.enabled() ? this._autocomplete.peekNextEdit(model.uri) : undefined;
		this._key.set(!!next && next.kind === 'next-edit');
		this._widget.show(next && next.kind === 'next-edit' ? next : undefined);
	}
}

/**
 * The next-edit hint: one chip after the text of the cursor's line, the Tab
 * key first, then where the edit is. It never takes focus.
 */
export class NextEditWidget implements IContentWidget {
	readonly allowEditorOverflow = true;
	readonly suppressMouseDown = true;

	private readonly _dom: HTMLElement;
	private readonly _label: HTMLElement;
	private _position: IPosition | null = null;

	constructor(private readonly _editor: ICodeEditor) {
		this._dom = $('.claude-next-edit');
		this._dom.setAttribute('role', 'status');
		this._dom.setAttribute('aria-live', 'polite');
		const keys = dom.append(this._dom, $('span.claude-kbd'));
		dom.append(keys, $('kbd')).textContent = localize('claudeTab.tabKey', "Tab");
		this._label = dom.append(this._dom, $('span.claude-next-edit-label'));
	}

	getId(): string {
		return ClaudeTabEditorContribution.ID;
	}

	getDomNode(): HTMLElement {
		return this._dom;
	}

	getPosition(): IContentWidgetPosition | null {
		if (!this._position) {
			return null;
		}
		return {
			position: this._position,
			// After the line's text; under it only when the line runs past the viewport.
			preference: [ContentWidgetPositionPreference.EXACT, ContentWidgetPositionPreference.BELOW],
		};
	}

	show(next: { readonly fileName: string; readonly line: number; readonly anchor: IPosition } | undefined): void {
		const model = this._editor.getModel();
		if (!next || !model || next.anchor.lineNumber > model.getLineCount()) {
			this._position = null;
			this._editor.layoutContentWidget(this);
			return;
		}
		const label = localize('claudeTab.nextEdit', "Next edit in {0}", `${next.fileName}:${next.line}`);
		this._label.textContent = label;
		this._dom.setAttribute('aria-label', localize('claudeTab.nextEditAria', "{0}, press Tab to go there", label));
		this._position = { lineNumber: next.anchor.lineNumber, column: model.getLineMaxColumn(next.anchor.lineNumber) };
		this._editor.layoutContentWidget(this);
	}
}

registerWorkbenchContribution2(ClaudeTabContribution.ID, ClaudeTabContribution, WorkbenchPhase.AfterRestored);
/** Registers Claude Tab on every code editor. A function, so a test that imports this file does not add it to other tests' editors. */
export function registerClaudeTabEditorContribution(): void {
	registerEditorContribution(ClaudeTabEditorContribution.ID, ClaudeTabEditorContribution, EditorContributionInstantiation.AfterFirstRender);
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: ACCEPT_NEXT_EDIT_ID,
			title: localize2('claudeTab.acceptNextEdit', "Accept Next Edit"),
			category: KLAWLY_CATEGORY,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyCode.Tab,
				when: claudeTabAcceptWhen(),
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const codeEditorService = accessor.get(ICodeEditorService);
		const editorService = accessor.get(IEditorService);
		const autocomplete = accessor.get(IClaudeAutocompleteService);
		const editor = codeEditorService.getFocusedCodeEditor();
		const source = editor?.getModel();
		if (!editor || !source) {
			return;
		}
		const next = autocomplete.acceptNextEdit(source.uri);
		if (!next) {
			return;
		}
		await editorService.openEditor({
			resource: next.target,
			options: {
				selection: {
					startLineNumber: next.line,
					startColumn: 1,
					endLineNumber: next.line,
					endColumn: 1,
				},
			},
		});
		const opened = codeEditorService.getActiveCodeEditor();
		const model = opened?.getModel();
		const position = opened?.getPosition();
		if (!opened || !model || !position || model.getVersionId() === undefined) {
			return;
		}
		if (model.uri.toString() !== next.target.toString()) {
			return;
		}
		if (position.lineNumber !== next.line) {
			return;
		}
		autocomplete.armPreview(model.uri, model.getVersionId(), next.line, next.preview);
		await getInlineCompletionsController(opened)?.model.get()?.trigger(undefined, { explicit: true, noDelay: true });
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: DISMISS_NEXT_EDIT_ID,
			title: localize2('claudeTab.dismissNextEdit', "Dismiss Next Edit"),
			category: KLAWLY_CATEGORY,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyCode.Escape,
				when: claudeTabDismissWhen(),
			},
		});
	}

	run(accessor: ServicesAccessor): void {
		const editor = accessor.get(ICodeEditorService).getFocusedCodeEditor();
		const model = editor?.getModel();
		if (!model) {
			return;
		}
		accessor.get(IClaudeAutocompleteService).dismissNextEdit(model.uri);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SHOW_LATENCY_ID,
			title: localize2('claudeTab.showLatency', "Show Tab Latency"),
			category: KLAWLY_CATEGORY,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IClaudeAutocompleteService).logLatency();
	}
});
