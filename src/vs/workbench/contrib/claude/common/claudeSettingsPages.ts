/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_DELEGATE_HELPER_WORKTREES_SETTING, CLAUDE_DELEGATE_CODING_CAP_MAX, CLAUDE_DELEGATE_CODING_CAP_SETTING, CLAUDE_DELEGATE_DEPTH_HARD_MAX, CLAUDE_DELEGATE_DEPTH_SETTING } from '../../../../platform/claude/common/claudeDelegateScheduler.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { CLAUDE_INJECTED_INSTRUCTIONS } from '../../../../platform/claude/common/claudeInjectedInstructions.js';
import { CLAUDE_AGENT_REPLY_STYLE_SETTING } from '../../../../platform/claude/common/claudeReplyStyle.js';
import { CLAUDE_WORK_RULES_SETTING } from '../../../../platform/claude/common/claudeWorkRules.js';
import { CLAUDE_VERIFY_UI_SETTING } from '../../../../platform/claude/common/claudeVerifyUi.js';
import { CLAUDE_DELEGATION_SESSION_FAILED_CALLS_SETTING, CLAUDE_DELEGATION_SESSION_STEPS_SETTING, CLAUDE_DELEGATION_WORKER_FAILED_CALLS_SETTING } from '../../../../platform/claude/common/claudeDelegateLadder.js';
import { CLAUDE_DELEGATION_COST_WATCHER_CADENCE_SETTING, CLAUDE_DELEGATION_COST_WATCHER_ENABLED_SETTING, CLAUDE_DELEGATION_COST_WATCHER_REFUSE_SETTING } from '../../../../platform/claude/common/claudeDelegateCostWatcher.js';
import { CLAUDE_WORKERS_FINISHED_MINUTES_SETTING, CLAUDE_WORKERS_HUNG_MINUTES_SETTING } from '../../../../platform/claude/common/claudeWorkersViewSettings.js';
import { CLAUDE_DELEGATION_TIER_MODEL_SETTINGS } from '../../../../platform/claude/common/claudeDelegateTier.js';
import { CLAUDE_ACCOUNTS_DEFAULT_ACCOUNT_SETTING } from '../../../../platform/claude/common/claudeChatAccount.js';
import { CLAUDE_ACCOUNTS_ON_LIMIT_SETTING } from '../../../../platform/claude/common/claudeLimitPolicy.js';
import { CLAUDE_AUTO_ENABLED_SETTING, CLAUDE_AUTO_REUSE_HELPERS_SETTING, CLAUDE_MERGE_STAGE_AFTER_KEEP_SETTING, CLAUDE_MERGE_WITHOUT_ASKING_SETTING, CLAUDE_ACTIONS_PREFER_COMMANDS_SETTING, CLAUDE_AGENT_AUTO_APPROVE_READS_SETTING, CLAUDE_AGENT_DEFAULT_MODE_SETTING, CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, CLAUDE_AGENT_ENABLED_SETTING, CLAUDE_AGENT_NEW_CHATS_FIRST_SETTING, CLAUDE_AGENT_RUNTIME_PATH_SETTING, CLAUDE_AGENT_RUNTIME_SETTING, CLAUDE_AGENT_SAVE_BEFORE_COMMANDS_SETTING, CLAUDE_AUTOCOMPLETE_DEBOUNCE_MAX_MS, CLAUDE_AUTOCOMPLETE_DEBOUNCE_MIN_MS, CLAUDE_AUTOCOMPLETE_DEBOUNCE_SETTING, CLAUDE_AUTOCOMPLETE_ENABLED_SETTING, CLAUDE_AUTOCOMPLETE_MODEL_SETTING, CLAUDE_CHAT_REFERENCE_SUMMARY_SETTING, CLAUDE_CHECKPOINTS_ENABLED_SETTING, CLAUDE_CHECKPOINT_RETENTION_SETTING, CLAUDE_COMPOSER_PASTE_AS_REFERENCE_SETTING, CLAUDE_COMPOSER_WHILE_WORKING_SETTING, CLAUDE_DEBUG_RETAIN_RAW_SETTING, CLAUDE_DEBUG_TERMINAL_LINES_SETTING, CLAUDE_DELEGATION_ENABLED_SETTING, CLAUDE_DIAGNOSTICS_AUTO_VERIFY_SETTING, CLAUDE_DIAGNOSTICS_HARD_CAP, CLAUDE_DIAGNOSTICS_MAX_CYCLES_SETTING, CLAUDE_DIAGNOSTICS_SETTLE_MAX_MS, CLAUDE_DIAGNOSTICS_SETTLE_MIN_MS, CLAUDE_DIAGNOSTICS_SETTLE_MS_SETTING, CLAUDE_INLINE_EDIT_MODEL_SETTING, CLAUDE_INLINE_REJECT_ON_ESCAPE_SETTING, CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING, CLAUDE_LONG_PASTE_SETTING, CLAUDE_MODELS_DEFAULT_SETTING, CLAUDE_MODELS_FAST_MODE_SETTING, CLAUDE_MODELS_ULTRACODE_SETTING, CLAUDE_NOTIFICATIONS_APPROVAL_SETTING, CLAUDE_NOTIFICATIONS_FINISHED_SETTING, CLAUDE_NOTIFICATIONS_SOUND_SETTING, CLAUDE_PERMISSION_SETTINGS, CLAUDE_PREVIEW_ENABLED_SETTING, CLAUDE_REVIEW_OPEN_AFTER_EDIT_SETTING, CLAUDE_SECURITY_SCAN_ATTACHMENTS_SETTING, CLAUDE_SELECTION_TOOLBAR_SETTING, CLAUDE_SUBAGENTS_BUILT_IN_SETTING, CLAUDE_SUBAGENTS_OPEN_ON_START_SETTING, CLAUDE_TELEMETRY_ENABLED_SETTING } from '../../../../platform/claude/common/claudeConfiguration.js';
import { CLAUDE_TEND_IGNORE_SETTING, CLAUDE_TEND_POLL_SECONDS, CLAUDE_TEND_POLL_SETTING, CLAUDE_TEND_TURN_CAP, CLAUDE_TEND_TURNS_SETTING } from '../../../../platform/claude/common/claudeTendPullRequest.js';
import { CLAUDE_WORKER_PROFILE_SETTING } from '../../../../platform/claude/common/claudeWorkerProfile.js';
import { CLAUDE_REVIEW_POST_STATUS_SETTING } from '../../../../platform/claude/common/claudeAutomationGitHub.js';
import { CLAUDE_REVIEW_MIN_SEVERITY_SETTING, CLAUDE_REVIEW_STRICTNESS_SETTING, CLAUDE_REVIEW_SUMMARY_SETTING } from '../../../../platform/claude/common/claudeReviewLoop.js';
import { CLAUDE_AGENT_AUTO_ALLOW_INSTRUCTIONS_SETTING, CLAUDE_AGENT_AUTO_BLOCK_INSTRUCTIONS_SETTING, CLAUDE_AGENT_AUTO_REVIEW_DELETIONS_SETTING, CLAUDE_AGENT_AUTO_REVIEW_OUTSIDE_WRITES_SETTING, CLAUDE_AGENT_AUTO_REVIEW_AGENT_BROWSER_SETTING } from '../../../../platform/claude/common/claudeAutoReview.js';
import { CLAUDE_AUTO_COST_NOTIFY_USD_SETTING, CLAUDE_AUTO_COST_STOP_USD_SETTING, CLAUDE_AUTO_COST_USD_MAX, CLAUDE_AUTO_COST_USD_MIN } from '../../../../platform/claude/common/claudeAutoCostGuard.js';
import { CLAUDE_AUTO_CONTEXT_CAP_TOKENS_MAX, CLAUDE_AUTO_CONTEXT_CAP_TOKENS_MIN, CLAUDE_AUTO_CONTEXT_CAP_TOKENS_SETTING } from '../../../../platform/claude/common/claudeAutoContextGuard.js';
import { CLAUDE_AUTO_REVIEW_MAX_ROUNDS_MAX, CLAUDE_AUTO_REVIEW_MAX_ROUNDS_MIN, CLAUDE_AUTO_REVIEW_MAX_ROUNDS_SETTING } from '../../../../platform/claude/common/claudeAutoReviewRounds.js';
import { CLAUDE_MODELS_WARN_ON_SWITCH_SETTING } from './claudeModelSwitch.js';
import { CLAUDE_GIT_BRANCH_PREFIX_DEFAULT, CLAUDE_GIT_BRANCH_PREFIX_SETTING, CLAUDE_GIT_COMMIT_ATTRIBUTION_SETTING, CLAUDE_GIT_INSTRUCTIONS_SETTING, CLAUDE_GIT_PR_ATTRIBUTION_SETTING, CLAUDE_GIT_WORKTREE_BASE_SETTING } from '../../../../platform/claude/common/claudeGitSettings.js';
import { ClaudeNetworkRule } from '../../../../platform/claude/common/claudeNetworkRules.js';
import { ClaudePermissionRule } from '../../../../platform/claude/common/claudePermissionRules.js';
import { CLAUDE_OTEL_ENDPOINT_SETTING, CLAUDE_OTEL_HEADERS_SETTING, CLAUDE_OTEL_PROTOCOL_SETTING, CLAUDE_SANDBOX_ALLOW_LOCAL_BINDING_SETTING, CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_SETTING, CLAUDE_SANDBOX_AUTO_ALLOW_BASH_SETTING, CLAUDE_SANDBOX_ENABLED_SETTING, ClaudeSandboxStatus } from '../../../../platform/claude/common/claudeSecuritySettings.js';
import { CLAUDE_IMPORT_FROM_CURSOR_COMMAND_ID, CLAUDE_IMPORT_FROM_VSCODE_COMMAND_ID } from './claudeImport.js';
import { claudePermissionLevels } from './claudePermissionLevels.js';
import { ClaudeRuntimeState } from '../../../../platform/claude/common/claude.js';
import { ClaudeAccountOverview, ClaudeMcpServerInfo, ClaudeMcpServerState, ClaudeUsageWindow } from '../../../../platform/claude/common/claudeAccount.js';
import { ClaudeCommandInfo } from '../../../../platform/claude/common/claudeCommands.js';
import { CLAUDE_AGENTS_SKILLS_PLUGIN } from '../../../../platform/claude/common/claudeAgentsFiles.js';
import { CLAUDE_AUTOMATIONS_ENABLED_SETTING, CLAUDE_AUTOMATIONS_RUN_AT_LOGIN_SETTING } from '../../../../platform/claude/common/claudeAutomation.js';
import { ClaudeHookEntry, ClaudeHookScope } from '../../../../platform/claude/common/claudeHooks.js';
import { ClaudeMcpAddRequest, ClaudeMcpScope, readClaudeMcpScope } from '../../../../platform/claude/common/claudeMcpConfig.js';
import { CLAUDE_CODE_MCP_SCOPE, CLAUDE_USE_CLAUDE_CODE_SETUP_SETTING } from '../../../../platform/claude/common/claudeUserLayer.js';
import { ClaudeInstalledPlugin, claudePluginOrigin } from '../../../../platform/claude/common/claudePlugins.js';
import { ClaudeCreatedFile, ClaudeRuleFile } from './claudeCustomizeCreate.js';
import { CLAUDE_INSTALL_RUNTIME_COMMAND_ID, CLAUDE_REDETECT_RUNTIME_COMMAND_ID, CLAUDE_SIGN_IN_COMMAND_ID } from './claudeViews.js';
import { CLAUDE_VOICE_AUTO_SEND_SETTING, CLAUDE_VOICE_DELETE_MODEL_COMMAND_ID, CLAUDE_VOICE_ENABLED_SETTING } from './claudeVoiceInput.js';
import { CLAUDE_REVIEW_CONFIG_FILE_DEFAULT, CLAUDE_REVIEW_CONFIG_FILE_SETTING } from '../../../../platform/claude/common/claudeReviewConfig.js';
import { CLAUDE_REVIEW_LEARN_AFTER_SETTING } from '../../../../platform/claude/common/claudeReviewLearning.js';
import { CLAUDE_REVIEW_AFTER_COMMIT_SETTING, CLAUDE_REVIEW_FIX_SENDS_SETTING } from '../../../../platform/claude/common/claudeCommitReview.js';
import { CLAUDE_REVIEW_IMPACT_CONTEXT_SETTING } from '../../../../platform/claude/common/claudeReviewContext.js';
import { CLAUDE_REVIEW_DEPTH_SETTING, CLAUDE_REVIEW_MAX_TURNS_SETTING, CLAUDE_REVIEW_MODEL_SETTING } from '../../../../platform/claude/common/claudeReviewDepth.js';

/** The pages of the Klawly Settings editor, in nav order. */
export type ClaudeSettingsPageId = 'general' | 'plan' | 'agents' | 'privacy' | 'models' | 'git' | 'customize' | 'tab' | 'beta' | 'auto';

