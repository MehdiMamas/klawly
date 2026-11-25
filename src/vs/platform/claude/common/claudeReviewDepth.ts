/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { ClaudeReviewFinding } from './claudeReviewLoop.js';

/**
 * Review depth (issue 926): Quick, Deep or Auto for every review. Auto picks by the
 * size of the diff, the risk paths it touches and the number of modules, and says why.
 */
export const CLAUDE_REVIEW_DEPTH_SETTING = 'claude.review.depth';

/** The model every review uses; empty keeps the default (the chat's model, Opus for Deep). */
export const CLAUDE_REVIEW_MODEL_SETTING = 'claude.review.model';

/** The most turns one review pass may take; 0 keeps the default for its depth. */
export const CLAUDE_REVIEW_MAX_TURNS_SETTING = 'claude.review.maxTurns';

export const CLAUDE_REVIEW_DEPTHS = ['auto', 'quick', 'deep'] as const;

export type ClaudeReviewDepthSetting = typeof CLAUDE_REVIEW_DEPTHS[number];

/** The depth a review runs at once Auto has chosen. */
export type ClaudeReviewDepth = 'quick' | 'deep';

/** Turns a pass takes when `claude.review.maxTurns` is 0. */
export const CLAUDE_REVIEW_DEFAULT_MAX_TURNS: Readonly<Record<ClaudeReviewDepth, number>> = { quick: 8, deep: 24 };

/** Deep passes that run at the same time when a Deep review fans out. */
export const CLAUDE_REVIEW_FAN_OUT_CONCURRENCY = 3;

/** Changed lines from which a diff is big: Auto goes Deep and a Deep run gets a cost note. */
export const CLAUDE_REVIEW_BIG_DIFF_LINES = 800;

/** Modules from which Auto goes Deep. */
export const CLAUDE_REVIEW_DEEP_MODULES = 4;

/** Changed lines up to which Auto stays Quick when no risk path is touched. */
const QUICK_MAX_LINES = 150;

/** Paths whose change deserves a deep pass: auth, payments, migrations and CI. */
export const CLAUDE_REVIEW_RISK_PATHS: readonly RegExp[] = [
	/(^|[/._-])(auth|oauth|login|session|token|credential|password|secret|crypto|permission)s?([/._-]|$)/i,
	/(^|[/._-])(payment|billing|checkout|invoice|stripe|subscription)s?([/._-]|$)/i,
	/(^|[/._-])(migration|migrate|schema)s?([/._-]|$)/i,
	/(^|\/)\.github\/workflows\/|(^|\/)(\.gitlab-ci\.yml|azure-pipelines\.yml|Jenkinsfile|\.circleci\/)/i,
];

/** What Auto reads from a diff. */
export interface ClaudeReviewDiffStats {
	readonly files: readonly string[];
	/** Added plus removed lines. */
	readonly changedLines: number;
	/** Top-level folders touched; a file at the root is its own module. */
	readonly modules: number;
}

/** The depth a review runs at and the one-line reason it shows. */
export interface ClaudeReviewDepthChoice {
	readonly depth: ClaudeReviewDepth;
	readonly reason: ClaudeReviewDepthReason;
	/** The risk path that made Auto go Deep, when one did. */
	readonly riskPath?: string;
}

export type ClaudeReviewDepthReason = 'setting' | 'riskPath' | 'big' | 'modules' | 'small' | 'medium';

/** Reads `claude.review.depth`; anything else is Auto. */
export function readClaudeReviewDepthSetting(value: unknown): ClaudeReviewDepthSetting {
	return value === 'quick' || value === 'deep' ? value : 'auto';
}

/** Reads `claude.review.maxTurns`; 0, missing or bad keeps the depth's default. */
export function readClaudeReviewMaxTurns(value: unknown, depth: ClaudeReviewDepth): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), 100) : CLAUDE_REVIEW_DEFAULT_MAX_TURNS[depth];
}

