/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IClaudeWorktreeService } from '../../../../platform/claude/common/claudeBackground.js';
import { CLAUDE_WORKTREE_CHANNEL } from '../../../../platform/claude/common/claudeBackgroundIpc.js';
import { registerSharedProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

registerSharedProcessRemoteService(IClaudeWorktreeService, CLAUDE_WORKTREE_CHANNEL);
