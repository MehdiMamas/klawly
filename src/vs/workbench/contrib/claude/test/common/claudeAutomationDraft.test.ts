/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeAutomationEntry } from '../../../../../platform/claude/common/claudeAutomation.js';
import { claudeAutomationDraft, claudeAutomationIdFor, claudeAutomationOfDraft, claudeAutomationTriggerSummary, emptyClaudeAutomationDraft, isClaudeAutomationDraftError } from '../../common/claudeAutomationDraft.js';
import { claudeReviewRunStatus, claudeReviewStatusDescription } from '../../../../../platform/claude/common/claudeAutomationGitHub.js';
import { ClaudeReviewFinding } from '../../../../../platform/claude/common/claudeReviewLoop.js';
import { claudeAutomationTemplateDraft } from '../../common/claudeAutomationTemplates.js';

suite('Klawly automation draft', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a draft is checked field by field, in the order the form shows them', () => {
		const draft = emptyClaudeAutomationDraft('workspace');
		const errors = [];
		errors.push(claudeAutomationOfDraft(draft, 'x'));
		draft.name = 'Fix tests';
		errors.push(claudeAutomationOfDraft(draft, 'x'));
		draft.prompt = 'Fix them.';
		draft.cron = '0 9 * *';
		errors.push(claudeAutomationOfDraft(draft, 'x'));
		draft.cron = '0 9 * * 1-5';
		draft.budget = '0';
		errors.push(claudeAutomationOfDraft(draft, 'x'));
		draft.budget = '2';
		draft.maxTurns = '1.5';
		errors.push(claudeAutomationOfDraft(draft, 'x'));
		draft.trigger = 'onSave';
		errors.push(claudeAutomationOfDraft(draft, 'x'));
		assert.deepStrictEqual(errors.map(error => isClaudeAutomationDraftError(error) ? error.field : 'ok'), ['name', 'prompt', 'cron', 'budget', 'maxTurns', 'glob']);
	});

	test('a valid draft becomes an automation; only its trigger\'s fields are read', () => {
		const draft = {
			...emptyClaudeAutomationDraft('user'),
			name: ' Lint on save ', prompt: 'Lint.', trigger: 'onSave' as const, cron: 'ignored', glob: 'src/**/*.ts', task: 'ignored',
			model: 'fixture-opus', effort: 'high', budget: '0.5', maxTurns: '12', allowedTools: 'Edit\n\n  Bash(npm run lint:*)  \n',
		};
		assert.deepStrictEqual(claudeAutomationOfDraft(draft, 'lint-on-save'), {
			id: 'lint-on-save', name: 'Lint on save', prompt: 'Lint.', trigger: { type: 'onSave', glob: 'src/**/*.ts' },
			model: 'fixture-opus', effort: 'high', permissionMode: 'agent', target: 'worktree', budgetUsd: 0.5, maxTurns: 12,
			allowedTools: ['Edit', 'Bash(npm run lint:*)'], enabled: true,
		});
	});

	test('an automation from a file round-trips through the form, keeping its on-save debounce', () => {
		const entry: ClaudeAutomationEntry = {
			key: 'workspace:lint', scope: 'workspace', id: 'lint', name: 'Lint', prompt: 'Lint.', trigger: { type: 'onSave', glob: '**/*.ts', debounceMs: 5000 },
			permissionMode: 'plan', target: 'worktree', budgetUsd: 1, allowedTools: ['Edit'], enabled: false,
		};
		const { key: _key, scope: _scope, ...automation } = entry;
		assert.deepStrictEqual(claudeAutomationOfDraft(claudeAutomationDraft(entry), entry.id), { ...automation, model: undefined, effort: undefined, maxTurns: undefined });
	});

	test('GitHub triggers: the form checks the repository and branch, keeps the file\'s events and carries memory (issue 518)', () => {
		const base = { ...emptyClaudeAutomationDraft('user'), name: 'Review', prompt: 'Review it.' };
		const pullRequest: ClaudeAutomationEntry = {
			key: 'user:review', scope: 'user', id: 'review', name: 'Review', prompt: 'Review it.', trigger: { type: 'githubPullRequest', repo: 'octo-org/app', on: ['updated', 'opened'], base: 'main' },
			permissionMode: 'ask', target: 'worktree', budgetUsd: 1, allowedTools: [], enabled: true, memory: true,
		};
		const result = (draft: Parameters<typeof claudeAutomationOfDraft>[0]) => {
			const automation = claudeAutomationOfDraft(draft, 'review');
			return isClaudeAutomationDraftError(automation) ? automation.field : [automation.trigger, automation.memory];
		};
		assert.deepStrictEqual([
			result({ ...base, trigger: 'githubPush', repo: 'octo-org' }),
			result({ ...base, trigger: 'githubPush', repo: 'octo-org/app' }),
			result({ ...base, trigger: 'githubPush', repo: ' octo-org/app ', branch: 'release/1.0', memory: true }),
			result({ ...base, trigger: 'githubCheckFailed', repo: 'octo-org/app' }),
			result({ ...base, trigger: 'githubPullRequest', repo: 'octo-org/app', pullRequest: 'labeled' }),
			result({ ...base, trigger: 'githubPullRequest', repo: 'octo-org/app', pullRequest: 'commented', comment: '@claude review', label: 'ignored' }),
			result(claudeAutomationDraft(pullRequest)),
			result({ ...claudeAutomationDraft(pullRequest), pullRequest: 'opened' }),
		], [
			'repo',
			'branch',
			[{ type: 'githubPush', repo: 'octo-org/app', branch: 'release/1.0' }, true],
			[{ type: 'githubCheckFailed', repo: 'octo-org/app' }, undefined],
			'label',
			[{ type: 'githubPullRequest', repo: 'octo-org/app', on: ['commented'], comment: '@claude review' }, undefined],
			[{ type: 'githubPullRequest', repo: 'octo-org/app', on: ['updated', 'opened'], base: 'main' }, true],
			[{ type: 'githubPullRequest', repo: 'octo-org/app', on: ['opened'], base: 'main' }, true],
		]);
	});

	test('run when Klawly is closed is kept only for a read-only schedule (issue 463)', () => {
		const base = { ...emptyClaudeAutomationDraft('user'), name: 'Digest', prompt: 'Summarize.', cron: '0 9 * * 1-5', runWhenClosed: true };
		const closed = (draft: Parameters<typeof claudeAutomationOfDraft>[0]) => {
			const automation = claudeAutomationOfDraft(draft, 'digest');
			return isClaudeAutomationDraftError(automation) ? automation.field : automation.runWhenClosed;
		};
		assert.deepStrictEqual([
			closed({ ...base, permissionMode: 'ask' }),
			closed({ ...base, permissionMode: 'agent' }),
			closed({ ...base, permissionMode: 'ask', trigger: 'onSave', glob: 'src/**' }),
			closed({ ...base, permissionMode: 'ask', runWhenClosed: false }),
			claudeAutomationDraft({ ...(claudeAutomationOfDraft({ ...base, permissionMode: 'ask' }, 'digest') as object), key: 'user:digest', scope: 'user' } as ClaudeAutomationEntry).runWhenClosed,
		], [true, undefined, undefined, undefined, true]);
	});

	test('the Review Pull Requests template needs only a repository, runs read-only and leaves posting to you (issue 506)', () => {
		const draft = claudeAutomationTemplateDraft('reviewPullRequests', 'workspace');
		const missing = claudeAutomationOfDraft(draft, 'review-pull-requests');
		draft.repo = 'octo-org/app';
		const automation = claudeAutomationOfDraft(draft, 'review-pull-requests');
		assert.ok(!isClaudeAutomationDraftError(automation));
		assert.deepStrictEqual({
			missing: isClaudeAutomationDraftError(missing) ? missing.field : 'ok',
			trigger: automation.trigger,
			summary: claudeAutomationTriggerSummary(automation.trigger),
			mode: automation.permissionMode,
			budget: automation.budgetUsd,
			allowedTools: automation.allowedTools,
			readsReviewNotes: automation.prompt.includes('REVIEW.md'),
			roundTrip: claudeAutomationDraft({ ...automation, key: 'workspace:review-pull-requests', scope: 'workspace' }).pullRequest,
			blank: claudeAutomationTemplateDraft('blank', 'user'),
		}, {
			missing: 'repo',
			trigger: { type: 'githubPullRequest', repo: 'octo-org/app', on: ['opened', 'updated', 'commented'], comment: '@klawly review' },
			summary: 'Pull requests on octo-org/app: opened, new commits or comment contains',
			mode: 'agent',
			budget: 2,
			allowedTools: ['Read', 'Grep', 'Glob', 'Bash(gh pr diff:*)', 'Bash(gh pr view:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
			readsReviewNotes: true,
			roundTrip: 'openedUpdatedOrCommented',
			blank: emptyClaudeAutomationDraft('user'),
		});
	});

	test('the security templates scan weekly and review pull requests, read-only, with one finding format (issue 507)', () => {
		const scan = claudeAutomationOfDraft(claudeAutomationTemplateDraft('securityScan', 'workspace'), 'security-scan');
		const review = claudeAutomationOfDraft({ ...claudeAutomationTemplateDraft('securityReviewPullRequests', 'workspace'), repo: 'octo-org/app' }, 'security-review');
		assert.ok(!isClaudeAutomationDraftError(scan) && !isClaudeAutomationDraftError(review));
		const writes = (tools: readonly string[] | undefined) => (tools ?? []).filter(tool => /^(Edit|Write|MultiEdit)$|gh pr (review|comment)|git (commit|push)/.test(tool));
		assert.deepStrictEqual({
			scan: [scan.trigger, claudeAutomationTriggerSummary(scan.trigger), scan.allowedTools, writes(scan.allowedTools)],
			review: [review.trigger, writes(review.allowedTools)],
			format: [scan.prompt, review.prompt].map(prompt => prompt.includes('[critical|high|medium|low]') && prompt.includes('read-only')),
		}, {
			scan: [{ type: 'schedule', cron: '0 9 * * 1' }, claudeAutomationTriggerSummary({ type: 'schedule', cron: '0 9 * * 1' }), ['Read', 'Grep', 'Glob', 'Bash(npm audit:*)', 'Bash(pip-audit:*)', 'Bash(git log:*)'], []],
			review: [{ type: 'githubPullRequest', repo: 'octo-org/app', on: ['opened', 'updated'] }, []],
			format: [true, true],
		});
	});

	test('pull request filters round-trip through the form; a stored trigger without them stays unfiltered (issue 924)', () => {
		const base = { ...emptyClaudeAutomationDraft('user'), name: 'Review', prompt: 'Review it.', trigger: 'githubPullRequest' as const, repo: 'octo-org/app' };
		const plain = claudeAutomationOfDraft(base, 'review');
		const filtered = claudeAutomationOfDraft({ ...base, authors: 'alice, bob', excludeAuthors: 'dependabot[bot]', headBranches: 'feature/*\nfix/*', keywords: 'review', skipKeywords: 'wip', ignorePaths: 'docs/**, *.md', skipDrafts: true }, 'review');
		const back = isClaudeAutomationDraftError(filtered) ? undefined : claudeAutomationDraft({ ...filtered, scope: 'user', key: 'user:review' });
		assert.deepStrictEqual([
			isClaudeAutomationDraftError(plain) ? undefined : plain.trigger,
			isClaudeAutomationDraftError(filtered) ? undefined : filtered.trigger,
			back && [back.authors, back.headBranches, back.ignorePaths, back.skipDrafts],
		], [
			{ type: 'githubPullRequest', repo: 'octo-org/app', on: ['opened'] },
			{ type: 'githubPullRequest', repo: 'octo-org/app', on: ['opened'], authors: ['alice', 'bob'], excludeAuthors: ['dependabot[bot]'], headBranches: ['feature/*', 'fix/*'], keywords: ['review'], skipKeywords: ['wip'], skipDrafts: true, ignorePaths: ['docs/**', '*.md'] },
			['alice, bob', 'feature/*, fix/*', 'docs/**, *.md', true],
		]);
	});

	test('a new automation\'s id comes from its name and never clashes', () => {
		assert.deepStrictEqual([
			claudeAutomationIdFor('Fix failing tests!', new Set()),
			claudeAutomationIdFor('Fix failing tests', new Set(['fix-failing-tests', 'fix-failing-tests-2'])),
			claudeAutomationIdFor('***', new Set()),
			claudeAutomationIdFor('A very long automation name that goes on and on', new Set()),
		], ['fix-failing-tests', 'fix-failing-tests-3', 'automation', 'a-very-long-automation-name-that']);
	});

	test('the review template asks for a summary ahead of the findings only when the setting is on (issue 918)', () => {
		const off = claudeAutomationTemplateDraft('reviewPullRequests', 'user').prompt;
		const on = claudeAutomationTemplateDraft('reviewPullRequests', 'user', false, true).prompt;
		assert.deepStrictEqual([
			off.includes('Summary'),
			on.startsWith(off),
			on.slice(off.length).split('\n').filter(line => line),
		], [
			false,
			true,
			['Open the answer with a summary, before the findings: a heading "Summary", then an overview of what the change does in two or three sentences, then one line per changed file: `path [low|medium|high] what changed`, where the bracket is how risky the change to that file is.'],
		]);
	});

	test('the review status follows the findings and the threshold, and the status call is allowed only when on (issue 928)', () => {
		const finding = (severity: ClaudeReviewFinding['severity']) => ({ file: 'a.ts', startLine: 1, endLine: 1, severity, title: 't', body: 'b' }) as ClaudeReviewFinding;
		const off = claudeAutomationTemplateDraft('reviewPullRequests', 'user');
		const on = claudeAutomationTemplateDraft('reviewPullRequests', 'user', true);
		assert.deepStrictEqual([
			claudeReviewStatusDescription([], 'low'),
			claudeReviewStatusDescription([finding('low')], 'medium'),
			claudeReviewStatusDescription([finding('low'), finding('high'), finding('high'), finding('critical')], 'medium'),
			claudeReviewStatusDescription([finding('medium')], 'medium'),
			claudeReviewStatusDescription([finding('critical')], 'critical').description,
			claudeReviewRunStatus('pending').state,
			claudeReviewRunStatus('error').state,
			off.allowedTools.includes('statuses'),
			on.allowedTools.includes('Bash(gh api repos/*/*/statuses/*:*)'),
			off.prompt.includes('commit status'),
			on.prompt.includes('`error` if you cannot finish'),
			off.allowedTools.includes('reactions'),
			on.allowedTools.split('\n').filter(tool => tool.includes('reactions')).length,
			on.prompt.includes('`eyes` reaction'),
			off.prompt.includes('reaction'),
		], [
			{ state: 'success', description: 'No findings at or above low' },
			{ state: 'success', description: 'No findings at or above medium' },
			{ state: 'failure', description: '3 findings at or above medium: 1 critical, 2 high' },
			{ state: 'failure', description: '1 finding at or above medium: 1 medium' },
			'1 finding at or above critical: 1 critical',
			'pending',
			'error',
			false,
			true,
			false,
			true,
			false,
			2,
			true,
			false,
		]);
	});
});
