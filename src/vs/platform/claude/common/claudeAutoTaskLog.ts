/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';

/**
 * Auto measurement (issue 849): one line per top-level Auto chat in the local
 * delegation log, rewritten each time the chat goes idle. Nothing leaves the machine.
 */
export interface ClaudeAutoTaskEntry {
	readonly time: number;
	/** The top-level chat. One entry per chat; a newer entry replaces the older one. */
	readonly sessionId: string;
	/** `solo` when the chat did the work itself, `delegated` when it started at least one delegated chat. */
	readonly approach: 'solo' | 'delegated';
	/** Every model the chat and its delegated chats ran on, first use first. */
	readonly models: readonly string[];
	readonly turns: number;
	/** The chat's own cost plus everything under it. */
	readonly costUsd?: number;
	/** Input, output and cache tokens Claude Code reported for the chat and its delegated chats. */
	readonly tokens: number;
	readonly compactions: number;
	/** Times the user sent a failed or stopped task again (Retry, Retry on Opus). */
	readonly retries: number;
	/** Turns and delegated runs that failed. */
	readonly failures: number;
	/** Turns and delegated runs that were stopped before they finished. */
	readonly stalls: number;
	readonly escalations: number;
	/** The first `ci_wait` result the chat got: whether CI passed on the first try. */
	readonly ciFirstTry?: 'pass' | 'fail';
	/** Rework rounds after the parent's review of a delegated chat. */
	readonly reviewRounds: number;
	/** Whether the cost guard asked the user before going on. */
	readonly asked?: boolean;
}

/** The targets of one Auto mode (issue 1215). */
export const CLAUDE_AUTO_TARGETS = {
	tokensPerTask: 100_000,
	medianCostUsd: 1.20,
	ciFirstTryRate: 0.9,
	expensiveUsd: 50,
	compactedSpendShare: 0.5,
} as const;

export function formatClaudeAutoTaskLogLine(entry: ClaudeAutoTaskEntry): string {
	return JSON.stringify({
		time: new Date(entry.time).toISOString(),
		kind: 'autoTask',
		sessionId: entry.sessionId,
		approach: entry.approach,
		models: entry.models,
		turns: entry.turns,
		costUsd: entry.costUsd === undefined ? undefined : Number(entry.costUsd.toFixed(4)),
		tokens: entry.tokens,
		compactions: entry.compactions,
		retries: entry.retries,
		failures: entry.failures,
		stalls: entry.stalls,
		escalations: entry.escalations,
		ciFirstTry: entry.ciFirstTry,
		reviewRounds: entry.reviewRounds,
		asked: entry.asked || undefined,
	});
}

/** Replaces the chat's older entry with the new one, or appends it. */
export function upsertClaudeAutoTaskLine(lines: readonly string[], entry: ClaudeAutoTaskEntry): string[] {
	const line = formatClaudeAutoTaskLogLine(entry);
	const kept = lines.filter(candidate => parseClaudeAutoTaskLine(candidate)?.sessionId !== entry.sessionId);
	return [...kept, line];
}

function parseClaudeAutoTaskLine(line: string): ClaudeAutoTaskEntry | undefined {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!raw || raw.kind !== 'autoTask' || typeof raw.sessionId !== 'string') {
		return undefined;
	}
	const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
	const time = typeof raw.time === 'string' ? Date.parse(raw.time) : NaN;
	return {
		time: Number.isNaN(time) ? 0 : time,
		sessionId: raw.sessionId,
		approach: raw.approach === 'delegated' ? 'delegated' : 'solo',
		models: Array.isArray(raw.models) ? raw.models.filter((model): model is string => typeof model === 'string') : [],
		turns: count(raw.turns),
		costUsd: typeof raw.costUsd === 'number' && Number.isFinite(raw.costUsd) ? raw.costUsd : undefined,
		tokens: count(raw.tokens),
		compactions: count(raw.compactions),
		retries: count(raw.retries),
		failures: count(raw.failures),
		stalls: count(raw.stalls),
		escalations: count(raw.escalations),
		ciFirstTry: raw.ciFirstTry === 'pass' || raw.ciFirstTry === 'fail' ? raw.ciFirstTry : undefined,
		reviewRounds: count(raw.reviewRounds),
		asked: raw.asked === true || undefined,
	};
}

