/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Share to Phone (issue 517): Claude Code's Remote Control on a running Klawly
 * chat, so the Claude app and claude.ai/code on the user's own Claude account
 * can follow the chat and send it messages. Klawly runs no relay: Claude Code
 * connects the session to the account, and permission requests still resolve
 * in Klawly.
 */

/** Starts Remote Control on the current chat and shows where to open it. */
export const CLAUDE_SHARE_TO_PHONE_COMMAND_ID = 'klawly.chat.shareToPhone';
/** Stops Remote Control on the current chat. */
export const CLAUDE_STOP_SHARING_TO_PHONE_COMMAND_ID = 'klawly.chat.stopSharingToPhone';

/** The longest Remote Control session name Klawly sends; the Claude app shows it in its session list. */
export const CLAUDE_REMOTE_CONTROL_NAME_LIMIT = 80;

/** Remote Control on one session, as Claude Code reported it. */
export interface ClaudeRemoteControlState {
	readonly enabled: boolean;
	/** The name the Claude app and claude.ai/code list the session under. */
	readonly name?: string;
	/** This session on claude.ai/code, only when it is an https claude.ai address. */
	readonly sessionUrl?: string;
	/** claude.ai/code for this computer's Remote Control sessions, only when it is an https claude.ai address. */
	readonly connectUrl?: string;
}

/** A chat title as a Remote Control session name: one line, capped. Empty is undefined, so Claude Code picks one. */
export function claudeRemoteControlName(title: unknown): string | undefined {
	if (typeof title !== 'string') {
		return undefined;
	}
	const name = title.replace(/\s+/g, ' ').trim();
	return name ? name.slice(0, CLAUDE_REMOTE_CONTROL_NAME_LIMIT) : undefined;
}

/** A link Klawly may open or copy for a session: https on claude.ai only. */
function readClaudeAiUrl(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && url.hostname === 'claude.ai' ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Claude Code's answer to the `remote_control` control request:
 * `{session_url, connect_url, environment_id, bridge_epoch, bridge_session_id}`
 * when it turned on, and nothing that matters when it turned off.
 */
export function readClaudeRemoteControlResponse(response: unknown, enabled: boolean, name?: string): ClaudeRemoteControlState {
	if (!enabled) {
		return { enabled: false };
	}
	const record = response && typeof response === 'object' ? response as Record<string, unknown> : {};
	return {
		enabled: true,
		name,
		sessionUrl: readClaudeAiUrl(record.session_url),
		connectUrl: readClaudeAiUrl(record.connect_url),
	};
}
