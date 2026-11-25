/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { claudeReviewDepthAutomationLine, ClaudeReviewDepthSetting } from '../../../../platform/claude/common/claudeReviewDepth.js';
import { localize } from '../../../../nls.js';
import { ClaudeAutomationScope } from '../../../../platform/claude/common/claudeAutomation.js';
import { CLAUDE_REVIEW_REACTION_ALLOWED_TOOLS, CLAUDE_REVIEW_STATUS_ALLOWED_TOOL, CLAUDE_REVIEW_STATUS_CONTEXT } from '../../../../platform/claude/common/claudeAutomationGitHub.js';
import { CLAUDE_SECURITY_FINDING_FORMAT } from '../../../../platform/claude/common/claudeSecurityFindings.js';
import { ClaudeAutomationDraft, emptyClaudeAutomationDraft } from './claudeAutomationDraft.js';

/**
 * Ready-made automations the New Automation form starts from (issue 506). A
 * template only fills the form: the person still names the repository, reads
 * the prompt and saves it, and nothing runs until then. The security
 * templates (issue 507) are read-only too.
 */
export type ClaudeAutomationTemplateId = 'blank' | 'reviewPullRequests' | 'securityScan' | 'securityReviewPullRequests';

export interface ClaudeAutomationTemplate {
	readonly id: ClaudeAutomationTemplateId;
	readonly label: string;
	readonly description: string;
}

export function claudeAutomationTemplates(): readonly ClaudeAutomationTemplate[] {
	return [
		{ id: 'blank', label: localize('claudeAutomationTemplateBlank', "Blank"), description: localize('claudeAutomationTemplateBlankDesc', "Every field empty") },
		{ id: 'reviewPullRequests', label: localize('claudeAutomationTemplateReview', "Review Pull Requests"), description: localize('claudeAutomationTemplateReviewDesc', "Reviews each new or updated pull request, and any that a comment asks to review, read-only") },
		{ id: 'securityScan', label: localize('claudeAutomationTemplateSecurityScan', "Security Scan"), description: localize('claudeAutomationTemplateSecurityScanDesc', "Scans the whole repository for vulnerabilities every Monday, with npm audit or pip-audit when present, read-only") },
		{ id: 'securityReviewPullRequests', label: localize('claudeAutomationTemplateSecurityReview', "Security Review on Pull Requests"), description: localize('claudeAutomationTemplateSecurityReviewDesc', "Reviews each new or updated pull request for security problems only, read-only") },
	];
}

/**
 * The read-only tools a pull request review needs. Posting (`gh pr review`,
 * `gh pr comment`) is left out on purpose: the run is denied and needs you,
 * so nothing reaches GitHub without your approval.
 */
const REVIEW_ALLOWED_TOOLS = [
	'Read',
	'Grep',
	'Glob',
	'Bash(gh pr diff:*)',
	'Bash(gh pr view:*)',
	'Bash(git diff:*)',
	'Bash(git log:*)',
	'Bash(git show:*)',
];

/**
 * The review's tools. With `postStatus` on (issue 928) they also allow the
 * `gh api` calls that set the commit status and react to the request; with it off the call is absent,
 * so the run is denied and needs you.
 */
export function claudeReviewAllowedTools(postStatus: boolean): readonly string[] {
	return postStatus ? [...REVIEW_ALLOWED_TOOLS, CLAUDE_REVIEW_STATUS_ALLOWED_TOOL, ...CLAUDE_REVIEW_REACTION_ALLOWED_TOOLS] : REVIEW_ALLOWED_TOOLS;
}

const REVIEW_STATUS_PROMPT = [
	'',
	`Also report the result as the commit status "${CLAUDE_REVIEW_STATUS_CONTEXT}" on the head commit with \`gh api repos/<owner/name>/statuses/<sha> -f state=<state> -f context="${CLAUDE_REVIEW_STATUS_CONTEXT}" -f description=<short text>\`:`,
	'- `pending` before you start reading the change.',
	'- `success` when no finding is at or above the lowest severity the person set, `failure` with a short description of the count otherwise.',
	'- `error` if you cannot finish the review, whatever the reason.',
	'',
	'Also react while you work: add the `eyes` reaction with `gh api repos/<owner/name>/issues/comments/<comment id>/reactions -f content=eyes` on the comment that asked for the review, or with `gh api repos/<owner/name>/issues/<number>/reactions -f content=eyes` on the pull request when no comment asked. When you are done, add `+1` the same way when the status is `success` and `-1` when it is `failure` or `error`.',
].join('\n');

// The prompt goes to Claude, so it is not localized; the person can edit it in the form.
const REVIEW_PROMPT = [
	'Review the pull request in the trigger below. This is a read-only review: do not edit, commit, push or post anything.',
	'',
	'1. Read the change with `gh pr diff <number> --repo <owner/name>` and its description with `gh pr view <number> --repo <owner/name>`.',
	'2. Follow the project\'s review notes when there are any: REVIEW.md or .claude/review.md at the root, and a REVIEW.md in any folder the change touches. Nested notes add to the root ones.',
	'3. Look for bugs, security problems and real quality issues the change brings in. Skip style nits a formatter or linter would catch.',
	'4. Answer with one finding per line: `path:line [high|medium|low] what is wrong, and how to fix it`. Write "No findings." when there are none.',
	'',
	'5. Earlier Klawly Review comments on the pull request may end with `<!-- klawly-reviewed-sha: <sha> -->`. When the last one names a commit still in the branch, review only `git diff <sha>..HEAD`, then say which earlier findings that diff addressed and which are still open. `@klawly review all` ignores it and reviews the whole change. End the answer with `<!-- klawly-reviewed-sha: <head sha> -->` (`gh pr view <number> --json headRefOid`).',
	'',
	'6. The trigger may be an `@klawly` comment. For `@klawly review quick` keep to the most serious problems; for `@klawly review deep` follow callers and callees outside the diff; for `@klawly review <question>` treat the question as an extra focus. For `@klawly remember <rule>` do not review: answer with the one line to add to REVIEW.md, as `Rule: <text>`, and stop. The person approves it before it is written.',
].join('\n');

