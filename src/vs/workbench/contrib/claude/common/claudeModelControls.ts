/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ClaudeModelInfo } from '../../../../platform/claude/common/claude.js';
import { ClaudeAutoComplexity, ClaudeAutoModelPick } from '../../../../platform/claude/common/claudeAutoModel.js';
import { ClaudeFastModeReason, ClaudeFastModeStatus } from '../../../../platform/claude/common/claudeFastMode.js';
import { claudeModelDisplayName } from '../../../../platform/claude/common/claudeModels.js';
import { claudeEffortLevelsFor, ClaudeEffortLevel, ClaudeSessionSettings } from '../../../../platform/claude/common/claudeSessionSettings.js';

/** The suffix Claude Code puts on a model id for its 1M-token context variant. */
const LONG_CONTEXT_SUFFIX = '[1m]';

export function claudeEffortLabel(level: ClaudeEffortLevel): string {
	switch (level) {
		case 'low': return localize('claudeEffortLow', "Low");
		case 'medium': return localize('claudeEffortMedium', "Medium");
		case 'high': return localize('claudeEffortHigh', "High");
		case 'xhigh': return localize('claudeEffortExtraHigh', "Extra High");
		case 'max': return localize('claudeEffortMax', "Max");
	}
}

/** The model and effort Auto ran a turn on, such as "Opus 5.5 · Medium". */
export function claudeAutoPickLabel(pick: ClaudeAutoModelPick): string {
	const name = pick.modelName ?? pick.modelId;
	return pick.effort ? localize('claudeAutoPick', "{0} \u00b7 {1}", name, claudeEffortLabel(pick.effort)) : name;
}

function claudeAutoComplexityLabel(complexity: ClaudeAutoComplexity): string {
	switch (complexity) {
		case 'simple': return localize('claudeAutoSimple', "simple");
		case 'moderate': return localize('claudeAutoModerate', "moderate");
		case 'complex': return localize('claudeAutoComplex', "complex");
	}
}

/** Why Auto ran a turn on its model: the rating, who made it, and the classifier's reason. */
export function claudeAutoPickHover(pick: ClaudeAutoModelPick): string {
	const complexity = claudeAutoComplexityLabel(pick.complexity);
	if (pick.source === 'estimate') {
		return localize('claudeAutoEstimated', "Auto estimated this message as {0} from its length, because Claude Code could not rate it.", complexity);
	}
	return pick.reason
		? localize('claudeAutoRatedReason', "Auto: Claude rated this message {0}. {1}", complexity, pick.reason)
		: localize('claudeAutoRated', "Auto: Claude rated this message {0}.", complexity);
}

/** The effort a session runs at, as the menu and the pill name it. Undefined when the session sends none. */
export function claudeEffortValue(settings: ClaudeSessionSettings): string | undefined {
	if (settings.ultracode) {
		return localize('claudeUltracode', "Ultracode");
	}
	return settings.effort ? claudeEffortLabel(settings.effort) : undefined;
}

/**
 * The grey qualifier after the model name on the pill, such as "High" or
 * "Ultracode, Fast": the effort the session sends, which the agent service
 * always resolves for a model that takes one. Undefined when the session sends
 * no effort and fast mode is off.
 */
export function claudeModelQualifier(settings: ClaudeSessionSettings, fastMode?: ClaudeFastModeStatus): string | undefined {
	const effort = claudeEffortValue(settings);
	if (settings.fastMode) {
		const fast = claudeFastModeBadge(fastMode);
		return effort ? localize('claudeModelQualifierBoth', "{0} \u00b7 {1}", effort, fast) : fast;
	}
	return effort;
}

/** The Fast badge: plain "Fast" while it runs, and what changed when Claude Code fell back (issue 456). */
export function claudeFastModeBadge(status: ClaudeFastModeStatus | undefined): string {
	switch (status?.state) {
		case 'cooldown': return localize('claudeFastCooling', "Fast (cooling down)");
		case 'unavailable': return localize('claudeFastUnavailable', "Fast (unavailable)");
		default: return localize('claudeFast', "Fast");
	}
}

