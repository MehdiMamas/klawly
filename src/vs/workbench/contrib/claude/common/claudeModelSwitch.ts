/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeModelInfo } from '../../../../platform/claude/common/claude.js';
import { CLAUDE_DEFAULT_MODEL_ALIAS } from '../../../../platform/claude/common/claudeModels.js';
import { UsageInfo } from '../../../../platform/claude/common/claudeProtocol.js';
import { TurnViewModel } from '../../../services/claude/common/claudeAgentState.js';
import { claudeContextUsage } from './claudeComposerState.js';

/** Turns the notice off for good: "Don't Show Again" writes false here (issue 703). */
export const CLAUDE_MODELS_WARN_ON_SWITCH_SETTING = 'claude.models.warnOnSwitch';

/** What the "should warn" rule needs to know about one model pick. */
export interface ClaudeModelSwitchInput {
	/** Turns of the chat that finished: complete, failed or stopped. */
	readonly finishedTurns: number;
	/** The model the chat ran on before the pick: the session's model, Auto's last pick, or undefined for Claude Code's default. */
	readonly from: string | undefined;
	readonly to: string;
	/** The models Claude Code reported, so an alias and the model it resolves to count as one. */
	readonly models: readonly ClaudeModelInfo[];
	/** Auto picked the model itself. Its own switches never warn here (issue 693). */
	readonly auto: boolean;
	/** `claude.models.warnOnSwitch`. */
	readonly enabled: boolean;
}

/**
 * Issue 703: Claude Code caches the conversation per model, so a new model's
 * next message reads the whole chat again without the cache. Warn when the
 * user picks a different model in a chat with at least one finished turn;
 * never for an empty chat, Auto's own picks, or with the setting off.
 */
export function claudeModelSwitchWarns(input: ClaudeModelSwitchInput): boolean {
	if (!input.enabled || input.auto || input.finishedTurns === 0) {
		return false;
	}
	return canonicalClaudeModel(input.from, input.models) !== canonicalClaudeModel(input.to, input.models);
}

/** The id a model runs as: `default` and aliases such as `opus` become the model they resolve to, when Claude Code says. */
export function canonicalClaudeModel(id: string | undefined, models: readonly ClaudeModelInfo[]): string {
	const key = id ?? CLAUDE_DEFAULT_MODEL_ALIAS;
	const row = models.find(model => model.id === key);
	if (row?.resolvedModel) {
		return row.resolvedModel;
	}
	// A runtime that reports no default alias runs its first model when none is picked.
	if (key === CLAUDE_DEFAULT_MODEL_ALIAS && !row && models.length) {
		return models[0].resolvedModel ?? models[0].id;
	}
	return key;
}

/** Turns that ended, whatever the outcome: each one is in the conversation the new model reads. */
export function claudeFinishedTurns(turns: readonly Pick<TurnViewModel, 'status'>[]): number {
	return turns.filter(turn => turn.status !== 'running').length;
}

/**
 * The chat's size for the notice, from the numbers the context meter shows,
 * rounded to the thousand above 1,000. Undefined when Claude Code has not reported them: never a guess.
 */
export function claudeModelSwitchTokens(usage: UsageInfo | undefined): number | undefined {
	const used = claudeContextUsage(usage)?.used;
	if (!used) {
		return undefined;
	}
	return used < 1000 ? used : Math.round(used / 1000) * 1000;
}
