/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ClaudeDelegateToolArgs } from './claudeDelegate.js';
import { CLAUDE_DELEGATE_QUIET_MARKER } from './claudeDelegateContract.js';
import { CLAUDE_CI_WAIT_TOOL, CLAUDE_MERGE_GATE_TOOL, CLAUDE_VERIFY_TOOL } from './claudeNoModelTools.js';

/**
 * Delegation templates (issue 845): common cheap jobs that need no written
 * brief. `klawly_delegate` takes `template` and `args`; the template fixes the
 * task, runs on the small tier, and reports failures only, in at most 100 words.
 * Each one waits with a no-model tool or one background command, never a
 * polling loop.
 */
export type ClaudeDelegateTemplate = 'watch-ci' | 'run-tests' | 'merge-pr' | 'find';

export const CLAUDE_DELEGATE_TEMPLATES: readonly ClaudeDelegateTemplate[] = ['watch-ci', 'run-tests', 'merge-pr', 'find'];

/** The plain names the user sees for the templates (Workers view, `/` menu). */
export const CLAUDE_DELEGATE_TEMPLATE_LABELS: Readonly<Record<ClaudeDelegateTemplate, string>> = {
	'watch-ci': 'Watch CI',
	'run-tests': 'Run Tests',
	'merge-pr': 'Merge Pull Request',
	'find': 'Find',
};

/** A template's report is cut at this many words. */
export const CLAUDE_DELEGATE_TEMPLATE_REPORT_MAX_WORDS = 100;

/** What the delegate tool says about templates; part of the tool description. */
export const CLAUDE_DELEGATE_TEMPLATE_DESCRIPTION = `Instead of a task you may give template and args for a common cheap job: watch-ci (args: a pull request number or a run id), run-tests (args: the test command), merge-pr (args: the pull request number) and find (args: the question). A template always runs on the small tier and reports failures only, in at most ${CLAUDE_DELEGATE_TEMPLATE_REPORT_MAX_WORDS} words.`;

interface TemplateDefinition {
	readonly task: (args: string) => string;
	readonly name: (args: string) => string;
	readonly acceptance: string;
	/** Why the args cannot be used, or undefined. */
	readonly problem: (args: string) => string | undefined;
}

const SHORT_REPORT = `Report failures only, in at most ${CLAUDE_DELEGATE_TEMPLATE_REPORT_MAX_WORDS} words. If nothing failed, end with ${CLAUDE_DELEGATE_QUIET_MARKER}.`;
const NO_POLLING = 'Never wait in a loop of tool calls: use one background command or the no-model tools.';

const TEMPLATES: Readonly<Record<ClaudeDelegateTemplate, TemplateDefinition>> = {
	'watch-ci': {
		task: args => [
			`Wait for CI on ${args} and report how it ended.`,
			`Use the ${CLAUDE_CI_WAIT_TOOL} tool (pass pr for a pull request number, run for a run id). ${NO_POLLING}`,
			'On a failure give the run URL, the failing job and step, and the last lines of that step. On success give the run URL only.',
			SHORT_REPORT,
		].join('\n'),
		name: args => `Watch CI ${args}`,
		acceptance: 'The CI result (success, or the failing job) is reported with the run URL.',
		problem: args => /^(#?\d+|\S+\s+#?\d+|https?:\/\/\S+)$/.test(args) ? undefined : 'Watch CI needs a pull request number or a run id.',
	},
	'run-tests': {
		task: args => [
			`Run the tests with: ${args}`,
			`Use the ${CLAUDE_VERIFY_TOOL} tool when the command is the repo's own test tier; otherwise run the command once in the background and read its log. ${NO_POLLING}`,
			'Report the counts, and for each failing test its file:line and the last error lines. Do not fix anything.',
			SHORT_REPORT,
		].join('\n'),
		name: args => `Run Tests: ${args.slice(0, 40)}`,
		acceptance: 'The command ran once and the result is reported as counts, with every failing test named.',
		problem: args => args ? undefined : 'Run Tests needs the test command.',
	},
	'merge-pr': {
		task: args => [
			`Merge pull request ${args} through the ${CLAUDE_MERGE_GATE_TOOL} tool.`,
			`Call it with dry_run first. If it refuses, report why and stop. If checks are still running, call ${CLAUDE_CI_WAIT_TOOL} once and merge when it reports success. ${NO_POLLING}`,
			'Never merge around a refusal. Report the merge result.',
			SHORT_REPORT,
		].join('\n'),
		name: args => `Merge Pull Request ${args}`,
		acceptance: 'The pull request is merged, or the reason it was refused is reported.',
		problem: args => /^#?\d+$/.test(args) ? undefined : 'Merge Pull Request needs a pull request number.',
	},
	'find': {
		task: args => [
			`Find the answer to this by searching the project (read-only, change nothing): ${args}`,
			'Give the answer with the file paths and line numbers that show it. Use as few tool calls as you can.',
			`Report in at most ${CLAUDE_DELEGATE_TEMPLATE_REPORT_MAX_WORDS} words. If it is not found, say so.`,
		].join('\n'),
		name: args => `Find: ${args.slice(0, 40)}`,
		acceptance: 'The answer is given with file:line evidence, or the report says it was not found.',
		problem: args => args ? undefined : 'Find needs the question.',
	},
};

/** True when the name is a template this build knows. */
export function isClaudeDelegateTemplate(name: unknown): name is ClaudeDelegateTemplate {
	return typeof name === 'string' && (CLAUDE_DELEGATE_TEMPLATES as readonly string[]).includes(name);
}

/** Why the template call cannot run, or undefined when it can. */
export function claudeDelegateTemplateProblem(template: string, args: string | undefined): string | undefined {
	if (!isClaudeDelegateTemplate(template)) {
		return `template is one of ${CLAUDE_DELEGATE_TEMPLATES.join(', ')}.`;
	}
	return TEMPLATES[template].problem((args ?? '').trim());
}

/**
 * The delegate call a template stands for: its task, the small tier and a
 * short budget. Fields set next to the template are kept, except the tier,
 * which is always small.
 */
export function expandClaudeDelegateTemplate(call: ClaudeDelegateToolArgs): ClaudeDelegateToolArgs {
	const template = call.template;
	if (!isClaudeDelegateTemplate(template) || claudeDelegateTemplateProblem(template, call.args)) {
		return call;
	}
	const args = (call.args ?? '').trim();
	const definition = TEMPLATES[template];
	return {
		...call,
		task: definition.task(args),
		title: call.title ?? definition.name(args),
		acceptance: call.acceptance ?? definition.acceptance,
		budget: call.budget ?? { calls: 25 },
		tier: 'small',
		reason: `Template ${template}: a cheap job with a fixed brief.`,
	};
}
