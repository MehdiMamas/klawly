/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KlawlySyncSnapshot } from './klawlySyncMerge.js';

/**
 * The resource kinds Klawly Sync keeps, one folder each in the sync repo. Settings → Sync can
 * pause or exclude each one. `~/.claude` is never one of them.
 */
export const KLAWLY_SYNC_RESOURCES = ['rules', 'settings', 'mcp', 'skills', 'agents', 'commands', 'outputStyles', 'app', 'memory', 'history'] as const;

export type KlawlySyncResource = typeof KLAWLY_SYNC_RESOURCES[number];

/** What the store holds for a resource: its files (tombstones included) at one version. */
export interface KlawlySyncRemote {
	readonly version: string;
	readonly files: KlawlySyncSnapshot;
}

export type KlawlySyncPushResult =
	| { readonly kind: 'ok'; readonly version: string }
	/** Someone pushed after `baseVersion`. `current` is what the store holds now. */
	| { readonly kind: 'conflict'; readonly current: KlawlySyncRemote | undefined };

/**
 * Where synced files live. A push names the version it was based on and the store accepts it
 * only if that is still the latest (a compare-and-swap), so a machine never overwrites a change
 * it has not seen. The GitHub store does it with a ref update that is not forced.
 */
export interface IKlawlySyncStore {
	/** The latest content of a resource, or `undefined` when nothing was pushed yet. */
	read(resource: KlawlySyncResource): Promise<KlawlySyncRemote | undefined>;
	/** `baseVersion` is the version of the last read, or `undefined` when the resource was empty. */
	push(resource: KlawlySyncResource, baseVersion: string | undefined, files: KlawlySyncSnapshot, machine: string): Promise<KlawlySyncPushResult>;
	/**
	 * Removes every file of a resource from the store, tombstones included, so the data is gone from the
	 * latest version. Used by "Delete Synced History". Resolves when the resource is already empty.
	 */
	deleteResource(resource: KlawlySyncResource, machine: string): Promise<void>;
}
