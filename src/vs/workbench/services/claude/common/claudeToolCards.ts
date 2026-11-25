/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { evaluateToolPolicy, ToolPolicyContext } from '../../../../platform/claude/common/claudeToolPolicy.js';
import { ToolCall, ToolCategory, ToolResult, ToolResultImage } from '../../../../platform/claude/common/claudeProtocol.js';
import { redactSecrets } from './claudeAgentLog.js';

/** Preview lines kept on a command card. Older lines are counted, not stored. */
export const COMMAND_OUTPUT_LINE_CAP = 200;

export const COMMAND_OUTPUT_LINE_HEIGHT = 17;

export type ToolCardState = 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted';

export type ToolCardKind = 'file' | 'search' | 'edit' | 'command' | 'skill' | 'mcp' | 'web' | 'generic';

/**
 * One tool call in the timeline. Fields are a safe summary: raw tool input is
 * not stored. `lines` is the retained tail of command output.
 */
export interface ToolCardModel {
	readonly id: string;
	readonly name: string;
	readonly category: ToolCategory;
	readonly kind: ToolCardKind;
	readonly label: string;
	readonly verb: string;
	readonly target: string;
	readonly meta?: string;
	readonly file?: string;
	readonly query?: string;
	readonly command?: string;
	/** What a command does, in Claude's words (the Bash tool's `description`), redacted (issue 745). */
	readonly description?: string;
	readonly cwd?: string;
	readonly range?: string;
	readonly count?: number;
	readonly exitCode?: number;
	readonly lines: readonly string[];
	readonly droppedLines: number;
	/** Redacted characters already applied, including lines the card has dropped. */
	readonly streamedChars: number;
	readonly state: ToolCardState;
	readonly error?: string;
	readonly provider?: string;
	/** Set for edits until review accepts or rejects them. */
	readonly review?: 'pending';
	/** Grep ran with `output_mode: "count"`: each output line is "path:matches". */
	readonly countsMatches?: boolean;
	/** An MCP tool's input, which an MCP App the tool draws reads (issue 513). */
	readonly mcpInput?: Readonly<Record<string, unknown>>;
	/** An MCP tool's images and `structuredContent`, once the call ended (issue 897). */
	readonly mcpImages?: readonly ToolResultImage[];
	readonly mcpStructured?: Readonly<Record<string, unknown>>;
	/** Set for a NotebookEdit call: the cell it changed (issue 526). */
	readonly notebook?: NotebookCellEdit;
}

/** Source lines a notebook cell card keeps. Later lines are counted, not stored. */
export const NOTEBOOK_PREVIEW_LINE_CAP = 12;

/**
 * One NotebookEdit call as a cell card shows it: the cell, its type, and the
 * first lines of its new source, with secrets redacted.
 */
export interface NotebookCellEdit {
	readonly mode: 'replace' | 'insert' | 'delete';
	readonly cellType?: 'code' | 'markdown';
	/** The cell id Claude named, or its number in older tool versions. */
	readonly cell?: string;
	readonly lines: readonly string[];
	readonly droppedLines: number;
}

/** Reads a NotebookEdit input. Any other tool, or an input with no notebook path, has no cell. */
export function notebookCellEdit(name: string, input: unknown): NotebookCellEdit | undefined {
	if (name !== 'NotebookEdit' || !isRecord(input) || !stringField(input, 'notebook_path')) {
		return undefined;
	}
	const editMode = stringField(input, 'edit_mode');
	const mode = editMode === 'insert' || editMode === 'delete' ? editMode : 'replace';
	const type = stringField(input, 'cell_type');
	const cellNumber = numberField(input, 'cell_number');
	const cell = stringField(input, 'cell_id') ?? (cellNumber !== undefined ? String(cellNumber) : undefined);
	const source = mode === 'delete' ? '' : redactSecrets(typeof input.new_source === 'string' ? input.new_source : '');
	const all = source.length > 0 ? source.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n') : [];
	return {
		mode,
		cellType: type === 'code' || type === 'markdown' ? type : undefined,
		cell,
		lines: all.slice(0, NOTEBOOK_PREVIEW_LINE_CAP),
		droppedLines: Math.max(0, all.length - NOTEBOOK_PREVIEW_LINE_CAP),
	};
}

