/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentMode } from './claudeContext.js';
import { ClaudeExecutionTarget } from './claudeExecutionTarget.js';

/** Current index schema. Version 1 records migrate forward and are not dropped. */
export const AGENT_DATABASE_SCHEMA_VERSION = 2;

export interface AgentTurn {
	id: string;
	createdAt: number;
	userText?: string;
}

export interface WorktreeDescriptor {
	path: string;
	branch?: string;
}

export interface IdeAgentSession {
	/** Stable IDE id. Survives compaction and a new Claude resume id. */
	id: string;
	claudeSessionId?: string;
	workspaceId: string;
	title: string;
	mode: AgentMode;
	createdAt: number;
	updatedAt: number;
	status: 'idle' | 'running' | 'waiting-permission' | 'failed' | 'complete';
	turns: AgentTurn[];
	checkpointIds: string[];
	worktree?: WorktreeDescriptor;
	modelId?: string;
	/** A fork's summary, sent ahead of its first message. Cleared once Claude has a session. */
	forkContext?: string;
	/** A command or skill pinned to the chat (issue 488), without the slash. */
	pinnedCommand?: string;
	/** After a rewind (issue 702): the chain entry the next resume cuts the conversation after. Cleared once Claude starts. */
	resumeAt?: string;
	/** After a rewind that kept changed files: the note sent ahead of the next message. Cleared once Claude starts. */
	rewindNote?: string;
}

export interface SessionIndexRecord {
	id: string;
	workspaceId: string;
	title: string;
	updatedAt: number;
	mode: AgentMode;
	createdAt?: number;
	status?: IdeAgentSession['status'];
	claudeSessionId?: string;
	checkpointIds?: readonly string[];
	worktree?: WorktreeDescriptor;
	workspaceName?: string;
	/** The folder the session works in. Klawly Sync (issue 448) files its history under this project's identity. */
	projectFolder?: string;
	/** Set when a crash left a turn or tool unfinished. Resume does not rerun tools. */
	interrupted?: boolean;
	/** Set when Claude rejected `claudeSessionId`. The transcript stays. */
	resumeFailed?: boolean;
	firstUser?: string;
	changedFiles?: readonly string[];
	/** How many turns the session had when it was last saved. */
	turnCount?: number;
	/** The session was an open tab when it was last saved. Only open sessions come back as tabs. */
	open?: boolean;
	/** Listed first in history. */
	pinned?: boolean;
	/** Kept out of the history lists until it is unarchived or opened again. */
	archived?: boolean;
	/** Where Claude Code ran (issue 425), so a resumed session runs there again. Absent ran it on this machine. */
	executionTarget?: ClaudeExecutionTarget;
}

export interface AgentPreferences {
	defaultMode?: AgentMode;
}

export interface PersistedAgentDatabase {
	schemaVersion: number;
	sessions: SessionIndexRecord[];
	preferences: AgentPreferences;
	/** Unknown top-level fields from a newer schema. They round-trip. */
	[key: string]: unknown;
}