/** The Auto entries of the log, oldest first. Other lines are skipped. */
export function parseClaudeAutoTaskLog(lines: readonly string[]): ClaudeAutoTaskEntry[] {
	const entries: ClaudeAutoTaskEntry[] = [];
	for (const line of lines) {
		const entry = parseClaudeAutoTaskLine(line);
		if (entry) {
			entries.push(entry);
		}
	}
	return entries;
}

/** Reads the outcome from a `ci_wait` result message, or undefined when the text is not one. */
export function claudeCiWaitOutcome(text: string): 'pass' | 'fail' | undefined {
	const outcome = /^\[ci_wait\] (?<outcome>\w+)/.exec(text)?.groups?.outcome.toLowerCase();
	if (outcome === 'pass' || outcome === 'success') {
		return 'pass';
	}
	return outcome === undefined ? undefined : 'fail';
}

export interface ClaudeAutoTotals {
	readonly tasks: number;
	readonly medianCostUsd?: number;
	readonly medianTokens?: number;
	/** Share of tasks with a CI result that passed on the first try. */
	readonly ciFirstTryRate?: number;
	/** Tasks over the expensive line that never asked the user. */
	readonly expensiveUnasked: number;
	/** Share of all spend that went to chats that were compacted. */
	readonly compactedSpendShare?: number;
}

