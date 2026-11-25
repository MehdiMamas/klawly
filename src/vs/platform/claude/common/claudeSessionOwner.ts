/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A running Claude Code process, by the chat that started it. */
export interface ClaudeLiveSession {
	/** The id of the view that owns the process: the pane session, else the runtime session. */
	readonly owner: string;
	/** Claude Code's own session id, once known (what `--resume` takes). */
	readonly claudeSessionId: string | undefined;
}

/**
 * v5 N5: one Claude Code session id runs in at most one process. A second view
 * that resumes it must follow the first instead of spawning another, which
 * would write the same transcript twice. Returns the owner that blocks
 * `resumeSessionId` for `requester`, or undefined when it may start.
 * A fork (`--fork-session`, rewind) writes a new transcript, so callers skip this for it.
 */
export function claudeSessionBlockedBy(live: readonly ClaudeLiveSession[], resumeSessionId: string | undefined, requester: string): string | undefined {
	if (!resumeSessionId) {
		return undefined;
	}
	return live.find(session => session.claudeSessionId === resumeSessionId && session.owner !== requester)?.owner;
}
