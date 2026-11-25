/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The plugin name `.agents/skills` loads under (issue 499), so its skills are
 * `agents:<name>` in Claude Code and Customize can say where they come from.
 */
export const CLAUDE_AGENTS_SKILLS_PLUGIN = 'agents';

/** Which open agent files a session passes to Claude Code (issue 499). */
export interface ClaudeAgentsFilesSettings {
	/** Pass the workspace's `AGENTS.md` when no CLAUDE.md imports it. */
	readonly instructions: boolean;
	/** Load `.agents/skills` as Claude Code skills. */
	readonly skills: boolean;
}

/** An instruction source Klawly passed to Claude Code at session start, shown in the session inspector. */
export interface ClaudeInstructionSource {
	/**
	 * `agentsMd`: an `AGENTS.md` in the system prompt; a `nested` one is listed by
	 * path for Claude to read when it works in that folder. `agentsSkills`: the
	 * `.agents/skills` folder, loaded as a plugin.
	 */
	readonly kind: 'agentsMd' | 'agentsSkills';
	/** Workspace-relative path with forward slashes. */
	readonly path: string;
	readonly nested?: true;
}
