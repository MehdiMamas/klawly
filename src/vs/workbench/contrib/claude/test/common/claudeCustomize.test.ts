/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readClaudePermissionRules } from '../../../../../platform/claude/common/claudePermissionRules.js';
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeAccountOverview } from '../../../../../platform/claude/common/claudeAccount.js';
import { readClaudeHooks } from '../../../../../platform/claude/common/claudeHooks.js';
import { readClaudeNetworkRules } from '../../../../../platform/claude/common/claudeNetworkRules.js';
import { claudeCustomizeItems, ClaudeCustomizeSource, claudeMcpKey, claudePlanLabel, claudeSandboxStatusBadge, claudeUsageWindowTitle, claudeWhereLabel } from '../../common/claudeSettingsPages.js';

suite('Klawly settings: plan and customize helpers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('plan names and limit titles read as people say them', () => {
		assert.deepStrictEqual({
			plans: ['max', 'PRO', 'team', 'scale'].map(claudePlanLabel),
			titles: [
				claudeUsageWindowTitle({ kind: 'weekSonnet', percent: 1 }),
				claudeUsageWindowTitle({ kind: 'model', label: 'Fable', percent: 1 }),
				claudeUsageWindowTitle({ kind: 'model', percent: 1 }),
			],
		}, {
			plans: ['Max', 'Pro', 'Team', 'Scale'],
			titles: ['This Week, Sonnet', 'This Week, Fable', 'This Week, One Model'],
		});
	});

	test('skills and commands split one catalog, and the filter matches word starts', () => {
		const overview: ClaudeAccountOverview = {
			live: false,
			mcpServers: [{ name: 'docs', state: 'connected', toolCount: 1 }],
			commands: [
				{ name: 'review', description: 'Review a change', source: 'builtin' },
				{ name: 'deploy', description: 'Ship to staging', source: 'user' },
				{ name: 'pdf', description: 'Read PDF files', source: 'skill' },
			],
		};
		const source: ClaudeCustomizeSource = { overview, memory: [], hooks: [], networkRules: [], addedMcp: [], removedMcp: new Set() };
		const names = (kind: Parameters<typeof claudeCustomizeItems>[1], query?: string) => claudeCustomizeItems(source, kind, query).map(item => `${item.name}: ${item.detail}`);
		assert.deepStrictEqual({
			mcp: names('mcp'),
			skills: names('skills'),
			commands: names('commands'),
			staging: names('commands', 'stag'),
			middle: names('commands', 'taging'),
			subagents: names('subagents'),
		}, {
			mcp: ['docs: 1 tool'],
			skills: ['pdf: Read PDF files'],
			// allow-any-unicode-next-line
			commands: ['/deploy: User · Ship to staging', '/review: Built in · Review a change'],
			// allow-any-unicode-next-line
			staging: ['/deploy: User · Ship to staging'],
			middle: [],
			subagents: [],
		});
	});

	test('AGENTS.md and the .agents/skills skills say where they come from', () => {
		const overview: ClaudeAccountOverview = {
			live: true,
			mcpServers: [],
			commands: [
				{ name: 'agents:foo', description: 'Does foo', source: 'skill' },
				{ name: 'agents:bar', description: '', source: 'skill' },
				{ name: 'pdf', description: 'Read PDF files', source: 'skill' },
			],
		};
		const source: ClaudeCustomizeSource = { overview, memory: [{ id: 'a', label: 'AGENTS.md', scope: 'agents' }, { id: 'c', label: 'CLAUDE.md', scope: 'project' }], hooks: [], networkRules: [], addedMcp: [], removedMcp: new Set() };
		const names = (kind: Parameters<typeof claudeCustomizeItems>[1]) => claudeCustomizeItems(source, kind).map(item => `${item.name}: ${item.detail}`);
		assert.deepStrictEqual({ skills: names('skills'), memory: names('memory') }, {
			// allow-any-unicode-next-line
			skills: ['agents:foo: Does foo · from .agents', 'agents:bar: From .agents', 'pdf: Read PDF files'],
			memory: ['AGENTS.md: AGENTS.md', 'Project Memory: CLAUDE.md'],
		});
	});

	test('servers added or removed here show before a session reports them, and hooks list from settings', () => {
		const source: ClaudeCustomizeSource = {
			overview: {
				live: true,
				mcpServers: [
					{ name: 'docs', state: 'connected', toolCount: 2, scope: 'user' },
					{ name: 'old', state: 'connected', toolCount: 1, scope: 'project' },
					{ name: 'claude.ai Drive', state: 'connected', toolCount: 3, scope: 'claudeai' },
				],
			},
			memory: [],
			hooks: readClaudeHooks('{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"lint"}]}],"Stop":[{"hooks":[{"type":"command","command":"notify"}]}]}}', 'local'),
			networkRules: readClaudeNetworkRules('{"permissions":{"deny":["WebFetch(domain:evil.example)"]},"sandbox":{"network":{"allowedDomains":["github.com"]}}}', 'project'),
			permissionRules: readClaudePermissionRules('{"permissions":{"allow":["Bash(npm test:*)","WebFetch(domain:github.com)"],"deny":["Read(./.env)"]}}', 'project'),
			addedMcp: [
				{ name: 'github', scope: 'local', config: { type: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'] } },
				{ name: 'docs', scope: 'user', config: { type: 'http', url: 'https://docs.example/mcp' } },
			],
			removedMcp: new Set([claudeMcpKey('project', 'old')]),
		};
		const rows = (kind: Parameters<typeof claudeCustomizeItems>[1]) => claudeCustomizeItems(source, kind).map(item => ({ name: item.name, detail: item.detail, pending: !!item.pending, scope: item.mcpScope ?? item.hook?.scope }));
		assert.deepStrictEqual({ mcp: rows('mcp'), hooks: rows('hooks'), network: claudeCustomizeItems(source, 'network').map(item => `${item.name}: ${item.detail}`), permissions: claudeCustomizeItems(source, 'permissions').map(item => `${item.name}: ${item.detail}`) }, {
			mcp: [
				// allow-any-unicode-next-line
				{ name: 'docs', detail: '2 tools · user', pending: false, scope: 'user' },
				// allow-any-unicode-next-line
				{ name: 'claude.ai Drive', detail: '3 tools · claudeai', pending: false, scope: undefined },
				// allow-any-unicode-next-line
				{ name: 'github', detail: 'npx -y gh-mcp · local', pending: true, scope: 'local' },
			],
			hooks: [
				// allow-any-unicode-next-line
				{ name: 'PreToolUse · Bash', detail: 'Local · lint', pending: false, scope: 'local' },
				// allow-any-unicode-next-line
				{ name: 'Stop', detail: 'Local · notify', pending: false, scope: 'local' },
			],
			network: [
				// allow-any-unicode-next-line
				'github.com: Allowed · Project · Sandbox only',
				// allow-any-unicode-next-line
				'evil.example: Denied · Project · WebFetch only',
			],
			permissions: [
				// allow-any-unicode-next-line
				'Bash(npm test:*): Allowed · Project',
				// allow-any-unicode-next-line
				'Read(./.env): Denied · Project',
			],
		});
	});

	test('issue 455: what ~/.claude holds lists read only, local servers cannot be removed, and the pickers say where in plain words', () => {
		const source: ClaudeCustomizeSource = {
			overview: {
				live: true,
				mcpServers: [
					{ name: 'theirs', state: 'connected', toolCount: 1, scope: 'claudeCode' },
					{ name: 'here', state: 'connected', toolCount: 0, scope: 'local' },
					{ name: 'mine', state: 'connected', toolCount: 2, scope: 'user' },
				],
			},
			memory: [
				{ id: 'u', label: '~/.klawly/claude/CLAUDE.md', scope: 'user', missing: true },
				{ id: 'c', label: '~/.claude/CLAUDE.md', scope: 'claudeCode' },
			],
			hooks: [],
			networkRules: [],
			claudeCodeHooks: readClaudeHooks('{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"say bye"}]}]}}', 'user'),
			claudeCodeNetworkRules: readClaudeNetworkRules('{"permissions":{"deny":["WebFetch(domain:evil.example)"]}}', 'user'),
			addedMcp: [],
			removedMcp: new Set(),
		};
		const rows = (kind: Parameters<typeof claudeCustomizeItems>[1]) => claudeCustomizeItems(source, kind).map(item => ({ name: item.name, detail: item.detail, removable: !!(item.mcpScope ?? item.hook ?? item.networkRule) }));
		assert.deepStrictEqual({ mcp: rows('mcp'), memory: rows('memory'), hooks: rows('hooks'), network: rows('network'), where: (['user', 'project', 'local'] as const).map(claudeWhereLabel) }, {
			mcp: [
				// allow-any-unicode-next-line
				{ name: 'theirs', detail: '1 tool · from Claude Code', removable: false },
				// allow-any-unicode-next-line
				{ name: 'here', detail: '0 tools · local', removable: false },
				// allow-any-unicode-next-line
				{ name: 'mine', detail: '2 tools · user', removable: true },
			],
			memory: [
				// allow-any-unicode-next-line
				{ name: 'Your Rules', detail: '~/.klawly/claude/CLAUDE.md · Not created yet. Open it to write instructions for every project', removable: false },
				// allow-any-unicode-next-line
				{ name: 'Claude Code Memory', detail: '~/.claude/CLAUDE.md · from Claude Code', removable: false },
			],
			// allow-any-unicode-next-line
			hooks: [{ name: 'Stop', detail: 'say bye · from Claude Code', removable: false }],
			// allow-any-unicode-next-line
			network: [{ name: 'evil.example', detail: 'Denied · from Claude Code', removable: false }],
			where: ['For Me, in Every Project', 'For This Project, Shared with the Team', 'For This Project, Only Me'],
		});
	});

	test('rows from an installed plugin say which plugin, and its hooks list read-only', () => {
		const contents = { skills: ['style', 'tidy'], subagents: ['checker'], commands: ['check'], hooks: [{ event: 'PreToolUse', matcher: 'Bash', command: 'guard.sh' }], mcpServers: [{ name: 'docs' }], allowedTools: [], complete: true };
		const source: ClaudeCustomizeSource = {
			overview: {
				live: true,
				mcpServers: [{ name: 'plugin:guard:docs', state: 'connected', toolCount: 1 }, { name: 'docs', state: 'connected', toolCount: 2 }],
				commands: [
					{ name: 'guard:check', description: 'Check', source: 'plugin' },
					{ name: 'check', description: 'Mine', source: 'user' },
					{ name: 'guard:style', description: 'Style', source: 'skill' },
					{ name: 'tidy', description: '', source: 'skill' },
				],
				agents: [{ name: 'guard:checker', description: 'Checks' }],
			},
			memory: [],
			hooks: [],
			networkRules: [],
			addedMcp: [],
			removedMcp: new Set(),
			plugins: [{ id: 'guard@team', name: 'guard', scope: 'user', contents }],
		};
		const rows = (kind: Parameters<typeof claudeCustomizeItems>[1]) => claudeCustomizeItems(source, kind).map(item => `${item.name}: ${item.detail}${item.plugin ? '' : ' (own)'}${item.hook ? ' (editable)' : ''}`);
		assert.deepStrictEqual({ mcp: rows('mcp'), commands: rows('commands'), skills: rows('skills'), subagents: rows('subagents'), hooks: rows('hooks') }, {
			// allow-any-unicode-next-line
			mcp: ['plugin:guard:docs: 1 tool · from guard', 'docs: 2 tools (own)'],
			// allow-any-unicode-next-line
			commands: ['/check: User · Mine (own)', '/guard:check: Plugin · Check · from guard'],
			// allow-any-unicode-next-line
			skills: ['guard:style: Style · from guard', 'tidy: From guard'],
			// allow-any-unicode-next-line
			subagents: ['guard:checker: Checks · from guard'],
			// allow-any-unicode-next-line
			hooks: ['PreToolUse · Bash: guard.sh · from guard'],
		});
	});

	test('the organization\'s managed CLAUDE.md and settings list under Memory, marked managed (issue 523)', () => {
		const source: ClaudeCustomizeSource = {
			overview: undefined,
			memory: [
				{ id: 'p', label: 'CLAUDE.md', scope: 'project' },
				{ id: 'm', label: '/etc/claude-code/CLAUDE.md', scope: 'managed', name: 'Organization Memory' },
				{ id: 's', label: '/etc/claude-code/managed-settings.json', scope: 'managed', name: 'Organization Settings' },
			],
			hooks: [],
			networkRules: [],
			addedMcp: [],
			removedMcp: new Set(),
		};
		assert.deepStrictEqual(claudeCustomizeItems(source, 'memory', 'organization'), [
			{ kind: 'memory', id: 'm', name: 'Organization Memory', detail: '/etc/claude-code/CLAUDE.md', managed: true },
			{ kind: 'memory', id: 's', name: 'Organization Settings', detail: '/etc/claude-code/managed-settings.json', managed: true },
		]);
	});

	test('the sandbox row says whether it can start here', () => {
		assert.deepStrictEqual([
			claudeSandboxStatusBadge({ state: 'ready', platform: 'linux', missing: [] }),
			claudeSandboxStatusBadge({ state: 'missing', platform: 'linux', missing: ['socat'] }),
			claudeSandboxStatusBadge({ state: 'setup', platform: 'win32', missing: [] }),
			claudeSandboxStatusBadge({ state: 'unsupported', platform: 'other', missing: [] }),
			claudeSandboxStatusBadge(undefined),
		], [
			{ label: 'Ready', className: 'is-success' },
			{ label: 'Install First', className: 'is-warning' },
			{ label: 'Checked at Start', className: 'is-idle' },
			{ label: 'Not Supported', className: 'is-warning' },
			undefined,
		]);
	});
});
