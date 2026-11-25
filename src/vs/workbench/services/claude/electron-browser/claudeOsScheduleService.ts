/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_OS_SCHEDULE_CHANNEL, IClaudeOsScheduleService } from '../../../../platform/claude/common/claudeAutomationOsScheduleService.js';
import { registerSharedProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

registerSharedProcessRemoteService(IClaudeOsScheduleService, CLAUDE_OS_SCHEDULE_CHANNEL);
