/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, dirname, isAbsolute, join, normalize, relative } from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { fsPathFromCheckpointUri, type RestoreConflict } from './claudeCheckpoints.js';
import { CLAUDE_ATTACHMENT_CHAR_LIMIT } from './claudePrompt.js';

/** Git facts attached as `@Git Changes`. Giant patches are truncated. */
export interface GitContext {
	branch?: string;
	head?: string;
	stagedPatch?: string;
	workingPatch?: string;
	/** Work-tree paths from the index resource list. The stat uses these, not the patch. */
	stagedPaths?: readonly string[];
	/** Work-tree paths from the working-tree resource list. */
	workingPaths?: readonly string[];
	untrackedPaths: string[];
}

export interface GitAttachmentBody {
	readonly stat: string;
	readonly patch: string;
	readonly truncated: boolean;
}

/**
 * Stat summary plus a truncated patch. Untracked paths stay in the stat so a
 * huge new file is not inlined.
 */
const GIT_STAT_NAME_LIMIT = 40;

export function summarizeGitContext(context: GitContext, limit = CLAUDE_ATTACHMENT_CHAR_LIMIT): GitAttachmentBody {
	const staged = context.stagedPaths ?? [];
	const working = context.workingPaths ?? [];
	const untracked = context.untrackedPaths;
	const where = context.branch || context.head
		? `branch ${context.branch ?? 'detached'}${context.head ? ` @ ${context.head.slice(0, 12)}` : ''}`
		: '';
	const stat = [
		where,
		namedGitStat('staged', staged),
		namedGitStat('working', working),
		namedGitStat('untracked', untracked),
	].filter(line => line.length > 0).join('\n');
	const patch = [
		context.stagedPatch ? `--- staged\n${context.stagedPatch}` : '',
		context.workingPatch ? `--- working tree\n${context.workingPatch}` : '',
	].filter(part => part.length > 0).join('\n');
	const namesTruncated = staged.length > GIT_STAT_NAME_LIMIT || working.length > GIT_STAT_NAME_LIMIT || untracked.length > GIT_STAT_NAME_LIMIT;
	const truncated = patch.length > limit || namesTruncated;
	const body = patch.length > limit ? `${patch.slice(0, limit)}\n…` : patch;
	return { stat, patch: body, truncated };
}

/** Committed changes attached as a branch diff or one commit (Phase 34). */
export interface GitHistoryContext {
	/** `branch feature vs origin/main @ <merge base>` or `commit <id> <subject>`. */
	readonly header: string;
	/** Work-tree paths the range changes. */
	readonly paths: readonly string[];
	readonly patch: string;
}

export function summarizeGitHistory(context: GitHistoryContext, limit = CLAUDE_ATTACHMENT_CHAR_LIMIT): GitAttachmentBody {
	const stat = [context.header, namedGitStat('changed', context.paths)].join('\n');
	const truncated = context.patch.length > limit || context.paths.length > GIT_STAT_NAME_LIMIT;
	const patch = context.patch.length > limit ? `${context.patch.slice(0, limit)}\n…` : context.patch;
	return { stat, patch, truncated };
}

/** A resolved git-diff attachment still has something to review or explain. */
export function gitAttachmentHasChanges(stat: string, patch: string): boolean {
	if (patch.trim().length > 0) {
		return true;
	}
	for (const line of stat.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('branch ') || trimmed.startsWith('commit ') || /^(staged|working|untracked|changed): \d+$/.test(trimmed)) {
			continue;
		}
		return true;
	}
	return false;
}

function namedGitStat(label: string, paths: readonly string[]): string {
	const shown = paths.slice(0, GIT_STAT_NAME_LIMIT);
	return [`${label}: ${paths.length}`, ...shown].join('\n');
}

/** Paths in the index are relative to the work tree and use `/`. */
export function relativeGitPath(workTree: string, fsPath: string): string | undefined {
	const rel = relative(workTree, fsPath);
	if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
		return undefined;
	}
	return rel.replace(/\\/g, '/');
}

export function gitPathKey(path: string): string {
	const slash = path.replace(/\\/g, '/');
	return isWindows ? slash.toLowerCase() : slash;
}

/**
 * A staged blob id recorded on the checkpoint no longer matches the index.
 * Restoring the working tree must not rewrite the index.
 */
