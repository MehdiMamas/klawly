/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AgentMode } from '../../common/claudeContext.js';
import { isPublishCommand } from '../../common/claudeToolPolicy.js';
import { evaluateModePolicy } from '../../common/claudeModePolicy.js';
import { DEFAULT_PERMISSION_POLICY, PermissionPolicy } from '../../common/claudePermissions.js';
import { ClaudeSessionPermissions, NO_SESSION_PERMISSIONS, sessionSwitchFor } from '../../common/claudeSessionPermissions.js';
import { ClaudePermissionHost } from '../../node/claudePermissionHost.js';

const PLANS = '/home/me/.claude/plans';

/** One request per tool class the Phase 27 gate names. */
const CLASSES: readonly (readonly [string, string, Record<string, unknown>])[] = [
	['read', 'Read', { file_path: '/ws/src/a.ts' }],
	['search', 'Grep', { pattern: 'x', path: '/ws/src' }],
	['workspace write', 'Edit', { file_path: '/ws/src/a.ts' }],
	['plan-file write', 'Write', { file_path: '/ws/docs/feature.plan.md' }],
	['.claude/plans write', 'Write', { file_path: '/ws/.claude/plans/a.md' }],
	['Claude plan folder write', 'Write', { file_path: `${PLANS}/happy-fox.md` }],
	['outside write', 'Write', { file_path: '/etc/hosts' }],
	['credential read', 'Read', { file_path: '/ws/.env' }],
	['credential write', 'Write', { file_path: '/ws/.npmrc' }],
	['read-only command', 'Bash', { command: 'git status' }],
	['command', 'Bash', { command: 'npm test' }],
	['network command', 'Bash', { command: 'npm install zod' }],
	['destructive command', 'Bash', { command: 'rm -rf dist' }],
	['credential command', 'Bash', { command: 'cat .env' }],
	['web', 'WebFetch', { url: 'https://example.com' }],
	['MCP', 'mcp__db__query', { sql: 'select 1' }],
];

/**
 * Phase 27 gate: each mode allows, asks or denies exactly what the plan says,
 * and Allow All Commands and Allow Everything approve what they cover, with the
 * untrusted-workspace and credential rails holding. Decisions go through the
 * mode filter and the real host (`ClaudePermissionHost.evaluate`), as in the runner.
 */
