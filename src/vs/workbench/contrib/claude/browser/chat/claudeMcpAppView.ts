/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { decodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { language } from '../../../../../base/common/platform.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { McpApps } from '../../../../../platform/mcp/common/modelContextProtocolApps.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { ClaudeMcpApp, ClaudeMcpAppLoad } from '../../../../../platform/claude/common/claudeMcpApps.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { isDark } from '../../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { ToolCardModel } from '../../../../services/claude/common/claudeToolCards.js';
import { ChatMcpAppModel } from '../../../chat/browser/widget/chatContentParts/toolInvocationParts/chatMcpAppModel.js';
import { IWebviewElement, IWebviewService, WebviewContentPurpose } from '../../../webview/browser/webview.js';
import { CLAUDE_MCP_APP_MAX_HEIGHT, CLAUDE_MCP_APP_STYLE_VARIABLES, ClaudeMcpAppBridge, ClaudeMcpAppCall, ClaudeMcpAppFile, ClaudeMcpAppHostContext, ClaudeMcpAppResource } from '../../common/claudeMcpAppBridge.js';
import { ClaudeMcpAppMount } from './claudeToolCardView.js';

/** What the chat gives an MCP App card: its running session and its composer. */
export interface ClaudeMcpAppChat {
	/** The runtime session the chat shows, whose MCP servers draw the apps. */
	runtimeSessionId(): string | undefined;
	/** Adds text to the composer's draft; false when the composer shows another chat. */
	draft(text: string): boolean;
}

/** The height an app starts at, before it says its own. */
const INITIAL_HEIGHT = 160;

/**
 * Issue 513: the MCP App an MCP tool names, drawn under the tool's card in a
 * sandboxed webview with the same CSP and message preamble as the chat's MCP
 * Apps. The card stays empty for a tool that draws no app, and for a chat
 * whose session is not running.
 */
export class ClaudeMcpAppView extends Disposable implements ClaudeMcpAppMount {
	/** One webview origin per server, so an app keeps its storage while Klawly runs. */
	private static readonly _origins = new Map<string, string>();

	private readonly _element: HTMLElement;
	private readonly _content = this._register(new DisposableStore());
	private _bridge: ClaudeMcpAppBridge | undefined;
	private _card: ToolCardModel;
	private _app: ClaudeMcpApp | undefined;
	private _loading = false;
	private _mode: McpApps.McpUiDisplayMode = 'inline';

	constructor(
		container: HTMLElement,
		card: ToolCardModel,
		private readonly _chat: ClaudeMcpAppChat,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IWebviewService private readonly _webviews: IWebviewService,
		@IOpenerService private readonly _opener: IOpenerService,
		@IThemeService private readonly _themes: IThemeService,
		@IProductService private readonly _product: IProductService,
		@IFileDialogService private readonly _fileDialogs: IFileDialogService,
		@IFileService private readonly _files: IFileService,
	) {
		super();
		this._card = card;
		this._element = append(container, $('.claude-mcp-app'));
		this._element.hidden = true;
		this._register({ dispose: () => this._element.remove() });
		this._register(this._themes.onDidColorThemeChange(() => this._bridge?.hostContextChanged()));
		this._register(addDisposableListener(this._element, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape' && this._mode !== 'inline') {
				event.stopPropagation();
				this.setDisplayMode('inline');
				this._bridge?.hostContextChanged();
			}
		}));
		void this.load();
	}

	update(card: ToolCardModel): void {
		this._card = card;
		const app = this._app;
		if (app) {
			this._bridge?.update(this.call(app));
		}
	}

	private async load(): Promise<void> {
		const sessionId = this._chat.runtimeSessionId();
		if (this._loading || !sessionId || !this._runtime.loadMcpApp) {
			return;
		}
		this._loading = true;
		let result: ClaudeMcpAppLoad | undefined;
		try {
			result = await this._runtime.loadMcpApp(sessionId, this._card.name);
		} catch (error) {
			result = { ok: false, message: error instanceof Error ? error.message : String(error) };
		} finally {
			this._loading = false;
		}
		if (this._store.isDisposed || !result) {
			return;
		}
		if (result.ok) {
			this.show(result.app);
		} else {
			this.showError(result.message);
		}
	}

	private show(app: ClaudeMcpApp): void {
		this._content.clear();
		clearNode(this._element);
		this.setDisplayMode('inline');
		this._app = app;
		this._element.hidden = false;
		this._element.classList.remove('is-error');
		this._element.classList.toggle('has-border', app.prefersBorder !== false);
		const frame = append(this._element, $('.claude-mcp-app-frame'));
		const exit = append(this._element, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost.claude-mcp-app-exit'));
		exit.type = 'button';
		exit.textContent = localize('claudeMcpAppExit', "Exit");
		this._content.add(addDisposableListener(exit, EventType.CLICK, event => {
			event.preventDefault();
			this.setDisplayMode('inline');
			this._bridge?.hostContextChanged();
		}));
		frame.style.height = `${INITIAL_HEIGHT}px`;
		let origin = ClaudeMcpAppView._origins.get(app.server);
		if (!origin) {
			origin = generateUuid();
			ClaudeMcpAppView._origins.set(app.server, origin);
		}
		const webview: IWebviewElement = this._content.add(this._webviews.createWebviewElement({
			origin,
			title: localize('claudeMcpAppTitle', "{0} App from {1}", app.tool, app.server),
			options: {
				purpose: WebviewContentPurpose.ChatOutputItem,
				enableFindWidget: false,
				disableServiceWorker: true,
				retainContextWhenHidden: true,
			},
			contentOptions: {
				allowMultipleAPIAcquire: true,
				allowScripts: true,
				allowForms: true,
			},
			extension: undefined,
		}));
		webview.mountTo(frame, getWindow(frame));
		const bridge = new ClaudeMcpAppBridge(this.call(app), {
			post: message => void webview.postMessage(message),
			resize: height => frame.style.height = `${height}px`,
			openLink: url => this._opener.open(url, { openExternal: true }),
			draft: text => this._chat.draft(text),
			hostContext: () => this.hostContext(),
			setDisplayMode: mode => this.setDisplayMode(mode),
			readResource: uri => this.readResource(app.server, uri),
			saveFile: file => this.saveFile(file),
		}, { name: this._product.nameLong, version: this._product.version });
		this._bridge = bridge;
		this._content.add({ dispose: () => this._bridge = undefined });
		this._content.add(webview.onMessage(({ message }) => void bridge.handle(message)));
		webview.setHtml(ChatMcpAppModel.injectPreamble({ html: app.html, mimeType: app.mimeType, csp: app.csp }));
	}

	private showError(message: string): void {
		this._content.clear();
		clearNode(this._element);
		this.setDisplayMode('inline');
		this._app = undefined;
		this._element.hidden = false;
		this._element.classList.add('is-error');
		const text = append(this._element, $('span.claude-mcp-app-message'));
		text.textContent = localize('claudeMcpAppFailed', "The MCP App did not load: {0}", message);
		const retry = append(this._element, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
		retry.type = 'button';
		retry.textContent = localize('claudeMcpAppRetry', "Retry");
		this._content.add(addDisposableListener(retry, EventType.CLICK, event => {
			event.preventDefault();
			event.stopPropagation();
			void this.load();
		}));
	}

	private call(app: ClaudeMcpApp): ClaudeMcpAppCall {
		const card = this._card;
		const output = card.lines.join('\n') || card.error;
		return {
			server: app.server,
			tool: app.tool,
			input: card.mcpInput ?? {},
			...(output ? { output } : {}),
			...(card.mcpImages?.length ? { images: card.mcpImages } : {}),
			...(card.mcpStructured ? { structuredContent: card.mcpStructured } : {}),
			done: card.state !== 'running',
			failed: card.state !== 'running' && card.state !== 'success',
		};
	}

	/** DL-102: fullscreen covers the window and picture-in-picture floats in its corner; Esc and Exit go back inline. */
	private setDisplayMode(mode: McpApps.McpUiDisplayMode): McpApps.McpUiDisplayMode {
		this._mode = mode;
		this._element.classList.toggle('is-fullscreen', mode === 'fullscreen');
		this._element.classList.toggle('is-pip', mode === 'pip');
		if (mode === 'fullscreen') {
			this._element.tabIndex = -1;
			this._element.focus();
		}
		return mode;
	}

	/** `resources/read` always goes to the app's own server, whatever the app asks for. */
	private async readResource(server: string, uri: string): Promise<readonly ClaudeMcpAppResource[]> {
		const sessionId = this._chat.runtimeSessionId();
		if (!sessionId || !this._runtime.readMcpResource) {
			throw new Error(localize('claudeMcpAppNoSession', "The chat is not running, so its MCP server cannot be read."));
		}
		const contents = await this._runtime.readMcpResource(sessionId, server, uri);
		return contents.map(({ uri, mimeType, text, blob }) => ({ uri, ...(mimeType ? { mimeType } : {}), ...(text !== undefined ? { text } : {}), ...(blob !== undefined ? { blob } : {}) }));
	}

	/** `ui/download-file`: the user picks where the file goes; nothing is written without that. */
	private async saveFile(file: ClaudeMcpAppFile): Promise<boolean> {
		try {
			const folder = await this._fileDialogs.defaultFilePath();
			const target = await this._fileDialogs.showSaveDialog({
				title: localize('claudeMcpAppSaveTitle', "Save File from {0}", this._app?.server ?? ''),
				defaultUri: joinPath(folder, file.name),
			});
			if (!target) {
				return false;
			}
			await this._files.writeFile(target, file.blob !== undefined ? decodeBase64(file.blob) : VSBuffer.fromString(file.text ?? ''));
			return true;
		} catch {
			return false;
		}
	}

	private hostContext(): ClaudeMcpAppHostContext {
		return {
			theme: isDark(this._themes.getColorTheme().type) ? 'dark' : 'light',
			styles: { variables: CLAUDE_MCP_APP_STYLE_VARIABLES },
			displayMode: this._mode,
			availableDisplayModes: ['inline', 'fullscreen', 'pip'],
			containerDimensions: { width: this._element.clientWidth, maxHeight: CLAUDE_MCP_APP_MAX_HEIGHT },
			platform: 'desktop',
			...(language ? { locale: language } : {}),
		};
	}
}
