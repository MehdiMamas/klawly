/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KlawlySyncConflict, KlawlySyncSnapshot, klawlyLiveFiles, mergeKlawlySnapshots, sameKlawlySnapshot, withKlawlyTombstones } from './klawlySyncMerge.js';
import { KlawlySyncSecretFinding, makeKlawlySnapshotPortable, restoreKlawlySnapshotSecrets } from './klawlySyncSecrets.js';
import { IKlawlySyncStore, KLAWLY_SYNC_RESOURCES, KlawlySyncResource } from './klawlySyncStore.js';

/** How many times a push is retried when another machine pushes first. */
export const KLAWLY_SYNC_MAX_RETRIES = 5;

/** The last state both this machine and the store agreed on, per resource. Lives in `.sync/base/`. */
export interface KlawlySyncBase {
	readonly version: string | undefined;
	readonly files: KlawlySyncSnapshot;
}

/** The machine side of a sync. The platform implements it with files, the tests with maps. */
export interface IKlawlySyncLocal {
	/** The live files of a resource (no tombstones), as the user has them now. */
	read(resource: KlawlySyncResource): Promise<Record<string, string>>;
	/**
	 * Replaces the resource's files with `next` only if they still equal `expected` (a local
	 * compare-and-swap, so an edit made during the sync is never overwritten). Returns false
	 * when the files changed meanwhile. Writes are atomic (tmp, fsync, rename).
	 */
	write(resource: KlawlySyncResource, expected: Record<string, string>, next: Record<string, string>): Promise<boolean>;
	readBase(resource: KlawlySyncResource): Promise<KlawlySyncBase>;
	writeBase(resource: KlawlySyncResource, base: KlawlySyncBase): Promise<void>;
	/** Keeps the remote text of a conflicting file next to the local one, for Resolve. */
	saveConflict(resource: KlawlySyncResource, conflict: KlawlySyncConflict): Promise<void>;
	/** The local secret store. */
	getSecret(name: string): string | undefined;
	setSecret(name: string, value: string): void;
}

export type KlawlySyncOutcome =
	| { readonly kind: 'synced'; readonly pulled: readonly string[]; readonly pushed: boolean; readonly missingSecrets: readonly string[] }
	| { readonly kind: 'unchanged' }
	/** Both machines changed the same place. Pushing this resource is paused until the user resolves. */
	| { readonly kind: 'conflict'; readonly conflicts: readonly KlawlySyncConflict[] }
	/** The scanner found a secret that could not become a placeholder. Nothing was pushed. */
	| { readonly kind: 'blocked'; readonly findings: readonly KlawlySyncSecretFinding[] }
	/** Another machine kept pushing. Shown as "Sync is waiting for another of your computers to finish". */
	| { readonly kind: 'waiting' };

export interface KlawlySyncOptions {
	/** Names this machine in commit messages and the status line. */
	readonly machine: string;
	readonly sleep: (ms: number) => Promise<void>;
	/** A number in [0, 1), for the retry jitter. */
	readonly random: () => number;
	readonly maxRetries?: number;
}

/** Exponential backoff with jitter: about 0.5 s, 1 s, 2 s, 4 s, 8 s, each stretched up to 2x. */
export function klawlySyncBackoff(attempt: number, random: () => number): number {
	return 500 * 2 ** attempt * (1 + random());
}

/**
 * Syncs one resource: read local, remote and base, merge three ways, apply the merge locally,
 * push, and keep the new base. Placeholders stand in for secrets in everything that leaves the
 * machine. Pull and push are both safe to repeat.
 */
export async function syncKlawlyResource(resource: KlawlySyncResource, local: IKlawlySyncLocal, store: IKlawlySyncStore, options: KlawlySyncOptions): Promise<KlawlySyncOutcome> {
	const maxRetries = options.maxRetries ?? KLAWLY_SYNC_MAX_RETRIES;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (attempt > 0) {
			await options.sleep(klawlySyncBackoff(attempt - 1, options.random));
		}
		const current = await local.read(resource);
		const base = await local.readBase(resource);
		const remote = await store.read(resource);

		const portable = makeKlawlySnapshotPortable(withKlawlyTombstones(current, base.files));
		if (portable.findings.length > 0) {
			return { kind: 'blocked', findings: portable.findings };
		}
		for (const [name, value] of Object.entries(portable.secrets)) {
			local.setSecret(name, value);
		}

		const remoteFiles = remote?.files ?? {};
		const merged = mergeKlawlySnapshots(base.files, portable.files, remoteFiles);
		const restored = restoreKlawlySnapshotSecrets(merged.files, name => local.getSecret(name));
		const next = klawlyLiveFiles(restored.files);

		if (!sameKlawlySnapshot(current, next)) {
			if (!await local.write(resource, current, next)) {
				continue; // edited while syncing: start over from what is there now
			}
		}
		const pulled = Object.keys(next).filter(path => current[path] !== next[path]).concat(Object.keys(current).filter(path => next[path] === undefined)).sort();

		if (merged.conflicts.length > 0) {
			for (const conflict of merged.conflicts) {
				await local.saveConflict(resource, conflict);
			}
			return { kind: 'conflict', conflicts: merged.conflicts };
		}

		if (sameKlawlySnapshot(merged.files, remoteFiles)) {
			if (remote) {
				await local.writeBase(resource, { version: remote.version, files: merged.files });
			}
			return pulled.length === 0 ? { kind: 'unchanged' } : { kind: 'synced', pulled, pushed: false, missingSecrets: restored.missing };
		}

		const result = await store.push(resource, remote?.version, merged.files, options.machine);
		if (result.kind === 'ok') {
			await local.writeBase(resource, { version: result.version, files: merged.files });
			return { kind: 'synced', pulled, pushed: true, missingSecrets: restored.missing };
		}
	}
	return { kind: 'waiting' };
}

export interface KlawlySyncRunOptions extends KlawlySyncOptions {
	/** Kinds the user turned off in Settings → Sync. */
	readonly excluded: ReadonlySet<KlawlySyncResource>;
	/** Kinds with an unresolved conflict. They still pull, but nothing is pushed. They are skipped here until resolved. */
	readonly paused: ReadonlySet<KlawlySyncResource>;
}

/** One pass over every resource kind that is neither excluded nor paused. One kind failing does not stop the rest. */
export async function syncKlawlyAll(local: IKlawlySyncLocal, store: IKlawlySyncStore, options: KlawlySyncRunOptions): Promise<ReadonlyMap<KlawlySyncResource, KlawlySyncOutcome | Error>> {
	const results = new Map<KlawlySyncResource, KlawlySyncOutcome | Error>();
	for (const resource of KLAWLY_SYNC_RESOURCES) {
		if (options.excluded.has(resource) || options.paused.has(resource)) {
			continue;
		}
		try {
			results.set(resource, await syncKlawlyResource(resource, local, store, options));
		} catch (error) {
			results.set(resource, error instanceof Error ? error : new Error(String(error)));
		}
	}
	return results;
}
