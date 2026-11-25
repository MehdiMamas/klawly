/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ToolResultImage } from '../../../../platform/claude/common/claudeProtocol.js';
import { McpApps } from '../../../../platform/mcp/common/modelContextProtocolApps.js';

/** The tool call an MCP App draws (issue 513): what Claude sent and what the server answered. */
export interface ClaudeMcpAppCall {
	readonly server: string;
	readonly tool: string;
	readonly input: Readonly<Record<string, unknown>>;
	/** The tool's text result, once the call ended. */
	readonly output?: string;
	/** Raster images in the result. */
	readonly images?: readonly ToolResultImage[];
	/** The result's `structuredContent`. */
	readonly structuredContent?: Readonly<Record<string, unknown>>;
	readonly done: boolean;
	readonly failed: boolean;
}

/** The host side of an MCP App: the card that draws it. */
export interface ClaudeMcpAppBridgeHost {
	/** Sends a JSON-RPC message to the app. */
	post(message: object): void;
	/** The app asked for this height in pixels. */
	resize(height: number): void;
	/** Opens an http or https link in the browser; false when it did not open. */
	openLink(url: URI): Promise<boolean>;
	/** Adds text to the composer's draft for the user to send; false when the composer shows another chat. */
	draft(text: string): boolean;
	/** The theme, fonts and size the app draws with. */
	hostContext(): ClaudeMcpAppHostContext;
	/** Draws the app in `mode` and returns the mode it now draws in (the old one when the mode is not available). */
	setDisplayMode(mode: McpApps.McpUiDisplayMode): McpApps.McpUiDisplayMode;
	/** Reads a resource of the app's own MCP server. */
	readResource(uri: string): Promise<readonly ClaudeMcpAppResource[]>;
	/** Asks the user where to save a file the app made; false when the user said no or the write failed. */
	saveFile(file: ClaudeMcpAppFile): Promise<boolean>;
}

/** One item of a resource an app read. */
export interface ClaudeMcpAppResource {
	readonly uri: string;
	readonly mimeType?: string;
	readonly text?: string;
	/** Base64, for a binary item. */
	readonly blob?: string;
}

/** A file an app asks the host to save. */
export interface ClaudeMcpAppFile {
	/** The file name, last segment of the resource's URI. */
	readonly name: string;
	readonly mimeType?: string;
	readonly text?: string;
	/** Base64. */
	readonly blob?: string;
}

/** What Klawly tells an app about where it draws: a subset of the MCP Apps host context. */
export interface ClaudeMcpAppHostContext {
	readonly theme: McpApps.McpUiTheme;
	readonly styles: { readonly variables: Readonly<Record<string, string>> };
	readonly displayMode: McpApps.McpUiDisplayMode;
	readonly availableDisplayModes: readonly McpApps.McpUiDisplayMode[];
	readonly containerDimensions: { readonly width: number; readonly maxHeight: number };
	readonly platform: 'desktop';
	readonly locale?: string;
}

/** The app draws with the workbench theme: MCP Apps style variables mapped to theme colors and fonts. */
export const CLAUDE_MCP_APP_STYLE_VARIABLES: Readonly<Record<string, string>> = {
	'--color-background-primary': 'var(--vscode-editor-background)',
	'--color-background-secondary': 'var(--vscode-sideBar-background)',
	'--color-background-tertiary': 'var(--vscode-editorWidget-background)',
	'--color-background-inverse': 'var(--vscode-editor-foreground)',
	'--color-background-ghost': 'transparent',
	'--color-background-info': 'var(--vscode-inputValidation-infoBackground)',
	'--color-background-danger': 'var(--vscode-inputValidation-errorBackground)',
	'--color-background-warning': 'var(--vscode-inputValidation-warningBackground)',
	'--color-text-primary': 'var(--vscode-foreground)',
	'--color-text-secondary': 'var(--vscode-descriptionForeground)',
	'--color-text-tertiary': 'var(--vscode-disabledForeground)',
	'--color-text-inverse': 'var(--vscode-editor-background)',
	'--color-text-info': 'var(--vscode-textLink-foreground)',
	'--color-text-danger': 'var(--vscode-errorForeground)',
	'--color-text-warning': 'var(--vscode-editorWarning-foreground)',
	'--color-border-primary': 'var(--vscode-widget-border)',
	'--color-border-secondary': 'var(--vscode-editorWidget-border)',
	'--color-ring-primary': 'var(--vscode-focusBorder)',
	'--font-sans': 'var(--vscode-font-family)',
	'--font-mono': 'var(--vscode-editor-font-family)',
	'--font-text-sm-size': '11px',
	'--font-text-md-size': '13px',
	'--border-radius-sm': '3px',
	'--border-radius-md': '4px',
	'--border-radius-lg': '6px',
};

