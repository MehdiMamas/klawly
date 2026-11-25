/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Issue 1388: the work rules Klawly ships, so its agents follow them without any extra tooling.
 * The runtime reads the setting when a session starts; nothing here is personal (no names, emails,
 * machine modes or per-user approvals).
 */
export const CLAUDE_WORK_RULES_SETTING = 'claude.agent.workRules';

/** On unless the setting is explicitly `false`, so a missing or bad value keeps the rules. */
export function readClaudeWorkRules(value: unknown): boolean {
	return value !== false;
}

/** An instruction to Claude, not UI text, so it is not localized. */
export const CLAUDE_WORK_RULES_INSTRUCTIONS = [
	'# Work rules',
	'- Autonomy: steer by veto. Do reversible work (edits, branches, commits, pushes to non-main branches, tests, pull requests) without asking. Ask first for anything public under the user\'s name, spending money, releases, destroying data, or secrets. Never end with an offer for something you may just do.',
	'- Helpers: at most manager, then coordinator, then helper. A helper does one task and stops. A helper at the depth limit starts no more helpers.',
	'- Acceptance criteria: every task has them. Write them yourself when none were given, and check the work against them before saying it is done.',
	'- Issue first: work belongs to an issue before it starts. Update the issue at milestones; close it only when shipped and verified.',
	'- Worktrees: start every change in its own git worktree under `.worktrees/<branch>` (gitignored). Keep the main checkout on the default branch. Never use `git stash`; make a WIP commit instead.',
	'- Testing is tiered by size and risk. Tier 0 (every edit, local): format, lint, typecheck and unit tests of what changed. Tier 1 (small fix): one quick job on one OS covering the changed files. Tier 2 (normal pull request): affected tests on every supported OS plus a full typecheck, once when the PR is ready, never per commit. Tier 3 (release): full suite, end-to-end, packaging.',
	'- One CI run per branch. Never merge a pull request whose checks failed, are still running, or never started; find out why first.',
	'- Proof: say that something works only with the command and its result (exit code, test counts, run URL) and the OS that ran it. Say plainly what was not run.',
	'- Models: plan and review with the strongest model, build with a mid-size one, and hand lookups and watching CI to the smallest.',
].join('\n');

/** The system prompt addition for the work rules, or undefined when they are off. */
export function claudeWorkRulesInstructions(enabled: boolean | undefined): string | undefined {
	return enabled === false ? undefined : CLAUDE_WORK_RULES_INSTRUCTIONS;
}
