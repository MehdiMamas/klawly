/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { PlanArtifact } from '../../../../platform/claude/common/claudePlan.js';
import { ClaudeGitHubReference } from '../../../../platform/claude/common/claudeProtocol.js';
import { AnsiStyle, ClaudeStatusLineSegment, parseAnsiLine } from '../../../../platform/claude/common/claudeStatusLine.js';
import { ElicitationEntry, PermissionEntry, permissionsForTimeline, SubagentViewModel, TurnPart, TurnPlanPart, TurnTextPart, TurnThinkingPart, turnParts, TurnViewModel } from '../../../services/claude/common/claudeAgentState.js';
import { formatElapsed, ToolCardModel } from '../../../services/claude/common/claudeToolCards.js';
import { ClaudeDelegateCard } from '../../../services/claude/common/claudeDelegationModel.js';

/**
 * One keyed block of a painted turn, in order. The renderer keeps a block's
 * DOM while its model is the same object, so a finished block is never
 * rebuilt by later events.
 */
export type TimelineBlock =
	| { readonly kind: 'text'; readonly key: string; readonly part: TurnTextPart; readonly caret: boolean }
	/** A Plan-mode answer that is still streaming. It shows as a plan skeleton, not raw Markdown. */
	| { readonly kind: 'planDraft'; readonly key: string; readonly part: TurnTextPart }
	| { readonly kind: 'plan'; readonly key: string; readonly part: TurnPlanPart; readonly plan: PlanArtifact }
	/** Claude's thinking, as one quiet line. `live` while it still streams in a running turn. */
	| { readonly kind: 'thinking'; readonly key: string; readonly part: TurnThinkingPart; readonly live: boolean }
	| { readonly kind: 'tool'; readonly key: string; readonly card: ToolCardModel }
	/** Consecutive finished reads, shown as one "Read N files" row. */
	| { readonly kind: 'reads'; readonly key: string; readonly cards: readonly ToolCardModel[] }
	/** Subagents started one after another, shown as one group. */
	| { readonly kind: 'subagents'; readonly key: string; readonly subagents: readonly SubagentViewModel[] }
	| { readonly kind: 'permission'; readonly key: string; readonly entry: PermissionEntry }
	/** A pull request or issue Claude linked or opened (issue 430). It never folds into the work. */
	| { readonly kind: 'github'; readonly key: string; readonly reference: ClaudeGitHubReference }
	/** An MCP form or sign-in (issue 428), in the permission card family. */
	| { readonly kind: 'elicitation'; readonly key: string; readonly entry: ElicitationEntry }
	/** A delegated chat (issue 693). It carries the answer, so it never folds into the work. */
	| { readonly kind: 'delegate'; readonly key: string; readonly card: ClaudeDelegateCard };

/**
 * The blocks of `turn` in event order. Permission requests from a subagent
 * follow that subagent's card. Requests that belong to no shown part come last.
 * `subagents` is every subagent of the session; `focusRunId` is set when the
 * pane shows one subagent's chat.
 */
