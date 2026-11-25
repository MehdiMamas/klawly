/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { AgentMode } from '../../../../platform/claude/common/claudeContext.js';
import { CLAUDE_AUTOMATION_DEFAULT_BUDGET_USD, ClaudeAutomation, ClaudeAutomationEntry, ClaudeAutomationRunState, ClaudeAutomationScope, ClaudeAutomationTrigger, ClaudeAutomationTriggerType, isClaudeAutomationId, parseClaudeCron } from '../../../../platform/claude/common/claudeAutomation.js';
import { ClaudeGitHubPullRequestAction, isClaudeGitHubBranch, isClaudeGitHubRepo, readClaudeGitHubPullRequestFilters } from '../../../../platform/claude/common/claudeAutomationGitHub.js';
import { isClaudeEffortLevel } from '../../../../platform/claude/common/claudeSessionSettings.js';

/** The pull request events the form offers, as one choice. A file can list any mix in `on`. */
export type ClaudeAutomationPullRequestChoice = 'opened' | 'openedOrUpdated' | 'labeled' | 'commented' | 'openedUpdatedOrCommented';

export const CLAUDE_AUTOMATION_PULL_REQUEST_CHOICES: readonly ClaudeAutomationPullRequestChoice[] = ['opened', 'openedOrUpdated', 'labeled', 'commented', 'openedUpdatedOrCommented'];

function pullRequestChoice(on: readonly ClaudeGitHubPullRequestAction[]): ClaudeAutomationPullRequestChoice {
	if (on.includes('commented')) {
		return on.includes('opened') && on.includes('updated') ? 'openedUpdatedOrCommented' : 'commented';
	}
	if (on.includes('labeled')) {
		return 'labeled';
	}
	return on.includes('updated') ? 'openedOrUpdated' : 'opened';
}

function pullRequestActions(choice: ClaudeAutomationPullRequestChoice): ClaudeGitHubPullRequestAction[] {
	switch (choice) {
		case 'openedOrUpdated': return ['opened', 'updated'];
		case 'openedUpdatedOrCommented': return ['opened', 'updated', 'commented'];
		default: return [choice];
	}
}

/** The automation editor's fields, as typed. */
export interface ClaudeAutomationDraft {
	name: string;
	prompt: string;
	scope: ClaudeAutomationScope;
	trigger: ClaudeAutomationTriggerType;
	cron: string;
	glob: string;
	task: string;
	permissionMode: AgentMode;
	/** Empty: the model a new session gets. */
	model: string;
	/** Empty: the model's default effort. */
	effort: string;
	budget: string;
	/** Empty: `CLAUDE_AUTOMATION_DEFAULT_MAX_TURNS`. */
	maxTurns: string;
	/** One rule per line. */
	allowedTools: string;
	enabled: boolean;
	/** An on-save debounce from the file; the form does not show it. */
	debounceMs?: number;
	/** GitHub `owner/name`, for the GitHub triggers (issue 518). */
	repo: string;
	/** Pull request trigger: what starts a run. */
	pullRequest: ClaudeAutomationPullRequestChoice;
	/** The pull request events from the file, kept while the choice still describes them. */
	pullRequestOn?: readonly ClaudeGitHubPullRequestAction[];
	label: string;
	comment: string;
	/** Pull request "Only when" filters (issue 924): comma or line separated lists, empty: no filter. */
	authors: string;
	excludeAuthors: string;
	headBranches: string;
	keywords: string;
	skipKeywords: string;
	ignorePaths: string;
	/** Skip draft pull requests (on for a new automation). */
	skipDrafts: boolean;
	/** The push branch, or the base or run branch that limits the other GitHub triggers. Empty: none. */
	branch: string;
	/** Keep `memory.md` between runs. */
	memory: boolean;
	/** Run from the system scheduler while Klawly is closed (issue 463); schedule trigger, read-only. */
	runWhenClosed: boolean;
	/** The memory's text as typed; undefined until it is read, and left alone when unchanged. */
	memoryText?: string;
}

