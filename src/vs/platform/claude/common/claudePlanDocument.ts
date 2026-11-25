/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hash } from '../../../base/common/hash.js';
import { findPlanTodoList, isPlanTodoItem, parsePlanDependsLine } from './claudePlan.js';

/** One to-do of a plan file: a top-level item of its to-do list. */
export interface PlanTodo {
	/** 1-based line of the item in the file. */
	readonly line: number;
	/** The item's text as written, Markdown included, without its marker and box. */
	readonly text: string;
	/** Indented lines under the item, joined with spaces, without the `Files:` line. */
	readonly detail?: string;
	/** The files an indented `Files:` line names, as a saved plan writes them. */
	readonly files?: readonly string[];
	/** The to-dos (1-based, in list order) an indented `Depends:` line says this one waits for (issue 495). */
	readonly depends?: readonly number[];
	readonly done: boolean;
}

/**
 * A plan file as the plan editor shows it: the first `#` heading is the title,
 * the to-do list (the one `findPlanTodoList` picks) holds the
 * to-dos, and the rest is prose before and after that list.
 */
export interface PlanDocument {
	readonly title?: string;
	readonly before: string;
	readonly after: string;
	readonly todos: readonly PlanTodo[];
	/** 1-based line a new to-do goes on: right after the last to-do and its detail, or at the end of `before`. */
	readonly insertLine: number;
	/** Whether the list is numbered (`1.`) rather than bulleted (`-`). */
	readonly numbered: boolean;
}

const ITEM_PATTERN = /^(?<indent>\s*)(?<marker>[-*+]|\d+[.)])\s+(?:\[(?<box>[ xX])\]\s+)?(?<text>.*\S)?\s*$/;
const HEADING_PATTERN = /^#\s+(?<text>.*\S)\s*$/;
const FILES_PATTERN = /^Files:\s*(?<list>.*\S)$/;

/**
 * Reads a plan file. The to-do list is the one `findPlanTodoList` picks; its
 * top-level items of the list's kind are the to-dos, other lines their detail.
 * Lines inside code fences are never a title or a to-do.
 */
export function parsePlanDocument(source: string): PlanDocument {
	const lines = source.split(/\r?\n/);
	const list = findPlanTodoList(lines);
	const start = list?.start ?? lines.length;
	const before: string[] = [];
	const todos: PlanTodo[] = [];
	let title: string | undefined;
	let fenced = false;
	let detail: string[] = [];
	let files: string[] = [];
	let depends: number[] = [];

	const closeTodo = () => {
		const last = todos[todos.length - 1];
		if (last && (detail.length > 0 || files.length > 0 || depends.length > 0)) {
			todos[todos.length - 1] = {
				...last,
				...(detail.length > 0 ? { detail: detail.join(' ') } : {}),
				...(files.length > 0 ? { files } : {}),
				...(depends.length > 0 ? { depends } : {}),
			};
		}
		detail = [];
		files = [];
		depends = [];
	};

	lines.slice(0, start).forEach((line, index) => {
		const fence = /^\s*```/.test(line);
		const code = fenced || fence;
		if (fence) {
			fenced = !fenced;
		}
		// The to-do heading is what the editor's own to-do header stands for.
		if (index === list?.heading) {
			return;
		}
		const heading = code ? undefined : HEADING_PATTERN.exec(line);
		if (heading?.groups && title === undefined) {
			title = heading.groups.text;
			return;
		}
		before.push(line);
	});
	if (list) {
		lines.slice(list.start, list.end + 1).forEach((line, offset) => {
			const item = /^\s*```/.test(line) ? undefined : ITEM_PATTERN.exec(line);
			if (item?.groups?.text && isPlanTodoItem(line, list.numbered)) {
				closeTodo();
				const box = item.groups.box;
				todos.push({ line: list.start + offset + 1, text: item.groups.text, done: !!box && box !== ' ' });
				return;
			}
			if (!line.trim()) {
				return;
			}
			const text = line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '');
			const named = FILES_PATTERN.exec(text)?.groups?.list;
			const after = todos.length > 0 ? parsePlanDependsLine(text, todos.length) : undefined;
			if (after) {
				depends = [...new Set([...depends, ...after])].sort((a, b) => a - b);
			} else if (named) {
				files.push(...named.split(',').map(file => file.trim().replace(/^`(.*)`$/, '$1')).filter(file => file.length > 0));
			} else {
				detail.push(text);
			}
		});
		closeTodo();
	}
	return {
		title,
		before: before.join('\n').trim(),
		after: list ? lines.slice(list.end + 1).join('\n').trim() : '',
		todos,
		// The line after the last to-do and its detail.
		insertLine: list ? list.end + 2 : endOfBefore(lines),
		numbered: list?.numbered ?? true,
	};
}

function endOfBefore(lines: readonly string[]): number {
	let end = lines.length;
	while (end > 0 && !lines[end - 1].trim()) {
		end--;
	}
	return end + 1;
}

