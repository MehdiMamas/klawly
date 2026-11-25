/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64 } from '../../../base/common/buffer.js';
import { McpApps } from '../../mcp/common/modelContextProtocolApps.js';

// MCP Apps (issue 513): an MCP tool can name a `ui://` resource, an HTML app that
// Klawly draws under the tool's card in a sandboxed webview.

/** A tool of an MCP server that draws an app. */
export interface ClaudeMcpAppTool {
	/** The tool's name on its server, such as `forecast`. */
	readonly tool: string;
	/** The app's `ui://` resource. */
	readonly resourceUri: string;
	/** Who may call the tool. Absent means Claude and the app. */
	readonly visibility?: readonly McpApps.McpUiToolVisibility[];
}

/** One item of a `ui://` resource read, as Claude Code returns it. */
export interface ClaudeMcpResourceContent {
	readonly uri: string;
	readonly mimeType?: string;
	readonly text?: string;
	/** Base64, for a binary item. */
	readonly blob?: string;
	/** The item's own `_meta`, where the server puts the app's CSP. */
	readonly meta?: Readonly<Record<string, unknown>>;
}

/** An app ready to draw: its HTML and what its server lets it load. */
export interface ClaudeMcpApp {
	readonly server: string;
	readonly tool: string;
	readonly uri: string;
	readonly html: string;
	readonly mimeType: string;
	readonly csp?: McpApps.McpUiResourceCsp;
	/** The app asks for a visible border around it. */
	readonly prefersBorder?: boolean;
}

/** An app that loaded, or why it did not. */
export type ClaudeMcpAppLoad =
	| { readonly ok: true; readonly app: ClaudeMcpApp }
	| { readonly ok: false; readonly message: string };

/** The largest app Klawly draws, in characters of HTML. */
export const CLAUDE_MCP_APP_MAX_HTML = 2 * 1024 * 1024;

const UI_SCHEME = 'ui://';

/** A server or tool name as Claude Code puts it in a tool name: characters other than letters, digits, `_` and `-` become `_`. */
function normalizeMcpName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** The name Claude Code gives a server's tool, such as `mcp__weather__forecast`. */
export function claudeMcpToolName(server: string, tool: string): string {
	return `mcp__${normalizeMcpName(server)}__${normalizeMcpName(tool)}`;
}

/** The server and app tool that Claude Code's tool name `toolName` calls, or `undefined` when it draws no app. */
export function findClaudeMcpApp<T extends { readonly name: string; readonly apps?: readonly ClaudeMcpAppTool[] }>(toolName: string, servers: readonly T[]): { readonly server: T; readonly app: ClaudeMcpAppTool } | undefined {
	for (const server of servers) {
		const app = server.apps?.find(candidate => claudeMcpToolName(server.name, candidate.tool) === toolName);
		if (app) {
			return { server, app };
		}
	}
	return undefined;
}

/**
 * The app a tool's `_meta` names: `ui.resourceUri`, or the older flat
 * `ui/resourceUri`. Only `ui://` resources count.
 */
export function readClaudeMcpAppTool(tool: string, meta: unknown): ClaudeMcpAppTool | undefined {
	if (!isRecord(meta)) {
		return undefined;
	}
	const ui = isRecord(meta.ui) ? meta.ui : undefined;
	const uri = typeof ui?.resourceUri === 'string' ? ui.resourceUri : meta['ui/resourceUri'];
	if (typeof uri !== 'string' || !uri.startsWith(UI_SCHEME)) {
		return undefined;
	}
	const visibility = Array.isArray(ui?.visibility) ? ui.visibility.filter((value): value is McpApps.McpUiToolVisibility => value === 'model' || value === 'app') : [];
	return visibility.length ? { tool, resourceUri: uri, visibility } : { tool, resourceUri: uri };
}

/**
 * The app in a `ui://` resource read: the first HTML item (or the first item),
 * as text or base64, with the CSP and border its `_meta.ui` asks for.
 */
export function claudeMcpAppFromContents(server: string, tool: string, uri: string, contents: readonly ClaudeMcpResourceContent[]): ClaudeMcpAppLoad {
	const content = contents.find(item => item.mimeType?.startsWith('text/html')) ?? contents[0];
	if (!content) {
		return { ok: false, message: `The ${server} MCP server returned nothing for ${uri}.` };
	}
	const html = content.text ?? (content.blob !== undefined ? decodeBase64(content.blob).toString() : undefined);
	if (html === undefined) {
		return { ok: false, message: `The ${server} MCP server returned no HTML for ${uri}.` };
	}
	if (html.length > CLAUDE_MCP_APP_MAX_HTML) {
		return { ok: false, message: `The app in ${uri} is larger than Klawly draws (2 MB).` };
	}
	const ui = isRecord(content.meta?.ui) ? content.meta.ui : undefined;
	const csp = readCsp(ui?.csp);
	return {
		ok: true,
		app: {
			server,
			tool,
			uri,
			html,
			mimeType: content.mimeType ?? 'text/html',
			...(csp ? { csp } : {}),
			...(typeof ui?.prefersBorder === 'boolean' ? { prefersBorder: ui.prefersBorder } : {}),
		},
	};
}

/** The CSP origins a resource asks for, keeping only lists of strings. */
function readCsp(value: unknown): McpApps.McpUiResourceCsp | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const csp: { [K in keyof McpApps.McpUiResourceCsp]: string[] } = {};
	for (const key of ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'] as const) {
		const list = value[key];
		if (Array.isArray(list)) {
			csp[key] = list.filter((item): item is string => typeof item === 'string');
		}
	}
	return Object.keys(csp).length ? csp : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
