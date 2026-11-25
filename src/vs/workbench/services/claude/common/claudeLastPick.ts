/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/** A choice a new agent starts with when the matching `claude.models.*` setting is empty. */
export type ClaudeLastPick = 'model' | 'effort' | 'auto';

function storageKey(pick: ClaudeLastPick): string {
	return `claude.lastPick.${pick}`;
}

/** What the user last picked for `pick`, in any window. Undefined before the first pick. */
export function readClaudeLastPick(storage: IStorageService, pick: ClaudeLastPick): string | undefined {
	return storage.get(storageKey(pick), StorageScope.APPLICATION) || undefined;
}

/** Remembers `value` as the last pick, so the next new agent starts with it. */
export function storeClaudeLastPick(storage: IStorageService, pick: ClaudeLastPick, value: string): void {
	storage.store(storageKey(pick), value, StorageScope.APPLICATION, StorageTarget.USER);
}
