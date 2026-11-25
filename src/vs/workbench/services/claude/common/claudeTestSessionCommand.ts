/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Schemas } from '../../../../base/common/network.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IOutputService } from '../../output/common/output.js';
import { IClaudeAgentService } from './claudeAgentService.js';
import { CLAUDE_AGENT_OUTPUT_CHANNEL_ID, redactSecrets } from './claudeAgentLog.js';

/** Command palette id for `Klawly: Run Test Agent Session`. */
export const RUN_TEST_AGENT_SESSION_COMMAND_ID = 'klawly.runTestAgentSession';

/**
 * Starts a fake or live session, selected by `claude.agent.runtime`, and shows
 * the Claude Agent output channel. Needs a local workspace folder for `cwd`.
 */
export async function runKlawlyTestAgentSession(accessor: ServicesAccessor): Promise<void> {
	const workspace = accessor.get(IWorkspaceContextService);
	const notificationService = accessor.get(INotificationService);
	const outputService = accessor.get(IOutputService);
	const agentService = accessor.get(IClaudeAgentService);
	const folder = workspace.getWorkspace().folders.find(candidate => candidate.uri.scheme === Schemas.file);
	if (!folder) {
		notificationService.error(localize('claudeTestSessionNeedsFolder', "Open a local folder before running a test agent session."));
		return;
	}
	await outputService.showChannel(CLAUDE_AGENT_OUTPUT_CHANNEL_ID);
	try {
		await agentService.runTestSession(folder.uri.fsPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notificationService.error(redactSecrets(message));
	}
}
