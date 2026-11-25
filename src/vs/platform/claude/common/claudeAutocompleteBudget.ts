/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_AUTOCOMPLETE_PREFIX_CHARS, CLAUDE_AUTOCOMPLETE_SUFFIX_CHARS, completionLatencyPercentiles } from './claudeAutocomplete.js';

/** How much text around the cursor one Tab request sends. */
export interface TabContextBudget {
	readonly prefixChars: number;
	readonly suffixChars: number;
}

export interface TabContextBudgetOptions {
	/** P95 above this shrinks the context one step. */
	readonly targetP95Ms: number;
	/** P95 at or below this grows it one step again. Lower than the target, so the size does not flap. */
	readonly growBelowP95Ms: number;
	/** Recent samples kept for the decision. */
	readonly window: number;
	/** Samples needed after the last change before the next decision. */
	readonly minSamples: number;
	/** Context sizes from the default down to the floor, as fractions of the default. */
	readonly steps: readonly number[];
}

export const DEFAULT_TAB_CONTEXT_BUDGET_OPTIONS: TabContextBudgetOptions = {
	targetP95Ms: 900,
	growBelowP95Ms: 650,
	window: 20,
	minSamples: 8,
	steps: [1, 0.75, 0.5, 0.25],
};

/**
 * Picks the Tab context size from measured latency (spec 31: measure P50/P95
 * and tune context). Every sample is one model call that completed. When the
 * P95 of the recent window is above the target, the prefix and suffix shrink
 * one step, down to the last step (the floor). When it is back well under the
 * target, they grow one step, up to the default. After each change the window
 * starts again, so the next decision only uses calls made at the new size.
 */
export class TabContextBudgetController {
	private readonly _samples: number[] = [];
	private _step = 0;

	constructor(
		private readonly _options: TabContextBudgetOptions = DEFAULT_TAB_CONTEXT_BUDGET_OPTIONS,
		private readonly _default: TabContextBudget = { prefixChars: CLAUDE_AUTOCOMPLETE_PREFIX_CHARS, suffixChars: CLAUDE_AUTOCOMPLETE_SUFFIX_CHARS },
	) { }

	/** The size the next request uses. */
	current(): TabContextBudget {
		const fraction = this._options.steps[this._step] ?? 1;
		return {
			prefixChars: Math.round(this._default.prefixChars * fraction),
			suffixChars: Math.round(this._default.suffixChars * fraction),
		};
	}

	/**
	 * Adds one latency sample. Returns the new budget and the P95 that moved it
	 * when the size changed, otherwise undefined.
	 */
	record(elapsedMs: number): { readonly budget: TabContextBudget; readonly p95: number } | undefined {
		if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
			return undefined;
		}
		this._samples.push(elapsedMs);
		if (this._samples.length > this._options.window) {
			this._samples.shift();
		}
		if (this._samples.length < this._options.minSamples) {
			return undefined;
		}
		const p95 = completionLatencyPercentiles(this._samples)?.p95;
		if (p95 === undefined) {
			return undefined;
		}
		let next = this._step;
		if (p95 > this._options.targetP95Ms) {
			next = Math.min(this._step + 1, this._options.steps.length - 1);
		} else if (p95 <= this._options.growBelowP95Ms) {
			next = Math.max(this._step - 1, 0);
		}
		if (next === this._step) {
			return undefined;
		}
		this._step = next;
		this._samples.length = 0;
		return { budget: this.current(), p95 };
	}

	/** Back to the default size with no samples, for example when Tab is turned off. */
	reset(): void {
		this._step = 0;
		this._samples.length = 0;
	}
}

/** One line for the Claude Agent output channel when the Tab context size changes. Numbers only. */
export function formatTabContextBudget(budget: TabContextBudget, p95: number): string {
	return `[claude] tab context prefix=${budget.prefixChars} suffix=${budget.suffixChars} p95=${p95}ms\n`;
}