/** The row's meta for a cell card: "New Markdown cell", "Cell 3", "Deleted cell 3". */
export function describeNotebookCellEdit(edit: NotebookCellEdit): string {
	switch (edit.mode) {
		case 'insert':
			return edit.cellType === 'markdown' ? localize('claudeNotebookNewMarkdownCell', "New Markdown cell")
				: edit.cellType === 'code' ? localize('claudeNotebookNewCodeCell', "New code cell")
					: localize('claudeNotebookNewCell', "New cell");
		case 'delete':
			return edit.cell ? localize('claudeNotebookDeletedCellNamed', "Deleted cell {0}", edit.cell) : localize('claudeNotebookDeletedCell', "Deleted cell");
		default:
			return edit.cell ? localize('claudeNotebookCellNamed', "Cell {0}", edit.cell) : localize('claudeNotebookCell', "Cell");
	}
}

export function projectToolCard(call: ToolCall): ToolCardModel {
	const input = isRecord(call.input) ? call.input : {};
	const kind = kindFor(call.category);
	const file = call.display.file;
	const query = call.display.query;
	const command = call.display.command ?? stringField(input, 'command');
	const cwd = stringField(input, 'cwd') ?? stringField(input, 'working_directory');
	const range = readRange(input);
	const provider = kind === 'mcp' ? mcpProvider(call.name) : undefined;
	const target = cardTarget(kind, call, file, query, command, input, provider);
	const notebook = kind === 'edit' ? notebookCellEdit(call.name, input) : undefined;
	const description = kind === 'command' ? stringField(input, 'description')?.trim() : undefined;
	return {
		id: call.id,
		name: call.name,
		category: call.category,
		kind,
		label: call.display.label,
		verb: verbFor(kind, call.name, 'running'),
		target,
		meta: notebook ? describeNotebookCellEdit(notebook) : range,
		file,
		query,
		command,
		...(description ? { description: redactSecrets(description) } : {}),
		cwd,
		range,
		lines: [],
		droppedLines: 0,
		streamedChars: 0,
		state: 'running',
		provider,
		review: kind === 'edit' ? 'pending' : undefined,
		countsMatches: kind === 'search' && stringField(input, 'output_mode') === 'count' ? true : undefined,
		...(kind === 'mcp' ? { mcpInput: input } : {}),
		notebook,
	};
}

/** The Agent tool is the subagent card, not a second generic row. */
export function isSubagentToolName(name: string): boolean {
	return name === 'Agent' || name === 'Task';
}

export function outputText(update: unknown): string {
	if (typeof update === 'string') {
		return update;
	}
	if (!isRecord(update)) {
		return '';
	}
	const parts = [update.stdout, update.stderr, update.output, update.text].filter((part): part is string => typeof part === 'string');
	return parts.join('');
}

export function appendCardOutput(card: ToolCardModel, text: string): ToolCardModel {
	if (!text) {
		return card;
	}
	const redacted = redactSecrets(text);
	const next = retainLines(card.lines, card.droppedLines, redacted);
	return { ...card, lines: next.lines, droppedLines: next.droppedLines, streamedChars: card.streamedChars + redacted.length };
}

/**
 * Text from a completion that was not already streamed.
 * `streamedChars` counts the redacted text already applied, including lines
 * the card dropped past the preview cap. The returned text is redacted.
 */
export function completedOutputDelta(lines: readonly string[], output: string | undefined, streamedChars = 0): string {
	if (!output) {
		return '';
	}
	const redacted = redactSecrets(output);
	const existing = lines.join('\n');
	if (streamedChars > 0) {
		const consumed = Math.min(streamedChars, redacted.length);
		const prefix = redacted.slice(0, consumed);
		if (existing.length === 0 || prefix.endsWith(existing)) {
			return redacted.slice(consumed);
		}
	}
	if (!existing) {
		return redacted;
	}
	if (redacted === existing || existing.endsWith(redacted)) {
		return '';
	}
	if (redacted.startsWith(existing)) {
		return redacted.slice(existing.length);
	}
	return redacted;
}

/** Remainder of a full command result after the redacted text already written to the log. */
export function unstreamedCommandOutput(streamedRedacted: string, output: string | undefined): string {
	if (!output) {
		return '';
	}
	const redacted = redactSecrets(output);
	if (!streamedRedacted) {
		return redacted;
	}
	if (redacted.startsWith(streamedRedacted)) {
		return redacted.slice(streamedRedacted.length);
	}
	if (redacted === streamedRedacted || streamedRedacted.endsWith(redacted)) {
		return '';
	}
	return redacted;
}

export interface CommandScrollState {
	readonly scrollTop: number;
	readonly follow: boolean;
}

