/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { localize } from '../../../../nls.js';
import { ClaudeSaveBeforeCommandRequest, IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { SaveReason } from '../../../common/editor.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { IWorkingCopy, WorkingCopyCapabilities } from '../../../services/workingCopy/common/workingCopy.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { applyClaudeSaveBeforeCommand, ClaudeSaveBeforeCommandHost } from '../common/claudeSaveBeforeCommands.js';

const MAX_COMMAND_DETAIL = 300;

/**
 * Applies `claude.agent.saveBeforeCommands` in the window that owns the session.
 * The shared process holds the command until this window answers, so every
 * request this window owns is answered, whatever happens while saving.
 */
export class ClaudeSaveBeforeCommandsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeSaveBeforeCommands';

	constructor(
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IWorkingCopyService private readonly _workingCopies: IWorkingCopyService,
		@IDialogService private readonly _dialogs: IDialogService,
	) {
		super();
		const onRequest = this._runtime.onDidRequestSaveBeforeCommand;
		if (onRequest) {
			this._register(onRequest(request => void this.handle(request)));
		}
	}

	private async handle(request: ClaudeSaveBeforeCommandRequest): Promise<void> {
		// Every window hears the request. Only the window that started the session saves.
		if (!this._agent.getSessions().some(session => this._agent.getRuntimeSessionId(session.id) === request.sessionId)) {
			return;
		}
		try {
			await applyClaudeSaveBeforeCommand(request, this.host());
		} catch {
			// A failed save does not hold the command. It runs against the files on disk.
		} finally {
			await this._runtime.resolveSaveBeforeCommand?.(request.sessionId, request.requestId);
		}
	}

	private host(): ClaudeSaveBeforeCommandHost {
		const dirty = (): IWorkingCopy[] => this._workingCopies.dirtyWorkingCopies.filter(copy => !(copy.capabilities & WorkingCopyCapabilities.Untitled));
		return {
			dirtyCount: () => dirty().length,
			saveAll: async () => {
				await Promise.all(dirty().map(copy => copy.save({ reason: SaveReason.EXPLICIT })));
			},
			confirm: async (count, command) => {
				const { confirmed } = await this._dialogs.confirm({
					type: Severity.Info,
					message: count === 1
						? localize('claudeSaveBeforeCommandOne', "Save 1 unsaved file before Claude runs a command?")
						: localize('claudeSaveBeforeCommandMany', "Save {0} unsaved files before Claude runs a command?", count),
					detail: command.length > MAX_COMMAND_DETAIL ? `${command.slice(0, MAX_COMMAND_DETAIL)}…` : command,
					primaryButton: localize({ key: 'claudeSaveBeforeCommandSave', comment: ['&& denotes a mnemonic'] }, "&&Save All"),
					cancelButton: localize('claudeSaveBeforeCommandSkip', "Don't Save"),
				});
				return confirmed;
			},
		};
	}
}
