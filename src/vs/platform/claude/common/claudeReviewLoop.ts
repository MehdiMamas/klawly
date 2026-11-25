/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeReviewDepth, claudeReviewDepthPromptLines } from './claudeReviewDepth.js';
import { ClaudeCommandInfo } from './claudeCommands.js';
import { CLAUDE_REVIEW_READINESS_RULE, ClaudeReviewReadiness, formatClaudeReviewReadiness } from './claudeReviewReadiness.js';
import { ClaudeReviewDiagram, ClaudeReviewDiagramKind, claudeReviewDiagramPrompt, formatClaudeReviewDiagram, readClaudeReviewDiagram } from './claudeReviewDiagram.js';
import { CLAUDE_REVIEW_TICKET_CHECKS_SCHEMA, CLAUDE_REVIEW_TICKET_PATTERNS_SETTING, CLAUDE_REVIEW_USE_TICKETS_SETTING, ClaudeReviewTicketCheck, ClaudeReviewTicketRequest, claudeReviewTicketPrompt, claudeReviewTicketReadOnlyTools, formatClaudeReviewTicketChecks, readClaudeReviewTicketChecks, readClaudeReviewTicketPatterns } from './claudeReviewTickets.js';
import { ClaudeReviewTestGap, formatClaudeReviewTestGaps, readClaudeReviewTestGaps } from './claudeReviewTests.js';

/**
 * A comment the user left on a line of the Review editor, waiting to be sent to
 * the agent (issue 431). `path` is relative to the workspace folder when it is
 * inside it, so the agent can read it as written.
 */
export interface ClaudeReviewFeedback {
	readonly id: string;
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
	/** The turn whose change the comment is on, when the line belongs to one. */
	readonly turnId?: string;
}

/** `path:line` or `path:start-end`, the form a pasted reference takes. */
export function claudeLineReference(path: string, startLine: number, endLine: number): string {
	return endLine > startLine ? `${path}:${startLine}-${endLine}` : `${path}:${startLine}`;
}

/** Sort order of feedback: by file, then by line, so the message reads top to bottom. */
export function compareClaudeReviewFeedback(a: ClaudeReviewFeedback, b: ClaudeReviewFeedback): number {
	return a.path.localeCompare(b.path) || a.startLine - b.startLine || a.endLine - b.endLine;
}

/**
 * The one message that carries every draft comment to the agent: a short ask,
 * then one block per comment headed by its `path:line` reference.
 */
export function formatClaudeReviewFeedback(items: readonly ClaudeReviewFeedback[]): string {
	const blocks = [...items].sort(compareClaudeReviewFeedback).map(item => {
		const body = item.text.trim().split(/\r?\n/).map(line => `  ${line}`).join('\n');
		return `- ${claudeLineReference(item.path, item.startLine, item.endLine)}\n${body}`;
	});
	const ask = items.length === 1
		? 'I left a review comment on your changes. Address it, then say what you changed.'
		: 'I left review comments on your changes. Address each one, then say what you changed.';
	return `${ask}\n\n${blocks.join('\n')}`;
}

/** The one severity scale of every Klawly review (issue 921), worst first. */
export type ClaudeReviewSeverity = 'critical' | 'high' | 'medium' | 'low';

export const CLAUDE_REVIEW_SEVERITIES: readonly ClaudeReviewSeverity[] = ['critical', 'high', 'medium', 'low'];

/** What a finding is about (issue 921). */
export type ClaudeReviewCategory = 'security' | 'bug' | 'logic' | 'performance' | 'style' | 'tests';

export const CLAUDE_REVIEW_CATEGORIES: readonly ClaudeReviewCategory[] = ['security', 'bug', 'logic', 'performance', 'style', 'tests'];

/** The categories shown by default: everything but style. */
export const CLAUDE_REVIEW_DEFAULT_CATEGORIES: readonly ClaudeReviewCategory[] = ['security', 'bug', 'logic', 'performance', 'tests'];

export type ClaudeReviewStrictness = 'relaxed' | 'balanced' | 'strict';

