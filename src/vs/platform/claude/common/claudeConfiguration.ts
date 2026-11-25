/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeAgentsFilesSettings } from './claudeAgentsFiles.js';
import { AgentMode } from './claudeContext.js';
import { DEFAULT_PERMISSION_POLICY, PermissionPolicy } from './claudePermissions.js';
import { ClaudeEffortLevel, ClaudeSessionSettings, isClaudeEffortLevel } from './claudeSessionSettings.js';

/** `fake` replays the built-in test script. `live` uses the Node Agent SDK runner. */
export const CLAUDE_AGENT_RUNTIME_SETTING = 'claude.agent.runtime';

/** Absolute path to the Claude Code executable. Empty uses `PATH`. */
export const CLAUDE_AGENT_RUNTIME_PATH_SETTING = 'claude.agent.runtimePath';

/** When false, action buttons always use the built-in template. */
export const CLAUDE_ACTIONS_PREFER_COMMANDS_SETTING = 'claude.actions.preferClaudeCommands';

/** Pastes at least this many characters become a pasted-text pill (spec 46, issue 737). */
export const CLAUDE_LONG_PASTE_SETTING = 'claude.composer.longPasteChipChars';

/**
 * Name used before spec 46 settled on {@link CLAUDE_LONG_PASTE_SETTING}. A configuration
 * migration moves it, and readers still fall back to it until that has run.
 */
export const CLAUDE_LEGACY_LONG_PASTE_SETTING = 'claude.composer.longPasteCharacters';

export const CLAUDE_LONG_PASTE_DEFAULT = 2000;

/** How long unreferenced checkpoint objects are kept. */
export const CLAUDE_CHECKPOINT_RETENTION_SETTING = 'claude.agent.retainSessionDays';

/** When false, turns do not record snapshots. */
export const CLAUDE_CHECKPOINTS_ENABLED_SETTING = 'claude.checkpoints.enabled';

/** When true, the session inspector can show raw SDK messages. */
export const CLAUDE_DEBUG_RETAIN_RAW_SETTING = 'claude.debug.retainRawEvents';

/** When false, Debug mode's reproductions leave terminal output out of what Claude reads (issue 1061). */
export const CLAUDE_DEBUG_TERMINAL_LINES_SETTING = 'claude.debug.includeTerminalOutput';

/** Cap for the summary inside a chat-reference chip. The file still holds the export. */
export const CLAUDE_CHAT_REFERENCE_SUMMARY_SETTING = 'claude.chatReferences.summaryChars';

export type ClaudeAgentRuntimeKind = 'fake' | 'live';

/**
 * Only an explicit `fake` selects the test script. A missing value is `live`,
 * because the shared process does not load workbench configuration defaults.
 */
export function readClaudeAgentRuntimeKind(value: unknown): ClaudeAgentRuntimeKind {
	return value === 'fake' ? 'fake' : 'live';
}

