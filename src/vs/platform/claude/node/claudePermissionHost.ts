/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { lstat, readlink, realpath } from 'fs/promises';
import { dirname, resolve } from '../../../base/common/path.js';
import { AgentMode } from '../common/claudeContext.js';
import { PermissionDecision, PermissionPolicy, DEFAULT_PERMISSION_POLICY } from '../common/claudePermissions.js';
import { ClaudeReadRule } from '../common/claudeReadRules.js';
import { PermissionChoice, PermissionOutcome } from '../common/claudeProtocol.js';
import { ClaudeSessionPermissions, ClaudeSessionSwitch, NO_SESSION_PERMISSIONS, readClaudeSessionPermissions, sessionSwitchFor } from '../common/claudeSessionPermissions.js';
import { ClaudeReadRulesLoader } from './claudeReadRulesLoader.js';
import { canonicalizePath, evaluateToolPolicy, PathRealpath, ToolPolicyResult } from '../common/claudeToolPolicy.js';

/** The message a request gets when its session ends first. */
export const SESSION_STOPPED_MESSAGE = 'Session stopped.';

/** Where a request comes from. The runner fills this in, never the model. */
export interface PermissionScope {
	readonly sessionId: string;
	readonly cwd: string;
	readonly workspaceFolders: readonly string[];
	readonly additionalDirectories: readonly string[];
	readonly trusted: boolean;
	/** Mode of the turn. Unset behaves as Agent. */
	readonly mode?: AgentMode;
	/** Claude Code's plan folders, which Plan mode may write to. */
	readonly planDirectories?: readonly string[];
	/** Klawly's plan folder for this user. See `ToolPolicyContext.klawlyPlanDirectory`. */
	readonly klawlyPlanDirectory?: string;
}

export interface PermissionVerdict extends ToolPolicyResult {
	/** Set when an earlier user answer covers this request. */
	readonly grantedBy?: 'session' | 'workspace';
	/** Set when Allow All Commands or Allow Everything approved a request that would ask. */
	readonly switchedBy?: ClaudeSessionSwitch;
}

/**
 * Follows symlinks, including a link whose target does not exist yet. A plain
 * `realpath` reports such a link as missing, and a write through it would
 * create the target wherever the link points.
 */
export const nodeRealpath: PathRealpath = async path => {
	try {
		return await realpath(path);
	} catch {
		// Fall through: the path may be a dangling link.
	}
	try {
		if ((await lstat(path)).isSymbolicLink()) {
			return resolve(dirname(path), await readlink(path));
		}
	} catch {
		// Missing, or not readable: the caller walks up to the parent.
	}
	return undefined;
};

/**
 * The host side of the permission bridge: policy, grants, and history. It runs
 * in the process that owns the Claude query, so a request cannot reach a tool
 * without passing through `evaluate`.
 */
export class ClaudePermissionHost {
	private readonly _sessionGrants = new Map<string, Set<string>>();
	private readonly _workspaceGrants = new Map<string, Set<string>>();
	private readonly _history = new Map<string, PermissionOutcome[]>();
	private readonly _active = new Set<string>();
	/** Allow All Commands and Allow Everything, per session. Never persisted. */
	private readonly _switches = new Map<string, ClaudeSessionPermissions>();

	private readonly _readRules: ClaudeReadRulesLoader;

	constructor(private readonly _options: {
		getPolicy?(): PermissionPolicy;
		realpath?: PathRealpath;
		/** Files Claude cannot read (issue 458). Defaults to the user list and the project's settings. */
		getReadRules?(workspaceFolders: readonly string[]): Promise<readonly ClaudeReadRule[]>;
		homeDirectory?: string;
	} = {}) {
		this._readRules = new ClaudeReadRulesLoader({ homeDirectory: _options.homeDirectory });
	}

	/** The files Claude cannot read for these folders (issue 458). */
	readRulesFor(workspaceFolders: readonly string[]): Promise<readonly ClaudeReadRule[]> {
		return this._options.getReadRules?.(workspaceFolders) ?? this._readRules.load(workspaceFolders);
	}

	async evaluate(scope: PermissionScope, toolName: string, input: unknown): Promise<PermissionVerdict> {
		const readRules = await this.readRulesFor(scope.workspaceFolders);
		const verdict = await evaluateToolPolicy(toolName, input, {
			readRules,
			homeDirectory: this._readRules.homeDirectory,
			cwd: scope.cwd,
			workspaceFolders: scope.workspaceFolders,
			additionalDirectories: scope.additionalDirectories,
			trusted: scope.trusted,
			policy: this._options.getPolicy?.() ?? DEFAULT_PERMISSION_POLICY,
			realpath: this._options.realpath ?? nodeRealpath,
			mode: scope.mode,
			planDirectories: scope.planDirectories,
			klawlyPlanDirectory: scope.klawlyPlanDirectory,
		});
		if (verdict.behavior !== 'ask') {
			return verdict;
		}
		// The switches apply only to a request that would ask. A denial from a setting or a mode stays a denial.
		const switchedBy = sessionSwitchFor(verdict.details, this._switches.get(scope.sessionId), scope.trusted);
		if (switchedBy) {
			return { ...verdict, behavior: 'allow', switchedBy };
		}
		if (!verdict.canRemember) {
			return verdict;
		}
		if (this._sessionGrants.get(scope.sessionId)?.has(verdict.grantKey)) {
			return { ...verdict, behavior: 'allow', grantedBy: 'session' };
		}
		if (this._workspaceGrants.get(workspaceKey(scope))?.has(verdict.grantKey)) {
			return { ...verdict, behavior: 'allow', grantedBy: 'workspace' };
		}
		return verdict;
	}

