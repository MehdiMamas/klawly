/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';

/**
 * Claude Code's own cloud sessions (issue 516). Klawly runs no servers: a cloud
 * agent is a Claude Code cloud session on the user's Claude account, started
 * with `claude --cloud`, sent follow-ups with `claude -p --cloud <id>` and
 * brought back with `claude --teleport <id>`.
 */

/** Starts a cloud session from the workspace folder, in a terminal. */
export const CLAUDE_CLOUD_START_COMMAND_ID = 'klawly.cloud.start';
/** Pulls a cloud session and its branch into a new worktree, in a terminal. */
export const CLAUDE_CLOUD_BRING_BACK_COMMAND_ID = 'klawly.cloud.bringBack';
/** Queues one message into a running cloud session. */
export const CLAUDE_CLOUD_SEND_COMMAND_ID = 'klawly.cloud.send';

/** What the installed Claude Code offers for cloud sessions, read from `claude --help`. */
export interface ClaudeCloudCapability {
	/** `--cloud`: start a cloud session, or send one a message with `-p`. */
	readonly cloud: boolean;
	/** `--teleport`: pull a cloud session and its branch into a checkout. */
	readonly teleport: boolean;
	/** `--remote-control`: Remote Control, which Share to Phone starts on a running chat (issue 517). */
	readonly remoteControl?: boolean;
	readonly version?: string;
	/** The `claude` binary a terminal runs. Absent when Claude Code is not installed. */
	readonly binary?: string;
	/** Why the help could not be read, when it could not. */
	readonly error?: string;
}

/** One message for a running cloud session. */
export interface ClaudeCloudSendRequest {
	/** A session ID (`session_...`, `cse_...`) or its claude.ai/code URL. */
	readonly session: string;
	readonly message: string;
	/** The folder `claude` runs in. The send needs no checkout, so it may be absent. */
	readonly cwd?: string;
}

/** What `claude -p --cloud <id> --output-format json` printed. */
export interface ClaudeCloudSendResult {
	readonly ok: boolean;
	readonly sessionId?: string;
	/** The session on claude.ai, only when it is an https claude.ai address. */
	readonly url?: string;
	readonly error?: string;
}

/** The longest task or message Klawly passes to `claude`, well under the Windows command line limit. */
export const CLAUDE_CLOUD_TEXT_LIMIT = 8000;

