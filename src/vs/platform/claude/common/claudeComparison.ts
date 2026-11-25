/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeComparisonDiffStat, ClaudeComparisonEvent, ClaudeComparisonRanking, ClaudeComparisonRunSpec, ClaudeComparisonRunState } from './claudeProtocol.js';

/** Most a single comparison run may spend, in US dollars, before Claude Code stops it. */
export const CLAUDE_COMPARE_MAX_BUDGET_SETTING = 'claude.compare.maxBudgetUsd';

export const CLAUDE_COMPARE_MAX_BUDGET_DEFAULT = 2;

export const CLAUDE_COMPARE_MIN_RUNS = 2;

export const CLAUDE_COMPARE_MAX_RUNS = 4;

/** A diff longer than this reaches the judge cut, with a note, so one large run cannot fill its context. */
export const CLAUDE_COMPARE_JUDGE_DIFF_LIMIT = 60_000;

/** A missing, non-numeric or non-positive value uses the default: a comparison always has a budget. */
export function readClaudeCompareBudget(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : CLAUDE_COMPARE_MAX_BUDGET_DEFAULT;
}

/**
 * The background task id of one run: `compare-<id>-<n>`, so its branch is
 * `<prefix>compare-<id>-<n>` (`agent/compare-…` by default).
 */
export function claudeComparisonTaskId(comparisonId: string, run: number): string {
	return `compare-${comparisonId}-${run}`;
}

/**
 * Why these runs cannot be compared, or `undefined` when they can: `count`
 * outside 2..4, or `duplicate` when two runs share a model and effort. The
 * window words the message.
 */
export function claudeComparisonRunsProblem(runs: readonly ClaudeComparisonRunSpec[]): 'count' | 'duplicate' | undefined {
	if (runs.length < CLAUDE_COMPARE_MIN_RUNS || runs.length > CLAUDE_COMPARE_MAX_RUNS) {
		return 'count';
	}
	const keys = new Set(runs.map(run => `${run.modelId}\u0000${run.effort ?? ''}`));
	return keys.size === runs.length ? undefined : 'duplicate';
}

/** What the judge reads about one finished run. */
export interface ClaudeComparisonJudgeRun {
	/** 1-based run number. */
	readonly run: number;
	readonly label: string;
	/** `git diff` of the run's worktree against the comparison's base. */
	readonly diff: string;
	/** The run's last assistant message, when it wrote one. */
	readonly finalMessage?: string;
	/** Set when the run failed or was stopped, such as at its budget. */
	readonly failure?: string;
}

export interface ClaudeComparisonJudgeRequest {
	/** Id `cancelComparisonJudge` cancels with. */
	readonly id: string;
	readonly prompt: string;
	readonly cwd: string;
	/** Absent: Claude Code's default model. */
	readonly modelId?: string;
	readonly runs: readonly ClaudeComparisonJudgeRun[];
}

export interface ClaudeComparisonVerdict {
	/** Best first. */
	readonly ranking: readonly ClaudeComparisonRanking[];
	readonly summary: string;
}

/** Plain data so it crosses IPC: a judge never throws to the window. */
export type ClaudeComparisonJudgeResult =
	| { readonly ok: true; readonly verdict: ClaudeComparisonVerdict }
	| { readonly ok: false; readonly cancelled?: true; readonly message: string };

export const CLAUDE_COMPARISON_JUDGE_SCHEMA: Record<string, unknown> = {
	type: 'object',
	additionalProperties: false,
	required: ['ranking', 'summary'],
	properties: {
		ranking: {
			type: 'array',
			description: 'Every run, best first.',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['run', 'score', 'reasons'],
				properties: {
					run: { type: 'integer', minimum: 1, description: 'The run number from the prompt.' },
					score: { type: 'number', minimum: 0, maximum: 10 },
					reasons: { type: 'string', description: 'Two or three sentences.' },
				},
			},
		},
		summary: { type: 'string', description: 'One short paragraph.' },
	},
};

/**
 * The judge's answer narrowed to a verdict over runs `1..runCount`: every run
 * once, scores clamped to 0..10, best first. `undefined` when the answer
 * leaves a run out, names one that does not exist, or ranks one twice.
 */
