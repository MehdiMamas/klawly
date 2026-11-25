/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeAutomation, CLAUDE_AUTOMATION_DEFAULT_BUDGET_USD } from './claudeAutomation.js';
import { CLAUDE_LOOP_DEFAULT_WAKEUP_MS, ClaudeGoalCommand, claudeGoalStartPrompt, ClaudeLoopCommand } from './claudeGoalLoop.js';

/** Longest name an automation made from a goal or loop gets. */
const MAX_NAME = 60;

/**
 * Keep a goal or loop running after its chat closed (issue 1026): the pieces of
 * an automation that runs the same thing in the background. A loop becomes a
 * schedule on its interval, which a self-paced loop has none of, so it gets the
 * default wait. A goal becomes a run you start with Run Now; the run itself
 * keeps working inside the goal's turn and spend limits. A goal's check command
 * needs the chat's terminal, so the run checks the outcome itself.
 */
export function claudeLoopAutomation(loop: ClaudeLoopCommand, id: string): ClaudeAutomation {
	return {
		id,
		name: automationName('Loop', loop.prompt),
		prompt: loop.prompt,
		trigger: { type: 'schedule', cron: claudeIntervalCron(loop.intervalMs ?? CLAUDE_LOOP_DEFAULT_WAKEUP_MS) },
		permissionMode: 'agent',
		target: 'worktree',
		budgetUsd: CLAUDE_AUTOMATION_DEFAULT_BUDGET_USD,
		allowedTools: [],
		enabled: true,
	};
}

export function claudeGoalAutomation(goal: ClaudeGoalCommand, id: string, limits: { readonly maxTurns: number; readonly maxBudgetUsd?: number }): ClaudeAutomation {
	return {
		id,
		name: automationName('Goal', goal.outcome),
		prompt: claudeGoalStartPrompt({ ...goal, check: undefined }),
		trigger: { type: 'manual' },
		permissionMode: 'agent',
		target: 'worktree',
		budgetUsd: limits.maxBudgetUsd ?? CLAUDE_AUTOMATION_DEFAULT_BUDGET_USD,
		maxTurns: limits.maxTurns,
		allowedTools: [],
		enabled: true,
	};
}

/** The five-field cron expression that fires about every `intervalMs`: whole minutes (at least 1), then whole hours, then daily. */
export function claudeIntervalCron(intervalMs: number): string {
	const minutes = Math.max(1, Math.round(intervalMs / 60_000));
	if (minutes < 60) {
		return minutes === 1 ? '* * * * *' : `*/${minutes} * * * *`;
	}
	const hours = Math.round(minutes / 60);
	return hours < 24 ? (hours === 1 ? '0 * * * *' : `0 */${hours} * * *`) : '0 0 * * *';
}

/** An id of letters, digits, `_` and `-` for a new automation: `loop-` or `goal-` and a suffix the caller makes unique. */
export function claudeGoalLoopAutomationId(kind: 'goal' | 'loop', suffix: string): string {
	return `${kind}-${suffix.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

function automationName(kind: string, text: string): string {
	const line = text.replace(/\s+/g, ' ').trim();
	return `${kind}: ${line.length > MAX_NAME ? `${line.slice(0, MAX_NAME - 1)}…` : line}`;
}
