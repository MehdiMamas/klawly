/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IClaudeMachineSessionService } from '../../../../platform/claude/common/claudeMachineSessions.js';
import { CLAUDE_MACHINE_SESSION_CHANNEL } from '../../../../platform/claude/common/claudeBackgroundIpc.js';
import { registerSharedProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

registerSharedProcessRemoteService(IClaudeMachineSessionService, CLAUDE_MACHINE_SESSION_CHANNEL);
