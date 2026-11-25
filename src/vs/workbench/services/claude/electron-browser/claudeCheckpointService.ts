/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { CLAUDE_CHECKPOINTS_ENABLED_SETTING } from '../../../../platform/claude/common/claudeConfiguration.js';
import { readCheckpointsEnabled } from '../../../../platform/claude/common/claudeCheckpoints.js';
import { ITextFileService } from '../../textfile/common/textfiles.js';
import { IOutputService } from '../../output/common/output.js';
import { INativeWorkbenchEnvironmentService } from '../../environment/electron-browser/environmentService.js';
import { CLAUDE_AGENT_OUTPUT_CHANNEL_ID, formatClaudeLogLine } from '../common/claudeAgentLog.js';
import { ClaudeCheckpointService } from '../common/claudeCheckpointService.js';

export class NativeClaudeCheckpointService extends ClaudeCheckpointService {
	constructor(
		@INativeWorkbenchEnvironmentService environmentService: INativeWorkbenchEnvironmentService,
		@IFileService files: IFileService,
		@ITextFileService textFiles: ITextFileService,
		@IDialogService dialogs: IDialogService,
		@IConfigurationService configurationService: IConfigurationService,
		@IOutputService outputService: IOutputService,
	) {
		super(environmentService.userDataPath, files, textFiles, dialogs, () => readCheckpointsEnabled(configurationService.getValue(CLAUDE_CHECKPOINTS_ENABLED_SETTING)), message => {
			outputService.getChannel(CLAUDE_AGENT_OUTPUT_CHANNEL_ID)?.append(formatClaudeLogLine(message));
		});
	}
}
