/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_DELEGATE_HELPER_WORKTREES_SETTING, CLAUDE_DELEGATE_CODING_CAP_DEFAULT, CLAUDE_DELEGATE_CODING_CAP_MAX, CLAUDE_DELEGATE_CODING_CAP_SETTING, CLAUDE_DELEGATE_DEPTH_DEFAULT, CLAUDE_DELEGATE_DEPTH_HARD_MAX, CLAUDE_DELEGATE_DEPTH_SETTING } from '../../../../platform/claude/common/claudeDelegateScheduler.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { OS } from '../../../../base/common/platform.js';
import { ConfigurationScope, IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IClaudePreviewCapture } from '../browser/claudePreviewCapture.js';
import { IClaudePreviewAttachmentService } from '../browser/claudePreviewAttachments.js';
import { ClaudePreviewAttachmentService } from './claudePreviewAttachmentService.js';
import { ClaudePreviewCapture } from './claudePreviewCapture.js';
import { ClaudeExtensionAgentService, IClaudeExtensionAgentService } from '../../../services/claude/common/claudeExtensionAgentService.js';
import '../browser/claudeMakerService.js';
import { CLAUDE_WORK_RULES_SETTING } from '../../../../platform/claude/common/claudeWorkRules.js';
import { CLAUDE_VERIFY_UI_SETTING } from '../../../../platform/claude/common/claudeVerifyUi.js';
import { CLAUDE_AGENT_REPLY_STYLE_SETTING } from '../../../../platform/claude/common/claudeReplyStyle.js';
import { CLAUDE_USE_CLAUDE_CODE_SETUP_SETTING } from '../../../../platform/claude/common/claudeUserLayer.js';
import { CLAUDE_DELEGATION_LADDER_DEFAULTS, CLAUDE_DELEGATION_SESSION_FAILED_CALLS_SETTING, CLAUDE_DELEGATION_SESSION_STEPS_SETTING, CLAUDE_DELEGATION_WORKER_FAILED_CALLS_SETTING } from '../../../../platform/claude/common/claudeDelegateLadder.js';
import { CLAUDE_COST_WATCHER_DEFAULT_CADENCE, CLAUDE_DELEGATION_COST_WATCHER_CADENCE_SETTING, CLAUDE_DELEGATION_COST_WATCHER_ENABLED_SETTING, CLAUDE_DELEGATION_COST_WATCHER_REFUSE_SETTING } from '../../../../platform/claude/common/claudeDelegateCostWatcher.js';
import { CLAUDE_DELEGATION_TIER_MODEL_DEFAULTS, CLAUDE_DELEGATION_TIER_MODEL_SETTINGS } from '../../../../platform/claude/common/claudeDelegateTier.js';
import { CLAUDE_ACCOUNTS_DEFAULT_ACCOUNT_SETTING } from '../../../../platform/claude/common/claudeChatAccount.js';
import { CLAUDE_ACCOUNTS_LIMIT_OPTIONS_SETTING, CLAUDE_ACCOUNTS_ON_LIMIT_SETTING } from '../../../../platform/claude/common/claudeLimitPolicy.js';
import { CLAUDE_AUTO_ENABLED_SETTING, CLAUDE_AUTO_REUSE_HELPERS_SETTING, CLAUDE_MERGE_STAGE_AFTER_KEEP_SETTING, CLAUDE_MERGE_WITHOUT_ASKING_SETTING, CLAUDE_ACTIONS_PREFER_COMMANDS_SETTING, CLAUDE_AGENT_ALLOW_EVERYTHING_CONFIRM_SETTING, CLAUDE_AGENT_AUTO_APPROVE_READS_SETTING, CLAUDE_AGENT_AUTO_APPROVE_WRITES_SETTING, CLAUDE_AGENT_DEFAULT_MODE_SETTING, CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, CLAUDE_AGENT_ENABLED_SETTING, CLAUDE_AGENT_NEW_CHATS_FIRST_SETTING, CLAUDE_AGENT_RUNTIME_PATH_SETTING, CLAUDE_AGENT_RUNTIME_SETTING, CLAUDE_AGENT_SAVE_BEFORE_COMMANDS_SETTING, CLAUDE_AUTOCOMPLETE_DEBOUNCE_DEFAULT_MS, CLAUDE_AUTOCOMPLETE_DEBOUNCE_MAX_MS, CLAUDE_AUTOCOMPLETE_DEBOUNCE_MIN_MS, CLAUDE_AUTOCOMPLETE_DEBOUNCE_SETTING, CLAUDE_AUTOCOMPLETE_ENABLED_SETTING, CLAUDE_AUTOCOMPLETE_MODEL_SETTING, CLAUDE_CHAT_REFERENCE_SUMMARY_SETTING, CLAUDE_CHECKPOINTS_ENABLED_SETTING, CLAUDE_CHECKPOINT_RETENTION_SETTING, CLAUDE_COMPOSER_PASTE_AS_REFERENCE_SETTING, CLAUDE_COMPOSER_WHILE_WORKING_SETTING, CLAUDE_CONFIGURABLE_EFFORT_LEVELS, CLAUDE_DEBUG_RETAIN_RAW_SETTING, CLAUDE_DEBUG_TERMINAL_LINES_SETTING, CLAUDE_DELEGATION_ENABLED_SETTING, CLAUDE_DIAGNOSTICS_AUTO_VERIFY_SETTING, CLAUDE_DIAGNOSTICS_DEFAULT_CYCLES, CLAUDE_DIAGNOSTICS_HARD_CAP, CLAUDE_DIAGNOSTICS_MAX_CYCLES_SETTING, CLAUDE_DIAGNOSTICS_SETTLE_DEFAULT_MS, CLAUDE_DIAGNOSTICS_SETTLE_MAX_MS, CLAUDE_DIAGNOSTICS_SETTLE_MIN_MS, CLAUDE_DIAGNOSTICS_SETTLE_MS_SETTING, CLAUDE_INLINE_EDIT_MODEL_SETTING, CLAUDE_INLINE_REJECT_ON_ESCAPE_SETTING, CLAUDE_INSTRUCTIONS_AGENTS_MD_SETTING, CLAUDE_INSTRUCTIONS_AGENTS_SKILLS_SETTING, CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING, CLAUDE_LONG_PASTE_DEFAULT, CLAUDE_LONG_PASTE_SETTING, CLAUDE_MODELS_CUSTOM_SETTING, CLAUDE_MODELS_DEFAULT_SETTING, CLAUDE_MODELS_EFFORT_SETTING, CLAUDE_MODELS_ENABLED_SETTING, CLAUDE_MODELS_FAST_MODE_SETTING, CLAUDE_MODELS_ULTRACODE_SETTING, CLAUDE_NOTIFICATIONS_APPROVAL_SETTING, CLAUDE_NOTIFICATIONS_FINISHED_SETTING, CLAUDE_NOTIFICATIONS_SOUND_SETTING, CLAUDE_PERMISSION_SETTINGS, CLAUDE_PREVIEW_ENABLED_SETTING, CLAUDE_REVIEW_AUTO_KEEP_SETTING, CLAUDE_REVIEW_OPEN_AFTER_EDIT_SETTING, CLAUDE_SECURITY_SCAN_ATTACHMENTS_SETTING, CLAUDE_SELECTION_TOOLBAR_SETTING, CLAUDE_SUBAGENTS_BUILT_IN_SETTING, CLAUDE_SUBAGENTS_OPEN_ON_START_SETTING, CLAUDE_TELEMETRY_ENABLED_SETTING, CLAUDE_TERMINAL_MIRROR_SETTING } from '../../../../platform/claude/common/claudeConfiguration.js';
import { KLAWLY_SYNC_ENABLED_SETTING, KLAWLY_SYNC_HISTORY_EXCLUDED_SETTING, KLAWLY_SYNC_HISTORY_KEEP_SETTING, KLAWLY_SYNC_HISTORY_MAX_KB_SETTING, KLAWLY_SYNC_HISTORY_SETTING, KLAWLY_SYNC_MEMORY_SETTING } from '../../../../platform/claude/common/klawlySyncService.js';
import { CLAUDE_WORKER_PROFILE_DEFAULT, CLAUDE_WORKER_PROFILE_SETTING, CLAUDE_WORKER_PROFILES } from '../../../../platform/claude/common/claudeWorkerProfile.js';
import { CLAUDE_REVIEW_POST_STATUS_SETTING } from '../../../../platform/claude/common/claudeAutomationGitHub.js';
import { CLAUDE_REVIEW_CATEGORIES, CLAUDE_REVIEW_CATEGORIES_SETTING, CLAUDE_REVIEW_DEFAULT_CATEGORIES, CLAUDE_REVIEW_MIN_SEVERITY_SETTING, CLAUDE_REVIEW_SEVERITIES, CLAUDE_REVIEW_SHOW_READINESS_SETTING, CLAUDE_REVIEW_STRICTNESS_SETTING, CLAUDE_REVIEW_SUMMARY_MODES, CLAUDE_REVIEW_SUMMARY_SETTING } from '../../../../platform/claude/common/claudeReviewLoop.js';
import { CLAUDE_REVIEW_IMPACT_CONTEXT_SETTING, CLAUDE_REVIEW_IMPACT_CONTEXTS } from '../../../../platform/claude/common/claudeReviewContext.js';
import { CLAUDE_REVIEW_DEFAULT_TICKET_PATTERNS, CLAUDE_REVIEW_TICKET_PATTERNS_SETTING, CLAUDE_REVIEW_USE_TICKETS_SETTING } from '../../../../platform/claude/common/claudeReviewTickets.js';
import { CLAUDE_REVIEW_DEPTH_SETTING, CLAUDE_REVIEW_DEPTHS, CLAUDE_REVIEW_MAX_TURNS_SETTING, CLAUDE_REVIEW_MODEL_SETTING } from '../../../../platform/claude/common/claudeReviewDepth.js';
import { CLAUDE_MODELS_AUTO_SETTING } from '../../../../platform/claude/common/claudeAutoModel.js';
import { CLAUDE_AUTO_COST_NOTIFY_USD_DEFAULT, CLAUDE_AUTO_COST_NOTIFY_USD_SETTING, CLAUDE_AUTO_COST_STOP_USD_DEFAULT, CLAUDE_AUTO_COST_STOP_USD_SETTING, CLAUDE_AUTO_COST_USD_MAX, CLAUDE_AUTO_COST_USD_MIN } from '../../../../platform/claude/common/claudeAutoCostGuard.js';
import { CLAUDE_AUTO_CONTEXT_CAP_TOKENS_DEFAULT, CLAUDE_AUTO_CONTEXT_CAP_TOKENS_MAX, CLAUDE_AUTO_CONTEXT_CAP_TOKENS_MIN, CLAUDE_AUTO_CONTEXT_CAP_TOKENS_SETTING } from '../../../../platform/claude/common/claudeAutoContextGuard.js';
import { CLAUDE_AUTO_REVIEW_MAX_ROUNDS_DEFAULT, CLAUDE_AUTO_REVIEW_MAX_ROUNDS_MAX, CLAUDE_AUTO_REVIEW_MAX_ROUNDS_MIN, CLAUDE_AUTO_REVIEW_MAX_ROUNDS_SETTING } from '../../../../platform/claude/common/claudeAutoReviewRounds.js';
import { CLAUDE_MODELS_WARN_ON_SWITCH_SETTING } from '../common/claudeModelSwitch.js';
import { CLAUDE_GIT_BRANCH_PREFIX_DEFAULT, CLAUDE_GIT_BRANCH_PREFIX_SETTING, CLAUDE_GIT_COMMIT_ATTRIBUTION_SETTING, CLAUDE_GIT_INSTRUCTIONS_SETTING, CLAUDE_GIT_PR_ATTRIBUTION_SETTING, CLAUDE_GIT_WORKTREE_BASE_SETTING } from '../../../../platform/claude/common/claudeGitSettings.js';
import { registerClaudeSettingsMigrations } from '../common/claudeSettingsMigration.js';
import { CLAUDE_AGENTS_WINDOW_ENABLED_SETTING } from '../../../../platform/claude/common/claudeAgentHost.js';
import { CLAUDE_PLUGINS_BUILT_IN_MARKETPLACES_SETTING } from '../../../../platform/claude/common/claudePlugins.js';
import '../../../../platform/claude/common/claudeSecurityConfiguration.js';
import { CLAUDE_SESSION_LIST_LOCATION_SETTING } from '../common/claudeAgentsList.js';
import { registerClaudeCommands } from '../browser/claudeCommands.js';
import { registerClaudeAgentsSidebarCommands } from '../browser/claudeAgentsSidebar.js';
import { ClaudeAgentEnabledContextContribution, ClaudeCommandContextContribution } from '../browser/claudeCommandContext.js';
import { registerClaudeSettingsEditor } from '../browser/settings/claudeSettingsEditorActions.js';
import { CLAUDE_MANAGE_MODELS_COMMAND_ID, KLAWLY_CATEGORY } from '../common/claudeViews.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { CLAUDE_CHAT_REFERENCE_SUMMARY_DEFAULT } from '../../../../platform/claude/common/claudeChatReference.js';
import { CLAUDE_GOAL_MAX_BUDGET_DEFAULT, CLAUDE_GOAL_MAX_BUDGET_SETTING, CLAUDE_GOAL_MAX_TURNS_DEFAULT, CLAUDE_GOAL_MAX_TURNS_SETTING } from '../../../../platform/claude/common/claudeGoalLoop.js';
import { ClaudeDurableHistoryContribution } from './claudeDurableHistory.js';
import { registerClaudeTabEditorContribution } from '../browser/claudeAutocompleteContribution.js';
import '../browser/claudeKlawlyHooksContribution.js';
import '../browser/claudeAttributionContribution.js';
import '../browser/claudeFileTouchDecorations.js';
import '../browser/claudeReadRulesDecorations.js';
import '../browser/claudeFollowAgentEdits.js';
import '../browser/claudeLiveDiffView.js';
import { CLAUDE_LINE_ATTRIBUTION_SETTING } from '../../../services/claude/common/claudeAttribution.js';
import { CLAUDE_ATTRIBUTION_GIT_NOTES_SETTING } from '../../../services/claude/common/claudeAttributionNote.js';
import { ClaudeAttributionNotes } from '../browser/claudeAttributionNotes.js';
import '../browser/claudeColors.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IClaudeActionService } from '../../../../platform/claude/common/claudeActions.js';
import { IClaudeContextService } from '../../../services/claude/common/claudeContextService.js';
import { ClaudeActionService } from '../browser/claudeActionService.js';
import { ClaudeDiagnosticsContribution, ClaudeDiagnosticsService } from '../browser/claudeDiagnosticsService.js';
import { ClaudeFixProblemsContribution, registerClaudeDiagnosticsActions } from '../browser/claudeDiagnosticsActions.js';
import { IClaudeDiagnosticsService } from '../../../services/claude/common/claudeDiagnostics.js';
import { ClaudeContextService } from '../browser/claudeContextService.js';
import { ClaudeCopyContribution } from '../browser/claudeCopyContribution.js';
import { ClaudePointerFocusContribution } from '../browser/claudePointerFocus.js';
import { ClaudeAgentsWindowLayoutContribution } from './claudeAgentsWindowLayout.js';
import './claudeAgentsWindowActions.js';
import { ClaudeFirstRunLayoutContribution } from '../browser/claudeFirstRunLayout.js';
import { ClaudeComingFromTerminalContribution } from '../browser/claudeComingFromTerminal.js';
import { registerClaudeContextActions } from '../browser/claudeContextActions.js';
import { registerClaudeMenuItems } from '../browser/claudeMenus.js';
import '../browser/media/claudeChrome.css';
import { ClaudeMergeStageContribution } from '../browser/claudeMergeStage.js';
import { registerClaudeGitActions } from '../browser/claudeGitActions.js';
import { registerClaudeScmReviewSection } from '../browser/claudeScmReviewSection.js';
import { registerClaudeSecurityFindingsView } from '../browser/claudeSecurityFindingsView.js';
import { RUN_TEST_AGENT_SESSION_COMMAND_ID, runKlawlyTestAgentSession } from '../../../services/claude/common/claudeTestSessionCommand.js';
import { registerClaudePaneActions } from '../browser/claudeActions.js';
import { ClaudeProjectIndex, IClaudeProjectIndex, registerClaudeProjectActions } from '../browser/claudeProjects.js';
import { registerClaudePreview } from '../browser/claudePreview.contribution.js';
import { registerClaudeCanvas } from '../browser/claudeCanvas.contribution.js';
import { registerClaudeSplit } from '../browser/claudeSplit.contribution.js';
import { registerClaudePlanEditor } from '../browser/plan/claudePlan.contribution.js';
import { registerClaudeReviewEditor } from '../browser/review/claudeReviewEditorActions.js';
import { registerClaudeAgentEditor } from '../browser/chat/claudeAgentEditorActions.js';
import { registerClaudeChatShareCommands } from '../browser/chat/claudeChatShare.js';
import '../browser/chat/claudeTendPullRequest.js';
import { registerClaudeVoice } from '../browser/chat/claudeVoiceActions.js';
import { registerClaudeInlineContributions, registerClaudeInlineEditorContribution } from '../browser/inline/claudeInlineController.js';
import { registerClaudeSelectionToolbar } from '../browser/inline/claudeSelectionToolbar.js';
import { registerClaudeTerminalPrompt } from '../browser/terminal/claudeTerminalPrompt.js';
import { registerClaudeTerminalSelectionBar } from '../browser/terminal/claudeTerminalSelectionBar.js';
import { registerClaudeReviewContributions, registerClaudeReviewEditorContributions } from '../browser/review/claudeReviewPane.js';
import { registerClaudeViewDescriptors } from '../browser/claudeViewRegistration.js';
import { ClaudeAgentViewPane } from '../browser/chat/claudeViewPane.js';
import { registerClaudeBackground } from '../../claudeBackground/browser/claudeBackground.contribution.js';
import { ClaudeOnboardingHintContribution, ClaudeSetupService, IClaudeSetupService, registerClaudeSetupCommands } from '../browser/claudeSetup.js';
import { registerClaudeAccountCommands } from '../browser/claudeAccountCommands.js';
import { registerClaudeProjectSwitcher } from '../browser/claudeProjectSwitcher.js';
import { KlawlyProfileContribution, registerKlawlyProfileCommands } from '../browser/klawlyProfile.js';
import { ClaudeStatusBarContribution, registerClaudeStatusCommands } from '../browser/claudeStatus.js';
import { ClaudeTabStatusContribution, registerClaudeTabStatusCommands } from '../browser/claudeTabStatus.js';
import { ClaudePendingStatusContribution } from '../browser/review/claudeKeepAll.js';
import { ClaudeRemoteIndicatorDefaultContribution } from '../browser/claudeRemoteIndicator.js';
import { ClaudeAnnouncerContribution, ClaudeAttentionNotifier } from '../browser/claudeAttention.js';
import { registerClaudeChatDefaults } from '../browser/claudeChatDefaults.js';
import { registerClaudeEditorWatermark } from '../browser/home/claudeHome.js';
import { ClaudeTitleBarContribution } from '../browser/titlebar/claudeTitleBar.js';
import { ClaudeImportContribution, ClaudeImportService, IClaudeImportService, registerClaudeImportCommands } from '../browser/claudeImport.js';
import { ClaudeSaveBeforeCommandsContribution } from '../browser/claudeSaveBeforeCommands.js';
import { ClaudeRunTargetNoticesContribution } from '../browser/claudeRunTargetNotices.js';
import { ClaudeRemoteFilesContribution } from './claudeRemoteFiles.js';
import { ClaudeAutoMigrationContribution } from '../browser/claudeAutoMigrationContribution.js';
import { ClaudePermissionLevelContribution } from '../browser/claudePermissionLevel.js';
import { ClaudeTerminalRunContribution, ClaudeTerminalRunService } from '../browser/claudeTerminalRuns.js';
import { ClaudeCommitReview } from '../browser/claudeCommitReview.js';
import { ClaudeCommitReviewState, IClaudeCommitReviewState } from '../browser/claudeCommitReviewState.js';
import { KlawlySyncStatusBar, registerKlawlySyncStatusCommands } from './klawlySyncStatusBar.js';
import { ClaudeCommitReviewStatusBar, registerClaudeCommitReviewCommands } from '../browser/claudeCommitReviewStatus.js';
import { registerClaudeReviewConfigCommand } from '../browser/claudeReviewConfigCommand.js';
import { ClaudeCommitReviewThreads } from '../browser/claudeCommitReviewThreads.js';
import { ClaudeSettingsToolContribution } from '../browser/claudeSettingsToolHandler.js';
import { ClaudeBrowserOfferContribution } from './claudeBrowserOffer.js';
import { ClaudeShellCommandOfferContribution } from './claudeShellCommandOffer.js';
import { ClaudeBrowserToolContribution } from './claudeBrowserToolHandler.js';
import { ClaudeDelegationContribution, ClaudeDepartmentContribution, ClaudeStartAgentContribution } from '../browser/claudeDelegationContribution.js';
import { ClaudeAgentEntryPoints } from './claudeAgentEntryPoints.js';
import { IClaudeTerminalRunService } from '../common/claudeTerminalRuns.js';
import { ClaudeCommandTerminalContribution, ClaudeCommandTerminalService, IClaudeCommandTerminalService, registerClaudeCommandTerminalActions } from '../browser/claudeCommandTerminal.js';
import { ClaudeGoalLoopService } from '../browser/chat/claudeGoalLoopService.js';
import { IClaudeGoalLoopService } from '../common/claudeGoalLoopService.js';
import { ClaudeDebugCleanupContribution } from '../browser/claudeDebugCleanup.js';
import { ClaudeReproductionContribution, ClaudeReproductionService } from '../browser/claudeReproductions.js';
import { IClaudeReproductionService } from '../common/claudeReproductions.js';
import { registerClaudeDiagnosticsExport } from './claudeDiagnosticsExport.js';
import { ClaudeFeedbackAutoSendContribution, ClaudeFeedbackToolContribution, ClaudeFeedbackStatusContribution, registerClaudeFeedback } from './claudeFeedback.js';
import { registerClaudeGuide } from '../browser/claudeGuide.js';
import { registerClaudeCloudAgents } from './claudeCloudAgents.js';
import { registerClaudeShareToPhone } from '../browser/chat/claudeShareToPhone.js';
import { registerClaudeTerminalPluginCommands } from '../browser/claudeTerminalPluginCommands.js';
import { registerClaudeTerminalSessionsCommand } from '../browser/claudeTerminalSessionsCommand.js';
import { registerClaudeTerminalBrowserCommand } from '../browser/claudeTerminalBrowserCommand.js';
import { registerClaudeTerminalWorkersCommand } from '../browser/claudeTerminalWorkersCommand.js';
import { KLAWLY_FEEDBACK_DEFAULT_ENDPOINT, KLAWLY_FEEDBACK_ENABLED_SETTING, KLAWLY_FEEDBACK_ENDPOINT_SETTING } from '../common/claudeFeedback.js';
import '../browser/claudePolicyDiagnostics.js';
import { CLAUDE_AGENT_AUTO_ALLOW_INSTRUCTIONS_SETTING, CLAUDE_AGENT_AUTO_BLOCK_INSTRUCTIONS_SETTING, CLAUDE_AGENT_AUTO_REVIEW_DELETIONS_SETTING, CLAUDE_AGENT_AUTO_REVIEW_OUTSIDE_WRITES_SETTING, CLAUDE_AGENT_AUTO_REVIEW_AGENT_BROWSER_SETTING } from '../../../../platform/claude/common/claudeAutoReview.js';
import { CLAUDE_REVIEW_CONFIG_FILE_DEFAULT, CLAUDE_REVIEW_CONFIG_FILE_SETTING } from '../../../../platform/claude/common/claudeReviewConfig.js';
import { CLAUDE_REVIEW_LEARN_AFTER_DEFAULT, CLAUDE_REVIEW_LEARN_AFTER_SETTING } from '../../../../platform/claude/common/claudeReviewLearning.js';
import { CLAUDE_REVIEW_AFTER_COMMIT_SETTING, CLAUDE_REVIEW_FIX_SENDS_SETTING } from '../../../../platform/claude/common/claudeCommitReview.js';