export interface ClaudeSettingsOption {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

/**
 * What a row shows on its right. Rows with a `key` read and write that setting.
 * - `model`: a dropdown of the models Claude Code reports, with `emptyLabel` for the empty value.
 * - `command`: a button that runs a command.
 * - `account`, `usage`, `modelList` and `customize`: blocks the editor draws from the runtime.
 * - `automations`: the automations list and editor, drawn from the automation service.
 */
export type ClaudeSettingsControl =
	| { readonly kind: 'toggle' }
	| { readonly kind: 'select'; readonly options: readonly ClaudeSettingsOption[] }
	| { readonly kind: 'model'; readonly emptyLabel: string }
	| { readonly kind: 'number'; readonly min?: number; readonly max?: number; readonly unit?: string }
	/** A list setting edited as text, one entry per line (issue 671). */
	| { readonly kind: 'lines'; readonly placeholder?: string }
	| { readonly kind: 'text'; readonly placeholder?: string; /** A field for a few characters, as wide as a select. */ readonly short?: boolean }
	| { readonly kind: 'command'; readonly label: string; readonly command: string; readonly args?: readonly string[] }
	| { readonly kind: 'account' }
	/** The GitHub account that is the Klawly profile (issue 446), above the Claude Code row. */
	| { readonly kind: 'profile' }
	/** The Klawly version with a Copy button, and the live update state with its one button (issue 833). */
	| { readonly kind: 'version' }
	| { readonly kind: 'updates' }
	| { readonly kind: 'usage' }
	| { readonly kind: 'modelList' }
	| { readonly kind: 'customize' }
	/** Whether Claude Code's sandbox can start on this machine (issue 432). */
	| { readonly kind: 'sandboxStatus' }
	/** Issue 1068: the rules this project learned from repeated dismissals, each with a Remove button. */
	| { readonly kind: 'learnedRules' }
	| { readonly kind: 'extensionAgents' }
	/** Issue 937: how many findings were raised, fixed, dismissed and ignored on this machine, with CSV export. */
	| { readonly kind: 'reviewStats' }
	| { readonly kind: 'automations' }
	/** The account Claude Code signed in with and its data terms, with a link to them (issue 522). */
	| { readonly kind: 'privacyAccount' }
	/** DL-56: a fact with no control, such as where some data goes (issue 522). */
	| { readonly kind: 'statement' };

export interface ClaudeSettingsRow {
	readonly id: string;
	readonly key?: string;
	readonly title: string;
	readonly description: string;
	readonly control: ClaudeSettingsControl;
	/** More words search matches on. */
	readonly keywords?: string;
	/** The row shows only while this setting is on or not empty (DL-12). */
	readonly shownWhen?: string;
}

export interface ClaudeSettingsSection {
	readonly id: string;
	/** The quiet label above the card. The first section of a page may have none. */
	readonly title?: string;
	readonly rows: readonly ClaudeSettingsRow[];
}

export interface ClaudeSettingsPage {
	readonly id: ClaudeSettingsPageId;
	readonly title: string;
	readonly description?: string;
	readonly icon: ThemeIcon;
	/** The nav draws a divider above this page. */
	readonly groupStart?: boolean;
	readonly sections: readonly ClaudeSettingsSection[];
}

export interface ClaudeSettingsMatch {
	readonly page: ClaudeSettingsPage;
	readonly section: ClaudeSettingsSection;
	readonly row: ClaudeSettingsRow;
}

const toggle: ClaudeSettingsControl = { kind: 'toggle' };

function askAllowDeny(...values: ('ask' | 'allow' | 'deny')[]): ClaudeSettingsControl {
	const labels = {
		ask: localize('claudeSettingsAsk', "Ask"),
		allow: localize('claudeSettingsAllow', "Allow"),
		deny: localize('claudeSettingsDeny', "Deny"),
	};
	return { kind: 'select', options: values.map(value => ({ value, label: labels[value] })) };
}

/** Every page with its sections and rows. Built on call so the strings follow the display language. */
export function claudeSettingsPages(): readonly ClaudeSettingsPage[] {
	return [
		{
			id: 'general',
			title: localize('claudeSettingsGeneral', "General"),
			icon: Codicon.settingsGear,
			sections: [
				{
					id: 'account',
					rows: [
						{ id: 'profile', title: localize('claudeSettingsProfile', "GitHub"), description: localize('claudeSettingsProfileDesc', "Your Klawly profile"), control: { kind: 'profile' }, keywords: 'account profile github sign in login sign out' },
						{ id: 'account', title: localize('claudeSettingsAccount', "Claude Code"), description: localize('claudeSettingsAccountDesc', "How Klawly reaches Claude Code"), control: { kind: 'account' }, keywords: 'account sign in login runtime version' },
					],
				},
				{
					id: 'versionUpdates',
					title: localize('claudeSettingsVersionUpdates', "Version and Updates"),
					rows: [
						{ id: 'version', title: localize('claudeSettingsVersion', "Version"), description: '', control: { kind: 'version' }, keywords: 'version about build commit release alpha copy bug report' },
						{ id: 'updates', title: localize('claudeSettingsCheckUpdates', "Check for Updates"), description: '', control: { kind: 'updates' }, keywords: 'update upgrade check latest restart download new version' },
					],
				},
				{
					id: 'preferences',
					title: localize('claudeSettingsPreferences', "Preferences"),
					rows: [
						{ id: 'editorSettings', title: localize('claudeSettingsEditorSettings', "Editor Settings"), description: localize('claudeSettingsEditorSettingsDesc', "Fonts, formatting, minimap and everything else in the editor"), control: { kind: 'command', label: localize('claudeSettingsOpen', "Open"), command: 'workbench.action.openSettings' } },
						{ id: 'keyboardShortcuts', title: localize('claudeSettingsKeyboard', "Keyboard Shortcuts"), description: localize('claudeSettingsKeyboardDesc', "Change the keys for any command"), control: { kind: 'command', label: localize('claudeSettingsOpen', "Open"), command: 'workbench.action.openGlobalKeybindings' } },
						{ id: 'importVSCode', title: localize('claudeSettingsImportVSCode', "Import from VS Code"), description: localize('claudeSettingsImportVSCodeDesc', "Bring over settings, keybindings and extensions"), control: { kind: 'command', label: localize('claudeSettingsImport', "Import"), command: CLAUDE_IMPORT_FROM_VSCODE_COMMAND_ID } },
						{ id: 'importCursor', title: localize('claudeSettingsImportCursor', "Import from Cursor"), description: localize('claudeSettingsImportCursorDesc', "Bring over settings, keybindings and extensions"), control: { kind: 'command', label: localize('claudeSettingsImport', "Import"), command: CLAUDE_IMPORT_FROM_CURSOR_COMMAND_ID } },
					],
				},
				{
					id: 'agent',
					title: localize('claudeSettingsAgentSection', "Agent"),
					rows: [
						{ id: 'enabled', key: CLAUDE_AGENT_ENABLED_SETTING, title: localize('claudeSettingsEnabled', "Agent"), description: localize('claudeSettingsEnabledDesc', "The agent views, commands and inline edit. Off leaves a plain editor"), control: toggle },
						{ id: 'selectionToolbar', key: CLAUDE_SELECTION_TOOLBAR_SETTING, title: localize('claudeSettingsSelectionToolbar', "Selection Toolbar"), description: localize('claudeSettingsSelectionToolbarDesc', "Show Add to Agent and Edit above selected text"), control: toggle },
						{ id: 'klawlyKeys', key: CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING, title: localize('claudeSettingsKlawlyKeys', "Klawly Keys"), description: localize('claudeSettingsKlawlyKeysDesc', "Ctrl+K edits inline, Ctrl+L and Ctrl+I focus the agent"), control: toggle, keywords: 'keybindings shortcuts' },
						{ id: 'rejectOnEscape', key: CLAUDE_INLINE_REJECT_ON_ESCAPE_SETTING, title: localize('claudeSettingsRejectEscape', "Escape Rejects Inline Edits"), description: localize('claudeSettingsRejectEscapeDesc', "Escape throws away an inline edit you have not accepted"), control: toggle },
					],
				},
				{
					id: 'voice',
					title: localize('claudeSettingsVoice', "Voice"),
					rows: [
						{ id: 'voiceEnabled', key: CLAUDE_VOICE_ENABLED_SETTING, title: localize('claudeSettingsVoiceEnabled', "Voice Input"), description: localize('claudeSettingsVoiceEnabledDesc', "A microphone in the composer. Speech is transcribed on this machine; the audio never leaves it"), control: toggle, keywords: 'dictation microphone speech' },
						{ id: 'voiceAutoSend', key: CLAUDE_VOICE_AUTO_SEND_SETTING, title: localize('claudeSettingsVoiceAutoSend', "Send When Dictation Ends"), description: localize('claudeSettingsVoiceAutoSendDesc', "Off leaves the dictated text in the composer to edit and send"), control: toggle, keywords: 'dictation' },
						{ id: 'voiceModel', title: localize('claudeSettingsVoiceModel', "Voice Model"), description: localize('claudeSettingsVoiceModelDesc', "The on-device speech model, downloaded on first use. Deleting it frees the disk space"), control: { kind: 'command', label: localize('claudeSettingsVoiceDelete', "Delete"), command: CLAUDE_VOICE_DELETE_MODEL_COMMAND_ID }, keywords: 'dictation download disk' },
					],
				},
				{
					id: 'runtime',
					title: localize('claudeSettingsRuntime', "Runtime"),
					rows: [
						{
							id: 'runtime', key: CLAUDE_AGENT_RUNTIME_SETTING, title: localize('claudeSettingsRuntimeKind', "Runtime"), description: localize('claudeSettingsRuntimeKindDesc', "Live runs Claude Code. Fake replays a test script"), control: {
								kind: 'select', options: [
									{ value: 'live', label: localize('claudeSettingsRuntimeLive', "Live") },
									{ value: 'fake', label: localize('claudeSettingsRuntimeFake', "Fake") },
								]
							}
						},
						{ id: 'runtimePath', key: CLAUDE_AGENT_RUNTIME_PATH_SETTING, title: localize('claudeSettingsRuntimePath', "Claude Code Path"), description: localize('claudeSettingsRuntimePathDesc', "Leave empty to use the claude on your PATH"), control: { kind: 'text', placeholder: localize('claudeSettingsRuntimePathPlaceholder', "claude") }, keywords: 'executable binary' },
					],
				},
			],
		},
		{
			id: 'plan',
			title: localize('claudeSettingsPlan', "Plan & Usage"),
			icon: Codicon.creditCard,
			groupStart: true,
			sections: [
				{
					id: 'usage',
					rows: [
						{ id: 'usage', title: localize('claudeSettingsUsage', "Usage"), description: localize('claudeSettingsUsageDesc', "Your Claude plan and its limits"), control: { kind: 'usage' }, keywords: 'plan billing limits subscription quota credits rate limit' },
					],
				},
			],
		},
		{
			id: 'agents',
			title: localize('claudeSettingsAgents', "Agents"),
			icon: Codicon.sparkle,
			sections: [
				{
					id: 'defaults',
					rows: [
						{
							id: 'defaultMode', key: CLAUDE_AGENT_DEFAULT_MODE_SETTING, title: localize('claudeSettingsDefaultMode', "Default Mode"), description: localize('claudeSettingsDefaultModeDesc', "The mode a new agent starts in"), control: {
								kind: 'select', options: [
									{ value: 'agent', label: localize('claudeSettingsModeAgent', "Agent"), description: localize('claudeSettingsModeAgentDesc', "Reads and edits the workspace") },
									{ value: 'plan', label: localize('claudeSettingsModePlan', "Plan"), description: localize('claudeSettingsModePlanDesc', "Researches and writes a plan to build") },
									{ value: 'ask', label: localize('claudeSettingsModeAsk', "Ask"), description: localize('claudeSettingsModeAskDesc', "Answers without changing files") },
								]
							}
						},
						{ id: 'newChatsFirst', key: CLAUDE_AGENT_NEW_CHATS_FIRST_SETTING, title: localize('claudeSettingsNewChatsFirst', "New Chats First"), description: localize('claudeSettingsNewChatsFirstDesc', "Open a new chat tab at the front of the tab strip instead of the end"), control: toggle, keywords: 'tabs order newest' },
						{ id: 'autoApproveReads', key: CLAUDE_AGENT_AUTO_APPROVE_READS_SETTING, title: localize('claudeSettingsReads', "Read Without Asking"), description: localize('claudeSettingsReadsDesc', "Read and search files in the workspace without a prompt"), control: toggle, keywords: 'permissions' },
						{
							id: 'saveBeforeCommands', key: CLAUDE_AGENT_SAVE_BEFORE_COMMANDS_SETTING, title: localize('claudeSettingsSave', "Unsaved Files Before Commands"), description: localize('claudeSettingsSaveDesc', "What happens to unsaved files before the agent runs a command"), control: {
								kind: 'select', options: [
									{ value: 'prompt', label: localize('claudeSettingsSavePrompt', "Ask") },
									{ value: 'always', label: localize('claudeSettingsSaveAlways', "Save") },
									{ value: 'never', label: localize('claudeSettingsSaveNever', "Leave") },
								]
							}
						},
						{
							id: 'replyStyle', key: CLAUDE_AGENT_REPLY_STYLE_SETTING, title: localize('claudeSettingsReplyStyle', "Reply Style"), description: localize('claudeSettingsReplyStyleDesc', "How Claude writes its replies"), control: {
								kind: 'select', options: [
									{ value: 'default', label: localize('claudeSettingsReplyStyleDefault', "Default") },
									{ value: 'adhd', label: localize('claudeSettingsReplyStyleAdhd', "ADHD Mode"), description: localize('claudeSettingsReplyStyleAdhdDesc', "TL;DR first, short bullets, detail folded away") },
								]
							}, keywords: 'adhd tldr concise short bullets focus answer style'
						},
						{ id: 'workRules', key: CLAUDE_WORK_RULES_SETTING, title: localize('claudeSettingsWorkRules', "Work Rules"), description: localize('claudeSettingsWorkRulesDesc', "Give Claude Klawly's work rules: autonomy by veto, acceptance criteria, tiered testing, a worktree per change, proof with every claim"), control: { kind: 'toggle' }, keywords: 'rules autonomy worktree tiered testing acceptance criteria proof stash system prompt' },
						{
							id: 'verifyUiChanges', key: CLAUDE_VERIFY_UI_SETTING, title: localize('claudeSettingsVerifyUi', "Verify UI Changes"), description: localize('claudeSettingsVerifyUiDesc', "After a UI change, Claude runs the app, drives the changed screen in the agent browser and attaches screenshots, a recording and console errors"), control: {
								kind: 'select', options: [
									{ value: 'off', label: localize('claudeSettingsVerifyUiOff', "Off") },
									{ value: 'ask', label: localize('claudeSettingsVerifyUiAsk', "Ask") },
									{ value: 'always', label: localize('claudeSettingsVerifyUiAlways', "Always") },
								]
							}, keywords: 'verify ui screenshot recording console browser dev server before after'
						},
					],
				},
				{
					id: 'permissions',
					title: localize('claudeSettingsPermissions', "Permissions"),
					rows: [
						// One level for every chat (issue 453). Strict is the default for a new install.
						{
							id: 'permissionMode', key: CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, title: localize('claudeSettingsPermissionLevel', "Permission Level"), description: localize('claudeSettingsPermissionLevelDesc', "What Claude may do without asking, in every chat"), control: {
								kind: 'select', options: claudePermissionLevels().map(({ level, label, description }) => ({ value: level, label, description })),
							}, keywords: 'permissions preset allow everything strict accept edits credentials yolo bypass auto approve trust skip dangerously'
						},
						{ id: 'writeWorkspace', key: CLAUDE_PERMISSION_SETTINGS.writeWorkspace, title: localize('claudeSettingsWriteWorkspace', "Edits in the Workspace"), description: localize('claudeSettingsWriteWorkspaceDesc', "Writes inside a trusted workspace"), control: askAllowDeny('ask', 'allow') },
						{ id: 'writeOutside', key: CLAUDE_PERMISSION_SETTINGS.writeOutsideWorkspace, title: localize('claudeSettingsWriteOutside', "Edits Outside the Workspace"), description: localize('claudeSettingsWriteOutsideDesc', "Writes anywhere else on disk"), control: askAllowDeny('ask', 'deny') },
						{ id: 'shellSafe', key: CLAUDE_PERMISSION_SETTINGS.shellSafe, title: localize('claudeSettingsShellSafe', "Read-Only Commands"), description: localize('claudeSettingsShellSafeDesc', "Commands such as git status that change nothing"), control: askAllowDeny('allow', 'ask'), keywords: 'shell terminal' },
						{ id: 'shellDestructive', key: CLAUDE_PERMISSION_SETTINGS.shellDestructive, title: localize('claudeSettingsShellDestructive', "Destructive Commands"), description: localize('claudeSettingsShellDestructiveDesc', "Commands that delete data or rewrite history"), control: askAllowDeny('ask', 'deny'), keywords: 'shell terminal' },
						{ id: 'network', key: CLAUDE_PERMISSION_SETTINGS.network, title: localize('claudeSettingsNetwork', "Network"), description: localize('claudeSettingsNetworkDesc', "Web fetches and commands that use the network"), control: askAllowDeny('ask', 'allow', 'deny'), keywords: 'web internet' },
					],
				},
				{
					id: 'sandbox',
					title: localize('claudeSettingsSandbox', "Sandbox"),
					rows: [
						{ id: 'sandboxEnabled', key: CLAUDE_SANDBOX_ENABLED_SETTING, title: localize('claudeSettingsSandboxEnabled', "Sandbox"), description: localize('claudeSettingsSandboxEnabledDesc', "Run Claude's commands in Claude Code's sandbox. A turn fails if it cannot start here"), control: toggle, keywords: 'security isolation bubblewrap network domains' },
						{ id: 'sandboxStatus', title: localize('claudeSettingsSandboxStatus', "On This Machine"), description: '', control: { kind: 'sandboxStatus' }, keywords: 'sandbox bubblewrap socat seatbelt install' },
						{ id: 'sandboxAutoAllowBash', key: CLAUDE_SANDBOX_AUTO_ALLOW_BASH_SETTING, title: localize('claudeSettingsSandboxAutoAllow', "Run Sandboxed Commands Without Asking"), description: localize('claudeSettingsSandboxAutoAllowDesc', "Commands that stay in the sandbox skip the prompt"), control: toggle, keywords: 'sandbox bash shell', shownWhen: CLAUDE_SANDBOX_ENABLED_SETTING },
						{ id: 'sandboxUnsandboxed', key: CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_SETTING, title: localize('claudeSettingsSandboxUnsandboxed', "Commands Outside the Sandbox"), description: localize('claudeSettingsSandboxUnsandboxedDesc', "Claude may ask to run a command unsandboxed"), control: toggle, keywords: 'sandbox escape', shownWhen: CLAUDE_SANDBOX_ENABLED_SETTING },
						{ id: 'sandboxLocalBinding', key: CLAUDE_SANDBOX_ALLOW_LOCAL_BINDING_SETTING, title: localize('claudeSettingsSandboxLocalBinding', "Local Ports"), description: localize('claudeSettingsSandboxLocalBindingDesc', "Sandboxed commands may listen on local ports, for a dev server"), control: toggle, keywords: 'sandbox network localhost', shownWhen: CLAUDE_SANDBOX_ENABLED_SETTING },
					],
				},
				{
					id: 'telemetryExport',
					title: localize('claudeSettingsTelemetryExport', "Telemetry Export"),
					rows: [
						{ id: 'otelEndpoint', key: CLAUDE_OTEL_ENDPOINT_SETTING, title: localize('claudeSettingsOtelEndpoint', "OpenTelemetry Endpoint"), description: localize('claudeSettingsOtelEndpointDesc', "Export Claude Code's metrics and events to your OTLP collector. Empty sends nothing"), control: { kind: 'text', placeholder: 'http://localhost:4317' }, keywords: 'otel otlp telemetry monitoring metrics' },
						{
							id: 'otelProtocol', key: CLAUDE_OTEL_PROTOCOL_SETTING, title: localize('claudeSettingsOtelProtocol', "Protocol"), description: localize('claudeSettingsOtelProtocolDesc', "The OTLP protocol the collector speaks"), control: {
								kind: 'select', options: [
									{ value: 'grpc', label: localize('claudeSettingsOtelGrpc', "gRPC") },
									{ value: 'http/protobuf', label: localize('claudeSettingsOtelProtobuf', "HTTP/Protobuf") },
									{ value: 'http/json', label: localize('claudeSettingsOtelJson', "HTTP/JSON") },
								]
							}, keywords: 'otel otlp', shownWhen: CLAUDE_OTEL_ENDPOINT_SETTING
						},
						{ id: 'otelHeaders', key: CLAUDE_OTEL_HEADERS_SETTING, title: localize('claudeSettingsOtelHeaders', "Headers"), description: localize('claudeSettingsOtelHeadersDesc', "key=value pairs separated by commas, kept in your settings file"), control: { kind: 'text', placeholder: 'Authorization=Bearer token' }, keywords: 'otel otlp authorization', shownWhen: CLAUDE_OTEL_ENDPOINT_SETTING },
					],
				},
				{
					id: 'chat',
					title: localize('claudeSettingsChat', "Chat"),
					rows: [
						{
							id: 'whileWorking', key: CLAUDE_COMPOSER_WHILE_WORKING_SETTING, title: localize('claudeSettingsWhileWorking', "Messages While Claude Works"), description: localize('claudeSettingsWhileWorkingDesc', "What Enter does mid-turn; Ctrl/Cmd+Enter does the other"), control: {
								kind: 'select', options: [
									{ value: 'queue', label: localize('claudeSettingsWhileWorkingQueue', "Queue"), description: localize('claudeSettingsWhileWorkingQueueDesc', "Hold it until the turn ends") },
									{ value: 'steer', label: localize('claudeSettingsWhileWorkingSteer', "Steer"), description: localize('claudeSettingsWhileWorkingSteerDesc', "Send it into the running turn") },
								]
							}, keywords: 'composer queue steer interrupt enter'
						},
						{ id: 'pasteAsReference', key: CLAUDE_COMPOSER_PASTE_AS_REFERENCE_SETTING, title: localize('claudeSettingsPasteRef', "Paste as Reference"), description: localize('claudeSettingsPasteRefDesc', "Pasted code becomes a file chip, long text a pasted-text pill"), control: toggle, keywords: 'composer' },
						{ id: 'longPaste', key: CLAUDE_LONG_PASTE_SETTING, title: localize('claudeSettingsLongPaste', "Long Paste"), description: localize('claudeSettingsLongPasteDesc', "Characters before a paste becomes a chip"), control: { kind: 'number', min: 1 }, keywords: 'composer' },
						{ id: 'preferCommands', key: CLAUDE_ACTIONS_PREFER_COMMANDS_SETTING, title: localize('claudeSettingsPreferCommands', "Use Project Commands"), description: localize('claudeSettingsPreferCommandsDesc', "Actions run your matching Claude command or skill when there is one"), control: toggle, keywords: 'slash skills' },
						{ id: 'defaultAccount', key: CLAUDE_ACCOUNTS_DEFAULT_ACCOUNT_SETTING, title: localize('claudeSettingsDefaultAccount', "Default Account"), description: localize('claudeSettingsDefaultAccountDesc', "The account new chats start on, by account id. Empty uses the active account"), control: { kind: 'text', short: true }, keywords: 'account sign in chat default' },
						{
							id: 'onLimit', key: CLAUDE_ACCOUNTS_ON_LIMIT_SETTING, title: localize('claudeSettingsOnLimit', "When a Limit Is Reached"), description: localize('claudeSettingsOnLimitDesc', "What a chat does when its account runs out. A chat can override it; an account only allows what its limit options permit"), control: {
								kind: 'select', options: [
									{ value: 'ask', label: localize('claudeSettingsOnLimitAsk', "Ask Me") },
									{ value: 'extraUsage', label: localize('claudeSettingsOnLimitExtra', "Use Extra Usage") },
									{ value: 'apiKey', label: localize('claudeSettingsOnLimitApi', "Use the API Key") },
									{ value: 'otherAccount', label: localize('claudeSettingsOnLimitOther', "Offer Another Account") },
								]
							}, keywords: 'account limit usage extra api key rotate'
						},
						{ id: 'referenceSummary', key: CLAUDE_CHAT_REFERENCE_SUMMARY_SETTING, title: localize('claudeSettingsReferenceSummary', "Chat Reference Summary"), description: localize('claudeSettingsReferenceSummaryDesc', "Characters kept when one chat references another"), control: { kind: 'number', min: 200 } },
					],
				},
				{
					id: 'notifications',
					title: localize('claudeSettingsNotifications', "Notifications"),
					rows: [
						{ id: 'notifyApproval', key: CLAUDE_NOTIFICATIONS_APPROVAL_SETTING, title: localize('claudeSettingsNotifyApproval', "Approval Requests"), description: localize('claudeSettingsNotifyApprovalDesc', "A system notification when Claude waits for you in the background"), control: toggle, keywords: 'notifications toast permission' },
						{ id: 'notifyFinished', key: CLAUDE_NOTIFICATIONS_FINISHED_SETTING, title: localize('claudeSettingsNotifyFinished', "Finished Agents"), description: localize('claudeSettingsNotifyFinishedDesc', "A notification when an agent or background agent finishes or fails"), control: toggle, keywords: 'notifications toast done' },
						{ id: 'notifySound', key: CLAUDE_NOTIFICATIONS_SOUND_SETTING, title: localize('claudeSettingsNotifySound', "Sound"), description: localize('claudeSettingsNotifySoundDesc', "Play a sound when an agent finishes or needs your approval"), control: toggle, keywords: 'notifications chime audio' },
					],
				},
				{
					id: 'review',
					title: localize('claudeSettingsReview', "Review and Checkpoints"),
					rows: [
						{ id: 'openAfterEdit', key: CLAUDE_REVIEW_OPEN_AFTER_EDIT_SETTING, title: localize('claudeSettingsOpenAfterEdit', "Open Review After Edits"), description: localize('claudeSettingsOpenAfterEditDesc', "Show the diff at the first change when a turn edits files"), control: toggle },
						// Issue 922: where the review rules live.
						{ id: 'reviewConfigFile', key: CLAUDE_REVIEW_CONFIG_FILE_SETTING, title: localize('claudeSettingsReviewConfigFile', "Review Rules File"), description: localize('claudeSettingsReviewConfigFileDesc', "Ignore globs, scoped rules and rules to turn off; a nearer folder's file wins"), control: { kind: 'text', placeholder: CLAUDE_REVIEW_CONFIG_FILE_DEFAULT }, keywords: 'review rules ignore scope json' },
						{ id: 'learnAfter', key: CLAUDE_REVIEW_LEARN_AFTER_SETTING, title: localize('claudeSettingsLearnAfter', "Learn After"), description: localize('claudeSettingsLearnAfterDesc', "Offer to stop flagging a finding after you dismiss it this many times in a project"), control: { kind: 'number', min: 1, unit: localize('claudeSettingsLearnAfterUnit', "dismissals") }, keywords: 'review learn dismiss repeat threshold' },
						{ id: 'learnedRules', title: localize('claudeSettingsLearnedRules', "Learned Rules"), description: localize('claudeSettingsLearnedRulesDesc', "Rules added after repeated dismissals; remove one to see those findings again"), control: { kind: 'learnedRules' }, keywords: 'review learned rules remove dismissed stop flagging' },
						{ id: 'reviewStats', title: localize('claudeSettingsReviewStats', "Statistics"), description: localize('claudeSettingsReviewStatsDesc', "What reviews raised and what you did with it, kept on this machine only"), control: { kind: 'reviewStats' }, keywords: 'review statistics stats dismissed fixed rate export csv' },
						// Issue 921: one severity scale and a strictness for every review. The categories are a list; edit them in settings.json.
						{
							id: 'minSeverity', key: CLAUDE_REVIEW_MIN_SEVERITY_SETTING, title: localize('claudeSettingsMinSeverity', "Lowest Severity Shown"), description: localize('claudeSettingsMinSeverityDesc', "Findings below this are hidden, never deleted"), control: {
								kind: 'select', options: [
									{ value: 'critical', label: localize('claudeSettingsSevCritical', "Critical"), description: localize('claudeSettingsSevCriticalDesc', "Only critical findings") },
									{ value: 'high', label: localize('claudeSettingsSevHigh', "High"), description: localize('claudeSettingsSevHighDesc', "High and critical") },
									{ value: 'medium', label: localize('claudeSettingsSevMedium', "Medium"), description: localize('claudeSettingsSevMediumDesc', "Medium and above") },
									{ value: 'low', label: localize('claudeSettingsSevLow', "Low"), description: localize('claudeSettingsSevLowDesc', "Every finding") },
								],
							}, keywords: 'review severity filter critical high medium low',
						},
						{
							id: 'strictness', key: CLAUDE_REVIEW_STRICTNESS_SETTING, title: localize('claudeSettingsStrictness', "Review Strictness"), description: localize('claudeSettingsStrictnessDesc', "How picky a review is"), control: {
								kind: 'select', options: [
									{ value: 'relaxed', label: localize('claudeSettingsStrictRelaxed', "Relaxed"), description: localize('claudeSettingsStrictRelaxedDesc', "Only sure, important problems") },
									{ value: 'balanced', label: localize('claudeSettingsStrictBalanced', "Balanced"), description: localize('claudeSettingsStrictBalancedDesc', "Real problems and clear risks") },
									{ value: 'strict', label: localize('claudeSettingsStrictStrict', "Strict"), description: localize('claudeSettingsStrictStrictDesc', "Also edge cases and missing tests") },
								],
							}, keywords: 'review strict picky relaxed balanced',
						},
						{
							id: 'reviewDepth', key: CLAUDE_REVIEW_DEPTH_SETTING, title: localize('claudeSettingsReviewDepth', "Review Depth"), description: localize('claudeSettingsReviewDepthDesc', "How far a review digs. Every review says which depth it used and why."), control: {
								kind: 'select', options: [
									{ value: 'auto', label: localize('claudeSettingsDepthAuto', "Auto"), description: localize('claudeSettingsDepthAutoDesc', "Deep for big diffs, many folders, or auth, payments, migrations and CI; Quick otherwise") },
									{ value: 'quick', label: localize('claudeSettingsDepthQuick', "Quick"), description: localize('claudeSettingsDepthQuickDesc', "One pass, the most serious problems only") },
									{ value: 'deep', label: localize('claudeSettingsDepthDeep', "Deep"), description: localize('claudeSettingsDepthDeepDesc', "One pass per top-level folder, following callers and edge cases; slower and uses more of your plan") },
								],
							}, keywords: 'review depth quick deep auto thorough',
						},
						{
							id: 'reviewImpact', key: CLAUDE_REVIEW_IMPACT_CONTEXT_SETTING, title: localize('claudeSettingsReviewImpact', "Review Context"), description: localize('claudeSettingsReviewImpactDesc', "What a review knows beyond the diff."), control: {
								kind: 'select', options: [
									{ value: 'off', label: localize('claudeSettingsImpactOff', "Off"), description: localize('claudeSettingsImpactOffDesc', "The reviewer sees the diff only") },
									{ value: 'symbols', label: localize('claudeSettingsImpactSymbols', "Callers"), description: localize('claudeSettingsImpactSymbolsDesc', "Where the changed functions and types are used outside the diff") },
									{ value: 'symbolsAndPatterns', label: localize('claudeSettingsImpactPatterns', "Callers and Summary"), description: localize('claudeSettingsImpactPatternsDesc', "Also a short dependency summary from the repository graph") },
								],
							}, keywords: 'review context callers impact references',
						},
						{ id: 'reviewModel', key: CLAUDE_REVIEW_MODEL_SETTING, title: localize('claudeSettingsReviewModel', "Review Model"), description: localize('claudeSettingsReviewModelDesc', "Advanced. The model every review uses"), control: { kind: 'model', emptyLabel: localize('claudeSettingsReviewModelDefault', "Chat's Model, Opus for Deep") }, keywords: 'review model advanced' },
						{ id: 'reviewMaxTurns', key: CLAUDE_REVIEW_MAX_TURNS_SETTING, title: localize('claudeSettingsReviewMaxTurns', "Review Turns"), description: localize('claudeSettingsReviewMaxTurnsDesc', "Advanced. The most turns one review pass may take; 0 keeps the default (8 Quick, 24 Deep)"), control: { kind: 'number', min: 0, max: 100 }, keywords: 'review turns advanced max' },
						{
							id: 'summary', key: CLAUDE_REVIEW_SUMMARY_SETTING, title: localize('claudeSettingsSummary', "Review Summary"), description: localize('claudeSettingsSummaryDesc', "An overview and a file by file walkthrough with each review"), control: {
								kind: 'select', options: [
									{ value: 'off', label: localize('claudeSettingsSummaryOff', "Off"), description: localize('claudeSettingsSummaryOffDesc', "Findings only") },
									{ value: 'summary', label: localize('claudeSettingsSummarySummary', "Summary"), description: localize('claudeSettingsSummarySummaryDesc', "Add the overview and the file walkthrough") },
									{ value: 'summaryAndDescription', label: localize('claudeSettingsSummaryDescription', "Summary and Description"), description: localize('claudeSettingsSummaryDescriptionDesc', "Also propose a new pull request description, applied only when you accept") },
								],
							}, keywords: 'review summary walkthrough overview pull request description',
						},
						{ id: 'postStatus', key: CLAUDE_REVIEW_POST_STATUS_SETTING, title: localize('claudeSettingsPostStatus', "Post Status and Reactions on GitHub"), description: localize('claudeSettingsPostStatusDesc', "The review bot sets a Klawly review commit status and reacts to the pull request or the comment that asked for the review. It needs the repo:status permission; with gh signed out it posts nothing."), control: toggle, keywords: 'review status check github pull request bot' },
						{ id: 'mergeStage', key: CLAUDE_MERGE_STAGE_AFTER_KEEP_SETTING, title: localize('claudeSettingsMergeStage', "Stage Resolved Conflicts"), description: localize('claudeSettingsMergeStageDesc', "After you keep the last change in a conflicted file with no marker left, stage it"), control: toggle, keywords: 'merge conflict git stage resolve' },
						{ id: 'checkpoints', key: CLAUDE_CHECKPOINTS_ENABLED_SETTING, title: localize('claudeSettingsCheckpoints', "Checkpoints"), description: localize('claudeSettingsCheckpointsDesc', "Save a restore point at the start of each turn"), control: toggle },
						{ id: 'retention', key: CLAUDE_CHECKPOINT_RETENTION_SETTING, title: localize('claudeSettingsRetention', "Keep Checkpoints"), description: localize('claudeSettingsRetentionDesc', "Days before old checkpoint files are deleted"), control: { kind: 'number', min: 0, unit: localize('claudeSettingsDays', "days") } },
						{ id: 'autoVerify', key: CLAUDE_DIAGNOSTICS_AUTO_VERIFY_SETTING, title: localize('claudeSettingsAutoVerify', "Fix New Errors"), description: localize('claudeSettingsAutoVerifyDesc', "After an edit, ask Claude to fix the errors it caused"), control: toggle, keywords: 'diagnostics problems' },
						{ id: 'maxCycles', key: CLAUDE_DIAGNOSTICS_MAX_CYCLES_SETTING, title: localize('claudeSettingsMaxCycles', "Fix Attempts"), description: localize('claudeSettingsMaxCyclesDesc', "Automatic fix turns after one request"), control: { kind: 'number', min: 1, max: CLAUDE_DIAGNOSTICS_HARD_CAP }, keywords: 'diagnostics' },
						{ id: 'settle', key: CLAUDE_DIAGNOSTICS_SETTLE_MS_SETTING, title: localize('claudeSettingsSettle', "Wait for Problems"), description: localize('claudeSettingsSettleDesc', "Quiet time before new errors are collected"), control: { kind: 'number', min: CLAUDE_DIAGNOSTICS_SETTLE_MIN_MS, max: CLAUDE_DIAGNOSTICS_SETTLE_MAX_MS, unit: localize('claudeSettingsMs', "ms") }, keywords: 'diagnostics' },
					],
				},
				{
					id: 'subagents',
					title: localize('claudeSettingsSubagents', "Subagents"),
					rows: [
						{ id: 'builtIn', key: CLAUDE_SUBAGENTS_BUILT_IN_SETTING, title: localize('claudeSettingsBuiltIn', "Klawly Subagents"), description: localize('claudeSettingsBuiltInDesc', "Offer a read-only reviewer and an explorer to Claude"), control: toggle },
						{ id: 'openOnStart', key: CLAUDE_SUBAGENTS_OPEN_ON_START_SETTING, title: localize('claudeSettingsOpenOnStart', "Follow Subagents"), description: localize('claudeSettingsOpenOnStartDesc', "Open a subagent's chat as soon as it starts"), control: toggle },
					],
				},
				{
					id: 'tend',
					title: localize('claudeSettingsTend', "Tend This PR"),
					rows: [
						{ id: 'tendPoll', key: CLAUDE_TEND_POLL_SETTING, title: localize('claudeSettingsTendPoll', "Check Interval"), description: localize('claudeSettingsTendPollDesc', "How often Klawly looks at the pull request while it tends it"), control: { kind: 'number', min: CLAUDE_TEND_POLL_SECONDS.min, max: CLAUDE_TEND_POLL_SECONDS.max, unit: localize('claudeSettingsTendPollUnit', "seconds") }, keywords: 'tend pull request pr poll interval github' },
						{ id: 'tendTurns', key: CLAUDE_TEND_TURNS_SETTING, title: localize('claudeSettingsTendTurns', "Turn Limit"), description: localize('claudeSettingsTendTurnsDesc', "Most turns Klawly starts for one pull request before it stops and tells you"), control: { kind: 'number', min: CLAUDE_TEND_TURN_CAP.min, max: CLAUDE_TEND_TURN_CAP.max }, keywords: 'tend pull request pr turn cap limit github' },
						{ id: 'tendIgnore', key: CLAUDE_TEND_IGNORE_SETTING, title: localize('claudeSettingsTendIgnore', "Ignored GitHub Users"), description: localize('claudeSettingsTendIgnoreDesc', "Review comments from these users are left alone, such as a bot. One name per line"), control: { kind: 'lines', placeholder: localize('claudeSettingsTendIgnorePlaceholder', "GitHub username") }, keywords: 'tend pull request pr ignore bot authors comments github' },
					],
				},
				{
					id: 'automations',
					title: localize('claudeSettingsAutomations', "Automations"),
					rows: [
						{ id: 'automationsEnabled', key: CLAUDE_AUTOMATIONS_ENABLED_SETTING, title: localize('claudeSettingsRunAutomations', "Run Automations"), description: localize('claudeSettingsRunAutomationsDesc', "Start automations on their schedules and triggers while Klawly is open. Run Now works either way"), control: toggle, keywords: 'automations schedule cron trigger background' },
						{ id: 'automationsRunAtLogin', key: CLAUDE_AUTOMATIONS_RUN_AT_LOGIN_SETTING, title: localize('claudeSettingsAutomationsRunAtLogin', "Run When Signed In"), description: localize('claudeSettingsAutomationsRunAtLoginDesc', "Start Klawly minimized when you sign in, so automations run while no window is open"), control: toggle, keywords: 'automations login startup background closed minimized' },
						{ id: 'automations', title: localize('claudeSettingsAutomationList', "Automations"), description: localize('claudeSettingsAutomationListDesc', "Background agents that start on a schedule, a save, or a failed task or test run"), control: { kind: 'automations' }, keywords: 'automation schedule cron trigger background agent on save task failed tests failed run now' },
					],
				},
			],
		},
		{
			id: 'auto',
			title: localize('claudeSettingsAuto', "Auto"),
			description: localize('claudeSettingsAutoPageDesc', "Let Claude pick the model for each turn; the Auto permission level is set separately"),
			icon: Codicon.sparkle,
			sections: [
				{
					id: 'switch',
					rows: [
						{ id: 'autoEnabled', key: CLAUDE_AUTO_ENABLED_SETTING, title: localize('claudeSettingsAutoEnabled', "Auto"), description: localize('claudeSettingsAutoEnabledDesc', "Picks the model for each turn. It does not change the permission level"), control: toggle, keywords: 'auto automatic model permission keep accept' },
					],
				},
				{
					id: 'autoPermissions',
					title: localize('claudeSettingsAutoPermissions', "Permissions"),
					rows: [
						// What the Auto level approves or always asks about, in plain words (issue 671).
						{ id: 'autoAllow', key: CLAUDE_AGENT_AUTO_ALLOW_INSTRUCTIONS_SETTING, title: localize('claudeSettingsAutoAllow', "Auto Approves"), description: localize('claudeSettingsAutoAllowDesc', "One rule per line, in plain words. The Auto level approves requests that match"), control: { kind: 'lines', placeholder: localize('claudeSettingsAutoAllowPlaceholder', "Run the project's test commands") }, keywords: 'auto allow instructions classifier approve rules' },
						{ id: 'autoBlock', key: CLAUDE_AGENT_AUTO_BLOCK_INSTRUCTIONS_SETTING, title: localize('claudeSettingsAutoBlock', "Auto Always Asks"), description: localize('claudeSettingsAutoBlockDesc', "One rule per line, in plain words. Requests that match always show a card"), control: { kind: 'lines', placeholder: localize('claudeSettingsAutoBlockPlaceholder', "Anything that pushes to a remote") }, keywords: 'auto block instructions classifier ask rules deny' },
						// Opt-in toggles that let Auto review what it otherwise always asks about; off by default (issue 908).
						{ id: 'autoReviewDeletions', key: CLAUDE_AGENT_AUTO_REVIEW_DELETIONS_SETTING, title: localize('claudeSettingsAutoReviewDeletions', "Auto Reviews File Deletions"), description: localize('claudeSettingsAutoReviewDeletionsDesc', "Off: deleting files always asks. On: Auto may approve a plain delete inside the workspace. A wrong call loses files"), control: toggle, keywords: 'auto delete deletion remove rm classifier review warning' },
						{ id: 'autoReviewOutsideWrites', key: CLAUDE_AGENT_AUTO_REVIEW_OUTSIDE_WRITES_SETTING, title: localize('claudeSettingsAutoReviewOutside', "Auto Reviews Writes Outside the Workspace"), description: localize('claudeSettingsAutoReviewOutsideDesc', "Off: writing outside the workspace always asks. On: Auto may approve it. A wrong call can overwrite files elsewhere on disk"), control: toggle, keywords: 'auto outside workspace write classifier review warning' },
						{ id: 'autoReviewAgentBrowser', key: CLAUDE_AGENT_AUTO_REVIEW_AGENT_BROWSER_SETTING, title: localize('claudeSettingsAutoReviewBrowser', "Auto Reviews Agent Browser Pages"), description: localize('claudeSettingsAutoReviewBrowserDesc', "Off: opening a page outside this machine always asks. On: Auto may approve it. Localhost never asks"), control: toggle, keywords: 'auto agent browser website classifier review warning' },
					],
				},
				{
					id: 'autoAdvanced',
					title: localize('claudeSettingsAutoAdvanced', "Advanced"),
					rows: [
						{ id: 'delegationEnabled', key: CLAUDE_DELEGATION_ENABLED_SETTING, title: localize('claudeSettingsDelegationEnabled', "Delegate to Workers"), description: localize('claudeSettingsDelegationEnabledDesc', "Let Claude hand work to separate worker chats and keep every worker run in one list"), control: toggle, keywords: 'delegate delegation workers worker agents handoff' },
						{ id: 'autoReuseHelpers', key: CLAUDE_AUTO_REUSE_HELPERS_SETTING, title: localize('claudeSettingsAutoReuseHelpers', "Reuse Idle Helpers"), description: localize('claudeSettingsAutoReuseHelpersDesc', "Give new work to a finished helper of the same tier, after compacting it, instead of starting another"), control: toggle, keywords: 'auto reuse idle helper worker compact' },
						{ id: 'autoContextCap', key: CLAUDE_AUTO_CONTEXT_CAP_TOKENS_SETTING, title: localize('claudeSettingsAutoContextCap', "Context Cap"), description: localize('claudeSettingsAutoContextCapDesc', "Most tokens one chat or helper holds before Auto compacts it. You get a nudge at 80%"), control: { kind: 'number', min: CLAUDE_AUTO_CONTEXT_CAP_TOKENS_MIN, max: CLAUDE_AUTO_CONTEXT_CAP_TOKENS_MAX }, keywords: 'auto context cap tokens compact handoff window' },
						{ id: 'autoCostNotify', key: CLAUDE_AUTO_COST_NOTIFY_USD_SETTING, title: localize('claudeSettingsAutoCostNotify', "Cost Notice"), description: localize('claudeSettingsAutoCostNotifyDesc', "Dollars one chat and its helpers may cost before Auto tells you. It carries on"), control: { kind: 'number', min: CLAUDE_AUTO_COST_USD_MIN, max: CLAUDE_AUTO_COST_USD_MAX }, keywords: 'auto cost notify budget dollars usd spend' },
						{ id: 'autoCostStop', key: CLAUDE_AUTO_COST_STOP_USD_SETTING, title: localize('claudeSettingsAutoCostStop', "Cost Limit"), description: localize('claudeSettingsAutoCostStopDesc', "Dollars one chat and its helpers may cost before Auto stops them all and asks you"), control: { kind: 'number', min: CLAUDE_AUTO_COST_USD_MIN, max: CLAUDE_AUTO_COST_USD_MAX }, keywords: 'auto cost limit stop budget dollars usd spend' },
						{ id: 'autoReviewRounds', key: CLAUDE_AUTO_REVIEW_MAX_ROUNDS_SETTING, title: localize('claudeSettingsAutoReviewRounds', "Auto Review Rounds"), description: localize('claudeSettingsAutoReviewRoundsDesc', "How many times the strong model reviews a helper's result before the open points come to you"), control: { kind: 'number', min: CLAUDE_AUTO_REVIEW_MAX_ROUNDS_MIN, max: CLAUDE_AUTO_REVIEW_MAX_ROUNDS_MAX }, keywords: 'auto review rounds helper delegate cap' },
						{ id: 'tierModelSmall', key: CLAUDE_DELEGATION_TIER_MODEL_SETTINGS.small, title: localize('claudeSettingsTierSmall', "Tier Model: Small"), description: localize('claudeSettingsTierSmallDesc', "The model for lookups and mechanical runs"), control: { kind: 'text', placeholder: 'haiku', short: true }, keywords: 'tier haiku sonnet model delegate small' },
						{ id: 'tierModelMedium', key: CLAUDE_DELEGATION_TIER_MODEL_SETTINGS.medium, title: localize('claudeSettingsTierMedium', "Tier Model: Medium"), description: localize('claudeSettingsTierMediumDesc', "The model for building from a brief"), control: { kind: 'text', placeholder: 'sonnet', short: true }, keywords: 'tier haiku sonnet model delegate medium' },
						{ id: 'tierModelLarge', key: CLAUDE_DELEGATION_TIER_MODEL_SETTINGS.large, title: localize('claudeSettingsTierLarge', "Tier Model: Large"), description: localize('claudeSettingsTierLargeDesc', "The model for large work with a stated reason; empty uses the chat's own model"), control: { kind: 'text', placeholder: localize('claudeSettingsTierLargePlaceholder', "Chat's model"), short: true }, keywords: 'tier haiku sonnet opus model delegate large' },
						{ id: 'codingCap', key: CLAUDE_DELEGATE_CODING_CAP_SETTING, title: localize('claudeSettingsCodingCap', "Helpers per Repository"), description: localize('claudeSettingsCodingCapDesc', "Most helpers working in one repository at once; the rest queue in order"), control: { kind: 'number', min: 1, max: CLAUDE_DELEGATE_CODING_CAP_MAX }, keywords: 'delegation helpers cap parallel queue repository limit' },
						{ id: 'helperWorktrees', key: CLAUDE_DELEGATE_HELPER_WORKTREES_SETTING, title: localize('claudeSettingsHelperWorktrees', "Worktree per Coding Helper"), description: localize('claudeSettingsHelperWorktreesDesc', "A helper that owns files works in its own Git worktree"), control: toggle, keywords: 'delegation helpers worktree isolate git files' },
						{ id: 'delegateDepth', key: CLAUDE_DELEGATE_DEPTH_SETTING, title: localize('claudeSettingsDelegateDepth', "Helper Nesting Depth"), description: localize('claudeSettingsDelegateDepthDesc', "How many levels helpers nest. A delegation with a stated reason may go to 4"), control: { kind: 'number', min: 1, max: CLAUDE_DELEGATE_DEPTH_HARD_MAX }, keywords: 'delegation depth nesting levels coordinator' },
						{ id: 'workerProfile', key: CLAUDE_WORKER_PROFILE_SETTING, title: localize('claudeSettingsWorkerProfile', "Worker Profile"), description: localize('claudeSettingsWorkerProfileDesc', "What a worker starts with. Lean has the file and shell tools only; Full adds MCP servers, plugins and skills"), control: { kind: 'select', options: [{ value: 'lean', label: localize('claudeSettingsWorkerProfileLean', "Lean") }, { value: 'full', label: localize('claudeSettingsWorkerProfileFull', "Full") }] }, keywords: 'delegation worker profile lean full mcp tools context' },
						{ id: 'workerFailedCalls', key: CLAUDE_DELEGATION_WORKER_FAILED_CALLS_SETTING, title: localize('claudeSettingsLadderWorkerFailedCalls', "Worker Escalation After"), description: localize('claudeSettingsLadderWorkerFailedCallsDesc', "Failed calls in a row that move a delegated worker up one tier. 0 turns it off"), control: { kind: 'number', min: 0 }, keywords: 'escalation ladder worker tier failed calls' },
						{ id: 'sessionFailedCalls', key: CLAUDE_DELEGATION_SESSION_FAILED_CALLS_SETTING, title: localize('claudeSettingsLadderSessionFailedCalls', "Cheap Turn Fallback: Failed Calls"), description: localize('claudeSettingsLadderSessionFailedCallsDesc', "Failed calls after which a cheap Auto turn goes back to the chat's own model. 0 turns it off"), control: { kind: 'number', min: 0 }, keywords: 'escalation ladder session auto fallback failed calls' },
						{ id: 'sessionSteps', key: CLAUDE_DELEGATION_SESSION_STEPS_SETTING, title: localize('claudeSettingsLadderSessionSteps', "Cheap Turn Fallback: Steps"), description: localize('claudeSettingsLadderSessionStepsDesc', "Steps after which a cheap Auto turn goes back to the chat's own model. 0 turns it off"), control: { kind: 'number', min: 0 }, keywords: 'escalation ladder session auto fallback steps' },
						{ id: 'costWatcherEnabled', key: CLAUDE_DELEGATION_COST_WATCHER_ENABLED_SETTING, title: localize('claudeSettingsCostWatcherEnabled', "Cost Reminders"), description: localize('claudeSettingsCostWatcherEnabledDesc', "Remind an expensive chat to hand mechanical runs to a worker, sooner when each call costs more. Never on Haiku chats"), control: toggle, keywords: 'cost watcher reminder nudge delegate worker expensive opus' },
						{ id: 'costWatcherCadence', key: CLAUDE_DELEGATION_COST_WATCHER_CADENCE_SETTING, title: localize('claudeSettingsCostWatcherCadence', "Cost Reminder Every"), description: localize('claudeSettingsCostWatcherCadenceDesc', "Tool calls between reminders at about $0.05 a call; dearer calls remind sooner"), control: { kind: 'number', min: 1 }, keywords: 'cost watcher cadence reminder nudge calls' },
						{ id: 'costWatcherRefuse', key: CLAUDE_DELEGATION_COST_WATCHER_REFUSE_SETTING, title: localize('claudeSettingsCostWatcherRefuse', "Refuse After Ignored Reminders"), description: localize('claudeSettingsCostWatcherRefuseDesc', "After 3 ignored reminders, refuse tool calls until the chat delegates or gives a reason a cheap model accepts"), control: toggle, keywords: 'cost watcher refuse block delegate reason' },
						{ id: 'workersFinishedMinutes', key: CLAUDE_WORKERS_FINISHED_MINUTES_SETTING, title: localize('claudeSettingsWorkersFinished', "Flag Finished Workers After"), description: localize('claudeSettingsWorkersFinishedDesc', "Minutes after which a finished worker that is still open is flagged in the Workers view. 0 turns it off"), control: { kind: 'number', min: 0 }, keywords: 'workers view finished idle flag stop' },
						{ id: 'workersHungMinutes', key: CLAUDE_WORKERS_HUNG_MINUTES_SETTING, title: localize('claudeSettingsWorkersHung', "Flag Hung Workers After"), description: localize('claudeSettingsWorkersHungDesc', "Minutes without any news after which a working worker is flagged as hung in the Workers view. 0 turns it off"), control: { kind: 'number', min: 0 }, keywords: 'workers view hung stuck silent flag' },
						{ id: 'mergeWithoutAsking', key: CLAUDE_MERGE_WITHOUT_ASKING_SETTING, title: localize('claudeSettingsMergeWithoutAsking', "Merge Without Asking"), description: localize('claudeSettingsMergeWithoutAskingDesc', "Let Claude squash-merge a pull request once its required checks are green, without a prompt. Off: you approve each merge"), control: { kind: 'toggle' }, keywords: 'merge pull request merge_gate ci checks approve delegation' },
					],
				},
			],
		},
		{
			// Issue 522: what leaves the machine and where it goes. Every row must stay true of the code: the PR that changes a destination changes its row.
			id: 'privacy',
			title: localize('claudeSettingsPrivacyPage', "Privacy"),
			description: localize('claudeSettingsPrivacyPageDesc', "What leaves this machine, where it goes, and who decides how it is used"),
			icon: Codicon.lock,
			sections: [
				{
					id: 'privacyAccount',
					title: localize('claudeSettingsPrivacyAccount', "Your Account"),
					rows: [
						{ id: 'privacyAccount', title: localize('claudeSettingsPrivacyAccountRow', "Account"), description: '', control: { kind: 'privacyAccount' }, keywords: 'training data retention terms consumer commercial privacy' },
					],
				},
				{
					id: 'privacyDestinations',
					title: localize('claudeSettingsPrivacyDestinations', "What Leaves This Machine"),
					rows: [
						{ id: 'privacyPrompts', title: localize('claudeSettingsPrivacyPrompts', "Prompts and Files"), description: localize('claudeSettingsPrivacyPromptsDesc', "Claude Code sends your messages and what Claude reads, such as files, command output and attachments, to Anthropic, or to Amazon Bedrock or Google Vertex AI when it signs in through them"), control: { kind: 'statement' }, keywords: 'anthropic data privacy' },
						{ id: 'telemetry', key: CLAUDE_TELEMETRY_ENABLED_SETTING, title: localize('claudeSettingsTelemetry', "Claude Code Reporting"), description: localize('claudeSettingsTelemetryDesc', "Off keeps Claude Code's telemetry and error reports off. Klawly sends none either way"), control: toggle, keywords: 'telemetry privacy' },
						{ id: 'privacyFeedback', title: localize('claudeSettingsPrivacyFeedback', "Send Feedback"), description: localize('claudeSettingsPrivacyFeedbackDesc', "Only when you send a report: what you write, and the screenshots, logs and system details you keep in it, go to Klawly's feedback relay"), control: { kind: 'statement' }, keywords: 'feedback relay report privacy' },
						{ id: 'privacyUpdates', title: localize('claudeSettingsPrivacyUpdates', "Update Checks"), description: localize('claudeSettingsPrivacyUpdatesDesc', "Alpha builds ask Klawly's relay for a newer alpha, sending the platform and build. Update: Mode set to none stops them"), control: { kind: 'command', label: localize('claudeSettingsPrivacyUpdatesButton', "Change"), command: 'workbench.action.openSettings', args: ['update.mode'] }, keywords: 'update relay alpha privacy' },
						// Issue 860: extensions that may start Klawly agents.
						{ id: 'extensionAgents', title: localize('claudeSettingsExtensionAgents', "Extensions That Start Agents"), description: localize('claudeSettingsExtensionAgentsDesc', "An extension is asked once before it may start a Klawly agent; revoke an answer here to be asked again. Agents start in your default permission mode"), control: { kind: 'extensionAgents' }, keywords: 'extension api agent start permission grant revoke allow deny privacy' },
						{ id: 'privacyExtensions', title: localize('claudeSettingsPrivacyExtensions', "Extensions"), description: localize('claudeSettingsPrivacyExtensionsDesc', "Searching, installing and updating extensions uses Open VSX (open-vsx.org)"), control: { kind: 'statement' }, keywords: 'open vsx marketplace gallery privacy' },
						{ id: 'privacyGitHub', title: localize('claudeSettingsPrivacyGitHub', "GitHub"), description: localize('claudeSettingsPrivacyGitHubDesc', "Pull request and issue cards in a session read from GitHub, with your GitHub sign-in when Accounts has one. Plugin marketplaces in Customize read from GitHub too"), control: { kind: 'statement' }, keywords: 'github pull request issue plugins privacy' },
						{ id: 'privacyOtel', title: localize('claudeSettingsPrivacyOtel', "OpenTelemetry Export"), description: localize('claudeSettingsPrivacyOtelDesc', "Claude Code's metrics and events go to the collector you set on Agents"), control: { kind: 'statement' }, keywords: 'otel otlp telemetry privacy', shownWhen: CLAUDE_OTEL_ENDPOINT_SETTING },
						{ id: 'privacyElse', title: localize('claudeSettingsPrivacyElse', "Nothing Else from Klawly"), description: localize('claudeSettingsPrivacyElseDesc', "No telemetry, and sessions stay on this machine. Extensions, MCP servers, Claude's web tools and editor features such as git remotes reach the network on their own"), control: { kind: 'statement' }, keywords: 'telemetry local privacy' },
					],
				},
				{
					id: 'privacyInstructions',
					title: localize('claudeSettingsPrivacyInstructions', "What Klawly Tells Claude"),
					rows: [
						// Read-only (issue 1172): the live text, so a user sees what a mode adds. The text is the model's prompt, so it stays in English.
						...CLAUDE_INJECTED_INSTRUCTIONS.map(({ id, title, text }) => ({ id, title, description: text, control: { kind: 'statement' as const }, keywords: 'prompt system instructions injected tells claude modes plan allow everything adhd reply style terminal' })),
					],
				},
				{
					id: 'privacySafeguards',
					title: localize('claudeSettingsPrivacySafeguards', "Before It Is Sent"),
					rows: [
						{ id: 'scanAttachments', key: CLAUDE_SECURITY_SCAN_ATTACHMENTS_SETTING, title: localize('claudeSettingsScan', "Check for Secrets"), description: localize('claudeSettingsScanDesc', "Look for keys and passwords in what you attach before it is sent"), control: toggle, keywords: 'security credentials secret guard privacy' },
					],
				},
			],
		},
		{
			id: 'models',
			title: localize('claudeSettingsModels', "Models"),
			description: localize('claudeSettingsModelsDesc', "Choose the models in the picker and how new agents start"),
			icon: Codicon.symbolClass,
			groupStart: true,
			sections: [
				{
					id: 'start',
					title: localize('claudeSettingsNewAgents', "New Agents"),
					rows: [
						{ id: 'defaultModel', key: CLAUDE_MODELS_DEFAULT_SETTING, title: localize('claudeSettingsDefaultModel', "Default Model"), description: localize('claudeSettingsDefaultModelDesc', "The model a new agent starts with"), control: { kind: 'model', emptyLabel: localize('claudeSettingsLastUsedModel', "Last Used") } },
						{ id: 'fastMode', key: CLAUDE_MODELS_FAST_MODE_SETTING, title: localize('claudeSettingsFast', "Fast Mode"), description: localize('claudeSettingsFastDesc', "Faster answers at a higher cost, on models that have it"), control: toggle },
						{ id: 'ultracode', key: CLAUDE_MODELS_ULTRACODE_SETTING, title: localize('claudeSettingsUltracode', "Ultracode"), description: localize('claudeSettingsUltracodeDesc', "Extra high effort, and Claude runs multi-step workflows on its own"), control: toggle, keywords: 'effort orchestration' },
						{ id: 'inlineModel', key: CLAUDE_INLINE_EDIT_MODEL_SETTING, title: localize('claudeSettingsInlineModel', "Inline Edit Model"), description: localize('claudeSettingsInlineModelDesc', "The model Ctrl+K uses"), control: { kind: 'model', emptyLabel: localize('claudeSettingsSameAsAgent', "Same as the Agent") } },
					],
				},
				{
					id: 'list',
					rows: [
						{ id: 'modelList', title: localize('claudeSettingsModelList', "Models"), description: localize('claudeSettingsModelListDesc', "Models in the picker, their effort, and custom model IDs"), control: { kind: 'modelList' }, keywords: 'effort custom enable picker' },
						// Issue 703: the notice after a model switch mid-chat.
						{ id: 'warnOnSwitch', key: CLAUDE_MODELS_WARN_ON_SWITCH_SETTING, title: localize('claudeSettingsWarnOnSwitch', "Warn When Switching Mid-Chat"), description: localize('claudeSettingsWarnOnSwitchDesc', "Say when a new model has to read the chat again without the cache"), control: toggle, keywords: 'model switch cache usage cost' },
					],
				},
			],
		},
		{
			id: 'git',
			title: localize('claudeSettingsGitPage', "Git and Pull Requests"),
			description: localize('claudeSettingsGitPageDesc', "How Claude Code commits, opens pull requests and names branches"),
			icon: Codicon.gitPullRequest,
			sections: [
				{
					id: 'commits',
					title: localize('claudeSettingsGitWorkflow', "Commits and Pull Requests"),
					rows: [
						{ id: 'commitAttribution', key: CLAUDE_GIT_COMMIT_ATTRIBUTION_SETTING, title: localize('claudeSettingsCommitAttribution', "Commit Attribution"), description: localize('claudeSettingsCommitAttributionDesc', "Claude Code adds its trailer to the commits it makes"), control: toggle, keywords: 'git co-authored-by trailer' },
						{ id: 'prAttribution', key: CLAUDE_GIT_PR_ATTRIBUTION_SETTING, title: localize('claudeSettingsPrAttribution', "Pull Request Attribution"), description: localize('claudeSettingsPrAttributionDesc', "Claude Code adds its line to the pull requests it opens"), control: toggle, keywords: 'git pr github' },
						{ id: 'gitInstructions', key: CLAUDE_GIT_INSTRUCTIONS_SETTING, title: localize('claudeSettingsGitInstructions', "Built-In Git Steps"), description: localize('claudeSettingsGitInstructionsDesc', "Claude Code's own way to commit and open pull requests"), control: toggle, keywords: 'git commit pr instructions prompt' },
						// Issue 502: a read-only review of each commit, whose findings land in Problems.
						{
							id: 'reviewAfterCommit', key: CLAUDE_REVIEW_AFTER_COMMIT_SETTING, title: localize('claudeSettingsReviewAfterCommit', "Review After Commit"), description: localize('claudeSettingsReviewAfterCommitDesc', "Claude reviews each new commit on its own and lists findings in Problems. To review the whole branch, run Review Branch Against Base (/review-branch)"), control: {
								kind: 'select', options: [
									{ value: 'off', label: localize('claudeSettingsReviewOff', "Off") },
									{ value: 'quick', label: localize('claudeSettingsReviewQuick', "Quick"), description: localize('claudeSettingsReviewQuickDesc', "One pass with the default model") },
									{ value: 'deep', label: localize('claudeSettingsReviewDeep', "Deep"), description: localize('claudeSettingsReviewDeepDesc', "One pass with Opus, slower and more thorough") },
								],
							}, keywords: 'git commit review findings problems',
						},
						{ id: 'reviewFixSends', key: CLAUDE_REVIEW_FIX_SENDS_SETTING, title: localize('claudeSettingsReviewFixSends', "Send Review Fixes at Once"), description: localize('claudeSettingsReviewFixSendsDesc', "Fix All and Fix with Agent send the fix to a new chat instead of leaving a draft. The chat's permission mode still decides what runs"), control: toggle, keywords: 'git commit review fix send draft' },
					],
				},
				{
					id: 'branches',
					title: localize('claudeSettingsBranches', "Branches"),
					rows: [
						{ id: 'branchPrefix', key: CLAUDE_GIT_BRANCH_PREFIX_SETTING, title: localize('claudeSettingsBranchPrefix', "Branch Prefix"), description: localize('claudeSettingsBranchPrefixDesc', "Begins every background agent's branch"), control: { kind: 'text', placeholder: CLAUDE_GIT_BRANCH_PREFIX_DEFAULT, short: true }, keywords: 'git background worktree' },
						{
							id: 'worktreeBase', key: CLAUDE_GIT_WORKTREE_BASE_SETTING, title: localize('claudeSettingsWorktreeBase', "Claude's Worktrees Start From"), description: localize('claudeSettingsWorktreeBaseDesc', "Where Claude Code's own worktrees branch from"), control: {
								kind: 'select', options: [
									{ value: 'fresh', label: localize('claudeSettingsWorktreeFresh', "Default Branch"), description: localize('claudeSettingsWorktreeFreshDesc', "The remote's default branch, a clean tree") },
									{ value: 'head', label: localize('claudeSettingsWorktreeHead', "Current Commit"), description: localize('claudeSettingsWorktreeHeadDesc', "Your HEAD, with unpushed work") },
								],
							}, keywords: 'git worktree isolation subagent',
						},
					],
				},
			],
		},
		{
			id: 'customize',
			title: localize('claudeSettingsCustomize', "Customize"),
			description: localize('claudeSettingsCustomizeDesc', "The MCP servers, skills, subagents, commands, hooks, network domains, permission rules and memory files Claude Code loads"),
			icon: Codicon.extensions,
			sections: [
				{
					// Its own section: the customize block draws only when it is alone in its section.
					id: 'claudeCodeSetup',
					rows: [
						// Issue 455: Klawly reads ~/.claude next to its own user layer, and never writes it.
						{ id: 'useClaudeCodeSetup', key: CLAUDE_USE_CLAUDE_CODE_SETUP_SETTING, title: localize('claudeSettingsUseClaudeCodeSetup', "Also Use My Claude Code Setup"), description: localize('claudeSettingsUseClaudeCodeSetupDesc', "Load your CLAUDE.md, settings, skills, subagents, commands and MCP servers from ~/.claude too. Klawly only reads them; yours for Klawly are in ~/.klawly/claude"), control: toggle, keywords: 'claude code ~/.claude user settings import global setup' },
					],
				},
				{
					id: 'customize',
					rows: [
						{ id: 'customize', title: localize('claudeSettingsCustomizeRow', "Customize"), description: localize('claudeSettingsCustomizeRowDesc', "MCP servers, skills, subagents, commands and CLAUDE.md memory"), control: { kind: 'customize' }, keywords: 'mcp servers skills subagents agents commands slash memory claude.md plugins tools rules hooks create' },
					],
				},
			],
		},
		{
			id: 'tab',
			title: localize('claudeSettingsTab', "Tab"),
			icon: Codicon.arrowRight,
			sections: [
				{
					id: 'tab',
					rows: [
						{ id: 'autocomplete', key: CLAUDE_AUTOCOMPLETE_ENABLED_SETTING, title: localize('claudeSettingsTabEnabled', "Tab Suggestions"), description: localize('claudeSettingsTabEnabledDesc', "Suggest the next edit as you type"), control: toggle, keywords: 'autocomplete completions' },
						{ id: 'tabModel', key: CLAUDE_AUTOCOMPLETE_MODEL_SETTING, title: localize('claudeSettingsTabModel', "Tab Model"), description: localize('claudeSettingsTabModelDesc', "The model that writes suggestions"), control: { kind: 'model', emptyLabel: localize('claudeSettingsClaudeDefault', "Claude Code Default") }, keywords: 'autocomplete' },
						{ id: 'debounce', key: CLAUDE_AUTOCOMPLETE_DEBOUNCE_SETTING, title: localize('claudeSettingsDebounce', "Delay"), description: localize('claudeSettingsDebounceDesc', "Pause after typing before a suggestion is requested"), control: { kind: 'number', min: CLAUDE_AUTOCOMPLETE_DEBOUNCE_MIN_MS, max: CLAUDE_AUTOCOMPLETE_DEBOUNCE_MAX_MS, unit: localize('claudeSettingsMs', "ms") }, keywords: 'autocomplete debounce' },
					],
				},
			],
		},
		{
			id: 'beta',
			title: localize('claudeSettingsBeta', "Beta"),
			icon: Codicon.beaker,
			sections: [
				{
					id: 'beta',
					rows: [
						{ id: 'preview', key: CLAUDE_PREVIEW_ENABLED_SETTING, title: localize('claudeSettingsPreview', "Browser Preview"), description: localize('claudeSettingsPreviewDesc', "Preview local dev servers in an editor tab"), control: toggle },
						{ id: 'retainRaw', key: CLAUDE_DEBUG_RETAIN_RAW_SETTING, title: localize('claudeSettingsRetainRaw', "Keep Raw Messages"), description: localize('claudeSettingsRetainRawDesc', "Keep the raw Claude Code stream for the session inspector"), control: toggle, keywords: 'debug inspector' },
						{ id: 'debugTerminalLines', key: CLAUDE_DEBUG_TERMINAL_LINES_SETTING, title: localize('claudeSettingsDebugTerminalLines', "Send Terminal Output When Reproducing"), description: localize('claudeSettingsDebugTerminalLinesDesc', "Debug mode sends terminal lines with the logs; turn off if terminals can show secrets"), control: toggle, keywords: 'debug reproduce terminal secrets' },
						{ id: 'redetect', title: localize('claudeSettingsRedetect', "Find Claude Code Again"), description: localize('claudeSettingsRedetectDesc', "Look for the Claude Code install and sign-in again"), control: { kind: 'command', label: localize('claudeSettingsRedetectButton', "Detect"), command: CLAUDE_REDETECT_RUNTIME_COMMAND_ID } },
					],
				},
			],
		},
	];
}

function words(text: string): string[] {
	return text.toLowerCase().split(/[\s.,&/()-]+/).filter(word => word.length > 0);
}

/**
 * The rows whose title, description, setting key, section, page or keywords
 * hold every word of `query`, each as the start of a word. Rows keep page order.
 */
export function searchClaudeSettings(pages: readonly ClaudeSettingsPage[], query: string): ClaudeSettingsMatch[] {
	const terms = words(query);
	if (terms.length === 0) {
		return [];
	}
	const matches: ClaudeSettingsMatch[] = [];
	for (const page of pages) {
		for (const section of page.sections) {
			for (const row of section.rows) {
				const haystack = words([row.title, row.description, row.key ?? '', row.keywords ?? '', section.title ?? '', page.title].join(' '));
				if (terms.every(term => haystack.some(word => word.startsWith(term)))) {
					matches.push({ page, section, row });
				}
			}
		}
	}
	return matches;
}

/** Where a search that Klawly Settings cannot answer belongs: a VS Code command that opens the right picker. */
export interface ClaudeSettingsSearchHint {
	readonly message: string;
	readonly label: string;
	readonly command: string;
}

/**
 * The hint for a search that finds no Klawly setting but names something VS Code owns (issue 904, DL-30).
 * "theme" is the one users ask for most: the color theme is picked in VS Code, not in Klawly Settings.
 * Returns undefined for any other query.
 */
export function claudeSettingsSearchHint(query: string): ClaudeSettingsSearchHint | undefined {
	const terms = words(query);
	const has = (...wanted: string[]) => terms.some(term => wanted.includes(term));
	if (has('icon', 'icons') && has('theme', 'themes')) {
		return {
			message: localize('claudeSettingsHintIconTheme', "File icon themes are chosen from the Command Palette, not in Klawly Settings."),
			label: localize('claudeSettingsHintIconThemeButton', "Choose File Icon Theme"),
			command: 'workbench.action.selectIconTheme',
		};
	}
	if (has('theme', 'themes', 'color', 'colors', 'colour', 'colours', 'dark', 'light')) {
		return {
			message: localize('claudeSettingsHintTheme', "The color theme is chosen from the Command Palette, not in Klawly Settings."),
			label: localize('claudeSettingsHintThemeButton', "Choose Color Theme"),
			command: 'workbench.action.selectTheme',
		};
	}
	return undefined;
}

/** How the account row and the nav's account block describe Claude Code's sign-in. */
export interface ClaudeAccountSummary {
	readonly label: string;
	readonly detail: string;
	readonly action?: { readonly label: string; readonly command: string };
}

/** Describes the runtime's install and sign-in state in our words, with the one action that fixes it. */
export function claudeAccountSummary(state: ClaudeRuntimeState | undefined): ClaudeAccountSummary {
	if (!state) {
		return { label: localize('claudeAccountChecking', "Checking..."), detail: localize('claudeAccountCheckingDetail', "Looking for Claude Code on this machine.") };
	}
	if (!state.installed) {
		return {
			label: localize('claudeAccountNotInstalled', "Not installed"),
			detail: localize('claudeAccountNotInstalledDetail', "Klawly runs your agents with Claude Code. Install it to start."),
			action: { label: localize('claudeAccountInstall', "Install"), command: CLAUDE_INSTALL_RUNTIME_COMMAND_ID },
		};
	}
	if (!state.authenticated) {
		return {
			label: localize('claudeAccountSignedOut', "Signed out"),
			detail: localize('claudeAccountSignedOutDetail', "Sign in to Claude Code to run agents."),
			action: { label: localize('claudeAccountSignIn', "Sign In"), command: CLAUDE_SIGN_IN_COMMAND_ID },
		};
	}
	const version = state.version ? localize('claudeAccountVersion', "Claude Code {0}", state.version) : localize('claudeAccountNoVersion', "Claude Code");
	switch (state.authMode) {
		case 'claude-account':
			return { label: localize('claudeAccountClaude', "Claude account"), detail: localize('claudeAccountClaudeDetail', "{0}, signed in with your Claude account", version) };
		case 'api-key':
			return { label: localize('claudeAccountApiKey', "API key"), detail: localize('claudeAccountApiKeyDetail', "{0}, signed in with an API key", version) };
		case 'enterprise':
			return { label: localize('claudeAccountEnterprise', "Enterprise"), detail: localize('claudeAccountEnterpriseDetail', "{0}, signed in through your organization", version) };
		case 'bedrock':
			return { label: localize('claudeAccountBedrock', "Amazon Bedrock"), detail: localize('claudeAccountBedrockDetail', "{0}, signed in through Amazon Bedrock", version) };
		case 'vertex':
			return { label: localize('claudeAccountVertex', "Google Vertex AI"), detail: localize('claudeAccountVertexDetail', "{0}, signed in through Google Vertex AI", version) };
		default:
			return { label: localize('claudeAccountSignedIn', "Signed in"), detail: localize('claudeAccountSignedInDetail', "{0}, signed in", version) };
	}
}

/** A plan name as people say it: `max` is "Max", an unknown plan keeps its own name. */
export function claudePlanLabel(plan: string): string {
	switch (plan.toLowerCase()) {
		case 'free': return localize('claudePlanFree', "Free");
		case 'pro': return localize('claudePlanPro', "Pro");
		case 'max': return localize('claudePlanMax', "Max");
		case 'team': return localize('claudePlanTeam', "Team");
		case 'enterprise': return localize('claudePlanEnterprise', "Enterprise");
		default: return plan.charAt(0).toUpperCase() + plan.slice(1);
	}
}

/** The title of one plan limit's meter. */
export function claudeUsageWindowTitle(window: ClaudeUsageWindow): string {
	switch (window.kind) {
		case 'session': return localize('claudeUsageSession', "Current Session");
		case 'week': return localize('claudeUsageWeek', "This Week");
		case 'weekOpus': return localize('claudeUsageWeekOpus', "This Week, Opus");
		case 'weekSonnet': return localize('claudeUsageWeekSonnet', "This Week, Sonnet");
		case 'model': return window.label ? localize('claudeUsageModel', "This Week, {0}", window.label) : localize('claudeUsageModelUnnamed', "This Week, One Model");
	}
}

/** What each meter says under its bar: what the window counts. */
export function claudeUsageWindowNote(window: ClaudeUsageWindow): string {
	switch (window.kind) {
		case 'session': return localize('claudeUsageSessionNote', "Every model, over a rolling five hours");
		case 'week': return localize('claudeUsageWeekNote', "Every model, over seven days");
		default: return localize('claudeUsageFamilyNote', "These models only, over seven days");
	}
}

/** The kinds of things the Customize page lists, each behind a filter chip. */
export type ClaudeCustomizeKind = 'mcp' | 'skills' | 'subagents' | 'commands' | 'hooks' | 'network' | 'permissions' | 'memory' | 'rules';

export const CLAUDE_CUSTOMIZE_KINDS: readonly ClaudeCustomizeKind[] = ['mcp', 'skills', 'subagents', 'commands', 'hooks', 'network', 'permissions', 'memory', 'rules'];

/** The chip and section title of a kind. */
export function claudeCustomizeKindLabel(kind: ClaudeCustomizeKind): string {
	switch (kind) {
		case 'mcp': return localize('claudeCustomizeMcp', "MCP Servers");
		case 'skills': return localize('claudeCustomizeSkills', "Skills");
		case 'subagents': return localize('claudeCustomizeSubagents', "Subagents");
		case 'commands': return localize('claudeCustomizeCommands', "Commands");
		case 'hooks': return localize('claudeCustomizeHooks', "Hooks");
		case 'network': return localize('claudeCustomizeNetwork', "Network Domains");
		case 'permissions': return localize('claudeCustomizePermissions', "Permission Rules");
		case 'memory': return localize('claudeCustomizeMemory', "Memory");
		case 'rules': return localize('claudeCustomizeRules', "Rules");
	}
}

/** Who an MCP server is for, as the Add Server form and the rows say it. */
export function claudeMcpScopeLabel(scope: ClaudeMcpScope): string {
	switch (scope) {
		case 'local': return localize('claudeMcpScopeLocal', "Local");
		case 'project': return localize('claudeMcpScopeProject', "Project");
		case 'user': return localize('claudeMcpScopeUser', "User");
	}
}

/** Where something added in Customize applies, in plain words: the Saved In and Scope pickers (issue 455, DL-82). */
export function claudeWhereLabel(scope: ClaudeHookScope | ClaudeMcpScope): string {
	switch (scope) {
		case 'user': return localize('claudeWhereUser', "For Me, in Every Project");
		case 'project': return localize('claudeWhereProject', "For This Project, Shared with the Team");
		case 'local': return localize('claudeWhereLocal', "For This Project, Only Me");
	}
}

/** Which settings file a hook is in. */
export function claudeHookScopeLabel(scope: ClaudeHookScope): string {
	switch (scope) {
		case 'project': return localize('claudeHookScopeProject', "Project");
		case 'local': return localize('claudeHookScopeLocal', "Local");
		case 'user': return localize('claudeHookScopeUser', "User");
	}
}

/** A memory file Claude Code reads at the start of a session. */
export interface ClaudeMemoryFile {
	/** Where it is, for the row's second line: a workspace-relative path or `~/.klawly/claude/CLAUDE.md`. */
	readonly label: string;
	/**
	 * `agents` is the workspace's AGENTS.md, which Klawly passes when no CLAUDE.md imports it (issue 499).
	 * `user` is your Klawly rules for every project; `claudeCode` is Claude Code's own `~/.claude/CLAUDE.md`,
	 * read while Also Use My Claude Code Setup is on and never written (issue 455).
	 */
	readonly scope: 'project' | 'local' | 'user' | 'claudeCode' | 'managed' | 'agents';
	/** Your rules file is listed before it exists; opening the row creates it. */
	readonly missing?: boolean;
	/** A string the editor resolves back to the file. */
	readonly id: string;
	/** The row's name, for a managed file (issue 523): the organization's memory or settings. */
	readonly name?: string;
}

/** What a from-Claude-Code row copies into Klawly's own settings: a file under `~/.claude`, or one entry of its `settings.json` (issue 807). */
export type ClaudeCopySource =
	| { readonly type: 'file'; readonly path: readonly string[] }
	| { readonly type: 'hook'; readonly hook: ClaudeHookEntry }
	| { readonly type: 'network'; readonly rule: ClaudeNetworkRule }
	| { readonly type: 'permission'; readonly rule: ClaudePermissionRule };

/** One row of the Customize list. */
export interface ClaudeCustomizeItem {
	readonly kind: ClaudeCustomizeKind;
	readonly id: string;
	readonly name: string;
	readonly detail: string;
	/** An MCP server's state, drawn as a badge. */
	readonly state?: ClaudeMcpServerState;
	/** An MCP server added here that no session has loaded yet. */
	readonly pending?: boolean;
	/** The scope `claude mcp remove` takes, when Klawly can remove the server. */
	readonly mcpScope?: ClaudeMcpScope;
	/** The hook this row is. */
	readonly hook?: ClaudeHookEntry;
	/** The installed Claude Code plugin the row comes from. */
	readonly plugin?: string;
	/** The allowed or denied domain this row is. */
	readonly networkRule?: ClaudeNetworkRule;
	/** The allow or deny permission rule this row is (issue 868). */
	readonly permissionRule?: ClaudePermissionRule;
	/** The file a rule or a skill, subagent or command written here opens, as the editor knows it. */
	readonly file?: string;
	/** A file Claude Code's managed folder holds: only an administrator changes it (issue 523, DL-26). */
	readonly managed?: boolean;
	/** Set on a row that comes from `~/.claude`: it opens read only and Copy to Klawly copies it (issue 807, DL-102). */
	readonly copyFrom?: ClaudeCopySource;
}

/** What the Customize page lists from. */
export interface ClaudeCustomizeSource {
	readonly overview: ClaudeAccountOverview | undefined;
	readonly memory: readonly ClaudeMemoryFile[];
	readonly hooks: readonly ClaudeHookEntry[];
	/** The domains the same settings files allow or deny. */
	readonly networkRules: readonly ClaudeNetworkRule[];
	/** The hooks and domains of Claude Code's own `~/.claude/settings.json`: listed, never changed (issue 455). */
	readonly claudeCodeHooks?: readonly ClaudeHookEntry[];
	readonly claudeCodeNetworkRules?: readonly ClaudeNetworkRule[];
	/** The allow and deny permission rules of the same settings files (issue 868). */
	readonly permissionRules?: readonly ClaudePermissionRule[];
	readonly claudeCodePermissionRules?: readonly ClaudePermissionRule[];
	/** MCP servers added here since the last refresh. Each shows until a session reports it. */
	readonly addedMcp: readonly ClaudeMcpAddRequest[];
	/** `<scope>:<name>` of the servers removed here since the last refresh. */
	readonly removedMcp: ReadonlySet<string>;
	/** The Claude Code plugins installed for you and in this project. */
	readonly plugins?: readonly ClaudeInstalledPlugin[];
	/** The `.claude/rules` files of the project and of `~/.klawly/claude`. */
	readonly rules?: readonly ClaudeRuleFile[];
	/** Skills, subagents and commands written here. Each shows until a session reports it. */
	readonly created?: readonly ClaudeCreatedFile[];
}

/** The key `ClaudeCustomizeSource.removedMcp` holds. */
export function claudeMcpKey(scope: string | undefined, name: string): string {
	return `${scope ?? ''}:${name}`;
}

function commandSourceLabel(source: ClaudeCommandInfo['source']): string {
	switch (source) {
		case 'builtin': return localize('claudeCommandBuiltin', "Built in");
		case 'project': return localize('claudeCommandProject', "Project");
		case 'user': return localize('claudeCommandUser', "User");
		case 'plugin': return localize('claudeCommandPlugin', "Plugin");
		case 'mcp': return localize('claudeCommandMcp', "MCP");
		default: return localize('claudeCommandOther', "Other");
	}
}

/** Commands you wrote come first, Claude Code's own last. */
const COMMAND_ORDER: readonly ClaudeCommandInfo['source'][] = ['project', 'user', 'plugin', 'mcp', 'other', 'builtin'];

function mcpDetail(server: ClaudeMcpServerInfo): string {
	if (server.state === 'failed' && server.error) {
		return server.error;
	}
	const tools = server.toolCount === 1 ? localize('claudeMcpOneTool', "1 tool") : localize('claudeMcpTools', "{0} tools", server.toolCount);
	if (server.scope === CLAUDE_CODE_MCP_SCOPE) {
		return fromClaudeCode(tools);
	}
	return server.scope ? localize('claudeMcpDetail', "{0} · {1}", tools, server.scope) : tools;
}

/** Klawly removes your servers and the project's; `local` ones live in Claude Code's `~/.claude.json`, which it never writes (issue 455). */
function removableMcpScope(scope: string | undefined): ClaudeMcpScope | undefined {
	const known = readClaudeMcpScope(scope);
	return known === 'local' ? undefined : known;
}

function addedMcpItem(request: ClaudeMcpAddRequest): ClaudeCustomizeItem {
	const target = request.config.type === 'stdio' ? [request.config.command, ...request.config.args].join(' ') : request.config.url;
	return { kind: 'mcp', id: request.name, name: request.name, detail: localize('claudeMcpAddedDetail', "{0} · {1}", target, request.scope), pending: true, mcpScope: request.scope };
}

function hookName(event: string, matcher: string | undefined): string {
	return matcher ? localize('claudeHookName', "{0} · {1}", event, matcher) : event;
}

/** A skill from the workspace's `.agents/skills` says so (issue 499); the others keep their description. */
function agentsSkillDetail(command: ClaudeCommandInfo): string {
	if (!command.name.startsWith(`${CLAUDE_AGENTS_SKILLS_PLUGIN}:`)) {
		return command.description;
	}
	return command.description ? localize('claudeSkillFromAgentsDetail', "{0} · from .agents", command.description) : localize('claudeSkillFromAgents', "From .agents");
}

/** A row's second line with the plugin it comes from. */
function fromPlugin(detail: string, plugin: string): string {
	return detail ? localize('claudeCustomizeFromPlugin', "{0} · from {1}", detail, plugin) : localize('claudeCustomizeFrom', "From {0}", plugin);
}

/** A row's second line for what Claude Code's own `~/.claude` holds: Klawly lists it and never changes it (issue 455, DL-82). */
function fromClaudeCode(detail: string): string {
	return localize('claudeCustomizeFromClaudeCode', "{0} · from Claude Code", detail);
}

function hookItem(hook: ClaudeHookEntry): ClaudeCustomizeItem {
	return {
		kind: 'hooks',
		id: `${hook.scope}:${hook.event}:${hook.group}:${hook.index}`,
		name: hookName(hook.event, hook.matcher),
		detail: localize('claudeHookDetail', "{0} · {1}", claudeHookScopeLabel(hook.scope), hook.command),
		hook,
	};
}

function networkItem(rule: ClaudeNetworkRule): ClaudeCustomizeItem {
	const effect = rule.effect === 'allow' ? localize('claudeNetworkAllowed', "Allowed") : localize('claudeNetworkDenied', "Denied");
	const carriers = rule.webFetch && rule.sandbox ? localize('claudeNetworkBoth', "WebFetch and sandbox")
		: rule.webFetch ? localize('claudeNetworkWebFetch', "WebFetch only") : localize('claudeNetworkSandbox', "Sandbox only");
	return {
		kind: 'network',
		id: `${rule.scope}:${rule.effect}:${rule.domain}`,
		name: rule.domain,
		detail: localize('claudeNetworkDetail', "{0} · {1} · {2}", effect, claudeHookScopeLabel(rule.scope), carriers),
		networkRule: rule,
	};
}

function permissionItem(rule: ClaudePermissionRule): ClaudeCustomizeItem {
	const effect = rule.effect === 'allow' ? localize('claudePermissionAllowed', "Allowed") : localize('claudePermissionDenied', "Denied");
	return {
		kind: 'permissions',
		id: `${rule.scope}:${rule.effect}:${rule.rule}`,
		name: rule.rule,
		detail: localize('claudePermissionDetail', "{0} · {1}", effect, claudeHookScopeLabel(rule.scope)),
		permissionRule: rule,
	};
}

function memoryName(scope: ClaudeMemoryFile['scope']): string {
	switch (scope) {
		case 'user': return localize('claudeMemoryUser', "Your Rules");
		case 'claudeCode': return localize('claudeMemoryClaudeCode', "Claude Code Memory");
		case 'local': return localize('claudeMemoryLocal', "Local Project Memory");
		case 'agents': return localize('claudeMemoryAgents', "AGENTS.md");
		default: return localize('claudeMemoryProject', "Project Memory");
	}
}

function memoryDetail(file: ClaudeMemoryFile): string {
	if (file.scope === 'claudeCode') {
		return fromClaudeCode(file.label);
	}
	return file.missing ? localize('claudeMemoryMissing', "{0} · Not created yet. Open it to write instructions for every project", file.label) : file.label;
}

function ruleItem(rule: ClaudeRuleFile): ClaudeCustomizeItem {
	const paths = rule.paths.length ? rule.paths.join(', ') : localize('claudeRuleAlways', "Every session");
	if (rule.scope === 'claudeCode') {
		return { kind: 'rules', id: rule.id, name: rule.name, detail: fromClaudeCode(paths), file: rule.id, copyFrom: { type: 'file', path: ['rules', ...`${rule.name}.md`.split('/')] } };
	}
	return { kind: 'rules', id: rule.id, name: rule.name, detail: localize('claudeRuleDetail', "{0} · {1}", claudeHookScopeLabel(rule.scope), paths), file: rule.id };
}

function createdItem(created: ClaudeCreatedFile): ClaudeCustomizeItem {
	const scope = claudeHookScopeLabel(created.scope);
	return {
		kind: created.kind,
		id: created.name,
		name: created.kind === 'commands' ? `/${created.name}` : created.name,
		detail: created.description ? localize('claudeCreatedDetail', "{0} · {1}", scope, created.description) : scope,
		pending: true,
		file: created.id,
	};
}

/** The second line of the sandbox row: whether it can start here, and what to install first. */
export function claudeSandboxStatusText(status: ClaudeSandboxStatus | undefined): string {
	if (!status) {
		return localize('claudeSandboxStatusUnknown', "Klawly cannot check this here. Claude Code checks it when a sandboxed turn starts");
	}
	switch (status.state) {
		case 'ready':
			return status.platform === 'darwin'
				? localize('claudeSandboxReadyMac', "macOS has the Seatbelt sandbox Claude Code uses built in")
				: localize('claudeSandboxReadyLinux', "bubblewrap and socat are installed, so Claude Code's sandbox can start here");
		case 'missing':
			if (status.missing.includes('WSL 2')) {
				return localize('claudeSandboxWsl1', "Claude Code sandboxes only in WSL 2. Convert this distribution with wsl --set-version");
			}
			if (status.platform === 'win32') {
				return localize('claudeSandboxGitBash', "Install Git for Windows first: Claude Code runs sandboxed commands in Git Bash");
			}
			return localize('claudeSandboxInstall', "Install {0} first, for example with apt install {1}. Until then a sandboxed turn fails", status.missing.join(', '), status.missing.join(' '));
		case 'setup':
			return status.platform === 'win32'
				? localize('claudeSandboxWindowsSetup', "Claude Code's Windows sandbox needs a one-time /sandbox install, with one administrator prompt, and may not be available yet. If it cannot start, the turn shows Claude Code's own message")
				: localize('claudeSandboxCheckLater', "Claude Code checks what its sandbox needs when a sandboxed turn starts");
		case 'unsupported':
			return localize('claudeSandboxUnsupported', "Claude Code sandboxes only on macOS, Linux and WSL 2, so a sandboxed turn fails here");
	}
}

/** The badge of the sandbox row. */
export function claudeSandboxStatusBadge(status: ClaudeSandboxStatus | undefined): { readonly label: string; readonly className: string } | undefined {
	switch (status?.state) {
		case 'ready': return { label: localize('claudeSandboxBadgeReady', "Ready"), className: 'is-success' };
		case 'missing': return { label: localize('claudeSandboxBadgeMissing', "Install First"), className: 'is-warning' };
		case 'setup': return { label: localize('claudeSandboxBadgeSetup', "Checked at Start"), className: 'is-idle' };
		case 'unsupported': return { label: localize('claudeSandboxBadgeUnsupported', "Not Supported"), className: 'is-warning' };
		default: return undefined;
	}
}

/**
 * The rows of one kind, filtered by every word of `query` against the name and
 * the second line. Skills are the commands Claude Code marks as skills; every
 * other command is under Commands.
 */
export function claudeCustomizeItems(source: ClaudeCustomizeSource, kind: ClaudeCustomizeKind, query = ''): ClaudeCustomizeItem[] {
	const { overview, memory } = source;
	let items: ClaudeCustomizeItem[];
	switch (kind) {
		case 'mcp': {
			const loaded = (overview?.mcpServers ?? []).filter(server => !source.removedMcp.has(claudeMcpKey(server.scope, server.name)));
			items = loaded.map(server => ({ kind, id: server.name, name: server.name, detail: mcpDetail(server), state: server.state, mcpScope: removableMcpScope(server.scope) }));
			for (const added of source.addedMcp) {
				if (!loaded.some(server => server.name === added.name) && !source.removedMcp.has(claudeMcpKey(added.scope, added.name))) {
					items.push(addedMcpItem(added));
				}
			}
			break;
		}
		case 'skills':
			items = (overview?.commands ?? []).filter(command => command.source === 'skill').map(command => ({ kind, id: command.name, name: command.name, detail: agentsSkillDetail(command) }));
			break;
		case 'subagents':
			items = (overview?.agents ?? []).map(agent => ({ kind, id: agent.name, name: agent.name, detail: agent.model ? localize('claudeSubagentDetail', "{0} · {1}", agent.description, agent.model) : agent.description }));
			break;
		case 'commands':
			items = (overview?.commands ?? [])
				.filter(command => command.source !== 'skill')
				.sort((a, b) => COMMAND_ORDER.indexOf(a.source) - COMMAND_ORDER.indexOf(b.source))
				.map(command => ({ kind, id: command.name, name: `/${command.name}`, detail: command.description ? localize('claudeCommandDetail', "{0} · {1}", commandSourceLabel(command.source), command.description) : commandSourceLabel(command.source) }));
			break;
		case 'hooks':
			items = source.hooks.map(hookItem);
			// No hook on these rows: they have no edit or remove, since Klawly never writes ~/.claude.
			for (const hook of source.claudeCodeHooks ?? []) {
				items.push({ kind, id: `claudeCode:${hook.event}:${hook.group}:${hook.index}`, name: hookName(hook.event, hook.matcher), detail: fromClaudeCode(hook.command), copyFrom: { type: 'hook', hook } });
			}
			// A plugin's hooks live in the plugin, so their rows have no edit or remove.
			for (const plugin of source.plugins ?? []) {
				plugin.contents.hooks.forEach((hook, index) => items.push({
					kind,
					id: `plugin:${plugin.id}:${index}`,
					name: hookName(hook.event, hook.matcher),
					detail: fromPlugin(hook.command, plugin.name),
					plugin: plugin.name,
				}));
			}
			break;
		case 'network':
			items = source.networkRules.map(networkItem);
			for (const rule of source.claudeCodeNetworkRules ?? []) {
				const { networkRule: _rule, ...row } = networkItem(rule);
				items.push({ ...row, copyFrom: { type: 'network', rule }, id: `claudeCode:${rule.effect}:${rule.domain}`, detail: fromClaudeCode(rule.effect === 'allow' ? localize('claudeNetworkAllowed', "Allowed") : localize('claudeNetworkDenied', "Denied")) });
			}
			break;
		case 'permissions':
			items = (source.permissionRules ?? []).map(permissionItem);
			for (const rule of source.claudeCodePermissionRules ?? []) {
				const { permissionRule: _rule, ...row } = permissionItem(rule);
				items.push({ ...row, copyFrom: { type: 'permission', rule }, id: `claudeCode:${rule.effect}:${rule.rule}`, detail: fromClaudeCode(rule.effect === 'allow' ? localize('claudePermissionAllowed', "Allowed") : localize('claudePermissionDenied', "Denied")) });
			}
			break;
		case 'memory':
			items = memory.map(file => ({ kind, id: file.id, name: file.name ?? memoryName(file.scope), detail: memoryDetail(file), ...(file.scope === 'managed' ? { managed: true } : {}), ...(file.scope === 'claudeCode' ? { copyFrom: { type: 'file' as const, path: ['CLAUDE.md'] } } : {}) }));
			break;
		case 'rules':
			items = (source.rules ?? []).map(ruleItem);
			break;
	}
	// What Customize just wrote shows until a session lists it.
	for (const created of source.created ?? []) {
		if (created.kind === kind && !items.some(item => item.id === created.name)) {
			items.push(createdItem(created));
		}
	}
	if (source.plugins?.length && kind !== 'hooks' && kind !== 'memory' && kind !== 'network' && kind !== 'permissions' && kind !== 'rules') {
		const plugins = source.plugins;
		items = items.map(item => {
			const command = kind === 'commands' ? overview?.commands?.find(entry => entry.name === item.id) : undefined;
			// Commands you or the project wrote never come from a plugin, whatever their name.
			const origin = command && command.source !== 'plugin' ? undefined : claudePluginOrigin(plugins, kind, item.id);
			return origin ? { ...item, plugin: origin.name, detail: fromPlugin(item.detail, origin.name) } : item;
		});
	}
	const terms = words(query);
	return terms.length === 0 ? items : items.filter(item => {
		const haystack = words(`${item.name} ${item.detail}`);
		return terms.every(term => haystack.some(word => word.startsWith(term)));
	});
}