/** The tallest an app draws inline, in pixels; past it the app scrolls. */
export const CLAUDE_MCP_APP_MAX_HEIGHT = 560;
/** The shortest an app draws, so a zero height still shows a strip. */
export const CLAUDE_MCP_APP_MIN_HEIGHT = 32;

const METHOD_NOT_FOUND = -32601;

interface JsonRpcMessage {
	readonly id?: string | number;
	readonly method: string;
	readonly params?: unknown;
}

/**
 * The host half of the MCP Apps protocol for one app (issue 513). The app asks
 * over JSON-RPC; Klawly answers what it can from the tool call it drew:
 * `ui/initialize` (then the call's input and result), sizes, links (http and
 * https only), messages for the composer and pings. Klawly never sends anything
 * to Claude on its own: a message or a tool call the app asks for goes into the
 * composer for the user to send.
 */
export class ClaudeMcpAppBridge {
	private _initialized = false;
	private _sentResult = false;

	constructor(
		private _call: ClaudeMcpAppCall,
		private readonly _host: ClaudeMcpAppBridgeHost,
		private readonly _hostInfo: { readonly name: string; readonly version: string },
	) { }

	/** The call changed, such as when its result came in. */
	update(call: ClaudeMcpAppCall): void {
		this._call = call;
		this.sendResult();
	}

	/** The theme or the width changed. */
	hostContextChanged(): void {
		if (this._initialized) {
			this.notify('ui/notifications/host-context-changed', this._host.hostContext());
		}
	}

	/** One message from the app. Anything that is not JSON-RPC is dropped. */
	async handle(message: unknown): Promise<void> {
		const request = readMessage(message);
		if (!request) {
			return;
		}
		const params = isRecord(request.params) ? request.params : {};
		switch (request.method) {
			case 'ui/initialize':
				this.respond(request, this.initialize());
				this._initialized = true;
				this.notify('ui/notifications/tool-input', { arguments: this._call.input });
				this.sendResult();
				return;
			case 'ui/notifications/size-changed':
				if (typeof params.height === 'number' && Number.isFinite(params.height)) {
					this._host.resize(Math.min(CLAUDE_MCP_APP_MAX_HEIGHT, Math.max(CLAUDE_MCP_APP_MIN_HEIGHT, Math.ceil(params.height))));
				}
				return;
			case 'ui/open-link':
				this.respond(request, { isError: !(await this.openLink(params.url)) });
				return;
			case 'ui/message': {
				const text = textOf(params.content);
				this.respond(request, { isError: !text || !this._host.draft(text) });
				return;
			}
			case 'tools/call':
				this.respond(request, this.callTool(params));
				return;
			case 'ui/request-display-mode': {
				const hostContext = this._host.hostContext();
				const mode = params.mode === 'inline' || params.mode === 'fullscreen' || params.mode === 'pip' ? params.mode : undefined;
				const result = mode && hostContext.availableDisplayModes.includes(mode) ? this._host.setDisplayMode(mode) : hostContext.displayMode;
				this.respond(request, { mode: result });
				if (result !== hostContext.displayMode) {
					this.hostContextChanged();
				}
				return;
			}
			case 'resources/read':
				this.respond(request, await this.readResource(params.uri));
				return;
			case 'ui/download-file':
				this.respond(request, { isError: !(await this.download(params.contents)) });
				return;
			case 'ping':
				this.respond(request, {});
				return;
			case 'ui/notifications/initialized':
			case 'notifications/message':
			case 'ui/notifications/sandbox-wheel':
				return;
			default:
				if (request.id !== undefined) {
					this._host.post({ jsonrpc: '2.0', id: request.id, error: { code: METHOD_NOT_FOUND, message: `Klawly does not support ${request.method} in MCP Apps yet.` } });
				}
		}
	}

	private initialize(): Omit<McpApps.McpUiInitializeResult, 'hostContext'> & { readonly hostContext: ClaudeMcpAppHostContext } {
		return {
			protocolVersion: McpApps.LATEST_PROTOCOL_VERSION,
			hostInfo: { name: this._hostInfo.name, version: this._hostInfo.version },
			hostCapabilities: {
				openLinks: {},
				logging: {},
				message: { text: {} },
				serverResources: {},
				downloadFile: {},
			},
			hostContext: this._host.hostContext(),
		};
	}

