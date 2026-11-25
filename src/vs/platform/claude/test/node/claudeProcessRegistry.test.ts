/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery } from '../../node/claudeQuery.js';

/** The idle timer must not kill a turn whose tool or worker is still running (issue 1252). */
suite('Claude process registry idle timer', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function query(): ClaudeQuery {
		return {
			[Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
			interrupt: async () => undefined,
			setModel: async () => undefined,
			supportedModels: async () => [],
			supportedCommands: async () => [],
			stopTask: async () => undefined,
			close: () => undefined,
		};
	}

	const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

	test('kills a silent turn, but not while a call is open', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		registry.track('idle', query(), 20);
		registry.arm('idle');
		registry.track('busy', query(), 20);
		registry.arm('busy');
		registry.setOpenCalls('busy', 1);
		await wait(60);
		assert.deepStrictEqual({ idle: registry.wasTimedOut('idle'), busy: registry.wasTimedOut('busy') }, { idle: true, busy: false });
		registry.setOpenCalls('busy', 0);
		await wait(60);
		assert.strictEqual(registry.wasTimedOut('busy'), true);
	});
});
