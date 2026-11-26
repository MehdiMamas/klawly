/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { LcsDiff } from '../../../base/common/diff/diff.js';
import { ClaudeEvent, IClaudeTranscriptMessage } from './claudeRuntime.js';

export type ClaudeToolStatus = 'running' | 'done' | 'failed';
export type ClaudePermissionState = 'pending' | 'allowed' | 'denied';

export interface IClaudeTextItem {
	readonly kind: 'user' | 'assistant';
	/** Markdown for assistant messages; plain text for user messages. */
	text: string;
	/** Files attached to a user message, shown as chips under it (v5-S13). */
	readonly files?: readonly string[];
}

/** One tool call as a collapsed row that can expand to its output (v5-S12, VC12). */
export interface IClaudeToolItem {
	readonly kind: 'tool';
	readonly id: string;
	readonly name: string;
	/** What the tool acts on, for example `total.ts` or `npm test`. */
	readonly target: string;
	readonly input: Record<string, unknown>;
	/** When the call started, for the running-time pill of v5-S12. */
	readonly startedAt: number;
	status: ClaudeToolStatus;
	output?: string;
}

/** The permission card of v5-S13. */
export interface IClaudePermissionItem {
	readonly kind: 'permission';
	readonly sessionId: string;
	readonly requestId: string;
	readonly toolName: string;
	readonly target: string;
	readonly input: Record<string, unknown>;
	readonly description?: string;
	state: ClaudePermissionState;
}

/** Marks where the person stopped the turn (Stop button or Esc). */
export interface IClaudeStoppedItem {
	readonly kind: 'stopped';
}

export type ClaudeItem = IClaudeTextItem | IClaudeToolItem | IClaudePermissionItem | IClaudeStoppedItem;

/** Lines added and removed in one file, summed over the turn (the changes bar of v5-S19, VC09). */
export interface IClaudeFileChange {
	readonly path: string;
	added: number;
	removed: number;
}

/** A state the chat is stuck in until something outside it changes (v5-S35 limit, S36 offline, S37 crash). */
export type ClaudeEdge =
	/** `resetsAt` in milliseconds since the epoch, when the CLI gave one. */
	| { readonly kind: 'limited'; readonly resetsAt?: number }
	| { readonly kind: 'offline' }
	| { readonly kind: 'crashed'; readonly exitCode: number; readonly at: number };

/** Reads the usage-limit and network wording of the CLI's error text; `undefined` for any other error. */
export function claudeClassifyError(text: string): ClaudeEdge | undefined {
	if (/usage limit|hit your limit|limit reached|rate limit/i.test(text)) {
		// older CLIs end the line with `|<epoch seconds>`
		const reset = /\|(\d{10})\b/.exec(text);
		return { kind: 'limited', resetsAt: reset ? Number(reset[1]) * 1000 : undefined };
	}
	if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|unable to connect|fetch failed|network error|socket hang up|connection error/i.test(text)) {
		return { kind: 'offline' };
	}
	return undefined;
}

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

/** The tool input field that names what a tool acts on, so a row reads as "Edit total.ts" (v5-S12, D17). */
export function claudeToolTarget(input: Record<string, unknown>): string {
	const value = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? '';
	const text = typeof value === 'string' ? value : '';
	return text.split('\n')[0];
}

/** The right-aligned result of a tool row (v5-S12): `L1–12`, `3 matches`, or `+3 −2`. */
export interface IClaudeToolSummary {
	readonly text?: string;
	readonly added?: number;
	readonly removed?: number;
}

function linesOf(output: string | undefined): number {
	return output ? output.split('\n').filter(line => line.trim()).length : 0;
}