export function timelineBlocks(turn: TurnViewModel, subagents: readonly SubagentViewModel[], focusRunId: string | undefined): TimelineBlock[] {
	const parts = turnParts(turn);
	const cards = new Map(turn.cards.map(card => [card.id, card]));
	const questionIds = new Set(turn.elicitations?.filter(entry => entry.mode === 'question').map(entry => entry.id));
	const runs = new Map(subagents.map(subagent => [subagent.run.id, subagent]));
	const permissions = permissionsForTimeline(turn, subagents, focusRunId);
	const byId = new Map(permissions.map(entry => [entry.id, entry]));
	const placed = new Set<string>();
	const blocks: TimelineBlock[] = [];
	const planMode = turn.user.sent?.mode === 'plan';
	const lastIndex = lastVisibleIndex(parts);

	const placePermission = (entry: PermissionEntry | undefined) => {
		if (entry && !placed.has(entry.id)) {
			placed.add(entry.id);
			blocks.push({ kind: 'permission', key: `permission:${entry.id}`, entry });
		}
	};
	const placeSubagents = (group: SubagentViewModel[]) => {
		blocks.push({ kind: 'subagents', key: `subagents:${group[0].run.id}`, subagents: group });
		for (const subagent of group) {
			for (const member of [subagent, ...descendants(subagent.run.id, subagents)]) {
				for (const entry of member.chat.permissions) {
					placePermission(byId.get(entry.id));
				}
			}
		}
	};

	let reads: ToolCardModel[] = [];
	let group: SubagentViewModel[] = [];
	const flushReads = () => {
		if (reads.length === 1) {
			blocks.push({ kind: 'tool', key: `tool:${reads[0].id}`, card: reads[0] });
		} else if (reads.length > 1) {
			blocks.push({ kind: 'reads', key: `reads:${reads[0].id}`, cards: reads });
		}
		reads = [];
	};
	const flushGroup = () => {
		if (group.length > 0) {
			placeSubagents(group);
		}
		group = [];
	};

	parts.forEach((part, index) => {
		if (part.kind !== 'tool') {
			flushReads();
		}
		if (part.kind !== 'subagent') {
			flushGroup();
		}
		switch (part.kind) {
			case 'text':
				if (part.text.trim().length === 0) {
					return;
				}
				if (planMode && turn.status === 'running' && index === lastIndex && looksLikePlan(part.text)) {
					blocks.push({ kind: 'planDraft', key: `text:${part.id}`, part });
				} else {
					blocks.push({ kind: 'text', key: `text:${part.id}`, part, caret: part.open && turn.status === 'running' && index === lastIndex });
				}
				return;
			case 'plan':
				if (turn.plan && turn.status === 'complete') {
					blocks.push({ kind: 'plan', key: `plan:${part.id}`, part, plan: turn.plan });
				} else if (part.text.trim()) {
					blocks.push({ kind: 'text', key: `text:${part.id}`, part: { kind: 'text', id: part.id, text: part.text, open: false, completed: true }, caret: false });
				}
				return;
			case 'thinking':
				blocks.push({ kind: 'thinking', key: `thinking:${part.id}`, part, live: part.open && turn.status === 'running' });
				return;
			case 'tool': {
				const card = cards.get(part.id);
				// A question from Claude is drawn by its question card, not as a tool row (issue 477).
				if (!card || questionIds.has(card.id)) {
					return;
				}
				if (card.kind === 'file' && card.state === 'success') {
					reads.push(card);
					return;
				}
				flushReads();
				blocks.push({ kind: 'tool', key: `tool:${card.id}`, card });
				return;
			}
			case 'subagent': {
				const subagent = runs.get(part.id);
				if (!subagent) {
					return;
				}
				if (group.length > 0 && group[0].groupId !== subagent.groupId) {
					flushGroup();
				}
				group.push(subagent);
				return;
			}
			case 'permission':
				placePermission(byId.get(part.id));
				return;
			case 'github':
				blocks.push({ kind: 'github', key: `github:${part.id}`, reference: part.reference });
				return;
			case 'elicitation': {
				const entry = turn.elicitations?.find(candidate => candidate.id === part.id);
				if (entry) {
					blocks.push({ kind: 'elicitation', key: `elicitation:${entry.id}`, entry });
				}
				return;
			}
			case 'delegate': {
				const card = turn.delegates?.find(candidate => candidate.id === part.id);
				if (card) {
					blocks.push({ kind: 'delegate', key: `delegate:${card.id}`, card });
				}
				return;
			}
		}
	});
	flushReads();
	flushGroup();
	if (!turn.parts) {
		// Built without parts: subagents of the turn follow its tools, as before parts existed.
		const legacy = subagents.filter(subagent => focusRunId ? subagent.run.parentRunId === focusRunId : subagent.parentTurnId === turn.id && subagent.run.parentRunId === undefined);
		if (legacy.length > 0) {
			placeSubagents(legacy);
		}
	}
	for (const entry of permissions) {
		placePermission(entry);
	}
	return blocks;
}

function lastVisibleIndex(parts: readonly TurnPart[]): number {
	for (let index = parts.length - 1; index >= 0; index--) {
		const part = parts[index];
		if (part.kind !== 'text' || part.text.trim().length > 0) {
			return index;
		}
	}
	return -1;
}

