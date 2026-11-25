/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runs Claude in the Agent Host, the process behind the Agent Sessions window (decision record
 * `docs/decisions/0001-agent-host-harness.md`). Off by default; the Agent Host registers no Claude
 * provider, since Klawly ships no Anthropic package (issue 1654).
 */
export const CLAUDE_AGENTS_WINDOW_ENABLED_SETTING = 'claude.agentsWindow.enabled';

/** Names the Claude Code executable the Agent Host runs; when unset it is found the way Klawly's runtime finds it. */
export const KLAWLY_CLAUDE_EXECUTABLE_ENV = 'KLAWLY_CLAUDE_EXECUTABLE';

/**
 * The env the starters add for the Agent Host: Klawly's `claude.agent.runtimePath` setting as
 * {@link KLAWLY_CLAUDE_EXECUTABLE_ENV}, so the Agents window runs the same Claude Code as the Agent
 * pane. A value the parent process already sets wins.
 */
export function klawlyAgentHostEnv(runtimePath: string | undefined, inheritedEnv: Readonly<Record<string, string | undefined>>): Record<string, string> {
	if (!runtimePath || inheritedEnv[KLAWLY_CLAUDE_EXECUTABLE_ENV] !== undefined) {
		return {};
	}
	return { [KLAWLY_CLAUDE_EXECUTABLE_ENV]: runtimePath };
}