const REVIEW_POSTING_PROMPT = [
	'',
	'The findings stay in Klawly. To post them, the person opens this run and asks; `gh pr review` then asks them first.',
].join('\n');

/** Asked for ahead of the findings when the review summary setting is on (issue 918). */
const REVIEW_SUMMARY_PROMPT = [
	'',
	'Open the answer with a summary, before the findings: a heading "Summary", then an overview of what the change does in two or three sentences, then one line per changed file: `path [low|medium|high] what changed`, where the bracket is how risky the change to that file is.',
].join('\n');

/** What a security scan may run: reading, and the dependency audits, which only report. */
const SECURITY_SCAN_ALLOWED_TOOLS = [
	'Read',
	'Grep',
	'Glob',
	'Bash(npm audit:*)',
	'Bash(pip-audit:*)',
	'Bash(git log:*)',
];

const SECURITY_SCAN_PROMPT = [
	'Scan this repository for security vulnerabilities. This is a read-only scan: do not edit, commit, push or post anything.',
	'',
	'1. Find the code that takes outside input (HTTP handlers, CLI arguments, files, environment, messages) and follow it to where it is used.',
	'2. Look for injection (SQL, shell, path, template), broken authentication or authorization, secrets in the code, unsafe deserialization, SSRF, XSS and weak cryptography.',
	'3. When the repository has a package-lock.json, run `npm audit --omit=dev`; when it has requirements files or a pyproject.toml, run `pip-audit` if it is installed. Report only advisories that the code can reach.',
	'4. Skip theoretical issues with no path from outside input.',
	'',
	`Answer with one finding per line: ${CLAUDE_SECURITY_FINDING_FORMAT}. Write "No findings." when there are none. To fix one, the person opens this run and asks.`,
].join('\n');

const SECURITY_REVIEW_PROMPT = [
	'Review the pull request in the trigger below for security problems only. This is a read-only review: do not edit, commit, push or post anything.',
	'',
	'1. Read the change with `gh pr diff <number> --repo <owner/name>`.',
	'2. Look for what the change brings in: injection (SQL, shell, path, template), broken authentication or authorization, secrets, unsafe deserialization, SSRF, XSS, weak cryptography, and new dependencies with known advisories.',
	'3. Skip findings that were there before the change and anything without a path from outside input.',
	'',
	`Answer with one finding per line: ${CLAUDE_SECURITY_FINDING_FORMAT}. Write "No findings." when there are none. Posting them waits for the person.`,
].join('\n');

/** The form's fields for a template. `blank` is the empty form. */
export function claudeAutomationTemplateDraft(id: ClaudeAutomationTemplateId, scope: ClaudeAutomationScope, postStatus = false, summary = false, depth: ClaudeReviewDepthSetting = 'auto'): ClaudeAutomationDraft {
	const draft = emptyClaudeAutomationDraft(scope);
	switch (id) {
		case 'blank':
			return draft;
		case 'reviewPullRequests':
			return {
				...draft,
				name: localize('claudeAutomationTemplateReviewName', "Review Pull Requests"),
				prompt: [REVIEW_PROMPT, claudeReviewDepthAutomationLine(depth), REVIEW_POSTING_PROMPT, summary ? REVIEW_SUMMARY_PROMPT : '', postStatus ? REVIEW_STATUS_PROMPT : ''].filter(part => part).join('\n'),
				trigger: 'githubPullRequest',
				pullRequest: 'openedUpdatedOrCommented',
				comment: '@klawly review',
				permissionMode: 'agent',
				budget: '2',
				maxTurns: '40',
				allowedTools: claudeReviewAllowedTools(postStatus).join('\n'),
			};
		case 'securityScan':
			return {
				...draft,
				name: localize('claudeAutomationTemplateSecurityScanName', "Security Scan"),
				prompt: SECURITY_SCAN_PROMPT,
				trigger: 'schedule',
				cron: '0 9 * * 1',
				permissionMode: 'agent',
				budget: '3',
				maxTurns: '60',
				allowedTools: SECURITY_SCAN_ALLOWED_TOOLS.join('\n'),
			};
		case 'securityReviewPullRequests':
			return {
				...draft,
				name: localize('claudeAutomationTemplateSecurityReviewName', "Security Review on Pull Requests"),
				prompt: SECURITY_REVIEW_PROMPT,
				trigger: 'githubPullRequest',
				pullRequest: 'openedOrUpdated',
				permissionMode: 'agent',
				budget: '2',
				maxTurns: '40',
				allowedTools: REVIEW_ALLOWED_TOOLS.join('\n'),
			};
	}
}
