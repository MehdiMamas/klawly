/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeSaveBeforeCommandRequest } from '../../../../platform/claude/common/claude.js';

/** What the workbench does with unsaved editors before a shell command. */
export interface ClaudeSaveBeforeCommandHost {
	/** Unsaved editors that have a file on disk. Untitled editors are never counted or saved. */
	dirtyCount(): number;
	saveAll(): Promise<void>;
	/** True to save. Asked only in `prompt` mode and only when something is unsaved. */
	confirm(count: number, command: string): Promise<boolean>;
}

export type ClaudeSaveBeforeCommandResult = 'clean' | 'saved' | 'declined';

/**
 * Applies `claude.agent.saveBeforeCommands` to one waiting command. `always`
 * saves without asking. `prompt` asks first. Nothing unsaved means no question.
 */
export async function applyClaudeSaveBeforeCommand(request: Pick<ClaudeSaveBeforeCommandRequest, 'command' | 'mode'>, host: ClaudeSaveBeforeCommandHost): Promise<ClaudeSaveBeforeCommandResult> {
	const count = host.dirtyCount();
	if (count === 0) {
		return 'clean';
	}
	if (request.mode === 'prompt' && !await host.confirm(count, request.command)) {
		return 'declined';
	}
	await host.saveAll();
	return 'saved';
}
