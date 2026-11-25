/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/claude.css';
import './media/claudeCanvas.css';
import { $, addDisposableListener, append, Dimension, EventType } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { FileChangeType, IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWebviewElement, IWebviewService, WebviewContentPurpose } from '../../webview/browser/webview.js';
import { claudeCanvasDocument, claudeCanvasStandalone } from '../common/claudeCanvasDocument.js';

/** A Canvas tab (issue 493): one HTML file, shown live. */
export class ClaudeCanvasInput extends EditorInput {

	static readonly ID = 'workbench.input.claudeCanvas';

	constructor(
		private readonly _file: URI,
		private readonly _title: string | undefined,
	) {
		super();
	}

	override get typeId(): string {
		return ClaudeCanvasInput.ID;
	}

	override get editorId(): string | undefined {
		return ClaudeCanvasEditor.ID;
	}

	/** The canvas file. Its own scheme keeps the tab apart from the file's text editor. */
	override get resource(): URI {
		return this._file.with({ scheme: 'klawly-canvas' });
	}

	get file(): URI {
		return this._file;
	}

	get title(): string | undefined {
		return this._title;
	}

	override getName(): string {
		return this._title || basename(this._file).replace(/\.html?$/i, '');
	}

	override getDescription(): string | undefined {
		return localize('claudeCanvasDescription', "Canvas");
	}

	override getTitle(): string {
		return localize('claudeCanvasTitle', "{0} (Canvas)", this.getName());
	}

	override getIcon(): ThemeIcon {
		return Codicon.graph;
	}

	override matches(other: EditorInput | unknown): boolean {
		return other instanceof ClaudeCanvasInput && other.file.toString() === this._file.toString();
	}
}

/** Opens a canvas, or shows its tab when one is open already. */
export async function openClaudeCanvas(editors: IEditorService, file: URI, title: string | undefined, preserveFocus: boolean): Promise<void> {
	const open = editors.editors.find(editor => editor instanceof ClaudeCanvasInput && editor.file.toString() === file.toString());
	await editors.openEditor(open ?? new ClaudeCanvasInput(file, title), { pinned: true, preserveFocus });
}

/**
 * Shows a Canvas page sealed (DL-64): scripts run, but the page cannot reach the
 * network, the workbench or the files around it. Edits to the file, by Claude
 * or by the user, reload the tab.
 */
export class ClaudeCanvasEditor extends EditorPane {

	static readonly ID = 'workbench.editor.claudeCanvas';

