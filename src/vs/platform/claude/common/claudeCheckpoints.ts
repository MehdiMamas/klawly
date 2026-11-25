/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, join } from '../../../base/common/path.js';
import { URI } from '../../../base/common/uri.js';

/** How long checkpoint objects stay after the session that wrote them. Default when the setting is missing. */
export const DEFAULT_CHECKPOINT_RETENTION_DAYS = 30;

export const CHECKPOINT_SCHEMA_VERSION = 1;

/** Files at least this big are copied into the object store without holding the bytes. */
export const CHECKPOINT_LARGE_FILE_BYTES = 1024 * 1024;

/** Temp object-store files older than this are leftover from a crash and can be removed. */
export const CHECKPOINT_TMP_STALE_MS = 60 * 60 * 1000;

export interface CheckpointFileStat {
	readonly mtime: number;
	readonly size: number;
}

/**
 * One file at a checkpoint boundary. `hash` is the original bytes in the object
 * store. `afterHash` is what the file became after an approved write: a string
 * hash, `null` when the file was gone, or absent until that write settled.
 */
export interface CheckpointFileRecord {
	readonly uri: string;
	readonly existed: boolean;
	readonly hash?: string;
	readonly stat?: CheckpointFileStat;
	afterHash?: string | null;
	/** `buffer` is an unsaved editor captured at turn start. `write` is the disk file before an approved write. */
	readonly capturedAs?: 'buffer' | 'write';
	/**
	 * Hash of the file on disk when a dirty buffer was captured. Restoring that
	 * buffer does not count as overwriting a later user edit when disk is unchanged.
	 */
	readonly diskHash?: string;
	/**
	 * Staged blob id when this snapshot was taken. Null means the path was not
	 * in the index. Absent means the index was not read. Restore never writes
	 * the index; a changed id is a staged user edit.
	 */
	indexBlob?: string | null;
}

export interface TurnCheckpoint {
	readonly schemaVersion: number;
	readonly id: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly createdAt: number;
	files: CheckpointFileRecord[];
	readonly gitHead?: string;
	readonly gitBranch?: string;
}

export interface RestoreConflict {
	readonly uri: string;
	readonly label: string;
}

export interface CheckpointDirtyBuffer {
	readonly path: string;
	readonly text: string;
}

/** A missing or unusable value keeps the default. Zero means expire on the next collection. */
export function readCheckpointRetentionDays(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		return DEFAULT_CHECKPOINT_RETENTION_DAYS;
	}
	return Math.floor(value);
}

/** Only an explicit false turns snapshots off. A missing value stays on. */
export function readCheckpointsEnabled(value: unknown): boolean {
	return value !== false;
}

export function checkpointObjectsRoot(userDataPath: string): string {
	return join(userDataPath, 'checkpoint-objects');
}

export function checkpointBlobPath(userDataPath: string, hash: string): string {
	assertSha256(hash);
	return join(checkpointObjectsRoot(userDataPath), hash.slice(0, 2), hash.slice(2));
}

export function checkpointFilePath(userDataPath: string, sessionId: string, checkpointId: string): string {
	assertSafeId(sessionId);
	assertSafeId(checkpointId);
	return join(userDataPath, 'agent-sessions', sessionId, 'checkpoints', `${checkpointId}.json`);
}

export function fileUriFromPath(fsPath: string): string {
	return URI.file(fsPath).toString();
}

export function fsPathFromCheckpointUri(uri: string): string {
	return URI.parse(uri).fsPath;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const copy = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
		? bytes
		: bytes.slice();
	const digest = await crypto.subtle.digest('SHA-256', copy);
	const view = new Uint8Array(digest);
	let hex = '';
	for (const byte of view) {
		hex += byte.toString(16).padStart(2, '0');
	}
	return hex;
}

/**
 * A user edit made after the checkpoint is content that is neither the original
 * snapshot nor the bytes observed after the approved write. An in-flight write
 * (no `afterHash` yet) is not listed. An unsaved buffer that moved is.
 */
export function postCheckpointUserEdits(checkpoint: TurnCheckpoint, currentHashByUri: ReadonlyMap<string, string | null>): RestoreConflict[] {
	const conflicts: RestoreConflict[] = [];
	for (const file of checkpoint.files) {
		const current = currentHashByUri.has(file.uri) ? currentHashByUri.get(file.uri) ?? null : null;
		const original = file.hash ?? null;
		if (current === original) {
			continue;
		}
		if (file.afterHash !== undefined && current === file.afterHash) {
			continue;
		}
		if (file.afterHash === undefined && file.capturedAs !== 'buffer') {
			continue;
		}
		if (file.capturedAs === 'buffer' && file.afterHash === undefined && file.diskHash !== undefined && current === file.diskHash) {
			continue;
		}
		conflicts.push({ uri: file.uri, label: basename(fsPathFromCheckpointUri(file.uri)) });
	}
	return conflicts;
}

/**
 * One checkpoint for a run of turns, oldest first (issue 702). It holds only the
 * files an agent wrote in those turns, not editors captured only because they
 * were unsaved. Each file keeps its earliest snapshot, the state before the first
 * of those turns touched it, and its latest settled write. Restoring it undoes
 * every one of those turns. Undefined when no turn wrote a file.
 */
export function mergeTurnCheckpoints(checkpoints: readonly TurnCheckpoint[]): TurnCheckpoint | undefined {
	const files = new Map<string, CheckpointFileRecord>();
	const written = new Set<string>();
	for (const checkpoint of checkpoints) {
		for (const file of checkpoint.files) {
			if (file.capturedAs === 'write' || file.afterHash !== undefined) {
				written.add(file.uri);
			}
			const known = files.get(file.uri);
			if (!known) {
				files.set(file.uri, { ...file });
			} else if (file.afterHash !== undefined) {
				known.afterHash = file.afterHash;
			}
		}
	}
	const first = checkpoints[0];
	if (!first || written.size === 0) {
		return undefined;
	}
	return { ...first, files: [...files.values()].filter(file => written.has(file.uri)) };
}

export function assertSafeId(id: string): void {
	if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) {
		throw new Error('Checkpoint id is not safe to store.');
	}
}

export function assertSha256(hash: string): void {
	if (!/^[0-9a-f]{64}$/.test(hash)) {
		throw new Error('Checkpoint blob hash is not a SHA-256 digest.');
	}
}