/** Scroll offset for a command preview. A running card that is following stays on the tail. */
export function nextCommandScroll(scrollHeight: number, clientHeight: number, saved: CommandScrollState | undefined, running: boolean, userMoved: boolean, scrollTop: number): CommandScrollState {
	const max = Math.max(0, scrollHeight - clientHeight);
	if (userMoved) {
		const top = Math.min(Math.max(0, scrollTop), max);
		return { scrollTop: top, follow: running && max - top < 4 };
	}
	const follow = saved ? saved.follow && running : running;
	return { scrollTop: follow ? max : Math.min(saved?.scrollTop ?? 0, max), follow };
}

export function completeToolCard(card: ToolCardModel, result: ToolResult): ToolCardModel {
	const state: ToolCardState = result.ok ? 'success' : 'failed';
	const delta = completedOutputDelta(card.lines, result.output, card.streamedChars);
	const withOutput = delta ? appendCardOutput(card, delta) : card;
	const error = result.error ? redactSecrets(result.error) : undefined;
	const count = card.kind === 'search' ? countLines(withOutput.lines) : card.count;
	const exitCode = card.kind === 'command' ? readExitCode(result.ok, withOutput.lines, error) : undefined;
	const meta = metaFor(withOutput, state, count, exitCode, error);
	return {
		...withOutput,
		state,
		verb: verbFor(card.kind, card.name, state),
		error,
		count,
		exitCode,
		meta,
		...(card.kind === 'mcp' && result.images?.length ? { mcpImages: result.images } : {}),
		...(card.kind === 'mcp' && result.structuredContent ? { mcpStructured: result.structuredContent } : {}),
	};
}

export function retainLines(existing: readonly string[], dropped: number, text: string): { lines: string[]; droppedLines: number } {
	const incoming = redactSecrets(text).split(/\r?\n/);
	const lines = existing.length === 0 ? incoming : [...existing.slice(0, -1), (existing[existing.length - 1] ?? '') + (incoming[0] ?? ''), ...incoming.slice(1)];
	const overflow = lines.length - COMMAND_OUTPUT_LINE_CAP;
	if (overflow <= 0) {
		return { lines, droppedLines: dropped };
	}
	return { lines: lines.slice(overflow), droppedLines: dropped + overflow };
}

/** Inclusive line window for a scrollable preview. */
export function visibleLineWindow(lineCount: number, scrollTop: number, viewportPx: number, lineHeight: number): { start: number; end: number } {
	if (lineCount <= 0) {
		return { start: 0, end: 0 };
	}
	const height = lineHeight > 0 ? lineHeight : COMMAND_OUTPUT_LINE_HEIGHT;
	const start = Math.max(0, Math.min(lineCount - 1, Math.floor(Math.max(0, scrollTop) / height)));
	const visible = Math.max(1, Math.ceil(viewportPx / height));
	const end = Math.min(lineCount, start + visible);
	return { start, end };
}

/**
 * Re-run uses the same tool policy as a Claude Bash call. `confirm` runs only
 * when the policy asks. A denial does not run the command.
 */
export async function planCommandRerun(command: string, context: ToolPolicyContext, confirm: (why: string, command: string) => Promise<boolean>): Promise<{ readonly run: boolean; readonly reason: string }> {
	const result = await evaluateToolPolicy('Bash', { command }, context);
	if (result.behavior === 'deny') {
		return { run: false, reason: result.why };
	}
	if (result.behavior === 'ask') {
		return { run: await confirm(result.why, command), reason: result.why };
	}
	return { run: true, reason: result.why };
}