const SESSION_ID = /^(?:session|cse)_[A-Za-z0-9_-]{1,200}$/;
const SESSION_URL = /^(?:https?:\/\/)?claude\.ai\/code\/(?<id>[^/?#\s]+)\/?(?:[?#]\S*)?$/;

/**
 * The bare session ID in a session ID or a claude.ai/code URL, as `claude`
 * accepts them. Anything else is undefined.
 */
export function readClaudeCloudSessionId(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	const id = SESSION_URL.exec(trimmed)?.groups?.id ?? trimmed;
	return SESSION_ID.test(id) ? id : undefined;
}

/** A cloud task on one line: Claude Code takes it as the session's description and first message. */
export function readClaudeCloudText(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const text = value.replace(/\s+/g, ' ').trim();
	return text && text.length <= CLAUDE_CLOUD_TEXT_LIMIT ? text : undefined;
}

/** Reads the options `claude --help` lists. Each option starts its own line. */
export function readClaudeCloudCapability(help: string, version?: string, binary?: string): ClaudeCloudCapability {
	return {
		cloud: /^\s*--cloud\b/m.test(help),
		teleport: /^\s*--teleport\b/m.test(help),
		remoteControl: /^\s*--remote-control\b/m.test(help),
		version,
		binary,
	};
}

/**
 * `claude --cloud=<task>`: creates a cloud session for the folder's GitHub
 * remote at its current branch. The `=` form keeps a task that starts with
 * `-` from reading as an option.
 */
export function claudeCloudStartArguments(task: string): string[] {
	return [`--cloud=${task}`];
}

/** `claude --teleport=<id>`, or `claude --teleport` for Claude Code's own session picker. */
export function claudeTeleportArguments(sessionId: string | undefined): string[] {
	return sessionId ? [`--teleport=${sessionId}`] : ['--teleport'];
}

/** `claude -p --cloud=<id> --output-format json`; the message goes on stdin. */
export function claudeCloudSendArguments(sessionId: string): string[] {
	return ['-p', `--cloud=${sessionId}`, '--output-format', 'json'];
}

/** A link Klawly may open for a session: https on claude.ai only. */
function readSessionUrl(value: unknown): string | undefined {
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
 * The send's JSON result: `{ok, session_id, url}` or `{ok: false, session_id,
 * error}`. Configuration errors print to stderr without JSON; then the last
 * line of stderr is the error.
 */
export function readClaudeCloudSendResult(stdout: string, stderr: string): ClaudeCloudSendResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch {
		parsed = undefined;
	}
	if (parsed && typeof parsed === 'object') {
		const record = parsed as Record<string, unknown>;
		const sessionId = readClaudeCloudSessionId(record.session_id);
		if (record.ok === true) {
			return { ok: true, sessionId, url: readSessionUrl(record.url) };
		}
		if (record.ok === false) {
			return { ok: false, sessionId, error: typeof record.error === 'string' && record.error.trim() ? record.error.trim() : lastLine(stderr) };
		}
	}
	return { ok: false, error: lastLine(stderr) || lastLine(stdout) || 'Claude Code did not say whether the message was sent.' };
}

function lastLine(text: string): string {
	return text.trim().split(/\r?\n/).at(-1)?.replace(/^Error:\s*/, '').trim() ?? '';
}

/**
 * Where an agent runs (issue 532). `local` covers every Klawly session, whose
 * Claude Code process Klawly drives from this machine (in the folder, a
 * worktree, a dev container or over SSH); `cloud` is a Claude Code cloud
 * session on the user's Claude account, which Klawly starts and messages
 * through the `claude` CLI but does not stream.
 */
export type ClaudeRunTarget = 'local' | 'cloud';

/** A cloud session started or messaged from Klawly, as the Agents column lists it (issue 532). */
export interface ClaudeCloudSessionRecord {
	/** The session ID when Klawly knows it, else a Klawly key (`start-...`). */
	readonly id: string;
	/** The session ID. A send reports it; a start in the terminal does not. */
	readonly sessionId?: string;
	/** The task the session started with, or the first message Klawly sent it. */
	readonly title: string;
	readonly startedAt: number;
	readonly updatedAt: number;
}

/** How many cloud sessions a workspace remembers, newest first. */
export const CLAUDE_CLOUD_SESSION_LIMIT = 20;

/** The cloud sessions stored for a workspace; anything malformed is dropped. */
export function readClaudeCloudSessionRecords(value: unknown): ClaudeCloudSessionRecord[] {
	const records: ClaudeCloudSessionRecord[] = [];
	for (const candidate of Array.isArray(value) ? value : []) {
		if (!candidate || typeof candidate !== 'object') {
			continue;
		}
		const record = candidate as Record<string, unknown>;
		const sessionId = readClaudeCloudSessionId(record.sessionId);
		const title = readClaudeCloudText(record.title);
		const id = sessionId ?? (typeof record.id === 'string' && /^start-[A-Za-z0-9-]{1,64}$/.test(record.id) ? record.id : undefined);
		if (!id || !title || typeof record.startedAt !== 'number' || typeof record.updatedAt !== 'number' || records.some(existing => existing.id === id)) {
			continue;
		}
		records.push({ id, sessionId, title, startedAt: record.startedAt, updatedAt: record.updatedAt });
	}
	return records.slice(0, CLAUDE_CLOUD_SESSION_LIMIT);
}

/**
 * Adds a start or a send to the records, newest first. A send to a session
 * Klawly already lists only moves it up; `startKey` names a terminal start,
 * whose session ID Klawly never sees.
 */
export function addClaudeCloudSessionRecord(records: readonly ClaudeCloudSessionRecord[], entry: { readonly sessionId?: string; readonly title: string }, now: number, startKey: string): ClaudeCloudSessionRecord[] {
	const sessionId = readClaudeCloudSessionId(entry.sessionId);
	const title = readClaudeCloudText(entry.title);
	if (!title) {
		return [...records];
	}
	const id = sessionId ?? `start-${startKey}`;
	const existing = records.find(record => record.id === id);
	const record: ClaudeCloudSessionRecord = existing ? { ...existing, updatedAt: now } : { id, sessionId, title, startedAt: now, updatedAt: now };
	return [record, ...records.filter(candidate => candidate.id !== id)].slice(0, CLAUDE_CLOUD_SESSION_LIMIT);
}

/** The session on claude.ai, or claude.ai's list of sessions when Klawly has no ID. */
export function claudeCloudSessionUrl(record: Pick<ClaudeCloudSessionRecord, 'sessionId'>): string {
	return record.sessionId ? `https://claude.ai/code/${record.sessionId}` : 'https://claude.ai/code';
}

/** The longest brought-back diff Review Diff opens; a longer one is cut with a note. */
export const CLAUDE_CLOUD_REVIEW_MAX_DIFF = 400_000;

/**
 * What Review Diff opens for a brought-back worktree (issue 864): a header
 * with the file and line counts, then the patch against the commit the
 * worktree started from. An empty patch (Claude Code has not fetched the
 * branch yet) yields `undefined`, so the caller says so instead of opening
 * an empty editor.
 */
export function claudeCloudReviewDocument(diff: string, summary: { readonly filesChanged: number; readonly added: number; readonly removed: number }): string | undefined {
	if (!diff.trim()) {
		return undefined;
	}
	const body = diff.length > CLAUDE_CLOUD_REVIEW_MAX_DIFF
		? `${diff.slice(0, CLAUDE_CLOUD_REVIEW_MAX_DIFF)}\n[The diff is cut here; open the worktree to read the rest.]\n`
		: diff;
	const header = summary.filesChanged === 1
		? localize('claudeCloudReviewHeaderOne', "1 file changed, +{0} -{1}", summary.added, summary.removed)
		: localize('claudeCloudReviewHeaderMany', "{0} files changed, +{1} -{2}", summary.filesChanged, summary.added, summary.removed);
	return `# ${header}\n${body}`;
}

/** The oldest Claude Code with `--cloud` and `--teleport`. */
export const CLAUDE_CLOUD_MINIMUM_VERSION = '2.1.296';

/**
 * Why Run in cannot start a cloud session, or undefined when it can. Cloud
 * sessions need Claude Code with `--cloud` and a Claude account sign-in: they
 * run on claude.ai, not through an API key, Bedrock or Vertex. `authMode` is
 * the runtime state's own value.
 */
export function claudeCloudUnavailableReason(capability: ClaudeCloudCapability | undefined, authMode?: string): string | undefined {
	if (!capability) {
		return localize('claudeCloudUnavailableRuntime', "this Claude runtime cannot reach cloud sessions");
	}
	if (!capability.binary) {
		return capability.error
			? localize('claudeCloudUnavailableUnread', "Klawly could not read what Claude Code supports: {0}", capability.error)
			: localize('claudeCloudUnavailableMissing', "Claude Code is not installed");
	}
	if (!capability.cloud) {
		return capability.error
			? localize('claudeCloudUnavailableUnread', "Klawly could not read what Claude Code supports: {0}", capability.error)
			: capability.version
				? localize('claudeCloudUnavailableVersion', "needs Claude Code {0} or later; this is {1}", CLAUDE_CLOUD_MINIMUM_VERSION, capability.version)
				: localize('claudeCloudUnavailableVersionUnknown', "needs Claude Code {0} or later", CLAUDE_CLOUD_MINIMUM_VERSION);
	}
	if (authMode === 'api-key' || authMode === 'bedrock' || authMode === 'vertex') {
		return localize('claudeCloudUnavailableAuth', "needs Claude Code signed in with a Claude account, not an API key, Bedrock or Vertex");
	}
	return undefined;
}
