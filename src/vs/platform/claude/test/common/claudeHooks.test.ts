/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { addClaudeHook, claudeHookTakesMatcher, isClaudeHookCommand, readClaudeHooks, removeClaudeHook } from '../../common/claudeHooks.js';

suite('Claude hooks in settings files', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const settings = [
		'{',
		'  // the team model',
		'  "model": "opus",',
		'  "hooks": {',
		'    "PreToolUse": [',
		'      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "lint" }, { "type": "prompt", "prompt": "check" }] },',
		'      { "hooks": [{ "type": "command", "command": "log" }] }',
		'    ],',
		'    "Stop": "not a list"',
		'  }',
		'}',
	].join('\n');

	test('every hook lists with where it is, and broken files list nothing', () => {
		assert.deepStrictEqual({
			hooks: readClaudeHooks(settings, 'project'),
			broken: readClaudeHooks('{ "hooks": ', 'user'),
			empty: readClaudeHooks('', 'local'),
		}, {
			hooks: [
				{ scope: 'project', event: 'PreToolUse', matcher: 'Bash', command: 'lint', group: 0, index: 0 },
				{ scope: 'project', event: 'PreToolUse', matcher: 'Bash', command: 'prompt', group: 0, index: 1 },
				{ scope: 'project', event: 'PreToolUse', matcher: undefined, command: 'log', group: 1, index: 0 },
			],
			broken: [],
			empty: [],
		});
	});

	test('adding joins the group with the same matcher, keeps comments, and refuses files it cannot read', () => {
		const joined = addClaudeHook(settings, 'PreToolUse', 'Bash', 'npm test')!;
		const fresh = addClaudeHook('', 'Stop', undefined, 'say done')!;
		assert.deepStrictEqual({
			joined: readClaudeHooks(joined, 'project').filter(hook => hook.matcher === 'Bash').map(hook => hook.command),
			keepsComment: joined.includes('// the team model'),
			fresh: JSON.parse(fresh),
			newMatcher: readClaudeHooks(addClaudeHook(fresh, 'PostToolUse', ' Edit|Write ', 'fmt')!, 'user').map(hook => `${hook.event}:${hook.matcher}:${hook.command}`),
			refused: [
				addClaudeHook('{ broken', 'Stop', undefined, 'x'),
				addClaudeHook('{"hooks": []}', 'Stop', undefined, 'x'),
				addClaudeHook(settings, 'Stop', undefined, 'x'),
				addClaudeHook('', 'Stop', undefined, 'two\nlines'),
				addClaudeHook('', 'Stop"', undefined, 'x'),
			],
			commands: ['ok', ' ', 'a\rb', 'x'.repeat(4097)].map(isClaudeHookCommand),
			matchers: ['PreToolUse', 'Stop'].map(claudeHookTakesMatcher),
		}, {
			joined: ['lint', 'prompt', 'npm test'],
			keepsComment: true,
			fresh: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } },
			newMatcher: ['Stop:undefined:say done', 'PostToolUse:Edit|Write:fmt'],
			refused: [undefined, undefined, undefined, undefined, undefined],
			commands: [true, false, false, false],
			matchers: [true, false],
		});
	});

	test('removing drops emptied groups and events, and refuses a hook that moved', () => {
		const one = addClaudeHook('{"model": "opus"}', 'Stop', undefined, 'say done')!;
		const [stop] = readClaudeHooks(one, 'user');
		const [lint, , log] = readClaudeHooks(settings, 'project');
		assert.deepStrictEqual({
			lastHook: JSON.parse(removeClaudeHook(one, stop)!),
			oneOfTwo: readClaudeHooks(removeClaudeHook(settings, lint)!, 'project').map(hook => hook.command),
			lastInGroup: readClaudeHooks(removeClaudeHook(settings, log)!, 'project').map(hook => hook.command),
			moved: removeClaudeHook(settings, { ...lint, command: 'something else' }),
			gone: removeClaudeHook(settings, { ...lint, group: 5 }),
		}, {
			lastHook: { model: 'opus' },
			oneOfTwo: ['prompt', 'log'],
			lastInGroup: ['lint', 'prompt'],
			moved: undefined,
			gone: undefined,
		});
	});
});