/** The field a draft fails on, and why. */
export interface ClaudeAutomationDraftError {
	readonly field: 'name' | 'prompt' | 'cron' | 'glob' | 'budget' | 'maxTurns' | 'repo' | 'branch' | 'label' | 'comment' | 'authors' | 'excludeAuthors' | 'headBranches' | 'keywords' | 'skipKeywords' | 'ignorePaths';
	readonly message: string;
}

export const CLAUDE_AUTOMATION_TRIGGER_TYPES: readonly ClaudeAutomationTriggerType[] = ['schedule', 'onSave', 'onTaskFailed', 'onTestFailed', 'githubPullRequest', 'githubPush', 'githubCheckFailed', 'manual'];

export function emptyClaudeAutomationDraft(scope: ClaudeAutomationScope): ClaudeAutomationDraft {
	return {
		name: '', prompt: '', scope, trigger: 'schedule', cron: '0 9 * * 1-5', glob: '', task: '', permissionMode: 'agent',
		model: '', effort: '', budget: String(CLAUDE_AUTOMATION_DEFAULT_BUDGET_USD), maxTurns: '', allowedTools: '', enabled: true,
		repo: '', pullRequest: 'opened', label: '', comment: '', branch: '', memory: false, runWhenClosed: false,
		authors: '', excludeAuthors: '', headBranches: '', keywords: '', skipKeywords: '', ignorePaths: '', skipDrafts: false,
	};
}

function filterList(trigger: ClaudeAutomationEntry['trigger'], key: 'authors' | 'excludeAuthors' | 'headBranches' | 'keywords' | 'skipKeywords' | 'ignorePaths'): string {
	return trigger.type === 'githubPullRequest' ? (trigger[key] ?? []).join(', ') : '';
}

/** A filter list as typed: split on commas and new lines, trimmed, without repeats. */
export function parseClaudeAutomationFilterList(value: string): string[] {
	return [...new Set(value.split(/[,\n]/).map(item => item.trim()).filter(item => item))];
}

/** The editor's fields for an automation from a file. */
export function claudeAutomationDraft(automation: ClaudeAutomationEntry): ClaudeAutomationDraft {
	const trigger = automation.trigger;
	return {
		name: automation.name,
		prompt: automation.prompt,
		scope: automation.scope,
		trigger: trigger.type,
		cron: trigger.type === 'schedule' ? trigger.cron : '',
		glob: trigger.type === 'onSave' ? trigger.glob : '',
		task: trigger.type === 'onTaskFailed' ? trigger.task ?? '' : '',
		permissionMode: automation.permissionMode,
		model: automation.model ?? '',
		effort: automation.effort ?? '',
		budget: String(automation.budgetUsd),
		maxTurns: automation.maxTurns === undefined ? '' : String(automation.maxTurns),
		allowedTools: automation.allowedTools.join('\n'),
		enabled: automation.enabled,
		debounceMs: trigger.type === 'onSave' ? trigger.debounceMs : undefined,
		repo: trigger.type === 'githubPullRequest' || trigger.type === 'githubPush' || trigger.type === 'githubCheckFailed' ? trigger.repo : '',
		pullRequest: trigger.type === 'githubPullRequest' ? pullRequestChoice(trigger.on) : 'opened',
		pullRequestOn: trigger.type === 'githubPullRequest' ? trigger.on : undefined,
		label: trigger.type === 'githubPullRequest' ? trigger.label ?? '' : '',
		comment: trigger.type === 'githubPullRequest' ? trigger.comment ?? '' : '',
		branch: trigger.type === 'githubPullRequest' ? trigger.base ?? '' : trigger.type === 'githubPush' || trigger.type === 'githubCheckFailed' ? trigger.branch ?? '' : '',
		authors: filterList(trigger, 'authors'),
		excludeAuthors: filterList(trigger, 'excludeAuthors'),
		headBranches: filterList(trigger, 'headBranches'),
		keywords: filterList(trigger, 'keywords'),
		skipKeywords: filterList(trigger, 'skipKeywords'),
		ignorePaths: filterList(trigger, 'ignorePaths'),
		// A stored trigger without the field keeps today's behaviour: drafts are reviewed.
		skipDrafts: trigger.type === 'githubPullRequest' && trigger.skipDrafts === true,
		memory: automation.memory === true,
		runWhenClosed: automation.runWhenClosed === true,
	};
}