/** The model a review pass uses: the setting, else Opus for Deep, else the caller's own. */
export function claudeReviewModel(setting: unknown, depth: ClaudeReviewDepth, fallback?: string): string | undefined {
	if (typeof setting === 'string' && setting.trim()) {
		return setting.trim();
	}
	return depth === 'deep' ? 'opus' : fallback;
}

/** The files, changed lines and modules of a unified diff. Pure. */
export function claudeReviewDiffStats(diff: string): ClaudeReviewDiffStats {
	const files: string[] = [];
	let changedLines = 0;
	for (const line of diff.split(/\r?\n/)) {
		const header = /^diff --git a\/(?:.+) b\/(?<path>.+)$/.exec(line);
		if (header?.groups) {
			files.push(header.groups.path);
		} else if ((line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))) {
			changedLines++;
		}
	}
	return { files, changedLines, modules: new Set(files.map(claudeReviewModule)).size };
}

/** The top-level folder of a path, or the path itself at the root. */
function claudeReviewModule(path: string): string {
	const slash = path.indexOf('/');
	return slash === -1 ? path : path.slice(0, slash);
}

/**
 * Picks the depth of a review (issue 926). A Quick or Deep setting wins; Auto goes
 * Deep for a risk path, a big diff or many modules, and Quick for a small one. Pure.
 */
export function chooseClaudeReviewDepth(stats: ClaudeReviewDiffStats, setting: ClaudeReviewDepthSetting, riskPaths: readonly RegExp[] = CLAUDE_REVIEW_RISK_PATHS): ClaudeReviewDepthChoice {
	if (setting !== 'auto') {
		return { depth: setting, reason: 'setting' };
	}
	const riskPath = stats.files.find(file => riskPaths.some(pattern => pattern.test(file)));
	if (riskPath) {
		return { depth: 'deep', reason: 'riskPath', riskPath };
	}
	if (stats.changedLines >= CLAUDE_REVIEW_BIG_DIFF_LINES) {
		return { depth: 'deep', reason: 'big' };
	}
	if (stats.modules >= CLAUDE_REVIEW_DEEP_MODULES) {
		return { depth: 'deep', reason: 'modules' };
	}
	return { depth: 'quick', reason: stats.changedLines <= QUICK_MAX_LINES ? 'small' : 'medium' };
}

/** The prompt line for a depth; the PR bot's `@klawly review quick|deep` uses the same lines. */
export function claudeReviewDepthPromptLines(depth: ClaudeReviewDepth | undefined): readonly string[] {
	if (depth === 'quick') {
		return ['Do a quick pass: only the most serious problems, no minor findings.'];
	}
	if (depth === 'deep') {
		return ['Do a deep pass: follow callers and callees outside the diff, and check edge cases and concurrency.'];
	}
	return [];
}

/**
 * The pull request review automation's depth step (issue 926): a pull request with no
 * `@klawly review quick|deep` gets the `claude.review.depth` setting, and Auto picks the
 * way Klawly does. Claude says which depth it chose and why. Not localized: it goes to Claude.
 */
export function claudeReviewDepthAutomationLine(setting: ClaudeReviewDepthSetting): string {
	const pick = setting === 'auto'
		? `pick the depth yourself: deep when it touches auth, payments, migrations or CI, has ${CLAUDE_REVIEW_BIG_DIFF_LINES} or more changed lines, or spans ${CLAUDE_REVIEW_DEEP_MODULES} or more top-level folders; quick otherwise`
		: `do a ${setting} pass`;
	return `6. When the trigger asks for neither \`quick\` nor \`deep\`, ${pick}. Open the answer with one line that says which depth you used and why.`;
}

/**
 * Splits a unified diff into one diff per top-level folder, for a Deep review's fan-out.
 * A diff with one module comes back whole. Pure.
 */
export function splitClaudeReviewDiff(diff: string): readonly string[] {
	const parts = new Map<string, string[]>();
	let current: string[] | undefined;
	const preamble: string[] = [];
	for (const line of diff.split('\n')) {
		const header = /^diff --git a\/(?:.+) b\/(?<path>.+?)\r?$/.exec(line);
		if (header?.groups) {
			const module = claudeReviewModule(header.groups.path);
			current = parts.get(module);
			if (!current) {
				current = [];
				parts.set(module, current);
			}
		}
		(current ?? preamble).push(line);
	}
	if (parts.size <= 1) {
		return [diff];
	}
	return [...parts.values()].map(lines => lines.join('\n'));
}

