/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';

/**
 * Goals and loops (issue 486). `/goal <outcome>` keeps a chat working until a
 * check says the outcome is true; `/loop [interval] <prompt>` sends a prompt
 * again on a timer, or when Claude asks to be woken (`ScheduleWakeup`). This
 * file holds the parsing, the prompts Claude reads and the limits; the
 * workbench runs the turns.
 */

/** Most turns a goal sends, the first one included, before it stops for the user. */
/** The composer commands, without their slash. */
export const CLAUDE_GOAL_COMMAND = 'goal';
export const CLAUDE_LOOP_COMMAND = 'loop';

export const CLAUDE_GOAL_MAX_TURNS_SETTING = 'claude.goal.maxTurns';
export const CLAUDE_GOAL_MAX_TURNS_DEFAULT = 10;
/** What a goal may spend in US dollars, as Claude Code reports it. 0 means no cap. */
export const CLAUDE_GOAL_MAX_BUDGET_SETTING = 'claude.goal.maxBudgetUsd';
export const CLAUDE_GOAL_MAX_BUDGET_DEFAULT = 5;

/** Claude Code's tool that asks the host to run the next turn later. */
export const CLAUDE_SCHEDULE_WAKEUP_TOOL = 'ScheduleWakeup';

/** Shortest and longest wait between loop turns, and Claude's wakeup clamp (1 to 60 minutes). */
export const CLAUDE_LOOP_MIN_MS = 60_000;
export const CLAUDE_WAKEUP_MAX_MS = 60 * 60_000;
/** Longest fixed interval `/loop` takes. */
export const CLAUDE_LOOP_MAX_MS = 24 * 60 * 60_000;
/** The wait when a self-paced loop turn names none. */
export const CLAUDE_LOOP_DEFAULT_WAKEUP_MS = 10 * 60_000;

/** The line Claude ends a goal turn with when no check command is set. */
export const CLAUDE_GOAL_MET = 'Goal met';
export const CLAUDE_GOAL_NOT_MET = 'Goal not met';
/** The line that ends a self-paced loop. */
export const CLAUDE_LOOP_DONE = 'Loop done';

export interface ClaudeGoalCommand {
	readonly kind: 'goal';
	readonly outcome: string;
	/** A shell command that exits with 0 once the outcome is true. Without it, Claude says whether it is. */
	readonly check?: string;
	/** `--turns N`: turn limit for this goal instead of `claude.goal.maxTurns`. */
	readonly maxTurns?: number;
	/** `--budget N`: spend limit in US dollars for this goal instead of `claude.goal.maxBudgetUsd`. 0 means no limit. */
	readonly maxBudgetUsd?: number;
}

export interface ClaudeLoopCommand {
	readonly kind: 'loop';
	readonly prompt: string;
	/** Undefined for a self-paced loop: Claude picks when it runs again. */
	readonly intervalMs?: number;
}

export type ClaudeGoalLoopCommand =
	| ClaudeGoalCommand
	| ClaudeLoopCommand
	| { readonly kind: 'stop'; readonly target: 'goal' | 'loop' }
	| { readonly kind: 'invalid'; readonly message: string };

const STOP_WORDS = new Set(['stop', 'clear', 'off', 'cancel']);

/** Well-known commands an outcome can name, such as "make npm test pass". */
const NAMED_CHECK = /(?<command>(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:.-]+|npx\s+[\w@/.-]+(?:\s+[\w-]+)?|pytest(?:\s+[\w/.-]+)?|cargo\s+(?:test|build|check|clippy)|go\s+(?:test|build|vet)(?:\s+\.\/\.\.\.)?|make\s+[\w-]+|dotnet\s+(?:test|build)|mvn\s+(?:test|verify)|(?:\.\/)?gradlew?\s+(?:test|build|check))\s+(?:pass|passes|succeed|succeeds|is\s+green|are\s+green|exit\s+0|exits\s+0|work|works)\b/i;

/**
 * Reads `/goal` and `/loop` from the composer. Undefined for any other text, so
 * the message goes to Claude Code as typed.
 */
export function parseClaudeGoalLoopCommand(text: string): ClaudeGoalLoopCommand | undefined {
	const match = /^\/(?<name>goal|loop)(?:\s+(?<rest>[\s\S]*))?$/.exec(text.trim());
	if (!match?.groups) {
		return undefined;
	}
	const name = match.groups.name as 'goal' | 'loop';
	const rest = (match.groups.rest ?? '').trim();
	if (STOP_WORDS.has(rest.toLowerCase())) {
		return { kind: 'stop', target: name };
	}
	return name === 'goal' ? parseGoal(rest) : parseLoop(rest);
}