registerClaudeViewDescriptors(new SyncDescriptor(ClaudeAgentViewPane));
registerClaudeBackground();
registerClaudePaneActions();
// Projects (issue 496): a goal planned by a coordinator chat and built by background agents.
registerClaudeProjectActions();
registerClaudeReviewContributions();
registerClaudeReviewEditorContributions();
registerClaudeInlineContributions();
registerClaudeInlineEditorContribution();
registerClaudeSelectionToolbar();
registerClaudeTabEditorContribution();
registerClaudeTerminalPrompt();
registerClaudeTerminalSelectionBar();
registerClaudePreview();
registerClaudeCanvas();
registerClaudeSplit();
registerClaudePlanEditor();
registerClaudeReviewEditor();
registerClaudeAgentEditor();
registerClaudeChatShareCommands();
registerSingleton(IClaudePreviewAttachmentService, ClaudePreviewAttachmentService, InstantiationType.Delayed);
registerSingleton(IClaudePreviewCapture, ClaudePreviewCapture, InstantiationType.Delayed);
registerSingleton(IClaudeExtensionAgentService, ClaudeExtensionAgentService, InstantiationType.Delayed);
registerClaudeContextActions();
registerClaudeMenuItems();
registerClaudeGitActions();
registerClaudeScmReviewSection();
registerClaudeSecurityFindingsView();
registerClaudeDiagnosticsActions();
registerSingleton(IClaudeContextService, ClaudeContextService, InstantiationType.Delayed);
registerSingleton(IClaudeActionService, ClaudeActionService, InstantiationType.Delayed);
registerSingleton(IClaudeDiagnosticsService, ClaudeDiagnosticsService, InstantiationType.Delayed);
registerWorkbenchContribution2(ClaudeMergeStageContribution.ID, ClaudeMergeStageContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ClaudeCopyContribution.ID, ClaudeCopyContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ClaudePointerFocusContribution.ID, ClaudePointerFocusContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ClaudeDurableHistoryContribution.ID, ClaudeDurableHistoryContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ClaudeDiagnosticsContribution.ID, ClaudeDiagnosticsContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ClaudeFixProblemsContribution.ID, ClaudeFixProblemsContribution, WorkbenchPhase.AfterRestored);
registerClaudeCommands();
registerClaudeVoice();
// Toggle Agents Sidebar: sessions on top by default, the agents sidebar on request (issue 98).
registerClaudeAgentsSidebarCommands();
registerClaudeSettingsEditor();
registerWorkbenchContribution2(ClaudeAgentEnabledContextContribution.ID, ClaudeAgentEnabledContextContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(ClaudeTitleBarContribution.ID, ClaudeTitleBarContribution, WorkbenchPhase.BlockStartup);
// A new profile starts with the prototype's side bar and agent pane widths.
registerWorkbenchContribution2(ClaudeFirstRunLayoutContribution.ID, ClaudeFirstRunLayoutContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ClaudeComingFromTerminalContribution.ID, ClaudeComingFromTerminalContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ClaudeAgentsWindowLayoutContribution.ID, ClaudeAgentsWindowLayoutContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ClaudeRemoteIndicatorDefaultContribution.ID, ClaudeRemoteIndicatorDefaultContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(ClaudeCommandContextContribution.ID, ClaudeCommandContextContribution, WorkbenchPhase.AfterRestored);

// Onboarding, status bar, announcements and notifications (spec 6, 47, 48, 49, 72).
registerSingleton(IClaudeSetupService, new SyncDescriptor(ClaudeSetupService, [OS], true));
registerClaudeSetupCommands();
registerClaudeAccountCommands();
registerClaudeProjectSwitcher();
// The GitHub account is the Klawly profile; Claude is a row under it (issue 446).
registerKlawlyProfileCommands();
registerWorkbenchContribution2(KlawlyProfileContribution.ID, KlawlyProfileContribution, WorkbenchPhase.AfterRestored);
registerClaudeStatusCommands();
registerWorkbenchContribution2(ClaudeStatusBarContribution.ID, ClaudeStatusBarContribution, WorkbenchPhase.Eventually);
registerClaudeTabStatusCommands();
registerWorkbenchContribution2(ClaudeTabStatusContribution.ID, ClaudeTabStatusContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ClaudePendingStatusContribution.ID, ClaudePendingStatusContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ClaudeOnboardingHintContribution.ID, ClaudeOnboardingHintContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ClaudeAnnouncerContribution.ID, ClaudeAnnouncerContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ClaudeAttentionNotifier.ID, ClaudeAttentionNotifier, WorkbenchPhase.Eventually);
registerSingleton(IClaudeImportService, ClaudeImportService, InstantiationType.Delayed);
registerClaudeImportCommands();
registerWorkbenchContribution2(ClaudeImportContribution.ID, ClaudeImportContribution, WorkbenchPhase.Eventually);
registerClaudeChatDefaults();
// Home in an empty window and the Klawly watermark in an empty editor group (ide-02, ide-03).
registerClaudeEditorWatermark();
registerWorkbenchContribution2(ClaudeSaveBeforeCommandsContribution.ID, ClaudeSaveBeforeCommandsContribution, WorkbenchPhase.AfterRestored);
// Where an agent runs (issue 425): fallback and install notices, and files on an SSH host for Review.
registerWorkbenchContribution2(ClaudeRunTargetNoticesContribution.ID, ClaudeRunTargetNoticesContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ClaudeRemoteFilesContribution.ID, ClaudeRemoteFilesContribution, WorkbenchPhase.BlockRestore);
// One permission level for every session, and its one-time warning (issue 453).
registerWorkbenchContribution2(ClaudePermissionLevelContribution.ID, ClaudePermissionLevelContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ClaudeAutoMigrationContribution.ID, ClaudeAutoMigrationContribution, WorkbenchPhase.AfterRestored);
// Interactive commands Claude hands to the user in a terminal (issue 452).
registerSingleton(IClaudeTerminalRunService, ClaudeTerminalRunService, InstantiationType.Delayed);
registerWorkbenchContribution2(ClaudeTerminalRunContribution.ID, ClaudeTerminalRunContribution, WorkbenchPhase.AfterRestored);
// The read-only Claude terminal that shows Claude's shell commands (issue 742).
registerSingleton(IClaudeCommandTerminalService, ClaudeCommandTerminalService, InstantiationType.Delayed);
registerWorkbenchContribution2(ClaudeCommandTerminalContribution.ID, ClaudeCommandTerminalContribution, WorkbenchPhase.AfterRestored);
registerClaudeCommandTerminalActions();
// `/goal` and `/loop` (issue 486).
registerSingleton(IClaudeProjectIndex, ClaudeProjectIndex, InstantiationType.Delayed);
registerSingleton(IClaudeGoalLoopService, ClaudeGoalLoopService, InstantiationType.Delayed);
// Debug mode's Reproduce card (issue 484).
registerSingleton(IClaudeReproductionService, ClaudeReproductionService, InstantiationType.Delayed);
registerWorkbenchContribution2(ClaudeReproductionContribution.ID, ClaudeReproductionContribution, WorkbenchPhase.AfterRestored);
// Offers to remove the marked lines Debug mode left behind (issue 689).
registerWorkbenchContribution2(ClaudeDebugCleanupContribution.ID, ClaudeDebugCleanupContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ClaudeAttributionNotes.ID, ClaudeAttributionNotes, WorkbenchPhase.Eventually);
// Review after commit: findings in Problems, under their lines and in the status bar (issues 502, 876).
registerSingleton(IClaudeCommitReviewState, ClaudeCommitReviewState, InstantiationType.Delayed);
registerClaudeCommitReviewCommands();
registerClaudeReviewConfigCommand();
registerWorkbenchContribution2(ClaudeCommitReview.ID, ClaudeCommitReview, WorkbenchPhase.Eventually);
registerKlawlySyncStatusCommands();
registerWorkbenchContribution2(KlawlySyncStatusBar.ID, KlawlySyncStatusBar, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ClaudeCommitReviewStatusBar.ID, ClaudeCommitReviewStatusBar, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ClaudeCommitReviewThreads.ID, ClaudeCommitReviewThreads, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ClaudeSettingsToolContribution.ID, ClaudeSettingsToolContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ClaudeBrowserToolContribution.ID, ClaudeBrowserToolContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ClaudeBrowserOfferContribution.ID, ClaudeBrowserOfferContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ClaudeShellCommandOfferContribution.ID, ClaudeShellCommandOfferContribution, WorkbenchPhase.Eventually);
// Delegated chats need the service up before the first message (issue 693).
registerWorkbenchContribution2(ClaudeDelegationContribution.ID, ClaudeDelegationContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ClaudeDepartmentContribution.ID, ClaudeDepartmentContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ClaudeStartAgentContribution.ID, ClaudeStartAgentContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ClaudeAgentEntryPoints.ID, ClaudeAgentEntryPoints, WorkbenchPhase.BlockRestore);
// Developer: Export Claude Agent Diagnostics (spec 51).
registerClaudeDiagnosticsExport();
// Send Feedback: status bar item, command and Help menu entry (issue 444).
registerClaudeFeedback();
registerClaudeGuide();
// Cloud agents through Claude Code's own cloud sessions (issue 516).
registerClaudeCloudAgents();
// Share to Phone: Claude Code's Remote Control on a chat (issue 517).
registerClaudeShareToPhone();
registerClaudeTerminalPluginCommands();
registerClaudeTerminalSessionsCommand();
registerClaudeTerminalBrowserCommand();
registerClaudeTerminalWorkersCommand();
registerWorkbenchContribution2(ClaudeFeedbackStatusContribution.ID, ClaudeFeedbackStatusContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(ClaudeFeedbackAutoSendContribution.ID, ClaudeFeedbackAutoSendContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ClaudeFeedbackToolContribution.ID, ClaudeFeedbackToolContribution, WorkbenchPhase.AfterRestored);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'klawly',
	order: 101,
	title: localize('klawlyConfigurationTitle', "Klawly"),
	type: 'object',
	properties: {
		[KLAWLY_FEEDBACK_ENABLED_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('klawlyFeedbackEnabled', "Show the Send Feedback item in the status bar. The Klawly: Send Feedback command stays available either way."),
		},
		[KLAWLY_FEEDBACK_ENDPOINT_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			default: KLAWLY_FEEDBACK_DEFAULT_ENDPOINT,
			description: localize('klawlyFeedbackEndpoint', "The service that files Send Feedback reports for the Klawly team."),
			tags: ['advanced'],
		},
	},
});

// `claude.composer.longPasteCharacters` was renamed to the spec 46 name.
registerClaudeSettingsMigrations();

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'claude',
	order: 100,
	title: localize('claudeConfigurationTitle', "AI / Claude"),
	type: 'object',
	properties: {
		[CLAUDE_AGENT_RUNTIME_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			enum: ['fake', 'live'],
			enumDescriptions: [
				localize('claudeAgentRuntime.fake', "Replay the built-in test script. No Claude process is started."),
				localize('claudeAgentRuntime.live', "Run Claude Code through the Agent SDK."),
			],
			default: 'live',
			description: localize('claudeAgentRuntime', "Selects the Claude runtime for all windows. Live runs Claude Code. Fake replays a built-in test script for development."),
		},
		[CLAUDE_AGENT_RUNTIME_PATH_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			restricted: true,
			default: '',
			description: localize('claudeAgentRuntimePath', "Absolute path to the Claude Code executable. Leave empty to use the executable on PATH. Used when the runtime is live."),
		},
		[CLAUDE_ACTIONS_PREFER_COMMANDS_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudePreferCommands', "When an action has a matching Claude command or skill in the session, use that. When off, actions use the built-in template."),
		},
		[CLAUDE_LONG_PASTE_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.APPLICATION,
			default: CLAUDE_LONG_PASTE_DEFAULT,
			minimum: 1,
			description: localize('claudeLongPaste', "A paste at least this many characters, or of five lines or more, becomes a pasted-text pill in the message instead of inline text. Used while Paste as Reference is on."),
		},
		[CLAUDE_COMPOSER_PASTE_AS_REFERENCE_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.WINDOW,
			default: true,
			description: localize('claudePasteAsReference', "Paste code copied in the editor as a file and line-range chip, and long text as a pasted-text pill. When off, pastes go into the composer as plain text."),
		},
		[CLAUDE_TERMINAL_MIRROR_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.WINDOW,
			default: true,
			description: localize('claudeTerminalMirror', "Show the shell commands Claude runs, their output, and the ones still running in the background, in a read-only Claude terminal in the Terminal panel."),
		},
		[CLAUDE_COMPOSER_WHILE_WORKING_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.WINDOW,
			enum: ['queue', 'steer'],
			default: 'queue',
			enumDescriptions: [
				localize('claudeWhileWorkingQueue', "Enter holds the message until the running turn ends. Ctrl+Enter (Cmd+Enter on macOS) steers."),
				localize('claudeWhileWorkingSteer', "Enter sends the message into the running turn. Ctrl+Enter (Cmd+Enter on macOS) holds it for later."),
			],
			description: localize('claudeWhileWorking', "What Enter does with a message typed while Claude is working. Steering needs a runtime that supports it; otherwise messages are held."),
		},
		[CLAUDE_SESSION_LIST_LOCATION_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			enum: ['top', 'side'],
			enumDescriptions: [
				localize('claudeSessionListTop', "Sessions show as tabs at the top of the Agent pane. Agent History opens the full list."),
				localize('claudeSessionListSide', "Sessions also show in the agents sidebar on the right of the Agent pane, with search and background agents, when the pane is at least 640 pixels wide."),
			],
			default: 'top',
			description: localize('claudeSessionListLocation', "Where the Agent pane lists your sessions."),
		},
		[CLAUDE_NOTIFICATIONS_APPROVAL_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeNotificationsApproval', "Show a system notification when Claude needs your approval while Klawly is in the background."),
		},
		[CLAUDE_NOTIFICATIONS_FINISHED_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeNotificationsFinished', "Show a notification when an agent or background agent finishes or fails. Agents in the Agent pane notify only while Klawly is in the background."),
		},
		[CLAUDE_NOTIFICATIONS_SOUND_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('claudeNotificationsSound', "Play a sound when an agent finishes or needs your approval, even while Klawly is focused."),
		},
		[CLAUDE_GIT_COMMIT_ATTRIBUTION_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeGitCommitAttribution', "Let Claude Code add its attribution trailer to the commits it makes. Off sets Claude Code's commit attribution to empty. Applies to agent sessions started after the change."),
		},
		[CLAUDE_GIT_PR_ATTRIBUTION_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeGitPrAttribution', "Let Claude Code add its attribution line to the pull requests it opens. Off sets Claude Code's pull request attribution to empty. Applies to agent sessions started after the change."),
		},
		[CLAUDE_LINE_ATTRIBUTION_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.WINDOW,
			default: false,
			description: localize('claudeLineAttribution', "Record which lines each kept Claude change wrote and mark them in the editor gutter, with lines changed by hand afterwards in a neutral color. The record stays in this workspace's local storage and never leaves the machine."),
		},
		[CLAUDE_ATTRIBUTION_GIT_NOTES_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.WINDOW,
			default: false,
			markdownDescription: localize('claudeAttributionGitNotes', "With line attribution on, write which lines Claude wrote into a git note (`refs/notes/klawly`) on each commit, so the marks survive a clone. The note holds line ranges and whether each was an agent turn, Tab or inline edit: no model name, session title or message. Klawly never pushes it; to share it, run `git push origin refs/notes/klawly`."),
		},
		[CLAUDE_GIT_INSTRUCTIONS_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeGitInstructions', "Keep Claude Code's built-in commit and pull request steps in its system prompt. Turn it off when your own CLAUDE.md or skills describe how to commit. Applies to agent sessions started after the change."),
		},
		[CLAUDE_GIT_WORKTREE_BASE_SETTING]: {
			type: 'string',
			enum: ['fresh', 'head'],
			enumDescriptions: [
				localize('claudeGitWorktreeFresh', "Branch from the remote's default branch, for a clean tree."),
				localize('claudeGitWorktreeHead', "Branch from the current commit, so unpushed work is there."),
			],
			scope: ConfigurationScope.APPLICATION,
			default: 'fresh',
			description: localize('claudeGitWorktreeBase', "Where the worktrees Claude Code makes for itself (subagent isolation, entering a worktree) branch from. Applies to agent sessions started after the change."),
		},
		[CLAUDE_REVIEW_AFTER_COMMIT_SETTING]: {
			type: 'string',
			enum: ['off', 'quick', 'deep'],
			enumDescriptions: [
				localize('claudeReviewAfterCommitOff', "No review."),
				localize('claudeReviewAfterCommitQuick', "One read-only pass with the default model."),
				localize('claudeReviewAfterCommitDeep', "One read-only pass with Opus: slower and more thorough."),
			],
			scope: ConfigurationScope.APPLICATION,
			default: 'off',
			markdownDescription: localize('claudeReviewAfterCommit', "When a commit lands while Klawly is open, Claude reviews that commit on its own, read-only, following the project's `REVIEW.md` or `.claude/review.md` when there is one. Findings show in the Problems panel on their lines."),
		},
		[CLAUDE_REVIEW_FIX_SENDS_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			markdownDescription: localize('claudeReviewFixSends', "When on, Fix All and Fix with Agent on a commit review finding send the fix to a new chat at once. The chat's own permission mode and approval cards still decide what runs. When off, they only write the fix as a draft for you to read and send."),
		},
		[CLAUDE_GIT_BRANCH_PREFIX_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			default: CLAUDE_GIT_BRANCH_PREFIX_DEFAULT,
			description: localize('claudeGitBranchPrefix', "The start of the branch name each background agent works on, such as agent/ or your user name. Empty, or a name git would refuse, uses agent/."),
		},
		[CLAUDE_AGENT_ENABLED_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeAgentEnabled', "Turn on the Agent: its views, commands, inline edit, and agent turns. When off, they are hidden or refuse to start, and the editor works as usual. Tab suggestions have their own setting."),
		},
		[CLAUDE_AGENTS_WINDOW_ENABLED_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('claudeAgentsWindowEnabled', "Run Claude in the Agents window, on your installed Claude Code and account. The Agents Window button in the title bar then opens it. Off until every tool there asks Klawly's permissions first. Takes effect after a restart."),
		},
		[CLAUDE_AGENT_DEFAULT_MODE_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			enum: ['agent', 'plan', 'ask'],
			enumDescriptions: [
				localize('claudeDefaultMode.agent', "Agent reads and edits files in the workspace. Edits ask first unless the permission preset is acceptEdits. Commands, web, MCP tools and writes outside the workspace ask."),
				localize('claudeDefaultMode.plan', "Plan reads, searches, uses the web and runs commands (commands ask), and writes only plan files. It ends with a plan you can build."),
				localize('claudeDefaultMode.ask', "Ask reads, searches, uses the web and runs commands (commands ask), and never changes a file."),
			],
			default: 'agent',
			description: localize('claudeDefaultModeSetting', "Mode a new agent session starts in. The mode pill changes it for one session."),
		},
		[CLAUDE_AGENT_NEW_CHATS_FIRST_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('claudeNewChatsFirstSetting', "Open a new chat tab at the front of the tab strip instead of the end. Drag a tab to put it anywhere."),
		},
		[CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			enum: ['strict', 'prompt', 'acceptEdits', 'auto', 'allowEverythingExceptCredentials', 'allowEverything'],
			enumDescriptions: [
				localize('claudePermissionMode.strict', "Ask before workspace edits, and refuse instead of asking for writes outside the workspace, destructive commands, and network access."),
				localize('claudePermissionMode.prompt', "Follow the Agent > Permissions settings: ask before workspace edits, commands with side effects, and network access."),
				localize('claudePermissionMode.acceptEdits', "Edit files inside a trusted workspace without asking. Everything else follows the Agent > Permissions settings."),
				localize('claudePermissionMode.auto', "Edit files inside a trusted workspace without asking, and let Claude Haiku approve other routine actions. Credentials, destructive commands and paths outside the workspace still ask."),
				localize('claudePermissionMode.allowEverythingExceptCredentials', "Run every tool call without asking, destructive commands and writes outside the workspace included. Klawly still checks each call, so anything that touches credentials asks and settings that refuse still refuse."),
				localize('claudePermissionMode.allowEverything', "In Agent mode, run Claude Code in its bypass permissions mode: every tool call runs without asking or checking, credentials and destructive commands included."),
			],
			default: 'strict',
			markdownDescription: localize('claudeDefaultPermissionMode', "Permission level for every agent session. `strict` (the default) asks before workspace edits and refuses risky commands and network access. `prompt` and `acceptEdits` are presets over the `#claude.agent.permissions.writeWorkspace#`, `#claude.agent.permissions.writeOutsideWorkspace#`, `#claude.agent.permissions.shellDestructive#` and `#claude.agent.permissions.network#` settings and never loosen what they refuse. `auto` edits like `acceptEdits` and asks Claude Haiku about each other request that would ask, following `#claude.agent.autoMode.allowInstructions#` and `#claude.agent.autoMode.blockInstructions#`; credentials, destructive commands and paths outside the workspace always ask, unless you turn on `#claude.agent.autoMode.reviewDeletions#` or `#claude.agent.autoMode.reviewOutsideWrites#`. The two Allow Everything levels approve what would ask; the first time you pick one, a warning explains it. `allowEverything` runs Claude Code in its bypass permissions mode in Agent mode, unless your organization's managed settings turn that mode off, in which case it asks before edits like `prompt`. Untrusted workspaces always ask, and Plan and Ask modes keep their own limits."),
		},
		[CLAUDE_AGENT_AUTO_ALLOW_INSTRUCTIONS_SETTING]: {
			type: 'array',
			items: { type: 'string' },
			scope: ConfigurationScope.APPLICATION,
			default: [],
			markdownDescription: localize('claudeAutoAllowInstructions', "Plain-language rules the `auto` permission level approves without asking, such as \"Running npm scripts\". Credentials, destructive commands and paths outside the workspace always ask."),
		},
		[CLAUDE_AGENT_AUTO_BLOCK_INSTRUCTIONS_SETTING]: {
			type: 'array',
			items: { type: 'string' },
			scope: ConfigurationScope.APPLICATION,
			default: [],
			markdownDescription: localize('claudeAutoBlockInstructions', "Plain-language rules the `auto` permission level never approves, such as \"Anything that changes the database\". Those requests always ask. They win over the allow instructions."),
		},
		[CLAUDE_AGENT_AUTO_REVIEW_DELETIONS_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			markdownDescription: localize('claudeAutoReviewDeletions', "Let the `auto` permission level approve plain file deletions inside the workspace, such as `rm build/output.txt`, when Claude Haiku judges them safe, instead of always asking. Warning: a wrong call deletes files you may not get back. Deletions that are chained, use wildcards, touch `.git`, or leave the workspace, and credentials, always ask."),
		},
		[CLAUDE_AGENT_AUTO_REVIEW_OUTSIDE_WRITES_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			markdownDescription: localize('claudeAutoReviewOutsideWrites', "Let the `auto` permission level approve file writes outside the workspace when Claude Haiku judges them safe, instead of always asking. Warning: a wrong call can overwrite files in your home folder or elsewhere on disk. Writes to `.git` and credential files always ask, and `#claude.agent.permissions.writeOutsideWorkspace#` set to deny still refuses."),
		},
		[CLAUDE_AGENT_AUTO_REVIEW_AGENT_BROWSER_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			markdownDescription: localize('claudeAutoReviewAgentBrowser', "Let the `auto` permission level open pages outside this machine in the Agent Browser when Claude Haiku judges them safe, instead of always asking. Warning: a wrong call lets Claude visit and read a site you did not intend. Pages on localhost never ask, and `#claude.agent.permissions.network#` set to deny still refuses."),
		},
		[CLAUDE_AGENT_ALLOW_EVERYTHING_CONFIRM_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeAllowEverythingConfirm', "Show a one-time warning the first time an Allow Everything permission level is picked. Confirming it turns this off. Until it is confirmed, an Allow Everything level asks before edits like `prompt`."),
		},
		[CLAUDE_AGENT_AUTO_APPROVE_READS_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			markdownDescription: localize('claudeAutoApproveReads', "Approve Read, Grep, Glob and LS inside the workspace and added folders without asking. When off, each read asks first. Shell commands that only read follow `#claude.agent.permissions.shellSafe#`. Reads outside the workspace and of credential files always ask."),
		},
		[CLAUDE_AGENT_AUTO_APPROVE_WRITES_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			markdownDescription: localize('claudeAutoApproveWrites', "Edit files inside a trusted workspace without asking. Same as setting `#claude.agent.permissions.writeWorkspace#` to `allow` or `#claude.agent.defaultPermissionMode#` to `acceptEdits`; any one of them turns it on. Writes outside the workspace, inside `.git`, or to credential files still ask."),
		},
		[CLAUDE_AGENT_SAVE_BEFORE_COMMANDS_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			enum: ['prompt', 'always', 'never'],
			default: 'prompt',
			enumDescriptions: [
				localize('claudeSaveBeforeCommands.prompt', "Ask before saving when files are unsaved."),
				localize('claudeSaveBeforeCommands.always', "Save unsaved files without asking."),
				localize('claudeSaveBeforeCommands.never', "Leave unsaved files alone. Commands see the files on disk."),
			],
			description: localize('claudeSaveBeforeCommands', "What to do with unsaved files before the agent runs a shell command. The command waits up to 15 seconds for a save, or 50 seconds for an answer, then runs against the files on disk. Untitled editors are never saved."),
		},
		[CLAUDE_WORKER_PROFILE_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.WINDOW,
			enum: [...CLAUDE_WORKER_PROFILES],
			enumDescriptions: [
				localize('claudeWorkerProfile.lean', "Workers start with the file and shell tools and the delegation tools only: no MCP servers, no slash commands, no skills. A smaller start, so a worker costs less."),
				localize('claudeWorkerProfile.full', "Workers start with everything the chat has, including MCP servers, plugins and skills. Use it for tasks that need the browser or an MCP server."),
			],
			default: CLAUDE_WORKER_PROFILE_DEFAULT,
			description: localize('claudeWorkerProfileSetting', "What a worker starts with when the agent delegates. The agent can pick Full for one worker that needs the browser or an MCP server."),
		},
		[CLAUDE_MERGE_WITHOUT_ASKING_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('claudeMergeWithoutAsking', "Let the agent's merge_gate tool squash-merge a pull request without asking, once the base branch's required checks are green. Off by default: each merge shows the usual tool permission prompt."),
		},
		[CLAUDE_AGENT_REPLY_STYLE_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			enum: ['default', 'adhd'],
			default: 'default',
			enumDescriptions: [
				localize('claudeReplyStyle.default', "Claude Code's own reply style."),
				localize('claudeReplyStyle.adhd', "ADHD mode: a TL;DR of one or two lines first, the answer or next action before the detail, short bullets, no filler, and long detail folded into collapsed sections."),
			],
			description: localize('claudeReplyStyle', "How Claude writes its replies in agent sessions. ADHD mode adds an instruction to Claude's system prompt. Applies to agent sessions started after the change."),
		},
		[CLAUDE_VERIFY_UI_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			enum: ['off', 'ask', 'always'],
			default: 'off',
			enumDescriptions: [
				localize('claudeVerifyUi.off', "Claude does not verify UI changes in the running app."),
				localize('claudeVerifyUi.ask', "Claude asks once after a UI change whether to verify it in the running app."),
				localize('claudeVerifyUi.always', "Claude verifies every UI change in the running app."),
			],
			description: localize('claudeVerifyUi', "After a UI change, Claude runs the app, drives the changed screen in the agent browser and attaches before and after screenshots, a short recording and console errors to its turn summary. Background agents start their own dev server on a free port. Applies to agent sessions started after the change."),
		},
		[CLAUDE_WORK_RULES_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeWorkRules', "Add Klawly's work rules to Claude's system prompt in agent sessions: autonomy by veto, a depth limit for helpers, acceptance criteria, tiered testing, a worktree per change, no git stash, and proof as a command with its result. Applies to agent sessions started after the change."),
		},
		[CLAUDE_REVIEW_OPEN_AFTER_EDIT_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.WINDOW,
			default: true,
			description: localize('claudeOpenAfterEdit', "After an agent turn edits files, open the review diff at its first change. Inline edits keep their own diff. Under Allow Everything the review stays in the agent pane until you open it."),
		},
		[CLAUDE_AUTO_ENABLED_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeAutoEnabled', "Replaces the Auto model, the Auto permission level and Auto-Keep"),
		},
		[CLAUDE_AUTO_REUSE_HELPERS_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeAutoReuseHelpers', "When Auto hands work to a helper, reuse an idle helper of the same tier that already finished, after compacting it, instead of starting a new one"),
		},
		[CLAUDE_REVIEW_AUTO_KEEP_SETTING]: {
			deprecationMessage: localize('claudeAutoKeepDeprecated', "Deprecated: use `claude.auto.enabled` instead."),
			type: 'string',
			scope: ConfigurationScope.WINDOW,
			enum: ['off', 'thisChat', 'always'],
			default: 'off',
			enumDescriptions: [
				localize('claudeAutoKeep.off', "Changes wait for you to keep or undo them."),
				localize('claudeAutoKeep.thisChat', "Changes are kept as they land in the chats where you turn on Auto-Keep from the mode menu."),
				localize('claudeAutoKeep.always', "Changes are kept as they land in every chat."),
			],
			markdownDescription: localize('claudeAutoKeep', "Keep an agent's changes as they land, so nothing waits for review. The changes card still lists them with Undo, and checkpoints stay. Auto-Accept is different: it lets Claude edit without asking first, and the edits still wait for review. Want both? Turn on Auto-Keep."),
		},
		// Issue 921: one severity scale, categories and a strictness for every review.
		[CLAUDE_REVIEW_MIN_SEVERITY_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.WINDOW,
			enum: [...CLAUDE_REVIEW_SEVERITIES],
			default: 'low',
			enumDescriptions: [
				localize('claudeMinSeverity.critical', "Show only critical findings."),
				localize('claudeMinSeverity.high', "Show high and critical findings."),
				localize('claudeMinSeverity.medium', "Show medium, high and critical findings."),
				localize('claudeMinSeverity.low', "Show every finding."),
			],
			markdownDescription: localize('claudeReviewMinSeverity', "The lowest severity a review shows. Findings below it are hidden, not deleted. Critical and security findings always show."),
		},
		[CLAUDE_REVIEW_POST_STATUS_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.WINDOW,
			default: false,
			markdownDescription: localize('claudeReviewPostStatus', "The review bot sets a `Klawly review` commit status (pending while it runs, then success, failure or error) and reacts to the pull request or the comment that asked for the review. It needs the repo:status permission; with gh signed out it posts nothing. It blocks nothing unless your branch protection requires it."),
		},
		// Issue 922: review rules by folder.
		[CLAUDE_REVIEW_CONFIG_FILE_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.WINDOW,
			default: CLAUDE_REVIEW_CONFIG_FILE_DEFAULT,
			markdownDescription: localize('claudeReviewConfigFile', "The file that holds review rules, found in the project root and in each folder of a changed file (the nearer folder wins). It can list `ignore` globs, `rules` with a `scope`, `disabledRules` and a `minSeverity`."),
		},
		// Issue 1068: how many dismissals of one finding it takes before Klawly offers a rule.
		[CLAUDE_REVIEW_LEARN_AFTER_SETTING]: {
			type: 'integer',
			minimum: 1,
			scope: ConfigurationScope.WINDOW,
			default: CLAUDE_REVIEW_LEARN_AFTER_DEFAULT,
			markdownDescription: localize('claudeReviewLearnAfter', "How many times you dismiss the same finding in a project before Klawly offers to stop flagging it. Security, memory, null and infinite-loop findings are never offered."),
		},
		[CLAUDE_REVIEW_CATEGORIES_SETTING]: {
			type: 'array',
			scope: ConfigurationScope.WINDOW,
			items: { type: 'string', enum: [...CLAUDE_REVIEW_CATEGORIES] },
			uniqueItems: true,
			default: [...CLAUDE_REVIEW_DEFAULT_CATEGORIES],
			markdownDescription: localize('claudeReviewCategories', "The kinds of finding a review reports: `security`, `bug`, `logic`, `performance`, `style` and `tests`. Security findings always show."),
		},
		[CLAUDE_REVIEW_STRICTNESS_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.WINDOW,
			enum: ['relaxed', 'balanced', 'strict'],
			default: 'balanced',
			enumDescriptions: [
				localize('claudeStrictness.relaxed', "Only problems Claude is sure about and that matter."),
				localize('claudeStrictness.balanced', "Real problems and clear risks."),
				localize('claudeStrictness.strict', "Also risks, edge cases and missing tests."),
			],
			markdownDescription: localize('claudeReviewStrictness', "How picky a review is. Security problems, memory leaks, null dereferences and infinite loops are reported at every level."),
		},
		[CLAUDE_REVIEW_DEPTH_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.WINDOW,
			enum: [...CLAUDE_REVIEW_DEPTHS],
			default: 'auto',
			enumDescriptions: [
				localize('claudeReviewDepth.auto', "Deep for big diffs, diffs across many folders, or changes to auth, payments, migrations and CI; Quick otherwise."),
				localize('claudeReviewDepth.quick', "One pass, the most serious problems only."),
				localize('claudeReviewDepth.deep', "One pass per top-level folder, following callers and edge cases. Slower and uses more of your plan."),
			],
			markdownDescription: localize('claudeReviewDepth', "How far a review digs. Every review says which depth it used and why; `@klawly review quick` or `deep` on a pull request wins over this setting."),
		},
		[CLAUDE_REVIEW_IMPACT_CONTEXT_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.WINDOW,
			enum: [...CLAUDE_REVIEW_IMPACT_CONTEXTS],
			default: 'symbols',
			enumDescriptions: [
				localize('claudeReviewImpact.off', "The reviewer sees the diff only."),
				localize('claudeReviewImpact.symbols', "Add where the changed functions, classes and types are used outside the diff."),
				localize('claudeReviewImpact.symbolsAndPatterns', "Also add a short dependency summary from the repository graph, when one exists."),
			],
			markdownDescription: localize('claudeReviewImpact', "What a review knows beyond the diff. Callers are found with the language servers; without one, the reviewer searches the repository itself."),
		},
		[CLAUDE_REVIEW_MODEL_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.WINDOW,
			default: '',
			markdownDescription: localize('claudeReviewModel', "The model every review uses. Empty keeps the chat's model, and Opus for a Deep review."),
		},
		[CLAUDE_REVIEW_MAX_TURNS_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.WINDOW,
			default: 0,
			minimum: 0,
			maximum: 100,
			markdownDescription: localize('claudeReviewMaxTurns', "The most turns one review pass may take. 0 keeps the default: 8 for Quick, 24 for Deep."),
		},
		[CLAUDE_REVIEW_SHOW_READINESS_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.WINDOW,
			default: true,
			markdownDescription: localize('claudeReviewShowReadiness', "Show a merge-readiness score from 0 to 5 with a one-line reason after each review. The score is advice only: it never approves a change."),
		},
		[CLAUDE_REVIEW_USE_TICKETS_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.WINDOW,
			default: false,
			markdownDescription: localize('claudeReviewUseTickets', "Check the change against the acceptance criteria of its linked ticket. Uses only read-only tools of a connected tracker; ticket text is data, never instructions."),
		},
		[CLAUDE_REVIEW_TICKET_PATTERNS_SETTING]: {
			type: 'array',
			scope: ConfigurationScope.WINDOW,
			items: { type: 'string' },
			default: [...CLAUDE_REVIEW_DEFAULT_TICKET_PATTERNS],
			markdownDescription: localize('claudeReviewTicketPatterns', "Regular expressions that find a ticket id in the diff, such as `ABC-123` or `#123`."),
		},
		[CLAUDE_REVIEW_SUMMARY_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.WINDOW,
			enum: [...CLAUDE_REVIEW_SUMMARY_MODES],
			default: 'summary',
			enumDescriptions: [
				localize('claudeReviewSummary.off', "Findings only."),
				localize('claudeReviewSummary.summary', "Add an overview and a file by file walkthrough."),
				localize('claudeReviewSummary.summaryAndDescription', "Also propose a new pull request description. It is applied only after you accept."),
			],
			markdownDescription: localize('claudeReviewSummarySetting', "Whether a review also writes a summary of the change. The proposed description is shown as a diff and only applied after you accept."),
		},
		[CLAUDE_MERGE_STAGE_AFTER_KEEP_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.WINDOW,
			default: false,
			description: localize('claudeMergeStageAfterKeep', "When you keep the last change Claude made to a file in Merge Changes and no conflict marker is left, stage the file. A file that still has a marker is never staged."),
		},
		[CLAUDE_PREVIEW_ENABLED_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('claudePreviewEnabled', "Turn on the browser preview commands for local dev servers."),
		},
		[KLAWLY_SYNC_ENABLED_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('klawlySyncEnabled', "Turns on Klawly Sync, which keeps your rules, settings, skills and other Klawly setup in step across your machines through a private GitHub repository. While it is off, Klawly signs in nowhere, sends nothing and reads no files for it."),
		},
		[KLAWLY_SYNC_MEMORY_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('klawlySyncMemoryEnabled', "Also keeps the memory Claude saves for a project in step across your machines through the same private GitHub repository, matched by the project's git remote. Needs Klawly Sync to be on. Secrets in memory are replaced by placeholders before anything leaves this machine. Off by default."),
		},
		[KLAWLY_SYNC_HISTORY_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('klawlySyncHistoryEnabled', "Also keeps a compact copy of your recent session transcripts (your messages and Claude's replies, not tool output) in step across your machines through the same private GitHub repository, matched by the project's git remote. Needs Klawly Sync to be on. Nothing is sent until you approve a preview with Preview Session History Sync. A session that holds a secret is never sent. Off by default."),
		},
		[KLAWLY_SYNC_HISTORY_KEEP_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.APPLICATION,
			default: 20,
			minimum: 1,
			description: localize('klawlySyncHistoryKeep', "How many of the newest sessions of each project the history sync keeps. Older ones are removed from the sync."),
		},
		[KLAWLY_SYNC_HISTORY_MAX_KB_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.APPLICATION,
			default: 256,
			minimum: 1,
			description: localize('klawlySyncHistoryMaxKb', "The most kilobytes of transcript the history sync keeps for each project. Newest sessions are kept first."),
		},
		[KLAWLY_SYNC_HISTORY_EXCLUDED_SETTING]: {
			type: 'array',
			items: { type: 'string' },
			scope: ConfigurationScope.APPLICATION,
			default: [],
			description: localize('klawlySyncHistoryExcluded', "Projects whose history is never synced, by git remote (for example github.com/owner/repo) or folder path. Adding one also removes its synced copy on the next sync."),
		},
		[CLAUDE_TELEMETRY_ENABLED_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('claudeTelemetryEnabled', "Klawly sends no telemetry about its Claude features, and this setting does not change that. While it is off, Klawly also starts Claude Code with telemetry, error reporting and other nonessential traffic turned off. When it is on, Claude Code's own reporting follows your Claude Code settings."),
		},
		[CLAUDE_SECURITY_SCAN_ATTACHMENTS_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeScanAttachments', "Before sending, look for credentials such as API keys, tokens, private keys and passwords in attached files, selections, pastes, terminal output and diffs. When one is found, choose Send Anyway, Remove Secrets or Cancel. Detection is a best effort and can miss a secret."),
		},
		[CLAUDE_MODELS_ENABLED_SETTING]: {
			type: 'array',
			items: { type: 'string' },
			scope: ConfigurationScope.APPLICATION,
			default: [],
			markdownDescription: localize('claudeModelsEnabled', "Model IDs shown in Pick Model and Cycle Model. Empty shows every model Claude reports. A model left out still works when set explicitly. [Manage Models]({0}) lists the models Claude reports with a switch for each.", `command:${CLAUDE_MANAGE_MODELS_COMMAND_ID}`),
		},
		[CLAUDE_MODELS_DEFAULT_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			default: '',
			markdownDescription: localize('claudeModelsDefault', "Model a new agent session starts with. Empty starts on the model you last picked, or on the model the Claude runtime default resolves to. If Claude rejects a picked model, the turn falls back to this one. Set it from [Manage Models]({0}).", `command:${CLAUDE_MANAGE_MODELS_COMMAND_ID}`),
		},
		[CLAUDE_MODELS_CUSTOM_SETTING]: {
			type: 'array',
			items: { type: 'string' },
			scope: ConfigurationScope.APPLICATION,
			default: [],
			markdownDescription: localize('claudeModelsCustom', "Extra model IDs that Claude did not report, such as a full model name. They are always shown in the picker. Add them from [Manage Models]({0}).", `command:${CLAUDE_MANAGE_MODELS_COMMAND_ID}`),
		},
		[CLAUDE_MODELS_EFFORT_SETTING]: {
			type: 'object',
			additionalProperties: { type: 'string', enum: [...CLAUDE_CONFIGURABLE_EFFORT_LEVELS] },
			scope: ConfigurationScope.APPLICATION,
			default: {},
			markdownDescription: localize('claudeModelsEffort', "Effort a new agent session starts with, per model ID, such as `{ \"opus\": \"high\" }`. Use `default` for the model Claude picks itself. A model left out starts at the effort last picked in the model menu, else Medium, and a level the model does not take falls to the nearest lower one. Max is chosen per session from the model menu."),
		},
		[CLAUDE_MODELS_FAST_MODE_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('claudeModelsFastMode', "Start new agent sessions in fast mode on a model that has it. Fast mode answers sooner and costs more."),
		},
		[CLAUDE_MODELS_ULTRACODE_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('claudeModelsUltracode', "Start new agent sessions with Ultracode on a model that has extra high effort. Ultracode runs at extra high effort and lets Claude orchestrate multi-step workflows on its own."),
		},
		[CLAUDE_MODELS_AUTO_SETTING]: {
			deprecationMessage: localize('claudeModelsAutoDeprecated', "Deprecated: use `claude.auto.enabled` instead."),
			type: 'string',
			enum: ['off', 'auto', 'cost', 'balance', 'intelligence'],
			enumDescriptions: [
				localize('claudeModelsAutoOff', "New agent sessions run on the model you pick."),
				localize('claudeModelsAutoOn', "Run each message on the current Opus at an effort that fits how hard it is."),
				localize('claudeModelsAutoCost', "Old value: reads as `auto`."),
				localize('claudeModelsAutoBalance', "Old value: reads as `auto`."),
				localize('claudeModelsAutoIntelligence', "Old value: reads as `auto`."),
			],
			scope: ConfigurationScope.APPLICATION,
			default: 'off',
			description: localize('claudeModelsAuto', "Start new agent sessions with Auto model: before each message, Claude Code's fastest model rates how hard it is, and Klawly runs it on the current Opus at an effort that fits. Picking a model in the composer turns Auto off for that session."),
		},
		[CLAUDE_AUTO_CONTEXT_CAP_TOKENS_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.APPLICATION,
			default: CLAUDE_AUTO_CONTEXT_CAP_TOKENS_DEFAULT,
			minimum: CLAUDE_AUTO_CONTEXT_CAP_TOKENS_MIN,
			maximum: CLAUDE_AUTO_CONTEXT_CAP_TOKENS_MAX,
			description: localize('claudeAutoContextCap', "In Auto mode, the most context tokens one chat or helper holds. At 80% the composer says the context is getting large; at the cap Auto compacts the chat and carries on with the summary. Scaled down when the model's window is smaller."),
		},
		[CLAUDE_AUTO_COST_NOTIFY_USD_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.APPLICATION,
			default: CLAUDE_AUTO_COST_NOTIFY_USD_DEFAULT,
			minimum: CLAUDE_AUTO_COST_USD_MIN,
			maximum: CLAUDE_AUTO_COST_USD_MAX,
			description: localize('claudeAutoCostNotify', "In Auto mode, the cost in US dollars of one chat and its helpers where you get a notice. Auto carries on."),
		},
		[CLAUDE_AUTO_COST_STOP_USD_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.APPLICATION,
			default: CLAUDE_AUTO_COST_STOP_USD_DEFAULT,
			minimum: CLAUDE_AUTO_COST_USD_MIN,
			maximum: CLAUDE_AUTO_COST_USD_MAX,
			description: localize('claudeAutoCostStop', "In Auto mode, the cost in US dollars of one chat and its helpers where Auto stops them all and waits for you. Raise Limit adds this amount again for that chat."),
		},
		[CLAUDE_AUTO_REVIEW_MAX_ROUNDS_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.APPLICATION,
			default: CLAUDE_AUTO_REVIEW_MAX_ROUNDS_DEFAULT,
			minimum: CLAUDE_AUTO_REVIEW_MAX_ROUNDS_MIN,
			maximum: CLAUDE_AUTO_REVIEW_MAX_ROUNDS_MAX,
			description: localize('claudeAutoReviewMaxRounds', "In Auto mode, how many times the strong model reviews a helper's result. After the last round, changes that are still needed go to you as a list of open points."),
		},
		[CLAUDE_MODELS_WARN_ON_SWITCH_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeModelsWarnOnSwitch', "Show a notice when you pick another model in a chat that already has messages. Claude Code caches the conversation per model, so the new model reads the whole chat again without the cache, which uses more of your usage."),
		},
		[CLAUDE_INLINE_EDIT_MODEL_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			default: '',
			description: localize('claudeInlineEditModel', "Model for inline edits. Empty uses the agent session's model. The session goes back to its own model on the next turn."),
		},
		[CLAUDE_SUBAGENTS_BUILT_IN_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeSubagentsBuiltIn', "Offer Klawly's own subagents (a read-only reviewer, an explorer, and the Klawly guide that Ask About Klawly uses) to Claude. Your own agents with the same name always win. Applies to agent sessions started after the change."),
		},
		[CLAUDE_USE_CLAUDE_CODE_SETUP_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeUseClaudeCodeSetup', "Also use your Claude Code setup in ~/.claude: its CLAUDE.md, settings, skills, subagents, commands and MCP servers. Klawly only reads it and never changes it; your Klawly setup is in ~/.klawly/claude. Applies to agent sessions started after the change."),
		},
		[CLAUDE_INSTRUCTIONS_AGENTS_MD_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeInstructionsAgentsMd', "Pass the workspace's AGENTS.md to Claude when no CLAUDE.md imports it with `@AGENTS.md`, and list the AGENTS.md files in subfolders for Claude to read where it works. Only in a trusted workspace. Applies to agent sessions started after the change."),
		},
		[CLAUDE_INSTRUCTIONS_AGENTS_SKILLS_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeInstructionsAgentsSkills', "Load the skills in the workspace's .agents/skills folder as Claude Code skills, named agents:<skill>. Nothing is copied into .claude. Only in a trusted workspace. Applies to agent sessions started after the change."),
		},
		[CLAUDE_PLUGINS_BUILT_IN_MARKETPLACES_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudePluginsBuiltInMarketplaces', "Also list plugins from Klawly's built-in marketplace list (Anthropic's official Claude Code plugin directory) in Customize > Discover, even before you add it to Claude Code. Marketplaces you added to Claude Code are always listed."),
		},
		[CLAUDE_SUBAGENTS_OPEN_ON_START_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.WINDOW,
			default: false,
			description: localize('claudeSubagentsOpenOnStart', "Open the subagent chat as soon as Claude starts a subagent in the current session."),
		},
		[CLAUDE_DELEGATION_ENABLED_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.WINDOW,
			default: true,
			description: localize('claudeDelegationEnabled', "Let Claude hand work to separate worker chats with the delegate tool, and keep every worker run in one list. Applies to agent sessions started after the change."),
		},
		[CLAUDE_DELEGATION_TIER_MODEL_SETTINGS.small]: {
			type: 'string',
			scope: ConfigurationScope.WINDOW,
			default: CLAUDE_DELEGATION_TIER_MODEL_DEFAULTS.small,
			description: localize('claudeDelegationTierSmall', "The model a small-tier worker runs on: lookups and mechanical runs. A model alias such as haiku, or a full model id."),
		},
		[CLAUDE_DELEGATION_TIER_MODEL_SETTINGS.medium]: {
			type: 'string',
			scope: ConfigurationScope.WINDOW,
			default: CLAUDE_DELEGATION_TIER_MODEL_DEFAULTS.medium,
			description: localize('claudeDelegationTierMedium', "The model a medium-tier worker runs on: building from a brief. A model alias such as sonnet, or a full model id."),
		},
		[CLAUDE_DELEGATION_TIER_MODEL_SETTINGS.large]: {
			type: 'string',
			scope: ConfigurationScope.WINDOW,
			default: CLAUDE_DELEGATION_TIER_MODEL_DEFAULTS.large,
			description: localize('claudeDelegationTierLarge', "The model a large-tier worker runs on, given only with a stated reason. Empty uses the chat's own model."),
		},
		[CLAUDE_DELEGATE_CODING_CAP_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.WINDOW,
			minimum: 1,
			maximum: CLAUDE_DELEGATE_CODING_CAP_MAX,
			default: CLAUDE_DELEGATE_CODING_CAP_DEFAULT,
			description: localize('claudeDelegationCodingCap', "Most helpers working in one repository at once. More wait in a queue, in order. A helper whose files overlap with a running helper's also waits."),
		},
		[CLAUDE_DELEGATE_HELPER_WORKTREES_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.WINDOW,
			default: true,
			description: localize('claudeDelegationHelperWorktrees', "A helper that owns files works in its own Git worktree, so helpers never edit the same folder. The worktree is removed when the helper ends with no changes."),
		},
		[CLAUDE_DELEGATE_DEPTH_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.WINDOW,
			minimum: 1,
			maximum: CLAUDE_DELEGATE_DEPTH_HARD_MAX,
			default: CLAUDE_DELEGATE_DEPTH_DEFAULT,
			description: localize('claudeDelegationMaxDepth', "How many levels helpers nest: manager, coordinator, helper is 2. A delegation that states a reason may go up to 4."),
		},
		[CLAUDE_DELEGATION_WORKER_FAILED_CALLS_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.WINDOW,
			minimum: 0,
			default: CLAUDE_DELEGATION_LADDER_DEFAULTS.workerFailedCalls,
			description: localize('claudeDelegationLadderWorkerFailedCalls', "Failed calls in a row that move a delegated worker up one tier: small to medium, then medium to large. 0 turns it off."),
		},
		[CLAUDE_DELEGATION_SESSION_FAILED_CALLS_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.WINDOW,
			minimum: 0,
			default: CLAUDE_DELEGATION_LADDER_DEFAULTS.sessionFailedCalls,
			description: localize('claudeDelegationLadderSessionFailedCalls', "Failed calls in a row after which a cheap turn on Auto goes back to the chat's own model. 0 turns it off."),
		},
		[CLAUDE_DELEGATION_SESSION_STEPS_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.WINDOW,
			minimum: 0,
			default: CLAUDE_DELEGATION_LADDER_DEFAULTS.sessionSteps,
			description: localize('claudeDelegationLadderSessionSteps', "Steps (tool calls) after which a cheap turn on Auto goes back to the chat's own model. 0 turns it off."),
		},
		[CLAUDE_DELEGATION_COST_WATCHER_ENABLED_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.WINDOW,
			default: true,
			description: localize('claudeDelegationCostWatcherEnabled', "Remind a chat on an expensive model to hand mechanical runs to a worker. The dearer each tool call, the sooner it reminds. Never on Haiku chats."),
		},
		[CLAUDE_DELEGATION_COST_WATCHER_CADENCE_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.WINDOW,
			minimum: 1,
			default: CLAUDE_COST_WATCHER_DEFAULT_CADENCE,
			description: localize('claudeDelegationCostWatcherCadence', "Tool calls between reminders when a call costs about $0.05. Dearer calls remind sooner, never more often than every 3 calls."),
		},
		[CLAUDE_DELEGATION_COST_WATCHER_REFUSE_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.WINDOW,
			default: false,
			description: localize('claudeDelegationCostWatcherRefuse', "After 3 ignored reminders, refuse the chat's tool calls until it delegates or gives a reason a cheap model accepts."),
		},
		[CLAUDE_PERMISSION_SETTINGS.writeWorkspace]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			enum: ['ask', 'allow'],
			default: 'ask',
			markdownDescription: localize('claudePermWriteWorkspace', "Whether Claude must ask before it writes a file inside a trusted workspace. `allow`, `#claude.agent.autoApproveWorkspaceWrites#` or the `acceptEdits` value of `#claude.agent.defaultPermissionMode#` each allow it. By default none of them is set, so edits ask. Writes in an untrusted workspace, outside the workspace, or to credential files always ask."),
		},
		[CLAUDE_PERMISSION_SETTINGS.writeOutsideWorkspace]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			enum: ['ask', 'deny'],
			default: 'ask',
			description: localize('claudePermWriteOutside', "What happens when Claude writes a file outside the workspace folders."),
		},
		[CLAUDE_PERMISSION_SETTINGS.shellSafe]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			enum: ['allow', 'ask'],
			default: 'allow',
			description: localize('claudePermShellSafe', "Whether Claude must ask before it runs a read-only command that only touches the workspace, such as git status. Commands that touch credentials always ask."),
		},
		[CLAUDE_PERMISSION_SETTINGS.shellDestructive]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			enum: ['ask', 'deny'],
			default: 'ask',
			description: localize('claudePermShellDestructive', "What happens when Claude runs a command that can delete data or rewrite history. Ask offers Allow once only."),
		},
		[CLAUDE_PERMISSION_SETTINGS.network]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			enum: ['ask', 'allow', 'deny'],
			default: 'ask',
			description: localize('claudePermNetwork', "What happens when Claude fetches from the web or runs a command that uses the network."),
		},
		[CLAUDE_CHECKPOINTS_ENABLED_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeCheckpointsEnabled', "Record a checkpoint at the start of each agent turn so those edits can be restored."),
		},
		[CLAUDE_ACCOUNTS_DEFAULT_ACCOUNT_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			default: '',
			description: localize('claudeAccountsDefaultAccount', "The account new chats start on, by account id. Empty uses the account active in Switch Account. A chat can pick another account in its composer."),
		},
		[CLAUDE_ACCOUNTS_ON_LIMIT_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			enum: ['ask', 'extraUsage', 'apiKey', 'otherAccount'],
			default: 'ask',
			description: localize('claudeAccountsOnLimit', "What a chat does when its account reaches a plan limit. A chat can override this, and an account only allows what its limit options permit."),
		},
		[CLAUDE_ACCOUNTS_LIMIT_OPTIONS_SETTING]: {
			type: 'object',
			scope: ConfigurationScope.APPLICATION,
			default: {},
			description: localize('claudeAccountsLimitOptions', "Per account limit options, by account id: allowExtraUsage, extraUsageCapUsd, allowApiFallback and kind (personal or work)."),
		},
		[CLAUDE_CHAT_REFERENCE_SUMMARY_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.APPLICATION,
			default: CLAUDE_CHAT_REFERENCE_SUMMARY_DEFAULT,
			minimum: 200,
			description: localize('claudeChatReferenceSummary', "Maximum characters of a chat reference summary. The redacted transcript file is unchanged."),
		},
		[CLAUDE_GOAL_MAX_TURNS_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.APPLICATION,
			default: CLAUDE_GOAL_MAX_TURNS_DEFAULT,
			minimum: 1,
			description: localize('claudeGoalMaxTurns', "Most turns a `/goal` sends before it stops and asks you, the first turn included."),
		},
		[CLAUDE_GOAL_MAX_BUDGET_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.APPLICATION,
			default: CLAUDE_GOAL_MAX_BUDGET_DEFAULT,
			minimum: 0,
			description: localize('claudeGoalMaxBudget', "Most a `/goal` may spend, in US dollars as Claude Code reports it, before it stops and asks you. 0 means no spend limit; the turn limit still applies."),
		},
		[CLAUDE_DEBUG_RETAIN_RAW_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('claudeRetainRaw', "Keep raw SDK messages for the session inspector. Leave this off unless you are debugging Claude."),
		},
		[CLAUDE_DEBUG_TERMINAL_LINES_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeDebugTerminalLines', "Send terminal output to Claude when you reproduce a bug in Debug mode. Turn this off if your terminals can show secrets; debug adapter and preview console lines are still sent."),
		},
		[CLAUDE_CHECKPOINT_RETENTION_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.APPLICATION,
			default: 30,
			minimum: 0,
			description: localize('claudeCheckpointRetention', "Days to keep checkpoint files. After that, unreferenced checkpoint objects are deleted. Zero deletes them on the next agent turn."),
		},
		[CLAUDE_AUTOCOMPLETE_ENABLED_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeAutocompleteEnabled', "Offer Claude Tab suggestions in the editor. When off, no suggestion is requested or applied."),
		},
		[CLAUDE_AUTOCOMPLETE_MODEL_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			default: '',
			description: localize('claudeAutocompleteModel', "Model for Tab completions. Leave empty to use the Claude runtime default. Completions use one turn and no tools."),
		},
		[CLAUDE_AUTOCOMPLETE_DEBOUNCE_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.APPLICATION,
			default: CLAUDE_AUTOCOMPLETE_DEBOUNCE_DEFAULT_MS,
			minimum: CLAUDE_AUTOCOMPLETE_DEBOUNCE_MIN_MS,
			maximum: CLAUDE_AUTOCOMPLETE_DEBOUNCE_MAX_MS,
			description: localize('claudeAutocompleteDebounce', "Milliseconds to wait after typing before asking for a Tab suggestion."),
		},
		[CLAUDE_DIAGNOSTICS_AUTO_VERIFY_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('claudeDiagnosticsAutoVerify', "After a turn that edits files, automatically ask Claude to fix new errors in those files. Off by default."),
		},
		[CLAUDE_DIAGNOSTICS_MAX_CYCLES_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.APPLICATION,
			default: CLAUDE_DIAGNOSTICS_DEFAULT_CYCLES,
			minimum: 1,
			maximum: CLAUDE_DIAGNOSTICS_HARD_CAP,
			description: localize('claudeDiagnosticsMaxCycles', "How many automatic fix turns may follow one request. Never more than {0}.", CLAUDE_DIAGNOSTICS_HARD_CAP),
		},
		[CLAUDE_DIAGNOSTICS_SETTLE_MS_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.APPLICATION,
			default: CLAUDE_DIAGNOSTICS_SETTLE_DEFAULT_MS,
			minimum: CLAUDE_DIAGNOSTICS_SETTLE_MIN_MS,
			maximum: CLAUDE_DIAGNOSTICS_SETTLE_MAX_MS,
			description: localize('claudeDiagnosticsSettle', "Milliseconds to wait after problems stop changing before collecting new errors from a turn."),
		},
		[CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeKeybindingsKlawlyKeys', "Klawly Keys: Ctrl/Cmd+K Inline Edit, Ctrl/Cmd+L Focus Agent (or Add Selection to Agent when text is selected), Ctrl/Cmd+I Focus Agent, Ctrl/Cmd+/ Cycle Model in the Agent view, Ctrl/Cmd+Shift+Backspace Stop Agent, Ctrl/Cmd+Shift+J Open Klawly Settings. While on, Ctrl/Cmd+K no longer starts Klawly chords in the editor, and Ctrl/Cmd+L and Ctrl/Cmd+I replace Expand Line Selection and Trigger Suggest. The keys with Alt keep working. Turn this off to get those Klawly keys back."),
		},
		[CLAUDE_INLINE_REJECT_ON_ESCAPE_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('claudeInlineRejectOnEscape', "Press Escape to reject an inline edit that has not been accepted."),
		},
		[CLAUDE_SELECTION_TOOLBAR_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeSelectionToolbar', "Show Add to Agent and Edit above text you select in an editor, and Add to Agent over text you select in a terminal."),
		},
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: RUN_TEST_AGENT_SESSION_COMMAND_ID,
			title: localize2('runTestAgentSession', "Run Test Agent Session"),
			category: KLAWLY_CATEGORY,
			f1: true,
			precondition: CLAUDE_AGENT_ENABLED,
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return runKlawlyTestAgentSession(accessor);
	}
});
