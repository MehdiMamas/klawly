/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_CHECK_INVESTIGATOR_CHANNEL, IClaudeCheckInvestigator } from '../../../../platform/claude/common/claudeCheckInvestigation.js';
import { registerSharedProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

registerSharedProcessRemoteService(IClaudeCheckInvestigator, CLAUDE_CHECK_INVESTIGATOR_CHANNEL);
