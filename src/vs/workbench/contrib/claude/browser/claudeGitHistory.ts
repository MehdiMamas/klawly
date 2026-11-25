/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { ISCMHistoryItem, ISCMHistoryItemChange, ISCMHistoryItemRef, ISCMHistoryProvider } from '../../scm/common/history.js';
import { ISCMService } from '../../scm/common/scm.js';

/** The branch the agent works on and the base it left from, for the `@` menu's branch diff. */
export interface ClaudeBranchBase {
	readonly provider: ISCMHistoryProvider;
	readonly head: ISCMHistoryItemRef;
	readonly base: ISCMHistoryItemRef;
}

export interface ClaudeCommit {
	readonly provider: ISCMHistoryProvider;
	readonly item: ISCMHistoryItem;
}

/** Committed changes of one range, with the work-tree URI of each changed file. */
export interface ClaudeHistoryRange {
	readonly header: string;
	readonly changes: readonly { readonly uri: URI; readonly change: ISCMHistoryItemChange }[];
}

function providers(scm: ISCMService): ISCMHistoryProvider[] {
	const result: ISCMHistoryProvider[] = [];
	for (const repository of scm.repositories) {
		const provider = repository.provider.historyProvider.get();
		if (provider) {
			result.push(provider);
		}
	}
	return result;
}

/** The first repository whose branch has a base other than itself. */
export function claudeBranchBase(scm: ISCMService): ClaudeBranchBase | undefined {
	for (const provider of providers(scm)) {
		const head = provider.historyItemRef.get();
		const base = provider.historyItemBaseRef.get();
		if (head && base && head.id !== base.id) {
			return { provider, head, base };
		}
	}
	return undefined;
}

/** The newest commits on the current branch of the first repository that has history. */
export async function claudeRecentCommits(scm: ISCMService, limit: number, token: CancellationToken): Promise<ClaudeCommit[]> {
	for (const provider of providers(scm)) {
		const head = provider.historyItemRef.get();
		if (!head) {
			continue;
		}
		const items = await provider.provideHistoryItems({ historyItemRefs: [head.id], limit }, token) ?? [];
		return items.slice(0, limit).map(item => ({ provider, item }));
	}
	return [];
}

/** The current branch's name and its newest commit's subject, the ticket id sources besides the diff (issue 1378). Empty when no repository has history. */
export async function claudeBranchContext(scm: ISCMService, token: CancellationToken): Promise<{ readonly branch?: string; readonly subject?: string }> {
	const [commit] = await claudeRecentCommits(scm, 1, token);
	const head = (commit?.provider ?? providers(scm)[0])?.historyItemRef.get();
	return { branch: head?.name, subject: commit?.item.subject };
}

/** A change URI carries the commit in its query; the work-tree file is the same path without it. */
function workTreeUri(change: ISCMHistoryItemChange): URI {
	return change.uri.with({ query: '' });
}

/**
 * The branch's commits since it left `baseRef` (else its own base), or one commit.
 * Undefined when no repository knows the range.
 */
export async function claudeHistoryRange(scm: ISCMService, scope: 'branch' | 'commit', ref: string | undefined, token: CancellationToken): Promise<ClaudeHistoryRange | undefined> {
	if (scope === 'branch') {
		const branch = claudeBranchBase(scm);
		const provider = branch?.provider ?? providers(scm)[0];
		const head = provider?.historyItemRef.get();
		const baseId = ref ?? branch?.base.id;
		if (!provider || !head || !baseId) {
			return undefined;
		}
		const mergeBase = await provider.resolveHistoryItemRefsCommonAncestor([head.id, baseId], token);
		if (!mergeBase) {
			return undefined;
		}
		const changes = await provider.provideHistoryItemChanges(head.revision ?? head.id, mergeBase, token) ?? [];
		const baseName = branch && branch.base.id === baseId ? branch.base.name : baseId;
		return {
			header: `branch ${head.name} vs ${baseName} @ ${mergeBase.slice(0, 12)}`,
			changes: changes.map(change => ({ uri: workTreeUri(change), change })),
		};
	}
	if (!ref) {
		return undefined;
	}
	for (const provider of providers(scm)) {
		const item = await provider.resolveHistoryItem(ref, token);
		if (!item) {
			continue;
		}
		const changes = await provider.provideHistoryItemChanges(item.id, item.parentIds[0], token) ?? [];
		return {
			header: `commit ${(item.displayId ?? item.id).slice(0, 12)} ${item.subject}`,
			changes: changes.map(change => ({ uri: workTreeUri(change), change })),
		};
	}
	return undefined;
}
