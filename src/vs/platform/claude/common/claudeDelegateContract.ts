/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The delegate contract (issue 837): what makes a worker's job checkable. The
 * objective, the files it owns, the approach, how to tell it is done, a budget
 * and a retry limit go in; a short structured report comes back. Pure, so the
 * tool, the delegation service and the card share it.
 */

import { ClaudeWorkerProfile } from './claudeWorkerProfile.js';

/** How capable a model the worker needs. */
export type ClaudeDelegateTier = 'small' | 'medium' | 'large';

export const CLAUDE_DELEGATE_TIERS: readonly ClaudeDelegateTier[] = ['small', 'medium', 'large'];

/** The most a worker spends, in tool calls and US dollars. Either may be absent. */
export interface ClaudeDelegateBudget {
	readonly calls?: number;
	readonly usd?: number;
}

/** The contract fields `klawly_delegate` accepts next to the task. All optional. */
export interface ClaudeDelegateContract {
	/** The goal in one sentence. */
	readonly objective?: string;
	/** The paths this worker owns; it changes nothing else. */
	readonly files?: readonly string[];
	/** How to do it, once decided. */
	readonly approach?: string;
	/** How to check the work is done. */
	readonly acceptance?: string;
	readonly budget?: ClaudeDelegateBudget;
	/** How many times it may retry a failing step before reporting. */
	readonly retries?: number;
	readonly tier?: ClaudeDelegateTier;
	/** One line: why this tier. */
	readonly reason?: string;
	/** A short name for the worker. */
	readonly name?: string;
	/** lean (file and shell tools plus delegation tools, no MCP servers, plugins or slash commands) or full (like the chat). Absent uses Settings > Agents > Delegation. */
	readonly profile?: ClaudeWorkerProfile;
	/** The worker itself splits its job across workers, so a large tier keeps the chat's model under Opus. */
	readonly orchestrates?: boolean;
}

/** The report is at most this many words. */
export const CLAUDE_DELEGATE_REPORT_MAX_WORDS = 300;

/** A worker with nothing to say ends its report with this line, and the parent is not told. */
export const CLAUDE_DELEGATE_QUIET_MARKER = '[[quiet]]';

/** The share of a budget at which the worker is told to wrap up. */
export const CLAUDE_DELEGATE_BUDGET_NOTICE_RATIO = 0.8;

/** Why the contract cannot run, or undefined when it can. */
export function claudeDelegateContractProblem(contract: ClaudeDelegateContract): string | undefined {
	const { budget, retries, tier, orchestrates, profile } = contract;
	if (orchestrates !== undefined && typeof orchestrates !== 'boolean') {
		return 'orchestrates is true or false.';
	}
	if (profile !== undefined && profile !== 'lean' && profile !== 'full') {
		return 'profile is lean or full.';
	}
	if (tier !== undefined && !CLAUDE_DELEGATE_TIERS.includes(tier)) {
		return 'tier is small, medium or large.';
	}
	if (budget?.calls !== undefined && !(Number.isInteger(budget.calls) && budget.calls > 0)) {
		return 'budget.calls is a whole number above zero.';
	}
	if (budget?.usd !== undefined && !(Number.isFinite(budget.usd) && budget.usd > 0)) {
		return 'budget.usd is a number above zero.';
	}
	if (retries !== undefined && !(Number.isInteger(retries) && retries >= 0)) {
		return 'retries is a whole number, zero or more.';
	}
	return undefined;
}

/** True when the contract sets anything beyond the task. */
export function hasClaudeDelegateContract(contract: ClaudeDelegateContract): boolean {
	return !!(contract.objective?.trim() || contract.files?.length || contract.approach?.trim() || contract.acceptance?.trim()
		|| contract.budget?.calls || contract.budget?.usd || contract.retries !== undefined);
}

/**
 * The text the worker gets: the task, then the contract as short sections, then
 * the report format. Without a contract it is the task unchanged.
 */
