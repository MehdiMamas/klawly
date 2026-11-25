/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeModelInfo } from './claude.js';

/** Trimmed, non-empty, de-duplicated model ids from a `claude.models.*` list setting. */
export function readClaudeModelIdList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const ids: string[] = [];
	for (const entry of value) {
		if (typeof entry !== 'string') {
			continue;
		}
		const id = entry.trim();
		if (id && !ids.includes(id)) {
			ids.push(id);
		}
	}
	return ids;
}

/** Claude Code's alias for the model it runs when none is picked. It names no model of its own. */
export const CLAUDE_DEFAULT_MODEL_ALIAS = 'default';

/** A resolved model id such as `claude-opus-5-5`, `claude-sonnet-5` or `claude-haiku-4-5-20251001[1m]`. */
const RESOLVED_MODEL_ID = /^claude-(?<family>[a-z]+)-(?<major>\d+)(?:-(?<minor>\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/i;

/**
 * The name a model goes by: Claude Code's display name, or the family and
 * version its id resolves to when that name is the bare family. Claude Code
 * names its aliases by family only (`opus` is "Opus", `default` is "Default
 * (recommended)"), so they read as "Opus 5.5". A qualifier such as
 * "(1M context)" is left to the caller.
 */
export function claudeModelDisplayName(model: ClaudeModelInfo): string {
	const name = model.displayName || model.id;
	const match = model.resolvedModel?.match(RESOLVED_MODEL_ID);
	if (!match?.groups) {
		return name;
	}
	const { family, major, minor } = match.groups;
	if (model.id !== CLAUDE_DEFAULT_MODEL_ALIAS && name.replace(/\s*\(.*\)$/, '').toLowerCase() !== family.toLowerCase()) {
		return name;
	}
	return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${minor ? `${major}.${minor}` : major}`;
}

/**
 * Models the picker and Cycle Model offer (spec 34b): runtime models switched on in
 * `claude.models.enabled` (empty means all), then custom ids the runtime did not
 * report. When none of the enabled ids is still reported, every runtime model is
 * shown, so a stale list cannot leave the picker empty. Claude Code's `default`
 * alias is left out: the picker names concrete models only.
 */
export function pickableClaudeModels(reported: readonly ClaudeModelInfo[], enabled: readonly string[], custom: readonly string[]): ClaudeModelInfo[] {
	const concrete = reported.filter(model => model.id !== CLAUDE_DEFAULT_MODEL_ALIAS);
	const filtered = enabled.length > 0 ? concrete.filter(model => enabled.includes(model.id)) : concrete.slice();
	const models = filtered.length > 0 ? filtered : concrete.slice();
	for (const id of custom) {
		if (!models.some(model => model.id === id)) {
			models.push({ id, displayName: id, source: 'custom' });
		}
	}
	return models;
}

/** True when `id` is a model the user may pick: reported by the runtime or listed as custom. */
export function isKnownClaudeModel(id: string, reported: readonly ClaudeModelInfo[], custom: readonly string[]): boolean {
	return reported.some(model => model.id === id) || custom.includes(id);
}

/**
 * The model after `currentId` in `models`, wrapping around. The first model when
 * `currentId` is not listed. Older models are left out; they are picked from the menu.
 */
export function cycleClaudeModel(models: readonly ClaudeModelInfo[], currentId: string | undefined): ClaudeModelInfo | undefined {
	const current = models.filter(model => !model.older);
	const cycle = current.length > 0 ? current : models;
	if (cycle.length === 0) {
		return undefined;
	}
	const index = currentId === undefined ? -1 : cycle.findIndex(model => model.id === currentId);
	return cycle[(index + 1) % cycle.length];
}

/**
 * The `claude.models.enabled` value for a selection on the Models page. All
 * reported models selected is stored as `[]`. Returns undefined when nothing is
 * selected, because an empty list would mean "all".
 */
export function enabledClaudeModelsSetting(reportedIds: readonly string[], selectedIds: readonly string[]): string[] | undefined {
	const selected = reportedIds.filter(id => selectedIds.includes(id));
	if (selected.length === 0) {
		return undefined;
	}
	return selected.length === reportedIds.length ? [] : selected;
}

/** True when `id` is switched on for the picker under `enabled` (empty means all). */
export function isClaudeModelEnabled(id: string, enabled: readonly string[], reportedIds: readonly string[]): boolean {
	if (enabled.length === 0 || !enabled.some(entry => reportedIds.includes(entry))) {
		return true;
	}
	return enabled.includes(id);
}

/**
 * The reported model a turn on `modelId` runs: its own row, else the row whose
 * alias resolves to it (`session.started` names `claude-opus-5-5`). No id runs
 * Claude Code's default alias, or the first model when none is reported, so the
 * caller can name the model instead of "Default". Undefined for an id the
 * runtime did not report, or before it reports any model.
 */
export function resolveClaudeModel(models: readonly ClaudeModelInfo[], modelId: string | undefined): ClaudeModelInfo | undefined {
	const id = modelId ?? CLAUDE_DEFAULT_MODEL_ALIAS;
	const own = models.find(model => model.id === id);
	if (own) {
		return own;
	}
	if (id === CLAUDE_DEFAULT_MODEL_ALIAS) {
		return models[0];
	}
	return models.find(model => model.id !== CLAUDE_DEFAULT_MODEL_ALIAS && model.resolvedModel === id);
}
