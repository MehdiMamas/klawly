/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeFeedbackBannedError, ClaudeFeedbackSendError, ClaudeFeedbackSignInError, ClaudeFeedbackUnsent } from '../../common/claudeFeedback.js';
import { autoSendClaudeFeedback, claudeFeedbackAutoSendDelay } from '../../common/claudeFeedbackAutoSend.js';

suite('Klawly kept feedback auto-send (issue 1211)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const entry = (id: string): ClaudeFeedbackUnsent => ({ id, draft: { kind: 'bug', title: `Report ${id}`, description: '', includeDiagnostics: true, images: [] } as ClaudeFeedbackUnsent['draft'], error: 'old' });

	function run(entries: ClaudeFeedbackUnsent[], send: (id: string) => Promise<number>) {
		const kept = new Map(entries.map(e => [e.id, e]));
		const sent: [string, number][] = [];
		const logs: string[] = [];
		const result = autoSendClaudeFeedback(entries, {
			send: draft => send(draft.title.slice(7)),
			remove: id => { kept.delete(id); },
			keep: e => { kept.set(e.id, e); },
			onSent: (e, n) => { sent.push([e.id, n]); },
			log: m => { logs.push(m); },
		});
		return { result, kept, sent, logs };
	}

	test('a report that sends is removed and announced', async () => {
		const r = run([entry('a'), entry('b')], async id => id === 'a' ? 11 : 12);
		assert.strictEqual(await r.result, 'done');
		assert.deepStrictEqual([...r.kept.keys()], []);
		assert.deepStrictEqual(r.sent, [['a', 11], ['b', 12]]);
	});

	test('a network failure keeps the report, retries later and stays quiet', async () => {
		const r = run([entry('a'), entry('b')], async () => { throw new ClaudeFeedbackSendError('offline'); });
		assert.strictEqual(await r.result, 'retry');
		assert.deepStrictEqual([...r.kept.keys()], ['a', 'b']);
		assert.strictEqual(r.kept.get('a')!.error, 'offline');
		assert.deepStrictEqual(r.sent, []);
		assert.strictEqual(r.logs.length, 1);
	});

	test('a ban or a missing sign-in stops and keeps every report with the reason', async () => {
		const banned = run([entry('a'), entry('b')], async () => { throw new ClaudeFeedbackBannedError({ login: 'x' } as ConstructorParameters<typeof ClaudeFeedbackBannedError>[0]); });
		assert.strictEqual(await banned.result, 'stop');
		assert.deepStrictEqual([...banned.kept.keys()], ['a', 'b']);
		assert.ok(banned.kept.get('a')!.error.includes('@x'));
		const signedOut = run([entry('a')], async () => { throw new ClaudeFeedbackSignInError('Sign in'); });
		assert.strictEqual(await signedOut.result, 'stop');
		assert.strictEqual(signedOut.kept.get('a')!.error, 'Sign in');
	});

	test('the back-off is 5 minutes, 30 minutes, then hourly', () => {
		assert.deepStrictEqual([0, 1, 2, 9].map(claudeFeedbackAutoSendDelay), [300_000, 1_800_000, 3_600_000, 3_600_000]);
	});
});
