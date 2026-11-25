/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { readClaudeSecuritySettings } from '../../../../../platform/claude/common/claudeSecuritySettings.js';
import { policyDiagnosticsContributedSections } from '../../../../browser/actions/policyDiagnosticsMarkdown.js';
import { claudePolicyDiagnostics } from '../../browser/claudePolicyDiagnostics.js';

suite('Claude policy diagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the report runs the Claude section, and a failing section says so in its place', async () => {
		assert.deepStrictEqual({
			sections: await policyDiagnosticsContributedSections(async id => `[${id}]`),
			failed: await policyDiagnosticsContributedSections(async () => { throw new Error('no runtime'); }),
		}, {
			sections: '[_claude.policyDiagnostics]',
			failed: '*Error retrieving \\_claude.policyDiagnostics: no runtime*\n\n',
		});
	});

	test('the section shows the effective sandbox, the rules of each settings file, and the managed settings received and passed on', () => {
		const policies: Record<string, unknown> = { 'claude.sandbox.enabled': true, 'claude.managedSettings': '{"permissions":{"deny":["WebFetch(domain:paste.example)"]}}' };
		const values: Record<string, unknown> = { ...policies, 'claude.sandbox.autoAllowBash': false };
		const markdown = claudePolicyDiagnostics({
			security: readClaudeSecuritySettings(key => values[key], key => policies[key]),
			policies: Object.entries(policies).map(([key, value]) => ({ key, value })),
			sandboxStatus: { state: 'ready', platform: 'linux', missing: [] },
			files: [
				{ scope: 'project', label: '.claude/settings.json', text: '{ "permissions": { "allow": ["WebFetch(domain:github.com)", "Bash(npm test)"] }, "sandbox": { "network": { "allowedDomains": ["github.com"] } } }' },
				{ scope: 'local', label: '.claude/settings.local.json', text: undefined },
				{ scope: 'user', label: '~/.claude/settings.json', text: '{ broken' },
			],
		});
		// Managed Settings lists the received policies, so its rows are counted apart from the sandbox rows.
		const managedAt = markdown.indexOf('### Managed Settings');
		const before = markdown.slice(0, managedAt).split('\n');
		assert.deepStrictEqual({
			headings: markdown.split('\n').filter(line => line.startsWith('#')),
			sandbox: before.filter(line => line.startsWith('| claude.sandbox') || line.startsWith('| On this machine')),
			rules: before.filter(line => /^\| (Project|Local|User) /.test(line)),
			received: markdown.slice(managedAt).split('\n').filter(line => line.startsWith('| claude.')).length,
			passed: JSON.parse(markdown.slice(markdown.indexOf('```json') + 7, markdown.lastIndexOf('```'))),
		}, {
			headings: ['## Claude', '### Effective Sandbox', '### Permission Rules by Source', '### Managed Settings'],
			sandbox: [
				'| claude.sandbox.enabled | Yes | Policy |',
				'| claude.sandbox.autoAllowBash | No | Settings |',
				'| claude.sandbox.allowUnsandboxedCommands | Yes | Settings |',
				'| claude.sandbox.allowLocalBinding | No | Settings |',
				'| On this machine | Ready | bubblewrap and socat are installed, so Claude Code\'s sandbox can start here |',
			],
			rules: [
				'| Project | .claude/settings.json | WebFetch\\(domain:github.com\\)<br>Bash\\(npm test\\) |  |  | github.com |  |',
				'| Local | .claude/settings.local.json \\(no file\\) |  |  |  |  |  |',
				'| User | \\~/.claude/settings.json \\(not valid JSON\\) |  |  |  |  |  |',
			],
			received: 2,
			passed: { permissions: { deny: ['WebFetch(domain:paste.example)'] }, sandbox: { enabled: true, failIfUnavailable: true } },
		});
	});
});