function parseGoal(text: string): ClaudeGoalLoopCommand {
	let rest = text;
	let maxTurns: number | undefined;
	let maxBudgetUsd: number | undefined;
	const turns = /(?:^|\s)--turns(?:\s+|=)(?<value>\d+)(?=\s|$)/.exec(rest);
	if (turns?.groups) {
		maxTurns = Math.max(1, Number(turns.groups.value));
		rest = (rest.slice(0, turns.index) + rest.slice(turns.index + turns[0].length)).trim();
	}
	const budget = /(?:^|\s)--budget(?:\s+|=)\$?(?<value>\d+(?:\.\d+)?)(?=\s|$)/.exec(rest);
	if (budget?.groups) {
		maxBudgetUsd = Number(budget.groups.value);
		rest = (rest.slice(0, budget.index) + rest.slice(budget.index + budget[0].length)).trim();
	}
	let outcome = rest;
	let check: string | undefined;
	const flag = /(?:^|\s)--check\s+(?<command>[\s\S]+)$/.exec(rest);
	if (flag?.groups) {
		check = unquote(flag.groups.command.trim());
		outcome = rest.slice(0, flag.index).trim();
	} else {
		check = /`(?<command>[^`\n]+)`/.exec(rest)?.groups?.command.trim() ?? NAMED_CHECK.exec(rest)?.groups?.command.replace(/\s+/g, ' ');
	}
	if (!outcome && check) {
		outcome = localize('claudeGoalCheckPasses', "{0} passes", check);
	}
	if (!outcome) {
		return { kind: 'invalid', message: localize('claudeGoalNoOutcome', "Say what should be true when the goal is done, for example: /goal make npm test pass") };
	}
	return { kind: 'goal', outcome, ...(check ? { check } : {}), ...(maxTurns !== undefined ? { maxTurns } : {}), ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}) };
}

function parseLoop(rest: string): ClaudeGoalLoopCommand {
	const match = /^(?:every\s+)?(?<amount>\d+(?:\.\d+)?)\s*(?<unit>s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b\s*(?<prompt>[\s\S]*)$/i.exec(rest);
	const prompt = (match?.groups ? match.groups.prompt : rest).trim();
	if (!prompt) {
		return { kind: 'invalid', message: localize('claudeLoopNoPrompt', "Say what to repeat, for example: /loop 10m check the build") };
	}
	if (!match?.groups) {
		return { kind: 'loop', prompt };
	}
	const unit = match.groups.unit.toLowerCase();
	const scale = unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1000;
	const intervalMs = clamp(Math.round(Number(match.groups.amount) * scale), CLAUDE_LOOP_MIN_MS, CLAUDE_LOOP_MAX_MS);
	return { kind: 'loop', prompt, intervalMs };
}

function unquote(text: string): string {
	const quoted = /^(?<quote>["'`])(?<inner>[\s\S]*)\k<quote>$/.exec(text);
	return quoted?.groups ? quoted.groups.inner : text;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

// --- prompts Claude reads ---

/** The first goal turn. */
export function claudeGoalStartPrompt(goal: ClaudeGoalCommand): string {
	return [
		`Work toward this goal until it is done: ${goal.outcome}`,
		goalCheckRule(goal),
	].join('\n\n');
}

/** A turn Klawly sends while the check still fails. */
export function claudeGoalContinuePrompt(goal: ClaudeGoalCommand, verdict: ClaudeGoalVerdict): string {
	const why = goal.check
		? `The check \`${goal.check}\` still fails${verdict.exitCode !== undefined ? ` (exit code ${verdict.exitCode})` : ''}.${verdict.output ? `\nLast output:\n\`\`\`\n${verdict.output}\n\`\`\`` : ''}`
		: `You said the goal is not met yet${verdict.output ? `: ${verdict.output}` : '.'}`;
	return [
		`Continue toward the goal: ${goal.outcome}`,
		why,
		goalCheckRule(goal),
	].join('\n\n');
}

function goalCheckRule(goal: ClaudeGoalCommand): string {
	return goal.check
		? `After each of your turns, Klawly runs \`${goal.check}\` and sends you another turn until it exits with code 0. Don't ask the user whether to go on; keep working until the check passes.`
		: `After each of your turns, Klawly sends you another turn until the goal is met. Check the outcome yourself before you answer, then end your reply with one line: "${CLAUDE_GOAL_MET}" when it is true now, or "${CLAUDE_GOAL_NOT_MET}: <what is left>" when it is not.`;
}