	private _root!: HTMLElement;
	private _status!: HTMLElement;
	private _stage!: HTMLElement;
	private _webview: IWebviewElement | undefined;
	private readonly _watch = this._register(new MutableDisposable<DisposableStore>());
	private readonly _reload = this._register(new RunOnceScheduler(() => void this.load(), 100));
	private _file: URI | undefined;
	private _token = 0;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviews: IWebviewService,
		@IFileService private readonly _files: IFileService,
		@IEditorService private readonly _editors: IEditorService,
		@IFileDialogService private readonly _dialogs: IFileDialogService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@INotificationService private readonly _notifications: INotificationService,
		@IClipboardService private readonly _clipboard: IClipboardService,
	) {
		super(ClaudeCanvasEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._root = append(parent, $('.claude-canvas'));
		const toolbar = append(this._root, $('.claude-canvas-toolbar'));
		this._status = append(toolbar, $('span.claude-canvas-status'));
		this._status.setAttribute('role', 'status');
		this._status.setAttribute('aria-live', 'polite');
		this.button(toolbar, localize('claudeCanvasReload', "Reload"), () => void this.load());
		this.button(toolbar, localize('claudeCanvasEditSource', "Edit Source"), () => this.editSource());
		this.button(toolbar, localize('claudeCanvasSave', "Save to Workspace..."), () => void this.saveToWorkspace());
		this.button(toolbar, localize('claudeCanvasExport', "Export..."), () => void this.exportStandalone());
		this.button(toolbar, localize('claudeCanvasCopy', "Copy HTML"), () => void this.copyHtml());
		this._stage = append(this._root, $('.claude-canvas-stage'));
		this._webview = this._register(this._webviews.createWebviewElement({
			title: localize('claudeCanvasWebview', "Canvas"),
			options: { purpose: WebviewContentPurpose.CustomEditor },
			contentOptions: {
				allowScripts: true,
				allowForms: false,
				enableCommandUris: false,
				localResourceRoots: [],
			},
			extension: undefined,
		}));
		this._webview.mountTo(this._stage, this.window);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof ClaudeCanvasInput) || token.isCancellationRequested) {
			return;
		}
		this._file = input.file;
		const watch = new DisposableStore();
		const watcher = watch.add(this._files.createWatcher(input.file, { recursive: false, excludes: [] }));
		watch.add(watcher.onDidChange(event => {
			if (event.contains(input.file, FileChangeType.UPDATED, FileChangeType.ADDED, FileChangeType.DELETED)) {
				this._reload.schedule();
			}
		}));
		this._watch.value = watch;
		await this.load();
	}

	override clearInput(): void {
		super.clearInput();
		this._file = undefined;
		this._token++;
		this._watch.clear();
		this._reload.cancel();
		this._webview?.setHtml('');
		this._status.textContent = '';
	}

	override layout(dimension: Dimension): void {
		this._root.style.width = `${dimension.width}px`;
		this._root.style.height = `${dimension.height}px`;
	}

	override focus(): void {
		this._webview?.focus();
	}

	private async load(): Promise<void> {
		const file = this._file;
		if (!file) {
			return;
		}
		const token = ++this._token;
		try {
			const content = await this._files.readFile(file);
			if (token !== this._token) {
				return;
			}
			this._webview?.setHtml(claudeCanvasDocument(content.value.toString()));
			this._status.textContent = '';
			this._root.classList.remove('is-missing');
		} catch {
			if (token !== this._token) {
				return;
			}
			this._webview?.setHtml('');
			this._status.textContent = localize('claudeCanvasMissing', "The canvas file is gone: {0}", file.fsPath);
			this._root.classList.add('is-missing');
		}
	}

	private editSource(): void {
		if (this._file) {
			void this._editors.openEditor({ resource: this._file, options: { pinned: true } });
		}
	}

	/** Copies the page into the project, where the user picks. */
	private async saveToWorkspace(): Promise<void> {
		const file = this._file;
		if (!file) {
			return;
		}
		const folder = this._workspace.getWorkspace().folders[0]?.uri;
		const target = await this._dialogs.showSaveDialog({
			title: localize('claudeCanvasSaveTitle', "Save Canvas to Workspace"),
			defaultUri: folder ? joinPath(folder, basename(file)) : undefined,
			filters: [{ name: localize('claudeCanvasHtml', "HTML"), extensions: ['html'] }],
		});
		if (!target) {
			return;
		}
		try {
			await this._files.copy(file, target, true);
		} catch (error) {
			this._notifications.error(localize('claudeCanvasSaveFailed', "Klawly could not save the canvas: {0}", error instanceof Error ? error.message : String(error)));
		}
	}

	/** Writes a sealed, self-contained copy the user can send anywhere (issue 885). */
	private async exportStandalone(): Promise<void> {
		const file = this._file;
		if (!file) {
			return;
		}
		const target = await this._dialogs.showSaveDialog({
			title: localize('claudeCanvasExportTitle', "Export Canvas"),
			defaultUri: joinPath(await this._dialogs.defaultFilePath(), basename(file)),
			filters: [{ name: localize('claudeCanvasHtml', "HTML"), extensions: ['html'] }],
		});
		if (!target) {
			return;
		}
		try {
			const content = await this._files.readFile(file);
			await this._files.writeFile(target, VSBuffer.fromString(claudeCanvasStandalone(content.value.toString())));
		} catch (error) {
			this._notifications.error(localize('claudeCanvasExportFailed', "Klawly could not export the canvas: {0}", error instanceof Error ? error.message : String(error)));
		}
	}

	private async copyHtml(): Promise<void> {
		const file = this._file;
		if (!file) {
			return;
		}
		try {
			const content = await this._files.readFile(file);
			await this._clipboard.writeText(claudeCanvasStandalone(content.value.toString()));
			this._status.textContent = localize('claudeCanvasCopied', "Copied the canvas HTML.");
		} catch (error) {
			this._notifications.error(localize('claudeCanvasCopyFailed', "Klawly could not copy the canvas: {0}", error instanceof Error ? error.message : String(error)));
		}
	}

	private button(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
		const button = append(parent, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
		button.type = 'button';
		button.textContent = label;
		this._register(addDisposableListener(button, EventType.CLICK, event => {
			event.preventDefault();
			onClick();
		}));
		return button;
	}
}
