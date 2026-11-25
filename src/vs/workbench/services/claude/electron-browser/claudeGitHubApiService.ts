/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_GITHUB_API_CHANNEL, IClaudeGitHubApiService } from '../../../../platform/claude/common/claudeAutomationGitHub.js';
import { registerSharedProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

registerSharedProcessRemoteService(IClaudeGitHubApiService, CLAUDE_GITHUB_API_CHANNEL);
