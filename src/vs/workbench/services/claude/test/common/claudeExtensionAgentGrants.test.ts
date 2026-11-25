/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeExtensionAgentGate, IClaudeExtensionAgentGrantStorage, parseClaudeExtensionAgentGrants, revokeClaudeExtensionAgentGrant, withClaudeExtensionAgentGrant } from '../../common/claudeExtensionAgentGrants.js';

class MemoryStorage implements IClaudeExtensionAgentGrantStorage {
	value: string | undefined;
	read() { return this.value; }
	write(value: string | undefined) { this.value = value; }
}

suite('Claude extension agent grants', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parse drops malformed and duplicate entries', () => {
		assert.deepStrictEqual(parseClaudeExtensionAgentGrants(undefined), []);
		assert.deepStrictEqual(parseClaudeExtensionAgentGrants('not json'), []);
		assert.deepStrictEqual(parseClaudeExtensionAgentGrants('{}'), []);
		const raw = JSON.stringify([
			{ extensionId: 'a.b', allowed: true, decidedAt: 5 },
			{ extensionId: 'A.B', allowed: false, decidedAt: 6 },
			{ extensionId: 3, allowed: true },
			{ extensionId: 'c.d', allowed: 'yes' },
			null,
			{ extensionId: 'e.f', allowed: false },
		]);
		assert.deepStrictEqual(parseClaudeExtensionAgentGrants(raw), [
			{ extensionId: 'a.b', allowed: true, decidedAt: 5 },
			{ extensionId: 'e.f', allowed: false, decidedAt: 0 },
		]);
	});

	test('set replaces and revoke removes, ignoring case', () => {
		const first = withClaudeExtensionAgentGrant([], { extensionId: 'a.b', allowed: true, decidedAt: 1 });
		const second = withClaudeExtensionAgentGrant(first, { extensionId: 'A.B', allowed: false, decidedAt: 2 });
		assert.deepStrictEqual(second, [{ extensionId: 'A.B', allowed: false, decidedAt: 2 }]);
		assert.deepStrictEqual(revokeClaudeExtensionAgentGrant(second, 'a.b'), []);
	});

	test('asks once, then reuses the saved answer', async () => {
		const storage = new MemoryStorage();
		const asked: string[] = [];
		const gate = new ClaudeExtensionAgentGate(storage, async id => { asked.push(id); return true; }, () => 42);
		assert.strictEqual(await gate.isAllowed('pub.ext'), true);
		assert.strictEqual(await gate.isAllowed('PUB.EXT'), true);
		assert.deepStrictEqual(asked, ['pub.ext']);
		assert.deepStrictEqual(gate.list(), [{ extensionId: 'pub.ext', allowed: true, decidedAt: 42 }]);
	});

	test('a denial is remembered and not asked again', async () => {
		const storage = new MemoryStorage();
		let asks = 0;
		const gate = new ClaudeExtensionAgentGate(storage, async () => { asks++; return false; });
		assert.strictEqual(await gate.isAllowed('pub.ext'), false);
		assert.strictEqual(await gate.isAllowed('pub.ext'), false);
		assert.strictEqual(asks, 1);
	});

	test('concurrent first calls share one prompt', async () => {
		const storage = new MemoryStorage();
		let asks = 0;
		let answer: (value: boolean) => void = () => { };
		const gate = new ClaudeExtensionAgentGate(storage, () => { asks++; return new Promise<boolean>(resolve => { answer = resolve; }); });
		const calls = [gate.isAllowed('pub.ext'), gate.isAllowed('pub.ext')];
		answer(true);
		assert.deepStrictEqual(await Promise.all(calls), [true, true]);
		assert.strictEqual(asks, 1);
	});

	test('revoking makes the next call ask again', async () => {
		const storage = new MemoryStorage();
		const answers = [true, false];
		const gate = new ClaudeExtensionAgentGate(storage, async () => answers.shift()!);
		assert.strictEqual(await gate.isAllowed('pub.ext'), true);
		gate.revoke('pub.ext');
		assert.strictEqual(storage.value, undefined);
		assert.strictEqual(await gate.isAllowed('pub.ext'), false);
	});

	test('a failing prompt denies the call and saves nothing', async () => {
		const storage = new MemoryStorage();
		const gate = new ClaudeExtensionAgentGate(storage, async () => { throw new Error('closed'); });
		assert.strictEqual(await gate.isAllowed('pub.ext'), false);
		assert.strictEqual(storage.value, undefined);
	});
});
