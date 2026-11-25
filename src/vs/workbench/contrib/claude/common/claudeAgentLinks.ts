/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentMode } from '../../../../platform/claude/common/claudeContext.js';

/**
 * Klawly from the terminal and links (issue 519). `klawly://agent/new?prompt=...`
 * opens a new chat with the prompt in the composer, never sent: a link can come
 * from any web page. `&folder=<absolute path>` hands the prompt to that folder's window,
 * after the user agrees to open it (issue 861). `klawly://agent/open?session=<id>` opens a saved chat.
 * `klawly://agent/import?session=<Claude Code session id>&folder=<absolute path>&handoff=<text>` opens a
 * Claude Code terminal session in that folder's window as the same conversation, after the user agrees;
 * the handoff text waits in the composer, never sent (issue 1186).
 */
export type ClaudeAgentLink =
	| { readonly kind: 'new'; readonly prompt: string; readonly mode?: AgentMode; readonly folder?: string }
	| { readonly kind: 'open'; readonly session: string }
	| { readonly kind: 'import'; readonly session: string; readonly folder: string; readonly handoff: string };

/** Longest prompt a link may carry. */
const MAX_LINK_PROMPT = 8000;

/** The agent link a URI names, as `<protocol>://agent/<action>` or `<protocol>:agent/<action>`; undefined for any other. */
export function readClaudeAgentLink(authority: string, path: string, query: string): ClaudeAgentLink | undefined {
	const route = `${authority}/${path.replace(/^\/+/, '')}`.replace(/^\/+/, '').replace(/\/+$/, '');
	const params = new URLSearchParams(query);
	if (route === 'agent/new') {
		const prompt = (params.get('prompt') ?? '').slice(0, MAX_LINK_PROMPT);
		const mode = readClaudeLinkMode(params.get('mode'));
		const folder = readClaudeLinkFolder(params.get('folder'));
		return { kind: 'new', prompt, ...(mode ? { mode } : {}), ...(folder ? { folder } : {}) };
	}
	if (route === 'agent/open') {
		const session = params.get('session') ?? '';
		return /^[\w-]{1,128}$/.test(session) ? { kind: 'open', session } : undefined;
	}
	if (route === 'agent/import') {
		const session = readClaudeCodeSessionId(params.get('session'));
		const folder = readClaudeLinkFolder(params.get('folder'));
		const handoff = (params.get('handoff') ?? '').slice(0, MAX_LINK_PROMPT);
		return session && folder ? { kind: 'import', session, folder, handoff } : undefined;
	}
	return undefined;
}

/** A Claude Code session id, which is a UUID, in lower case; undefined for anything else. */
export function readClaudeCodeSessionId(value: string | null | undefined): string | undefined {
	return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : undefined;
}

/** Longest folder path a link may name. */
const MAX_LINK_FOLDER = 1024;

/** An absolute local folder path (`/a/b`, `C:\a\b` or `C:/a/b`) without control characters or `..` parts; undefined for anything else. */
export function readClaudeLinkFolder(value: string | null | undefined): string | undefined {
	if (!value || value.length > MAX_LINK_FOLDER || /[\u0000-\u001f]/.test(value)) {
		return undefined;
	}
	if (!/^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(value) || value.split(/[\\/]/).includes('..')) {
		return undefined;
	}
	return value;
}

/** `agent`, `plan` or `ask`; upstream's `edit` mode is Klawly's agent. Anything else is undefined. */
export function readClaudeLinkMode(value: string | null | undefined): AgentMode | undefined {
	switch (value?.toLowerCase()) {
		case 'agent':
		case 'edit':
			return 'agent';
		case 'plan':
			return 'plan';
		case 'ask':
			return 'ask';
		default:
			return undefined;
	}
}
