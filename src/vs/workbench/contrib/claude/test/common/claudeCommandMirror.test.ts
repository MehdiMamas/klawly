/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NormalizedClaudeEvent, ToolCall } from '../../../../../platform/claude/common/claudeProtocol.js';
import { ClaudeCommandMirror, claudeSubagentKindLabel, describeStillRunning, isBackgroundCommand, STUCK_COMMAND_MINUTES } from '../../common/claudeCommandMirror.js';

function started(id: string, name: string, input: Record<string, unknown>): NormalizedClaudeEvent {
	const call = { id, name, category: name === 'Bash' ? 'shell' : 'other', input, display: { label: name } } as ToolCall;
	return { type: 'tool.started', sessionId: 's1', call } as NormalizedClaudeEvent;
}

function completed(callId: string, ok: boolean, text: string): NormalizedClaudeEvent {
	return { type: 'tool.completed', sessionId: 's1', callId, result: ok ? { ok, output: text } : { ok, error: text } } as NormalizedClaudeEvent;
}

/** The text without colors, so the snapshot reads like the terminal. */
function plain(text: string): string {
	return text.replace(/\x1b\[\d+m/g, '').replace(/\r\n/g, '\n');
}

suite('Claude command mirror', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('issue 742: commands, their output, background runs and the chat they came from', () => {
		const mirror = new ClaudeCommandMirror();
		const out = [
			mirror.accept(started('t1', 'Bash', { command: 'npm test', description: 'Run the tests' }), 'Fix login'),
			mirror.accept(completed('t1', true, 'ok 3 tests\n'), 'Fix login'),
			mirror.accept(started('t2', 'Bash', { command: 'npm run dev', run_in_background: true }), 'Fix login'),
			mirror.accept(completed('t2', true, 'Command running in background with ID: b1'), 'Fix login'),
			mirror.accept(started('r1', 'Read', { file_path: '/a.ts' }), 'Fix login'),
			mirror.accept(completed('r1', true, 'text'), 'Fix login'),
			mirror.accept(started('t3', 'Bash', { command: 'rm nope' }), 'Other chat'),
			mirror.accept(completed('t3', false, 'rm: nope: No such file'), 'Other chat'),
			mirror.accept({ type: 'subagent.finished', sessionId: 's1', runId: 't2', state: 'success' } as NormalizedClaudeEvent, 'Fix login'),
		].map(plain);
		assert.deepStrictEqual(out, [
			'# Claude in Fix login\n# Run the tests\n$ npm test\n',
			'ok 3 tests\n[done]\n\n',
			'$ npm run dev\n',
			'Command running in background with ID: b1\n[running in the background]\n\n',
			'',
			'',
			'# Claude in Other chat\n$ rm nope\n',
			'rm: nope: No such file\n[failed]\n\n',
			'# Claude in Fix login\n$ npm run dev\n[background command finished]\n\n',
		]);
		assert.strictEqual(plain(mirror.history), out.join(''));
	});

	test('issue 742: a background shell reads as a background command', () => {
		assert.deepStrictEqual([claudeSubagentKindLabel('local_bash'), claudeSubagentKindLabel('Explore')], ['Background command', 'Subagent (Explore)']);
	});

	test('issue 1257: only local_bash is a command, subagents stay subagents', () => {
		assert.deepStrictEqual([isBackgroundCommand('local_bash'), isBackgroundCommand('Explore')], [true, false]);
	});

	test('issue 1247: Still running appears at the threshold and not before', () => {
		const minute = 60_000;
		assert.deepStrictEqual([
			describeStillRunning((STUCK_COMMAND_MINUTES * minute) - 1),
			describeStillRunning(STUCK_COMMAND_MINUTES * minute),
			describeStillRunning((STUCK_COMMAND_MINUTES * minute) + (2 * minute) + 5_000),
			describeStillRunning(2 * minute, 2),
		], [undefined, 'Still running for 5 min', 'Still running for 7 min', 'Still running for 2 min']);
	});
});
