/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { claudeDebugMarkerLineCount, claudeRemoveDebugMarkerLines } from '../../../../platform/claude/common/claudeDebugMode.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';

/**
 * Debug mode asks Claude to remove the lines it marked `klawly-debug` when the
 * bug is fixed. When a Debug-mode turn ends with marked lines still in the files it
 * wrote, this offers Remove Instrumentation (issue 689).
 */
export class ClaudeDebugCleanupContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeDebugCleanup';

	/** The turn each session was last checked at, so one finished turn is offered once. */
	private readonly _checked = new Map<string, string>();

	constructor(
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IFileService private readonly _files: IFileService,
		@ITextFileService private readonly _textFiles: ITextFileService,
		@INotificationService private readonly _notifications: INotificationService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this._register(this._agent.onDidChangeViewState(({ sessionId }) => {
			this.check(sessionId).catch(error => this._log.warn('[claude] Could not look for leftover debug lines.', error));
		}));
	}

	private async check(sessionId: string): Promise<void> {
		const session = this._agent.getSessions().find(candidate => candidate.id === sessionId);
		const turn = this._agent.getViewState(sessionId).turns.at(-1);
		if (session?.mode !== 'debug' || !turn || turn.status !== 'complete' || turn.changedFiles.length === 0 || this._checked.get(sessionId) === turn.id) {
			return;
		}
		this._checked.set(sessionId, turn.id);
		const found = await findClaudeDebugLines(this._files, this._textFiles, turn.changedFiles);
		if (found.length === 0) {
			return;
		}
		const total = found.reduce((sum, file) => sum + file.lines, 0);
		this._notifications.prompt(
			Severity.Info,
			localize('claudeDebugLeftover', "Debug mode left {0} marked lines in {1} files.", total, found.length),
			[{
				label: localize('claudeDebugRemove', "Remove Instrumentation"),
				run: () => this.remove(found.map(file => file.uri)).catch(error => this._log.warn('[claude] Could not remove the debug lines.', error)),
			}],
			{ sticky: true },
		);
	}

	private async remove(uris: readonly URI[]): Promise<void> {
		await removeClaudeDebugLines(this._textFiles, uris);
	}
}

/** A file that still holds lines Debug mode marked `klawly-debug`, and how many. */
export interface IClaudeDebugLines {
	readonly uri: URI;
	readonly lines: number;
}

/** Looks through `changed` (file URIs as the agent reports them) for lines Debug mode marked. */
export async function findClaudeDebugLines(files: IFileService, textFiles: ITextFileService, changed: readonly string[]): Promise<IClaudeDebugLines[]> {
	const found: IClaudeDebugLines[] = [];
	for (const changedFile of changed) {
		const uri = URI.parse(changedFile);
		try {
			const lines = claudeDebugMarkerLineCount(textFiles.files.get(uri)?.textEditorModel?.getValue() ?? (await files.readFile(uri)).value.toString());
			if (lines > 0) {
				found.push({ uri, lines });
			}
		} catch {
			// Gone or unreadable: nothing to clean up there.
		}
	}
	return found;
}

/** Takes the marked lines out of `uris` and saves them. */
export async function removeClaudeDebugLines(textFiles: ITextFileService, uris: readonly URI[]): Promise<void> {
	for (const uri of uris) {
		const model = await textFiles.files.resolve(uri);
		const text = model.textEditorModel?.getValue();
		if (text === undefined) {
			continue;
		}
		model.textEditorModel?.setValue(claudeRemoveDebugMarkerLines(text));
		await model.save();
	}
}