/** An id for a new automation from its name, unique among `taken`. */
export function claudeAutomationIdFor(name: string, taken: ReadonlySet<string>): string {
	const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'automation';
	let id = base;
	for (let n = 2; taken.has(id); n++) {
		id = `${base}-${n}`;
	}
	return id;
}

/** The automation a draft describes, or the first field that is wrong. Only the fields its trigger uses are read. */
export function claudeAutomationOfDraft(draft: ClaudeAutomationDraft, id: string): ClaudeAutomation | ClaudeAutomationDraftError {
	const name = draft.name.trim();
	if (!name) {
		return { field: 'name', message: localize('claudeAutomationNoName', "Name the automation.") };
	}
	const prompt = draft.prompt.trim();
	if (!prompt) {
		return { field: 'prompt', message: localize('claudeAutomationNoPrompt', "Write what Claude does on each run.") };
	}
	let trigger: ClaudeAutomationTrigger;
	switch (draft.trigger) {
		case 'schedule': {
			const cron = draft.cron.trim().replace(/\s+/g, ' ');
			if (!parseClaudeCron(cron)) {
				return { field: 'cron', message: localize('claudeAutomationBadCron', "Enter a schedule of five fields: minute, hour, day of the month, month and weekday, such as 0 9 * * 1-5.") };
			}
			trigger = { type: 'schedule', cron };
			break;
		}
		case 'onSave': {
			const glob = draft.glob.trim();
			if (!glob) {
				return { field: 'glob', message: localize('claudeAutomationNoGlob', "Enter the files whose save starts a run, such as src/**/*.ts.") };
			}
			trigger = draft.debounceMs === undefined ? { type: 'onSave', glob } : { type: 'onSave', glob, debounceMs: draft.debounceMs };
			break;
		}
		case 'onTaskFailed': {
			const task = draft.task.trim();
			trigger = task ? { type: 'onTaskFailed', task } : { type: 'onTaskFailed' };
			break;
		}
		case 'githubPullRequest':
		case 'githubPush':
		case 'githubCheckFailed': {
			const repo = draft.repo.trim();
			if (!isClaudeGitHubRepo(repo)) {
				return { field: 'repo', message: localize('claudeAutomationBadRepo', "Enter a GitHub repository as owner/name, such as octo-org/app.") };
			}
			const branch = draft.branch.trim();
			if (draft.trigger === 'githubPush' ? !isClaudeGitHubBranch(branch) : branch && !isClaudeGitHubBranch(branch)) {
				return { field: 'branch', message: localize('claudeAutomationBadBranch', "Enter a branch name, such as main.") };
			}
			if (draft.trigger === 'githubPush') {
				trigger = { type: 'githubPush', repo, branch };
			} else if (draft.trigger === 'githubCheckFailed') {
				trigger = branch ? { type: 'githubCheckFailed', repo, branch } : { type: 'githubCheckFailed', repo };
			} else {
				const on = draft.pullRequestOn && pullRequestChoice(draft.pullRequestOn) === draft.pullRequest ? draft.pullRequestOn : pullRequestActions(draft.pullRequest);
				const label = draft.label.trim();
				const comment = draft.comment.trim();
				if (on.includes('labeled') && !label) {
					return { field: 'label', message: localize('claudeAutomationNoLabel', "Enter the label that starts a run.") };
				}
				if (on.includes('commented') && !comment) {
					return { field: 'comment', message: localize('claudeAutomationNoComment', "Enter the text a comment must contain, such as @claude review.") };
				}
				trigger = {
					type: 'githubPullRequest', repo, on,
					...(on.includes('labeled') ? { label } : {}),
					...(on.includes('commented') ? { comment } : {}),
					...(branch ? { base: branch } : {}),
					...readClaudeGitHubPullRequestFilters({
						authors: parseClaudeAutomationFilterList(draft.authors), excludeAuthors: parseClaudeAutomationFilterList(draft.excludeAuthors),
						headBranches: parseClaudeAutomationFilterList(draft.headBranches), keywords: parseClaudeAutomationFilterList(draft.keywords),
						skipKeywords: parseClaudeAutomationFilterList(draft.skipKeywords), ignorePaths: parseClaudeAutomationFilterList(draft.ignorePaths),
						skipDrafts: draft.skipDrafts,
					}),
				};
			}
			break;
		}
		default:
			trigger = { type: draft.trigger };
	}
	const budget = Number(draft.budget);
	if (!draft.budget.trim() || !Number.isFinite(budget) || budget <= 0) {
		return { field: 'budget', message: localize('claudeAutomationBadBudget', "Enter a spend cap above 0.") };
	}
	const turns = draft.maxTurns.trim();
	const maxTurns = turns ? Number(turns) : undefined;
	if (maxTurns !== undefined && !(Number.isInteger(maxTurns) && maxTurns > 0)) {
		return { field: 'maxTurns', message: localize('claudeAutomationBadTurns', "Enter a whole number of turns, or leave it empty.") };
	}
	return {
		id: isClaudeAutomationId(id) ? id : 'automation',
		name,
		prompt,
		trigger,
		model: draft.model.trim() || undefined,
		effort: isClaudeEffortLevel(draft.effort) ? draft.effort : undefined,
		permissionMode: draft.permissionMode,
		target: 'worktree',
		budgetUsd: budget,
		maxTurns,
		allowedTools: draft.allowedTools.split(/\r?\n/).map(rule => rule.trim()).filter(rule => rule),
		enabled: draft.enabled,
		...(draft.memory ? { memory: true } : {}),
		...(draft.runWhenClosed && draft.trigger === 'schedule' && draft.permissionMode !== 'agent' ? { runWhenClosed: true } : {}),
	};
}