suite('Claude permission modes and session switches', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	async function matrix(mode: AgentMode, options: { switches?: ClaudeSessionPermissions; trusted?: boolean; policy?: Partial<PermissionPolicy> } = {}): Promise<Record<string, string>> {
		// The acceptEdits preset. The default prompt preset makes workspace writes ask (#175).
		const host = new ClaudePermissionHost({ getPolicy: () => ({ ...DEFAULT_PERMISSION_POLICY, writeWorkspace: 'allow', ...options.policy }), realpath: async path => path });
		host.beginSession('s');
		host.setSessionPermissions('s', options.switches ?? NO_SESSION_PERMISSIONS);
		const result: Record<string, string> = {};
		for (const [name, tool, input] of CLASSES) {
			if (evaluateModePolicy(mode, tool, input).behavior === 'deny') {
				result[name] = 'deny';
				continue;
			}
			const verdict = await host.evaluate({ sessionId: 's', cwd: '/ws', workspaceFolders: ['/ws'], additionalDirectories: [], trusted: options.trusted ?? true, mode, planDirectories: [PLANS] }, tool, input);
			result[name] = verdict.switchedBy ? `${verdict.behavior} (${verdict.switchedBy})` : verdict.behavior;
		}
		host.endSession('s');
		return result;
	}

	test('GATE: Agent, Plan and Ask allow, ask and deny exactly what Phase 27 says', async () => {
		assert.deepStrictEqual({ agent: await matrix('agent'), plan: await matrix('plan'), ask: await matrix('ask') }, {
			agent: {
				'read': 'allow', 'search': 'allow', 'workspace write': 'allow', 'plan-file write': 'allow', '.claude/plans write': 'allow',
				'Claude plan folder write': 'ask', 'outside write': 'ask', 'credential read': 'ask', 'credential write': 'ask',
				'read-only command': 'allow', 'command': 'ask', 'network command': 'ask', 'destructive command': 'ask', 'credential command': 'ask',
				'web': 'ask', 'MCP': 'ask',
			},
			plan: {
				'read': 'allow', 'search': 'allow', 'workspace write': 'deny', 'plan-file write': 'allow', '.claude/plans write': 'allow',
				'Claude plan folder write': 'allow', 'outside write': 'deny', 'credential read': 'ask', 'credential write': 'deny',
				'read-only command': 'allow', 'command': 'ask', 'network command': 'ask', 'destructive command': 'ask', 'credential command': 'ask',
				'web': 'allow', 'MCP': 'ask',
			},
			ask: {
				'read': 'allow', 'search': 'allow', 'workspace write': 'deny', 'plan-file write': 'deny', '.claude/plans write': 'deny',
				'Claude plan folder write': 'deny', 'outside write': 'deny', 'credential read': 'ask', 'credential write': 'deny',
				'read-only command': 'allow', 'command': 'ask', 'network command': 'ask', 'destructive command': 'ask', 'credential command': 'ask',
				'web': 'allow', 'MCP': 'ask',
			},
		});
	});

	test('GATE: Allow All Commands runs every command without a card except destructive and credential ones, in every mode', async () => {
		const allowAll = { allowAllCommands: true, allowEverything: false };
		for (const mode of ['agent', 'plan', 'ask'] as const) {
			const result = await matrix(mode, { switches: allowAll });
			assert.deepStrictEqual({
				command: result.command,
				network: result['network command'],
				destructive: result['destructive command'],
				credentials: result['credential command'],
				web: result.web,
				mcp: result.MCP,
				outside: result['outside write'],
			}, {
				command: 'allow (allow-all-commands)',
				network: 'allow (allow-all-commands)',
				destructive: 'ask',
				credentials: 'ask',
				web: mode === 'agent' ? 'ask' : 'allow',
				mcp: 'ask',
				outside: mode === 'agent' ? 'ask' : 'deny',
			}, mode);
		}
	});

	test('GATE: Allow Everything approves every request that would ask, except credentials; modes keep their file limits', async () => {
		const everything = { allowAllCommands: false, allowEverything: true };
		assert.deepStrictEqual({ agent: await matrix('agent', { switches: everything }), plan: await matrix('plan', { switches: everything }), ask: await matrix('ask', { switches: everything }) }, {
			agent: {
				'read': 'allow', 'search': 'allow', 'workspace write': 'allow', 'plan-file write': 'allow', '.claude/plans write': 'allow',
				'Claude plan folder write': 'allow (allow-everything)', 'outside write': 'allow (allow-everything)', 'credential read': 'ask', 'credential write': 'ask',
				'read-only command': 'allow', 'command': 'allow (allow-everything)', 'network command': 'allow (allow-everything)', 'destructive command': 'allow (allow-everything)', 'credential command': 'ask',
				'web': 'allow (allow-everything)', 'MCP': 'allow (allow-everything)',
			},
			plan: {
				'read': 'allow', 'search': 'allow', 'workspace write': 'deny', 'plan-file write': 'allow', '.claude/plans write': 'allow',
				'Claude plan folder write': 'allow', 'outside write': 'deny', 'credential read': 'ask', 'credential write': 'deny',
				'read-only command': 'allow', 'command': 'allow (allow-everything)', 'network command': 'allow (allow-everything)', 'destructive command': 'allow (allow-everything)', 'credential command': 'ask',
				'web': 'allow', 'MCP': 'allow (allow-everything)',
			},
			ask: {
				'read': 'allow', 'search': 'allow', 'workspace write': 'deny', 'plan-file write': 'deny', '.claude/plans write': 'deny',
				'Claude plan folder write': 'deny', 'outside write': 'deny', 'credential read': 'ask', 'credential write': 'deny',
				'read-only command': 'allow', 'command': 'allow (allow-everything)', 'network command': 'allow (allow-everything)', 'destructive command': 'allow (allow-everything)', 'credential command': 'ask',
				'web': 'allow', 'MCP': 'allow (allow-everything)',
			},
		});
	});

	test('GATE: no switch approves anything in an untrusted workspace', async () => {
		const both = { allowAllCommands: true, allowEverything: true };
		for (const mode of ['agent', 'plan', 'ask'] as const) {
			assert.deepStrictEqual(await matrix(mode, { switches: both, trusted: false }), await matrix(mode, { trusted: false }), mode);
		}
		assert.strictEqual(sessionSwitchFor({ category: 'shell', risk: 'mutating' }, both, false), undefined);
	});

	test('a push, pull request, publish or deploy asks under every switch, even with network allowed (issue 1167)', async () => {
		const host = new ClaudePermissionHost({ getPolicy: () => ({ ...DEFAULT_PERMISSION_POLICY, network: 'allow' }), realpath: async path => path });
		host.beginSession('s');
		const commands = ['git push origin fix/1', 'git -C repo push', 'gh pr create --fill', 'npm publish', 'vercel --prod', 'git status', 'npm install zod', 'git pull'];
		const results: Record<string, string> = {};
		for (const [label, switches] of [['everything', { allowAllCommands: false, allowEverything: true, allowCredentials: true }], ['commands', { allowAllCommands: true, allowEverything: false }]] as const) {
			host.setSessionPermissions('s', switches);
			for (const command of commands) {
				results[`${label}: ${command}`] = (await host.evaluate({ sessionId: 's', cwd: '/ws', workspaceFolders: ['/ws'], additionalDirectories: [], trusted: true, mode: 'agent', planDirectories: [PLANS] }, 'Bash', { command })).behavior;
			}
		}
		host.endSession('s');
		assert.deepStrictEqual({ results, publishes: commands.filter(isPublishCommand) }, {
			results: Object.fromEntries(['everything', 'commands'].flatMap(label => commands.map(command => [`${label}: ${command}`, ['git status', 'npm install zod', 'git pull'].includes(command) ? 'allow' : 'ask']))),
			publishes: ['git push origin fix/1', 'git -C repo push', 'gh pr create --fill', 'npm publish', 'vercel --prod'],
		});
	});

	test('a setting that refuses still refuses under Allow Everything', async () => {
		const result = await matrix('agent', { switches: { allowAllCommands: true, allowEverything: true }, policy: { writeOutsideWorkspace: 'deny', shellDestructive: 'deny', network: 'deny' } });
		assert.deepStrictEqual([result['outside write'], result['destructive command'], result['network command'], result.web], ['deny', 'deny', 'deny', 'deny']);
	});

	test('the prompt preset makes Agent ask for workspace edits again', async () => {
		const result = await matrix('agent', { policy: { writeWorkspace: 'ask' } });
		assert.deepStrictEqual([result['workspace write'], result['plan-file write'], result.read], ['ask', 'ask', 'allow']);
	});

	test('switches end with the session and cannot be set on one that never began', async () => {
		const host = new ClaudePermissionHost({ realpath: async path => path });
		const scope = { sessionId: 's', cwd: '/ws', workspaceFolders: ['/ws'], additionalDirectories: [], trusted: true };
		host.setSessionPermissions('s', { allowAllCommands: true, allowEverything: true });
		assert.deepStrictEqual(host.sessionPermissions('s'), NO_SESSION_PERMISSIONS);
		host.beginSession('s');
		host.setSessionPermissions('s', { allowAllCommands: true, allowEverything: false });
		assert.strictEqual((await host.evaluate(scope, 'Bash', { command: 'npm test' })).behavior, 'allow');
		host.setSessionPermissions('s', NO_SESSION_PERMISSIONS);
		assert.strictEqual((await host.evaluate(scope, 'Bash', { command: 'npm test' })).behavior, 'ask');
		host.setSessionPermissions('s', { allowAllCommands: true, allowEverything: false });
		host.endSession('s');
		host.beginSession('s');
		assert.strictEqual((await host.evaluate(scope, 'Bash', { command: 'npm test' })).behavior, 'ask');
	});
});