export function stagedIndexConflicts(
	files: readonly { uri: string; indexBlob?: string | null }[],
	current: ReadonlyMap<string, string | null>,
): RestoreConflict[] {
	const conflicts: RestoreConflict[] = [];
	for (const file of files) {
		if (file.indexBlob === undefined || !current.has(file.uri)) {
			continue;
		}
		const now = current.get(file.uri) ?? null;
		if (now !== file.indexBlob) {
			conflicts.push({ uri: file.uri, label: `${basename(fsPathFromCheckpointUri(file.uri))} (staged)` });
		}
	}
	return conflicts;
}

export interface AcceptedCommitFile {
	readonly path: string;
	readonly accepted: boolean;
}

export interface CommitAcceptedPlan {
	readonly paths: readonly string[];
	/** Staged paths that are not part of the accepted set. A commit must leave them alone. */
	readonly leaveStaged: readonly string[];
	readonly commit: boolean;
	readonly reason?: 'not-requested' | 'nothing-accepted' | 'staged-user-changes';
}

/**
 * Commits only when the user asked, and only the accepted paths. Other staged
 * paths block the commit. Nothing here runs `git commit` by itself.
 */
export function planCommitAccepted(input: {
	readonly files: readonly AcceptedCommitFile[];
	readonly stagedPaths: readonly string[];
	readonly userInitiated: boolean;
}): CommitAcceptedPlan {
	const paths = input.files.filter(file => file.accepted).map(file => file.path);
	const accepted = new Set(paths.map(gitPathKey));
	const leaveStaged = input.stagedPaths.filter(path => !accepted.has(gitPathKey(path)));
	if (!input.userInitiated) {
		return { paths, leaveStaged, commit: false, reason: 'not-requested' };
	}
	if (paths.length === 0) {
		return { paths, leaveStaged, commit: false, reason: 'nothing-accepted' };
	}
	if (leaveStaged.length > 0) {
		return { paths, leaveStaged, commit: false, reason: 'staged-user-changes' };
	}
	return { paths, leaveStaged, commit: true };
}

/** The first fenced block anywhere in the reply is the message. The commit box is left alone when this is empty. */
export function commitMessageFromAssistant(text: string): string {
	const fenced = /```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```/.exec(text);
	return (fenced ? fenced[1] : text).trim();
}

/**
 * A non-empty commit box is replaced only after `confirm` accepts.
 * Returns the text to write, or undefined when the box stays as it is.
 */
export async function replaceCommitMessage(current: string, next: string, confirm: () => Promise<boolean>): Promise<string | undefined> {
	const message = next.trim();
	if (!message) {
		return undefined;
	}
	if (current.trim().length > 0) {
		if (!await confirm()) {
			return undefined;
		}
	}
	return message;
}

export interface AcceptedHunkText {
	readonly state: string;
	readonly originalStart: number;
	readonly originalText: string;
	readonly modifiedText: string;
}

/**
 * Working tree after accepted hunks, using the pre-turn text as the base.
 * An empty base has no lines, so a new file does not gain a phantom trailing
 * line. A trailing newline on a hunk is the line separator, not an extra line.
 * CRLF and LF describe the same lines.
 */
export function textAfterAcceptedHunks(original: string, hunks: readonly AcceptedHunkText[]): string {
	const doc = gitDocument(original);
	const lines = doc.lines.slice();
	const accepted = hunks.filter(hunk => hunk.state === 'accepted').sort((left, right) => right.originalStart - left.originalStart);
	for (const hunk of accepted) {
		const start = Math.max(0, hunk.originalStart - 1);
		const removed = gitDocument(hunk.originalText).lines.length;
		const inserted = gitDocument(hunk.modifiedText).lines;
		lines.splice(start, removed, ...inserted);
	}
	return joinGitDocument({ lines, trailingNewline: lines.length === 0 ? false : doc.trailingNewline });
}

/**
 * Refuses a commit when an accepted file is in both the index and the working
 * tree, or the working tree is not the accepted text. A deletion is accepted
 * only when the working file is already gone.
 */
