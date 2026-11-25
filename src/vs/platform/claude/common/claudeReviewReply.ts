/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeReviewFinding } from './claudeReviewLoop.js';

/** One message of a finding thread: what the person wrote, or what Claude answered (issue 929). */
export interface ClaudeFindingReply {
	readonly role: 'user' | 'assistant';
	readonly text: string;
}

/** What a finding thread keeps beyond the finding itself; saved with the review. */
export interface ClaudeFindingThread {
	readonly findingId: string;
	readonly replies: readonly ClaudeFindingReply[];
	/** Marked as intended: counts as a dismissal for the learning of issue 923. */
	readonly intended?: boolean;
}

/** The most code lines, and thread messages, a reply turn is given. */
const MAX_CONTEXT_LINES = 60;
const MAX_CONTEXT_REPLIES = 12;

/**
 * The prompt of a read-only reply turn: the finding, the code around it, the
 * review summary and the conversation so far, ending with the new message.
 * Pure; the caller supplies `code` (the lines around the finding).
 */
export function buildFindingReplyContext(finding: ClaudeReviewFinding, code: readonly string[], summary: string | undefined, replies: readonly ClaudeFindingReply[], message: string): string {
	const lines = code.slice(0, MAX_CONTEXT_LINES);
	const kindLine = finding.kind === 'question'
		? 'The reviewer asked this question because the intent was unclear. Treat the answer as the author\'s intent.'
		: 'The reviewer reported this finding.';
	return [
		'You are answering in the thread of a code review finding. Answer briefly. Read files if you need to; do not edit anything.',
		kindLine,
		'',
		`<finding file="${finding.file}" lines="${finding.startLine}-${finding.endLine}" severity="${finding.severity}">`,
		finding.title,
		finding.body,
		...(finding.suggestion ? [`Suggested fix:\n${finding.suggestion}`] : []),
		'</finding>',
		'<code>',
		...lines,
		'</code>',
		...(summary?.trim() ? ['<review_summary>', summary.trim(), '</review_summary>'] : []),
		...(replies.length ? ['<thread>', ...replies.slice(-MAX_CONTEXT_REPLIES).map(reply => `${reply.role === 'user' ? 'Author' : 'Reviewer'}: ${reply.text}`), '</thread>'] : []),
		'',
		`Author: ${message.trim()}`,
	].filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n');
}

/** Appends a message to a thread; empty text changes nothing. */
export function appendFindingReply(thread: ClaudeFindingThread, reply: ClaudeFindingReply): ClaudeFindingThread {
	const text = reply.text.trim();
	return text ? { ...thread, replies: [...thread.replies, { role: reply.role, text }] } : thread;
}