export function readClaudeComparisonVerdict(value: unknown, runCount: number): ClaudeComparisonVerdict | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const candidate = value as { ranking?: unknown; summary?: unknown };
	if (!Array.isArray(candidate.ranking) || typeof candidate.summary !== 'string') {
		return undefined;
	}
	const ranking: ClaudeComparisonRanking[] = [];
	const seen = new Set<number>();
	for (const item of candidate.ranking as unknown[]) {
		if (typeof item !== 'object' || item === null) {
			return undefined;
		}
		const entry = item as { run?: unknown; score?: unknown; reasons?: unknown };
		if (typeof entry.run !== 'number' || !Number.isInteger(entry.run) || entry.run < 1 || entry.run > runCount || seen.has(entry.run)) {
			return undefined;
		}
		if (typeof entry.score !== 'number' || !Number.isFinite(entry.score) || typeof entry.reasons !== 'string') {
			return undefined;
		}
		seen.add(entry.run);
		ranking.push({ run: entry.run, score: Math.min(10, Math.max(0, entry.score)), reasons: entry.reasons.trim() });
	}
	if (seen.size !== runCount) {
		return undefined;
	}
	ranking.sort((a, b) => b.score - a.score);
	return { ranking, summary: candidate.summary.trim() };
}

/** The judge's prompt: the task, then each run's final message and diff. */
export function claudeComparisonJudgePrompt(request: Pick<ClaudeComparisonJudgeRequest, 'prompt' | 'runs'>): string {
	const lines = [
		`${request.runs.length} coding agents were given the same task, each in its own copy of the repository. Rank every run, best first, by how well its changes do the task: correctness first, then completeness, then how small and clean the change is. A run that failed or changed nothing ranks below one that did the task.`,
		'',
		'Task:',
		request.prompt.trim(),
	];
	for (const run of request.runs) {
		lines.push('', `## Run ${run.run} (${run.label})`);
		if (run.failure) {
			lines.push(`The run did not finish: ${run.failure}`);
		}
		lines.push('', 'Final message:', run.finalMessage?.trim() || '(none)', '', 'Diff:');
		const diff = run.diff.trim();
		if (!diff) {
			lines.push('(no changes)');
		} else if (diff.length > CLAUDE_COMPARE_JUDGE_DIFF_LIMIT) {
			lines.push('```diff', diff.slice(0, CLAUDE_COMPARE_JUDGE_DIFF_LIMIT), '```', `(The diff is ${diff.length} characters; the rest is cut.)`);
		} else {
			lines.push('```diff', diff, '```');
		}
	}
	return lines.join('\n');
}

/** One run as the Compare view shows it. */
export interface ClaudeComparisonRunView extends ClaudeComparisonRunSpec {
	readonly run: number;
	readonly state: ClaudeComparisonRunState;
	readonly sessionId?: string;
	readonly diffStat?: ClaudeComparisonDiffStat;
	/** Why the run failed, when it did. */
	readonly message?: string;
	/** What the run cost in US dollars, as Claude Code reported it. */
	readonly costUsd?: number;
	/** From the run's first prompt to the end of its last turn. */
	readonly durationMs?: number;
}

export interface ClaudeComparisonView {
	readonly id: string;
	readonly prompt: string;
	readonly runs: readonly ClaudeComparisonRunView[];
	readonly verdict?: ClaudeComparisonVerdict;
	readonly judgeError?: string;
}

/**
 * Folds one comparison event into the view. Events for another comparison,
 * or for a run that does not exist, leave it unchanged.
 */
export function applyClaudeComparisonEvent(view: ClaudeComparisonView | undefined, event: ClaudeComparisonEvent): ClaudeComparisonView | undefined {
	if (event.type === 'comparison.started') {
		return {
			id: event.comparisonId,
			prompt: event.prompt,
			runs: event.runs.map((spec, index) => ({ ...spec, run: index + 1, state: 'starting' })),
		};
	}
	if (!view || view.id !== event.comparisonId) {
		return view;
	}
	switch (event.type) {
		case 'comparison.runUpdated': {
			if (!view.runs.some(run => run.run === event.run)) {
				return view;
			}
			const runs = view.runs.map(run => run.run !== event.run ? run : {
				...run,
				state: event.state,
				sessionId: event.sessionId ?? run.sessionId,
				diffStat: event.diffStat ?? run.diffStat,
				message: event.message ?? (event.state === 'failed' ? run.message : undefined),
				costUsd: event.costUsd ?? run.costUsd,
				durationMs: event.durationMs ?? run.durationMs,
			});
			return { ...view, runs };
		}
		case 'comparison.judged':
			return { ...view, verdict: { ranking: event.ranking, summary: event.summary }, judgeError: undefined };
		case 'comparison.judgeFailed':
			return { ...view, judgeError: event.message };
	}
}

/** True once no run is starting, running or waiting on a permission. */
export function isClaudeComparisonSettled(view: ClaudeComparisonView): boolean {
	return view.runs.every(run => run.state !== 'starting' && run.state !== 'running' && run.state !== 'waiting');
}