function claudeFastModeReasonText(reason: ClaudeFastModeReason, detail: string | undefined): string {
	switch (reason) {
		case 'rate-limit': return localize('claudeFastReasonRateLimit', "a rate limit was reached");
		case 'overloaded': return localize('claudeFastReasonOverloaded', "fast mode is overloaded");
		case 'not-enabled': return localize('claudeFastReasonNotEnabled', "your account or organization has not turned it on");
		case 'billing': return localize('claudeFastReasonBilling', "billing does not allow it");
		case 'model': return localize('claudeFastReasonModel', "this model does not support it");
		default: return detail ?? localize('claudeFastReasonOther', "Claude Code did not say why");
	}
}

function defaultTimeText(ms: number): string {
	return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * The model menu row's detail: what fast mode is doing now, in plain words (issue 456).
 * `formatTime` is injectable so a test does not depend on the machine's locale.
 */
export function claudeFastModeDetail(status: ClaudeFastModeStatus | undefined, formatTime: (ms: number) => string = defaultTimeText): string {
	switch (status?.state) {
		case 'cooldown':
			return status.resumesAt !== undefined
				? localize('claudeFastDetailCoolingUntil', "Cooling down, back around {0}", formatTime(status.resumesAt))
				: localize('claudeFastDetailCooling', "Cooling down, using standard speed");
		case 'unavailable':
			return localize('claudeFastDetailUnavailable', "Unavailable: {0}", claudeFastModeReasonText(status.reason, status.detail));
		default:
			return localize('claudeFastModeDetail', "Faster, costs more");
	}
}

/**
 * The one quiet notice when fast mode drops from running to cooling down or unavailable.
 * Undefined for every other change, so a repeat or a recovery says nothing (issue 456).
 */
export function claudeFastModeDropNotice(previous: ClaudeFastModeStatus | undefined, status: ClaudeFastModeStatus): string | undefined {
	if (previous?.state !== 'on') {
		return undefined;
	}
	if (status.state === 'cooldown') {
		return localize('claudeFastNoticeCooldown', "Fast mode paused after a rate limit; using standard speed");
	}
	if (status.state === 'unavailable') {
		return localize('claudeFastNoticeUnavailable', "Fast mode is unavailable ({0}); using standard speed", claudeFastModeReasonText(status.reason, status.detail));
	}
	return undefined;
}

/** A prompt long enough that planning first likely pays off: many words, or many lines. */
export function isLongClaudePrompt(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.split(/\s+/).length >= 60 || trimmed.split('\n').length >= 6;
}

export type ClaudeModelFamily = 'opus' | 'sonnet' | 'fable' | 'haiku' | 'other' | 'custom';

const FAMILY_ORDER: readonly ClaudeModelFamily[] = ['opus', 'sonnet', 'fable', 'haiku', 'other', 'custom'];

/** The family a model belongs to, from the id it resolves to, else its own id. */
export function claudeModelFamily(model: ClaudeModelInfo): ClaudeModelFamily {
	if (model.source === 'custom') {
		return 'custom';
	}
	const name = `${model.resolvedModel ?? ''} ${model.id}`.toLowerCase();
	for (const family of ['opus', 'sonnet', 'fable', 'haiku'] as const) {
		if (name.includes(family)) {
			return family;
		}
	}
	return 'other';
}

/** Where a model sits in the list: Claude Code's lineup, the older models it still runs, or custom ids. */
export type ClaudeModelSection = 'current' | 'older' | 'custom';

const SECTION_ORDER: readonly ClaudeModelSection[] = ['current', 'older', 'custom'];

function claudeModelSection(model: ClaudeModelInfo): ClaudeModelSection {
	return model.source === 'custom' ? 'custom' : model.older ? 'older' : 'current';
}

/** The header over a section. The lineup has none. */
export function claudeModelSectionLabel(section: ClaudeModelSection): string | undefined {
	switch (section) {
		case 'current': return undefined;
		case 'older': return localize('claudeOlderModels', "Older Models");
		case 'custom': return localize('claudeCustomModels', "Custom");
	}
}

/**
 * Models in menu order: the lineup, then older models, then custom ids, each
 * sorted by family. A model's 1M-context variant is left out when its standard
 * one is listed: the Context row switches between them.
 */
export function groupClaudeModels(models: readonly ClaudeModelInfo[]): { readonly section: ClaudeModelSection; readonly models: readonly ClaudeModelInfo[] }[] {
	const ids = new Set(models.map(model => model.id));
	const shown = models.filter(model => !(isLongContext(model.id) && ids.has(standardId(model.id))));
	const groups: { section: ClaudeModelSection; models: ClaudeModelInfo[] }[] = [];
	for (const section of SECTION_ORDER) {
		const members = shown.filter(model => claudeModelSection(model) === section);
		members.sort((a, b) => FAMILY_ORDER.indexOf(claudeModelFamily(a)) - FAMILY_ORDER.indexOf(claudeModelFamily(b)));
		if (members.length > 0) {
			groups.push({ section, models: members });
		}
	}
	return groups;
}

/**
 * The name the menu shows: the model and its version (an alias named "Opus" reads
 * "Opus 5.5"), keeping Claude Code's "(1M context)" on a 1M row. Claude Code's
 * `opusplan` alias gets a name that says what it does.
 */
export function claudeModelName(model: ClaudeModelInfo): string {
	if (model.id === 'opusplan' && (model.displayName === model.id || !model.displayName)) {
		return localize('claudeOpusPlan', "Opus Plan");
	}
	const name = claudeModelDisplayName(model);
	const qualifier = isLongContext(model.id) ? model.displayName?.match(/\s*\(.*\)$/)?.[0] : undefined;
	return qualifier && !name.endsWith(qualifier) ? name + qualifier : name;
}

/** What a model is for, shown in its hover card. */
export function claudeModelDescription(model: ClaudeModelInfo): string | undefined {
	if (model.source === 'custom') {
		return localize('claudeCustomModel', "Custom model ID");
	}
	if (model.id === 'opusplan' && !model.description) {
		return localize('claudeOpusPlanDesc', "Opus plans, Sonnet builds");
	}
	return model.description;
}

/**
 * A short hover card for a model row: its name, what it is for, and its effort
 * range. Undefined when there is nothing to add to the name.
 */
export function claudeModelHover(model: ClaudeModelInfo): string | undefined {
	const lines = [claudeModelName(model)];
	const description = claudeModelDescription(model);
	if (description) {
		lines.push(description);
	}
	const levels = claudeEffortLevelsFor(model);
	if (levels.length > 1) {
		lines.push(localize('claudeModelEffortRange', "Effort: {0} to {1}", claudeEffortLabel(levels[0]), claudeEffortLabel(levels[levels.length - 1])));
	} else if (levels.length === 1) {
		lines.push(localize('claudeModelEffortOne', "Effort: {0}", claudeEffortLabel(levels[0])));
	}
	return lines.length > 1 ? lines.join('\n') : undefined;
}

/** The standard and 1M-context variants of a model, when the runtime reports both. */
export interface ClaudeContextChoice {
	readonly standard: ClaudeModelInfo;
	readonly long: ClaudeModelInfo;
	readonly isLong: boolean;
}

export function claudeContextChoice(models: readonly ClaudeModelInfo[], modelId: string | undefined): ClaudeContextChoice | undefined {
	if (!modelId) {
		return undefined;
	}
	const base = standardId(modelId);
	const standard = models.find(model => model.id === base);
	const long = models.find(model => model.id === base + LONG_CONTEXT_SUFFIX);
	return standard && long ? { standard, long, isLong: isLongContext(modelId) } : undefined;
}

function isLongContext(id: string): boolean {
	return id.toLowerCase().endsWith(LONG_CONTEXT_SUFFIX);
}

function standardId(id: string): string {
	return isLongContext(id) ? id.slice(0, -LONG_CONTEXT_SUFFIX.length) : id;
}
