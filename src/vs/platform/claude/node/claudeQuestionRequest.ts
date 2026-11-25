/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_ELICITATION_TIMEOUT_MS, ClaudeElicitationRequest } from '../common/claudeElicitation.js';
import { CLAUDE_QUESTION_ASKER, CLAUDE_QUESTION_DECLINED, ClaudeQuestion, claudeQuestionNotes, claudeQuestionReply, claudeQuestionResult } from '../common/claudeQuestion.js';
import { ClaudeElicitationContext } from './claudeElicitationBridge.js';
import { ClaudeToolPermission } from './claudeQuery.js';

/** Why the runtime declined when the wait ended without the user. */
const QUESTION_TIMED_OUT = 'The user did not answer the questions in time.';
const QUESTION_STOPPED = 'The session stopped before the user answered.';

/**
 * The runner's answer to an `AskUserQuestion` call (issue 477): shows the
 * questions as a `question` elicitation, waits on the bridge and hands the
 * answers to the SDK as the tool's `updatedInput`. A reply in place of the
 * answers goes as the SDK's `response`, which Claude reads and acts on. A
 * decline, a timeout or a stopped session denies the call with a message, so
 * the turn never hangs.
 */
export async function runClaudeQuestion(
	context: Pick<ClaudeElicitationContext, 'bridge' | 'sessionId' | 'push' | 'timeoutMs' | 'now'>,
	toolUseId: string,
	questions: readonly ClaudeQuestion[],
	input: Record<string, unknown>,
	signal: AbortSignal,
): Promise<ClaudeToolPermission> {
	const timeoutMs = context.timeoutMs ?? CLAUDE_ELICITATION_TIMEOUT_MS;
	const { sessionId } = context;
	const request: ClaudeElicitationRequest = {
		id: toolUseId,
		server: CLAUDE_QUESTION_ASKER,
		mode: 'question',
		// The toast and the agents list show the message, so it is the first question.
		message: questions[0].question,
		questions,
		expiresAt: (context.now?.() ?? Date.now()) + timeoutMs,
	};
	context.push({ type: 'elicitation.requested', sessionId, request });
	const settled = await context.bridge.request({ sessionId, id: toolUseId, signal, timeoutMs });
	const { answer } = settled;
	const reply = answer.action === 'accept' ? claudeQuestionReply(answer.reply) : undefined;
	const result = reply ?? (answer.action === 'accept' && answer.content ? claudeQuestionResult(questions, answer.content, answer.notes) : undefined);
	// An accept without an answer to every question is a decline: Claude gets nothing it would have to guess at.
	const action = result ? 'accept' : answer.action === 'cancel' ? 'cancel' : 'decline';
	const notes = result && claudeQuestionNotes(result);
	const shown = reply?.response ? { reply: reply.response } : result ? { answers: { ...result.answers }, ...(notes ? { notes } : {}) } : {};
	context.push({ type: 'elicitation.resolved', sessionId, outcome: { id: toolUseId, server: CLAUDE_QUESTION_ASKER, mode: 'question', action, source: settled.source, ...shown } });
	if (result) {
		return { behavior: 'allow', updatedInput: { ...input, ...result } };
	}
	return { behavior: 'deny', message: settled.source === 'timeout' ? QUESTION_TIMED_OUT : settled.source === 'session-stopped' ? QUESTION_STOPPED : CLAUDE_QUESTION_DECLINED };
}
