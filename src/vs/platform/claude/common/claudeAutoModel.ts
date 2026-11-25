/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeModelInfo } from './claude.js';
import { CLAUDE_DEFAULT_MODEL_ALIAS } from './claudeModels.js';
import { ClaudeEffortLevel } from './claudeSessionSettings.js';

/**
 * Auto model (issue 521): before each turn Klawly rates how hard the prompt is
 * and picks the effort. The agent that runs Auto is always the current Opus;
 * Sonnet and Haiku only run delegated workers and lookups (issue 1254).
 */

/** `claude.models.auto`: `auto` starts new agent sessions on Auto, `off` does not. */
export const CLAUDE_MODELS_AUTO_SETTING = 'claude.models.auto';

/** The values the setting held while Auto had three strategies. They still read as Auto on. */
const LEGACY_AUTO_VALUES: readonly unknown[] = ['auto', 'cost', 'balance', 'intelligence', true];

/** Whether a stored or configured value turns Auto on. Old strategy names count as on. */
export function readClaudeAutoOn(value: unknown): boolean {
	return LEGACY_AUTO_VALUES.includes(value);
}

/** How hard a prompt is, as the classifier (or the local estimate) rates it. */
export type ClaudeAutoComplexity = 'simple' | 'moderate' | 'complex';

const COMPLEXITIES: readonly ClaudeAutoComplexity[] = ['simple', 'moderate', 'complex'];

/** The model Auto classifies with: Claude Code's alias for its fastest model. */
export const CLAUDE_AUTO_CLASSIFIER_MODEL = 'haiku';

/** The prompt text the classifier reads at most. The rest says little more about how hard the task is. */
const CLASSIFIER_PROMPT_CHARS = 4000;

/** What the composer asks the runtime to classify. */
export interface ClaudeAutoModelRequest {
	/** Cancels it through `cancelAutoModel`. */
	readonly id: string;
	readonly prompt: string;
	readonly cwd: string;
	/** Tokens already in the session's context, as Claude Code last reported them. */
	readonly contextTokens?: number;
	/** The previous turn failed, so this one is likely a second try. */
	readonly retry?: boolean;
}

export type ClaudeAutoModelClassification =
	| { readonly ok: true; readonly complexity: ClaudeAutoComplexity; readonly reason?: string }
	| { readonly ok: false; readonly message: string; readonly cancelled?: boolean };

/** What Auto chose for one turn. The turn records it, so its header names the model it ran. */
export interface ClaudeAutoModelPick {
	readonly complexity: ClaudeAutoComplexity;
	readonly modelId: string;
	/** The model's name from the list Claude Code reported, for the turn's label. */
	readonly modelName?: string;
	readonly effort?: ClaudeEffortLevel;
	/** The classifier's one-line reason. Absent for the local estimate. */
	readonly reason?: string;
	/** `claude`: Haiku classified the prompt. `estimate`: it could not, so Klawly estimated from the prompt's size. */
	readonly source: 'claude' | 'estimate';
}

export const CLAUDE_AUTO_MODEL_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		complexity: { type: 'string', enum: [...COMPLEXITIES] },
		reason: { type: 'string', maxLength: 160 },
	},
	required: ['complexity'],
	additionalProperties: false,
};

/** The classifier's answer, or undefined when it does not match the schema. */
export function readClaudeAutoClassification(value: unknown): { readonly complexity: ClaudeAutoComplexity; readonly reason?: string } | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const candidate = value as { complexity?: unknown; reason?: unknown };
	const complexity = COMPLEXITIES.find(level => level === candidate.complexity);
	if (!complexity) {
		return undefined;
	}
	const reason = typeof candidate.reason === 'string' ? candidate.reason.trim().slice(0, 160) : '';
	return reason ? { complexity, reason } : { complexity };
}