export function formatElapsed(startedAt: number, endedAt: number | undefined, now: number): string {
	const ms = Math.max(0, (endedAt ?? now) - startedAt);
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function kindFor(category: ToolCategory): ToolCardKind {
	switch (category) {
		case 'read': return 'file';
		case 'search': return 'search';
		case 'write': return 'edit';
		case 'shell': return 'command';
		case 'skill': return 'skill';
		case 'mcp': return 'mcp';
		case 'web': return 'web';
		default: return 'generic';
	}
}

function verbFor(kind: ToolCardKind, name: string, state: ToolCardState): string {
	if (state === 'failed') {
		switch (kind) {
			case 'file': return localize('claudeVerbReadFailed', "Read failed");
			case 'search': return localize('claudeVerbSearchFailed', "Search failed");
			case 'edit': return localize('claudeVerbEditFailed', "Edit failed");
			case 'command': return localize('claudeVerbCommandFailed', "Command failed");
			default: return localize('claudeVerbToolFailed', "{0} failed", name);
		}
	}
	if (state === 'running') {
		switch (kind) {
			case 'file': return localize('claudeVerbReading', "Reading");
			case 'search': return localize('claudeVerbSearching', "Searching");
			case 'edit': return localize('claudeVerbEditing', "Editing");
			case 'command': return localize('claudeVerbRunning', "Running");
			case 'web': return localize('claudeVerbFetching', "Fetching");
			default: return name;
		}
	}
	switch (kind) {
		case 'file': return localize('claudeVerbRead', "Read");
		case 'search': return name === 'Glob' ? 'Glob' : 'Grep';
		case 'edit': return name === 'Write' ? localize('claudeVerbWrote', "Wrote") : localize('claudeVerbEdited', "Edited");
		case 'command': return localize('claudeVerbRan', "Ran");
		case 'skill': return localize('claudeVerbSkill', "Skill");
		case 'mcp': return localize('claudeVerbMcp', "MCP");
		case 'web': return localize('claudeVerbFetched', "Fetched");
		default: return name;
	}
}

function cardTarget(kind: ToolCardKind, call: ToolCall, file: string | undefined, query: string | undefined, command: string | undefined, input: Record<string, unknown>, provider: string | undefined): string {
	switch (kind) {
		case 'file':
		case 'edit':
			return file ?? call.display.label;
		case 'search':
			return query ? `"${query}"` : call.display.label;
		case 'command':
			return command ?? call.display.label;
		case 'web':
			return stringField(input, 'url') ?? stringField(input, 'query') ?? call.display.label;
		case 'skill':
			return stringField(input, 'skill') ?? stringField(input, 'name') ?? call.display.label;
		case 'mcp': {
			const tool = mcpTool(call.name);
			const subject = stringField(input, 'id') ?? stringField(input, 'issue') ?? query ?? file;
			const head = provider ? `${provider}` : call.name;
			return subject ? `${head} | ${tool ?? ''} ${subject}`.replace(/\s+/g, ' ').trim() : (tool ? `${head} | ${tool}` : call.display.label);
		}
		default:
			return call.display.label || call.name;
	}
}

function metaFor(card: ToolCardModel, state: ToolCardState, count: number | undefined, exitCode: number | undefined, error: string | undefined): string | undefined {
	if (card.kind === 'search' && count !== undefined) {
		return count === 1 ? localize('claudeSearchOne', "1 result") : localize('claudeSearchMany', "{0} results", count);
	}
	if (card.kind === 'command' && exitCode !== undefined) {
		return localize('claudeExitCode', "exit {0}", exitCode);
	}
	if (state === 'failed' && error) {
		return error.length > 80 ? `${error.slice(0, 80)}...` : error;
	}
	return card.range ?? card.meta;
}

function readExitCode(ok: boolean, lines: readonly string[], error: string | undefined): number | undefined {
	const tail = lines.slice(-8);
	for (let index = tail.length - 1; index >= 0; index--) {
		const match = /^\s*exit(?:\s+code)?\s*[:=]?\s*(\d+)\s*$/i.exec(tail[index]);
		if (match) {
			return Number(match[1]);
		}
	}
	// A failed Bash call reports "... with exit code 2" in its error, not in the output.
	const reported = error ? /\bexit(?:\s+code)?\s*[:=]?\s*(?<code>\d+)\b/i.exec(error) : null;
	if (reported?.groups?.code) {
		return Number(reported.groups.code);
	}
	return ok ? 0 : undefined;
}

function readRange(input: Record<string, unknown>): string | undefined {
	const offset = numberField(input, 'offset') ?? numberField(input, 'start_line');
	const limit = numberField(input, 'limit');
	if (offset === undefined) {
		return undefined;
	}
	if (limit === undefined || limit <= 1) {
		return localize('claudeLineMeta', "L{0}", offset);
	}
	return localize('claudeLineRange', "L{0}-{1}", offset, offset + limit - 1);
}

function countLines(lines: readonly string[]): number {
	return lines.filter(line => line.trim().length > 0).length;
}

function mcpProvider(name: string): string | undefined {
	const parts = name.split('__');
	return parts.length >= 3 ? parts[1] : undefined;
}

function mcpTool(name: string): string | undefined {
	const parts = name.split('__');
	return parts.length >= 3 ? parts.slice(2).join('__') : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}