export const CLAUDE_REVIEW_MIN_SEVERITY_SETTING = 'claude.review.minSeverity';
export const CLAUDE_REVIEW_CATEGORIES_SETTING = 'claude.review.categories';
export const CLAUDE_REVIEW_STRICTNESS_SETTING = 'claude.review.strictness';

/** `claude.review.summary` (issue 918): whether a review opens with a summary, and whether it proposes a new PR description. */
export const CLAUDE_REVIEW_SUMMARY_SETTING = 'claude.review.summary';
export const CLAUDE_REVIEW_SUMMARY_MODES = ['off', 'summary', 'summaryAndDescription'] as const;
export type ClaudeReviewSummaryMode = typeof CLAUDE_REVIEW_SUMMARY_MODES[number];

export function readClaudeReviewSummaryMode(value: unknown): ClaudeReviewSummaryMode {
	return CLAUDE_REVIEW_SUMMARY_MODES.find(mode => mode === value) ?? 'summary';
}

/**
 * Reads a severity. The old three-level scale of reviews stored before issue 921
 * maps error to high, warning to medium and info to low. Unknown values are low.
 */
export function readClaudeReviewSeverity(value: unknown): ClaudeReviewSeverity {
	switch (value) {
		case 'critical': case 'high': case 'medium': case 'low': return value;
		case 'error': return 'high';
		case 'warning': return 'medium';
		default: return 'low';
	}
}

/** A missing or unknown category is `bug`. */
export function readClaudeReviewCategory(value: unknown): ClaudeReviewCategory {
	return CLAUDE_REVIEW_CATEGORIES.find(category => category === value) ?? 'bug';
}

export function readClaudeReviewStrictness(value: unknown): ClaudeReviewStrictness {
	return value === 'relaxed' || value === 'strict' ? value : 'balanced';
}

/** The categories setting: known names only. Anything but a list is the default. */
export function readClaudeReviewCategories(value: unknown): readonly ClaudeReviewCategory[] {
	if (!Array.isArray(value)) {
		return CLAUDE_REVIEW_DEFAULT_CATEGORIES;
	}
	return CLAUDE_REVIEW_CATEGORIES.filter(category => value.includes(category));
}

/** Whether the review shows a merge-readiness score, 0 to 5 (issue 920). On by default. */
export const CLAUDE_REVIEW_SHOW_READINESS_SETTING = 'claude.review.showReadiness';

/** The review settings as read from the configuration. */
export interface ClaudeReviewSettings extends ClaudeReviewFilter {
	readonly strictness: ClaudeReviewStrictness;
	readonly summary: ClaudeReviewSummaryMode;
	/** Whether the review shows a merge-readiness score (issue 920). */
	readonly showReadiness: boolean;
	/** Whether the review checks the change against its ticket (issue 935). */
	readonly useTickets: boolean;
	readonly ticketPatterns: readonly string[];
}

export function readClaudeReviewSettings(getValue: (key: string) => unknown): ClaudeReviewSettings {
	const minSeverity = getValue(CLAUDE_REVIEW_MIN_SEVERITY_SETTING);
	return {
		minSeverity: CLAUDE_REVIEW_SEVERITIES.find(severity => severity === minSeverity) ?? 'low',
		categories: readClaudeReviewCategories(getValue(CLAUDE_REVIEW_CATEGORIES_SETTING)),
		strictness: readClaudeReviewStrictness(getValue(CLAUDE_REVIEW_STRICTNESS_SETTING)),
		summary: readClaudeReviewSummaryMode(getValue(CLAUDE_REVIEW_SUMMARY_SETTING)),
		showReadiness: getValue(CLAUDE_REVIEW_SHOW_READINESS_SETTING) !== false,
		useTickets: getValue(CLAUDE_REVIEW_USE_TICKETS_SETTING) === true,
		ticketPatterns: readClaudeReviewTicketPatterns(getValue(CLAUDE_REVIEW_TICKET_PATTERNS_SETTING)),
	};
}

/** How the review is narrowed: findings below `minSeverity` or outside `categories` are hidden. */
export interface ClaudeReviewFilter {
	readonly minSeverity: ClaudeReviewSeverity;
	readonly categories: readonly ClaudeReviewCategory[];
}