export function claudeDelegateContractPrompt(task: string, contract: ClaudeDelegateContract): string {
	if (!hasClaudeDelegateContract(contract)) {
		return task;
	}
	const sections: string[] = [task];
	const add = (heading: string, body: string | undefined) => {
		if (body?.trim()) {
			sections.push(`${heading}\n${body.trim()}`);
		}
	};
	add('Objective', contract.objective);
	add('Files you own (change nothing else)', contract.files?.length ? contract.files.map(file => `- ${file}`).join('\n') : undefined);
	add('Approach', contract.approach);
	add('Acceptance (how to check you are done)', contract.acceptance);
	const limits: string[] = [];
	if (contract.budget?.calls) {
		limits.push(`- At most ${contract.budget.calls} tool calls.`);
	}
	if (contract.budget?.usd) {
		limits.push(`- At most $${contract.budget.usd} of spend.`);
	}
	if (limits.length) {
		limits.push('- You get a notice at 80%. At 100% stop and report.');
	}
	if (contract.retries !== undefined) {
		limits.push(`- Retry a failing step at most ${contract.retries} time${contract.retries === 1 ? '' : 's'}, then report.`);
	}
	add('Limits', limits.join('\n'));
	sections.push([
		'Report',
		`End with a short report of at most ${CLAUDE_DELEGATE_REPORT_MAX_WORDS} words: status (done, partial or blocked), what changed, how you checked it (command and result), and what is left.`,
		`If there is nothing to say, end with ${CLAUDE_DELEGATE_QUIET_MARKER}.`,
	].join('\n'));
	return sections.join('\n\n');
}

/** Where a worker stands against its budget. */
export type ClaudeDelegateBudgetState = 'ok' | 'notice' | 'stop';

/** Compares what a worker used with its budget; the larger of the two shares counts. */
export function claudeDelegateBudgetState(budget: ClaudeDelegateBudget | undefined, usedCalls: number, usedUsd: number): ClaudeDelegateBudgetState {
	if (!budget) {
		return 'ok';
	}
	const shares: number[] = [];
	if (budget.calls) {
		shares.push(usedCalls / budget.calls);
	}
	if (budget.usd) {
		shares.push(usedUsd / budget.usd);
	}
	const share = shares.length ? Math.max(...shares) : 0;
	return share >= 1 ? 'stop' : share >= CLAUDE_DELEGATE_BUDGET_NOTICE_RATIO ? 'notice' : 'ok';
}

/** The message that tells a worker it reached 80% of its budget. */
export function claudeDelegateBudgetNotice(): string {
	return 'Budget notice: you have used 80% of your budget. Wrap up now and report; at 100% you are stopped.';
}

/** A trimmed report: its text, and whether the worker had nothing to say. */
export interface ClaudeDelegateReport {
	readonly text: string;
	readonly quiet: boolean;
	readonly cut: boolean;
}

/** The report at most `maxWords` words long, without the quiet marker. A text that is only the marker is quiet. */
export function claudeDelegateReport(text: string, maxWords = CLAUDE_DELEGATE_REPORT_MAX_WORDS): ClaudeDelegateReport {
	const trimmed = text.trim();
	const endsQuiet = trimmed.endsWith(CLAUDE_DELEGATE_QUIET_MARKER);
	const body = (endsQuiet ? trimmed.slice(0, -CLAUDE_DELEGATE_QUIET_MARKER.length) : trimmed).trim();
	const words = body.split(/\s+/).filter(word => word.length > 0);
	if (words.length <= maxWords) {
		return { text: body, quiet: endsQuiet && body.length === 0, cut: false };
	}
	// Cut at the word, keeping the line breaks that fall inside the kept part.
	let seen = 0;
	let end = 0;
	const pattern = /\S+/g;
	for (let match = pattern.exec(body); match && seen < maxWords; match = pattern.exec(body)) {
		seen++;
		end = match.index + match[0].length;
	}
	return { text: `${body.slice(0, end)}…`, quiet: false, cut: true };
}