function descendants(runId: string, subagents: readonly SubagentViewModel[]): SubagentViewModel[] {
	const children = subagents.filter(subagent => subagent.run.parentRunId === runId);
	return [...children, ...children.flatMap(child => descendants(child.run.id, subagents))];
}

/** True when streamed Plan-mode text has started its list of steps. */
export function looksLikePlan(text: string): boolean {
	return /^\s*(?:[-*+]|\d+[.)])\s+\S/m.test(text);
}

/**
 * What shows the turn is alive. Streaming text has its caret; a running tool,
 * a running subagent and a pending permission card show their own state. The
 * activity line only shows when none of those is on screen.
 */
export function showsProgress(blocks: readonly TimelineBlock[]): boolean {
	return blocks.some(block => {
		switch (block.kind) {
			case 'text': return block.caret;
			case 'planDraft': return true;
			case 'thinking': return block.live;
			case 'tool': return block.card.state === 'running';
			case 'subagents': return block.subagents.some(subagent => subagent.run.state === 'running');
			case 'permission': return block.entry.state === 'pending';
			case 'elicitation': return block.entry.state === 'pending';
			case 'delegate': return block.card.state === 'running';
			default: return false;
		}
	});
}

/**
 * How a finished turn folds: the work blocks (tools, reads, subagents,
 * permissions and the narration between them) go under one "Worked for" line,
 * and the answer after the last tool stays in view. `work` is empty when the
 * turn is not complete or did no work, and then nothing folds.
 */
export function turnWork(turn: TurnViewModel, blocks: readonly TimelineBlock[]): { readonly work: readonly string[]; readonly answer: readonly TurnTextPart[] } {
	if (turn.status !== 'complete') {
		return { work: [], answer: [] };
	}
	let last = -1;
	blocks.forEach((block, index) => {
		// Thinking is not a step: thinking before the answer stays in view with it.
		if (block.kind !== 'text' && block.kind !== 'plan' && block.kind !== 'planDraft' && block.kind !== 'thinking' && block.kind !== 'github' && block.kind !== 'delegate') {
			last = index;
		}
	});
	const answer = blocks.slice(last + 1).flatMap(block => block.kind === 'text' ? [block.part] : []);
	// A pull request or issue card stays in view with the answer, and so does a delegated chat's card (issue 693).
	return { work: blocks.slice(0, last + 1).filter(block => block.kind !== 'github' && block.kind !== 'delegate').map(block => block.key), answer };
}

/** "Worked for 5s", or the step count when the turn was not timed. */
export function describeWork(turn: TurnViewModel, steps: number): string {
	if (turn.startedAt !== undefined && turn.endedAt !== undefined) {
		return localize('claudeWorkedFor', "Worked for {0}", formatElapsed(turn.startedAt, turn.endedAt, turn.endedAt));
	}
	return steps === 1 ? localize('claudeWorkedStep', "1 step") : localize('claudeWorkedSteps', "{0} steps", steps);
}

/** True once the turn has written a file: a write tool that succeeded, or a write the runtime reported. Its checkpoint then has something to put back. */
export function turnWroteFiles(turn: TurnViewModel): boolean {
	return turn.changedFiles.length > 0 || turn.cards.some(card => card.category === 'write' && card.state === 'success');
}

/**
 * "Thinking", then "Thought for 4s", or "Thought for a moment" under a second.
 * When the runtime omits the thinking text, its token estimate keeps the row
 * from reading empty: "Thinking · 208 tokens" (issue 740).
 */
export function describeThinking(part: TurnThinkingPart, live: boolean): string {
	const label = live
		? localize('claudeThinking', "Thinking")
		: part.lastAt - part.startedAt < 1000
			? localize('claudeThoughtMoment', "Thought for a moment")
			: localize('claudeThoughtFor', "Thought for {0}", formatElapsed(part.startedAt, part.lastAt, part.lastAt));
	if (!part.tokens || part.text.trim().length > 0) {
		return label;
	}
	return part.tokens === 1
		? localize('claudeThinkingToken', "{0} · 1 token", label)
		: localize('claudeThinkingTokens', "{0} · {1} tokens", label, part.tokens.toLocaleString());
}

