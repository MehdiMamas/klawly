/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { AgentMode } from '../../../../platform/claude/common/claudeContext.js';
import { readClaudeCodeSessionId } from './claudeAgentLinks.js';
import { ClaudeTerminalHandoff, parseClaudeTerminalHandoff } from './claudeTerminalHandoff.js';

/**
 * A prompt carried from a `klawly://agent/new?folder=` link into the window of that folder
 * (issue 861). The window that got the link leaves it in application storage; the window
 * that has the folder open takes it, once, and puts the prompt in a new chat's composer.
 * Nothing in it is ever sent. With `resume` the chat continues that Claude Code session (issue 1186).
 */
export interface ClaudeChatHandoff {
	/** The folder the prompt is for, an absolute path. */
	readonly folder: string;
	readonly prompt: string;
	readonly mode?: AgentMode;
	/** The Claude Code session id the new chat resumes, from a `klawly://agent/import` link. */
	readonly resume?: string;
	/** The terminal session's handoff note, shown as a card in the resumed chat (issue 1186). */
	readonly card?: ClaudeTerminalHandoff;
	/** Milliseconds since the epoch when the link was accepted. */
	readonly createdAt: number;
}

/** The application storage key a handoff waits under. */
export const CLAUDE_CHAT_HANDOFF_KEY = 'klawly.chatHandoff';

/** A handoff nobody took in this long is dropped: it is stale, not meant for a later visit to the folder. */
export const CLAUDE_CHAT_HANDOFF_MAX_AGE_MS = 2 * 60 * 1000;

export function serializeClaudeChatHandoff(handoff: ClaudeChatHandoff): string {
	return JSON.stringify(handoff);
}

/** The stored handoff, or undefined when it is missing, malformed or older than the limit. */
export function parseClaudeChatHandoff(raw: string | undefined, now: number): ClaudeChatHandoff | undefined {
	if (!raw) {
		return undefined;
	}
	let value: Partial<ClaudeChatHandoff> | null;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value?.folder !== 'string' || typeof value.prompt !== 'string' || typeof value.createdAt !== 'number') {
		return undefined;
	}
	const age = now - value.createdAt;
	if (age < 0 || age > CLAUDE_CHAT_HANDOFF_MAX_AGE_MS) {
		return undefined;
	}
	const mode = value.mode === 'agent' || value.mode === 'plan' || value.mode === 'ask' ? value.mode : undefined;
	const resume = readClaudeCodeSessionId(value.resume);
	const card = value.card ? parseClaudeTerminalHandoff(JSON.stringify(value.card)) : undefined;
	return { folder: value.folder, prompt: value.prompt, createdAt: value.createdAt, ...(mode ? { mode } : {}), ...(resume ? { resume } : {}), ...(card ? { card } : {}) };
}

/** Whether a window whose folders are these is the one the handoff is for. */
export function claudeChatHandoffIsFor(handoff: ClaudeChatHandoff, windowFolders: readonly string[]): boolean {
	const bare = (path: string) => URI.file(path.length > 1 ? path.replace(/[\\/]+$/, '') || path : path);
	const target = bare(handoff.folder);
	return windowFolders.some(folder => extUriBiasedIgnorePathCase.isEqual(bare(folder), target));
}
