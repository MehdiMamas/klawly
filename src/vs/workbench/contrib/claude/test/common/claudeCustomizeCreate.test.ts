/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeAccountOverview } from '../../../../../platform/claude/common/claudeAccount.js';
import { CLAUDE_CREATE_KINDS, claudeCreateContent, ClaudeCreateDraft, claudeCreatePath, claudeCreatePathLabel, claudeCreatePrompt, emptyClaudeCreateDraft, isClaudeCreateName, readClaudeRulePaths, splitClaudeList } from '../../common/claudeCustomizeCreate.js';
import { claudeCustomizeItems, ClaudeCustomizeSource } from '../../common/claudeSettingsPages.js';

function draft(fields: Partial<ClaudeCreateDraft>): ClaudeCreateDraft {
	return { ...emptyClaudeCreateDraft('project'), ...fields };
}

suite('Klawly Customize: create skills, subagents, commands and rules', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('each kind is written where and how Claude Code reads it', () => {
		const files = CLAUDE_CREATE_KINDS.map(kind => ({
			path: claudeCreatePath(kind, 'code-review').join('/'),
			text: claudeCreateContent(kind, draft({
				name: 'code-review',
				description: 'Reviews a diff: bugs first',
				model: 'sonnet',
				tools: 'Read, Grep, Bash(git diff:*)',
				paths: 'src/**/*.{ts,tsx}, test/**',
			})),
		}));
		assert.deepStrictEqual(files, [
			{ path: 'skills/code-review/SKILL.md', text: '---\nname: code-review\ndescription: "Reviews a diff: bugs first"\n---\n\n# Code Review\n\nWrite the steps Claude follows when this skill applies.\n' },
			{ path: 'agents/code-review.md', text: '---\nname: code-review\ndescription: "Reviews a diff: bugs first"\ntools: Read, Grep, Bash(git diff:*)\nmodel: sonnet\n---\n\nWrite the system prompt of this subagent: its role, how it works and what it reports back.\n' },
			{ path: 'commands/code-review.md', text: '---\ndescription: "Reviews a diff: bugs first"\n---\n\nWrite the prompt this command sends. $ARGUMENTS stands for what follows the command.\n' },
			{ path: 'rules/code-review.md', text: '---\npaths:\n  - "src/**/*.{ts,tsx}"\n  - "test/**"\n---\n\n# Code Review\n\nWrite the instructions Claude follows in the files this rule covers.\n' },
		]);
	});

	test('optional fields stay out of the frontmatter', () => {
		assert.deepStrictEqual({
			subagent: claudeCreateContent('subagents', draft({ name: 'helper', description: 'Helps out' })),
			command: claudeCreateContent('commands', draft({ name: 'ship' })),
			rule: claudeCreateContent('rules', draft({ name: 'style' })),
		}, {
			subagent: '---\nname: helper\ndescription: Helps out\nmodel: inherit\n---\n\nWrite the system prompt of this subagent: its role, how it works and what it reports back.\n',
			command: 'Write the prompt this command sends. $ARGUMENTS stands for what follows the command.\n',
			rule: '# Style\n\nWrite the instructions Claude follows in the files this rule covers.\n',
		});
	});

	test('names, lists and rule paths read the way Claude Code writes them', () => {
		assert.deepStrictEqual({
			names: ['pdf', 'code-review', 'v2-notes', 'Code', '-x', 'a b', 'a/b', ''].map(isClaudeCreateName),
			list: splitClaudeList('src/**/*.{ts,tsx}, lib/**,\n docs/*.md ,'),
			paths: [
				'---\npaths:\n  - "src/api/**/*.ts"\n  - \'lib/**\'\n  - test/**\nother: 1\n---\n# Rule',
				'---\r\npaths: ["a/**", "b/*.{js,ts}"]\r\n---\r\n',
				'---\npaths: src/**\n---\n',
				'---\ndescription: none\n---\n',
				'# No frontmatter\npaths:\n  - x',
			].map(readClaudeRulePaths),
		}, {
			names: [true, true, true, false, false, false, false, false],
			list: ['src/**/*.{ts,tsx}', 'lib/**', 'docs/*.md'],
			paths: [
				['src/api/**/*.ts', 'lib/**', 'test/**'],
				['a/**', 'b/*.{js,ts}'],
				['src/**'],
				[],
				[],
			],
		});
	});

	test('Create with Claude asks for what the form leaves open', () => {
		assert.deepStrictEqual([
			claudeCreatePrompt('skills', draft({ name: 'release-notes', description: 'Drafts release notes' })),
			claudeCreatePrompt('rules', draft({ scope: 'user' })),
		], [
			'Help me create a Claude Code skill. Name it release-notes. What it is for: Drafts release notes. Ask me what it should do and when you should use it until that is clear, then write its SKILL.md with name and description frontmatter in .claude/skills/release-notes/.',
			'Help me create a Claude Code rule. Ask me what it should say and which files it applies to until that is clear, then write it to ~/.klawly/claude/rules/, with paths frontmatter listing the globs it is scoped to, or none if it always applies.',
		]);
	});

	test('rules list with their paths, and new files show until a session reports them', () => {
		const overview: ClaudeAccountOverview = {
			live: false,
			commands: [{ name: 'pdf', description: 'Read PDF files', source: 'skill' }],
			agents: [],
		};
		const source: ClaudeCustomizeSource = {
			overview, memory: [], hooks: [], networkRules: [], addedMcp: [], removedMcp: new Set(),
			rules: [
				{ id: 'file:///p/.claude/rules/api.md', name: 'api', scope: 'project', paths: ['src/api/**'] },
				{ id: 'file:///h/.claude/rules/tone.md', name: 'tone', scope: 'user', paths: [] },
			],
			created: [
				{ kind: 'skills', name: 'pdf', description: 'Already loaded', scope: 'project', id: 'file:///p/.claude/skills/pdf/SKILL.md' },
				{ kind: 'skills', name: 'notes', description: 'Takes notes', scope: 'user', id: 'file:///h/.claude/skills/notes/SKILL.md' },
				{ kind: 'commands', name: 'ship', description: '', scope: 'project', id: 'file:///p/.claude/commands/ship.md' },
			],
		};
		assert.deepStrictEqual({
			rules: claudeCustomizeItems(source, 'rules'),
			skills: claudeCustomizeItems(source, 'skills').map(item => ({ name: item.name, detail: item.detail, pending: item.pending })),
			commands: claudeCustomizeItems(source, 'commands').map(item => ({ name: item.name, detail: item.detail, file: item.file })),
		}, {
			rules: [
				{ kind: 'rules', id: 'file:///p/.claude/rules/api.md', name: 'api', detail: 'Project · src/api/**', file: 'file:///p/.claude/rules/api.md' },
				{ kind: 'rules', id: 'file:///h/.claude/rules/tone.md', name: 'tone', detail: 'User · Every session', file: 'file:///h/.claude/rules/tone.md' },
			],
			skills: [
				{ name: 'pdf', detail: 'Read PDF files', pending: undefined },
				{ name: 'notes', detail: 'User · Takes notes', pending: true },
			],
			commands: [{ name: '/ship', detail: 'Project', file: 'file:///p/.claude/commands/ship.md' }],
		});
	});

	test('the dev build names its own user layer folder (issue 807)', () => {
		assert.deepStrictEqual([
			claudeCreatePathLabel('rules', 'user'),
			claudeCreatePathLabel('subagents', 'user', undefined, '.klawly-dev'),
			claudeCreatePathLabel('skills', 'user', 'review', '.klawly-dev'),
			claudeCreatePathLabel('skills', 'project', 'review', '.klawly-dev'),
			claudeCreatePrompt('rules', draft({ scope: 'user' }), '.klawly-dev'),
		], [
			'~/.klawly/claude/rules/',
			'~/.klawly-dev/claude/agents/',
			'~/.klawly-dev/claude/skills/review/SKILL.md',
			'.claude/skills/review/SKILL.md',
			'Help me create a Claude Code rule. Ask me what it should say and which files it applies to until that is clear, then write it to ~/.klawly-dev/claude/rules/, with paths frontmatter listing the globs it is scoped to, or none if it always applies.',
		]);
	});

	test('Claude Code rules list read only with a Copy source (issue 807)', () => {
		const source: ClaudeCustomizeSource = {
			overview: { live: false, commands: [], agents: [] }, memory: [], hooks: [], networkRules: [], addedMcp: [], removedMcp: new Set(), created: [],
			rules: [{ id: 'file:///h/.claude/rules/web/react.md', name: 'web/react', scope: 'claudeCode', paths: [] }],
		};
		assert.deepStrictEqual(claudeCustomizeItems(source, 'rules').map(item => ({ name: item.name, detail: item.detail, file: item.file, copyFrom: item.copyFrom })), [
			{ name: 'web/react', detail: 'Every session · from Claude Code', file: 'file:///h/.claude/rules/web/react.md', copyFrom: { type: 'file', path: ['rules', 'web', 'react.md'] } },
		]);
	});
});
