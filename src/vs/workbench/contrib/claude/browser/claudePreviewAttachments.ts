/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ContextAttachment } from '../../../../platform/claude/common/claudeContext.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IClaudePreviewAttachmentService = createDecorator<IClaudePreviewAttachmentService>('claudePreviewAttachmentService');

export interface IClaudePreviewAttachmentService {
	readonly _serviceBrand: undefined;
	storeImage(sessionId: string, bytes: Uint8Array): Promise<ContextAttachment>;
}