/** The classifier's prompt: the task, how much context the session holds, and whether it is a second try. */
export function claudeAutoModelPrompt(request: Pick<ClaudeAutoModelRequest, 'prompt' | 'contextTokens' | 'retry'>): string {
	const prompt = request.prompt.length > CLASSIFIER_PROMPT_CHARS ? `${request.prompt.slice(0, CLASSIFIER_PROMPT_CHARS)}\n[...]` : request.prompt;
	return [
		'You route a request to a coding agent. Rate how hard the request is. Do not answer it.',
		'- simple: a short question, an explanation, a lookup, or a one-line change.',
		'- moderate: a change in one to a few files, a bug fix, a test, a small feature.',
		'- complex: architecture or design, a large refactor, a change across many files, a hard bug, or a task that already failed once.',
		`Tokens already in the session's context: ${request.contextTokens ?? 0}.`,
		`The previous turn failed: ${request.retry ? 'yes' : 'no'}.`,
		'Answer with the rating and a reason of at most twelve words.',
		'',
		'Request:',
		'<<<',
		prompt,
		'>>>',
	].join('\n');
}

const COMPLEX_WORDS = /\b(architect\w*|redesign|refactor\w*|migrat\w*|rewrite|overhaul|across the (?:code ?base|repo)|every file|all files)\b/i;
const SIMPLE_START = /^(?:what|why|how|where|which|who|when|is|are|does|do|can|explain|show|list|rename)\b/i;

/**
 * The rating Auto falls back to when the classifier cannot answer: a long
 * prompt, a large context or a design word is complex; a short question is
 * simple; the rest is moderate. A failed previous turn moves it up one level.
 */
export function estimateClaudeAutoComplexity(request: Pick<ClaudeAutoModelRequest, 'prompt' | 'contextTokens' | 'retry'>): ClaudeAutoComplexity {
	const text = request.prompt.trim();
	const words = text ? text.split(/\s+/).length : 0;
	const lines = text.split('\n').length;
	const context = request.contextTokens ?? 0;
	let complexity: ClaudeAutoComplexity;
	if (words > 150 || lines > 20 || context > 100_000 || COMPLEX_WORDS.test(text)) {
		complexity = 'complex';
	} else if (words <= 25 && lines <= 2 && context < 30_000 && (SIMPLE_START.test(text) || text.endsWith('?'))) {
		complexity = 'simple';
	} else {
		complexity = 'moderate';
	}
	return request.retry ? raise(complexity) : complexity;
}

function raise(complexity: ClaudeAutoComplexity): ClaudeAutoComplexity {
	return COMPLEXITIES[Math.min(COMPLEXITIES.indexOf(complexity) + 1, COMPLEXITIES.length - 1)];
}

/** The effort for each rating. */
const EFFORTS: Record<ClaudeAutoComplexity, ClaudeEffortLevel> = {
	simple: 'low',
	moderate: 'medium',
	complex: 'high',
};

/**
 * The model and effort Auto runs a turn on. `models` are the ones the user may
 * pick; Auto chooses only among Claude Code's current haiku, sonnet and opus
 * rows, never a custom id, an older model or a 1M-context variant. The model is
 * always the opus row; only when none is offered does it fall back to sonnet,
 * then haiku. The rating sets the effort. Undefined when none of the three
 * families is offered.
 */
export function pickClaudeAutoModel(complexity: ClaudeAutoComplexity, models: readonly ClaudeModelInfo[]): { readonly modelId: string; readonly effort: ClaudeEffortLevel } | undefined {
	for (const tier of ['opus', 'sonnet', 'haiku'] as const) {
		const model = models.find(candidate => autoTier(candidate) === tier);
		if (model) {
			return { modelId: model.id, effort: EFFORTS[complexity] };
		}
	}
	return undefined;
}

function autoTier(model: ClaudeModelInfo): 'haiku' | 'sonnet' | 'opus' | undefined {
	if (model.source === 'custom' || model.older || model.id === CLAUDE_DEFAULT_MODEL_ALIAS || /\[1m\]$/i.test(model.id)) {
		return undefined;
	}
	const name = `${model.resolvedModel ?? ''} ${model.id}`.toLowerCase();
	return (['haiku', 'sonnet', 'opus'] as const).find(tier => name.includes(tier));
}