/** Merges the findings of several passes, keeping the first of each file, start line and title. Pure. */
export function mergeClaudeReviewFindings(lists: readonly (readonly ClaudeReviewFinding[])[]): readonly ClaudeReviewFinding[] {
	const seen = new Set<string>();
	const merged: ClaudeReviewFinding[] = [];
	for (const finding of lists.flat()) {
		const key = `${finding.file}\u0000${finding.startLine}\u0000${finding.title.trim().toLowerCase()}`;
		if (!seen.has(key)) {
			seen.add(key);
			merged.push(finding);
		}
	}
	return merged;
}

/** The depth, model and turns of one review, with what Auto read from the diff. */
export interface ClaudeReviewPlan extends ClaudeReviewDepthChoice {
	readonly stats: ClaudeReviewDiffStats;
	readonly model?: string;
	readonly maxTurns: number;
}

/**
 * Plans a review from the settings (issue 926). `forced` is a depth the caller asked
 * for, such as `@klawly review deep` or the commit review's own setting; it wins over
 * `claude.review.depth`. `model` is the caller's own model, used when no setting names one.
 */
export function planClaudeReviewRun(diff: string, read: (key: string) => unknown, options: { readonly forced?: ClaudeReviewDepth; readonly model?: string } = {}): ClaudeReviewPlan {
	const stats = claudeReviewDiffStats(diff);
	const choice = chooseClaudeReviewDepth(stats, options.forced ?? readClaudeReviewDepthSetting(read(CLAUDE_REVIEW_DEPTH_SETTING)));
	return {
		...choice,
		stats,
		model: claudeReviewModel(read(CLAUDE_REVIEW_MODEL_SETTING), choice.depth, options.model),
		maxTurns: readClaudeReviewMaxTurns(read(CLAUDE_REVIEW_MAX_TURNS_SETTING), choice.depth),
	};
}

/** Whether a Deep run is big enough to warn about its cost first. */
export function claudeReviewNeedsCostNote(plan: ClaudeReviewPlan): boolean {
	return plan.depth === 'deep' && plan.stats.changedLines >= CLAUDE_REVIEW_BIG_DIFF_LINES;
}

/** The line that says which depth a review runs at and why, plus the cost note of a big Deep run. */
export function claudeReviewDepthMessage(plan: ClaudeReviewPlan): string {
	const reason = claudeReviewDepthReasonText(plan);
	const line = plan.depth === 'deep'
		? localize('claudeReviewDepthDeep', "Deep review: {0}", reason)
		: localize('claudeReviewDepthQuick', "Quick review: {0}", reason);
	return claudeReviewNeedsCostNote(plan)
		? localize('claudeReviewDepthCost', "{0} A deep review of {1} changed lines takes several passes and uses more of your plan.", line, plan.stats.changedLines)
		: line;
}

function claudeReviewDepthReasonText(plan: ClaudeReviewPlan): string {
	switch (plan.reason) {
		case 'setting': return localize('claudeReviewDepthReasonSetting', "set in Review Depth or asked for.");
		case 'riskPath': return localize('claudeReviewDepthReasonRisk', "{0} is a risky path (auth, payments, migrations or CI).", plan.riskPath ?? '');
		case 'big': return localize('claudeReviewDepthReasonBig', "{0} changed lines is a big diff.", plan.stats.changedLines);
		case 'modules': return localize('claudeReviewDepthReasonModules', "the diff spans {0} top-level folders.", plan.stats.modules);
		case 'small': return localize('claudeReviewDepthReasonSmall', "{0} changed lines is a small diff.", plan.stats.changedLines);
		case 'medium': return localize('claudeReviewDepthReasonMedium', "{0} changed lines in a few folders, with no risky path.", plan.stats.changedLines);
	}
}
