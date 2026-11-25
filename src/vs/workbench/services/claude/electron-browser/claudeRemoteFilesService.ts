/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_REMOTE_FILES_CHANNEL, IClaudeRemoteFilesService } from '../../../../platform/claude/common/claudeRemoteFiles.js';
import { registerSharedProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

registerSharedProcessRemoteService(IClaudeRemoteFilesService, CLAUDE_REMOTE_FILES_CHANNEL);
