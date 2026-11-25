/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { ClaudeElicitationAnswer } from '../../../../platform/claude/common/claudeElicitation.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IClaudeAgentService } from './claudeAgentService.js';
import { ElicitationEntry } from './claudeAgentState.js';

export const IClaudeElicitationService = createDecorator<IClaudeElicitationService>('claudeElicitationService');

/**
 * Answers MCP forms and sign-ins (issue 428). The card asks; this service checks
 * the request still waits and hands the answer to the runtime of the session.
 */
export interface IClaudeElicitationService {
	readonly _serviceBrand: undefined;
	/** The forms and sign-ins of a pane session that still wait for the user, oldest first. */
	getPending(sessionId: string): readonly ElicitationEntry[];
	/**
	 * Answers a pending request. Rejects when it is not pending or the runtime
	 * session is gone, so a late click cannot answer something stale. The caller
	 * screens an accepted form for secrets first.
	 */
	respond(sessionId: string, id: string, answer: ClaudeElicitationAnswer): Promise<void>;
}

export class ClaudeElicitationService implements IClaudeElicitationService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
	) { }

	getPending(sessionId: string): readonly ElicitationEntry[] {
		return this._agent.getViewState(sessionId).turns.flatMap(turn => turn.elicitations ?? []).filter(entry => entry.state === 'pending');
	}

	async respond(sessionId: string, id: string, answer: ClaudeElicitationAnswer): Promise<void> {
		if (!this.getPending(sessionId).some(entry => entry.id === id)) {
			throw new Error(localize('claudeElicitationNotPending', "That request was already answered or has ended."));
		}
		const runtimeId = this._agent.getRuntimeSessionId(sessionId);
		if (!runtimeId || !this._runtime.resolveElicitation) {
			throw new Error(localize('claudeElicitationNoSession', "The agent session has ended, so the request was cancelled."));
		}
		await this._runtime.resolveElicitation(runtimeId, id, answer);
	}
}
