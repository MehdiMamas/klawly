/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { CLAUDE_DELEGATE_TEMPLATE_LABELS, isClaudeDelegateTemplate } from '../../../../platform/claude/common/claudeDelegateTemplates.js';
import { ClaudeWorkersViewThresholds } from '../../../../platform/claude/common/claudeWorkersViewSettings.js';
import { canRestartWorker } from './claudeWorkerControls.js';
import { ClaudeWorkerState, IClaudeWorkerRun, isEndedWorkerState } from './claudeWorkerRegistry.js';

/** A flag on a row. `idle` is a finished run nobody stopped; `hung` is a working run that went silent. */
export type ClaudeWorkerFlag = 'idle' | 'hung' | 'messages' | 'quiet';

/** What the view needs from the registry, so row building stays a plain function. */
export interface ClaudeWorkersSource {
	all(): readonly IClaudeWorkerRun[];
	subtreeCost(id: string): number;
}

export interface ClaudeWorkerRow {
	readonly id: string;
	readonly number: string;
	readonly depth: number;
	readonly name: string;
	/** The state in plain words, with the reason when there is one. */
	readonly stateText: string;
	readonly state: ClaudeWorkerState;
	readonly modelText: string;
	/** For a worker that started from a delegate template: its plain name and how it runs (issue 1110). */
	readonly templateText?: string;
	readonly contextTokens: number;
	readonly costUsd: number;
	/** The run's own cost plus every descendant's. Equal to `costUsd` when it has no children. */
	readonly subtreeCostUsd: number;
	readonly hasChildren: boolean;
	/** A finished row folds into one line until the user opens it. */
	readonly collapsed: boolean;
	readonly flags: readonly ClaudeWorkerFlag[];
}

const MINUTE = 60_000;

/** The flags a run carries at `now`. Thresholds of 0 turn their flag off. */
export function workerFlags(run: IClaudeWorkerRun, now: number, thresholds: ClaudeWorkersViewThresholds): readonly ClaudeWorkerFlag[] {
	const flags: ClaudeWorkerFlag[] = [];
	if (run.state === 'finished' && thresholds.finishedMinutes > 0 && now - (run.endedAt ?? run.lastEventAt) >= thresholds.finishedMinutes * MINUTE) {
		flags.push('idle');
	}
	if (run.state === 'working' && thresholds.hungMinutes > 0 && now - run.lastEventAt >= thresholds.hungMinutes * MINUTE) {
		flags.push('hung');
	}
	if ((run.messagesWaiting ?? 0) > 0) {
		flags.push('messages');
	}
	if (run.quiet && isEndedWorkerState(run.state)) {
		flags.push('quiet');
	}
	return flags;
}

/** The state in plain words. A producer's own wording wins; otherwise the state name. */
export function workerStateText(run: IClaudeWorkerRun): string {
	if (run.stateDetail) {
		return run.stateDetail;
	}
	switch (run.state) {
		case 'queued': return localize('claudeWorkerQueued', "queued");
		case 'working': return localize('claudeWorkerWorking', "working");
		case 'waiting': return localize('claudeWorkerWaiting', "waiting");
		case 'finished': return localize('claudeWorkerFinished', "finished");
		case 'failed': return localize('claudeWorkerFailed', "failed");
		case 'stopped': return localize('claudeWorkerStopped', "stopped");
	}
}

/** The flag in plain words, with what to do next. Restart is named only when the run can be restarted. */
export function workerFlagText(flag: ClaudeWorkerFlag, run: IClaudeWorkerRun, thresholds: ClaudeWorkersViewThresholds): string {
	switch (flag) {
		case 'idle': return localize('claudeWorkerFlagIdle', "Finished more than {0} min ago and is still open.", thresholds.finishedMinutes);
		case 'hung': return canRestartWorker(run)
			? localize('claudeWorkerFlagHungRestart', "No news for over {0} min. It may be stuck; stop it or restart it.", thresholds.hungMinutes)
			: localize('claudeWorkerFlagHung', "No news for over {0} min. It may be stuck; stop it.", thresholds.hungMinutes);
		case 'messages': {
			const count = run.messagesWaiting ?? 0;
			return count === 1
				? localize('claudeWorkerFlagMessagesOne', "1 message was sent to it and it has not read it yet. It reads them when its current step ends.")
				: localize('claudeWorkerFlagMessagesMany', "{0} messages were sent to it and it has not read them yet. It reads them when its current step ends.", count);
		}
		case 'quiet': return localize('claudeWorkerFlagQuiet', "Finished with nothing to report. Check what it did below.");
	}
}

/** "haiku, medium effort" style text for a row. */
export function workerModelText(run: IClaudeWorkerRun): string {
	return run.effort ? localize('claudeWorkerModelEffort', "{0}, {1} effort", run.model, run.effort) : run.model;
}

/** "Watch CI · Small tier, reports failures only" for a worker that started from a delegate template, else undefined. */
export function workerTemplateText(run: IClaudeWorkerRun): string | undefined {
	if (!isClaudeDelegateTemplate(run.template)) {
		return undefined;
	}
	return localize('claudeWorkerTemplate', "{0} · Small tier, reports failures only", CLAUDE_DELEGATE_TEMPLATE_LABELS[run.template]);
}