/**
 * Line `line` with its to-do marked done or open. A done item gets `[x]`; an
 * open item keeps an empty box if it had one and otherwise has none, so a
 * plain numbered step stays plain. Returns the line unchanged when it is not
 * a list item.
 */
export function setPlanTodoDone(line: string, done: boolean): string {
	const item = ITEM_PATTERN.exec(line);
	if (!item?.groups) {
		return line;
	}
	const { indent, marker, box } = item.groups;
	const text = item.groups.text ?? '';
	const nextBox = done ? '[x] ' : box !== undefined ? '[ ] ' : '';
	return `${indent}${marker} ${nextBox}${text}`;
}

/** The line a new open to-do is written as, numbered after `document`'s last one. */
export function newPlanTodoLine(document: PlanDocument, text: string): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	const marker = document.numbered ? `${document.todos.length + 1}.` : '-';
	return `${marker} [ ] ${oneLine}`;
}

/**
 * The key a chat's plan file carries in its name: the same chat turn always
 * gets the same key, so Open Plan finds the file it wrote before.
 */
export function planFileKey(sessionId: string, turnId: string): string {
	return (hash(`${sessionId}/${turnId}`) >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

/** A file name for a plan titled `title`; `key` keeps two plans with one title apart. */
export function planFileName(title: string, key: string): string {
	const slug = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
	return `${slug || 'plan'}-${key}.plan.md`;
}

/**
 * What Build sends for a plan file: the file, its open to-dos in order, and
 * the ask to tick each one off in the file, so the plan editor follows along.
 */
export function buildPlanFilePrompt(document: PlanDocument, path: string): string {
	const open = document.todos.filter(todo => !todo.done);
	const lines = [
		`Build the plan in \`${path}\`. Work through its open to-dos in order, make the changes, and say what you did.`,
		`When you finish a to-do, mark it done in that file by putting \`[x]\` after its list marker.`,
		'',
	];
	if (document.title) {
		lines.push(`Plan: ${document.title}`);
	}
	if (document.before) {
		lines.push(document.before);
	}
	lines.push('', 'Open to-dos:');
	open.forEach((todo, index) => {
		lines.push(`${index + 1}. ${todo.text}`);
		if (todo.detail) {
			lines.push(`   ${todo.detail}`);
		}
		if (todo.files) {
			lines.push(`   Files: ${todo.files.map(file => `\`${file}\``).join(', ')}`);
		}
	});
	if (document.after) {
		lines.push('', document.after);
	}
	return lines.join('\n');
}

/**
 * Build in Parallel (issue 495): the open to-dos that can start now, each one
 * a background agent of its own. A to-do is ready when every to-do its
 * `Depends:` line names is done; a to-do with no `Depends:` line depends on
 * nothing. `waiting` counts the open to-dos that still wait for another.
 */
export function readyPlanTodos(document: PlanDocument): { readonly ready: readonly PlanTodo[]; readonly waiting: number } {
	const open = document.todos.filter(todo => !todo.done);
	const ready = open.filter(todo => (todo.depends ?? []).every(number => document.todos[number - 1]?.done ?? true));
	return { ready, waiting: open.length - ready.length };
}

/** A finished to-do and the branch its agent's changes are on. */
export interface PlanTodoBranch {
	readonly number: number;
	readonly branch: string;
}

/**
 * What one background agent gets for one to-do of a plan built in parallel.
 * The agent works on its own worktree, so it does not tick the plan file;
 * Klawly ticks the to-do when the agent finishes.
 */
export function buildPlanTodoPrompt(document: PlanDocument, path: string, todo: PlanTodo, built: readonly PlanTodoBranch[] = []): string {
	const number = document.todos.indexOf(todo) + 1;
	const lines = [
		`Build to-do ${number} of the plan in \`${path}\`, and only that to-do: other agents build the other to-dos at the same time, each on its own worktree. Make the changes and say what you did. Do not edit the plan file.`,
		'',
	];
	if (document.title) {
		lines.push(`Plan: ${document.title}`);
	}
	if (document.before) {
		lines.push(document.before);
	}
	lines.push('', `To-do ${number}: ${todo.text}`);
	if (todo.detail) {
		lines.push(todo.detail);
	}
	if (todo.files) {
		lines.push(`Files: ${todo.files.map(file => `\`${file}\``).join(', ')}`);
	}
	if (built.length > 0) {
		// A later wave starts from the checkout's HEAD, which has none of the earlier agents' changes.
		lines.push('', 'This to-do builds on to-dos other agents already finished. Their changes are on these branches of this repository and not in your checkout yet. Before you start, merge each one with `git merge --no-edit <branch>`; if a merge fails, say so and stop instead of guessing.');
		for (const item of built) {
			lines.push(`- To-do ${item.number}: \`${item.branch}\``);
		}
	}
	return lines.join('\n');
}
