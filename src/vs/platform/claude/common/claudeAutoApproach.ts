/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';

/**
 * Auto mode approach picker (issue 1217, epic 1215): for each step of a plan,
 * who does it. A pure function: no services, no I/O.
 */

/** What a plan step needs: thinking, building code, or a lookup, CI run or merge. */
export type ClaudeAutoStepKind = 'judgment' | 'build' | 'mechanical';

/** `solo-strong`: the strong model does it alone. `plan-build`: the strong model plans and reviews, the mid model builds. `mechanical`: a free tool, else the cheapest model. */
export type ClaudeAutoApproach = 'solo-strong' | 'plan-build' | 'mechanical';

/** The model tiers, cheapest first. */
export type ClaudeAutoApproachTier = 'cheap' | 'mid' | 'strong';

const TIER_ORDER: readonly ClaudeAutoApproachTier[] = ['cheap', 'mid', 'strong'];

export interface ClaudeAutoApproachStep {
	readonly id: string;
	readonly kind: ClaudeAutoStepKind;
	/** Estimated tool calls. */
	readonly toolCalls: number;
	/** A free tool (CI wait, test runner, merge gate) can do this step without a model. */
	readonly freeTool?: boolean;
}

export interface ClaudeAutoApproachModel {
	readonly id: string;
	/** Rate-limited right now, so it is skipped. */
	readonly rateLimited?: boolean;
}

export type ClaudeAutoApproachModels = Partial<Record<ClaudeAutoApproachTier, ClaudeAutoApproachModel>>;

export interface ClaudeAutoApproachThresholds {
	/** A task of at most this many estimated tool calls is short. Default 20. */
	readonly shortTaskCalls: number;
	/** A step that failed this many times moves to the strong model. Default 2. */
	readonly escalateAfterFailures: number;
}

export const CLAUDE_AUTO_APPROACH_DEFAULT_THRESHOLDS: ClaudeAutoApproachThresholds = { shortTaskCalls: 20, escalateAfterFailures: 2 };

export interface ClaudeAutoApproachInput {
	readonly steps: readonly ClaudeAutoApproachStep[];
	readonly models: ClaudeAutoApproachModels;
	/** Failures so far, by step id. */
	readonly failures?: Readonly<Record<string, number>>;
	readonly thresholds?: Partial<ClaudeAutoApproachThresholds>;
}

export interface ClaudeAutoApproachDecision {
	readonly stepId: string;
	readonly approach: ClaudeAutoApproach;
	/** The model that does the step. Undefined when a free tool does it, or when no model is usable. */
	readonly modelId?: string;
	/** For `plan-build`: the model that plans and reviews. */
	readonly plannerModelId?: string;
	/** Plain words: which rule fired, and any fallback. */
	readonly reason: string;
}

interface Resolved {
	readonly tier: ClaudeAutoApproachTier;
	readonly id: string;
}

/** The wanted tier if usable, else the next one up, else the next ones down. */
function resolve(models: ClaudeAutoApproachModels, want: ClaudeAutoApproachTier): Resolved | undefined {
	const wanted = TIER_ORDER.indexOf(want);
	const order = [...TIER_ORDER.slice(wanted), ...TIER_ORDER.slice(0, wanted).reverse()];
	for (const tier of order) {
		const model = models[tier];
		if (model && !model.rateLimited) {
			return { tier, id: model.id };
		}
	}
	return undefined;
}

/** Empty when the wanted tier was used; otherwise says which fallback applied. */
function fallbackNote(want: ClaudeAutoApproachTier, got: Resolved | undefined): string {
	if (!got) {
		return localize('claudeAutoApproachNoModel', "no model is available");
	}
	if (got.tier === want) {
		return '';
	}
	return TIER_ORDER.indexOf(got.tier) > TIER_ORDER.indexOf(want)
		? localize('claudeAutoApproachTierUp', "the {0} model is unavailable, so one tier up is used", want)
		: localize('claudeAutoApproachTierDown', "the {0} model is unavailable, so the best available is used", want);
}

function withNote(reason: string, note: string): string {
	return note ? localize('claudeAutoApproachWithNote', "{0} ({1})", reason, note) : reason;
}

/** Picks the approach and model for each plan step. */
export function pickAutoApproach(input: ClaudeAutoApproachInput): readonly ClaudeAutoApproachDecision[] {
	const thresholds = { ...CLAUDE_AUTO_APPROACH_DEFAULT_THRESHOLDS, ...input.thresholds };
	const totalCalls = input.steps.reduce((sum, step) => sum + step.toolCalls, 0);
	const isShort = totalCalls <= thresholds.shortTaskCalls;
	const hasJudgment = input.steps.some(step => step.kind === 'judgment');
	const strong = resolve(input.models, 'strong');
	const strongNote = fallbackNote('strong', strong);

	return input.steps.map((step): ClaudeAutoApproachDecision => {
		const failures = input.failures?.[step.id] ?? 0;
		if (failures >= thresholds.escalateAfterFailures) {
			return {
				stepId: step.id, approach: 'solo-strong', modelId: strong?.id,
				reason: withNote(localize('claudeAutoApproachEscalated', "failed {0} times, so the strong model takes over", failures), strongNote),
			};
		}
		if (step.kind === 'mechanical') {
			if (step.freeTool) {
				return { stepId: step.id, approach: 'mechanical', reason: localize('claudeAutoApproachMechanicalTool', "mechanical work, done by a free tool") };
			}
			const cheap = resolve(input.models, 'cheap');
			return {
				stepId: step.id, approach: 'mechanical', modelId: cheap?.id,
				reason: withNote(localize('claudeAutoApproachMechanicalModel', "mechanical work, done by the cheapest model"), fallbackNote('cheap', cheap)),
			};
		}
		if (step.kind === 'build') {
			const mid = resolve(input.models, 'mid');
			return {
				stepId: step.id, approach: 'plan-build', modelId: mid?.id, plannerModelId: strong?.id,
				reason: withNote(localize('claudeAutoApproachBuild', "build work: the strong model plans and reviews, the mid model builds"), fallbackNote('mid', mid) || strongNote),
			};
		}
		return {
			stepId: step.id, approach: 'solo-strong', modelId: strong?.id,
			reason: withNote(isShort && hasJudgment
				? localize('claudeAutoApproachShortJudgment', "short task ({0} tool calls or fewer) that needs judgment, so the strong model works alone", thresholds.shortTaskCalls)
				: localize('claudeAutoApproachJudgment', "judgment work, so the strong model does it"), strongNote),
		};
	});
}