/** The tree as flat rows in reading order. Children of a collapsed (finished) row are omitted unless it is in `expanded`. */
export function buildWorkerRows(source: ClaudeWorkersSource, now: number, thresholds: ClaudeWorkersViewThresholds, expanded: ReadonlySet<string> = new Set()): readonly ClaudeWorkerRow[] {
	const runs = source.all();
	const byParent = new Map<string | undefined, IClaudeWorkerRun[]>();
	for (const run of runs) {
		const list = byParent.get(run.parentId) ?? [];
		list.push(run);
		byParent.set(run.parentId, list);
	}
	const rows: ClaudeWorkerRow[] = [];
	const walk = (parentId: string | undefined, depth: number) => {
		for (const run of byParent.get(parentId) ?? []) {
			const children = byParent.get(run.id) ?? [];
			const collapsed = run.state === 'finished' && !expanded.has(run.id);
			rows.push({
				id: run.id,
				number: run.number,
				depth,
				name: run.name,
				stateText: workerStateText(run),
				state: run.state,
				modelText: workerModelText(run),
				...(workerTemplateText(run) ? { templateText: workerTemplateText(run) } : {}),
				contextTokens: run.contextTokens ?? 0,
				costUsd: run.costUsd ?? 0,
				subtreeCostUsd: source.subtreeCost(run.id),
				hasChildren: children.length > 0,
				collapsed,
				flags: workerFlags(run, now, thresholds),
			});
			if (!collapsed) {
				walk(run.id, depth + 1);
			}
		}
	};
	walk(undefined, 0);
	return rows;
}

/** A step a worker took, as the chat records it. */
export interface ClaudeWorkerStep {
	readonly tool: string;
	readonly state: 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted';
}

const STEP_VERBS: Readonly<Record<string, () => string>> = {
	Read: () => localize('claudeWorkerStepRead', "read files"),
	Edit: () => localize('claudeWorkerStepEdit', "edited files"),
	Write: () => localize('claudeWorkerStepWrite', "wrote files"),
	Bash: () => localize('claudeWorkerStepBash', "ran commands"),
	Grep: () => localize('claudeWorkerStepSearch', "searched the code"),
	Glob: () => localize('claudeWorkerStepSearch', "searched the code"),
};

/** Steps in plain words, such as "read files (3), ran commands (2, 1 failed)". Never a raw tool dump. */
export function summarizeWorkerSteps(steps: readonly ClaudeWorkerStep[]): string {
	if (steps.length === 0) {
		return localize('claudeWorkerNoSteps', "No steps yet.");
	}
	const groups = new Map<string, { count: number; failed: number }>();
	for (const step of steps) {
		const verb = (STEP_VERBS[step.tool] ?? (() => localize('claudeWorkerStepOther', "used other tools")))();
		const group = groups.get(verb) ?? { count: 0, failed: 0 };
		group.count++;
		if (step.state === 'failed') {
			group.failed++;
		}
		groups.set(verb, group);
	}
	return [...groups].map(([verb, g]) => g.failed
		? localize('claudeWorkerStepGroupFailed', "{0} ({1}, {2} failed)", verb, g.count, g.failed)
		: localize('claudeWorkerStepGroup', "{0} ({1})", verb, g.count)).join(', ');
}

export interface ClaudeWorkerDetail {
	readonly title: string;
	/** Short lines for the header card, each readable alone. */
	readonly facts: readonly string[];
	readonly flags: readonly string[];
	readonly steps: string;
	readonly report: string;
}

/** The detail view of one run: a header card, its steps in plain words, its report and cost. */
export function buildWorkerDetail(run: IClaudeWorkerRun, steps: readonly ClaudeWorkerStep[], subtreeCostUsd: number, now: number, thresholds: ClaudeWorkersViewThresholds): ClaudeWorkerDetail {
	const facts = [
		localize('claudeWorkerFactState', "{0} · {1}", run.number, workerStateText(run)),
		workerModelText(run),
		localize('claudeWorkerFactCost', "Cost {0} (with workers under it {1})", formatWorkerCost(run.costUsd ?? 0), formatWorkerCost(subtreeCostUsd)),
		localize('claudeWorkerFactAge', "Last news {0} min ago", Math.floor((now - run.lastEventAt) / MINUTE)),
	];
	if (run.objective) {
		facts.push(localize('claudeWorkerFactObjective', "Goal: {0}", run.objective));
	}
	return {
		title: run.name,
		facts,
		flags: workerFlags(run, now, thresholds).map(flag => workerFlagText(flag, run, thresholds)),
		steps: summarizeWorkerSteps(steps),
		report: run.report?.trim() || (isEndedWorkerState(run.state)
			? localize('claudeWorkerNoReport', "No report.")
			: localize('claudeWorkerReportPending', "No report yet.")),
	};
}

export function formatWorkerCost(usd: number): string {
	return `$${usd.toFixed(usd >= 1 ? 2 : 3)}`;
}
