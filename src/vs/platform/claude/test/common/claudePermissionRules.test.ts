/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { hasKey } from '../../../../base/common/types.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { parseClaudeSettings } from '../../common/claudeHooks.js';
import { addClaudePermissionRule, isClaudePermissionRule, normalizeClaudePermissionRule, readClaudePermissionRules, removeClaudePermissionRule } from '../../common/claudePermissionRules.js';

function textOf(result: ReturnType<typeof addClaudePermissionRule>): string {
	assert.ok(hasKey(result, { text: true }), JSON.stringify(result));
	return result.text;
}

function permissionsOf(text: string): unknown {
	return (parseClaudeSettings(text)?.permissions);
}

suite('Claude permission rules in settings files', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const settings = [
		'{',
		'  // the team rules',
		'  "permissions": {',
		'    "allow": ["Bash(npm run test:*)", "Read(./src/**)", "WebFetch(domain:github.com)"],',
		'    "ask": ["Bash(git push:*)"],',
		'    "deny": ["Read(./.env)", "Bash(rm:*)", "WebFetch(domain:evil.example)"],',
		'    "defaultMode": "acceptEdits"',
		'  },',
		'  "model": "opus"',
		'}',
	].join('\n');

	test('allow and deny rules list in file order, without domain rules, and broken files list nothing', () => {
		assert.deepStrictEqual({
			rules: readClaudePermissionRules(settings, 'project'),
			broken: readClaudePermissionRules('{ "permissions": ', 'user'),
			wrongShape: readClaudePermissionRules('{ "permissions": { "allow": "Bash", "deny": [1, "Read"] } }', 'local'),
		}, {
			rules: [
				{ scope: 'project', rule: 'Bash(npm run test:*)', effect: 'allow' },
				{ scope: 'project', rule: 'Read(./src/**)', effect: 'allow' },
				{ scope: 'project', rule: 'Read(./.env)', effect: 'deny' },
				{ scope: 'project', rule: 'Bash(rm:*)', effect: 'deny' },
			],
			broken: [],
			wrongShape: [{ scope: 'local', rule: 'Read', effect: 'deny' }],
		});
	});

	test('a rule is a tool name, optionally with a balanced specifier', () => {
		const valid = ['Bash', 'Bash(npm run test:*)', 'Read(./.env)', 'Edit(src/**/*.ts)', 'mcp__github', 'mcp__github__create_issue', 'mcp__github__*', 'Bash(echo (hi))', '  Bash(ls)  '];
		const invalid = ['', '   ', 'Bash()', 'Bash( )', 'Bash(ls', 'Bash(ls))', 'Bash)(', '(ls)', '1Bash', 'Bash ls', 'Bash\n(ls)', 'Bash(ls\n)', 'x'.repeat(501)];
		assert.deepStrictEqual({ valid: valid.map(isClaudePermissionRule), invalid: invalid.map(isClaudePermissionRule), trimmed: normalizeClaudePermissionRule('  Bash(ls)  ') }, {
			valid: valid.map(() => true),
			invalid: invalid.map(() => false),
			trimmed: 'Bash(ls)',
		});
	});

	test('adding allows a rule and keeps every other key, comment and list as it was', () => {
		const next = textOf(addClaudePermissionRule(settings, 'Bash(git status)', 'allow'));
		// Only the edited list is re-laid out; the comment, `ask`, `deny`, `defaultMode` and `model` stay as written.
		assert.strictEqual(next, settings.replace('    "allow": ["Bash(npm run test:*)", "Read(./src/**)", "WebFetch(domain:github.com)"],', [
			'    "allow": [',
			'      "Bash(npm run test:*)",',
			'      "Read(./src/**)",',
			'      "WebFetch(domain:github.com)",',
			'      "Bash(git status)"',
			'    ],',
		].join('\n')));
	});

	test('adding to a file with no permissions, or an empty one, creates only the list', () => {
		assert.deepStrictEqual({
			empty: parseClaudeSettings(textOf(addClaudePermissionRule('', 'Read(./secrets/**)', 'deny'))),
			other: parseClaudeSettings(textOf(addClaudePermissionRule('{ "model": "opus" }', 'Bash', 'allow'))),
		}, {
			empty: { permissions: { deny: ['Read(./secrets/**)'] } },
			other: { model: 'opus', permissions: { allow: ['Bash'] } },
		});
	});

	test('a rule already in its list is not repeated', () => {
		assert.strictEqual(textOf(addClaudePermissionRule(settings, ' Read(./.env) ', 'deny')), settings);
		assert.strictEqual(textOf(addClaudePermissionRule(settings, 'Read(./src/**)', 'allow')), settings);
	});

	test('a denied rule is never allowed, whether this file or another file denies it', () => {
		assert.deepStrictEqual({
			here: addClaudePermissionRule(settings, 'Read(./.env)', 'allow'),
			there: addClaudePermissionRule('{}', 'Bash(curl:*)', 'allow', new Set(['Bash(curl:*)'])),
			// Denying what another file allows is fine: deny wins.
			deny: hasKey(addClaudePermissionRule(settings, 'Read(./src/**)', 'deny'), { text: true }),
		}, {
			here: { failure: 'denied' },
			there: { failure: 'denied' },
			deny: true,
		});
	});

	test('adding a deny rule leaves the allow list as it was', () => {
		const next = textOf(addClaudePermissionRule(settings, 'Bash(curl:*)', 'deny'));
		assert.deepStrictEqual(permissionsOf(next), {
			...(permissionsOf(settings) as object),
			deny: ['Read(./.env)', 'Bash(rm:*)', 'WebFetch(domain:evil.example)', 'Bash(curl:*)'],
		});
	});

	test('invalid input and files Claude Code could not read write nothing', () => {
		assert.deepStrictEqual([
			addClaudePermissionRule(settings, 'Bash()', 'allow'),
			addClaudePermissionRule(settings, 'WebFetch(domain:github.com)', 'allow'),
			addClaudePermissionRule('{ "permissions": ', 'Bash', 'deny'),
			addClaudePermissionRule('[]', 'Bash', 'deny'),
			addClaudePermissionRule('{ "permissions": [] }', 'Bash', 'deny'),
			addClaudePermissionRule('{ "permissions": { "deny": "Bash" } }', 'Bash(ls)', 'deny'),
		], [
			{ failure: 'invalid' },
			{ failure: 'invalid' },
			{ failure: 'file' },
			{ failure: 'file' },
			{ failure: 'file' },
			{ failure: 'file' },
		]);
	});

	test('removing takes the rule out of its own list only', () => {
		const both = '{ "permissions": { "allow": ["Bash(ls)", "Read"], "deny": ["Bash(ls)"] } }';
		const allowRemoved = removeClaudePermissionRule(both, { rule: 'Bash(ls)', effect: 'allow' });
		const denyRemoved = removeClaudePermissionRule(both, { rule: 'Bash(ls)', effect: 'deny' });
		assert.deepStrictEqual({
			allowRemoved: allowRemoved && permissionsOf(allowRemoved),
			denyRemoved: denyRemoved && permissionsOf(denyRemoved),
		}, {
			allowRemoved: { allow: ['Read'], deny: ['Bash(ls)'] },
			denyRemoved: { allow: ['Bash(ls)', 'Read'] },
		});
	});

	test('removing the last rule drops the list, then the empty permissions object, and keeps other keys', () => {
		const only = '{\n  "model": "opus",\n  "permissions": { "deny": ["Read(./.env)"] }\n}';
		const next = removeClaudePermissionRule(only, { rule: 'Read(./.env)', effect: 'deny' });
		const kept = removeClaudePermissionRule(settings, { rule: 'Bash(rm:*)', effect: 'deny' });
		assert.deepStrictEqual({
			last: next && parseClaudeSettings(next),
			kept: kept && permissionsOf(kept),
		}, {
			last: { model: 'opus' },
			kept: { ...(permissionsOf(settings) as object), deny: ['Read(./.env)', 'WebFetch(domain:evil.example)'] },
		});
	});

	test('removing a rule the file no longer has changes nothing', () => {
		assert.deepStrictEqual([
			removeClaudePermissionRule(settings, { rule: 'Bash(rm:*)', effect: 'allow' }),
			removeClaudePermissionRule(settings, { rule: 'Nope', effect: 'deny' }),
			removeClaudePermissionRule('{ "permissions": ', { rule: 'Bash', effect: 'deny' }),
			removeClaudePermissionRule('{}', { rule: 'Bash', effect: 'deny' }),
		], [undefined, undefined, undefined, undefined]);
	});

	test('a written file reads back the same rules', () => {
		let text = '';
		for (const [rule, effect] of [['Bash(npm test)', 'allow'], ['Read(./.env)', 'deny'], ['mcp__github', 'allow']] as const) {
			text = textOf(addClaudePermissionRule(text, rule, effect));
		}
		assert.deepStrictEqual(readClaudePermissionRules(text, 'user').map(rule => `${rule.effect}:${rule.rule}`), ['allow:Bash(npm test)', 'allow:mcp__github', 'deny:Read(./.env)']);
	});
});
