/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IClaudeCheckpointService } from '../../../../services/claude/common/claudeCheckpointService.js';
import { claudeRewindFiles } from '../../../../services/claude/common/claudeRewind.js';

/** The remembered answer to the Stop question (issue 1178): 'keep' or 'undo'. */
export const CLAUDE_STOPPED_CHANGES_KEY = 'klawly.claude.stoppedChanges';

/**
 * Asks once whether to keep or undo what a stopped turn changed (issue 1178), unless the user
 * ticked "Remember my choice" before. Resolves to the paths left as they are, empty when the
 * changes were undone, undefined on Cancel (the turn then stays stopped, as it was).
 */
export async function askClaudeStoppedChanges(
	sessionId: string,
	turnId: string,
	checkpoints: IClaudeCheckpointService,
	dialogs: IDialogService,
	storage: IStorageService,
): Promise<readonly string[] | undefined> {
	const files = claudeRewindFiles(sessionId, turnId, await checkpoints.readTurnsChanges(sessionId, [turnId]));
	if (files.length === 0) {
		return [];
	}
	let choice = storage.get(CLAUDE_STOPPED_CHANGES_KEY, StorageScope.APPLICATION);
	if (choice !== 'keep' && choice !== 'undo') {
		const listed = files.map(file => localize('claudeStoppedFileLine', "{0}  {1}  +{2} -{3}", file.name, file.directory, file.added, file.removed)).join('\n');
		const { result, checkboxChecked } = await dialogs.prompt<'undo' | 'keep'>({
			type: 'question',
			message: localize('claudeStoppedQuestion', "Keep the changes this turn made?"),
			detail: localize('claudeStoppedDetail', "{0}\n\nKeep Changes leaves the files as they are, and Claude is told they changed.", listed),
			buttons: [
				{ label: localize({ key: 'claudeStoppedKeep', comment: ['&& denotes a mnemonic'] }, "&&Keep Changes"), run: () => 'keep' },
				{ label: localize({ key: 'claudeStoppedUndo', comment: ['&& denotes a mnemonic'] }, "&&Undo Changes"), run: () => 'undo' },
			],
			cancelButton: true,
			checkbox: { label: localize('claudeStoppedRemember', "Remember my choice"), checked: false },
		});
		if (!result) {
			return undefined;
		}
		choice = result;
		if (checkboxChecked) {
			storage.store(CLAUDE_STOPPED_CHANGES_KEY, choice, StorageScope.APPLICATION, StorageTarget.USER);
		}
	}
	if (choice === 'keep') {
		return files.map(file => file.uri.fsPath);
	}
	return await checkpoints.restoreTurns(sessionId, [turnId]) ? [] : undefined;
}
