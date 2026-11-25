/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CLAUDE_CANVAS_FOLDER, CLAUDE_CANVAS_TOOL_ID, readClaudeCanvasResult } from '../../../../platform/claude/common/claudeCanvas.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ResourceContextKey } from '../../../common/contextkeys.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { KLAWLY_CATEGORY } from '../common/claudeViews.js';
import { ClaudeCanvasEditor, ClaudeCanvasInput, openClaudeCanvas } from './claudeCanvasEditor.js';

interface SerializedCanvas {
	readonly file: string;
	readonly title?: string;
}

export class ClaudeCanvasInputSerializer implements IEditorSerializer {
	canSerialize(editor: EditorInput): boolean {
		return editor instanceof ClaudeCanvasInput;
	}

	serialize(editor: EditorInput): string | undefined {
		if (!(editor instanceof ClaudeCanvasInput)) {
			return undefined;
		}
		const value: SerializedCanvas = { file: editor.file.toString(), title: editor.title };
		return JSON.stringify(value);
	}

	deserialize(instantiationService: IInstantiationService, serializedEditor: string): EditorInput | undefined {
		try {
			const value: Partial<SerializedCanvas> = JSON.parse(serializedEditor);
			return typeof value.file === 'string'
				? instantiationService.createInstance(ClaudeCanvasInput, URI.parse(value.file), typeof value.title === 'string' ? value.title : undefined)
				: undefined;
		} catch {
			return undefined;
		}
	}
}

/**
 * Opens the canvas a `klawly_canvas` call saved in a chat this window owns (issue 493).
 * A canvas whose tab is open already only reloads (its watcher sees the write), so
 * an update never pulls the user away from the tab they are on.
 */
export class ClaudeCanvasOpener extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeCanvasOpener';

	private readonly _calls = new Set<string>();

	constructor(
		@IClaudeAgentService agent: IClaudeAgentService,
		@IEditorService private readonly _editors: IEditorService,
	) {
		super();
		this._register(agent.onDidReceiveEvent(event => {
			if (event.type === 'tool.started' && event.call.name === CLAUDE_CANVAS_TOOL_ID) {
				this._calls.add(event.call.id);
			} else if (event.type === 'tool.completed' && this._calls.delete(event.callId) && event.result.ok) {
				this.open(event.result.output);
			} else if (event.type === 'session.completed' || event.type === 'session.failed') {
				this._calls.clear();
			}
		}));
	}

	private open(output: string | undefined): void {
		const canvas = readClaudeCanvasResult(output);
		if (!canvas) {
			return;
		}
		const file = URI.file(canvas.path);
		if (this._editors.editors.some(editor => editor instanceof ClaudeCanvasInput && editor.file.toString() === file.toString())) {
			return;
		}
		void openClaudeCanvas(this._editors, file, canvas.title, true);
	}
}

export function registerClaudeCanvas(): void {
	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(
			ClaudeCanvasEditor,
			ClaudeCanvasEditor.ID,
			localize('claudeCanvasEditor', "Canvas"),
		),
		[new SyncDescriptor(ClaudeCanvasInput)],
	);
	Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
		ClaudeCanvasInput.ID,
		ClaudeCanvasInputSerializer,
	);
	registerWorkbenchContribution2(ClaudeCanvasOpener.ID, ClaudeCanvasOpener, WorkbenchPhase.AfterRestored);
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'claude.canvas.open',
				title: localize2('claudeOpenCanvas', "Open Canvas..."),
				category: KLAWLY_CATEGORY,
				f1: true,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const dialogs = accessor.get(IFileDialogService);
			const editors = accessor.get(IEditorService);
			const dataFolderName = accessor.get(IProductService).dataFolderName;
			const home = await accessor.get(IPathService).userHome();
			const folder = joinPath(home, dataFolderName, CLAUDE_CANVAS_FOLDER);
			const picked = await dialogs.showOpenDialog({
				title: localize('claudeOpenCanvasTitle', "Open Canvas"),
				defaultUri: folder,
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				filters: [{ name: localize('claudeOpenCanvasHtml', "HTML"), extensions: ['html', 'htm'] }],
			});
			if (picked?.[0]) {
				await openClaudeCanvas(editors, picked[0], undefined, false);
			}
		}
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'claude.canvas.openFile',
				title: localize2('claudeOpenAsCanvas', "Open as Canvas"),
				category: KLAWLY_CATEGORY,
				menu: {
					id: MenuId.ExplorerContext,
					group: '3_open_as',
					order: 10,
					when: ContextKeyExpr.and(ResourceContextKey.Scheme.isEqualTo('file'), ContextKeyExpr.or(ResourceContextKey.Extension.isEqualTo('.html'), ResourceContextKey.Extension.isEqualTo('.htm'))),
				},
			});
		}
		async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
			if (resource) {
				await openClaudeCanvas(accessor.get(IEditorService), resource, undefined, false);
			}
		}
	});
}