export function readClaudeAgentRuntimePath(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** One setting per `PermissionPolicy` field except `readWorkspace`, which {@link CLAUDE_AGENT_AUTO_APPROVE_READS_SETTING} sets. */
export const CLAUDE_PERMISSION_SETTINGS = {
	writeWorkspace: 'claude.agent.permissions.writeWorkspace',
	writeOutsideWorkspace: 'claude.agent.permissions.writeOutsideWorkspace',
	shellSafe: 'claude.agent.permissions.shellSafe',
	shellDestructive: 'claude.agent.permissions.shellDestructive',
	network: 'claude.agent.permissions.network',
} as const;

/**
 * Builds the host policy from setting values. A missing or unknown value takes
 * the default, which is the more cautious reading, so a bad settings file cannot
 * loosen the policy.
 */
export function readClaudePermissionPolicy(get: (key: string) => unknown): PermissionPolicy {
	const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
		const value = get(key);
		return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
	};
	const preset = readClaudePermissionPreset(get(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING));
	const strict = preset === 'strict';
	// The setting's own default is `ask`: Agent's write default comes from the preset below.
	const writeWorkspace = pick(CLAUDE_PERMISSION_SETTINGS.writeWorkspace, ['ask', 'allow'], 'ask');
	const network = pick(CLAUDE_PERMISSION_SETTINGS.network, ['ask', 'allow', 'deny'], DEFAULT_PERMISSION_POLICY.network);
	return {
		// Only an explicit false makes workspace reads ask. The PreToolUse screen
		// enforces it, because Claude Code would otherwise read without a request.
		readWorkspace: get(CLAUDE_AGENT_AUTO_APPROVE_READS_SETTING) === false ? 'ask' : 'allow',
		// Each of the three is an opt-in, so any one of them allows workspace writes.
		writeWorkspace: writeWorkspace === 'allow' || get(CLAUDE_AGENT_AUTO_APPROVE_WRITES_SETTING) === true || preset === 'acceptEdits' || preset === 'auto' ? 'allow' : 'ask',
		// Strict turns the questions below into refusals. It never loosens a choice.
		writeOutsideWorkspace: strict ? 'deny' : pick(CLAUDE_PERMISSION_SETTINGS.writeOutsideWorkspace, ['ask', 'deny'], DEFAULT_PERMISSION_POLICY.writeOutsideWorkspace),
		shellSafe: pick(CLAUDE_PERMISSION_SETTINGS.shellSafe, ['allow', 'ask'], DEFAULT_PERMISSION_POLICY.shellSafe),
		shellDestructive: strict ? 'deny' : pick(CLAUDE_PERMISSION_SETTINGS.shellDestructive, ['ask', 'deny'], DEFAULT_PERMISSION_POLICY.shellDestructive),
		network: strict && network === 'ask' ? 'deny' : network,
	};
}

/**
 * `claude.agent.defaultPermissionMode` (spec 46) is the permission level of every
 * session (issue 453), a preset over the policy above.
 * - `strict` (the default for a new install) also asks for workspace edits, and refuses
 *   what would otherwise ask for writes outside the workspace, destructive commands,
 *   and network access.
 * - `prompt` keeps the individual settings, so workspace edits ask unless
 *   `claude.agent.permissions.writeWorkspace` or `claude.agent.autoApproveWorkspaceWrites` allows them.
 * - `acceptEdits` allows workspace writes without asking.
 * - `auto` (issue 510) reads as `acceptEdits` here: its classifier approves what
 *   would ask (`claudeAutoReviewApplies`), and credentials and blocked paths keep asking.
 * - `allowEverythingExceptCredentials` and `allowEverything` read as `prompt` here:
 *   the session switches approve what would ask (`withClaudePermissionLevel`), so a
 *   setting that refuses still refuses.
 */
export const CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING = 'claude.agent.defaultPermissionMode';

/**
 * Maps to `PermissionPolicy.readWorkspace`. False makes Read, Grep, Glob, LS and
 * NotebookRead ask inside the workspace too. Shell commands follow `shellSafe`.
 */
export const CLAUDE_AGENT_AUTO_APPROVE_READS_SETTING = 'claude.agent.autoApproveWorkspaceReads';

/** True allows writes inside a trusted workspace without asking. Maps to `PermissionPolicy.writeWorkspace`. */
export const CLAUDE_AGENT_AUTO_APPROVE_WRITES_SETTING = 'claude.agent.autoApproveWorkspaceWrites';

export type ClaudePermissionPreset = 'strict' | 'prompt' | 'acceptEdits' | 'auto' | 'allowEverythingExceptCredentials' | 'allowEverything';

/** The permission levels, from the most asking to the most open. */
export const CLAUDE_PERMISSION_LEVELS: readonly ClaudePermissionPreset[] = ['strict', 'prompt', 'acceptEdits', 'auto', 'allowEverythingExceptCredentials', 'allowEverything'];

/**
 * A missing value is the registered default, `strict`. The shared process
 * does not load workbench defaults, so it sees a missing value for a user who
 * never set one. An unknown value is read as `strict`, the cautious choice.
 */
export function readClaudePermissionPreset(value: unknown): ClaudePermissionPreset {
	return (CLAUDE_PERMISSION_LEVELS as readonly unknown[]).includes(value) ? value as ClaudePermissionPreset : 'strict';
}

/**
 * True (the default) until the user confirms the one-time warning for the
 * Allow Everything levels (issue 453); the confirm sets it to false. While it is
 * true, those levels work as Ask Before Edits.
 */
export const CLAUDE_AGENT_ALLOW_EVERYTHING_CONFIRM_SETTING = 'claude.agent.allowEverythingConfirm';