/**
 * Hides findings below the minimum severity or outside the categories. Pure: it
 * returns a new list and never touches the stored one. Security findings and
 * critical findings are never dropped.
 */
export function filterClaudeReviewFindings(findings: readonly ClaudeReviewFinding[], filter: ClaudeReviewFilter): readonly ClaudeReviewFinding[] {
	const limit = SEVERITY_ORDER[filter.minSeverity];
	return findings.filter(finding => finding.severity === 'critical' || finding.category === 'security'
		|| (SEVERITY_ORDER[finding.severity] <= limit && filter.categories.includes(finding.category)));
}

/** One finding of the structured review pass. Lines are 1-based in the current file. */
export interface ClaudeReviewFinding {
	readonly file: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly severity: ClaudeReviewSeverity;
	readonly category: ClaudeReviewCategory;
	readonly title: string;
	readonly body: string;
	readonly suggestion?: string;
	/** `question`: intent cannot be inferred, so the reviewer asks instead of asserting a bug (issue 929). Missing means a finding. */
	readonly kind?: 'question';
}

/** How risky the change to one file is. */
export type ClaudeReviewFileRisk = 'low' | 'medium' | 'high';

/** One row of the per-file walkthrough (issue 918). */
export interface ClaudeReviewSummaryFile {
	readonly path: string;
	readonly change: string;
	readonly risk: ClaudeReviewFileRisk;
}

/** What a change does, who it touches and why, then file by file (issue 918). */
export interface ClaudeReviewSummary {
	readonly overview: string;
	readonly files: readonly ClaudeReviewSummaryFile[];
	/** A proposed new pull request description, when the setting asks for one. */
	readonly description?: string;
	/** A diagram of the change, when one helps (issue 919). */
	readonly diagram?: ClaudeReviewDiagram;
	/** Cases the change has no test for (issue 936). */
	readonly testGaps?: readonly ClaudeReviewTestGap[];
	/** How the change measures up to its linked ticket, per acceptance criterion (issue 935). */
	readonly ticketChecks?: readonly ClaudeReviewTicketCheck[];
}

/** The schema the structured review query asks Claude Code to answer with. */
export const CLAUDE_REVIEW_FINDINGS_SCHEMA: Record<string, unknown> = {
	type: 'object',
	additionalProperties: false,
	required: ['findings'],
	properties: {
		summary: {
			type: 'object',
			additionalProperties: false,
			required: ['overview', 'files'],
			description: 'What the change does, who it affects and why, then one row per changed file.',
			properties: {
				overview: { type: 'string', description: 'Two to four sentences: what the change does, who or what it affects, and why.' },
				files: {
					type: 'array',
					items: {
						type: 'object',
						additionalProperties: false,
						required: ['path', 'change'],
						properties: {
							path: { type: 'string' },
							change: { type: 'string', description: 'One line: what changed in this file.' },
							risk: { type: 'string', enum: ['low', 'medium', 'high'] },
						},
					},
				},
				description: { type: 'string', description: 'A proposed pull request description in Markdown.' },
				diagram: {
					type: 'object',
					additionalProperties: false,
					required: ['kind', 'mermaid'],
					description: 'A Mermaid diagram of the change; omit for small, docs-only or rename changes.',
					properties: {
						kind: { type: 'string', enum: ['sequence', 'flow', 'er', 'class'] },
						mermaid: { type: 'string', description: 'Mermaid text that starts with sequenceDiagram, flowchart, erDiagram or classDiagram.' },
					},
				},
				ticketChecks: CLAUDE_REVIEW_TICKET_CHECKS_SCHEMA,
				testGaps: {
					type: 'array',
					maxItems: 10,
					description: 'Cases the change has no test for, one per function and case; omit when the change is covered.',
					items: {
						type: 'object',
						additionalProperties: false,
						required: ['file', 'symbol', 'caseDescription'],
						properties: {
							file: { type: 'string', description: 'The changed file that holds the function.' },
							symbol: { type: 'string', description: 'The function, method or class without a test.' },
							caseDescription: { type: 'string', description: 'One line: the case that is not tested, e.g. "stops after the maximum number of attempts".' },
						},
					},
				},
			},
		},
		readiness: {
			type: 'object',
			additionalProperties: false,
			required: ['score', 'reason'],
			description: 'How ready the change is to merge, 0 (do not merge) to 5 (ready). Advice only.',
			properties: {
				score: { type: 'integer', minimum: 0, maximum: 5 },
				reason: { type: 'string', description: 'One line that cites the scoring rule: the highest unresolved severity, the number of findings and the area touched.' },
				riskArea: { type: 'string', enum: ['auth', 'payments', 'migrations'] },
			},
		},
		findings: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['file', 'startLine', 'endLine', 'severity', 'title', 'body'],
				properties: {
					file: { type: 'string', description: 'Path of the changed file, relative to the working directory.' },
					startLine: { type: 'integer', minimum: 1 },
					endLine: { type: 'integer', minimum: 1 },
					severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'critical: data loss, security hole, crash. high: a real bug. medium: a risk or a gap. low: a small improvement.' },
					category: { type: 'string', enum: ['security', 'bug', 'logic', 'performance', 'style', 'tests'] },
					title: { type: 'string', description: 'One line.' },
					body: { type: 'string' },
					suggestion: { type: 'string', description: 'Replacement code for the lines, when there is a concrete fix.' },
					kind: { type: 'string', enum: ['finding', 'question'], description: 'question only when intent cannot be inferred from code, tests or docs; the title is then the question.' },
				},
			},
		},
	},
};

