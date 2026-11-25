/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { hashCopiedText, IClaudeCopyTracker } from '../../../services/claude/common/claudeCopyTracker.js';

/** Records the latest editor copy so a composer paste can become a selection chip. */
export class ClaudeCopyContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeCopyTracker';

	private readonly _editors = this._register(new DisposableMap<string, DisposableStore>());

	constructor(
		@ICodeEditorService editorService: ICodeEditorService,
		@IClaudeCopyTracker private readonly _tracker: IClaudeCopyTracker,
	) {
		super();
		this._register(editorService.onCodeEditorAdd(editor => this.watch(editor)));
		this._register(editorService.onCodeEditorRemove(editor => this._editors.deleteAndDispose(editor.getId())));
		for (const editor of editorService.listCodeEditors()) {
			this.watch(editor);
		}
	}

	private watch(editor: ICodeEditor): void {
		const id = editor.getId();
		if (this._editors.has(id)) {
			return;
		}
		const store = new DisposableStore();
		this._editors.set(id, store);
		let attached = false;
		const attach = () => {
			const node = editor.getDomNode();
			if (!node || attached) {
				return;
			}
			attached = true;
			store.add(addDisposableListener(node, 'copy', () => {
				const model = editor.getModel();
				const selection = editor.getSelection();
				if (!model || !selection || selection.isEmpty()) {
					return;
				}
				const text = model.getValueInRange(selection);
				this._tracker.record({
					uri: model.uri.toString(),
					range: {
						startLine: selection.startLineNumber,
						startColumn: selection.startColumn,
						endLine: selection.endLineNumber,
						endColumn: selection.endColumn,
					},
					versionId: model.getVersionId(),
					textHash: hashCopiedText(text),
				});
			}));
		};
		store.add(editor.onDidFocusEditorText(attach));
		attach();
	}
}