/** A loop turn. Self-paced loops also say how Claude picks when it runs again. */
export function claudeLoopPrompt(loop: ClaudeLoopCommand, run: number): string {
	const pacing = loop.intervalMs === undefined
		? `This prompt repeats in a Klawly loop (run ${run}). When you finish, pick when to run it again: call ${CLAUDE_SCHEDULE_WAKEUP_TOOL} with delaySeconds if you have that tool, or end your reply with a line "Next run in: <N> minutes" (1 to 60). End with "${CLAUDE_LOOP_DONE}" when there is nothing left to watch.`
		: `This prompt repeats in a Klawly loop every ${formatClaudeInterval(loop.intervalMs)} (run ${run}).`;
	return `${loop.prompt}\n\n${pacing}`;
}

// --- reading the results ---

/** What the goal check said after a turn. */
export interface ClaudeGoalVerdict {
	readonly met: boolean;
	readonly exitCode?: number;
	/** The check's last output, or what Claude said is left. */
	readonly output?: string;
}

/** Claude's own verdict, from the last line of a goal turn when no check command is set. */
export function claudeGoalVerdictFromReply(reply: string): ClaudeGoalVerdict {
	const last = lastLine(reply);
	if (new RegExp(`^\\**${CLAUDE_GOAL_MET}\\**[.!]?\\**$`, 'i').test(last)) {
		return { met: true };
	}
	const notMet = new RegExp(`^\\**${CLAUDE_GOAL_NOT_MET}\\**[:.]?\\s*(?<why>.*)$`, 'i').exec(last);
	return { met: false, output: notMet?.groups?.why.replace(/\*+$/, '').trim() || undefined };
}

/** The wait Claude asked for with `ScheduleWakeup`, clamped to 1 to 60 minutes. */
export function claudeWakeupDelayMs(input: unknown): number | undefined {
	const seconds = typeof input === 'object' && input !== null ? (input as { delaySeconds?: unknown }).delaySeconds : undefined;
	return typeof seconds === 'number' && Number.isFinite(seconds) ? clamp(seconds * 1000, CLAUDE_LOOP_MIN_MS, CLAUDE_WAKEUP_MAX_MS) : undefined;
}

/**
 * When a self-paced loop runs next, from the end of Claude's reply: `done` for
 * "Loop done", the wait from "Next run in: N minutes", else undefined.
 */
export function claudeLoopPacingFromReply(reply: string): { readonly done: true } | { readonly done: false; readonly delayMs: number } | undefined {
	const last = lastLine(reply);
	if (new RegExp(`^\\**${CLAUDE_LOOP_DONE}\\**[.!]?\\**$`, 'i').test(last)) {
		return { done: true };
	}
	const next = /next\s+(?:run|check)\s+in:?\s*(?<amount>\d+(?:\.\d+)?)\s*(?<unit>s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)?/i.exec(last);
	if (!next?.groups) {
		return undefined;
	}
	const unit = (next.groups.unit ?? 'm').toLowerCase();
	const scale = unit.startsWith('h') ? 3_600_000 : unit.startsWith('s') ? 1000 : 60_000;
	return { done: false, delayMs: clamp(Number(next.groups.amount) * scale, CLAUDE_LOOP_MIN_MS, CLAUDE_WAKEUP_MAX_MS) };
}

function lastLine(text: string): string {
	const lines = text.trim().split(/\r?\n/);
	return (lines[lines.length - 1] ?? '').trim();
}

/**
 * Adds a query's reported cost to what a goal has spent. Claude Code reports
 * `total_cost_usd` per query, so a smaller number means a new query started.
 */
export function addClaudeQueryCost(state: { readonly lastCostUsd?: number; readonly spentUsd: number }, costUsd: number): { readonly lastCostUsd: number; readonly spentUsd: number } {
	const last = state.lastCostUsd;
	const added = last !== undefined && costUsd >= last ? costUsd - last : costUsd;
	return { lastCostUsd: costUsd, spentUsd: state.spentUsd + added };
}

// --- labels ---

/** `10m`, `2h`, `1h 30m`, `45s`. */
export function formatClaudeInterval(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (ms < 60_000) {
		return `${Math.round(ms / 1000)}s`;
	}
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Longest outcome a pill shows before it cuts it short. */
const PILL_OUTCOME_CHARS = 40;

/** The outcome as the pill shows it: one line, cut short. */
export function claudeGoalPillOutcome(outcome: string): string {
	const line = outcome.split(/\r?\n/, 1)[0].trim();
	return line.length > PILL_OUTCOME_CHARS ? `${line.slice(0, PILL_OUTCOME_CHARS - 1)}…` : line;
}
