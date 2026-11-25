/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';

/** Command palette category for every Klawly command. */
export const KLAWLY_CATEGORY = localize2('klawly', "Klawly");

export const CLAUDE_VIEW_CONTAINER_ID = 'workbench.view.claude';
export const CLAUDE_AGENT_VIEW_ID = 'claude.agentView';
/** The Agent view's first title item, which renders the chat's header row (#106). */
export const CLAUDE_AGENT_HEADER_ACTION_ID = 'claude.agentView.header';

export const CLAUDE_NEW_SESSION_COMMAND_ID = 'claude.newSession';
export const CLAUDE_PICK_MODEL_COMMAND_ID = 'claude.pickModel';
export const CLAUDE_PICK_MODE_COMMAND_ID = 'claude.pickMode';
export const CLAUDE_ADD_SELECTION_COMMAND_ID = 'claude.addSelection';
export const CLAUDE_ADD_SELECTION_TO_NEW_AGENT_COMMAND_ID = 'claude.addSelectionToNewAgent';
/** Terminal selection, else the last command and its output, as a chip (issue 734). */
export const CLAUDE_ADD_TERMINAL_COMMAND_ID = 'claude.addTerminalToAgent';
export const CLAUDE_EXPLAIN_SELECTION_COMMAND_ID = 'claude.explainSelection';
export const CLAUDE_REVIEW_CHANGES_COMMAND_ID = 'claude.reviewChanges';
/** Writes .claude/review-knowledge.md, the repo notes the reviewer reads (issue 933). */
export const CLAUDE_GENERATE_REVIEW_KNOWLEDGE_COMMAND_ID = 'claude.review.generateKnowledge';
export const CLAUDE_GENERATE_COMMIT_MESSAGE_COMMAND_ID = 'claude.generateCommitMessage';
export const CLAUDE_EXPLAIN_DIFF_COMMAND_ID = 'claude.explainDiff';
export const CLAUDE_EXPLAIN_COMMIT_COMMAND_ID = 'claude.explainCommit';
export const CLAUDE_COMMIT_ACCEPTED_COMMAND_ID = 'claude.commitAcceptedChanges';
export const CLAUDE_SPLIT_PULL_REQUESTS_COMMAND_ID = 'claude.splitIntoPullRequests';
export const CLAUDE_OPEN_REVIEW_EDITOR_COMMAND_ID = 'klawly.review.openEditor';
export const CLAUDE_FIX_PROBLEMS_COMMAND_ID = 'claude.fixProblems';