/** How many comparisons History keeps. The oldest go first. */
export const CLAUDE_COMPARE_HISTORY_LIMIT = 50;

/** A comparison as `comparisons.json` beside the sessions keeps it, so History lists it as one entry. */
export interface ClaudeStoredComparison {
	readonly view: ClaudeComparisonView;
	readonly createdAt: number;
	readonly updatedAt: number;
}

const RUN_STATES: ReadonlySet<string> = new Set<ClaudeComparisonRunState>(['starting', 'running', 'waiting', 'complete', 'failed', 'kept', 'discarded']);

/** The file's text: newest first, at most {@link CLAUDE_COMPARE_HISTORY_LIMIT}. */
export function serializeClaudeComparisons(comparisons: readonly ClaudeStoredComparison[]): string {
	const newest = [...comparisons].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, CLAUDE_COMPARE_HISTORY_LIMIT);
	return JSON.stringify({ version: 1, comparisons: newest });
}

/**
 * Reads `comparisons.json`. Entries that do not parse are dropped. A run that
 * was still going when Klawly closed is failed, because its background agent
 * does not outlive the window.
 */
export function readClaudeComparisons(text: string | undefined, interrupted: string): ClaudeStoredComparison[] {
	let parsed: unknown;
	try {
		parsed = text ? JSON.parse(text) : undefined;
	} catch {
		return [];
	}
	const list = typeof parsed === 'object' && parsed !== null ? (parsed as { comparisons?: unknown }).comparisons : undefined;
	if (!Array.isArray(list)) {
		return [];
	}
	const comparisons: ClaudeStoredComparison[] = [];
	for (const item of list as unknown[]) {
		const stored = readStoredComparison(item, interrupted);
		if (stored) {
			comparisons.push(stored);
		}
	}
	return comparisons;
}

function readStoredComparison(value: unknown, interrupted: string): ClaudeStoredComparison | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const { view, createdAt, updatedAt } = value as { view?: unknown; createdAt?: unknown; updatedAt?: unknown };
	if (typeof createdAt !== 'number' || typeof updatedAt !== 'number' || typeof view !== 'object' || view === null) {
		return undefined;
	}
	const candidate = view as { id?: unknown; prompt?: unknown; runs?: unknown; verdict?: unknown; judgeError?: unknown };
	if (typeof candidate.id !== 'string' || typeof candidate.prompt !== 'string' || !Array.isArray(candidate.runs)) {
		return undefined;
	}
	const runs: ClaudeComparisonRunView[] = [];
	for (const item of candidate.runs as unknown[]) {
		const run = item as Partial<Record<keyof ClaudeComparisonRunView, unknown>> | null;
		if (typeof run !== 'object' || run === null || typeof run.run !== 'number' || typeof run.modelId !== 'string' || typeof run.label !== 'string' || typeof run.state !== 'string' || !RUN_STATES.has(run.state)) {
			return undefined;
		}
		const unfinished = run.state === 'starting' || run.state === 'running' || run.state === 'waiting';
		runs.push({
			run: run.run,
			modelId: run.modelId,
			effort: typeof run.effort === 'string' ? run.effort as ClaudeComparisonRunView['effort'] : undefined,
			label: run.label,
			state: unfinished ? 'failed' : run.state as ClaudeComparisonRunState,
			sessionId: typeof run.sessionId === 'string' ? run.sessionId : undefined,
			diffStat: readDiffStat(run.diffStat),
			message: unfinished ? interrupted : typeof run.message === 'string' ? run.message : undefined,
			costUsd: typeof run.costUsd === 'number' ? run.costUsd : undefined,
			durationMs: typeof run.durationMs === 'number' ? run.durationMs : undefined,
		});
	}
	const verdict = candidate.verdict === undefined ? undefined : readClaudeComparisonVerdict(candidate.verdict, runs.length);
	return {
		view: { id: candidate.id, prompt: candidate.prompt, runs, verdict, judgeError: typeof candidate.judgeError === 'string' ? candidate.judgeError : undefined },
		createdAt,
		updatedAt,
	};
}

function readDiffStat(value: unknown): ClaudeComparisonDiffStat | undefined {
	const stat = value as Partial<Record<keyof ClaudeComparisonDiffStat, unknown>> | null;
	if (typeof stat !== 'object' || stat === null || typeof stat.filesChanged !== 'number' || typeof stat.added !== 'number' || typeof stat.removed !== 'number') {
		return undefined;
	}
	return { filesChanged: stat.filesChanged, added: stat.added, removed: stat.removed };
}
