/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { CLAUDE_MERGE_STAGE_AFTER_KEEP_SETTING } from '../../../../platform/claude/common/claudeConfiguration.js';
import { shouldStageResolvedFile } from '../../../../platform/claude/common/claudeMergeConflicts.js';
import { IClaudeReviewService } from '../../../services/claude/common/claudeReview.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { ISCMService } from '../../scm/common/scm.js';

/** The git extension's group for conflicted files (`Merge Changes`). */
const GIT_MERGE_GROUP_ID = 'merge';

/**
 * The optional stage step after Keep (issue 877). When `claude.mergeConflicts.stageAfterKeep`
 * is on and every change in a file is kept or undone (at least one kept) that is still in Merge Changes, the
 * file is staged, but only after it is read from disk with no conflict marker left and
 * with no unsaved edits. Off by default; with it off nothing here reads or stages anything.
 */
export class ClaudeMergeStageContribution extends Disposable {
	static readonly ID = 'claude.mergeStage';

	/** Files already staged by this step, so one Keep stages a file once. */
	private readonly _staged = new Set<string>();
	private _running = false;
	private _again = false;

	constructor(
		@IClaudeReviewService private readonly _review: IClaudeReviewService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@ISCMService private readonly _scm: ISCMService,
		@IFileService private readonly _files: IFileService,
		@ITextFileService private readonly _textFiles: ITextFileService,
		@ICommandService private readonly _commands: ICommandService,
	) {
		super();
		this._register(this._review.onDidChangeReview(event => void this.run(event.sessionId)));
	}

	/** Stages each kept conflicted file of the session that is clean now. Calls that overlap run once more after the first. */
	async run(sessionId: string): Promise<void> {
		if (this._configuration.getValue<boolean>(CLAUDE_MERGE_STAGE_AFTER_KEEP_SETTING) !== true) {
			return;
		}
		if (this._running) {
			this._again = true;
			return;
		}
		this._running = true;
		try {
			do {
				this._again = false;
				await this.stageClean(sessionId);
			} while (this._again);
		} finally {
			this._running = false;
		}
	}

	private async stageClean(sessionId: string): Promise<void> {
		const merging = this.mergeGroupUris();
		for (const key of [...this._staged]) {
			if (!merging.some(uri => uri.toString() === key)) {
				this._staged.delete(key);
			}
		}
		for (const review of this._review.reviewsFor(sessionId)) {
			for (const file of review.files) {
				const conflicted = merging.find(uri => extUriBiasedIgnorePathCase.isEqual(uri, file.uri));
				if (!conflicted || this._staged.has(conflicted.toString())) {
					continue;
				}
				const text = await this.read(file.uri);
				const ok = shouldStageResolvedFile({
					enabled: true,
					inMergeGroup: true,
					allKept: file.hunks.some(hunk => hunk.state === 'accepted') && file.hunks.every(hunk => hunk.state === 'accepted' || hunk.state === 'rejected'),
					dirty: this._textFiles.isDirty(file.uri),
					text,
				});
				if (ok) {
					this._staged.add(conflicted.toString());
					try {
						await this._commands.executeCommand('git.stageFile', conflicted);
					} catch {
						this._staged.delete(conflicted.toString());
					}
				}
			}
		}
	}

	private mergeGroupUris(): URI[] {
		const uris: URI[] = [];
		for (const repository of this._scm.repositories) {
			const merge = repository.provider.groups.find(group => group.id === GIT_MERGE_GROUP_ID);
			if (merge && repository.provider.providerId === 'git') {
				uris.push(...merge.resources.map(resource => resource.sourceUri));
			}
		}
		return uris;
	}

	private async read(uri: URI): Promise<string | undefined> {
		try {
			return (await this._files.readFile(uri)).value.toString();
		} catch {
			return undefined;
		}
	}
}
