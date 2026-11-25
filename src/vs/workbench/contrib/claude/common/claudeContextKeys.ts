/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { CLAUDE_AUTOCOMPLETE_ENABLED_SETTING, CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING, CLAUDE_PREVIEW_ENABLED_SETTING } from '../../../../platform/claude/common/claudeConfiguration.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';

/**
 * Set from `claude.agent.enabled` at startup. Negated so that a window where it
 * was never bound (tests, early startup) counts as enabled, like the setting.
 */
export const CLAUDE_AGENT_DISABLED = new RawContextKey<boolean>('claude.agentDisabled', false, localize('claudeAgentDisabledKey', "Whether the claude.agent.enabled setting is off"));

/** True unless `claude.agent.enabled` is off. */
export const CLAUDE_AGENT_ENABLED = CLAUDE_AGENT_DISABLED.negate();

/** True in the Agents window, the window opened with `--agents-layout` (#1255). */
export const CLAUDE_AGENTS_WINDOW = new RawContextKey<boolean>('claude.agentsWindow', false, localize('claudeAgentsWindowKey', "Whether this is the Agents window"));

/** True while `claude.preview.enabled` is on. Its registered default is true. */
export const CLAUDE_PREVIEW_ENABLED = ContextKeyExpr.equals(`config.${CLAUDE_PREVIEW_ENABLED_SETTING}`, true);

/** True when the Klawly Keys preset is on. Its registered default is true. */
export const CLAUDE_KLAWLY_KEYMAP = ContextKeyExpr.equals(`config.${CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING}`, true);

/**
 * Weight of the preset's Ctrl/Cmd+K (Inline Edit) and Ctrl/Cmd+L (Add to Agent).
 * - Above their default keys with Alt, so labels (selection toolbar, first-run
 *   hint, empty chat, Command Palette) show the preset key while it is on. When
 *   it is off the preset rule never holds and a label shows the default key
 *   instead, through `CLAUDE_DEFAULT_KEY_LABEL_WHEN`.
 * - Above built-in extension chords, which weigh `BuiltinExtension` plus their
 *   index: the git extension's Ctrl/Cmd+K Ctrl/Cmd+Alt+S holds in every file
 *   editor and would otherwise turn Ctrl/Cmd+K into a chord prefix there.
 *   Installed extensions still win, and so do user keybindings.
 */
export const CLAUDE_KLAWLY_KEY_WEIGHT = KeybindingWeight.ExternalExtension - 1;

/**
 * Holds while the Klawly Keys preset is off, with no focus condition. A label
 * looked up where no rule's `when` holds (the Command Palette, the first-run
 * hint, the empty chat) takes the command's heaviest rule, the preset one. A
 * rule with the default key and this `when`, at `CLAUDE_DEFAULT_KEY_LABEL_WEIGHT`,
 * holds there while the preset is off, so those labels show the default key
 * (issue 287). The key then also runs the command outside the editor, as the
 * Command Palette entry does.
 */
export const CLAUDE_DEFAULT_KEY_LABEL_WHEN = ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_KLAWLY_KEYMAP.negate());

/** Below every other rule on those keys, so the rule only wins where nothing else is bound. */
export const CLAUDE_DEFAULT_KEY_LABEL_WEIGHT = KeybindingWeight.EditorCore + 1;

/** True while Tab suggestions are on. Its registered default is true. */
export const CLAUDE_AUTOCOMPLETE_ON = ContextKeyExpr.equals(`config.${CLAUDE_AUTOCOMPLETE_ENABLED_SETTING}`, true);

export const CLAUDE_AGENT_RUNNING = new RawContextKey<boolean>('claude.agentRunning', false, localize('claudeAgentRunningKey', "Whether the current agent session has a turn running"));
export const CLAUDE_HAS_TURNS = new RawContextKey<boolean>('claude.hasTurns', false, localize('claudeHasTurnsKey', "Whether the current agent session has at least one turn"));
export const CLAUDE_HAS_PENDING_CHANGES = new RawContextKey<boolean>('claude.hasPendingChanges', false, localize('claudeHasPendingChangesKey', "Whether any agent session, background or delegated agent has changes waiting for review"));
/** Files with agent changes waiting for review, as URI strings, for `resource in klawly.reviewPendingFiles` (issue 706). */
export const CLAUDE_REVIEW_PENDING_FILES = new RawContextKey<string[]>('klawly.reviewPendingFiles', [], localize('claudeReviewPendingFilesKey', "The files with agent changes waiting for review"));
export const CLAUDE_HAS_SUBAGENTS = new RawContextKey<boolean>('claude.hasSubagents', false, localize('claudeHasSubagentsKey', "Whether the current agent session started a subagent"));
export const CLAUDE_HAS_RUNNING_SUBAGENT = new RawContextKey<boolean>('claude.hasRunningSubagent', false, localize('claudeHasRunningSubagentKey', "Whether a subagent of the current agent session is running"));
export const CLAUDE_HAS_OTHER_SESSIONS = new RawContextKey<boolean>('claude.hasOtherSessions', false, localize('claudeHasOtherSessionsKey', "Whether another agent session can be referenced"));
