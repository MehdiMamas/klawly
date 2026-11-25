/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The kinds of diagram a review can draw for a change (issue 919). */
export const CLAUDE_REVIEW_DIAGRAM_KINDS = ['sequence', 'flow', 'er', 'class'] as const;
export type ClaudeReviewDiagramKind = typeof CLAUDE_REVIEW_DIAGRAM_KINDS[number];

/** A diagram of the change, as Mermaid text. */
export interface ClaudeReviewDiagram {
	readonly kind: ClaudeReviewDiagramKind;
	readonly mermaid: string;
}

/** A diagram bigger than this is dropped: it would be unreadable in the card. */
export const CLAUDE_REVIEW_DIAGRAM_MAX_LINES = 40;
const MAX_CHARS = 4000;

const HEADERS: Record<ClaudeReviewDiagramKind, RegExp> = {
	sequence: /^sequenceDiagram\b/,
	flow: /^(flowchart|graph)\b/,
	er: /^erDiagram\b/,
	class: /^classDiagram\b/,
};

/** Mermaid directives that run code or open links; a review never draws them. */
const UNSAFE = /(^|\s)(click|callback|href)\s|<\s*script|javascript:|%%\{|```/i;

/**
 * Reads the optional `diagram` of a summary. `undefined` when it is missing, of an unknown
 * kind, does not start with the header of its kind, is longer than the cap or has an
 * unsafe directive: the card then hides the block instead of drawing a broken one. Pure.
 */
export function readClaudeReviewDiagram(value: unknown): ClaudeReviewDiagram | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const { kind, mermaid } = value as { kind?: unknown; mermaid?: unknown };
	if (typeof mermaid !== 'string' || !CLAUDE_REVIEW_DIAGRAM_KINDS.includes(kind as ClaudeReviewDiagramKind)) {
		return undefined;
	}
	const text = mermaid.replace(/\r\n?/g, '\n').trim();
	const lines = text.split('\n').filter(line => line.trim() && !line.trim().startsWith('%%'));
	if (!text || text.length > MAX_CHARS || lines.length < 2 || lines.length > CLAUDE_REVIEW_DIAGRAM_MAX_LINES) {
		return undefined;
	}
	if (!HEADERS[kind as ClaudeReviewDiagramKind].test(lines[0].trim()) || UNSAFE.test(text)) {
		return undefined;
	}
	return { kind: kind as ClaudeReviewDiagramKind, mermaid: text };
}

/** The prompt lines that ask for a diagram when the change warrants one; `kind` forces it (Redraw Diagram). */
export function claudeReviewDiagramPrompt(kind?: ClaudeReviewDiagramKind): string[] {
	if (kind) {
		return ['', `Also fill "summary.diagram" with a Mermaid ${kind} diagram of the change (kind "${kind}"), at most ${CLAUDE_REVIEW_DIAGRAM_MAX_LINES} lines.`];
	}
	return [
		'',
		`Fill "summary.diagram" only when a diagram is the quickest way to see the change: a new request flow (sequence or flow), a schema change (er) or a class restructure (class). Leave it out for small, docs-only, rename or formatting changes. Keep it at most ${CLAUDE_REVIEW_DIAGRAM_MAX_LINES} lines, with no click or link directives.`,
	];
}

/** The Markdown fence a posted summary carries for a diagram. */
export function formatClaudeReviewDiagram(diagram: ClaudeReviewDiagram): string {
	return ['```mermaid', diagram.mermaid, '```'].join('\n');
}