/** Only an explicit false skips the confirm. */
export function readClaudeAllowEverythingConfirm(value: unknown): boolean {
	return value !== false;
}

/** When false, Tab asks for no completions and applies none. */
export const CLAUDE_AUTOCOMPLETE_ENABLED_SETTING = 'claude.autocomplete.enabled';

/** Model id for the completion turn. Empty uses the runtime default. */
export const CLAUDE_AUTOCOMPLETE_MODEL_SETTING = 'claude.autocomplete.model';

/** Pause after typing before a completion request. Clamped to 100-500 ms. */
export const CLAUDE_AUTOCOMPLETE_DEBOUNCE_SETTING = 'claude.autocomplete.debounceMs';

export const CLAUDE_AUTOCOMPLETE_DEBOUNCE_MIN_MS = 100;
export const CLAUDE_AUTOCOMPLETE_DEBOUNCE_MAX_MS = 500;
export const CLAUDE_AUTOCOMPLETE_DEBOUNCE_DEFAULT_MS = 300;

/** Only an explicit false turns Tab off. A missing value stays on. */
export function readClaudeAutocompleteEnabled(value: unknown): boolean {
	return value !== false;
}

/**
 * When true, Inline Edit is bound to Ctrl/Cmd+K and that chord prefix no longer
 * starts Code - OSS chords while the editor has focus. On by default, as the
 * prototype shows. Ctrl/Cmd+Alt+K always works; turning this off gives the
 * chords back.
 */
export const CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING = 'claude.keybindings.klawlyKeys';

/**
 * Name the Klawly Keys preset shipped under before issue 553. A configuration
 * migration moves it to {@link CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING}.
 */
export const CLAUDE_LEGACY_KEYBINDINGS_PRESET_SETTING = 'claude.keybindings.cursorLike';

/** When true, Escape rejects an inline diff that has not been accepted. */
export const CLAUDE_INLINE_REJECT_ON_ESCAPE_SETTING = 'claude.inlineEdit.rejectOnEscape';

/** When true, selecting text in an editor shows Add to Agent and Edit above the selection. */
export const CLAUDE_SELECTION_TOOLBAR_SETTING = 'claude.editor.selectionToolbar';