/** "1 tool · 4s", with a localized plural. */
export function describeSubagentMeta(toolCount: number, elapsed: string, quiet?: string): string {
	const base = toolCount === 1
		? localize('claudeSubagentMetaOne', "1 tool · {0}", elapsed)
		: localize('claudeSubagentMetaMany', "{0} tools · {1}", toolCount, elapsed);
	// A running row says how long it has been silent, so stuck and busy look different (issue 1258).
	return quiet ? localize('claudeSubagentMetaQuiet', "{0} · last output {1} ago", base, quiet) : base;
}

/** Below this, a running subagent or command counts as busy and its row shows no "last output" time. */
export const QUIET_AFTER_MS = 10_000;

/** "12s" once a running row has been silent for {@link QUIET_AFTER_MS}, else undefined. */
export function describeQuiet(lastOutputAt: number, now: number): string | undefined {
	return now - lastOutputAt >= QUIET_AFTER_MS ? formatElapsed(lastOutputAt, undefined, now) : undefined;
}

/** "4 steps · 1 file", with localized plurals. */
export function describePlanSize(plan: PlanArtifact): string {
	const fileCount = new Set(plan.steps.flatMap(step => step.files ?? [])).size;
	const steps = plan.steps.length === 1
		? localize('claudePlanOneStep', "1 step")
		: localize('claudePlanSteps', "{0} steps", plan.steps.length);
	if (fileCount === 0) {
		return steps;
	}
	const files = fileCount === 1
		? localize('claudePlanOneFile', "1 file")
		: localize('claudePlanFiles', "{0} files", fileCount);
	return localize('claudePlanSizeJoin', "{0} · {1}", steps, files);
}

/** One run of inline Markdown in a plan step title: plain text, `code` or **strong**. */
export interface InlineRun {
	readonly kind: 'text' | 'code' | 'strong';
	readonly text: string;
}

/**
 * Splits a step title into inline runs. Only code spans and strong text are
 * kept; everything is shown as text, never as HTML.
 */