function median(values: readonly number[]): number | undefined {
	if (!values.length) {
		return undefined;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function claudeAutoTotals(entries: readonly ClaudeAutoTaskEntry[]): ClaudeAutoTotals {
	const costs = entries.map(entry => entry.costUsd).filter((cost): cost is number => cost !== undefined);
	const withCi = entries.filter(entry => entry.ciFirstTry !== undefined);
	const spend = costs.reduce((sum, cost) => sum + cost, 0);
	const compactedSpend = entries.filter(entry => entry.compactions > 0).reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
	return {
		tasks: entries.length,
		medianCostUsd: median(costs),
		medianTokens: median(entries.map(entry => entry.tokens)),
		ciFirstTryRate: withCi.length ? withCi.filter(entry => entry.ciFirstTry === 'pass').length / withCi.length : undefined,
		expensiveUnasked: entries.filter(entry => (entry.costUsd ?? 0) > CLAUDE_AUTO_TARGETS.expensiveUsd && !entry.asked).length,
		compactedSpendShare: spend > 0 ? compactedSpend / spend : undefined,
	};
}

const dollars = (value: number | undefined) => value === undefined ? '-' : `$${value.toFixed(2)}`;
const percent = (value: number | undefined) => value === undefined ? '-' : `${Math.round(value * 100)}%`;

/** The Auto report: the log as a table, then the totals against the targets. Markdown. */
export function claudeAutoReport(entries: readonly ClaudeAutoTaskEntry[]): string {
	const lines = [`# ${localize('claudeAutoReportTitle', "Auto Report")}`, ''];
	if (!entries.length) {
		lines.push(localize('claudeAutoReportEmpty', "No Auto chats yet. Each top-level chat with Auto on adds a row here when it goes idle."));
		return lines.join('\n');
	}
	const totals = claudeAutoTotals(entries);
	const met = (ok: boolean | undefined) => ok === undefined ? localize('claudeAutoReportNoData', "no data") : ok ? localize('claudeAutoReportMet', "met") : localize('claudeAutoReportMissed', "missed");
	lines.push(
		`## ${localize('claudeAutoReportTargets', "Targets")}`,
		'',
		`| ${localize('claudeAutoReportTarget', "Target")} | ${localize('claudeAutoReportNow', "Now")} | |`,
		'| --- | --- | --- |',
		`| ${localize('claudeAutoReportTokensTarget', "Tokens per task at most {0}", CLAUDE_AUTO_TARGETS.tokensPerTask.toLocaleString('en-US'))} | ${totals.medianTokens === undefined ? '-' : Math.round(totals.medianTokens).toLocaleString('en-US')} | ${met(totals.medianTokens === undefined ? undefined : totals.medianTokens <= CLAUDE_AUTO_TARGETS.tokensPerTask)} |`,
		`| ${localize('claudeAutoReportCostTarget', "Median cost per chat at most {0}", dollars(CLAUDE_AUTO_TARGETS.medianCostUsd))} | ${dollars(totals.medianCostUsd)} | ${met(totals.medianCostUsd === undefined ? undefined : totals.medianCostUsd <= CLAUDE_AUTO_TARGETS.medianCostUsd)} |`,
		`| ${localize('claudeAutoReportCiTarget', "CI passes on the first try in at least {0}", percent(CLAUDE_AUTO_TARGETS.ciFirstTryRate))} | ${percent(totals.ciFirstTryRate)} | ${met(totals.ciFirstTryRate === undefined ? undefined : totals.ciFirstTryRate >= CLAUDE_AUTO_TARGETS.ciFirstTryRate)} |`,
		`| ${localize('claudeAutoReportExpensiveTarget', "No chat over {0} without asking", dollars(CLAUDE_AUTO_TARGETS.expensiveUsd))} | ${totals.expensiveUnasked} | ${met(totals.expensiveUnasked === 0)} |`,
		`| ${localize('claudeAutoReportCompactedTarget', "Under {0} of spend in compacted chats", percent(CLAUDE_AUTO_TARGETS.compactedSpendShare))} | ${percent(totals.compactedSpendShare)} | ${met(totals.compactedSpendShare === undefined ? undefined : totals.compactedSpendShare < CLAUDE_AUTO_TARGETS.compactedSpendShare)} |`,
		'',
		`## ${localize('claudeAutoReportChats', "Chats ({0})", totals.tasks)}`,
		'',
		`| ${[
			localize('claudeAutoReportWhen', "When"),
			localize('claudeAutoReportApproach', "Approach"),
			localize('claudeAutoReportModels', "Models"),
			localize('claudeAutoReportTurns', "Turns"),
			localize('claudeAutoReportCost', "Cost"),
			localize('claudeAutoReportTokens', "Tokens"),
			localize('claudeAutoReportCompactions', "Compactions"),
			localize('claudeAutoReportRetries', "Retries"),
			localize('claudeAutoReportFailures', "Failures"),
			localize('claudeAutoReportStalls', "Stopped"),
			localize('claudeAutoReportEscalations', "Escalations"),
			localize('claudeAutoReportCi', "CI First Try"),
			localize('claudeAutoReportReviews', "Review Rounds"),
		].join(' | ')} |`,
		`|${' --- |'.repeat(13)}`,
	);
	for (const entry of [...entries].reverse()) {
		const approach = entry.approach === 'delegated' ? localize('claudeAutoReportDelegated', "Delegated") : localize('claudeAutoReportSolo', "Solo");
		const ci = entry.ciFirstTry === undefined ? '-' : entry.ciFirstTry === 'pass' ? localize('claudeAutoReportPassed', "Passed") : localize('claudeAutoReportFailed', "Failed");
		lines.push(`| ${[
			new Date(entry.time).toISOString().slice(0, 16).replace('T', ' '),
			approach,
			entry.models.join(', ') || '-',
			entry.turns,
			dollars(entry.costUsd),
			entry.tokens.toLocaleString('en-US'),
			entry.compactions,
			entry.retries,
			entry.failures,
			entry.stalls,
			entry.escalations,
			ci,
			entry.reviewRounds,
		].join(' | ')} |`);
	}
	lines.push('', localize('claudeAutoReportLocal', "Read from the local delegation log. Nothing is sent off this machine."));
	return lines.join('\n');
}
