/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/** The application-wide storage key every window reads, so a hand-off shows in the target project's window too (issue 1459). */
export const CLAUDE_DEPARTMENT_INBOX_KEY = 'claude.departmentInbox';

const MAX_RECORDS = 100;

/** One hand-off from a project's chat to another project (issue 1177). */
export interface ClaudeHandoffRecord {
	/** The chat the hand-off opened. */
	readonly chatId: string;
	/** The chat that handed the work over. */
	readonly from: string;
	/** The target project's folder path. */
	readonly folder: string;
	/** The target project's name. */
	readonly project: string;
	readonly at: number;
	/** True once the user opened the chat. */
	readonly read: boolean;
}

/** The records with a new hand-off added, newest kept, capped. */
export function addClaudeHandoff(records: readonly ClaudeHandoffRecord[], record: ClaudeHandoffRecord): ClaudeHandoffRecord[] {
	return [...records.filter(existing => existing.chatId !== record.chatId), record].sort((a, b) => a.at - b.at).slice(-MAX_RECORDS);
}

/** The records with the hand-off for a chat marked read; the same array when nothing changes. */
export function markClaudeHandoffRead(records: readonly ClaudeHandoffRecord[], chatId: string): readonly ClaudeHandoffRecord[] {
	return records.some(record => record.chatId === chatId && !record.read)
		? records.map(record => record.chatId === chatId ? { ...record, read: true } : record)
		: records;
}

/** The hand-offs in time order, newest first (the Departments timeline). */
export function claudeHandoffTimeline(records: readonly ClaudeHandoffRecord[]): ClaudeHandoffRecord[] {
	return [...records].sort((a, b) => b.at - a.at);
}

/** How many hand-offs to each project's folder the user has not opened yet. */
export function claudeUnreadByFolder(records: readonly ClaudeHandoffRecord[]): ReadonlyMap<string, number> {
	const counts = new Map<string, number>();
	for (const record of records) {
		if (!record.read) {
			counts.set(record.folder, (counts.get(record.folder) ?? 0) + 1);
		}
	}
	return counts;
}

/** The stored records; anything malformed is dropped. */
export function parseClaudeHandoffs(raw: string | undefined): ClaudeHandoffRecord[] {
	if (!raw) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.filter((item): item is ClaudeHandoffRecord =>
			!!item && typeof item.chatId === 'string' && typeof item.from === 'string' && typeof item.folder === 'string'
			&& typeof item.project === 'string' && typeof item.at === 'number' && typeof item.read === 'boolean');
	} catch {
		return [];
	}
}

export function readClaudeHandoffs(storage: IStorageService): ClaudeHandoffRecord[] {
	return parseClaudeHandoffs(storage.get(CLAUDE_DEPARTMENT_INBOX_KEY, StorageScope.APPLICATION));
}

function writeClaudeHandoffs(storage: IStorageService, records: readonly ClaudeHandoffRecord[]): void {
	storage.store(CLAUDE_DEPARTMENT_INBOX_KEY, JSON.stringify(records), StorageScope.APPLICATION, StorageTarget.MACHINE);
}

/** Records a delivered hand-off where every window can see it. */
export function recordClaudeHandoff(storage: IStorageService, record: ClaudeHandoffRecord): void {
	writeClaudeHandoffs(storage, addClaudeHandoff(readClaudeHandoffs(storage), record));
}

/** Marks a chat's hand-off read, if it has one. */
export function markClaudeHandoffOpened(storage: IStorageService, chatId: string): void {
	const records = readClaudeHandoffs(storage);
	const next = markClaudeHandoffRead(records, chatId);
	if (next !== records) {
		writeClaudeHandoffs(storage, next);
	}
}
