/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PlanArtifact, PlanStep } from './claudePlan.js';

/**
 * Gives step `stepId` a new title. A blank title is ignored, so a step can
 * never become empty. Returns the same plan when nothing changed.
 */
export function renamePlanStep(plan: PlanArtifact, stepId: string, title: string): PlanArtifact {
	const trimmed = title.replace(/\s+/g, ' ').trim();
	const index = plan.steps.findIndex(step => step.id === stepId);
	if (index < 0 || !trimmed || plan.steps[index].title === trimmed) {
		return plan;
	}
	const steps = [...plan.steps];
	steps[index] = { ...steps[index], title: trimmed };
	return { ...plan, steps };
}

/**
 * Moves step `stepId` one place up (`-1`) or down (`1`). Returns the same plan
 * when the step is unknown or already at that edge.
 */
export function movePlanStep(plan: PlanArtifact, stepId: string, direction: -1 | 1): PlanArtifact {
	const index = plan.steps.findIndex(step => step.id === stepId);
	const target = index + direction;
	if (index < 0 || target < 0 || target >= plan.steps.length) {
		return plan;
	}
	const steps = [...plan.steps];
	[steps[index], steps[target]] = [steps[target], steps[index]];
	// Depends lines name steps by number (issue 495): follow the swap, and a step never waits on one after it.
	const renumber = (number: number) => number === index + 1 ? target + 1 : number === target + 1 ? index + 1 : number;
	return {
		...plan,
		steps: steps.map((step, position) => {
			if (!step.depends) {
				return step;
			}
			const moved: PlanStep = { ...step, depends: step.depends.map(renumber).filter(number => number <= position).sort((a, b) => a - b) };
			if (!moved.depends?.length) {
				delete moved.depends;
			}
			return moved;
		}),
	};
}

/** True when `edited` has other step titles or another step order than `original`. */
export function isPlanEdited(original: PlanArtifact, edited: PlanArtifact): boolean {
	if (original.steps.length !== edited.steps.length) {
		return true;
	}
	return original.steps.some((step, index) => step.id !== edited.steps[index].id || step.title !== edited.steps[index].title);
}

/**
 * The plan Build may send when the user edited the card. The edit may only
 * reorder steps and change their titles: every step of `original` must appear
 * once, and no step may be added. Detail, files and status always come from
 * `original`. Returns undefined when `edited` is not such an edit.
 */
export function acceptEditedPlan(original: PlanArtifact, edited: PlanArtifact): PlanArtifact | undefined {
	if (edited.steps.length !== original.steps.length) {
		return undefined;
	}
	const byId = new Map(original.steps.map(step => [step.id, step]));
	const seen = new Set<string>();
	const steps: PlanStep[] = [];
	for (const step of edited.steps) {
		const source = byId.get(step.id);
		const title = step.title.replace(/\s+/g, ' ').trim();
		if (!source || seen.has(step.id) || !title) {
			return undefined;
		}
		seen.add(step.id);
		steps.push({ ...source, title });
	}
	return { ...original, steps };
}

/**
 * The Markdown a plan step title came from. Plan steps keep plain titles, so
 * this finds the list item in `markdown` whose plain text is `title`. A title
 * the user edited has no source and shows as plain text.
 */
export function planStepSource(markdown: string, title: string): string | undefined {
	for (const line of markdown.split(/\r?\n/)) {
		const match = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(?<raw>.*\S)\s*$/.exec(line);
		const raw = match?.groups?.raw;
		if (raw && raw.replace(/\*\*|__/g, '').replace(/`/g, '').trim() === title) {
			return raw;
		}
	}
	return undefined;
}

/** A detail line under a step: indented by two spaces or a tab. */
const INDENTED = /^(?:\s{2,}|\t)/;

/**
 * The Markdown of the detail under the step titled `title`, for display: the
 * indented lines under that list item, with bold and code kept. Lines that
 * only name files are left out, since the card shows those as chips. Returns
 * undefined when no step has that title, such as a step the user renamed.
 */
export function planDetailSource(markdown: string, title: string): string | undefined {
	const lines = markdown.split(/\r?\n/);
	const start = lines.findIndex(line => !INDENTED.test(line) && planStepSource(line, title) !== undefined);
	if (start < 0) {
		return undefined;
	}
	const detail: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (!line.trim()) {
			continue;
		}
		if (!INDENTED.test(line)) {
			break;
		}
		const text = withoutTrailingFiles(line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, ''));
		if (text && !isFileList(text)) {
			detail.push(text);
		}
	}
	return detail.join(' ');
}

/**
 * `text` without the backticked file names that follow its last sentence, such
 * as "Codes are stored upper case. `a.ts` `b.ts`". A sentence that names a file
 * as its object ("Update `a.ts`") keeps it.
 */
function withoutTrailingFiles(text: string): string {
	const match = /^(?<sentence>.*[.!?])(?:[\s,;]*`[^`\s]+\.[A-Za-z][A-Za-z0-9]{0,7}`)+[\s,;.]*$/.exec(text);
	return match?.groups ? match.groups.sentence : text;
}

/** Whether `text` only names backticked files, such as "Files: `a.ts`, `b.ts`". */
function isFileList(text: string): boolean {
	return /`[^`]+\.[A-Za-z][A-Za-z0-9]{0,7}`/.test(text)
		&& text.replace(/`[^`]+`/g, '').replace(/^files?:/i, '').replace(/\band\b|[\s,;.]/gi, '') === '';
}

/**
 * The plan as a Markdown file: title, the details (or the summary), then a
 * "To-dos" heading over a numbered step list with detail and files, then the
 * user's notes when there are any. With the Markdown the plan came from, step
 * titles keep their bold and code.
 */
export function planToMarkdown(plan: PlanArtifact, notes: string, source?: string): string {
	const lines = [`# ${oneLine(plan.title)}`, ''];
	const prose = plan.details ?? plan.summary;
	if (prose) {
		lines.push(prose, '');
	}
	// The heading marks which list holds the to-dos, so lists in the details or notes are never read as to-dos.
	lines.push('## To-dos', '');
	plan.steps.forEach((step, index) => {
		const box = step.status === 'done' ? '[x] ' : '';
		lines.push(`${index + 1}. ${box}${oneLine((source !== undefined ? planStepSource(source, step.title) : undefined) ?? step.title)}`);
		if (step.detail) {
			lines.push(`   ${oneLine(step.detail)}`);
		}
		if (step.files && step.files.length > 0) {
			lines.push(`   Files: ${step.files.map(file => `\`${file}\``).join(', ')}`);
		}
		if (step.depends && step.depends.length > 0) {
			lines.push(`   Depends: ${step.depends.join(', ')}`);
		}
	});
	const trimmed = notes.trim();
	if (trimmed) {
		lines.push('', '## Notes', '', trimmed);
	}
	lines.push('');
	return lines.join('\n');
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}
