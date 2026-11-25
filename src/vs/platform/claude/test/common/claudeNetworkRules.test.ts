/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { addClaudeNetworkRule, isClaudeNetworkDomain, readClaudeNetworkRules, removeClaudeNetworkRule } from '../../common/claudeNetworkRules.js';

suite('Claude network domains in settings files', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const settings = [
		'{',
		'  // the team rules',
		'  "permissions": { "allow": ["Bash(npm test)", "WebFetch(domain:github.com)"], "deny": ["WebFetch(domain:evil.example)"] },',
		'  "sandbox": { "enabled": true, "network": { "allowedDomains": ["github.com", "*.npmjs.org"] } }',
		'}',
	].join('\n');

	test('each domain lists once per effect, with which rule carries it, and broken files list nothing', () => {
		assert.deepStrictEqual({
			rules: readClaudeNetworkRules(settings, 'project'),
			broken: readClaudeNetworkRules('{ "permissions": ', 'user'),
		}, {
			rules: [
				{ scope: 'project', domain: 'github.com', effect: 'allow', webFetch: true, sandbox: true },
				{ scope: 'project', domain: '*.npmjs.org', effect: 'allow', webFetch: false, sandbox: true },
				{ scope: 'project', domain: 'evil.example', effect: 'deny', webFetch: true, sandbox: false },
			],
			broken: [],
		});
	});

	test('domains are host names, optionally for every subdomain', () => {
		assert.deepStrictEqual(['example.com', '*.example.com', 'localhost', 'https://example.com', 'a b.com', '*example.com', ''].map(isClaudeNetworkDomain), [true, true, true, false, false, false, false]);
	});

	test('adding writes the WebFetch rule and the sandbox list, without repeating entries', () => {
		const added = addClaudeNetworkRule(settings, 'github.com', 'deny');
		const again = addClaudeNetworkRule(settings, 'github.com', 'allow');
		assert.deepStrictEqual({
			empty: JSON.parse(addClaudeNetworkRule('', 'example.com', 'allow')!),
			denied: readClaudeNetworkRules(added!, 'local').filter(rule => rule.effect === 'deny'),
			unchanged: again === settings,
			commentKept: added!.includes('// the team rules'),
			badDomain: addClaudeNetworkRule(settings, 'https://x.com', 'allow'),
			badShape: addClaudeNetworkRule('{ "permissions": { "allow": "WebFetch" } }', 'x.com', 'allow'),
		}, {
			empty: { permissions: { allow: ['WebFetch(domain:example.com)'] }, sandbox: { network: { allowedDomains: ['example.com'] } } },
			denied: [
				{ scope: 'local', domain: 'evil.example', effect: 'deny', webFetch: true, sandbox: false },
				{ scope: 'local', domain: 'github.com', effect: 'deny', webFetch: true, sandbox: true },
			],
			unchanged: true,
			commentKept: true,
			badDomain: undefined,
			badShape: undefined,
		});
	});

	test('removing drops both entries and the keys they leave empty, and refuses a rule no longer there', () => {
		const removed = removeClaudeNetworkRule(settings, { domain: 'github.com', effect: 'allow' });
		const last = removeClaudeNetworkRule(removeClaudeNetworkRule(removed!, { domain: '*.npmjs.org', effect: 'allow' })!, { domain: 'evil.example', effect: 'deny' });
		assert.deepStrictEqual({
			removed: readClaudeNetworkRules(removed!, 'project').map(rule => rule.domain),
			last: JSON.parse(last!.replace(/\/\/.*\n/, '')),
			gone: removeClaudeNetworkRule(settings, { domain: 'gone.example', effect: 'allow' }),
		}, {
			removed: ['*.npmjs.org', 'evil.example'],
			last: { permissions: { allow: ['Bash(npm test)'] }, sandbox: { enabled: true } },
			gone: undefined,
		});
	});
});