export function claudeToolSummary(tool: IClaudeToolItem): IClaudeToolSummary | undefined {
	if (tool.status === 'running') {
		return undefined;
	}
	const input = tool.input;
	switch (tool.name) {
		case 'Read': {
			const from = typeof input.offset === 'number' ? input.offset : 1;
			const count = typeof input.limit === 'number' ? input.limit : linesOf(tool.output);
			return count ? { text: `L${from}–${from + count - 1}` } : undefined;
		}
		case 'Grep':
		case 'Glob': {
			const count = tool.output?.startsWith('No ') ? 0 : linesOf(tool.output);
			return { text: count === 1 ? '1 match' : `${count} matches` };
		}
		case 'Edit':
		case 'MultiEdit':
		case 'Write': {
			const change = claudeFileChange(tool.name, input);
			return { added: change.added, removed: change.removed };
		}
		default:
			return undefined;
	}
}

/** One line of an edit: removed, added, or unchanged context. */
export interface IClaudeDiffLine {
	readonly sign: '+' | '-' | ' ';
	readonly text: string;
}

function textLines(text: unknown): string[] {
	return typeof text === 'string' && text.length > 0 ? text.replace(/\n$/, '').split('\n') : [];
}

/** A real line diff (the editor's LCS diff), so a line that stays is not shown as removed and added again. */
function diffRows(before: unknown, after: unknown): IClaudeDiffLine[] {
	const a = textLines(before);
	const b = textLines(after);
	const rows: IClaudeDiffLine[] = [];
	let at = 0;
	for (const change of new LcsDiff({ getElements: () => a }, { getElements: () => b }).ComputeDiff(false).changes) {
		for (; at < change.originalStart; at++) {
			rows.push({ sign: ' ', text: a[at] });
		}
		for (let i = 0; i < change.originalLength; i++) {
			rows.push({ sign: '-', text: a[change.originalStart + i] });
		}
		for (let i = 0; i < change.modifiedLength; i++) {
			rows.push({ sign: '+', text: b[change.modifiedStart + i] });
		}
		at = change.originalStart + change.originalLength;
	}
	for (; at < a.length; at++) {
		rows.push({ sign: ' ', text: a[at] });
	}
	return rows;
}

/** The lines an Edit, MultiEdit or Write changes, for the expanded tool row. */
export function claudeDiffLines(toolName: string, input: Record<string, unknown>): IClaudeDiffLine[] {
	if (toolName === 'Write') {
		return textLines(input.content).map(text => ({ sign: '+', text }));
	}
	if (toolName === 'Edit') {
		return diffRows(input.old_string, input.new_string);
	}
	return Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]).flatMap(edit => diffRows(edit?.old_string, edit?.new_string)) : [];
}

function claudeFileChange(toolName: string, input: Record<string, unknown>): { added: number; removed: number } {
	const lines = claudeDiffLines(toolName, input);
	return { added: lines.filter(l => l.sign === '+').length, removed: lines.filter(l => l.sign === '-').length };
}

/** A question the agent asks with the AskUserQuestion tool: the first question and its answer options. */
export function claudeQuestion(input: Record<string, unknown>): { question: string; options: { label: string; description?: string }[] } | undefined {
	const first = Array.isArray(input.questions) ? input.questions[0] as { question?: unknown; options?: unknown } | undefined : undefined;
	if (typeof first?.question !== 'string') {
		return undefined;
	}
	const options: { label: string; description?: string }[] = [];
	for (const raw of Array.isArray(first.options) ? first.options as { label?: unknown; description?: unknown }[] : []) {
		if (typeof raw?.label === 'string') {
			options.push({ label: raw.label, description: typeof raw.description === 'string' && raw.description ? raw.description : undefined });
		}
	}
	return { question: first.question, options };
}

/**
 * The rule "Always allow" writes to `permissions.allow` and the name shown on its button (v5-S13):
 * a command is allowed by its first words (`Bash(npm test *)`), any other tool by its name.
 */
