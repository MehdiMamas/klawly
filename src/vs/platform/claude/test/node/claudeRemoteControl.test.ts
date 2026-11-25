/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeRemoteControlName, readClaudeRemoteControlResponse } from '../../common/claudeRemoteControl.js';
import { ClaudeNodeRuntimeService } from '../../node/claudeNodeRuntimeService.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery } from '../../node/claudeQuery.js';

/** What Claude Code answers to the `remote_control` control request when it turns on. */
const ENABLED = {
	session_url: 'https://claude.ai/code/session_01abc',
	connect_url: 'https://claude.ai/code?environment=env_01xyz',
	environment_id: 'env_01xyz',
	bridge_epoch: 1,
	bridge_session_id: 'session_01abc',
};

/** Share to Phone is Claude Code's Remote Control on a running chat (issue 517). */
suite('Claude Remote Control', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function query(remoteControl?: (enabled: boolean, name?: string) => Promise<unknown>): ClaudeQuery {
		return {
			[Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
			interrupt: async () => undefined,
			setModel: async () => undefined,
			supportedModels: async () => [],
			supportedCommands: async () => [],
			remoteControl,
			stopTask: async () => undefined,
			close: () => undefined,
		};
	}

	test('reads Claude Code\'s answer and keeps only https claude.ai links', () => {
		assert.deepStrictEqual({
			enabled: readClaudeRemoteControlResponse(ENABLED, true, 'Fix the flaky test'),
			untrusted: readClaudeRemoteControlResponse({ session_url: 'http://claude.ai/code/session_01abc', connect_url: 'https://claude.ai.evil.example/code' }, true),
			empty: readClaudeRemoteControlResponse(undefined, true),
			disabled: readClaudeRemoteControlResponse(ENABLED, false),
			names: [claudeRemoteControlName('  Fix the\n flaky   test '), claudeRemoteControlName('   '), claudeRemoteControlName(42), claudeRemoteControlName('x'.repeat(100))?.length],
		}, {
			enabled: { enabled: true, name: 'Fix the flaky test', sessionUrl: 'https://claude.ai/code/session_01abc', connectUrl: 'https://claude.ai/code?environment=env_01xyz' },
			untrusted: { enabled: true, name: undefined, sessionUrl: undefined, connectUrl: undefined },
			empty: { enabled: true, name: undefined, sessionUrl: undefined, connectUrl: undefined },
			disabled: { enabled: false },
			names: ['Fix the flaky test', undefined, undefined, 80],
		});
	});

	test('the registry turns it on and off on the tracked query, and forgets it with the query', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		const calls: [boolean, string | undefined][] = [];
		registry.track('s1', query(async (enabled, name) => {
			calls.push([enabled, name]);
			return enabled ? ENABLED : {};
		}), 5000);
		registry.track('s2', query(), 5000);
		const unknown = await registry.remoteControl('missing', true);
		const on = await registry.remoteControl('s1', true, 'Chat');
		const whileOn = registry.remoteControlState('s1');
		const off = await registry.remoteControl('s1', false);
		const afterOff = registry.remoteControlState('s1');
		await registry.remoteControl('s1', true, 'Chat');
		registry.untrack('s1');
		const afterUntrack = registry.remoteControlState('s1');
		const unsupported = await registry.remoteControl('s2', true).catch((error: Error) => error.message);
		assert.deepStrictEqual({ unknown, on: on?.sessionUrl, whileOn: whileOn?.enabled, off, afterOff, afterUntrack, unsupported, calls }, {
			unknown: undefined,
			on: 'https://claude.ai/code/session_01abc',
			whileOn: true,
			off: { enabled: false },
			afterOff: undefined,
			afterUntrack: undefined,
			unsupported: 'This Claude Code query cannot start Remote Control.',
			calls: [[true, 'Chat'], [false, undefined], [true, 'Chat']],
		});
	});

	test('a chat that was shared is shared again when its query restarts, unless it was stopped', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		const calls: [string, boolean, string | undefined][] = [];
		const tracked = (id: string) => query(async (enabled, name) => {
			calls.push([id, enabled, name]);
			return enabled ? ENABLED : {};
		});
		registry.track('shared', tracked('shared'), 5000);
		registry.track('stopped', tracked('stopped'), 5000);
		await registry.remoteControl('shared', true, 'Chat');
		await registry.remoteControl('stopped', true, 'Other');
		await registry.remoteControl('stopped', false);
		registry.untrack('shared');
		registry.untrack('stopped');
		registry.track('shared', tracked('shared'), 5000);
		registry.track('stopped', tracked('stopped'), 5000);
		await new Promise(resolve => setTimeout(resolve, 0));
		const again = registry.remoteControlState('shared')?.enabled;
		const notAgain = registry.remoteControlState('stopped');
		registry.disposeSession('shared');
		registry.dispose();
		registry.track('shared', tracked('shared'), 5000);
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual({ again, notAgain, afterDispose: registry.remoteControlState('shared'), calls }, {
			again: true,
			notAgain: undefined,
			afterDispose: undefined,
			calls: [['shared', true, 'Chat'], ['stopped', true, 'Other'], ['stopped', false, undefined], ['shared', true, 'Chat']],
		});
	});

	test('the runtime asks for a running chat first and passes Claude Code\'s refusal on', async () => {
		const runtime = store.add(new ClaudeNodeRuntimeService({ runtimePath: process.execPath }));
		const noQuery = await runtime.setRemoteControl('missing', true, 'Chat').catch((error: Error) => error.message);
		const stopWithoutQuery = await runtime.setRemoteControl('missing', false);
		const registry = store.add(new ClaudeProcessRegistry());
		registry.track('s1', query(async () => { throw new Error('Remote Control requires a claude.ai subscription'); }), 5000);
		const refused = await registry.remoteControl('s1', true).catch((error: Error) => error.message);
		assert.deepStrictEqual({ noQuery, stopWithoutQuery, refused, state: registry.remoteControlState('s1') }, {
			noQuery: 'Remote Control shares a running chat. Send a message first, then share it.',
			stopWithoutQuery: { enabled: false },
			refused: 'Remote Control requires a claude.ai subscription',
			state: undefined,
		});
	});
});
