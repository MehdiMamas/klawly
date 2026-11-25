/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ContextAttachment } from './claudeContext.js';

export const IClaudeActionService = createDecorator<IClaudeActionService>('claudeActionService');

export type AgentActionId =
	| 'addSelection'
	| 'explainSelection'
	| 'reviewChanges'
	| 'reviewTurnChanges'
	| 'securityReviewChanges'
	| 'generateCommitMessage'
	| 'explainDiff'
	| 'explainCommit'
	| 'resolveConflicts'
	| 'splitPullRequests'
	| 'generateReviewKnowledge'
	| 'fixProblems'
	| 'fixTerminalError'
	| 'fixPreviewElement';

export interface AgentActionRequest {
	id: AgentActionId;
	source: 'button' | 'menu' | 'keybinding' | 'drop' | 'paste' | 'palette';
	attachments: ContextAttachment[];
	args?: Record<string, string>;
}

export type ActionResolution =
	| { kind: 'claude-command'; command: string }
	| { kind: 'skill'; skill: string }
	| { kind: 'prompt'; templateId: string };

/**
 * Types only. The phase that owns each gesture registers the implementation.
 */
export interface IClaudeActionService {
	readonly _serviceBrand: undefined;
	resolve(req: AgentActionRequest): ActionResolution;
	run(req: AgentActionRequest): Promise<void>;
}
