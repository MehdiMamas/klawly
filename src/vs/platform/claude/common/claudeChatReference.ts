/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ContextAttachment } from './claudeContext.js';

/** Default cap for `claude.chatReferences.summaryChars`. */
export const CLAUDE_CHAT_REFERENCE_SUMMARY_DEFAULT = 1500;

export const CLAUDE_CHAT_DRAG_MIME = 'application/vnd.klawly.chat';

export interface ChatDragPayload {
	readonly sessionId: string;
	readonly subagentId?: string;
	readonly turnId?: string;
	readonly asOfTurn: number;
}

export interface ChatReferenceInput {
	readonly title: string;
	readonly sessionId: string;
	readonly turnStart: number;
	readonly turnEnd: number;
	readonly asOfTurn: number;
	readonly path: string;
	readonly summary: string;
	readonly fullTranscript?: string;
	readonly scope: 'summary' | 'full';
	readonly deleted: boolean;
	readonly workspaceName?: string;
	readonly otherWorkspace: boolean;
}

export function chatReferenceSummary(input: {
	readonly title: string;
	readonly firstUser: string;
	readonly finalAssistant: string;
	readonly changedFiles: readonly string[];
	readonly openTodos: readonly string[];
}, cap: number): string {
	const files = input.changedFiles.length ? input.changedFiles.join(', ') : 'none';
	const todos = input.openTodos.length ? input.openTodos.join('; ') : 'none';
	const text = `${input.title}. First request: ${oneLine(input.firstUser)}. Final result: ${oneLine(input.finalAssistant)}. Changed files: ${files}. Open todos: ${todos}.`;
	const limit = Math.max(1, cap);
	return text.length <= limit ? text : text.slice(0, limit);
}

export function encodeChatDrag(payload: ChatDragPayload): string {
	return JSON.stringify(payload);
}

export function parseChatDrag(raw: string): ChatDragPayload | undefined {
	try {
		const parsed = JSON.parse(raw) as ChatDragPayload;
		if (!parsed || typeof parsed.sessionId !== 'string' || typeof parsed.asOfTurn !== 'number') {
			return undefined;
		}
		return parsed;
	} catch {
		return undefined;
	}
}

/** A new session seeded when Claude cannot resume the old one. */
export function continueSessionSummary(input: {
	readonly title: string;
	readonly workspaceName: string;
	readonly firstUser: string;
	readonly finalAssistant: string;
	readonly changedFiles: readonly string[];
}): string {
	const files = input.changedFiles.length ? input.changedFiles.join(', ') : 'none';
	return [
		`Continue the conversation "${input.title}" in this workspace (${input.workspaceName}).`,
		`The previous Claude session could not be resumed. This is a summary, not a rerun of its tools.`,
		`First request: ${oneLine(input.firstUser)}`,
		`Last result: ${oneLine(input.finalAssistant)}`,
		`Changed files: ${files}`,
	].join('\n');
}

/**
 * Context sent to Claude ahead of a fork's first message. The new Claude session has
 * none of the prior turns, and the composer stays empty for the user.
 */
export function forkSessionSeed(input: {
	readonly title: string;
	readonly workspaceName: string;
	readonly firstUser: string;
	readonly finalAssistant: string;
	readonly changedFiles: readonly string[];
}): string {
	const files = input.changedFiles.length ? input.changedFiles.join(', ') : 'none';
	return [
		`This chat was forked from "${input.title}" in ${input.workspaceName}.`,
		'You do not have its transcript. This summary is all that carried over; the message after it is the user\'s next request.',
		`First request: ${oneLine(input.firstUser)}`,
		`Last result: ${oneLine(input.finalAssistant)}`,
		`Changed files: ${files}`,
	].join('\n');
}

function oneLine(text: string): string {
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length > 240 ? `${line.slice(0, 240)}…` : line || 'none';
}

type ChatAttachment = Extract<ContextAttachment, { kind: 'chat' }>;

/**
 * Which chat a reference points to: the session, the subagent, and the turns. A
 * reference to a whole chat matches another whole-chat reference to it, whatever
 * turn each was taken at.
 */
function chatReferenceKey(attachment: ChatAttachment): string {
	const range = attachment.turnRange;
	const whole = !range || (range[0] === 1 && range[1] === attachment.asOfTurn);
	return JSON.stringify([attachment.sessionId, attachment.subagentId ?? null, whole ? null : range]);
}

/**
 * Adds `attachment` to a composer's attachments. A chat that is already
 * referenced is not added twice: the newer reference replaces the old one in
 * place, so it covers the latest turns, and keeps the summary or full
 * transcript choice made on the chip. Other attachments are appended.
 */
export function withChatAttachment(existing: readonly ContextAttachment[], attachment: ContextAttachment): ContextAttachment[] {
	if (attachment.kind !== 'chat') {
		return [...existing, attachment];
	}
	const key = chatReferenceKey(attachment);
	const index = existing.findIndex(item => item.kind === 'chat' && chatReferenceKey(item) === key);
	if (index < 0) {
		return [...existing, attachment];
	}
	const previous = existing[index] as ChatAttachment;
	const next = existing.slice();
	next[index] = { ...attachment, scope: previous.scope };
	return next;
}
