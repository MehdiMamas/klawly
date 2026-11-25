/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** US dollars per million tokens, for one model family (issue 836). */
export interface ClaudeModelPrice {
	readonly input: number;
	readonly output: number;
	/** Reading a cached prompt. */
	readonly cacheRead: number;
	/** Writing a prompt to the 5 minute cache. */
	readonly cacheWrite: number;
}

/** The tokens one run used, by kind. Each is the count the runtime reports and absent means none. */
export interface ClaudeTokenUsage {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
}

/**
 * The one price table. Claude Code reports a cost for the main loop (`total_cost_usd`); runs it does not
 * price, such as subagents, are estimated from their tokens with these rates. Cache reads cost a tenth of
 * input and cache writes 1.25 times input.
 */
export const CLAUDE_MODEL_PRICES: Readonly<Record<'opus' | 'sonnet' | 'haiku', ClaudeModelPrice>> = {
	opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/** The family a model id or name belongs to, or undefined when it is not one Klawly can price. */
export function claudeModelFamily(model: string | undefined): keyof typeof CLAUDE_MODEL_PRICES | undefined {
	const lower = model?.toLowerCase() ?? '';
	for (const family of ['opus', 'sonnet', 'haiku'] as const) {
		if (lower.includes(family)) {
			return family;
		}
	}
	return undefined;
}

/** What the tokens cost on `model`, or undefined when the model is unknown. Never guesses a family. */
export function claudeEstimateCostUsd(model: string | undefined, usage: ClaudeTokenUsage): number | undefined {
	const family = claudeModelFamily(model);
	if (!family) {
		return undefined;
	}
	const price = CLAUDE_MODEL_PRICES[family];
	const million = 1_000_000;
	return ((usage.inputTokens ?? 0) * price.input
		+ (usage.outputTokens ?? 0) * price.output
		+ (usage.cacheReadTokens ?? 0) * price.cacheRead
		+ (usage.cacheWriteTokens ?? 0) * price.cacheWrite) / million;
}
