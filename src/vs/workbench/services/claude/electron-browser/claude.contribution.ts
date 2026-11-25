/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ClaudeDelegationService, IClaudeDelegationService } from '../common/claudeDelegation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IOutputChannelRegistry, Extensions as OutputExtensions } from '../../output/common/output.js';
import { ClaudeAgentService, IClaudeAgentService } from '../common/claudeAgentService.js';
import { ClaudeFileTouchService, IClaudeFileTouchService } from '../common/claudeFileTouchService.js';
import { ClaudeAutocompleteService, IClaudeAutocompleteService } from '../common/claudeAutocompleteService.js';
import { ClaudePermissionService, IClaudePermissionService } from '../common/claudePermissionService.js';
import { ClaudeElicitationService, IClaudeElicitationService } from '../common/claudeElicitationService.js';
import { ClaudeCopyTracker, IClaudeCopyTracker } from '../common/claudeCopyTracker.js';
import { IClaudeCheckpointService } from '../common/claudeCheckpointService.js';
import { NativeClaudeCheckpointService } from './claudeCheckpointService.js';
import { ClaudeReviewService, IClaudeReviewService } from '../common/claudeReview.js';
import { IClaudeBackgroundAgentService, IClaudeBackgroundPreview } from '../common/claudeBackgroundAgent.js';
import { NativeClaudeBackgroundAgentService, NativeClaudeBackgroundPreview, NativeClaudeWorktreeKeeper } from './claudeBackgroundAgent.js';
import './claudeWorktreeService.js';
import './claudeMachineSessionService.js';
import './claudePluginService.js';
import './claudeRemoteFilesService.js';
import './claudeFeedbackService.js';
import './klawlySyncService.js';
import './claudeCheckInvestigatorService.js';
import './claudeGitHubApiService.js';
import './claudeOsScheduleService.js';
import { ClaudeInlineEditService, IClaudeInlineEditService } from '../common/claudeInlineEdit.js';
import { ClaudePlanLinks, IClaudePlanLinks } from '../common/claudePlanLinks.js';
import { ClaudeComparisonService, IClaudeComparisonService } from '../common/claudeComparison.js';
import { ClaudeAutomationService, IClaudeAutomationService } from '../common/claudeAutomationService.js';
import { CLAUDE_AGENT_OUTPUT_CHANNEL_ID, CLAUDE_COMMAND_LOG_CHANNEL_ID } from '../common/claudeAgentLog.js';
import { ClaudeMultitaskService, IClaudeMultitaskService } from '../common/claudeMultitask.js';
import { ClaudeWorkerRegistry, IClaudeWorkerRegistry } from '../common/claudeWorkerRegistry.js';
import { IClaudeWorktreeKeeper } from '../common/claudeWorktreeKeeper.js';
import { CLAUDE_MCP_LOG_CHANNEL_ID } from '../../../../platform/claude/common/claudeMcpControl.js';
import { ClaudeKlawlyHooksService, IClaudeKlawlyHooksService } from '../common/claudeKlawlyHooksService.js';

Registry.as<IOutputChannelRegistry>(OutputExtensions.OutputChannels).registerChannel({
	id: CLAUDE_AGENT_OUTPUT_CHANNEL_ID,
	label: localize('claudeAgentOutput', "Claude Agent"),
	log: false,
});

Registry.as<IOutputChannelRegistry>(OutputExtensions.OutputChannels).registerChannel({
	id: CLAUDE_COMMAND_LOG_CHANNEL_ID,
	label: localize('claudeCommandLog', "Claude Command Log"),
	log: false,
});

// Issue 512: Show Logs on an MCP server row fills this with that server's newest log.
Registry.as<IOutputChannelRegistry>(OutputExtensions.OutputChannels).registerChannel({
	id: CLAUDE_MCP_LOG_CHANNEL_ID,
	label: localize('claudeMcpLogs', "Claude MCP Logs"),
	log: false,
});

registerSingleton(IClaudeAgentService, ClaudeAgentService, InstantiationType.Delayed);
// Eager: it follows tool events from the start, so a file an agent began editing before the first look still shows.
registerSingleton(IClaudeFileTouchService, ClaudeFileTouchService, InstantiationType.Eager);
// Auto and the delegate tool hand tasks to delegated chats (issue 693).
registerSingleton(IClaudeDelegationService, ClaudeDelegationService, InstantiationType.Delayed);
registerSingleton(IClaudeAutocompleteService, ClaudeAutocompleteService, InstantiationType.Delayed);
registerSingleton(IClaudePermissionService, ClaudePermissionService, InstantiationType.Delayed);
registerSingleton(IClaudeElicitationService, ClaudeElicitationService, InstantiationType.Delayed);
registerSingleton(IClaudeCopyTracker, ClaudeCopyTracker, InstantiationType.Delayed);
registerSingleton(IClaudeCheckpointService, NativeClaudeCheckpointService, InstantiationType.Delayed);
registerSingleton(IClaudeReviewService, ClaudeReviewService, InstantiationType.Delayed);
registerSingleton(IClaudeBackgroundPreview, NativeClaudeBackgroundPreview, InstantiationType.Delayed);
registerSingleton(IClaudeBackgroundAgentService, NativeClaudeBackgroundAgentService, InstantiationType.Delayed);
registerSingleton(IClaudeWorktreeKeeper, NativeClaudeWorktreeKeeper, InstantiationType.Delayed);
registerSingleton(IClaudeInlineEditService, ClaudeInlineEditService, InstantiationType.Delayed);
registerSingleton(IClaudePlanLinks, ClaudePlanLinks, InstantiationType.Delayed);
registerSingleton(IClaudeComparisonService, ClaudeComparisonService, InstantiationType.Delayed);
registerSingleton(IClaudeAutomationService, ClaudeAutomationService, InstantiationType.Delayed);
registerSingleton(IClaudeMultitaskService, ClaudeMultitaskService, InstantiationType.Delayed);
registerSingleton(IClaudeWorkerRegistry, ClaudeWorkerRegistry, InstantiationType.Delayed);
registerSingleton(IClaudeKlawlyHooksService, ClaudeKlawlyHooksService, InstantiationType.Delayed);