	/**
	 * Stores the answer. A request the policy marked `canRemember: false`
	 * (credentials, destructive, outside the workspace, untrusted) is only ever
	 * approved once, whatever scope the caller asked for.
	 */
	remember(scope: PermissionScope, verdict: PermissionVerdict, decision: PermissionDecision): 'once' | 'session' | 'workspace' {
		if (decision.behavior !== 'allow' || !verdict.canRemember || decision.scope === undefined || decision.scope === 'once') {
			return 'once';
		}
		if (decision.scope === 'session' && !this._active.has(scope.sessionId)) {
			// The session ended: a grant for it would never be cleaned up.
			return 'once';
		}
		const grants = decision.scope === 'workspace' ? this._workspaceGrants : this._sessionGrants;
		const key = decision.scope === 'workspace' ? workspaceKey(scope) : scope.sessionId;
		let set = grants.get(key);
		if (!set) {
			set = new Set();
			grants.set(key, set);
		}
		set.add(verdict.grantKey);
		return decision.scope;
	}

	/**
	 * Sets Allow All Commands and Allow Everything for a session. A session that
	 * never began or has ended keeps no switch, so a late call cannot turn one on.
	 */
	setSessionPermissions(sessionId: string, permissions: ClaudeSessionPermissions): void {
		if (!this._active.has(sessionId)) {
			return;
		}
		if (permissions.allowAllCommands || permissions.allowEverything || permissions.autoReview) {
			this._switches.set(sessionId, readClaudeSessionPermissions(permissions));
		} else {
			this._switches.delete(sessionId);
		}
	}

	sessionPermissions(sessionId: string): ClaudeSessionPermissions {
		return this._switches.get(sessionId) ?? NO_SESSION_PERMISSIONS;
	}

	/** Starts history for a session. `record` and session grants ignore a session that never began or has ended. */
	beginSession(sessionId: string): void {
		this._active.add(sessionId);
		if (!this._history.has(sessionId)) {
			this._history.set(sessionId, []);
		}
	}

	record(sessionId: string, outcome: PermissionOutcome): void {
		this._history.get(sessionId)?.push(outcome);
	}

	/** The user-visible permission history for one session, oldest first. */
	history(sessionId: string): readonly PermissionOutcome[] {
		return [...(this._history.get(sessionId) ?? [])];
	}

	/** Session grants end with the session. Workspace grants stay until the process ends. */
	endSession(sessionId: string): void {
		this._active.delete(sessionId);
		this._sessionGrants.delete(sessionId);
		this._switches.delete(sessionId);
		this._history.delete(sessionId);
	}
}

function workspaceKey(scope: PermissionScope): string {
	return scope.workspaceFolders.map(folder => canonicalizePath(folder, scope.cwd)).sort().join('\n');
}

interface PendingRequest {
	readonly resolve: (decision: PermissionDecision) => void;
	readonly cleanup: () => void;
}

/**
 * Holds requests that need a person. `request` waits for `resolve`. A request
 * ends as a denial when the session stops, the query aborts, or the
 * bridge is disposed. Nothing here ever answers `allow` on its own.
 */
export class ClaudeUserPermissionBridge {
	private readonly _pending = new Map<string, PendingRequest>();

	request(request: { readonly sessionId: string; readonly requestId: string; readonly signal: AbortSignal }): Promise<PermissionDecision> {
		const key = pendingKey(request.sessionId, request.requestId);
		if (request.signal.aborted) {
			return Promise.resolve(stopped());
		}
		return new Promise<PermissionDecision>(resolvePromise => {
			const onAbort = () => this.settle(key, stopped());
			request.signal.addEventListener('abort', onAbort, { once: true });
			this._pending.get(key)?.resolve(stopped());
			this._pending.set(key, {
				resolve: resolvePromise,
				cleanup: () => request.signal.removeEventListener('abort', onAbort),
			});
		});
	}

	/** Answers one pending request. Returns false when nothing was waiting. */
	resolve(sessionId: string, requestId: string, choice: PermissionChoice): boolean {
		return this.settle(pendingKey(sessionId, requestId), decisionFor(choice));
	}

	/** Denies every request this session is waiting on. */
	cancelSession(sessionId: string): void {
		const prefix = `${sessionId}\n`;
		for (const key of [...this._pending.keys()]) {
			if (key.startsWith(prefix)) {
				this.settle(key, stopped());
			}
		}
	}

	hasPending(sessionId: string): boolean {
		const prefix = `${sessionId}\n`;
		return [...this._pending.keys()].some(key => key.startsWith(prefix));
	}

	dispose(): void {
		for (const key of [...this._pending.keys()]) {
			this.settle(key, stopped());
		}
	}

	private settle(key: string, decision: PermissionDecision): boolean {
		const pending = this._pending.get(key);
		if (!pending) {
			return false;
		}
		this._pending.delete(key);
		pending.cleanup();
		pending.resolve(decision);
		return true;
	}
}

function pendingKey(sessionId: string, requestId: string): string {
	return `${sessionId}\n${requestId}`;
}

function decisionFor(choice: PermissionChoice): PermissionDecision {
	switch (choice) {
		case 'allow-once': return { behavior: 'allow', scope: 'once' };
		case 'allow-session': return { behavior: 'allow', scope: 'session' };
		case 'allow-workspace': return { behavior: 'allow', scope: 'workspace' };
		default: return { behavior: 'deny', message: 'The user denied this action.' };
	}
}

function stopped(): PermissionDecision {
	return { behavior: 'deny', message: SESSION_STOPPED_MESSAGE };
}
