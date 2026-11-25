/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_PERMISSION_LEVELS, ClaudePermissionPreset, readClaudePermissionPolicy, readClaudePermissionPreset } from '../../common/claudeConfiguration.js';
import { effectiveClaudePermissionLevel, NO_SESSION_PERMISSIONS, withClaudePermissionLevel } from '../../common/claudeSessionPermissions.js';
import { ClaudePermissionHost } from '../../node/claudePermissionHost.js';

/** The requests issue 453 names: credentials, a destructive command, an edit and the network. */
const REQUESTS: readonly (readonly [string, string, Record<string, unknown>])[] = [
	['~/.ssh read', 'Read', { file_path: '/home/me/.ssh/id_rsa' }],
	['.env read', 'Read', { file_path: '/ws/.env' }],
	['.env command', 'Bash', { command: 'cat .env' }],
	['rm -rf', 'Bash', { command: 'rm -rf dist' }],
	['edit', 'Edit', { file_path: '/ws/src/a.ts' }],
	['network', 'Bash', { command: 'curl https://example.com' }],
];

/**
 * Issue 453: one permission level in Settings decides every session. The level
 * sets the policy preset and the session switches the agent service sends to
 * the host, and the decisions go through the real host as in the runner.
 */
suite('Claude permission levels', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	async function decisions(level: ClaudePermissionPreset, trusted = true, acknowledged = true, settings: Record<string, unknown> = {}): Promise<Record<string, string>> {
		const policy = readClaudePermissionPolicy(key => key === 'claude.agent.defaultPermissionMode' ? level : settings[key]);
		const host = new ClaudePermissionHost({ getPolicy: () => policy, realpath: async path => path });
		host.beginSession('s');
		host.setSessionPermissions('s', withClaudePermissionLevel(NO_SESSION_PERMISSIONS, effectiveClaudePermissionLevel(level, trusted, acknowledged)));
		const result: Record<string, string> = {};
		for (const [name, tool, input] of REQUESTS) {
			const verdict = await host.evaluate({ sessionId: 's', cwd: '/ws', workspaceFolders: ['/ws'], additionalDirectories: [], trusted, mode: 'agent', planDirectories: [] }, tool, input);
			result[name] = verdict.switchedBy ? `${verdict.behavior} (${verdict.switchedBy})` : verdict.behavior;
		}
		host.endSession('s');
		return result;
	}

	test('each level allows, asks or refuses what issue 453 says', async () => {
		const table: Record<string, Record<string, string>> = {};
		for (const level of CLAUDE_PERMISSION_LEVELS) {
			table[level] = await decisions(level);
		}
		table['allowEverything, untrusted'] = await decisions('allowEverything', false);
		table['auto, untrusted'] = await decisions('auto', false);
		table['allowEverything, warning not confirmed'] = await decisions('allowEverything', true, false);
		table['allowEverything, network and destructive denied'] = await decisions('allowEverything', true, true, { 'claude.agent.permissions.network': 'deny', 'claude.agent.permissions.shellDestructive': 'deny' });
		const asks = { '~/.ssh read': 'ask', '.env read': 'ask', '.env command': 'ask', 'rm -rf': 'ask', 'edit': 'ask', 'network': 'ask' };
		assert.deepStrictEqual(table, {
			strict: { '~/.ssh read': 'ask', '.env read': 'ask', '.env command': 'ask', 'rm -rf': 'deny', 'edit': 'ask', 'network': 'deny' },
			prompt: asks,
			acceptEdits: { ...asks, 'edit': 'allow' },
			// Auto's classifier runs in the runner, after the host (issue 510); the host alone reads it as Accept Edits.
			auto: { ...asks, 'edit': 'allow' },
			allowEverythingExceptCredentials: { '~/.ssh read': 'ask', '.env read': 'ask', '.env command': 'ask', 'rm -rf': 'allow (allow-everything)', 'edit': 'allow (allow-everything)', 'network': 'allow (allow-everything)' },
			allowEverything: { '~/.ssh read': 'allow (allow-everything)', '.env read': 'allow (allow-everything)', '.env command': 'allow (allow-everything)', 'rm -rf': 'allow (allow-everything)', 'edit': 'allow (allow-everything)', 'network': 'allow (allow-everything)' },
			'allowEverything, untrusted': asks,
			'auto, untrusted': asks,
			'allowEverything, warning not confirmed': asks,
			'allowEverything, network and destructive denied': { '~/.ssh read': 'allow (allow-everything)', '.env read': 'allow (allow-everything)', '.env command': 'allow (allow-everything)', 'rm -rf': 'deny', 'edit': 'allow (allow-everything)', 'network': 'deny' },
		});
	});

	test('a new install starts on Strict', () => {
		assert.deepStrictEqual([undefined, 'bypass', 'prompt', 'allowEverything'].map(readClaudePermissionPreset), ['strict', 'strict', 'prompt', 'allowEverything']);
	});
});
