/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IKlawlySyncService, KLAWLY_SYNC_CHANNEL } from '../../../../platform/claude/common/klawlySyncService.js';
import { registerSharedProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

registerSharedProcessRemoteService(IKlawlySyncService, KLAWLY_SYNC_CHANNEL);
