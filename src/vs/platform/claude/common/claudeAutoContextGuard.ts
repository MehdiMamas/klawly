/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';

/**
 * Auto mode context guard (issue 846, epic 1215): one chat or helper never
 * carries on in a large context. At 80% of the cap the composer nudges; at the
 * cap Auto compacts the chat and goes on with the summary. A pure function of
 * numbers: no services, no I/O.
 */

/** Most context tokens one chat or helper may hold. */
export const CLAUDE_AUTO_CONTEXT_CAP_TOKENS_SETTING = 'claude.auto.context.capTokens';
export const CLAUDE_AUTO_CONTEXT_CAP_TOKENS_DEFAULT = 150000;
export const CLAUDE_AUTO_CONTEXT_CAP_TOKENS_MIN = 20000;
export const CLAUDE_AUTO_CONTEXT_CAP_TOKENS_MAX = 1000000;

/** The share of the cap where the nudge starts. */
export const CLAUDE_AUTO_CONTEXT_NUDGE_FRACTION = 0.8;

export type ClaudeAutoContextState = 'ok' | 'nudge' | 'handoff';

/** Reads the cap. Anything but a number in range falls back to the default. */
export function readClaudeAutoContextCap(get: (key: string) => unknown): number {
	const value = get(CLAUDE_AUTO_CONTEXT_CAP_TOKENS_SETTING);
	if (typeof value !== 'number' || !Number.isFinite(value) || value < CLAUDE_AUTO_CONTEXT_CAP_TOKENS_MIN || value > CLAUDE_AUTO_CONTEXT_CAP_TOKENS_MAX) {
		return CLAUDE_AUTO_CONTEXT_CAP_TOKENS_DEFAULT;
	}
	return Math.floor(value);
}

/** A model whose window is smaller than the cap gets the cap scaled down to 80% of its window, so the guard fires before the model compacts itself. */
export function scaleClaudeAutoContextCap(cap: number, window: number | undefined): number {
	if (window === undefined || !Number.isFinite(window) || window <= 0) {
		return cap;
	}
	return Math.min(cap, Math.floor(window * CLAUDE_AUTO_CONTEXT_NUDGE_FRACTION));
}

/** ok below 80% of the effective cap, nudge from 80%, handoff at the cap. */
export function claudeAutoContextState(used: number, cap: number, window?: number): ClaudeAutoContextState {
	const effective = scaleClaudeAutoContextCap(cap, window);
	if (!Number.isFinite(used) || used < 0 || effective <= 0) {
		return 'ok';
	}
	if (used >= effective) {
		return 'handoff';
	}
	return used >= effective * CLAUDE_AUTO_CONTEXT_NUDGE_FRACTION ? 'nudge' : 'ok';
}

export function claudeAutoContextNudgeLabel(): string {
	return localize('claudeAutoContextNudge', "Context Is Getting Large");
}

export function claudeAutoContextNudgeDetail(): string {
	return localize('claudeAutoContextNudgeDetail', "Auto compacts this chat when it reaches the cap");
}

/** One log line for a handoff or compaction (issue 849 reads these). */
export function formatClaudeAutoContextLogLine(sessionId: string, used: number, cap: number): string {
	return `[auto] context handoff: session ${sessionId} compacted at ${used} of ${cap} tokens`;
}
