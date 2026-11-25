/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeAutoApproach, ClaudeAutoApproachStep, ClaudeAutoApproachThresholds, CLAUDE_AUTO_APPROACH_DEFAULT_THRESHOLDS, pickAutoApproach } from './claudeAutoApproach.js';
import { ClaudeAutoComplexity } from './claudeAutoModel.js';
import { ClaudeDelegateTier } from './claudeDelegateContract.js';

/**
 * Delegation tiers (issue 838): small is Haiku (lookups, mechanical runs),
 * medium is Sonnet (builds from a brief), large is the chat's own model, and
 * only with a named reason. Pure, so the service, the settings and the tests
 * share it.
 */

export const CLAUDE_DELEGATION_TIER_MODEL_SETTINGS: Readonly<Record<ClaudeDelegateTier, string>> = {
	small: 'klawly.delegation.tierModel.small',
	medium: 'klawly.delegation.tierModel.medium',
	large: 'klawly.delegation.tierModel.large',
};

/** The model alias each tier runs by default. An empty alias is the chat's own model. */
export const CLAUDE_DELEGATION_TIER_MODEL_DEFAULTS: Readonly<Record<ClaudeDelegateTier, string>> = {
	small: 'haiku',
	medium: 'sonnet',
	large: '',
};

/** A trimmed, non-empty string, or the tier's default. */
export function readClaudeDelegationTierModel(tier: ClaudeDelegateTier, value: unknown): string {
	return typeof value === 'string' && value.trim() ? value.trim() : CLAUDE_DELEGATION_TIER_MODEL_DEFAULTS[tier];
}

export type ClaudeDelegationTierModels = Readonly<Record<ClaudeDelegateTier, string>>;

/** What a delegated task asks the router. */
export interface ClaudeDelegateRouteInput {
	readonly tier?: ClaudeDelegateTier;
	readonly reason?: string;
	/** A model the caller named. */
	readonly model?: string;
	readonly orchestrates?: boolean;
	/** The delegating chat's model id or name. */
	readonly parentModel?: string;
	/** What the Auto classifier (or the local estimate) rated the task, when no tier or model was given. */
	readonly complexity?: ClaudeAutoComplexity;
	/** The classifier's reason, used as the reason for a large pick. */
	readonly classifierReason?: string;
	readonly models: ClaudeDelegationTierModels;
}

export interface ClaudeDelegateRoute {
	/** The tier the worker runs as. Undefined when the caller named a model. */
	readonly tier?: ClaudeDelegateTier;
	/** The model alias to resolve. Undefined is the delegating chat's own model. */
	readonly modelAlias?: string;
	readonly classifierSkipped: boolean;
	readonly why: string;
}

const COMPLEXITY_TIER: Readonly<Record<ClaudeAutoComplexity, ClaudeDelegateTier>> = { simple: 'small', moderate: 'medium', complex: 'large' };

function isOpus(model: string | undefined): boolean {
	return !!model && model.toLowerCase().includes('opus');
}

/** Picks the tier and the model a delegated task runs on. */
export function routeDelegateTier(input: ClaudeDelegateRouteInput): ClaudeDelegateRoute {
	const named = input.model?.trim();
	if (named) {
		// A named model wins; a tier given with it is only recorded.
		return { ...(input.tier !== undefined ? { tier: input.tier } : {}), modelAlias: named, classifierSkipped: true, why: 'model named' };
	}
	let tier = input.tier;
	let reason = input.reason?.trim();
	let classifierSkipped = true;
	let source = 'tier and reason given';
	if (tier === undefined) {
		classifierSkipped = false;
		tier = COMPLEXITY_TIER[input.complexity ?? 'moderate'];
		reason = input.classifierReason?.trim();
		source = `classifier rated it ${input.complexity ?? 'moderate'}`;
	} else if (!reason) {
		source = 'tier given';
	}
	let why = source;
	if (tier === 'large') {
		if (!reason) {
			tier = 'medium';
			why = `${source}; large needs a reason, so it runs as medium`;
		} else if (isOpus(input.parentModel) && input.orchestrates !== true) {
			tier = 'medium';
			why = `${source}; an Opus chat's large worker runs Sonnet unless it orchestrates`;
		}
	}
	const alias = input.models[tier].trim();
	return { tier, modelAlias: alias || undefined, classifierSkipped, why };
}

/** Who does one plan step in Auto mode (issue 1206). */
export interface ClaudeAutoStepRoute {
	readonly approach: ClaudeAutoApproach;
	/** Run the step in the chat itself with no helper: a short job, or the strong model working alone. */
	readonly inline: boolean;
	/** A free tool does the step; no model runs. */
	readonly freeTool: boolean;
	/** The helper tier, when a helper runs. */
	readonly tier?: ClaudeDelegateTier;
	/** The model alias for the helper. Undefined is the chat's own model. */
	readonly modelAlias?: string;
	/** The strong model that plans and reviews, for plan-build. */
	readonly plannerAlias?: string;
	readonly why: string;
}