/** Tools the structured review may run: it reads, it never edits. */
export const CLAUDE_REVIEW_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];

const SEVERITY_ORDER: Record<ClaudeReviewSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Reads the structured answer. Returns `undefined` when it is not an object with
 * a `findings` array; findings without a file, a title or a valid line are dropped.
 * The rest come back worst first, then by file and line.
 */
export function readClaudeReviewFindings(value: unknown): readonly ClaudeReviewFinding[] | undefined {
	if (typeof value !== 'object' || value === null || !Array.isArray((value as { findings?: unknown }).findings)) {
		return undefined;
	}
	const findings: ClaudeReviewFinding[] = [];
	for (const raw of (value as { findings: unknown[] }).findings) {
		const finding = readFinding(raw);
		if (finding) {
			findings.push(finding);
		}
	}
	return findings.sort(compareClaudeReviewFindings);
}

/**
 * Reads the optional `summary` of the structured answer. `undefined` when it is
 * missing or has no overview; rows without a path or a change are dropped.
 */
export function readClaudeReviewSummary(value: unknown): ClaudeReviewSummary | undefined {
	const raw = typeof value === 'object' && value !== null ? (value as { summary?: unknown }).summary : undefined;
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const { overview, files, description, diagram, testGaps, ticketChecks } = raw as { overview?: unknown; files?: unknown; description?: unknown; diagram?: unknown; testGaps?: unknown; ticketChecks?: unknown };
	if (typeof overview !== 'string' || !overview.trim()) {
		return undefined;
	}
	const rows: ClaudeReviewSummaryFile[] = [];
	for (const row of Array.isArray(files) ? files : []) {
		const { path, change, risk } = (typeof row === 'object' && row !== null ? row : {}) as { path?: unknown; change?: unknown; risk?: unknown };
		if (typeof path === 'string' && path.trim() && typeof change === 'string' && change.trim()) {
			rows.push({ path: path.trim(), change: change.trim(), risk: risk === 'high' || risk === 'medium' ? risk : 'low' });
		}
	}
	const drawn = readClaudeReviewDiagram(diagram);
	const gaps = readClaudeReviewTestGaps(testGaps);
	const checks = readClaudeReviewTicketChecks(ticketChecks);
	return {
		overview: overview.trim(),
		files: rows,
		...(typeof description === 'string' && description.trim() ? { description: description.trim() } : {}),
		...(drawn ? { diagram: drawn } : {}),
		...(gaps.length ? { testGaps: gaps } : {}),
		...(checks.length ? { ticketChecks: checks } : {}),
	};
}

