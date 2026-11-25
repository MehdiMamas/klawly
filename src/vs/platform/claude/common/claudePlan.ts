/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type PlanStepStatus = 'pending' | 'active' | 'done' | 'blocked';

export interface PlanStep {
	id: string;
	title: string;
	detail?: string;
	files?: string[];
	/** The steps (1-based, in list order) a `Depends:` line under this one says it waits for (issue 495). */
	depends?: number[];
	status: PlanStepStatus;
}

/** What Plan mode hands the user: a titled checklist, not Markdown text. */
export interface PlanArtifact {
	title: string;
	summary: string;
	/**
	 * What the answer said to the user above the plan's heading, as Markdown.
	 * The chat shows it above the card; it is not part of the plan.
	 */
	lead?: string;
	/**
	 * The plan's details as Markdown: everything between the title and the
	 * to-do list, lists and sub-headings included, then the sections after
	 * the list (such as "## Verification"). Unset when that is only the
	 * summary.
	 */
	details?: string;
	steps: PlanStep[];
}

const STEP_PATTERN = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*\S)\s*$/;
const FILE_PATTERN = /[\w@.\-/\\]+\.[A-Za-z][A-Za-z0-9]{0,7}\b/g;
const TITLE_LIMIT = 100;
const LIST_ITEM_PATTERN = /^(?<indent>\s*)(?<marker>[-*+]|\d+[.)])\s+\S/;
/** A heading that is exactly a to-do heading: "## To-dos", "## Todos", "## Tasks" or "## Steps". */
const TODO_HEADING_PATTERN = /^#{2,6}\s+(?:to-?dos?|tasks?|steps?)\s*:?\s*$/i;
/** A heading that may name the list under it as the to-dos, such as "### Implementation steps". */
const LOOSE_TODO_HEADING_PATTERN = /^#{2,6}\s+(?:[\w-]+\s+)?(?:to-?dos?|tasks?|steps?|checklist)\s*:?\s*$/i;
/** A section whose lists are never to-dos, such as the "## Notes" a saved plan ends with. */
const NOTES_HEADING_PATTERN = /^#{1,6}\s+notes?\s*:?\s*$/i;
/** "Depends: 1, 3", "Depends on 2 and 3" or "Depends on: none"; other text after "Depends" stays detail. */
const DEPENDS_PATTERN = /^Depends(?:\s+on)?:?\s+(?<list>none|\d+(?:\s*(?:,|&|\band\b)\s*\d+)*)\.?$/i;

/**
 * The to-dos a `Depends:` detail line of to-do `own` (1-based) names, such as
 * "Depends: 1, 3", "Depends on 1 and 2" or "Depends on: none"; undefined when
 * `text` is not such a line. Only earlier to-dos count, so none waits on itself.
 */
export function parsePlanDependsLine(text: string, own: number): number[] | undefined {
	const list = DEPENDS_PATTERN.exec(text.trim())?.groups?.list;
	if (list === undefined) {
		return undefined;
	}
	const numbers = new Set<number>();
	for (const match of list.matchAll(/\d+/g)) {
		const value = Number(match[0]);
		if (value >= 1 && value < own) {
			numbers.add(value);
		}
	}
	return [...numbers].sort((a, b) => a - b);
}

/** Where a plan's to-do list is in its Markdown lines (0-based, `end` included). */
export interface PlanTodoRange {
	readonly start: number;
	readonly end: number;
	/** Whether the list is numbered (`1.`) rather than bulleted (`-`). */
	readonly numbered: boolean;
	/** The to-do heading right above the list, when it has one. */
	readonly heading?: number;
}

/**
 * Whether `line` is a top-level item of a list of the given kind: a bullet or
 * a number, as `numbered` says, indented less than 2 columns (a tab is 4).
 */
export function isPlanTodoItem(line: string, numbered: boolean): boolean {
	const item = LIST_ITEM_PATTERN.exec(line);
	return !!item?.groups && indentOf(item.groups.indent) < 2 && /\d/.test(item.groups.marker) === numbered;
}

function indentOf(whitespace: string): number {
	return whitespace.replace(/\t/g, '    ').length;
}

/**
 * Finds the to-do list of a plan. A plan gives its details first and its tasks
 * last, so lists in the details are not to-dos: the to-dos are the last list
 * under a "To-dos", "Todos", "Tasks" or "Steps" heading, else the last list
 * under a heading like "Implementation steps", else the last numbered list,
 * else the last list. Lists in a "Notes" section are never the to-dos. A list
 * is a run of top-level items of one kind (indented less than 2 columns) with
 * the lines indented under them; an indented item of the other kind belongs
 * to the item above it. Lines in code fences are never items.
 */
