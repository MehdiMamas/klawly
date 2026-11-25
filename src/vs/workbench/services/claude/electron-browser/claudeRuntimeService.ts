/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { CLAUDE_RUNTIME_CHANNEL } from '../../../../platform/claude/common/claudeIpc.js';
import { registerSharedProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

registerSharedProcessRemoteService(IClaudeRuntimeService, CLAUDE_RUNTIME_CHANNEL);
