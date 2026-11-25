/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readClaudeCodeSessionId, readClaudeLinkFolder } from './claudeAgentLinks.js';

/**
 * One terminal Claude Code session from the session-manager registry (`~/.claude/session-manager/<id>/<id>.json`),
 * shown read-only in the `/klawly all` import list (issue 1186). Klawly only reads the registry, never writes it.
 */
export interface ClaudeRegistrySession {
	readonly sessionId: string;
	readonly name: string;
	readonly state: string;
	readonly task?: string;
	/** The manager's session id when this session is a worker it started. */
	readonly parent?: string;
	readonly folder: string;
	readonly updatedAt: number;
}

const MAX_REGISTRY_FILE = 64 * 1024;
const MAX_TASK_LENGTH = 200;

/** The session in one registry file's text; undefined when it is too big, not JSON, or has no usable id and folder. */
export function parseClaudeRegistrySession(raw: string): ClaudeRegistrySession | undefined {
	if (raw.length > MAX_REGISTRY_FILE) {
		return undefined;
	}
	let value: Record<string, unknown> | null;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const sessionId = readClaudeCodeSessionId(typeof value.sessionId === 'string' ? value.sessionId : undefined);
	const folder = readClaudeLinkFolder(typeof value.cwd === 'string' ? value.cwd : undefined);
	if (!sessionId || !folder) {
		return undefined;
	}
	const parent = readClaudeCodeSessionId(typeof value.parent === 'string' ? value.parent : undefined);
	const task = typeof value.task === 'string' && value.task.trim() ? value.task.trim().slice(0, MAX_TASK_LENGTH) : undefined;
	return {
		sessionId,
		name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 80) : sessionId.slice(0, 8),
		state: typeof value.state === 'string' ? value.state : 'unknown',
		task,
		...(parent ? { parent } : {}),
		folder,
		updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
	};
}

/** The import list: the newest sessions first, one row per session id, ended ones only when `includeEnded`. */
export function claudeRegistryImportList(sessions: readonly ClaudeRegistrySession[], includeEnded: boolean, limit = 30): readonly ClaudeRegistrySession[] {
	const newest = new Map<string, ClaudeRegistrySession>();
	for (const session of sessions) {
		const known = newest.get(session.sessionId);
		if (!known || session.updatedAt > known.updatedAt) {
			newest.set(session.sessionId, session);
		}
	}
	return [...newest.values()]
		.filter(session => includeEnded || session.state !== 'ended')
		.sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId))
		.slice(0, limit);
}

/** The `klawly://agent/import` link that opens this session in Klawly. The user is still asked before it opens. */
export function claudeRegistryImportLink(session: ClaudeRegistrySession): string {
	return `klawly://agent/import?session=${encodeURIComponent(session.sessionId)}&folder=${encodeURIComponent(session.folder)}`;
}

/** The workers a manager started, newest first. */
export function claudeRegistryWorkersOf(sessions: readonly ClaudeRegistrySession[], managerId: string): readonly ClaudeRegistrySession[] {
	return sessions.filter(session => session.parent === managerId).sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

/** The managers that have workers, each with how many, newest manager first. */
export function claudeRegistryManagers(sessions: readonly ClaudeRegistrySession[]): readonly { readonly manager: ClaudeRegistrySession; readonly workers: number }[] {
	const counts = new Map<string, number>();
	for (const session of sessions) {
		if (session.parent) {
			counts.set(session.parent, (counts.get(session.parent) ?? 0) + 1);
		}
	}
	return sessions
		.filter(session => counts.has(session.sessionId))
		.map(manager => ({ manager, workers: counts.get(manager.sessionId)! }))
		.sort((a, b) => b.manager.updatedAt - a.manager.updatedAt || a.manager.sessionId.localeCompare(b.manager.sessionId));
}

/** The file a worker's latest report is in, next to the registry entries of its manager: `<manager id>.<worker name>.report.md`. */
export function claudeRegistryReportFile(managerId: string, workerName: string): string {
	return `${managerId}.${workerName}.report.md`;
}