export function claudeAllowRule(toolName: string, input: Record<string, unknown>): { rule: string; label: string } {
	if (toolName === 'Bash' && typeof input.command === 'string') {
		const [first, second] = input.command.trim().split(/\s+/);
		const prefix = second && !second.startsWith('-') ? `${first} ${second}` : first;
		if (prefix) {
			return { rule: `Bash(${prefix} *)`, label: prefix };
		}
	}
	return { rule: toolName, label: toolName };
}

/**
 * The state of one conversation, built only from the normalized events of the runtime. It holds no DOM, so the
 * pane, a chat in an editor and tests can all use it. A change fires `onDidChange` with the changed item, or
 * with `undefined` when the whole list changed.
 */
export class ClaudeConversation extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<ClaudeItem | undefined>());
	readonly onDidChange: Event<ClaudeItem | undefined> = this._onDidChange.event;

	private readonly _items: ClaudeItem[] = [];
	private readonly tools = new Map<string, IClaudeToolItem>();
	private readonly fileChanges = new Map<string, IClaudeFileChange>();

	sessionId: string | undefined;
	/** The model the CLI reported when the session started. */
	model: string | undefined;
	/** The permission mode the CLI reported last, `undefined` until it does. */
	mode: string | undefined;
	/** The folder the CLI works in; files outside it never count as changes. */
	private root: string | undefined;
	working = false;
	/** Input tokens of the last turn, an estimate of how full the context is. */
	contextTokens = 0;
	/** A message for the notice line, or `undefined`. */
	notice: string | undefined;
	/** Set while the chat is limited, offline or crashed; the next prompt clears it. */
	edge: ClaudeEdge | undefined;
	/** After a stop, until the CLI reports the end of the interrupted turn: its late events are dropped. */
	private stopping = false;

	get items(): readonly ClaudeItem[] {
		return this._items;
	}

	get changes(): readonly IClaudeFileChange[] {
		return [...this.fileChanges.values()];
	}

	/** The first prompt, shortened, as the pane title. */
	get title(): string | undefined {
		const first = this._items.find((item): item is IClaudeTextItem => item.kind === 'user');
		return first ? first.text.trim().split('\n')[0].slice(0, 60) : undefined;
	}

	/** Shows the messages of a stored session and continues it under the same id. */
	restore(sessionId: string, messages: readonly IClaudeTranscriptMessage[]): void {
		this.sessionId = sessionId;
		this._items.length = 0;
		this.fileChanges.clear();
		this.tools.clear();
		for (const message of messages) {
			this._items.push({ kind: message.role, text: message.text });
		}
		this._onDidChange.fire(undefined);
	}

	addUser(text: string, files?: readonly string[]): void {
		const item: IClaudeTextItem = { kind: 'user', text, files };
		this._items.push(item);
		this.working = true;
		this.stopping = false;
		this.notice = undefined;
		this.edge = undefined;
		this._onDidChange.fire(item);
	}

	/** The person stopped the turn: tools still running end, a waiting card is denied, and a "Stopped" mark is added. */
	stop(): void {
		if (!this.working) {
			return;
		}
		this.working = false;
		this.stopping = true;
		for (const item of this._items) {
			if (item.kind === 'tool' && item.status === 'running') {
				item.status = 'failed';
			} else if (item.kind === 'permission' && item.state === 'pending') {
				item.state = 'denied';
			}
		}
		this._items.push({ kind: 'stopped' });
		this._onDidChange.fire(undefined);
	}

	/** Marks a permission card as answered after the answer was sent to the runtime. */
	resolvePermission(item: IClaudePermissionItem, allow: boolean): void {
		item.state = allow ? 'allowed' : 'denied';
		this._onDidChange.fire(item);
	}

	setNotice(message: string | undefined): void {
		this.notice = message;
		this._onDidChange.fire(undefined);
	}

	setWorking(working: boolean): void {
		this.working = working;
		this._onDidChange.fire(undefined);
	}

	/** Applies one runtime event. Events of other sessions are ignored. */
	handle(event: ClaudeEvent): void {
		if (!this.sessionId || event.sessionId !== this.sessionId) {
			return;
		}
		if (this.stopping) {
			if (event.type === 'result' || event.type === 'ended') {
				this.stopping = false;
			}
			if (event.type !== 'error') {
				return;
			}
		}
		switch (event.type) {
			case 'started':
				this.model = event.model ?? this.model;
				this.root = event.cwd ?? this.root;
				this._onDidChange.fire(undefined);
				break;
			case 'mode':
				this.mode = event.mode;
				this._onDidChange.fire(undefined);
				break;
			case 'text': {
				const last = this._items[this._items.length - 1];
				if (last?.kind === 'assistant') {
					last.text += event.text;
					this._onDidChange.fire(last);
				} else {
					const item: IClaudeTextItem = { kind: 'assistant', text: event.text };
					this._items.push(item);
					this._onDidChange.fire(item);
				}
				break;
			}
			case 'toolUse': {
				const item: IClaudeToolItem = { kind: 'tool', id: event.toolUseId, name: event.name, target: claudeToolTarget(event.input), input: event.input, startedAt: Date.now(), status: 'running' };
				this.tools.set(item.id, item);
				this._items.push(item);
				this._onDidChange.fire(item);
				break;
			}
			case 'toolResult': {
				const tool = this.tools.get(event.toolUseId);
				if (tool) {
					tool.status = event.isError ? 'failed' : 'done';
					tool.output = event.output;
					if (!event.isError) {
						// only an edit that was applied counts for the changes bar
						this.recordChange(tool.name, tool.input);
					}
					this._onDidChange.fire(tool);
				}
				break;
			}
			case 'permission': {
				const item: IClaudePermissionItem = { kind: 'permission', sessionId: event.sessionId, requestId: event.requestId, toolName: event.toolName, target: claudeToolTarget(event.input), input: event.input, description: event.description, state: 'pending' };
				this._items.push(item);
				this._onDidChange.fire(item);
				break;
			}
			case 'rateLimit':
				if (event.status === 'rejected') {
					// the CLI gives seconds
					this.edge = { kind: 'limited', resetsAt: event.resetsAt ? event.resetsAt * 1000 : undefined };
					this.working = false;
					this._onDidChange.fire(undefined);
				}
				break;
			case 'result': {
				this.working = false;
				this.contextTokens = event.usage?.inputTokens ?? this.contextTokens;
				const edge = event.isError ? claudeClassifyError(event.text) : undefined;
				// a limit seen in a rateLimit event keeps its reset time
				this.edge = edge?.kind === 'limited' && this.edge?.kind === 'limited' ? this.edge : edge;
				this.notice = event.isError && !edge ? event.text : undefined;
				this._onDidChange.fire(undefined);
				break;
			}
			case 'error': {
				this.working = false;
				this.edge = claudeClassifyError(event.message) ?? this.edge;
				this.notice = this.edge ? undefined : event.message;
				this._onDidChange.fire(undefined);
				break;
			}
			case 'ended':
				this.working = false;
				if (event.exitCode && !this.edge) {
					// the CLI died while no limit or network error explains it
					this.edge = { kind: 'crashed', exitCode: event.exitCode, at: Date.now() };
					this.notice = undefined;
				}
				this._onDidChange.fire(undefined);
				break;
		}
	}

	private recordChange(toolName: string, input: Record<string, unknown>): void {
		const path = input.file_path;
		if (!FILE_TOOLS.has(toolName) || typeof path !== 'string') {
			return;
		}
		if (this.root && !(path.startsWith(this.root) && /[\\/]/.test(path[this.root.length] ?? ''))) {
			return; // e.g. a plan file under ~/.claude/plans
		}
		const change = this.fileChanges.get(path) ?? { path, added: 0, removed: 0 };
		const added = claudeFileChange(toolName, input);
		change.added += added.added;
		change.removed += added.removed;
		this.fileChanges.set(path, change);
	}
}
