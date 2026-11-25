/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { CLAUDE_PERMISSION_LEVELS, ClaudePermissionPreset } from '../../../../platform/claude/common/claudeConfiguration.js';

export interface ClaudePermissionLevelDescriptor {
	readonly level: ClaudePermissionPreset;
	readonly label: string;
	readonly description: string;
	readonly icon: ThemeIcon;
}

/**
 * The permission levels as the mode menu and Settings show them (issue 453),
 * from the most asking to the most open. The two Allow Everything levels use
 * the unlock icon, so the open levels do not rely on colour alone (DL-10).
 */
export function claudePermissionLevels(): readonly ClaudePermissionLevelDescriptor[] {
	const labels: Record<ClaudePermissionPreset, Omit<ClaudePermissionLevelDescriptor, 'level'>> = {
		strict: { label: localize('claudeLevelStrict', "Strict"), description: localize('claudeLevelStrictDesc', "Ask before edits; refuse risky commands and network"), icon: Codicon.lock },
		prompt: { label: localize('claudeLevelPrompt', "Ask Before Edits"), description: localize('claudeLevelPromptDesc', "Workspace edits and risky commands ask first"), icon: Codicon.shield },
		acceptEdits: { label: localize('claudeLevelAcceptEdits', "Accept Edits"), description: localize('claudeLevelAcceptEditsDesc', "Edit workspace files without asking"), icon: Codicon.edit },
		// Issue 510: a classifier approves routine requests; credentials, destructive commands and paths outside the workspace still ask.
		auto: { label: localize('claudeLevelAuto', "Auto"), description: localize('claudeLevelAutoDesc', "Claude Haiku approves routine actions; risky ones still ask"), icon: Codicon.sparkle },
		// Issue 694: Allow Everything is Claude Code's bypass permissions mode; Except Credentials keeps Klawly checking each call.
		allowEverythingExceptCredentials: { label: localize('claudeLevelEverythingExcept', "Allow Everything Except Credentials"), description: localize('claudeLevelEverythingExceptDesc', "No prompts except credentials; Klawly still checks each call"), icon: Codicon.unlock },
		allowEverything: { label: localize('claudeLevelEverything', "Allow Everything"), description: localize('claudeLevelEverythingDesc', "Like bypass permissions: in Agent, nothing is checked or asked"), icon: Codicon.unlock },
	};
	return CLAUDE_PERMISSION_LEVELS.map(level => ({ level, ...labels[level] }));
}

/** The descriptor of one level. */
export function claudePermissionLevel(level: ClaudePermissionPreset): ClaudePermissionLevelDescriptor {
	return claudePermissionLevels().find(descriptor => descriptor.level === level)!;
}

/**
 * The level to write once when the default changed from Ask Before Edits to
 * Strict (issue 453). A new install takes the new default. An existing install
 * that never picked a level keeps Ask Before Edits, so nobody's every-session
 * level changes under them. Nothing is written when a level was already picked.
 */
export function claudePermissionLevelToMigrate(newInstall: boolean, userValue: unknown): ClaudePermissionPreset | undefined {
	return newInstall || userValue !== undefined ? undefined : 'prompt';
}
