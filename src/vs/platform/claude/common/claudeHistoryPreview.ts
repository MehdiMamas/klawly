/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** What the sync would carry for one project. */
export interface ClaudeHistoryProjectPreview {
	readonly identity: string;
	readonly excluded: boolean;
	readonly sessions: number;
	readonly bytes: number;
	/** Sessions held back because they hold a secret. */
	readonly heldBack: number;
	readonly samples: readonly string[];
}

export interface ClaudeHistoryPreview {
	readonly projects: readonly ClaudeHistoryProjectPreview[];
	readonly totalBytes: number;
}