/** Markdown for the summary: the overview, then a collapsible per-file table (issue 918);  appends the proposed description (issue 1088). */
export function formatClaudeReviewSummary(summary: ClaudeReviewSummary, readiness?: ClaudeReviewReadiness, includeDescription = false): string {
	const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ');
	const lines = ['## Summary', '', summary.overview];
	if (summary.diagram) {
		lines.push('', formatClaudeReviewDiagram(summary.diagram));
	}
	if (readiness) {
		lines.push('', `**${formatClaudeReviewReadiness(readiness)}**`);
	}
	if (summary.testGaps?.length) {
		lines.push('', formatClaudeReviewTestGaps(summary.testGaps));
	}
	if (summary.ticketChecks?.length) {
		lines.push('', formatClaudeReviewTicketChecks(summary.ticketChecks));
	}
	if (summary.files.length) {
		lines.push('', '<details>', `<summary>Files changed (${summary.files.length})</summary>`, '', '| File | Change | Risk |', '| --- | --- | --- |');
		for (const file of summary.files) {
			lines.push(`| \`${file.path}\` | ${cell(file.change)} | ${file.risk} |`);
		}
		lines.push('', '</details>');
	}
	if (includeDescription && summary.description) {
		lines.push('', '## Proposed Pull Request Description', '', summary.description);
	}
	return lines.join('\n');
}

/** Worst first, then by file and line. */
export function compareClaudeReviewFindings(a: ClaudeReviewFinding, b: ClaudeReviewFinding): number {
	return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.file.localeCompare(b.file) || a.startLine - b.startLine;
}

function readFinding(raw: unknown): ClaudeReviewFinding | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const candidate = raw as Record<string, unknown>;
	const { file, title } = candidate;
	const startLine = positiveLine(candidate.startLine);
	if (typeof file !== 'string' || !file.trim() || typeof title !== 'string' || !title.trim() || startLine === undefined) {
		return undefined;
	}
	const endLine = Math.max(startLine, positiveLine(candidate.endLine) ?? startLine);
	const severity = readClaudeReviewSeverity(candidate.severity);
	const category = readClaudeReviewCategory(candidate.category);
	const suggestion = typeof candidate.suggestion === 'string' && candidate.suggestion.length > 0 ? candidate.suggestion : undefined;
	return {
		file: file.trim(),
		startLine,
		endLine,
		severity,
		category,
		title: title.trim(),
		body: typeof candidate.body === 'string' ? candidate.body.trim() : '',
		...(suggestion !== undefined ? { suggestion } : {}),
		...(candidate.kind === 'question' ? { kind: 'question' as const } : {}),
	};
}