export function acceptedChangeConflict(file: {
	readonly inIndex: boolean;
	readonly inWorking: boolean;
	readonly originalText: string;
	readonly hunks: readonly AcceptedHunkText[];
	readonly workingText: string | undefined;
}): 'partly-staged' | 'beyond-accepted' | 'unreadable' | undefined {
	if (file.inIndex && file.inWorking) {
		return 'partly-staged';
	}
	const accepted = textAfterAcceptedHunks(file.originalText, file.hunks);
	const deleted = accepted.length === 0 && normalizeGitText(file.originalText).length > 0;
	if (file.workingText === undefined) {
		return deleted ? undefined : 'unreadable';
	}
	if (deleted || normalizeGitText(file.workingText) !== normalizeGitText(accepted)) {
		return 'beyond-accepted';
	}
	return undefined;
}

interface GitDocument {
	readonly lines: string[];
	readonly trailingNewline: boolean;
}

/** Lines of a git text. A trailing newline is a terminator, not a blank line. An empty string has no lines. */
function gitDocument(text: string): GitDocument {
	const normalized = text.replace(/\r\n/g, '\n');
	if (normalized.length === 0) {
		return { lines: [], trailingNewline: false };
	}
	const trailingNewline = normalized.endsWith('\n');
	const body = trailingNewline ? normalized.slice(0, -1) : normalized;
	return { lines: body.split('\n'), trailingNewline };
}

function joinGitDocument(doc: GitDocument): string {
	if (doc.lines.length === 0) {
		return '';
	}
	const body = doc.lines.join('\n');
	return doc.trailingNewline ? `${body}\n` : body;
}

function normalizeGitText(text: string): string {
	return text.replace(/\r\n/g, '\n');
}

/**
 * Walks from `start` to the repository root. A `.git` file may point at a
 * worktree git dir, including a relative path that contains `..`.
 */
