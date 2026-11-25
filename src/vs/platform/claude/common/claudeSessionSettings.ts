/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Claude Code's effort levels, lowest first. A model supports a subset of them. */
export type ClaudeEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const CLAUDE_EFFORT_LEVELS: readonly ClaudeEffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function isClaudeEffortLevel(value: unknown): value is ClaudeEffortLevel {
	return typeof value === 'string' && (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * The Claude Code flag settings the composer controls for one session (Phase 33).
 * Each field is set only when it differs from Claude Code's own default, so an
 * empty object means "the model's defaults". The workbench always sends the
 * whole object: a missing field clears that choice.
 */
export interface ClaudeSessionSettings {
	/** Absent means the model's default effort. Ignored while `ultracode` is on, which runs at `xhigh`. */
	readonly effort?: ClaudeEffortLevel;
	/** Fast mode. Only `true` is stored. */
	readonly fastMode?: true;
	/** Extra high effort plus standing workflow orchestration. Session only. Only `true` is stored. */
	readonly ultracode?: true;
	/** `false` turns adaptive thinking off. Only `false` is stored. */
	readonly thinking?: false;
}

export const DEFAULT_CLAUDE_SESSION_SETTINGS: ClaudeSessionSettings = Object.freeze({});

/** Reads a value that crossed IPC or came from settings. Anything unknown takes the default. */
export function readClaudeSessionSettings(value: unknown): ClaudeSessionSettings {
	if (typeof value !== 'object' || value === null) {
		return DEFAULT_CLAUDE_SESSION_SETTINGS;
	}
	const record = value as { effort?: unknown; fastMode?: unknown; ultracode?: unknown; thinking?: unknown };
	const settings: { effort?: ClaudeEffortLevel; fastMode?: true; ultracode?: true; thinking?: false } = {};
	if (isClaudeEffortLevel(record.effort)) {
		settings.effort = record.effort;
	}
	if (record.fastMode === true) {
		settings.fastMode = true;
	}
	if (record.ultracode === true) {
		settings.ultracode = true;
	}
	if (record.thinking === false) {
		settings.thinking = false;
	}
	return settings;
}

export function sameClaudeSessionSettings(a: ClaudeSessionSettings, b: ClaudeSessionSettings): boolean {
	return a.effort === b.effort && a.fastMode === b.fastMode && a.ultracode === b.ultracode && a.thinking === b.thinking;
}

/**
 * A change to Claude Code's flag settings layer (`applyFlagSettings`). `null`
 * clears a key: effort goes back to the model's default, Ultracode turns off
 * and keeps the effort it ran at, fast mode turns off, thinking turns back on.
 */
export interface ClaudeFlagSettingsPatch {
	effortLevel?: ClaudeEffortLevel | null;
	fastMode?: true | null;
	ultracode?: true | null;
	alwaysThinkingEnabled?: false | null;
}

/**
 * What to send so a session running with `previous` runs with `next`, or
 * undefined when nothing changes.
 * - Turning Ultracode off sends the chosen effort again, because Claude Code
 *   keeps the extra high effort Ultracode ran at.
 * - An effort chosen while Ultracode is on waits until Ultracode turns off.
 */
export function claudeFlagSettingsPatch(previous: ClaudeSessionSettings, next: ClaudeSessionSettings): ClaudeFlagSettingsPatch | undefined {
	const patch: ClaudeFlagSettingsPatch = {};
	if (previous.ultracode !== next.ultracode) {
		patch.ultracode = next.ultracode ?? null;
		if (!next.ultracode) {
			patch.effortLevel = next.effort ?? null;
		}
	} else if (!next.ultracode && previous.effort !== next.effort) {
		patch.effortLevel = next.effort ?? null;
	}
	if (previous.fastMode !== next.fastMode) {
		patch.fastMode = next.fastMode ?? null;
	}
	if (previous.thinking !== next.thinking) {
		patch.alwaysThinkingEnabled = next.thinking ?? null;
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}

/** The `query()` options that open a session with these settings. */
export interface ClaudeStartSettings {
	readonly effort?: ClaudeEffortLevel;
	readonly flagSettings?: {
		readonly fastMode?: true;
		readonly ultracode?: true;
		readonly alwaysThinkingEnabled?: false;
	};
}

export function claudeStartSettings(settings: ClaudeSessionSettings): ClaudeStartSettings {
	const flagSettings: { fastMode?: true; ultracode?: true; alwaysThinkingEnabled?: false } = {};
	if (settings.fastMode) {
		flagSettings.fastMode = true;
	}
	if (settings.ultracode) {
		flagSettings.ultracode = true;
	}
	if (settings.thinking === false) {
		flagSettings.alwaysThinkingEnabled = false;
	}
	return {
		// Ultracode sets its own extra high effort.
		effort: settings.ultracode ? undefined : settings.effort,
		flagSettings: Object.keys(flagSettings).length > 0 ? flagSettings : undefined,
	};
}

/** What a model reports about the settings it takes. `ClaudeModelInfo` satisfies it. */
export interface ClaudeSettingsCapabilities {
	readonly supportsEffort?: boolean;
	readonly supportedEffortLevels?: readonly ClaudeEffortLevel[];
	readonly supportsAdaptiveThinking?: boolean;
	readonly supportsFastMode?: boolean;
}

/** The effort levels a model takes, lowest first. Empty when it takes none. */
export function claudeEffortLevelsFor(model: ClaudeSettingsCapabilities | undefined): readonly ClaudeEffortLevel[] {
	if (!model?.supportsEffort || !model.supportedEffortLevels) {
		return [];
	}
	const levels = model.supportedEffortLevels;
	return CLAUDE_EFFORT_LEVELS.filter(level => levels.includes(level));
}

/** Ultracode runs at extra high effort, so only a model with `xhigh` offers it. */
export function claudeSupportsUltracode(model: ClaudeSettingsCapabilities | undefined): boolean {
	return claudeEffortLevelsFor(model).includes('xhigh');
}

/** Why a model refuses these settings, or undefined when it takes them. */
export function claudeSettingsProblem(model: ClaudeSettingsCapabilities | undefined, settings: ClaudeSessionSettings): string | undefined {
	const levels = claudeEffortLevelsFor(model);
	if (settings.effort && !levels.includes(settings.effort)) {
		return levels.length === 0 ? 'This model takes no effort level.' : `This model does not take ${settings.effort} effort.`;
	}
	if (settings.ultracode && !levels.includes('xhigh')) {
		return 'Ultracode needs a model with extra high effort.';
	}
	if (settings.fastMode && !model?.supportsFastMode) {
		return 'This model has no fast mode.';
	}
	if (settings.thinking === false && !model?.supportsAdaptiveThinking) {
		return 'Thinking can be turned off only on a model with adaptive thinking.';
	}
	return undefined;
}

/**
 * The closest settings a model takes. An effort it lacks falls to the nearest
 * lower level it has (or the lowest one); unsupported switches turn off.
 */
export function fitClaudeSessionSettings(model: ClaudeSettingsCapabilities | undefined, settings: ClaudeSessionSettings): ClaudeSessionSettings {
	const levels = claudeEffortLevelsFor(model);
	const fitted: { effort?: ClaudeEffortLevel; fastMode?: true; ultracode?: true; thinking?: false } = {};
	if (settings.effort && levels.length > 0) {
		const wanted = CLAUDE_EFFORT_LEVELS.indexOf(settings.effort);
		const lower = levels.filter(level => CLAUDE_EFFORT_LEVELS.indexOf(level) <= wanted);
		fitted.effort = lower.length > 0 ? lower[lower.length - 1] : levels[0];
	}
	if (settings.ultracode && levels.includes('xhigh')) {
		fitted.ultracode = true;
	}
	if (settings.fastMode && model?.supportsFastMode) {
		fitted.fastMode = true;
	}
	if (settings.thinking === false && model?.supportsAdaptiveThinking) {
		fitted.thinking = false;
	}
	return fitted;
}