export function findPlanTodoList(lines: readonly string[]): PlanTodoRange | undefined {
	const runs: { start: number; end: number; numbered: boolean; heading?: number; exact?: boolean }[] = [];
	let run: (typeof runs)[number] | undefined;
	let fenced = false;
	let todoHeading: number | undefined;
	let notes = false;
	lines.forEach((line, index) => {
		const fence = /^\s*```/.test(line);
		const code = fenced || fence;
		if (fence) {
			fenced = !fenced;
		}
		if (!line.trim()) {
			return;
		}
		const above = todoHeading;
		todoHeading = !code && LOOSE_TODO_HEADING_PATTERN.test(line) ? index : undefined;
		if (!code && /^#{1,6}\s/.test(line)) {
			notes = NOTES_HEADING_PATTERN.test(line);
		}
		const item = code ? undefined : LIST_ITEM_PATTERN.exec(line);
		const indent = item?.groups ? indentOf(item.groups.indent) : 0;
		if (item?.groups && indent < 2) {
			const numbered = /\d/.test(item.groups.marker);
			if (run && (run.numbered === numbered || indent > 0)) {
				run.end = index;
				return;
			}
			run = { start: index, end: index, numbered, ...(above !== undefined ? { heading: above, exact: TODO_HEADING_PATTERN.test(lines[above]) } : {}) };
			if (!notes) {
				runs.push(run);
			}
			return;
		}
		if (run && /^(?:\s{2,}|\t)/.test(line)) {
			run.end = index;
			return;
		}
		run = undefined;
	});
	return runs.findLast(candidate => candidate.exact)
		?? runs.findLast(candidate => candidate.heading !== undefined)
		?? runs.findLast(candidate => candidate.numbered)
		?? runs[runs.length - 1];
}

/**
 * Reads a plan out of the assistant's Markdown answer. The to-do list (see
 * `findPlanTodoList`) gives the steps: its top-level items, with the indented
 * lines under an item as its detail and backticked file paths as file chips.
 * Text before the list is the title and summary; with a heading, the text
 * above it is the lead and the text under it the summary. Lists, sub-headings
 * and code there are details, kept as Markdown, and so are the sections after
 * the list (see `sectionsAfter`). Returns undefined when there
 * is no list, so a plain answer in Plan mode is not dressed up as a plan.
 */
export function parsePlanArtifact(markdown: string): PlanArtifact | undefined {
	const lines = markdown.split(/\r?\n/);
	const list = findPlanTodoList(lines);
	if (!list) {
		return undefined;
	}
	const steps: PlanStep[] = [];
	/** Original text of each step and its detail, backticks included, for file chips. */
	const raws: string[] = [];
	const intro: string[] = [];
	/** The intro lines as written, for the lead. */
	const introSource: string[] = [];
	let lead: string[] = [];
	/** The lines under the title as written, for the details. */
	let details: string[] = [];
	let title: string | undefined;
	let fenced = false;
	let detail: string[] = [];

	const closeStep = () => {
		const step = steps[steps.length - 1];
		if (step && detail.length > 0) {
			step.detail = detail.join(' ');
		}
		detail = [];
	};

	lines.slice(0, list.start).forEach((line, index) => {
		if (index === list.heading) {
			return;
		}
		const fence = /^\s*```/.test(line);
		const code = fenced || fence;
		if (fence) {
			fenced = !fenced;
		}
		const text = line.trim();
		const heading = code ? undefined : /^#{1,6}\s+(.*\S)\s*$/.exec(line);
		if (heading && title === undefined) {
			title = plain(heading[1]);
			intro.length = 0;
			lead = introSource.splice(0);
			details = [];
			return;
		}
		details.push(line);
		if (!code && !heading && text) {
			intro.push(plain(text.replace(/^(?:[-*+]|\d+[.)])\s+/, '')));
			introSource.push(text);
		}
	});
	fenced = false;
	for (const line of lines.slice(list.start, list.end + 1)) {
		if (/^\s*```/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) {
			continue;
		}
		const match = STEP_PATTERN.exec(line);
		if (match && isPlanTodoItem(line, list.numbered)) {
			closeStep();
			raws.push(match[3]);
			steps.push({
				id: `step-${steps.length + 1}`,
				title: plain(match[3]),
				status: match[2] && match[2] !== ' ' ? 'done' : 'pending',
			});
			continue;
		}
		const text = line.trim();
		if (text) {
			const body = match ? match[3] : text;
			const depends = steps.length > 0 ? parsePlanDependsLine(body, steps.length) : undefined;
			if (depends) {
				const step = steps[steps.length - 1];
				const all = [...new Set([...step.depends ?? [], ...depends])].sort((a, b) => a - b);
				if (all.length) {
					step.depends = all;
				}
				continue;
			}
			raws[raws.length - 1] += `\n${body}`;
			detail.push(plain(body));
		}
	}
	closeStep();
	steps.forEach((step, index) => {
		const files = filesIn(raws[index]);
		if (files.length > 0) {
			step.files = files;
		}
	});
	const summary = (title === undefined ? intro.slice(1) : intro).join(' ');
	if (title === undefined) {
		// Without a heading, the first line of text is the title, so the details start after it.
		details = details.slice(details.findIndex(line => line.trim()) + 1);
	}
	const plan: PlanArtifact = {
		title: clip(withoutPlanPrefix(title ?? intro[0] ?? steps[0].title)),
		summary,
		steps,
	};
	const after = sectionsAfter(lines, list.end + 1);
	const source = [details.join('\n').trim(), after].filter(part => part).join('\n\n');
	if (source && source !== summary) {
		plan.details = source;
	}
	if (lead.length > 0) {
		plan.lead = lead.join(' ');
	}
	return plan;
}

/**
 * The sections after the to-do list, such as "## Verification", as Markdown:
 * everything from the first heading after `start` on. Text between the list
 * and that heading is the answer talking to the user ("Want me to go
 * ahead?"), not part of the plan.
 */
function sectionsAfter(lines: readonly string[], start: number): string {
	let fenced = false;
	for (let index = start; index < lines.length; index++) {
		if (/^\s*```/.test(lines[index])) {
			fenced = !fenced;
		} else if (!fenced && /^#{1,6}\s+\S/.test(lines[index])) {
			return lines.slice(index).join('\n').trim();
		}
	}
	return '';
}