// spec 45 commands added in Phase 22.
export const CLAUDE_FOCUS_AGENT_COMMAND_ID = 'claude.focusAgent';
export const CLAUDE_OPEN_SESSION_HISTORY_COMMAND_ID = 'claude.openSessionHistory';
export const CLAUDE_ADD_FILE_COMMAND_ID = 'claude.addFile';
export const CLAUDE_ADD_FILE_TO_NEW_AGENT_COMMAND_ID = 'claude.addFileToNewAgent';
export const CLAUDE_ACCEPT_ALL_CHANGES_COMMAND_ID = 'claude.acceptAllChanges';
export const CLAUDE_REJECT_ALL_CHANGES_COMMAND_ID = 'claude.rejectAllChanges';
export const CLAUDE_RESTORE_CHECKPOINT_COMMAND_ID = 'claude.restoreCheckpoint';
export const CLAUDE_STOP_AGENT_COMMAND_ID = 'claude.stopAgent';
export const CLAUDE_QUEUE_MESSAGE_COMMAND_ID = 'claude.queueMessage';
export const CLAUDE_START_GOAL_COMMAND_ID = 'claude.startGoal';
export const CLAUDE_START_LOOP_COMMAND_ID = 'claude.startLoop';
export const CLAUDE_EDIT_MESSAGE_COMMAND_ID = 'claude.editMessage';
export const CLAUDE_CREATE_SKILL_COMMAND_ID = 'claude.createSkill';
export const CLAUDE_REMOVE_INSTRUMENTATION_COMMAND_ID = 'claude.removeInstrumentation';
export const CLAUDE_CYCLE_MODEL_COMMAND_ID = 'claude.cycleModel';
export const CLAUDE_SHOW_SENT_PROMPT_COMMAND_ID = 'claude.showSentPrompt';
export const CLAUDE_ASK_SIDE_QUESTION_COMMAND_ID = 'claude.askSideQuestion';
export const CLAUDE_GO_TO_TURN_COMMAND_ID = 'claude.goToTurn';
export const CLAUDE_FIND_IN_CHAT_COMMAND_ID = 'claude.findInChat';
export const CLAUDE_FIND_IN_CHAT_LIST_COMMAND_ID = 'claude.findInChatAsList';
export const CLAUDE_OPEN_INSPECTOR_COMMAND_ID = 'claude.openSessionInspector';
export const CLAUDE_OPEN_SUBAGENT_COMMAND_ID = 'claude.openSubagentChat';
export const CLAUDE_STOP_SUBAGENT_COMMAND_ID = 'claude.stopSubagent';
export const CLAUDE_REFERENCE_CHAT_COMMAND_ID = 'claude.referenceChat';
export const CLAUDE_OPEN_BACKGROUND_AGENTS_COMMAND_ID = 'claude.openBackgroundAgents';
export const CLAUDE_TOGGLE_AUTOCOMPLETE_COMMAND_ID = 'claude.toggleAutocomplete';
export const CLAUDE_MANAGE_MODELS_COMMAND_ID = 'claude.manageModels';
export const CLAUDE_OPEN_SETTINGS_COMMAND_ID = 'claude.openSettings';
export const CLAUDE_CHANGE_PERMISSION_LEVEL_COMMAND_ID = 'claude.changePermissionLevel';
export const CLAUDE_SHOW_PLAN_USAGE_COMMAND_ID = 'claude.showPlanUsage';
export const CLAUDE_OPEN_CUSTOMIZE_COMMAND_ID = 'claude.openCustomize';
export const CLAUDE_IMPORT_FROM_CLAUDE_CODE_COMMAND_ID = 'claude.importFromClaudeCode';

// Where the chat lives: the Agent view, an editor tab, or a window of its own (ide-03).
export const CLAUDE_OPEN_CHAT_IN_EDITOR_COMMAND_ID = 'claude.openChatInEditor';
export const CLAUDE_OPEN_CHAT_IN_WINDOW_COMMAND_ID = 'claude.openChatInWindow';
/** Opens the Agents window: VS Code's Agents window when `claude.agentsWindow.enabled` is on, else the chat in its own window (issue 617, DL-27). */
export const CLAUDE_OPEN_AGENTS_WINDOW_COMMAND_ID = 'claude.openAgentsWindow';
/** Agents window only: shows this session in the IDE window's Agent pane (#1509). */
export const CLAUDE_OPEN_IN_AGENT_PANE_COMMAND_ID = 'claude.openInAgentPane';
export const CLAUDE_MOVE_CHAT_TO_SIDE_BAR_COMMAND_ID = 'claude.moveChatToSideBar';

// Onboarding and status (spec 6, 47, 72), Phase 22.
export const CLAUDE_SHOW_STATUS_COMMAND_ID = 'claude.showStatus';
export const CLAUDE_REDETECT_RUNTIME_COMMAND_ID = 'claude.redetectRuntime';
export const CLAUDE_SIGN_IN_COMMAND_ID = 'claude.signIn';
export const CLAUDE_LOG_OUT_COMMAND_ID = 'claude.logOut';
export const CLAUDE_SWITCH_ACCOUNT_COMMAND_ID = 'claude.switchAccount';
export const CLAUDE_INSTALL_RUNTIME_COMMAND_ID = 'claude.installRuntime';
export const CLAUDE_CHOOSE_RUNTIME_COMMAND_ID = 'claude.chooseRuntime';
export const CLAUDE_ENABLE_AGENT_COMMAND_ID = 'claude.enableAgent';
/** Registered by the inline edit controller. The onboarding hint shows its key. */
export const CLAUDE_INLINE_EDIT_COMMAND_ID = 'klawly.inlineEdit.start';
