/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ReviewPendingSummary } from '../../../services/claude/common/claudeReview.js';

/** The counts a scope label needs. */
export type ClaudeScopeCounts = Pick<ReviewPendingSummary, 'hunks' | 'files' | 'chats'>;

/**
 * What a Keep All or Undo All control says: the action and its scope, never a
 * bare "All" (DL-69). "Keep 14 Changes in 6 Files", and "... from 3 Chats" once
 * the scope spans more than one chat.
 */
export function claudeScopeActionLabel(action: 'keep' | 'undo', counts: ClaudeScopeCounts): string {
	const { hunks, files, chats } = counts;
	if (action === 'keep') {
		if (chats > 1) {
			return files === 1
				? localize('claudeKeepChangesInFileFromChats', "Keep {0} Changes in 1 File from {1} Chats", hunks, chats)
				: localize('claudeKeepChangesInFilesFromChats', "Keep {0} Changes in {1} Files from {2} Chats", hunks, files, chats);
		}
		if (hunks === 1) {
			return localize('claudeKeepChangeInFile', "Keep 1 Change in 1 File");
		}
		return files === 1
			? localize('claudeKeepChangesInFile', "Keep {0} Changes in 1 File", hunks)
			: localize('claudeKeepChangesInFiles', "Keep {0} Changes in {1} Files", hunks, files);
	}
	if (chats > 1) {
		return files === 1
			? localize('claudeUndoChangesInFileFromChats', "Undo {0} Changes in 1 File from {1} Chats", hunks, chats)
			: localize('claudeUndoChangesInFilesFromChats', "Undo {0} Changes in {1} Files from {2} Chats", hunks, files, chats);
	}
	if (hunks === 1) {
		return localize('claudeUndoChangeInFile', "Undo 1 Change in 1 File");
	}
	return files === 1
		? localize('claudeUndoChangesInFile', "Undo {0} Changes in 1 File", hunks)
		: localize('claudeUndoChangesInFiles', "Undo {0} Changes in {1} Files", hunks, files);
}

/** The short Keep All button of the changes bar: "Keep All (6 Files)". */
export function claudeKeepAllFilesLabel(files: number): string {
	return files === 1
		? localize('claudeKeepAllOneFile', "Keep All (1 File)")
		: localize('claudeKeepAllFiles', "Keep All ({0} Files)", files);
}

/** The status bar text: "14 changes to review". */
export function claudePendingStatusText(hunks: number): string {
	return hunks === 1
		? localize('claudePendingOneChange', "1 change to review")
		: localize('claudePendingChanges', "{0} changes to review", hunks);
}

/** How many file names the Undo All dialog lists before it says how many more. */
export const CLAUDE_UNDO_ALL_LISTED_FILES = 10;

/** The file list of the Undo All dialog: up to ten names, then "and N more". */
export function claudeUndoAllFileList(names: readonly string[]): string {
	const listed = names.slice(0, CLAUDE_UNDO_ALL_LISTED_FILES);
	const rest = names.length - listed.length;
	return rest > 0
		? [...listed, rest === 1 ? localize('claudeUndoAllOneMore', "and 1 more file") : localize('claudeUndoAllMore', "and {0} more files", rest)].join('\n')
		: listed.join('\n');
}

/** The one line that tells Auto-Keep from Auto-Accept, shown in the mode menu and in Settings. */
export function claudeAutoKeepExplanation(): string {
	return localize('claudeAutoKeepExplanation', "Auto-Accept means Claude edits without asking first; Auto-Keep means you don't review the edits afterwards.");
}

/** The hint under Auto-Accept. */
export function claudeAutoKeepHint(): string {
	return localize('claudeAutoKeepHint', "Want both? Turn on Auto-Keep.");
}
