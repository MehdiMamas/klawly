/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A Klawly project (issue 496): a goal that a coordinator chat plans and hands
 * to background agents over days. It is kept as `~/.klawly/projects/<name>.json`,
 * out of the workspace, so it outlives the chats and windows that work on it.
 */
export interface KlawlyProject {
	readonly version: 1;
	/** The goal's first line, short enough for a list row. */
	readonly name: string;
	/** What the project is for, as the user wrote it. */
	readonly goal: string;
	/** The workspace folder the agents work in. */
	readonly folder: string;
	/** ISO time the project was made. */
	readonly createdAt: string;
	/** The coordinator chat: a Plan mode chat that plans and never edits files. */
	readonly sessionId?: string;
}

const NAME_LIMIT = 60;

/** The name of a project with `goal`: its first line, clipped at a word. */
export function projectName(goal: string): string {
	const line = goal.trim().split(/\r?\n/)[0].replace(/\s+/g, ' ').trim();
	if (line.length <= NAME_LIMIT) {
		return line;
	}
	const cut = line.slice(0, NAME_LIMIT);
	const space = cut.lastIndexOf(' ');
	return `${(space > NAME_LIMIT / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, '')}...`;
}

/** A file name for project `name` that is not one of `taken` (lower case names). */
export function projectFileName(name: string, taken: readonly string[]): string {
	const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'project';
	const names = new Set(taken.map(file => file.toLowerCase()));
	for (let index = 1; ; index++) {
		const file = index === 1 ? `${slug}.json` : `${slug}-${index}.json`;
		if (!names.has(file)) {
			return file;
		}
	}
}

/** The shared context folder name of project file `file`: `add-dark-mode.json` has `add-dark-mode.context`. */
export function projectContextFolderName(file: string): string {
	return `${file.replace(/\.json$/i, '')}.context`;
}

/** The note in a new context folder, so the user and the agents know what it is for. */
export function projectContextReadme(project: KlawlyProject): string {
	return [
		`# Shared context: ${project.name}`,
		'',
		'Every agent of this project can read and write this folder, whichever Git worktree it works in.',
		'Keep what they all need here: decisions, API notes, links and anything one agent learns for the others.',
		'Put code changes in the repository, not here.',
		'',
	].join('\n');
}

/** Reads a project file; undefined when it is not one. */
export function parseProjectFile(text: string): KlawlyProject | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const { version, name, goal, folder, createdAt, sessionId } = value as Record<string, unknown>;
	if (version !== 1 || typeof name !== 'string' || typeof goal !== 'string' || typeof folder !== 'string' || typeof createdAt !== 'string' || (sessionId !== undefined && typeof sessionId !== 'string')) {
		return undefined;
	}
	return { version, name, goal, folder, createdAt, ...(sessionId ? { sessionId } : {}) };
}

/** The text a project file holds. */
export function writeProjectFile(project: KlawlyProject): string {
	return `${JSON.stringify(project, undefined, '\t')}\n`;
}

/**
 * The first turn of a project's coordinator chat, sent in Plan mode. The
 * coordinator plans and never edits files: its plan's to-dos carry `Files:`
 * and `Depends:` lines, so Build in Parallel (issue 495) can start each one
 * that waits on nothing as its own background agent and worktree.
 */
export function projectCoordinatorPrompt(project: KlawlyProject, path: string, contextPath?: string): string {
	return [
		`You coordinate a Klawly project. Its goal: ${project.goal.trim()}`,
		'',
		`Plan the work and don't change any files yourself. Read what you need, then write the plan as a numbered to-do list in which each to-do is one task for one background agent that works alone on its own Git worktree:`,
		`- Keep each to-do small and self-contained, and say in it what done means.`,
		`- Under each to-do, add a \`Files:\` line with the files it changes and a \`Depends:\` line with the numbers of the to-dos it waits for (\`Depends: none\` when it can start right away).`,
		`- Let as many to-dos as you can start at the same time, at most eight at once.`,
		'',
		`The user builds the plan with Build in Parallel: each to-do that waits on nothing gets its own background agent, and their results come back to this chat as one turn. Then say which ones are ready to review, what failed, and what is left, and keep the plan up to date.`,
		'',
		`The project file is \`${path}\`.`,
		...(contextPath ? ['', `Every agent of this project shares the context folder \`${contextPath}\`. Put what the others need there (decisions, API notes, links) and read it before you plan.`] : []),
	].join('\n');
}
