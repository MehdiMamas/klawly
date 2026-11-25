/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Follow agent edits (issue 1176), slice 1: the pure core. It turns the Pre/Post tool
 * events of Edit, Write, MultiEdit and NotebookEdit from every session Klawly knows into
 * a per-file picture: which agents are editing it right now (their pets), which agent
 * last changed it and has not been reviewed, and whether two agents collide on it.
 * Edits made inside `.worktrees/<name>` map back to the main file and are marked.
 * Explorer and tab decoration, Follow mode and the side view build on this.
 */

/** Tools whose calls edit a file. Same set as the read-only mode policy. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Number of pet colours; an agent keeps the same colour for its whole life. */
export const CLAUDE_AGENT_PET_COLOR_COUNT = 8;

/** One agent that can edit files: the main chat, a subagent, a delegate or a worker. */
export interface ClaudeAgentIdentity {
	readonly agentId: string;
	readonly name: string;
	readonly task?: string;
	readonly model?: string;
}

/** An edit in flight. */
export interface ClaudeFileTouch {
	readonly agent: ClaudeAgentIdentity;
	/** Colour slot 0..7 for the agent's pet. */
	readonly color: number;
	/** The tool that edits the file, for the hover's last action. */
	readonly tool: string;
	/** True when the edit happened in a worktree and was mapped to the main file. */
	readonly inWorktree: boolean;
	/** The worktree name when `inWorktree`. */
	readonly worktree?: string;
	readonly startedAt: number;
}

/** The pets shown on one file. */
export interface ClaudeFilePets {
	readonly path: string;
	/** Agents editing the file right now, oldest first. */
	readonly active: readonly ClaudeFileTouch[];
	/** Two or more different agents are editing the file at once. */
	readonly conflict: boolean;
	/** The last agent that changed the file and has not been reviewed, if any. */
	readonly changedBy: ClaudeAgentIdentity | undefined;
}

export interface ClaudeFileTouchState {
	/** Active touches by mapped path, then agent id. */
	readonly active: ReadonlyMap<string, ReadonlyMap<string, ClaudeFileTouch>>;
	/** Unreviewed changes by mapped path. */
	readonly changed: ReadonlyMap<string, ClaudeAgentIdentity>;
}

export const EMPTY_CLAUDE_FILE_TOUCH_STATE: ClaudeFileTouchState = { active: new Map(), changed: new Map() };

/** A stable colour slot for an agent, from its id. */
export function claudeAgentPetColor(agentId: string): number {
	let hash = 0;
	for (let index = 0; index < agentId.length; index++) {
		hash = (hash * 31 + agentId.charCodeAt(index)) >>> 0;
	}
	return hash % CLAUDE_AGENT_PET_COLOR_COUNT;
}

/** The file an edit tool call writes, or undefined when the call is not an edit. */
export function claudeEditedFileOf(toolName: string, input: unknown): string | undefined {
	if (!EDIT_TOOLS.has(toolName) || typeof input !== 'object' || input === null) {
		return undefined;
	}
	const record = input as { readonly file_path?: unknown; readonly notebook_path?: unknown };
	const value = toolName === 'NotebookEdit' ? record.notebook_path : record.file_path;
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Maps a path inside `<root>/.worktrees/<name>/...` back to `<root>/...`. Paths outside a
 * worktree come back unchanged (with forward slashes) and `worktree` unset.
 */
export function claudeMapWorktreePath(path: string): { readonly path: string; readonly worktree?: string } {
	const normalized = path.replace(/\\/g, '/');
	const match = /^(?<root>.*?)\/\.worktrees\/(?<name>[^/]+)(?<rest>\/.*)?$/.exec(normalized);
	if (!match?.groups) {
		return { path: normalized };
	}
	return { path: `${match.groups.root}${match.groups.rest ?? ''}`, worktree: match.groups.name };
}

function withActive(state: ClaudeFileTouchState, path: string, touches: ReadonlyMap<string, ClaudeFileTouch>): ClaudeFileTouchState['active'] {
	const next = new Map(state.active);
	if (touches.size > 0) {
		next.set(path, touches);
	} else {
		next.delete(path);
	}
	return next;
}

/** PreToolUse: the agent starts editing the file. Returns the state unchanged for a non-edit call. */
export function claudeFileTouchStart(state: ClaudeFileTouchState, agent: ClaudeAgentIdentity, toolName: string, input: unknown, now: number): ClaudeFileTouchState {
	const edited = claudeEditedFileOf(toolName, input);
	if (edited === undefined) {
		return state;
	}
	const mapped = claudeMapWorktreePath(edited);
	const touches = new Map(state.active.get(mapped.path));
	touches.set(agent.agentId, {
		agent,
		color: claudeAgentPetColor(agent.agentId),
		tool: toolName,
		inWorktree: mapped.worktree !== undefined,
		worktree: mapped.worktree,
		startedAt: now,
	});
	return { ...state, active: withActive(state, mapped.path, touches) };
}

/**
 * PostToolUse: the edit ended. The pet leaves; when the edit succeeded the file keeps a
 * "changed by" mark until it is reviewed.
 */
export function claudeFileTouchEnd(state: ClaudeFileTouchState, agent: ClaudeAgentIdentity, toolName: string, input: unknown, succeeded: boolean): ClaudeFileTouchState {
	const edited = claudeEditedFileOf(toolName, input);
	if (edited === undefined) {
		return state;
	}
	const path = claudeMapWorktreePath(edited).path;
	const touches = new Map(state.active.get(path));
	touches.delete(agent.agentId);
	const changed = new Map(state.changed);
	if (succeeded) {
		changed.set(path, agent);
	}
	return { active: withActive(state, path, touches), changed };
}

/** An agent finished or died: all its pets leave at once. Changed marks stay. */
export function claudeFileTouchAgentDone(state: ClaudeFileTouchState, agentId: string): ClaudeFileTouchState {
	const active = new Map<string, ReadonlyMap<string, ClaudeFileTouch>>();
	for (const [path, touches] of state.active) {
		const kept = new Map(touches);
		kept.delete(agentId);
		if (kept.size > 0) {
			active.set(path, kept);
		}
	}
	return { ...state, active };
}

/** The user reviewed the file: its "changed by" mark goes. */
export function claudeFileTouchReviewed(state: ClaudeFileTouchState, path: string): ClaudeFileTouchState {
	const key = claudeMapWorktreePath(path).path;
	if (!state.changed.has(key)) {
		return state;
	}
	const changed = new Map(state.changed);
	changed.delete(key);
	return { ...state, changed };
}

/** What the explorer row and the editor tab of `path` show. */
export function claudeFilePets(state: ClaudeFileTouchState, path: string): ClaudeFilePets {
	const key = claudeMapWorktreePath(path).path;
	const active = [...(state.active.get(key)?.values() ?? [])].sort((a, b) => a.startedAt - b.startedAt);
	return { path: key, active, conflict: active.length > 1, changedBy: state.changed.get(key) };
}
