/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { AgentMode, ContextAttachment } from '../../../../platform/claude/common/claudeContext.js';
import { AgentEnvelope } from '../../../../platform/claude/common/claudePrompt.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IClaudeContextService = createDecorator<IClaudeContextService>('claudeContextService');

/**
 * Resolves composer chips against the current editor models and compiles the
 * prompt that will be sent. The pane never reads files itself.
 */
export interface IClaudeContextService {
	readonly _serviceBrand: undefined;
	resolve(userText: string, mode: AgentMode, attachments: readonly ContextAttachment[], sessionId?: string): Promise<AgentEnvelope>;
	/** The exact text `submit` will send for this composer state. */
	preview(userText: string, mode: AgentMode, attachments: readonly ContextAttachment[], sessionId?: string): Promise<string>;
	/** Stores an image for the prompt. `name` is what the chip and the sent message call it (issue 743). */
	storeImage(bytes: Uint8Array, mime: string, name?: string): Promise<ContextAttachment>;
	/** Copies a file from outside the workspace into an attachment the prompt can cite. */
	copyExternalFile(uri: URI): Promise<ContextAttachment>;
}
