/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The highest merge-readiness score: nothing stands in the way (issue 920). */
export const CLAUDE_REVIEW_READINESS_MAX = 5;

/** The areas that weigh more than their number of findings. */
export const CLAUDE_REVIEW_RISK_AREAS = ['auth', 'payments', 'migrations'] as const;
export type ClaudeReviewRiskArea = typeof CLAUDE_REVIEW_RISK_AREAS[number];

/** How ready a change is to merge, 0 (do not merge) to 5 (ready), with the rule that gave it. Advice only (issue 508). */
export interface ClaudeReviewReadiness {
	readonly score: number;
	readonly reason: string;
	readonly riskArea?: ClaudeReviewRiskArea;
}

/** The part of a finding the fallback score looks at. */
export interface ClaudeReviewReadinessFinding {
	readonly file: string;
	readonly severity: 'critical' | 'high' | 'medium' | 'low';
	readonly kind?: 'finding' | 'question';
}

const RISK_PATTERNS: Record<ClaudeReviewRiskArea, RegExp> = {
	auth: /(^|[\/._-])(auth\w*|login|logout|session|oauth|jwt|permissions?|credentials?|password)([\/._-]|$)/i,
	payments: /(^|[\/._-])(payments?|billing|checkout|invoice|stripe|subscriptions?)([\/._-]|$)/i,
	migrations: /(^|[\/._-])(migrations?|migrate|schema)([\/._-]|$)/i,
};

/** The risky area a file path belongs to, if any. */
export function claudeReviewRiskArea(file: string): ClaudeReviewRiskArea | undefined {
	return CLAUDE_REVIEW_RISK_AREAS.find(area => RISK_PATTERNS[area].test(file));
}

/** The prompt rule that asks the model for the score; the fallback below uses the same rule. */
export const CLAUDE_REVIEW_READINESS_RULE = 'Score from the highest unresolved severity (none 5, low 4, medium 3, high 2, critical 0 or 1), take one off for more than three findings, and one off when the finding touches auth, payments or migrations.';

/** Clamps to a whole number from 0 to 5; `undefined` for anything that is not a number. */
export function clampClaudeReviewReadinessScore(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return undefined;
	}
	return Math.min(CLAUDE_REVIEW_READINESS_MAX, Math.max(0, Math.round(value)));
}

/**
 * The deterministic score when the model gives none: the highest severity sets the base
 * (none 5, low 4, medium 3, high 2, critical 0), more than three findings take one off,
 * and a finding in auth, payments or migrations takes one off. Questions do not count.
 */
export function fallbackClaudeReviewReadiness(findings: readonly ClaudeReviewReadinessFinding[]): ClaudeReviewReadiness {
	const real = findings.filter(finding => finding.kind !== 'question');
	if (!real.length) {
		return { score: CLAUDE_REVIEW_READINESS_MAX, reason: 'No unresolved findings.' };
	}
	const base = { low: 4, medium: 3, high: 2, critical: 0 };
	const order = ['critical', 'high', 'medium', 'low'] as const;
	const worst = order.find(severity => real.some(finding => finding.severity === severity))!;
	let score = base[worst];
	const parts = [`highest severity is ${worst}`];
	if (real.length > 3) {
		score -= 1;
		parts.push(`${real.length} findings`);
	}
	const riskArea = real.map(finding => claudeReviewRiskArea(finding.file)).find(area => area !== undefined);
	if (riskArea) {
		score -= 1;
		parts.push(`touches ${riskArea}`);
	}
	return {
		score: clampClaudeReviewReadinessScore(score) ?? 0,
		reason: `${parts[0].charAt(0).toUpperCase()}${parts[0].slice(1)}${parts.length > 1 ? `, ${parts.slice(1).join(', ')}` : ''}.`,
		...(riskArea ? { riskArea } : {}),
	};
}

/**
 * Reads the optional top-level `readiness` of the structured answer. A missing or unusable score
 * falls back to the deterministic one; the model's reason is kept when it gave one.
 */
export function readClaudeReviewReadiness(value: unknown, findings: readonly ClaudeReviewReadinessFinding[]): ClaudeReviewReadiness {
	const raw = typeof value === 'object' && value !== null ? (value as { readiness?: unknown }).readiness : undefined;
	const { score, reason, riskArea } = (typeof raw === 'object' && raw !== null ? raw : {}) as { score?: unknown; reason?: unknown; riskArea?: unknown };
	const clamped = clampClaudeReviewReadinessScore(score);
	if (clamped === undefined) {
		return fallbackClaudeReviewReadiness(findings);
	}
	const area = CLAUDE_REVIEW_RISK_AREAS.find(candidate => candidate === riskArea);
	return {
		score: clamped,
		reason: typeof reason === 'string' && reason.trim() ? reason.trim() : fallbackClaudeReviewReadiness(findings).reason,
		...(area ? { riskArea: area } : {}),
	};
}

/** One line for headers, rows and the PR summary: "Merge readiness 3/5: reason". Advice only; it never approves anything. */
export function formatClaudeReviewReadiness(readiness: ClaudeReviewReadiness): string {
	return `Merge readiness ${readiness.score}/${CLAUDE_REVIEW_READINESS_MAX}: ${readiness.reason}`;
}

/** The band of a readiness score: what the number means at a glance (issue 1098). */
export type ClaudeReviewReadinessBand = 'notReady' | 'reviewNeeded' | 'ready';

/** 0 to 2 is not ready, 3 and 4 need review, 5 is ready. */
export function claudeReviewReadinessBand(score: number): ClaudeReviewReadinessBand {
	return score >= CLAUDE_REVIEW_READINESS_MAX ? 'ready' : score >= 3 ? 'reviewNeeded' : 'notReady';
}