export function isClaudeAutomationDraftError(value: ClaudeAutomation | ClaudeAutomationDraftError): value is ClaudeAutomationDraftError {
	return 'field' in value;
}

/** The codicon for an automation's trigger, the same in Settings and in the Agents column (DL-10). */
export function claudeAutomationTriggerIcon(type: ClaudeAutomationTriggerType): ThemeIcon {
	switch (type) {
		case 'schedule': return Codicon.watch;
		case 'onSave': return Codicon.save;
		case 'onTaskFailed': return Codicon.terminal;
		case 'onTestFailed': return Codicon.beaker;
		case 'githubPullRequest': return Codicon.gitPullRequest;
		case 'githubPush': return Codicon.repoPush;
		case 'githubCheckFailed': return Codicon.github;
		case 'manual': return Codicon.playCircle;
	}
}

export function claudeAutomationTriggerLabel(type: ClaudeAutomationTriggerType): string {
	switch (type) {
		case 'schedule': return localize('claudeAutomationTriggerSchedule', "Schedule");
		case 'onSave': return localize('claudeAutomationTriggerSave', "On Save");
		case 'onTaskFailed': return localize('claudeAutomationTriggerTask', "Task Fails");
		case 'onTestFailed': return localize('claudeAutomationTriggerTests', "Tests Fail");
		case 'githubPullRequest': return localize('claudeAutomationTriggerPullRequest', "Pull Request");
		case 'githubPush': return localize('claudeAutomationTriggerPush', "Push");
		case 'githubCheckFailed': return localize('claudeAutomationTriggerCheck', "Workflow Fails");
		case 'manual': return localize('claudeAutomationTriggerManual', "Manual");
	}
}

