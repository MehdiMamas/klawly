/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CLAUDE_CHAT_HANDOFF_MAX_AGE_MS, claudeChatHandoffIsFor, parseClaudeChatHandoff, serializeClaudeChatHandoff } from '../../common/claudeChatHandoff.js';

suite('Klawly link prompt handoff (issue 861)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a stored handoff reads back while fresh; stale, future, malformed and half-filled ones are dropped', () => {
		const handoff = { folder: '/work/app', prompt: 'Fix the login test', mode: 'plan' as const, createdAt: 1000 };
		const raw = serializeClaudeChatHandoff(handoff);
		assert.deepStrictEqual([
			parseClaudeChatHandoff(raw, 1000 + 5),
			parseClaudeChatHandoff(raw, 1000 + CLAUDE_CHAT_HANDOFF_MAX_AGE_MS),
			parseClaudeChatHandoff(raw, 1000 + CLAUDE_CHAT_HANDOFF_MAX_AGE_MS + 1),
			parseClaudeChatHandoff(raw, 999),
			parseClaudeChatHandoff('{nope', 1000),
			parseClaudeChatHandoff('null', 1000),
			parseClaudeChatHandoff(JSON.stringify({ folder: '/work/app', createdAt: 1000 }), 1000),
			parseClaudeChatHandoff(JSON.stringify({ ...handoff, mode: 'yolo' }), 1000),
			parseClaudeChatHandoff(undefined, 1000),
		], [
			handoff,
			handoff,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ folder: '/work/app', prompt: 'Fix the login test', createdAt: 1000 },
			undefined,
		]);
	});

	test('a terminal handoff card survives the trip between windows, and a bad one is dropped', () => {
		const card = { version: 1 as const, goals: ['Ship it'], open: [], waitingOnUser: [], decisions: [] };
		const kept = parseClaudeChatHandoff(serializeClaudeChatHandoff({ folder: '/work/app', prompt: 'x', createdAt: 1000, card }), 1000);
		const dropped = parseClaudeChatHandoff(JSON.stringify({ folder: '/work/app', prompt: 'x', createdAt: 1000, card: { version: 1, goals: 5 } }), 1000);
		assert.deepStrictEqual([kept?.card, dropped?.card], [card, undefined]);
	});

	test('only a window that has the folder open is the target, ignoring a trailing slash', () => {
		const handoff = { folder: '/work/app', prompt: 'x', createdAt: 0 };
		assert.deepStrictEqual([
			claudeChatHandoffIsFor(handoff, ['/work/app']),
			claudeChatHandoffIsFor(handoff, ['/other', '/work/app/']),
			claudeChatHandoffIsFor(handoff, ['/work/app/src']),
			claudeChatHandoffIsFor(handoff, []),
		], [true, true, false, false]);
	});
});
