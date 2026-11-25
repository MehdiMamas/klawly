/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hash } from '../../../../base/common/hash.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SerializedRange } from '../../../../platform/claude/common/claudeContext.js';

export const IClaudeCopyTracker = createDecorator<IClaudeCopyTracker>('claudeCopyTracker');

export interface ClaudeCopyRecord {
	readonly uri: string;
	readonly range: SerializedRange;
	readonly versionId: number;
	readonly textHash: number;
}

/** Remembers the latest editor copy so a composer paste can become a selection chip. */
export interface IClaudeCopyTracker {
	readonly _serviceBrand: undefined;
	record(record: ClaudeCopyRecord): void;
	/** The latest copy whose text hash matches, if any. */
	match(text: string): ClaudeCopyRecord | undefined;
}

export function hashCopiedText(text: string): number {
	return hash(text);
}

export class ClaudeCopyTracker implements IClaudeCopyTracker {
	declare readonly _serviceBrand: undefined;

	private _latest: ClaudeCopyRecord | undefined;

	record(record: ClaudeCopyRecord): void {
		this._latest = record;
	}

	match(text: string): ClaudeCopyRecord | undefined {
		if (!this._latest || this._latest.textHash !== hashCopiedText(text)) {
			return undefined;
		}
		return this._latest;
	}
}
