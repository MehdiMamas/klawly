/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * True when Claude rejected the stored resume id. A disk, network, or runtime
 * failure uses different wording and stays retryable.
 * "No conversation found" is the Agent SDK's refusal for an unknown resume id.
 */
export function isClaudeResumeRejection(error: unknown): boolean {
	const message = errorText(error);
	return /cannot be resumed|no resumable|unknown session|invalid session|session not found|resume failed|no conversation found/i.test(message);
}

/**
 * Wording to keep when a resume id was sent and Claude refused that id.
 * Other failures keep the generic classifier message.
 */
export function resumeFailureMessage(error: unknown, resume: string | undefined): string | undefined {
	if (!resume || !isClaudeResumeRejection(error)) {
		return undefined;
	}
	return errorText(error) || 'No conversation found';
}

function errorText(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return typeof error === 'string' ? error : '';
}
