/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentMode } from './claudeContext.js';
import { ToolCategory } from './claudeProtocol.js';

/**
 * What a mode is allowed to do. The permission bridge applies these limits
 * through `evaluateModePolicy` (`claudeModePolicy.ts`) and the host policy
 * (`evaluateToolPolicy` in `claudeToolPolicy.ts`).
 */
export interface SessionPolicy {
	allowReads: boolean;
	/**
	 * `prompt-or-auto`: writes follow the host policy (Agent). `plan-files`: only
	 * plan files may be written (Plan). `false`: no file write at all (Ask).
	 */
	allowWorkspaceWrites: false | 'plan-files' | 'prompt-or-auto';
	/** `read-only-commands` is kept for older callers. Every mode now uses `prompt`. */
	allowShell: false | 'prompt' | 'read-only-commands';
	/** `allow`: web tools run without a card unless a setting denies the network. */
	allowNetwork: false | 'prompt' | 'allow';
	captureFileSnapshots: boolean;
}

/** Agent: reads and workspace writes run, commands, web and MCP ask (Phase 27). */
export const AGENT_POLICY: Readonly<SessionPolicy> = Object.freeze({
	allowReads: true,
	allowWorkspaceWrites: 'prompt-or-auto',
	allowShell: 'prompt',
	allowNetwork: 'prompt',
	captureFileSnapshots: true,
});

/** Ask: everything Plan may do, but no file write at all, plan files included. */
export const ASK_POLICY: Readonly<SessionPolicy> = Object.freeze({
	allowReads: true,
	allowWorkspaceWrites: false,
	allowShell: 'prompt',
	allowNetwork: 'allow',
	captureFileSnapshots: false,
});

/**
 * Plan reads, searches, fetches and runs commands (commands ask as in Agent),
 * and writes only plan files until the user presses Build, which starts an
 * Agent turn.
 */
export const PLAN_POLICY: Readonly<SessionPolicy> = Object.freeze({
	allowReads: true,
	allowWorkspaceWrites: 'plan-files',
	allowShell: 'prompt',
	allowNetwork: 'allow',
	captureFileSnapshots: true,
});

/** Why the IDE refused a request. Machine-readable; `message` is for the model. */
export interface PermissionDenial {
	code: 'mode-read-only' | 'policy' | 'user-denied' | 'session-stopped';
	mode: AgentMode;
	tool: string;
	category: ToolCategory;
}

export interface PermissionDecision {
	behavior: 'allow' | 'deny';
	denial?: PermissionDenial;
	updatedInput?: unknown;
	message?: string;
	scope?: 'once' | 'session' | 'workspace';
}

export interface PermissionPolicy {
	/** `ask` makes reads inside the workspace ask too (`claude.agent.autoApproveWorkspaceReads` false). */
	readWorkspace: 'allow' | 'ask';
	writeWorkspace: 'ask' | 'allow';
	writeOutsideWorkspace: 'deny' | 'ask';
	shellSafe: 'allow' | 'ask';
	shellDestructive: 'ask' | 'deny';
	network: 'ask' | 'allow' | 'deny';
}

/**
 * Defaults for the host policy: what Agent mode does when no setting says
 * otherwise. Reads inside the workspace are allowed. Writes ask, because the
 * `prompt` preset is the default. Everything else asks too.
 */
export const DEFAULT_PERMISSION_POLICY: Readonly<PermissionPolicy> = Object.freeze({
	readWorkspace: 'allow',
	writeWorkspace: 'ask',
	writeOutsideWorkspace: 'ask',
	shellSafe: 'allow',
	shellDestructive: 'ask',
	network: 'ask',
});