export async function locateGitRepository(start: string, read: (path: string) => Promise<string | undefined>): Promise<{ workTree: string; gitDir: string; headText: string } | undefined> {
	if (!isAbsolute(start)) {
		return undefined;
	}
	let dir = start;
	for (let hop = 0; hop < 32; hop++) {
		const dotGit = join(dir, '.git');
		const head = await read(join(dotGit, 'HEAD'));
		if (head !== undefined) {
			return { workTree: dir, gitDir: dotGit, headText: head };
		}
		const pointer = await read(dotGit);
		if (pointer !== undefined) {
			let gitDir = resolveGitDirPointer(dir, pointer);
			if (!gitDir) {
				const candidate = gitDirCandidate(dir, pointer);
				if (candidate && candidate.replace(/\\/g, '/').includes('/.git/')) {
					const common = await read(join(candidate, 'commondir'));
					if (common !== undefined) {
						gitDir = resolveGitDirPointer(dir, pointer, common);
					}
				}
			}
			if (!gitDir) {
				return undefined;
			}
			const headText = await read(join(gitDir, 'HEAD'));
			return headText === undefined ? undefined : { workTree: dir, gitDir, headText };
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
	return undefined;
}

/**
 * Resolves a `gitdir:` pointer. Relative paths are from the work tree.
 * A `.git` file may point at a worktree or submodule git dir, or at a directory
 * under the common git dir named by a relative `commondir`. Other absolute
 * paths and `..` targets are rejected.
 */
export function resolveGitDirPointer(workTree: string, pointer: string, commondir?: string): string | undefined {
	const resolved = gitDirCandidate(workTree, pointer);
	if (!resolved) {
		return undefined;
	}
	if (linkedGitDir(resolved)) {
		return resolved;
	}
	if (commondir !== undefined && commondirAllows(resolved, commondir)) {
		return resolved;
	}
	return undefined;
}

function gitDirCandidate(workTree: string, pointer: string): string | undefined {
	const match = /^gitdir:\s*(.+)$/m.exec(pointer.trim());
	const raw = match?.[1].trim();
	if (!raw || raw.includes('\0')) {
		return undefined;
	}
	const resolved = normalize(isAbsolute(raw) ? raw : join(workTree, raw));
	return isAbsolute(resolved) ? resolved : undefined;
}

function linkedGitDir(resolved: string): boolean {
	const slash = resolved.replace(/\\/g, '/');
	return slash.includes('/.git/worktrees/') || slash.includes('/.git/modules/');
}

/** `commondir` is the relative file git writes inside a linked git dir. It must land on a `.git` directory that contains this git dir. */
function commondirAllows(gitDir: string, commondir: string): boolean {
	const raw = commondir.replace(/^\uFEFF/, '').trim();
	if (!raw || raw.includes('\0') || raw.includes('\n') || raw.includes('\r') || isAbsolute(raw)) {
		return false;
	}
	if (!gitDir.replace(/\\/g, '/').includes('/.git/')) {
		return false;
	}
	const common = normalize(join(gitDir, raw)).replace(/\\/g, '/').replace(/\/+$/, '');
	if (!/(^|\/)\.git$/.test(common)) {
		return false;
	}
	const dir = normalize(gitDir).replace(/\\/g, '/').replace(/\/+$/, '');
	return dir.startsWith(`${common}/`);
}

/** `ref: refs/heads/main` → `main`. A detached HEAD has no branch name. */
export function branchFromHead(head: string): string | undefined {
	const match = /^ref:\s*refs\/heads\/(\S+)\s*$/m.exec(head.trim());
	const name = match?.[1];
	if (!name || name.includes('..')) {
		return undefined;
	}
	return name;
}

/**
 * Reads version 2 and 3 of the Git index. Stage-0 entries map a work-tree
 * path to the staged blob id. A corrupt index returns undefined.
 */
export function parseGitIndex(bytes: Uint8Array): Map<string, string> | undefined {
	if (bytes.byteLength < 12) {
		return undefined;
	}
	if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'DIRC') {
		return undefined;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = view.getUint32(4);
	if (version !== 2 && version !== 3) {
		return undefined;
	}
	const count = view.getUint32(8);
	const map = new Map<string, string>();
	let offset = 12;
	for (let index = 0; index < count; index++) {
		if (offset + 62 > bytes.byteLength) {
			return undefined;
		}
		const flags = view.getUint16(offset + 60);
		const extended = (flags & 0x4000) !== 0;
		const stage = (flags >>> 12) & 0x3;
		let nameLength = flags & 0x0fff;
		let nameAt = offset + 62;
		if (extended) {
			if (version < 3 || nameAt + 2 > bytes.byteLength) {
				return undefined;
			}
			nameAt += 2;
		}
		if (nameLength === 0x0fff) {
			let end = nameAt;
			while (end < bytes.byteLength && bytes[end] !== 0) {
				end++;
			}
			nameLength = end - nameAt;
		}
		if (nameAt + nameLength > bytes.byteLength) {
			return undefined;
		}
		const path = new TextDecoder().decode(bytes.subarray(nameAt, nameAt + nameLength));
		if (stage === 0 && path.length > 0) {
			map.set(path, bytesToHex(bytes.subarray(offset + 40, offset + 60)));
		}
		const entryLength = (nameAt + nameLength + 1) - offset;
		offset += Math.ceil(entryLength / 8) * 8;
	}
	return map;
}

/** A version-2 index, enough for tests and for a round-trip through `parseGitIndex`. */
export function encodeGitIndex(entries: readonly { path: string; blob: string }[]): Uint8Array {
	const parts: Uint8Array[] = [];
	for (const entry of entries) {
		const pathBytes = new TextEncoder().encode(entry.path);
		const raw = 62 + pathBytes.byteLength + 1;
		const size = Math.ceil(raw / 8) * 8;
		const buf = new Uint8Array(size);
		const view = new DataView(buf.buffer);
		view.setUint32(24, 0o100644);
		buf.set(hexToBytes(entry.blob), 40);
		view.setUint16(60, Math.min(pathBytes.byteLength, 0x0fff));
		buf.set(pathBytes, 62);
		parts.push(buf);
	}
	const header = new Uint8Array(12);
	header.set(new TextEncoder().encode('DIRC'), 0);
	const head = new DataView(header.buffer);
	head.setUint32(4, 2);
	head.setUint32(8, entries.length);
	const total = parts.reduce((sum, part) => sum + part.byteLength, header.byteLength);
	const out = new Uint8Array(total);
	out.set(header, 0);
	let cursor = header.byteLength;
	for (const part of parts) {
		out.set(part, cursor);
		cursor += part.byteLength;
	}
	return out;
}

function bytesToHex(bytes: Uint8Array): string {
	let hex = '';
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, '0');
	}
	return hex;
}

function hexToBytes(hex: string): Uint8Array {
	if (!/^[0-9a-f]{40}$/i.test(hex)) {
		throw new Error('Git blob id must be 40 hex characters.');
	}
	const bytes = new Uint8Array(20);
	for (let index = 0; index < 20; index++) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}
