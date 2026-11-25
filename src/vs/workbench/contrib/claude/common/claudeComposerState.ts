/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TodoItem, UsageInfo } from '../../../../platform/claude/common/claudeProtocol.js';
import { AgentReducerEvent, AgentViewState } from '../../../services/claude/common/claudeAgentState.js';

/**
 * What the composer shows around the input: the to-do list, the context
 * ring and the model the runtime reported. Only main-loop events count; a
 * subagent's to-dos and usage stay in its own chat.
 */
export interface ClaudeComposerMeta {
	readonly todos: readonly TodoItem[];
	readonly usage?: UsageInfo;
	/** Model the runtime reported with `session.started` or `session.modelChanged`. */
	readonly runtimeModel?: string;
}

export const EMPTY_COMPOSER_META: ClaudeComposerMeta = { todos: [] };

/** The to-dos and usage come from the session's view state; the model from {@link claudeRuntimeModel}. */
export function claudeComposerMeta(state: AgentViewState, runtimeModel: string | undefined): ClaudeComposerMeta {
	return { todos: state.todos ?? EMPTY_COMPOSER_META.todos, usage: state.usage, runtimeModel };
}

/** The model a main-loop event reports, if it reports one. */
function reportedModel(event: AgentReducerEvent | undefined): string | undefined {
	if (!event || (event.type !== 'session.started' && event.type !== 'session.modelChanged') || event.parentRunId !== undefined) {
		return undefined;
	}
	return event.type === 'session.started' ? event.model : event.modelId;
}

/** The model the runtime reported last, read from the newest event back. */
export function claudeRuntimeModel(events: readonly AgentReducerEvent[]): string | undefined {
	for (let index = events.length - 1; index >= 0; index--) {
		const model = reportedModel(events[index]);
		if (model) {
			return model;
		}
	}
	return undefined;
}

/**
 * Applies one event to the known runtime model. The event log is capped, so
 * the composer keeps the model per session and folds each new event in; a
 * long turn can push `session.started` out of the log.
 */
export function foldClaudeRuntimeModel(model: string | undefined, event: AgentReducerEvent | undefined): string | undefined {
	return reportedModel(event) || model;
}

export interface ClaudeTodoProgress {
	readonly done: number;
	readonly total: number;
	/** The item in progress, or the first one still open. */
	readonly current?: TodoItem;
}

export function claudeTodoProgress(items: readonly TodoItem[]): ClaudeTodoProgress {
	const done = items.filter(item => item.status === 'completed').length;
	const current = items.find(item => item.status === 'in_progress') ?? items.find(item => item.status !== 'completed');
	return { done, total: items.length, current };
}

/** The strip shows while a turn runs, and afterwards only while something is left to do. */
export function showClaudeTodos(items: readonly TodoItem[], running: boolean): boolean {
	return items.length > 0 && (running || items.some(item => item.status !== 'completed'));
}

export interface ClaudeContextUsage {
	readonly used: number;
	readonly window: number;
	/** 0 to 1. */
	readonly fraction: number;
}

/** Only real numbers: both the context size and the window must come from the runtime. */
export function claudeContextUsage(usage: UsageInfo | undefined): ClaudeContextUsage | undefined {
	const used = usage?.contextTokens;
	const window = usage?.contextWindow;
	if (used === undefined || window === undefined || !Number.isFinite(used) || !Number.isFinite(window) || used < 0 || window <= 0) {
		return undefined;
	}
	return { used, window, fraction: Math.min(1, used / window) };
}

/** Below this share of the window the context ring stays hidden. */
const CONTEXT_RING_FROM = 0.5;

/**
 * Like Claude Code, which names the context left only as it nears compaction,
 * the ring shows once half the window is used. Below that a quiet toolbar
 * reads better than an arc that looks like a spinner (#136).
 */
export function showClaudeContextRing(context: ClaudeContextUsage | undefined): context is ClaudeContextUsage {
	return !!context && context.fraction >= CONTEXT_RING_FROM;
}

/**
 * Replaces the `@query` or `/query` token with the item's text. When the
 * item inserts nothing (a chip), one of the two spaces around the token goes,
 * so the text never keeps a double space.
 */
export function spliceClaudeMention(value: string, start: number, cursor: number, insert: string): { readonly value: string; readonly cursor: number } {
	const before = value.slice(0, start);
	let after = value.slice(cursor);
	const endsOpen = before.length === 0 || /\s$/.test(before) || /\s$/.test(insert);
	if ((insert.length === 0 || /\s$/.test(insert)) && endsOpen && /^[ \t]/.test(after)) {
		after = after.slice(1);
	}
	return { value: before + insert + after, cursor: before.length + insert.length };
}

/** The folder part of a workspace-relative path, with `/` separators. Empty at the root. */
export function claudeRelativeFolder(relativePath: string): string {
	const normalized = relativePath.replace(/\\/g, '/');
	const slash = normalized.lastIndexOf('/');
	return slash > 0 ? normalized.slice(0, slash) : '';
}

/**
 * The composer text after Edit Goal prefills `/name text` (issue 1134). Text already typed is kept on a
 * new line after the prefill; a draft that already is that command is replaced, not repeated.
 */
export function claudeSlashDraftWithText(name: string, text: string, draft: string): string {
	const prefill = `/${name} ${text}`;
	const typed = draft.trim();
	if (!typed || typed === prefill || draft.startsWith(`/${name} `) || draft === `/${name}`) {
		return prefill;
	}
	return `${prefill}\n${typed}`;
}
