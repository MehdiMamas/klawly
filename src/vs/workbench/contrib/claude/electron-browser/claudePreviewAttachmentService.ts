/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ContextAttachment } from '../../../../platform/claude/common/claudeContext.js';
import { PreviewAttachmentStore } from '../common/claudePreview.js';
import { IClaudePreviewAttachmentService } from '../browser/claudePreviewAttachments.js';

export class ClaudePreviewAttachmentService implements IClaudePreviewAttachmentService {
	declare readonly _serviceBrand: undefined;

	private readonly _store: PreviewAttachmentStore;

	constructor(
		@IFileService files: IFileService,
		@INativeEnvironmentService environment: INativeEnvironmentService,
	) {
		this._store = new PreviewAttachmentStore(files, environment.userDataPath, generateUuid);
	}

	storeImage(sessionId: string, bytes: Uint8Array): Promise<ContextAttachment> {
		return this._store.storeImage(sessionId, bytes);
	}
}