/** Strips the Markdown the checklist rows do not render. */
function plain(text: string): string {
	return text.replace(/\*\*|__/g, '').replace(/`/g, '').trim();
}

/**
 * Drops one leading "Plan:" or "Plan -" from a title: the card, the plan file
 * name and the Build text already say it is a plan. A bare "Plan" stays.
 */
function withoutPlanPrefix(title: string): string {
	return title.replace(/^plan(?:\s*:|\s+[-\u2013\u2014])\s*/i, '') || title;
}

function clip(text: string): string {
	return text.length > TITLE_LIMIT ? `${text.slice(0, TITLE_LIMIT - 1)}…` : text;
}

function filesIn(raw: string): string[] {
	const files: string[] = [];
	for (const span of raw.matchAll(/`([^`]+)`/g)) {
		for (const candidate of span[1].match(FILE_PATTERN) ?? []) {
			if (!files.includes(candidate) && !/^\d+(\.\d+)+$/.test(candidate)) {
				files.push(candidate);
			}
		}
	}
	return files;
}

/**
 * The text the Build turn sends. The plan the user saw is the plan that runs,
 * followed by their notes. `edited` says the user changed or reordered steps
 * on the card, so Claude follows this version rather than its own answer.
 */
export function buildPlanPrompt(plan: PlanArtifact, notes: string, edited = false): string {
	const lines = [
		'Build the accepted plan below. Follow the steps in order, make the changes, and say what you did.',
	];
	if (edited) {
		lines.push('The user edited or reordered the steps of your plan. Follow this version.');
	}
	lines.push(
		'',
		`Plan: ${plan.title}`,
	);
	const prose = plan.details ?? plan.summary;
	if (prose) {
		lines.push(prose);
	}
	lines.push('');
	plan.steps.forEach((step, index) => {
		lines.push(`${index + 1}. ${step.title}`);
		if (step.detail) {
			lines.push(`   ${step.detail}`);
		}
		if (step.files && step.files.length > 0) {
			lines.push(`   Files: ${step.files.join(', ')}`);
		}
	});
	const trimmed = notes.trim();
	if (trimmed) {
		lines.push('', 'Notes from the user:', trimmed);
	}
	return lines.join('\n');
}