/**
 * Mixed models in Auto mode: the strong model (the chat's own) plans and
 * reviews, the medium tier builds, the small tier or a free tool does
 * mechanical steps. A short task, or a step that failed twice, runs in the
 * chat itself. The decision comes from `pickAutoApproach`.
 */
export function routeAutoStep(input: {
	readonly step: ClaudeAutoApproachStep;
	/** All steps of the task, so a short task is seen as a whole. */
	readonly steps: readonly ClaudeAutoApproachStep[];
	readonly models: ClaudeDelegationTierModels;
	readonly failures?: number;
	readonly thresholds?: Partial<ClaudeAutoApproachThresholds>;
}): ClaudeAutoStepRoute {
	const small = input.models.small.trim();
	const medium = input.models.medium.trim();
	const strong = input.models.large.trim();
	const decision = pickAutoApproach({
		steps: input.steps,
		models: { cheap: { id: 'small' }, mid: { id: 'medium' }, strong: { id: 'large' } },
		failures: { [input.step.id]: input.failures ?? 0 },
		thresholds: input.thresholds,
	}).find(d => d.stepId === input.step.id);
	if (!decision) {
		return { approach: 'solo-strong', inline: true, freeTool: false, why: 'step not found, so the chat does it' };
	}
	if (decision.approach === 'mechanical') {
		if (decision.modelId === undefined) {
			return { approach: 'mechanical', inline: false, freeTool: true, why: decision.reason };
		}
		return { approach: 'mechanical', inline: false, freeTool: false, tier: 'small', modelAlias: small || undefined, why: decision.reason };
	}
	if (decision.approach === 'plan-build') {
		const totalCalls = input.steps.reduce((sum, step) => sum + step.toolCalls, 0);
		const shortTaskCalls = input.thresholds?.shortTaskCalls ?? CLAUDE_AUTO_APPROACH_DEFAULT_THRESHOLDS.shortTaskCalls;
		if (totalCalls <= shortTaskCalls) {
			return { approach: 'plan-build', inline: true, freeTool: false, why: `short task, so the chat does it with no helper (${decision.reason})` };
		}
		return { approach: 'plan-build', inline: false, freeTool: false, tier: 'medium', modelAlias: medium || undefined, plannerAlias: strong || undefined, why: decision.reason };
	}
	return { approach: 'solo-strong', inline: true, freeTool: false, why: decision.reason };
}

/** An idle, finished helper that could take a new task. */
export interface ClaudeIdleHelper {
	readonly id: string;
	readonly tier: ClaudeDelegateTier;
	readonly idle: boolean;
	readonly finished: boolean;
	/** Same folder as the new task. */
	readonly sameFolder: boolean;
	/** When it last finished; the newest is reused. */
	readonly finishedAt: number;
}

/** The idle helper of the same tier to reuse (after compacting it), instead of starting a new one. */
export function pickReusableHelper(tier: ClaudeDelegateTier, helpers: readonly ClaudeIdleHelper[]): ClaudeIdleHelper | undefined {
	return helpers
		.filter(h => h.tier === tier && h.idle && h.finished && h.sameFolder)
		.sort((a, b) => b.finishedAt - a.finishedAt)[0];
}

/** One line of the decision log. */
export interface ClaudeDelegateDecision {
	readonly time: number;
	/** The tier the worker ran as. */
	readonly tier?: ClaudeDelegateTier;
	readonly requestedTier?: ClaudeDelegateTier;
	readonly reason?: string;
	readonly model?: string;
	readonly why: string;
	readonly classifierSkipped: boolean;
	/** The delegated run the decision started, so its tokens are added when it ends (issue 987). */
	readonly runId?: string;
	readonly tokens?: ClaudeDelegateRunTokens;
}

/** What a delegated run used, from the usage its chat reported. */
export interface ClaudeDelegateRunTokens {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

/** The entry as one JSON line, without a line break inside. */
export function formatDecisionLogLine(entry: ClaudeDelegateDecision): string {
	const line: Record<string, unknown> = {
		time: new Date(entry.time).toISOString(),
		tier: entry.tier ?? null,
		requestedTier: entry.requestedTier ?? null,
		reason: entry.reason ?? null,
		model: entry.model ?? null,
		why: entry.why,
		classifierSkipped: entry.classifierSkipped,
	};
	if (entry.runId !== undefined) {
		line.runId = entry.runId;
	}
	if (entry.tokens !== undefined) {
		line.tokens = entry.tokens;
	}
	return JSON.stringify(line);
}

/** The log line with the run's tokens added when it is that run's decision, otherwise the line unchanged. */
export function addDecisionTokens(line: string, runId: string, tokens: ClaudeDelegateRunTokens): string {
	let entry: Record<string, unknown>;
	try {
		entry = JSON.parse(line);
	} catch {
		return line;
	}
	if (entry.runId !== runId || entry.kind !== undefined) {
		return line;
	}
	return JSON.stringify({ ...entry, tokens });
}
