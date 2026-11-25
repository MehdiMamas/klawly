/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Claude Code settings precedence, from https://code.claude.com/docs/en/settings (section "Settings precedence"):
 * managed, command line, project local (`.claude/settings.local.json`), shared project (`.claude/settings.json`),
 * user (`~/.claude/settings.json`), highest first. A key at a higher level overrides the same key lower down,
 * except lists (such as `permissions.allow`), which are combined ("Lists merge instead of overriding").
 *
 * shortcut: managed settings and the model-list keys with their own rules (`fallbackModel`, `modelPicker`,
 * `availableModels`, `modelSettings`) are not special-cased, upgrade when the settings editor (P7) edits them.
 */
export type ClaudeSettingsObject = { [key: string]: unknown };

function isObject(value: unknown): value is ClaudeSettingsObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeValue(low: unknown, high: unknown): unknown {
	if (Array.isArray(low) && Array.isArray(high)) {
		return [...low, ...high.filter(item => !low.includes(item))];
	}
	if (isObject(low) && isObject(high)) {
		return mergeObjects(low, high);
	}
	return high;
}

function mergeObjects(low: ClaudeSettingsObject, high: ClaudeSettingsObject): ClaudeSettingsObject {
	const result: ClaudeSettingsObject = { ...low };
	for (const key of Object.keys(high)) {
		// `__proto__` never becomes a key of the merged settings
		if (key === '__proto__') {
			continue;
		}
		result[key] = Object.hasOwn(low, key) ? mergeValue(low[key], high[key]) : high[key];
	}
	return result;
}

/** Merges settings layers given lowest precedence first (user, project, local). */
export function mergeClaudeSettings(layers: readonly ClaudeSettingsObject[]): ClaudeSettingsObject {
	return layers.reduce<ClaudeSettingsObject>((acc, layer) => mergeObjects(acc, layer), {});
}

/** Parses one settings file; returns an error instead of throwing, like Claude Code skipping a broken file. */
export function parseClaudeSettingsFile(text: string): { value?: ClaudeSettingsObject; error?: string } {
	try {
		const value: unknown = JSON.parse(text);
		return isObject(value) ? { value } : { error: 'Expected a JSON object' };
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Returns the text of a settings file with `rule` added to `permissions.allow` (https://code.claude.com/docs/en/settings,
 * "Permission settings"). Keeps every other key; throws when the existing text is not a JSON object, so a broken file is never overwritten.
 */
export function addAllowRuleToSettings(existing: string | undefined, rule: string): string {
	let settings: ClaudeSettingsObject = {};
	if (existing?.trim()) {
		const parsed = parseClaudeSettingsFile(existing);
		if (!parsed.value) {
			throw new Error(parsed.error);
		}
		settings = parsed.value;
	}
	const permissions = isObject(settings.permissions) ? settings.permissions : {};
	const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
	if (!allow.includes(rule)) {
		allow.push(rule);
	}
	return JSON.stringify({ ...settings, permissions: { ...permissions, allow } }, undefined, '\t') + '\n';
}
