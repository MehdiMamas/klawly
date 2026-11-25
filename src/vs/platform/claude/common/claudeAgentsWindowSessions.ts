/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';

/**
 * One session in both windows (issue 618). The Agent pane and the Agents window share Claude
 * Code's own session id and its one transcript: the Agent Host names a Claude session
 * `claude:/<id>` and the Agents window shows it as `agent-host-claude:/<id>`, where `<id>` is
 * the id the Agent pane keeps as `claudeSessionId`. Nothing is copied into a second store.
 */
const AGENTS_WINDOW_CLAUDE_SCHEME = 'agent-host-claude';
const AGENT_HOST_CLAUDE_SCHEME = 'claude';
const CLAUDE_CODE_SESSION_ID = /^[\w-]{1,128}$/;

/** The Agents window's resource for a Claude Code session started in this machine's Agent Host. */
export function agentsWindowSessionResource(claudeSessionId: string): URI {
	return URI.from({ scheme: AGENTS_WINDOW_CLAUDE_SCHEME, path: `/${claudeSessionId}` });
}

/**
 * The Claude Code session id behind an Agents window or Agent Host resource. Undefined for any
 * other provider, a remote host's session (its transcript is on that host), an untitled draft,
 * or an id Claude Code would not have made.
 */
export function claudeSessionIdFromAgentsWindow(resource: URI): string | undefined {
	if (resource.scheme !== AGENTS_WINDOW_CLAUDE_SCHEME && resource.scheme !== AGENT_HOST_CLAUDE_SCHEME) {
		return undefined;
	}
	const id = resource.path.substring(1);
	return CLAUDE_CODE_SESSION_ID.test(id) && !id.startsWith('untitled-') ? id : undefined;
}