export function claudeAutomationTriggerDescription(type: ClaudeAutomationTriggerType): string {
	switch (type) {
		case 'schedule': return localize('claudeAutomationTriggerScheduleDesc', "On a cron schedule, in local time");
		case 'onSave': return localize('claudeAutomationTriggerSaveDesc', "When a matching file is saved");
		case 'onTaskFailed': return localize('claudeAutomationTriggerTaskDesc', "When a task exits with an error");
		case 'onTestFailed': return localize('claudeAutomationTriggerTestsDesc', "When a test run has a failure");
		case 'githubPullRequest': return localize('claudeAutomationTriggerPullRequestDesc', "When a GitHub pull request is opened, updated, labeled or commented on");
		case 'githubPush': return localize('claudeAutomationTriggerPushDesc', "When a GitHub branch gets new commits");
		case 'githubCheckFailed': return localize('claudeAutomationTriggerCheckDesc', "When a GitHub Actions workflow run fails");
		case 'manual': return localize('claudeAutomationTriggerManualDesc', "Only with Run Now");
	}
}

/** What starts the automation, for its row in the list. */
export function claudeAutomationTriggerSummary(trigger: ClaudeAutomationTrigger): string {
	switch (trigger.type) {
		case 'schedule': return trigger.cron;
		case 'onSave': return localize('claudeAutomationOnSaveOf', "On save of {0}", trigger.glob);
		case 'onTaskFailed': return trigger.task ? localize('claudeAutomationWhenTaskFails', "When {0} fails", trigger.task) : localize('claudeAutomationWhenAnyTaskFails', "When a task fails");
		case 'onTestFailed': return localize('claudeAutomationWhenTestsFail', "When tests fail");
		case 'githubPullRequest': return localize('claudeAutomationOnPullRequest', "Pull requests on {0}: {1}", trigger.repo, claudeAutomationPullRequestChoiceLabel(pullRequestChoice(trigger.on)).toLowerCase());
		case 'githubPush': return localize('claudeAutomationOnPush', "Push to {0} on {1}", trigger.branch, trigger.repo);
		case 'githubCheckFailed': return trigger.branch ? localize('claudeAutomationOnCheckBranch', "Failed workflow runs on {0} {1}", trigger.repo, trigger.branch) : localize('claudeAutomationOnCheck', "Failed workflow runs on {0}", trigger.repo);
		case 'manual': return localize('claudeAutomationRunNowOnly', "Run Now only");
	}
}

export function claudeAutomationPullRequestChoiceLabel(choice: ClaudeAutomationPullRequestChoice): string {
	switch (choice) {
		case 'opened': return localize('claudeAutomationPrOpened', "Opened");
		case 'openedOrUpdated': return localize('claudeAutomationPrUpdated', "Opened or New Commits");
		case 'labeled': return localize('claudeAutomationPrLabeled', "Label Added");
		case 'commented': return localize('claudeAutomationPrCommented', "Comment Contains");
		case 'openedUpdatedOrCommented': return localize('claudeAutomationPrAny', "Opened, New Commits or Comment Contains");
	}
}

export function claudeAutomationRunStateLabel(state: ClaudeAutomationRunState): string {
	switch (state) {
		case 'running': return localize('claudeAutomationRunning', "Running");
		case 'needsYou': return localize('claudeAutomationNeedsYou', "Needs You");
		case 'complete': return localize('claudeAutomationDone', "Done");
		case 'failed': return localize('claudeAutomationFailed', "Failed");
		case 'stopped': return localize('claudeAutomationStopped', "Stopped");
	}
}
