/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_FEEDBACK_CHANNEL, IClaudeFeedbackService } from '../../../../platform/claude/common/claudeFeedbackRelay.js';
import { registerSharedProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

registerSharedProcessRemoteService(IClaudeFeedbackService, CLAUDE_FEEDBACK_CHANNEL);
