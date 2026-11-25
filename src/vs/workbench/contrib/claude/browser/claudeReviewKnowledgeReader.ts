/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IClaudeWorktreeService } from '../../../../platform/claude/common/claudeBackground.js';
import { CLAUDE_REVIEW_KNOWLEDGE_FILE, claudeReviewKnowledgeText, isClaudeReviewKnowledgeStale } from '../../../../platform/claude/common/claudeReviewKnowledge.js';

/** The repo knowledge file the reviewer reads (issue 933), cut to its budget; undefined when there is none. */
export async function readClaudeReviewKnowledge(files: IFileService, root: URI): Promise<string | undefined> {
	try {
		return claudeReviewKnowledgeText((await files.readFile(joinPath(root, ...CLAUDE_REVIEW_KNOWLEDGE_FILE.split('/')))).value.toString());
	} catch {
		return undefined;
	}
}

/** True when the knowledge file exists and many files changed in the repo since it was written (issue 933). */
export async function isClaudeReviewKnowledgeFileStale(files: IFileService, git: IClaudeWorktreeService, root: URI): Promise<boolean> {
	try {
		const stat = await files.stat(joinPath(root, ...CLAUDE_REVIEW_KNOWLEDGE_FILE.split('/')));
		const count = await git.changedFileCountSince?.(root.fsPath, stat.mtime);
		return count !== undefined && isClaudeReviewKnowledgeStale(count);
	} catch {
		return false;
	}
}
