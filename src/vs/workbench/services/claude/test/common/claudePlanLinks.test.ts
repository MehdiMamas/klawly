/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ClaudePlanLinks } from '../../common/claudePlanLinks.js';

suite('Claude plan links', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const plan = URI.file('/home/me/.klawly/plans/clear-cart-1a2b3c.plan.md');
	const other = URI.file('/home/me/.klawly/plans/totals-4d5e6f.plan.md');
	const key = 'klawly.plan.links';

	test('links are kept per profile, so another window sees the author of a plan in the user plans folder', () => {
		const storage = store.add(new InMemoryStorageService());
		store.add(new ClaudePlanLinks(storage)).link(plan, { sessionId: 's1', title: 'Plan clearing the cart', role: 'author' });
		const otherWindow = store.add(new ClaudePlanLinks(storage));
		assert.deepStrictEqual({
			author: otherWindow.author(plan)?.sessionId,
			workspace: storage.get(key, StorageScope.WORKSPACE),
		}, {
			author: 's1',
			workspace: undefined,
		});
	});

	test('links this workspace kept before move into the profile once, after the profile links of the same plan', () => {
		const storage = store.add(new InMemoryStorageService());
		storage.store(key, JSON.stringify([
			[plan.toString(), [{ sessionId: 's1', title: 'Plan clearing the cart', role: 'author' }, { sessionId: 's3', title: 'Build it', role: 'build' }]],
			[other.toString(), [{ sessionId: 's2', title: 'Fix totals', role: 'author' }]],
		]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		storage.store(key, JSON.stringify([
			[plan.toString(), [{ sessionId: 's3', title: 'Build it', role: 'build' }]],
		]), StorageScope.PROFILE, StorageTarget.MACHINE);
		const links = store.add(new ClaudePlanLinks(storage));
		assert.deepStrictEqual({
			plan: links.links(plan).map(link => `${link.sessionId}:${link.role}`),
			other: links.author(other)?.sessionId,
			workspace: storage.get(key, StorageScope.WORKSPACE),
			reread: store.add(new ClaudePlanLinks(storage)).links(plan).length,
		}, {
			plan: ['s3:build', 's1:author'],
			other: 's2',
			workspace: undefined,
			reread: 2,
		});
	});
});
