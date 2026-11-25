/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ClaudeEvent } from './claudeRuntime.js';

export type ClaudeToolStatus = 'running' | 'done' | 'failed';
export type ClaudePermissionState = 'pending' | 'allowed' | 'denied';

export interface IClaudeTextItem {
	readonly kind: 'user' | 'assistant';
	/** Markdown for assistant messages; plain text for user messages. */
	text: string;
}

/** One tool call as a collapsed row that can expand to its output (v5-S12, VC12). */
export interface IClaudeToolItem {
	readonly kind: 'tool';
	readonly id: string;
	readonly name: string;
	/** What the tool acts on, for example `total.ts` or `npm test`. */
	readonly target: string;
	readonly input: Record<string, unknown>;
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
	readonly description?: string;
	state: ClaudePermissionState;
}

export type ClaudeItem = IClaudeTextItem | IClaudeToolItem | IClaudePermissionItem;

/** Lines added and removed in one file, summed over the turn (the changes bar of v5-S19, VC09). */
export interface IClaudeFileChange {
	readonly path: string;
	added: number;
	removed: number;
}

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

function countLines(text: unknown): number {
	return typeof text === 'string' && text.length > 0 ? text.split('\n').length : 0;
}

/** The tool input field that names what a tool acts on, so a row reads as "Edit total.ts" (v5-S12, D17). */
export function claudeToolTarget(input: Record<string, unknown>): string {
	const value = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? '';
	const text = typeof value === 'string' ? value : '';
	return text.split('\n')[0];
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
	working = false;
	/** Input tokens of the last turn, an estimate of how full the context is. */
	contextTokens = 0;
	/** A message for the notice line, or `undefined`. */
	notice: string | undefined;

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

	addUser(text: string): void {
		const item: IClaudeTextItem = { kind: 'user', text };
		this._items.push(item);
		this.working = true;
		this.notice = undefined;
		this._onDidChange.fire(item);
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
		switch (event.type) {
			case 'started':
				this.model = event.model ?? this.model;
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
				const item: IClaudeToolItem = { kind: 'tool', id: event.toolUseId, name: event.name, target: claudeToolTarget(event.input), input: event.input, status: 'running' };
				this.tools.set(item.id, item);
				this._items.push(item);
				this.recordChange(event.name, event.input);
				this._onDidChange.fire(item);
				break;
			}
			case 'toolResult': {
				const tool = this.tools.get(event.toolUseId);
				if (tool) {
					tool.status = event.isError ? 'failed' : 'done';
					tool.output = event.output;
					this._onDidChange.fire(tool);
				}
				break;
			}
			case 'permission': {
				const item: IClaudePermissionItem = { kind: 'permission', sessionId: event.sessionId, requestId: event.requestId, toolName: event.toolName, target: claudeToolTarget(event.input), description: event.description, state: 'pending' };
				this._items.push(item);
				this._onDidChange.fire(item);
				break;
			}
			case 'result':
				this.working = false;
				this.contextTokens = event.usage?.inputTokens ?? this.contextTokens;
				this.notice = event.isError ? event.text : undefined;
				this._onDidChange.fire(undefined);
				break;
			case 'error':
				this.working = false;
				this.notice = event.message;
				this._onDidChange.fire(undefined);
				break;
			case 'ended':
				this.working = false;
				this._onDidChange.fire(undefined);
				break;
		}
	}

	private recordChange(toolName: string, input: Record<string, unknown>): void {
		const path = input.file_path;
		if (!FILE_TOOLS.has(toolName) || typeof path !== 'string') {
			return;
		}
		const change = this.fileChanges.get(path) ?? { path, added: 0, removed: 0 };
		if (toolName === 'Write') {
			change.added += countLines(input.content);
		} else if (toolName === 'Edit') {
			change.added += countLines(input.new_string);
			change.removed += countLines(input.old_string);
		} else if (Array.isArray(input.edits)) {
			for (const edit of input.edits as Record<string, unknown>[]) {
				change.added += countLines(edit?.new_string);
				change.removed += countLines(edit?.old_string);
			}
		}
		this.fileChanges.set(path, change);
	}
}
