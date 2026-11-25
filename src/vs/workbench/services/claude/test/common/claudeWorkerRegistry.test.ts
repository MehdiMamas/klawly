/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { CLAUDE_WORKER_RETENTION_MS, ClaudeWorkerRegistry, ClaudeWorkerRunInput, workerUsagePatch } from '../../common/claudeWorkerRegistry.js';

suite('Claude worker registry', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function input(name: string, extra: Partial<ClaudeWorkerRunInput> = {}): ClaudeWorkerRunInput {
		return { name, kind: 'delegate', model: 'Sonnet 5.5', ownerSessionId: 'chat-1', ...extra };
	}

	function create(storage = store.add(new InMemoryStorageService())) {
		return { storage, registry: store.add(new ClaudeWorkerRegistry(storage)) };
	}

	test('create numbers top-level runs and links children to their parent', () => {
		const { registry } = create();
		const a = registry.create(input('a'));
		const b = registry.create(input('b'));
		const a1 = registry.create(input('a1', { parentId: a.id }));
		const a2 = registry.create(input('a2', { parentId: a.id }));
		const a21 = registry.create(input('a21', { parentId: a2.id }));
		assert.deepStrictEqual({
			numbers: [a, b, a1, a2, a21].map(run => run.number),
			state: a.state,
			roots: registry.roots().map(run => run.name),
			children: registry.children(a.id).map(run => run.name),
			grandchildren: registry.children(a2.id).map(run => run.name),
		}, {
			numbers: ['1', '2', '1-1', '1-2', '1-2-1'],
			state: 'queued',
			roots: ['a', 'b'],
			children: ['a1', 'a2'],
			grandchildren: ['a21'],
		});
	});

	test('create with an existing id returns that run', () => {
		const { registry } = create();
		const first = registry.create(input('a', { id: 'background-1' }));
		const again = registry.create(input('other', { id: 'background-1' }));
		assert.deepStrictEqual({ same: again === first, count: registry.all().length }, { same: true, count: 1 });
	});

	test('update changes the run, sets endedAt on an ended state and fires onDidChange', () => {
		const { registry } = create();
		const run = registry.create(input('a'));
		const fired: (readonly string[])[] = [];
		store.add(registry.onDidChange(ids => fired.push(ids)));
		registry.update(run.id, { state: 'working', costUsd: 0.5 });
		const working = registry.get(run.id)!;
		registry.update(run.id, { state: 'failed', stateDetail: 'failed: budget reached' });
		const failed = registry.get(run.id)!;
		assert.deepStrictEqual({
			missing: registry.update('nope', { state: 'working' }),
			working: [working.state, working.costUsd, working.endedAt === undefined],
			failed: [failed.state, failed.stateDetail, failed.endedAt !== undefined],
			fired,
		}, {
			missing: undefined,
			working: ['working', 0.5, true],
			failed: ['failed', 'failed: budget reached', true],
			fired: [[run.id], [run.id]],
		});
	});

	test('subtreeCost adds the run and every descendant', () => {
		const { registry } = create();
		const a = registry.create(input('a', { costUsd: 1 }));
		const b = registry.create(input('b', { parentId: a.id, costUsd: 0.5 }));
		registry.create(input('c', { parentId: b.id, costUsd: 0.25 }));
		registry.create(input('d', { costUsd: 4 }));
		assert.deepStrictEqual({ a: registry.subtreeCost(a.id), b: registry.subtreeCost(b.id), unknown: registry.subtreeCost('x') }, { a: 1.75, b: 0.75, unknown: 0 });
	});

	test('remove drops the run and its descendants', () => {
		const { registry } = create();
		const a = registry.create(input('a'));
		registry.create(input('b', { parentId: a.id }));
		const c = registry.create(input('c'));
		registry.remove(a.id);
		assert.deepStrictEqual(registry.all().map(run => run.id), [c.id]);
	});

	test('runs persist and come back; live runs return stopped', () => {
		const { registry, storage } = create();
		const a = registry.create(input('a', { state: 'working' }));
		const b = registry.create(input('b', { parentId: a.id, state: 'waiting', stateDetail: 'waiting for CI' }));
		const c = registry.create(input('c'));
		registry.update(c.id, { state: 'finished', report: 'done' });
		const restored = store.add(new ClaudeWorkerRegistry(storage));
		assert.deepStrictEqual(restored.all().map(run => [run.name, run.number, run.parentId, run.state, run.stateDetail, run.report]), [
			['a', '1', undefined, 'stopped', 'stopped when Klawly closed', undefined],
			['b', '1-1', a.id, 'stopped', 'stopped when Klawly closed', undefined],
			['c', '2', undefined, 'finished', undefined, 'done'],
		]);
		assert.strictEqual(b.parentId, a.id);
	});

	test('restore prunes ended runs older than the retention window', () => {
		const { registry, storage } = create();
		const old = registry.create(input('old'));
		const fresh = registry.create(input('fresh'));
		registry.update(old.id, { state: 'finished', endedAt: Date.now() - CLAUDE_WORKER_RETENTION_MS - 1000 });
		registry.update(fresh.id, { state: 'finished' });
		const restored = store.add(new ClaudeWorkerRegistry(storage));
		assert.deepStrictEqual(restored.all().map(run => run.name), ['fresh']);
	});

	test('subtree and session totals roll cost, tokens and context up the tree', () => {
		const { registry } = create();
		const a = registry.create(input('a', { costUsd: 1, inputTokens: 100, outputTokens: 10, contextTokens: 5000 }));
		const a1 = registry.create(input('a1', { parentId: a.id, kind: 'subagent', costUsd: 0.5, inputTokens: 40, outputTokens: 4, contextTokens: 9000 }));
		registry.create(input('a11', { parentId: a1.id, kind: 'subagent', costUsd: 0.25, inputTokens: 10, outputTokens: 1, contextTokens: 2000 }));
		registry.create(input('b', { costUsd: 2, ownerSessionId: 'chat-2' }));
		registry.create(input('c', { costUsd: 4 }));
		assert.deepStrictEqual({
			cost: [registry.subtreeCost(a.id), registry.subtreeCost(a1.id)],
			tokens: registry.subtreeTokens(a.id),
			context: registry.subtreeContextTokens(a.id),
			chat1: registry.sessionTotals('chat-1'),
			chat2: registry.sessionTotals('chat-2'),
			nobody: registry.sessionTotals('chat-3'),
		}, {
			cost: [1.75, 0.75],
			tokens: { inputTokens: 150, outputTokens: 15 },
			context: 9000,
			chat1: { costUsd: 5.75, inputTokens: 150, outputTokens: 15, runs: 4 },
			chat2: { costUsd: 2, inputTokens: 0, outputTokens: 0, runs: 1 },
			nobody: { costUsd: 0, inputTokens: 0, outputTokens: 0, runs: 0 },
		});
	});

	test('workerUsagePatch carries only what the usage report has', () => {
		assert.deepStrictEqual([
			workerUsagePatch(undefined),
			workerUsagePatch({ inputTokens: 3, costUsd: 0.1 }),
			workerUsagePatch({ inputTokens: 3, outputTokens: 4, contextTokens: 50, costUsd: 0.2 }),
		], [{}, { inputTokens: 3, costUsd: 0.1 }, { costUsd: 0.2, contextTokens: 50, inputTokens: 3, outputTokens: 4 }]);
	});
});