function positiveLine(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** The prompt wording of each strictness: what counts as a problem. */
const STRICTNESS_WORDING: Record<ClaudeReviewStrictness, string> = {
	relaxed: 'Be relaxed: report only problems you are sure about and that matter. Skip nitpicks, taste and anything speculative.',
	balanced: 'Be balanced: report real problems and clear risks in the changed code. Skip pure taste.',
	strict: 'Be strict: also report risks, edge cases, missing tests and anything a careful maintainer would push back on.',
};

/** Problems no setting hides (issue 921). */
const NEVER_SUPPRESSED = 'Whatever the settings, always report security problems, memory leaks, null or undefined dereferences and infinite loops.';

/** Strictness and categories the prompt words; the defaults when missing. */
export interface ClaudeReviewPromptOptions {
	readonly strictness?: ClaudeReviewStrictness;
	readonly categories?: readonly ClaudeReviewCategory[];
	/** Canonical related repository folders the reviewer may read (issue 934). */
	readonly relatedRepos?: readonly string[];
	/** Whether the answer opens with a summary (issue 918); off when missing. */
	readonly summary?: ClaudeReviewSummaryMode;
	/** Forces a diagram of this kind in the summary (Redraw Diagram, issue 919). */
	readonly diagramKind?: ClaudeReviewDiagramKind;
	/** Whether the answer carries a merge-readiness score (issue 920); off when missing. */
	readonly readiness?: boolean;
	/** How deep the pass goes (issue 926); no depth line when missing. */
	readonly depth?: ClaudeReviewDepth;
	/** The ticket check (issue 935); no ticket lines when missing. */
	readonly tickets?: ClaudeReviewTicketRequest;
}

/** The prompt lines that ask for the merge-readiness score; empty when it is off (issue 920). */
export function claudeReviewReadinessPrompt(enabled: boolean): string[] {
	if (!enabled) {
		return [];
	}
	return [
		'',
		`Also fill "readiness": "score" is a whole number from 0 (do not merge) to 5 (ready to merge) and "reason" is one line that cites the rule you used. ${CLAUDE_REVIEW_READINESS_RULE} Name the area in "riskArea" when it applies. The score is advice only.`,
	];
}

/** The prompt lines that ask for the summary; empty when it is off. */
export function claudeReviewSummaryPrompt(mode: ClaudeReviewSummaryMode, diagramKind?: ClaudeReviewDiagramKind): string[] {
	if (mode === 'off') {
		return [];
	}
	return [
		'',
		'Also fill "summary": "overview" says in two to four sentences what the change does, who or what it affects and why; "files" has one row per changed file with a one-line "change" and a "risk" (low, medium or high).',
		...(mode === 'summaryAndDescription' ? ['Also put a better pull request description in Markdown in "summary.description": what and why, then how it was checked.'] : []),
		'List in "summary.testGaps" the functions this change adds or changes that have no test, one row per missing case (at most 10); leave it out when the change is covered.',
		...claudeReviewDiagramPrompt(diagramKind),
	];
}

/** The prompt lines that name the related repositories; empty when there are none. */
export function claudeRelatedReposPrompt(directories: readonly string[]): string[] {
	if (!directories.length) {
		return [];
	}
	return [
		'',
		'These related repositories can be read (read only, outside the project):',
		...directories.map(directory => `- ${directory}`),
		'When the diff changes an exported API, a schema or a protocol, search them for callers and consumers that would break. When a finding comes from one, name the file with its full path in the body.',
	];
}

/** The prompt of the structured review: the diff as context, findings only on changed code. */
export function claudeReviewPrompt(diff: string, instructions?: string, options: ClaudeReviewPromptOptions = {}): string {
	// Issue 502: the project's own review notes (REVIEW.md), when it has them.
	const notes = instructions?.trim() ? ['', 'The project asks reviewers to follow these notes:', '<project_review_notes>', instructions.trim(), '</project_review_notes>'] : [];
	const categories = options.categories ?? CLAUDE_REVIEW_DEFAULT_CATEGORIES;
	return [
		'Review the changes in the diff below for bugs, risks and missing tests.',
		'Read the files you need with the tools you have; do not edit anything.',
		'Report each problem as one finding on the lines of the current file it is about (1-based line numbers).',
		'Give each finding a severity (critical, high, medium or low) and a category (security, bug, logic, performance, style or tests).',
		`Report only real problems in the changed code. An empty list is a valid answer. ${STRICTNESS_WORDING[options.strictness ?? 'balanced']}`,
		categories.length ? `Report these categories: ${categories.join(', ')}.` : 'Report only security problems.',
		NEVER_SUPPRESSED,
		...claudeReviewDepthPromptLines(options.depth),
		'Use kind "question" (the title is the question) only when the intent cannot be inferred from the code, tests or docs; otherwise report a finding.',
		...notes,
		...claudeRelatedReposPrompt(options.relatedRepos ?? []),
		...claudeReviewSummaryPrompt(options.summary ?? 'off', options.diagramKind),
		...claudeReviewReadinessPrompt(options.readiness ?? false),
		...claudeReviewTicketPrompt(!!options.tickets && (options.summary ?? 'off') !== 'off', options.tickets?.ids ?? [], claudeReviewTicketReadOnlyTools(options.tickets)),
		'',
		'<diff>',
		diff,
		'</diff>',
	].join('\n');
}

/** A finding as feedback for the agent: Fix with Agent sends it like a line comment. */
export function claudeFindingFeedback(finding: ClaudeReviewFinding, id: string): ClaudeReviewFeedback {
	const parts = [finding.title, finding.body];
	if (finding.suggestion) {
		parts.push(`Suggested fix:\n${finding.suggestion}`);
	}
	return { id, path: finding.file, startLine: finding.startLine, endLine: finding.endLine, text: parts.filter(Boolean).join('\n') };
}

/** What the workbench asks the runtime to review with the structured pass (issue 431). */
export interface ClaudeReviewRequest {
	/** The workbench's id for this pass; `cancelReview` takes it. */
	readonly reviewId: string;
	/** The chat whose changes are reviewed; the findings event carries it. */
	readonly sessionId: string;
	readonly cwd: string;
	/** The changes under review, as unified diff text. */
	readonly diff: string;
	readonly model?: string;
	/** The project's own review notes, such as REVIEW.md (issue 502). */
	readonly instructions?: string;
	/** How strict the review is (issue 921); balanced when missing. */
	readonly strictness?: ClaudeReviewStrictness;
	/** The categories the review reports (issue 921). */
	readonly categories?: readonly ClaudeReviewCategory[];
	/** Whether the answer carries a summary (issue 918); off when missing. */
	readonly summary?: ClaudeReviewSummaryMode;
	/** Forces a diagram of this kind in the summary (Redraw Diagram, issue 919). */
	readonly diagramKind?: ClaudeReviewDiagramKind;
	/** Whether the answer carries a merge-readiness score (issue 920); off when missing. */
	readonly readiness?: boolean;
	/** How deep the review goes (issue 926); Deep may fan out by top-level folder. Neither when missing. */
	readonly depth?: ClaudeReviewDepth;
	/** The most turns one pass may take (issue 926). */
	readonly maxTurns?: number;
	/** The ticket check (issue 935): ids to fetch and the tracker's read-only tools. Missing when the setting is off. */
	readonly tickets?: ClaudeReviewTicketRequest;
}

/**
 * Why a review pass has no findings. `malformed` carries the text Claude wrote
 * instead, when it wrote any.
 */
export type ClaudeReviewFailure =
	| { readonly kind: 'cancelled' }
	| { readonly kind: 'failed'; readonly message: string }
	| { readonly kind: 'malformed'; readonly text?: string };

/** Commands and skills that make Review run the project's own review instead of the structured pass. */
const PROJECT_REVIEW_COMMANDS: readonly string[] = ['review'];
const PROJECT_REVIEW_SKILLS: readonly string[] = ['code-review', 'review'];

/**
 * The one-click rule (spec 34a) for Review: the project's or the user's own
 * `/review` command or review skill wins over the structured pass. Claude Code's
 * built-in `/review` (and a name whose source is not known yet) does not count:
 * the structured pass is Klawly's own review.
 */
export function claudeHasOwnReviewCommand(commands: readonly ClaudeCommandInfo[], skills: readonly string[], preferClaudeCommands: boolean): boolean {
	if (!preferClaudeCommands) {
		return false;
	}
	if (PROJECT_REVIEW_SKILLS.some(name => skills.includes(name))) {
		return true;
	}
	return commands.some(command => PROJECT_REVIEW_COMMANDS.includes(command.name) && command.source !== 'builtin' && command.source !== 'other' && command.source !== 'mcp');
}

/**
 * Findings in the chat answer of a project's own `/review`: a fenced `json`
 * block (or the whole answer) that is an object with a `findings` array.
 * `undefined` when there is none, which is when Review runs the structured pass.
 */
export function readClaudeReviewFindingsFromText(text: string): readonly ClaudeReviewFinding[] | undefined {
	const candidates = [...text.matchAll(/```(?:json)?[ \t]*\r?\n(?<body>[\s\S]*?)```/g)].map(match => match.groups?.body ?? '');
	candidates.push(text);
	for (const candidate of candidates) {
		let value: unknown;
		try {
			value = JSON.parse(candidate.trim());
		} catch {
			continue;
		}
		const findings = readClaudeReviewFindings(value);
		if (findings) {
			return findings;
		}
	}
	return undefined;
}

/** Forward slashes, no leading `./`, so `./src\a.ts` and `src/a.ts` match. */
export function normalizeClaudeFindingPath(path: string): string {
	return path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/** What an exported review carries besides the findings (issue 938). */
export interface ClaudeReviewExportOptions {
	/** The commit the review was made against. */
	readonly commitSha?: string;
	/** The merge-readiness score from 0 to 5, when the review produced one (issue 920). */
	readonly readinessScore?: number;
	/** The one-line reason for the score. */
	readonly readinessReason?: string;
	/** The summary of the pass (issue 918), written first. */
	readonly summary?: ClaudeReviewSummary;
}

const SARIF_LEVELS: Record<ClaudeReviewSeverity, 'error' | 'warning' | 'note'> = { critical: 'error', high: 'error', medium: 'warning', low: 'note' };

function exportedFindings(findings: readonly ClaudeReviewFinding[], filter: ClaudeReviewFilter): readonly ClaudeReviewFinding[] {
	return [...filterClaudeReviewFindings(findings, filter)].sort(compareClaudeReviewFindings);
}

/** Markdown of a review: commit, readiness score, summary and the findings that pass the filter (issue 938). Pure. */
export function formatClaudeReviewMarkdown(findings: readonly ClaudeReviewFinding[], filter: ClaudeReviewFilter, options: ClaudeReviewExportOptions = {}): string {
	const shown = exportedFindings(findings, filter);
	const lines = ['# Klawly Review'];
	if (options.commitSha) {
		lines.push('', `Commit: \`${options.commitSha}\``);
	}
	if (options.readinessScore !== undefined) {
		lines.push('', `Readiness: ${options.readinessScore}/5${options.readinessReason ? ` - ${options.readinessReason}` : ''}`);
	}
	if (options.summary) {
		lines.push('', formatClaudeReviewSummary(options.summary));
	}
	lines.push('', `## Findings (${shown.length})`);
	if (!shown.length) {
		lines.push('', 'No findings.');
	}
	for (const finding of shown) {
		lines.push('', `### ${finding.kind === 'question' ? 'Question' : finding.severity.toUpperCase()}: ${finding.title}`, '', `\`${claudeLineReference(finding.file, finding.startLine, finding.endLine)}\` · ${finding.category}`, '', finding.body);
		if (finding.suggestion) {
			lines.push('', '```', finding.suggestion, '```');
		}
	}
	return lines.join('\n') + '\n';
}

/** SARIF 2.1.0 of a review: one result per finding that passes the filter; critical and high map to `error`, medium to `warning`, low to `note` (issue 938). Pure. */
export function formatClaudeReviewSarif(findings: readonly ClaudeReviewFinding[], filter: ClaudeReviewFilter, options: ClaudeReviewExportOptions = {}): string {
	const shown = exportedFindings(findings, filter);
	const properties: Record<string, unknown> = {};
	if (options.commitSha) {
		properties.commitSha = options.commitSha;
	}
	if (options.readinessScore !== undefined) {
		properties.readinessScore = options.readinessScore;
		if (options.readinessReason) {
			properties.readinessReason = options.readinessReason;
		}
	}
	const run: Record<string, unknown> = {
		tool: { driver: { name: 'Klawly Review', rules: CLAUDE_REVIEW_CATEGORIES.map(category => ({ id: category, name: category })) } },
		results: shown.map(finding => ({
			ruleId: finding.category,
			level: SARIF_LEVELS[finding.severity],
			message: { text: `${finding.title}\n\n${finding.body}${finding.suggestion ? `\n\nSuggestion:\n${finding.suggestion}` : ''}` },
			locations: [{ physicalLocation: { artifactLocation: { uri: normalizeClaudeFindingPath(finding.file) }, region: { startLine: finding.startLine, endLine: finding.endLine } } }],
		})),
	};
	if (options.commitSha) {
		run.versionControlProvenance = [{ revisionId: options.commitSha }];
	}
	if (Object.keys(properties).length) {
		run.properties = properties;
	}
	return JSON.stringify({ $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0', runs: [run] }, undefined, 2) + '\n';
}