export function inlineMarkdownRuns(source: string): InlineRun[] {
	const runs: InlineRun[] = [];
	const pattern = /`(?<code>[^`]+)`|\*\*(?<strong>[^*]+)\*\*/g;
	let cursor = 0;
	for (const match of source.matchAll(pattern)) {
		const start = match.index ?? 0;
		if (start > cursor) {
			runs.push({ kind: 'text', text: source.slice(cursor, start) });
		}
		const code = match.groups?.code;
		runs.push(code !== undefined ? { kind: 'code', text: code } : { kind: 'strong', text: match.groups?.strong ?? '' });
		cursor = start + match[0].length;
	}
	if (cursor < source.length) {
		runs.push({ kind: 'text', text: source.slice(cursor) });
	}
	return runs;
}

/** One file in a search result list, with the lines that matched in it. */
export interface SearchResultRow {
	readonly path: string;
	readonly lines: readonly number[];
	/** Matches in the file, for Grep's count output ("path:12"). */
	readonly count?: number;
}

/**
 * Groups Grep and Glob output lines into one row per file, in the order the
 * files first appear. Lines are "path:line:text", "path:line" or "path"
 * (files_with_matches and Glob). With `counts`, "path:N" is Grep's count
 * output: N matches, not line N. Summary lines such as "Found 3 files" are
 * skipped.
 */
export function searchResultRows(lines: readonly string[], counts = false): SearchResultRow[] {
	const rows = new Map<string, { lines: number[]; count?: number }>();
	for (const raw of lines) {
		const line = raw.trim();
		if (!line || /^(?:Found \d+ (?:files?|matches|match|lines?)\b|No (?:files|matches) found\b)/i.test(line)) {
			continue;
		}
		const match = /^(?<path>(?:[A-Za-z]:)?[^:]+?):(?<line>\d+)(?::|$)/.exec(line);
		const path = match?.groups?.path ?? line;
		const found = rows.get(path) ?? { lines: [] };
		const number = match?.groups?.line ? Number(match.groups.line) : undefined;
		if (number !== undefined && counts) {
			found.count = (found.count ?? 0) + number;
		} else if (number !== undefined && !found.lines.includes(number)) {
			found.lines.push(number);
		}
		rows.set(path, found);
	}
	return [...rows].map(([path, found]) => found.count !== undefined ? { path, lines: found.lines, count: found.count } : { path, lines: found.lines });
}

/** "1 match" or "12 matches", with a localized plural. */
export function describeMatchCount(count: number): string {
	return count === 1
		? localize('claudeSearchMatchOne', "1 match")
		: localize('claudeSearchMatchMany', "{0} matches", count);
}

/**
 * `path` relative to the workspace folder that holds it, with / separators,
 * or the normalized path when no folder holds it. Paths compare without case
 * unless `caseSensitive` (Linux).
 */
export function workspaceRelativePath(path: string, roots: readonly string[], caseSensitive: boolean): string {
	const normalized = path.replace(/\\/g, '/');
	const compare = (value: string) => caseSensitive ? value : value.toLowerCase();
	for (const folder of roots) {
		const root = folder.replace(/\\/g, '/').replace(/\/$/, '');
		if (compare(normalized).startsWith(compare(`${root}/`))) {
			return normalized.slice(root.length + 1);
		}
	}
	return normalized;
}

/** The folder shown next to a file name: workspace-relative, and empty for a drive or file system root. */
export function workspaceRelativeFolder(folder: string, roots: readonly string[], caseSensitive: boolean): string {
	const relative = workspaceRelativePath(folder, roots, caseSensitive);
	const root = roots.some(candidate => {
		const normalized = candidate.replace(/\\/g, '/').replace(/\/$/, '');
		return caseSensitive ? normalized === relative : normalized.toLowerCase() === relative.toLowerCase();
	});
	return root || /^[A-Za-z]:\/?$|^\/$/.test(relative) ? '' : relative;
}

/** The file name and its folder, for "name  folder" rows. Works with / and \ separators. */
export function splitPath(path: string): { readonly name: string; readonly folder: string } {
	const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
	const slash = normalized.lastIndexOf('/');
	return slash < 0 ? { name: normalized, folder: '' } : { name: normalized.slice(slash + 1), folder: normalized.slice(0, slash) };
}

/** A hunk as the mini-diff needs it. Line numbers are 1-based. */
export interface MiniDiffHunk {
	readonly originalStart: number;
	readonly originalLength: number;
	readonly modifiedStart: number;
	readonly modifiedLength: number;
	readonly originalText: string;
	readonly modifiedText: string;
}

export interface MiniDiffRow {
	readonly kind: 'fold' | 'ctx' | 'ins' | 'del';
	/** Line number in the changed file. Unset for removed lines and folds. */
	readonly line?: number;
	readonly text: string;
	/** For a fold: how many lines it stands for. */
	readonly count?: number;
}

/**
 * Rows for a collapsed diff of one file: one context line around each hunk,
 * folds for the unchanged lines between, and at most `maxRows` changed or
 * context rows before a final fold.
 */
export function miniDiffRows(originalText: string, hunks: readonly MiniDiffHunk[], maxRows = 12): MiniDiffRow[] {
	const original = originalText.length > 0 ? originalText.split('\n') : [];
	const rows: MiniDiffRow[] = [];
	let shown = 0;
	let hidden = 0;
	let nextOriginal = 1;
	const push = (row: MiniDiffRow) => {
		if (shown >= maxRows) {
			hidden++;
			return;
		}
		shown++;
		rows.push(row);
	};
	for (const hunk of hunks) {
		const before = hunk.originalStart - 1;
		const contextStart = Math.max(nextOriginal, before);
		const skipped = contextStart - nextOriginal;
		if (skipped > 0 && shown < maxRows) {
			rows.push({ kind: 'fold', text: '', count: skipped });
		}
		if (before >= nextOriginal && before >= 1 && before <= original.length) {
			push({ kind: 'ctx', line: hunk.modifiedStart - 1, text: original[before - 1] });
		}
		// An empty original (a new file) has nothing to remove.
		for (const text of hunkLines(hunk.originalText, original.length > 0 ? hunk.originalLength : 0)) {
			push({ kind: 'del', text });
		}
		hunkLines(hunk.modifiedText, hunk.modifiedLength).forEach((text, offset) => push({ kind: 'ins', line: hunk.modifiedStart + offset, text }));
		const after = hunk.originalStart + hunk.originalLength;
		if (after <= original.length) {
			push({ kind: 'ctx', line: hunk.modifiedStart + hunk.modifiedLength, text: original[after - 1] });
			nextOriginal = after + 1;
		} else {
			nextOriginal = after;
		}
	}
	if (hidden > 0) {
		rows.push({ kind: 'fold', text: '', count: hidden });
	}
	return rows;
}

/**
 * The lines of a hunk side. Its text spans whole lines, so it carries one
 * line break at its end, or at its start when the hunk ends the file.
 */
function hunkLines(text: string, count: number): string[] {
	if (count <= 0) {
		return [];
	}
	const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text.startsWith('\n') ? text.slice(1) : text;
	return trimmed.split('\n').slice(0, count);
}

/**
 * The review file an edit card changed. Cards show a workspace-relative or
 * absolute path; review files have URIs. Matches on whole path segments.
 */
export function matchesCardFile(uriPath: string, cardFile: string | undefined): boolean {
	if (!cardFile) {
		return false;
	}
	const file = cardFile.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
	const path = uriPath.replace(/\\/g, '/').toLowerCase();
	return path === file || path.endsWith(`/${file.replace(/^\/+/, '')}`);
}

/** One row of command output: its text in runs of the same ANSI style. */
export type OutputRow = readonly ClaudeStatusLineSegment[];

/**
 * Soft-wraps command output into rows of at most `columns` characters, so a
 * virtualized preview can keep one fixed row height. ANSI color codes become
 * styled runs and carry across lines, as in a terminal (issue 745); they never
 * count toward the width. Tabs become four spaces. With `columns` 0 (not laid
 * out yet) every line is one row.
 */
export function outputRows(lines: readonly string[], columns: number): readonly OutputRow[] {
	const rows: OutputRow[] = [];
	let style: AnsiStyle = {};
	for (const raw of lines) {
		const line = raw.replace(/\t/g, '    ');
		let segments: readonly ClaudeStatusLineSegment[];
		if (line.includes('\u001b')) {
			const parsed = parseAnsiLine(line, style);
			segments = parsed.segments;
			style = parsed.style;
		} else {
			segments = line ? [{ text: line, ...style }] : [];
		}
		let row: ClaudeStatusLineSegment[] = [];
		let width = 0;
		for (const segment of segments) {
			let text = segment.text;
			while (columns > 0 && width + text.length > columns) {
				const fits = columns - width;
				if (fits > 0) {
					row.push({ ...segment, text: text.slice(0, fits) });
				}
				rows.push(row);
				row = [];
				width = 0;
				text = text.slice(fits);
			}
			if (text) {
				row.push({ ...segment, text });
				width += text.length;
			}
		}
		if (row.length > 0 || width === 0) {
			rows.push(row);
		}
	}
	return rows;
}

/** Output lines a running command card shows: the tail of its log. */
export const COMMAND_TAIL_LINES = 5;

/**
 * Output lines a command card does not show, for "… N earlier lines hidden".
 * Lines past the kept preview always count. A running command shows only its
 * last {@link COMMAND_TAIL_LINES} lines, so the kept lines above them count too;
 * an opened finished command scrolls through every kept line.
 */
export function hiddenCommandLines(card: Pick<ToolCardModel, 'state' | 'lines' | 'droppedLines'>): number {
	const lines = card.lines.length > 0 && card.lines[card.lines.length - 1] === '' ? card.lines.length - 1 : card.lines.length;
	const aboveTail = card.state === 'running' ? Math.max(0, lines - COMMAND_TAIL_LINES) : 0;
	return card.droppedLines + aboveTail;
}

/** Exit code text for a command card, "exit 2". */
export function describeExit(exitCode: number): string {
	return localize('claudeExitMeta', "exit {0}", exitCode);
}
