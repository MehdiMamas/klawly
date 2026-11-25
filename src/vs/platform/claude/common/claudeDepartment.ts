/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_KLAWLY_MCP_SERVER } from './claudeTerminalRun.js';

/**
 * Departments (issue 1177): a chat hands a request that belongs to another project to
 * that project's own top-level chat. Departments are peers, not workers: the sending
 * chat gets a hand-off card, not a reply. This is the pure core: the tool contract,
 * matching a project name to an open project, the hand-off status, and the text the
 * receiving chat shows. The tool is `klawly_department` on Klawly's own MCP server.
 */
export const CLAUDE_DEPARTMENT_TOOL = 'klawly_department';
export const CLAUDE_DEPARTMENT_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_DEPARTMENT_TOOL}`;

export const CLAUDE_DEPARTMENT_TOOL_DESCRIPTION = [
	'Hands a request that belongs to another project to that project\'s own chat, without asking the user, and returns at once.',
	'project is the folder name, repository name or a distinctive part of either; if it matches more than one project the user picks.',
	'brief is the whole request, written for a chat that does not see this conversation; facts is what you already know that saves it work; userWords is what the user said, word for word.',
	'The other chat is a peer: no reply comes back. The user sees a card in this chat with the hand-off status.',
].join(' ');

/** What Claude passes to `klawly_department`. */
export interface ClaudeDepartmentToolArgs {
	readonly project: string;
	readonly brief: string;
	readonly facts?: string;
	readonly userWords: string;
}

/** Where a hand-off stands, as the card shows it. */
export type ClaudeDepartmentStatus = 'delivered' | 'working' | 'waiting' | 'done' | 'failed';

/** A project window or folder Klawly knows. */
export interface ClaudeDepartmentProject {
	/** The absolute folder. */
	readonly folder: string;
	/** The folder's name. */
	readonly name: string;
	/** `owner/name` of its GitHub remote, when it has one. */
	readonly repo?: string;
}

export type ClaudeDepartmentMatch =
	| { readonly kind: 'match'; readonly project: ClaudeDepartmentProject }
	| { readonly kind: 'ambiguous'; readonly candidates: readonly ClaudeDepartmentProject[] }
	| { readonly kind: 'none' };

/** A `klawly_department` call waiting for the window that owns the session. */
export type ClaudeDepartmentToolRequest = ClaudeDepartmentToolArgs & {
	readonly sessionId: string;
	readonly requestId: string;
};

export type ClaudeDepartmentToolResult =
	| { readonly kind: 'delivered'; readonly project: string; readonly opened: boolean }
	| { readonly kind: 'needsPick'; readonly candidates: readonly string[] }
	| { readonly kind: 'failed'; readonly message: string };

function normalize(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** How well a query names a project: 3 exact, 2 prefix, 1 contained, 0 none. */
function score(query: string, project: ClaudeDepartmentProject): number {
	const names = [project.name, project.repo?.split('/').pop() ?? '', project.repo ?? ''].map(normalize).filter(name => name.length > 0);
	let best = 0;
	for (const name of names) {
		if (name === query) {
			best = Math.max(best, 3);
		} else if (name.startsWith(query)) {
			best = Math.max(best, 2);
		} else if (name.includes(query)) {
			best = Math.max(best, 1);
		}
	}
	return best;
}

/**
 * Finds the project a name points at, by folder name and repository name. One best
 * match wins; a tie at the best score is ambiguous, and the user picks. An empty
 * query matches nothing.
 */
export function matchClaudeDepartmentProject(query: string, projects: readonly ClaudeDepartmentProject[]): ClaudeDepartmentMatch {
	const wanted = normalize(query);
	if (!wanted) {
		return { kind: 'none' };
	}
	const scored = projects.map(project => ({ project, score: score(wanted, project) })).filter(entry => entry.score > 0);
	if (scored.length === 0) {
		return { kind: 'none' };
	}
	const top = Math.max(...scored.map(entry => entry.score));
	const best = scored.filter(entry => entry.score === top).map(entry => entry.project);
	return best.length === 1 ? { kind: 'match', project: best[0] } : { kind: 'ambiguous', candidates: best };
}

/** Why the arguments cannot become a hand-off, or undefined when they can. */
export function claudeDepartmentArgsProblem(args: ClaudeDepartmentToolArgs): string | undefined {
	if (!args.project.trim()) {
		return 'Name the project this request belongs to.';
	}
	if (!args.brief.trim()) {
		return 'Write the request for the other chat in brief.';
	}
	if (!args.userWords.trim()) {
		return 'Pass what the user said, word for word, in userWords.';
	}
	return undefined;
}

/**
 * The message the receiving chat starts with: a banner line naming where it came from,
 * the user's exact words, the brief and the facts. `from` is the sending project's name.
 */
export function claudeDepartmentMessage(from: string, args: ClaudeDepartmentToolArgs): string {
	const parts = [
		`From ${from} chat. This is a hand-off from another project's chat, not a worker: nobody waits for a reply.`,
		`The user said: ${args.userWords.trim()}`,
		args.brief.trim(),
	];
	const facts = args.facts?.trim();
	if (facts) {
		parts.push(`Known so far: ${facts}`);
	}
	return parts.join('\n\n');
}

/** The one-line label of a hand-off status on the card. */
export function claudeDepartmentStatusLabel(status: ClaudeDepartmentStatus): string {
	switch (status) {
		case 'delivered': return 'Delivered';
		case 'working': return 'Working';
		case 'waiting': return 'Waiting on you';
		case 'done': return 'Done';
		case 'failed': return 'Failed';
	}
}

/** The text Claude reads back after a hand-off. */
export function claudeDepartmentToolText(result: ClaudeDepartmentToolResult): { readonly text: string; readonly isError: boolean } {
	switch (result.kind) {
		case 'delivered':
			return { text: `Handed to the ${result.project} chat${result.opened ? ' (opened a new one)' : ''}. It is a peer: no reply will come back. Tell the user it was handed over.`, isError: false };
		case 'needsPick':
			return { text: `More than one project fits (${result.candidates.join(', ')}). The user is asked to pick; do not hand it over again unless they ask.`, isError: false };
		case 'failed':
			return { text: `Klawly could not hand the request over: ${result.message}`, isError: true };
	}
}