export function readClaudeAutocompleteModel(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** When true, a code-changing turn that leaves new errors starts another fix turn. */
export const CLAUDE_DIAGNOSTICS_AUTO_VERIFY_SETTING = 'claude.diagnostics.autoVerify';

/** How many automatic fix turns may follow one user turn. The hard cap is {@link CLAUDE_DIAGNOSTICS_HARD_CAP}. */
export const CLAUDE_DIAGNOSTICS_MAX_CYCLES_SETTING = 'claude.diagnostics.maxVerifyCycles';

/** Quiet time after the last problem update before new errors are collected. */
export const CLAUDE_DIAGNOSTICS_SETTLE_MS_SETTING = 'claude.diagnostics.settleMs';

/** Automatic verify/fix turns cannot exceed this, even if the setting is higher. */
export const CLAUDE_DIAGNOSTICS_HARD_CAP = 3;

export const CLAUDE_DIAGNOSTICS_DEFAULT_CYCLES = 2;

export const CLAUDE_DIAGNOSTICS_SETTLE_DEFAULT_MS = 750;

export const CLAUDE_DIAGNOSTICS_SETTLE_MIN_MS = 0;

export const CLAUDE_DIAGNOSTICS_SETTLE_MAX_MS = 4000;

/** Collection does not wait longer than this after the turn ends, even if problems keep changing. */
export const CLAUDE_DIAGNOSTICS_MAX_WAIT_MS = 8000;

/** Only an explicit true turns automatic verify on. */
export function readClaudeDiagnosticsAutoVerify(value: unknown): boolean {
	return value === true;
}

export function readClaudeDiagnosticsMaxCycles(value: unknown): number {
	const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : CLAUDE_DIAGNOSTICS_DEFAULT_CYCLES;
	return Math.min(CLAUDE_DIAGNOSTICS_HARD_CAP, Math.max(1, parsed));
}

export function readClaudeDiagnosticsSettleMs(value: unknown): number {
	const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : CLAUDE_DIAGNOSTICS_SETTLE_DEFAULT_MS;
	return Math.min(CLAUDE_DIAGNOSTICS_SETTLE_MAX_MS, Math.max(CLAUDE_DIAGNOSTICS_SETTLE_MIN_MS, parsed));
}

export function readClaudeAutocompleteDebounceMs(value: unknown): number {
	const parsed = typeof value === 'number' ? value : CLAUDE_AUTOCOMPLETE_DEBOUNCE_DEFAULT_MS;
	if (!Number.isFinite(parsed)) {
		return CLAUDE_AUTOCOMPLETE_DEBOUNCE_DEFAULT_MS;
	}
	return Math.min(CLAUDE_AUTOCOMPLETE_DEBOUNCE_MAX_MS, Math.max(CLAUDE_AUTOCOMPLETE_DEBOUNCE_MIN_MS, Math.round(parsed)));
}

/** When false, Agent views and commands are hidden and no agent turn starts. The editor keeps working. */
export const CLAUDE_AGENT_ENABLED_SETTING = 'claude.agent.enabled';

/** Mode a new agent session starts in. */
export const CLAUDE_AGENT_DEFAULT_MODE_SETTING = 'claude.agent.defaultMode';

/** When true, a new chat tab opens at the front of the tab strip instead of the end. */
export const CLAUDE_AGENT_NEW_CHATS_FIRST_SETTING = 'claude.agent.newChatsFirst';

/** Before shell commands: save dirty editors, ask, or do nothing. */
export const CLAUDE_AGENT_SAVE_BEFORE_COMMANDS_SETTING = 'claude.agent.saveBeforeCommands';

export type ClaudeSaveBeforeCommandsMode = 'prompt' | 'always' | 'never';

/** A missing or unknown value asks, which is the registered default. */
export function readClaudeSaveBeforeCommands(value: unknown): ClaudeSaveBeforeCommandsMode {
	return value === 'always' || value === 'never' ? value : 'prompt';
}

/** When true, `merge_gate` merges a green pull request without the tool permission prompt (issue 844). Off by default. */
export const CLAUDE_MERGE_WITHOUT_ASKING_SETTING = 'klawly.delegation.mergeWithoutAsking';

/** Only an explicit true skips the prompt. */
export function readClaudeMergeWithoutAsking(value: unknown): boolean {
	return value === true;
}

/** Opens the review diff for the first change after an agent turn edits files. */
export const CLAUDE_REVIEW_OPEN_AFTER_EDIT_SETTING = 'claude.review.openAfterAgentEdit';

/** One switch for Auto: the model, the permission level and Auto-Keep (issue 1221). */
export const CLAUDE_AUTO_ENABLED_SETTING = 'claude.auto.enabled';

/** Auto reuses an idle, finished helper of the same tier (compacted) instead of starting a new one (issue 1230). */
export const CLAUDE_AUTO_REUSE_HELPERS_SETTING = 'claude.auto.reuseHelpers';

/** On unless the user turned it off. */
export function readClaudeAutoReuseHelpers(value: unknown): boolean {
	return value !== false;
}

/**
 * Auto-Keep (issue 706): keeps an agent's changes as they land, so nothing waits for review.
 * It is separate from Auto-Accept, which only skips the permission prompt before an edit.
 */
export const CLAUDE_REVIEW_AUTO_KEEP_SETTING = 'claude.review.autoKeep';

/** `off` never keeps; `thisChat` keeps in the chats turned on from the mode menu; `always` keeps in every chat. */
export type ClaudeAutoKeepMode = 'off' | 'thisChat' | 'always';

/** A missing or unknown value is `off`, the registered default. */
export function readClaudeAutoKeep(value: unknown): ClaudeAutoKeepMode {
	return value === 'thisChat' || value === 'always' ? value : 'off';
}

/**
 * Stage a merge-conflicted file once Keep has settled every change in it and no
 * conflict marker is left (issue 877). Off by default: nothing is staged unless you ask.
 */
export const CLAUDE_MERGE_STAGE_AFTER_KEEP_SETTING = 'claude.mergeConflicts.stageAfterKeep';

/** Off by default (Beta). When false, the browser preview commands are disabled. */
export const CLAUDE_PREVIEW_ENABLED_SETTING = 'claude.preview.enabled';

/**
 * Klawly sends no telemetry. While this is false (the default), Claude Code is
 * also started with its nonessential traffic turned off (see `claudeRuntime.ts`).
 */
export const CLAUDE_TELEMETRY_ENABLED_SETTING = 'claude.telemetry.enabled';

/** Runtime model ids shown in the picker. Empty shows all of them. */
export const CLAUDE_MODELS_ENABLED_SETTING = 'claude.models.enabled';

/** Model a new agent session starts with. Empty uses the Claude runtime default. */
export const CLAUDE_MODELS_DEFAULT_SETTING = 'claude.models.default';

/** Extra model ids the runtime did not report. Always shown in the picker. */
export const CLAUDE_MODELS_CUSTOM_SETTING = 'claude.models.custom';

/**
 * Effort a new session starts with, per model id (`default` for the runtime's
 * default model). A model left out uses its own default. Max is not offered:
 * Claude Code keeps it for one session.
 */
export const CLAUDE_MODELS_EFFORT_SETTING = 'claude.models.effort';

/** Effort levels `claude.models.effort` accepts. */
export const CLAUDE_CONFIGURABLE_EFFORT_LEVELS: readonly ClaudeEffortLevel[] = ['low', 'medium', 'high', 'xhigh'];

/** New sessions start in fast mode on a model that has it. */
export const CLAUDE_MODELS_FAST_MODE_SETTING = 'claude.models.fastMode';

/** New sessions start with Ultracode on a model with extra high effort. */
export const CLAUDE_MODELS_ULTRACODE_SETTING = 'claude.models.ultracode';

/**
 * The settings a new session asks for from `claude.models.effort`,
 * `claude.models.fastMode` and `claude.models.ultracode`. The caller fits them
 * to what the model supports.
 */
export function readClaudeConfiguredSessionSettings(modelId: string | undefined, effort: unknown, fastMode: unknown, ultracode: unknown): ClaudeSessionSettings {
	const settings: { effort?: ClaudeEffortLevel; fastMode?: true; ultracode?: true } = {};
	if (typeof effort === 'object' && effort !== null && !Array.isArray(effort)) {
		const level = (effort as Record<string, unknown>)[modelId ?? 'default'];
		if (isClaudeEffortLevel(level) && CLAUDE_CONFIGURABLE_EFFORT_LEVELS.includes(level)) {
			settings.effort = level;
		}
	}
	if (fastMode === true) {
		settings.fastMode = true;
	}
	if (ultracode === true) {
		settings.ultracode = true;
	}
	return settings;
}

/** Model for inline edit turns. Empty uses the session model. */
export const CLAUDE_INLINE_EDIT_MODEL_SETTING = 'claude.inlineEdit.model';

/** When false, pastes go in as text instead of selection chips or pasted-text pills. */
export const CLAUDE_COMPOSER_PASTE_AS_REFERENCE_SETTING = 'claude.composer.pasteAsReference';

/** What Enter does with a message sent while Claude works: hold it for after the turn, or steer the turn. */
export const CLAUDE_COMPOSER_WHILE_WORKING_SETTING = 'claude.composer.whileWorking';

/** When true, a read-only "Claude" terminal shows the shell commands Claude runs and their output (issue 742). */
export const CLAUDE_TERMINAL_MIRROR_SETTING = 'claude.terminal.mirrorCommands';

export type ClaudeWhileWorking = 'queue' | 'steer';

/** A missing or unknown value queues, which is the registered default. */
export function readClaudeWhileWorking(value: unknown): ClaudeWhileWorking {
	return value === 'steer' ? 'steer' : 'queue';
}

/** An OS notification when an agent needs approval while the window is in the background. */
export const CLAUDE_NOTIFICATIONS_APPROVAL_SETTING = 'claude.notifications.approval';

/** An OS notification when an agent finishes or fails while the window is in the background. */
export const CLAUDE_NOTIFICATIONS_FINISHED_SETTING = 'claude.notifications.finished';

/** A sound when an agent finishes or needs approval, whether or not the window is focused. */
export const CLAUDE_NOTIFICATIONS_SOUND_SETTING = 'claude.notifications.sound';

/** When false, Klawly's own subagent definitions are not passed to the runtime. */
export const CLAUDE_SUBAGENTS_BUILT_IN_SETTING = 'claude.subagents.builtInAgents';

/** Issue 499: pass the workspace's AGENTS.md to Claude when no CLAUDE.md imports it. */
export const CLAUDE_INSTRUCTIONS_AGENTS_MD_SETTING = 'claude.instructions.agentsMd';

/** Issue 499: load the workspace's `.agents/skills` as Claude Code skills. */
export const CLAUDE_INSTRUCTIONS_AGENTS_SKILLS_SETTING = 'claude.instructions.agentsSkills';

/** Only an explicit false turns either one off. */
export function readClaudeAgentsFilesSettings(get: (key: string) => unknown): ClaudeAgentsFilesSettings {
	return { instructions: get(CLAUDE_INSTRUCTIONS_AGENTS_MD_SETTING) !== false, skills: get(CLAUDE_INSTRUCTIONS_AGENTS_SKILLS_SETTING) !== false };
}

/** When true, the subagent chat opens as soon as a subagent starts. */
export const CLAUDE_SUBAGENTS_OPEN_ON_START_SETTING = 'claude.subagents.openOnStart';

/** When false, Claude is not offered the delegate tool and the delegate skill (issue 835). */
export const CLAUDE_DELEGATION_ENABLED_SETTING = 'klawly.delegation.enabled';

/** Only an explicit false turns delegation off. A missing value stays on. */
export function readClaudeDelegationEnabled(value: unknown): boolean {
	return value !== false;
}

/** Before a send, scan attached files, selections, pastes, terminal output and diffs for secrets. */
export const CLAUDE_SECURITY_SCAN_ATTACHMENTS_SETTING = 'claude.security.scanAttachmentsForSecrets';

/** Only an explicit false turns the attachment secret scan off. */
export function readClaudeScanAttachments(value: unknown): boolean {
	return value !== false;
}

/** Only an explicit false turns the agent off. A missing value stays on. */
export function readClaudeAgentEnabled(value: unknown): boolean {
	return value !== false;
}

/** A missing or unknown value starts sessions in Agent mode. */
export function readClaudeDefaultMode(value: unknown): AgentMode {
	return value === 'ask' || value === 'plan' ? value : 'agent';
}

/** Trimmed model id, or undefined when empty. */
export function readClaudeModelId(value: unknown): string | undefined {
	return readClaudeAutocompleteModel(value);
}

/** Only an explicit false keeps Klawly's own subagents out of the run. */
export function readClaudeBuiltInAgents(value: unknown): boolean {
	return value !== false;
}

/** Only an explicit false pastes plain text. */
export function readClaudePasteAsReference(value: unknown): boolean {
	return value !== false;
}

/**
 * Character threshold for the pasted-text pill. `explicit` is the value the
 * user set for {@link CLAUDE_LONG_PASTE_SETTING} (not its default). Until the
 * migration has run, a value under the old name still applies.
 */
export function readClaudeLongPasteChars(explicit: unknown, legacy: unknown): number {
	for (const value of [explicit, legacy]) {
		if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
			return Math.floor(value);
		}
	}
	return CLAUDE_LONG_PASTE_DEFAULT;
}

/**
 * Migration for the old long-paste key. Moves the value to the new key unless
 * the user already set that one, and removes the old key either way.
 */
export function migrateClaudeLongPasteSetting(value: unknown, newValue: unknown): [string, { value: unknown }][] {
	const remove: [string, { value: unknown }] = [CLAUDE_LEGACY_LONG_PASTE_SETTING, { value: undefined }];
	if (newValue !== undefined || typeof value !== 'number') {
		return [remove];
	}
	return [[CLAUDE_LONG_PASTE_SETTING, { value }], remove];
}

/**
 * Migration for the old Klawly Keys key. Moves a boolean to the new key unless
 * the user already set that one, and removes the old key either way.
 */
export function migrateClaudeKeybindingsPresetSetting(value: unknown, newValue: unknown): [string, { value: unknown }][] {
	const remove: [string, { value: unknown }] = [CLAUDE_LEGACY_KEYBINDINGS_PRESET_SETTING, { value: undefined }];
	if (newValue !== undefined || typeof value !== 'boolean') {
		return [remove];
	}
	return [[CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING, { value }], remove];
}
