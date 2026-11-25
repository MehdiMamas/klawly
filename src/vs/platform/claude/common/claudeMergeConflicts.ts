/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_ATTACHMENT_CHAR_LIMIT } from './claudePrompt.js';

/** Most conflicted files one Resolve with Claude turn carries. */
export const MERGE_CONFLICT_FILE_LIMIT = 20;

/** Recent commit subjects listed per side. */
export const MERGE_CONFLICT_COMMIT_LIMIT = 5;

/** The refs git leaves while a merge, rebase, cherry-pick or revert stops on a conflict, in the order they are tried. */
export const MERGE_INCOMING_REFS: readonly string[] = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];

/** One side of a merge: the ref it is read from, its branch when known, and its latest commits. */
export interface MergeConflictSide {
	readonly ref: string;
	readonly branch?: string;
	readonly commits: readonly { readonly id: string; readonly subject: string }[];
}

/**
 * One conflicted file. `base`, `ours` and `theirs` are the index stages 1, 2
 * and 3 (undefined when the side deleted the file); `working` is the file on
 * disk with its conflict markers.
 */
export interface MergeConflictFile {
	readonly path: string;
	readonly working?: string;
	readonly base?: string;
	readonly ours?: string;
	readonly theirs?: string;
}

export interface MergeConflictContext {
	readonly ours: MergeConflictSide;
	readonly theirs: MergeConflictSide;
	readonly files: readonly MergeConflictFile[];
}

/** One pasted-text attachment: an id that stays the same for the same file, and its text. */
export interface MergeConflictChunk {
	readonly id: string;
	readonly text: string;
}

/** Number of `<<<<<<<` conflict markers in a file. */
export function countConflictMarkers(text: string | undefined): number {
	return text ? (text.match(/^<{7}(?: |$)/gm) ?? []).length : 0;
}

/**
 * Whether a conflicted file may be staged after Keep (issue 877): the setting is
 * on, the file is still in the Merge Changes group, every change in it is kept,
 * it has no unsaved edits, and it was read with no conflict marker left.
 * Unreadable text never stages.
 */
export function shouldStageResolvedFile(file: { readonly enabled: boolean; readonly inMergeGroup: boolean; readonly allKept: boolean; readonly dirty: boolean; readonly text: string | undefined }): boolean {
	return file.enabled && file.inMergeGroup && file.allKept && !file.dirty && file.text !== undefined && countConflictMarkers(file.text) === 0;
}

/**
 * Turns the merge state into pasted-text attachments: a summary of both sides
 * and their recent commits, then one attachment per file with its merge base
 * and both sides. Each attachment fits the attachment limit; a clipped side
 * names the read-only git command that shows all of it.
 */
export function mergeConflictChunks(context: MergeConflictContext): MergeConflictChunk[] {
	const files = context.files.slice(0, MERGE_CONFLICT_FILE_LIMIT);
	const summary = [
		'Merge conflicts',
		'',
		describeSide('Ours (stage 2)', context.ours),
		describeSide('Theirs (stage 3)', context.theirs),
		'',
		'Conflicted files:',
		...files.map(file => `- ${file.path} (${conflictLabel(countConflictMarkers(file.working))})`),
		...(context.files.length > files.length ? [`- … and ${context.files.length - files.length} more`] : []),
	];
	const chunks: MergeConflictChunk[] = [{ id: 'merge-conflicts', text: summary.join('\n') }];
	for (const file of files) {
		chunks.push({ id: `merge-conflict:${file.path}`, text: fileChunk(file) });
	}
	return chunks;
}

function describeSide(label: string, side: MergeConflictSide): string {
	const lines = [`${label}: ${side.branch ? `${side.branch} (${side.ref})` : side.ref}`];
	for (const commit of side.commits.slice(0, MERGE_CONFLICT_COMMIT_LIMIT)) {
		lines.push(`  ${commit.id.slice(0, 8)} ${commit.subject}`);
	}
	if (side.commits.length === 0) {
		lines.push('  (no commits found)');
	}
	return lines.join('\n');
}

function conflictLabel(count: number): string {
	return count === 1 ? '1 conflict' : count === 0 ? 'no conflict markers' : `${count} conflicts`;
}

function fileChunk(file: MergeConflictFile): string {
	const header = `File: ${file.path} (${conflictLabel(countConflictMarkers(file.working))})`;
	const sides: [string, string, string | undefined][] = [
		['Merge base', '1', file.base],
		['Ours', '2', file.ours],
		['Theirs', '3', file.theirs],
	];
	// Leave room for the header and the three section titles.
	const budget = Math.floor((CLAUDE_ATTACHMENT_CHAR_LIMIT - 600) / sides.length);
	const parts = [header];
	for (const [title, stage, text] of sides) {
		const command = `git show :${stage}:${file.path}`;
		if (text === undefined) {
			parts.push('', `--- ${title} (stage ${stage}): the file does not exist on this side`);
			continue;
		}
		if (text.length > budget) {
			parts.push('', `--- ${title} (stage ${stage}), first ${budget} of ${text.length} characters; run \`${command}\` for all of it`, text.slice(0, budget));
		} else {
			parts.push('', `--- ${title} (stage ${stage})`, text);
		}
	}
	return parts.join('\n');
}