	private async openLink(url: unknown): Promise<boolean> {
		if (typeof url !== 'string') {
			return false;
		}
		let parsed: URI;
		try {
			parsed = URI.parse(url, true);
		} catch {
			return false;
		}
		// The protocol means a web page: other schemes could reach the workbench's own handlers.
		return (parsed.scheme === 'http' || parsed.scheme === 'https') && this._host.openLink(parsed);
	}

	/** `resources/read` for a resource of the app's own server; a failure comes back as a JSON-RPC style error text. */
	private async readResource(uri: unknown): Promise<object> {
		if (typeof uri !== 'string' || !uri) {
			return { contents: [] };
		}
		try {
			return { contents: await this._host.readResource(uri) };
		} catch (error) {
			return { contents: [], isError: true, message: error instanceof Error ? error.message : String(error) };
		}
	}

	/** `ui/download-file`: each embedded resource is saved where the user says; resource links are not fetched. */
	private async download(contents: unknown): Promise<boolean> {
		if (!Array.isArray(contents) || !contents.length) {
			return false;
		}
		let saved = false;
		for (const item of contents) {
			const file = readDownload(item);
			if (!file) {
				return false;
			}
			if (!(await this._host.saveFile(file))) {
				return saved;
			}
			saved = true;
		}
		return saved;
	}

	/**
	 * Klawly cannot call an MCP tool for an app yet, so it drafts the call for
	 * the user to send to Claude, who runs it through the usual permission ask.
	 */
	private callTool(params: Record<string, unknown>): object {
		const name = typeof params.name === 'string' ? params.name : undefined;
		if (!name) {
			return toolText(localize('claudeMcpAppNoTool', "The app asked for a tool call without a tool name."));
		}
		const args = isRecord(params.arguments) ? params.arguments : {};
		const draft = localize('claudeMcpAppToolDraft', "Call the {0} tool of the {1} MCP server with these arguments:\n```json\n{2}\n```", name, this._call.server, JSON.stringify(args, undefined, 2));
		return toolText(this._host.draft(draft)
			? localize('claudeMcpAppToolDrafted', "Klawly put this call in the composer. Claude runs it when the user sends it.")
			: localize('claudeMcpAppToolBusy', "Klawly could not put this call in the composer because it shows another chat."));
	}

	private sendResult(): void {
		if (!this._initialized || this._sentResult || !this._call.done) {
			return;
		}
		this._sentResult = true;
		const result: McpApps.HostNotification = {
			method: 'ui/notifications/tool-result',
			params: {
				content: [
					{ type: 'text', text: this._call.output ?? '' },
					...(this._call.images ?? []).map(image => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
				],
				...(this._call.structuredContent ? { structuredContent: this._call.structuredContent } : {}),
				isError: this._call.failed,
			},
		};
		this.notify(result.method, result.params);
	}

	private respond(request: JsonRpcMessage, result: object): void {
		if (request.id !== undefined) {
			this._host.post({ jsonrpc: '2.0', id: request.id, result });
		}
	}

	private notify(method: string, params: object): void {
		this._host.post({ jsonrpc: '2.0', method, params });
	}
}

/** A tools/call answer of one text block, marked as an error because the tool did not run. */
function toolText(text: string): object {
	return { content: [{ type: 'text', text }], isError: true };
}

/** The text blocks of a ui/message, joined. Images and other blocks are left out. */
function textOf(content: unknown): string {
	if (!Array.isArray(content)) {
		return '';
	}
	return content.filter(isRecord).map(block => block.type === 'text' && typeof block.text === 'string' ? block.text : '').filter(Boolean).join('\n\n').trim();
}

/** The file name of an `ui/download-file` item: the last segment of its URI, or `download`. */
function readDownload(item: unknown): ClaudeMcpAppFile | undefined {
	if (!isRecord(item) || item.type !== 'resource' || !isRecord(item.resource)) {
		return undefined;
	}
	const { uri, mimeType, text, blob } = item.resource;
	if (typeof text !== 'string' && typeof blob !== 'string') {
		return undefined;
	}
	const last = typeof uri === 'string' ? uri.split(/[?#]/)[0].split('/').filter(Boolean).pop() : undefined;
	// Only a plain file name: no path separators or control characters reach the save dialog.
	const name = last && !/[\\/:\u0000-\u001f]/.test(last) ? last : 'download';
	return {
		name,
		...(typeof mimeType === 'string' ? { mimeType } : {}),
		...(typeof text === 'string' ? { text } : {}),
		...(typeof blob === 'string' ? { blob } : {}),
	};
}

function readMessage(message: unknown): JsonRpcMessage | undefined {
	if (!isRecord(message) || typeof message.method !== 'string') {
		return undefined;
	}
	const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined;
	return { id, method: message.method, params: message.params };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
