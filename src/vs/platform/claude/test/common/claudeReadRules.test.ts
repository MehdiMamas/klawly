/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeReadDenyRules, claudeSandboxDenyRead, evaluateReadRules, isReadBlocked, mergeReadRules, parseReadRules, readRulesFromSettings } from '../../common/claudeReadRules.js';

suite('claudeReadRules', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const home = '/home/me';
	const user = (text: string) => parseReadRules(text, { source: 'user', home });

	test('a pattern without a slash blocks at any depth, a comment and blank lines are ignored', () => {
		const rules = user('# secrets\n\n.env\n*.pem\n');
		assert.deepStrictEqual(
			['/ws/.env', '/ws/a/b/.env', '/ws/key.pem', '/ws/a/.env.example', '/ws/readme.md'].map(p => evaluateReadRules(rules, p).blocked),
			[true, true, true, false, false]);
	});

	test('a blocked folder blocks everything below it, a later ! rule lets a file through', () => {
		const rules = user('secrets/*\n!secrets/public.txt\n');
		assert.deepStrictEqual(
			['/ws/secrets/a.txt', '/ws/secrets/sub/b.txt', '/ws/secrets/public.txt'].map(p => evaluateReadRules(rules, p, false).blocked),
			[true, true, false]);
	});

	test('a ! rule cannot reopen a file under a blocked folder', () => {
		const rules = user('secrets\n!secrets/public.txt\n');
		assert.strictEqual(evaluateReadRules(rules, '/ws/secrets/public.txt').blocked, true);
	});

	test('a folder-only rule leaves a file of that name alone', () => {
		const rules = user('build/\n');
		assert.deepStrictEqual(
			[evaluateReadRules(rules, '/ws/build', false).blocked, evaluateReadRules(rules, '/ws/build', true).blocked],
			[false, true]);
	});

	test('~/ and absolute rules name one place', () => {
		const rules = user('~/.ssh\n/etc/secret\nC:/keys\n');
		assert.deepStrictEqual(
			['/home/me/.ssh/id_rsa', '/home/me/x/.ssh/id_rsa', '/etc/secret', 'c:/Keys/a.txt', '/other/etc/secret'].map(p => evaluateReadRules(rules, p).blocked),
			[true, false, true, true, false]);
	});

	test('a project rule is anchored at its base', () => {
		const rules = parseReadRules('/private\ndata/raw\nlogs', { source: 'project', base: '/ws', home });
		assert.deepStrictEqual(
			['/ws/private/a', '/ws/sub/private/a', '/ws/data/raw/x', '/ws/sub/data/raw/x', '/ws/sub/logs/x', '/other/logs/x'].map(p => evaluateReadRules(rules, p).blocked),
			[true, false, true, false, true, false]);
	});

	test('** crosses folders, * does not', () => {
		const rules = user('a/**/z.txt\nsrc/*.key\n');
		assert.deepStrictEqual(
			['/ws/a/z.txt', '/ws/a/b/c/z.txt', '/ws/src/x.key', '/ws/src/d/x.key'].map(p => evaluateReadRules(rules, p).blocked),
			[true, true, true, false]);
	});

	test('a symlink that leads into a blocked place is blocked', () => {
		const rules = user('/vault\n');
		assert.deepStrictEqual(
			[isReadBlocked(rules, { absolute: '/ws/link', real: '/vault/a' }).blocked, isReadBlocked(rules, { absolute: '/ws/link', real: '/ws/other' }).blocked],
			[true, false]);
	});

	test('the verdict names the rule that decided', () => {
		const rules = mergeReadRules(user('.env\n'), parseReadRules('secrets', { source: 'project', base: '/ws', origin: '/ws/.claude/settings.json' }));
		const verdict = evaluateReadRules(rules, '/ws/secrets/a');
		assert.deepStrictEqual([verdict.blocked, verdict.rule?.source, verdict.rule?.origin], [true, 'project', '/ws/.claude/settings.json']);
	});

	test('settings Read(...) deny entries become project rules, other entries are ignored', () => {
		const rules = readRulesFromSettings({ permissions: { deny: ['Read(./secrets/**)', 'Read(//etc/shadow)', 'Read(~/.aws)', 'Bash(rm:*)', 'Read(.env)'] } }, { source: 'project', base: '/ws', home });
		assert.deepStrictEqual(
			['/ws/secrets/x', '/etc/shadow', '/home/me/.aws/credentials', '/ws/a/.env', '/ws/ok.txt'].map(p => evaluateReadRules(rules, p).blocked),
			[true, true, true, true, false]);
		assert.deepStrictEqual(readRulesFromSettings('nope', { source: 'project' }), []);
	});

	test('the user list becomes Read and Edit deny rules and sandbox paths', () => {
		const rules = user('.env\n~/.ssh\n/vault\n!keep\n');
		assert.deepStrictEqual(claudeReadDenyRules(rules), ['Read(**/.env)', 'Edit(**/.env)', 'Read(~/.ssh)', 'Edit(~/.ssh)', 'Read(//vault)', 'Edit(//vault)']);
		assert.deepStrictEqual(claudeSandboxDenyRead(rules), ['~/.ssh', '/vault']);
	});
});
