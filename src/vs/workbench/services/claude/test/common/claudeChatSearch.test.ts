/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { StoredHistoryLine } from '../../../../../platform/claude/common/claudeSessionStore.js';
import { AgentReducerEvent, EMPTY_AGENT_VIEW_STATE, reduceAgentState, TurnViewModel } from '../../common/claudeAgentState.js';
import { ClaudeChatSearchIndex, ClaudeChatSearchStorage, claudeChatSearchEntries, claudeChatSearchLine } from '../../common/claudeChatSearch.js';

class MemorySearchStorage implements ClaudeChatSearchStorage {
	file: string | undefined;
	readonly reads: string[] = [];
	constructor(private readonly _events: Record<string, readonly AgentReducerEvent[]> = {}) { }
	async readSearchIndex(): Promise<string | undefined> {
		return this.file;
	}
	async writeSearchIndex(json: string): Promise<void> {
		this.file = json;
	}
	async read(sessionId: string): Promise<readonly StoredHistoryLine[]> {
		this.reads.push(sessionId);
		return (this._events[sessionId] ?? []).map(event => ({ v: 1, ts: 0, event }));
	}
}

function turn(turnId: string, prompt: string, reply: string): AgentReducerEvent[] {
	return [
		{ type: 'turn.submitted', turnId, text: prompt },
		{ type: 'assistant.delta', sessionId: 's', text: reply },
		{ type: 'assistant.completed', sessionId: 's', text: reply },
		{ type: 'session.completed', sessionId: 's' },
	];
}

function turns(events: readonly AgentReducerEvent[]): readonly TurnViewModel[] {
	return events.reduce(reduceAgentState, EMPTY_AGENT_VIEW_STATE).turns;
}

suite('Claude chat search', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps prompts and replies, not tools or thinking, and removes secrets', () => {
		const events: AgentReducerEvent[] = [
			{ type: 'turn.submitted', turnId: 't1', text: 'Use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ to call it' },
			{ type: 'thinking.delta', sessionId: 's', text: 'secret plan about the flux capacitor', at: 1 },
			{ type: 'tool.completed', sessionId: 's', callId: 'c1', result: { ok: true, output: 'flux output' } },
			{ type: 'assistant.completed', sessionId: 's', text: 'Done.' },
			{ type: 'session.completed', sessionId: 's' },
		];
		assert.deepStrictEqual(claudeChatSearchEntries(turns(events)), [
			{ turnId: 't1', role: 'user', text: 'Use key [redacted] to call it' },
			{ turnId: 't1', role: 'assistant', text: 'Done.' },
		]);
	});

	test('the shown line is the one with the match, cut around it', () => {
		const long = `${'a'.repeat(200)} the retry backoff doubles ${'b'.repeat(200)}`;
		assert.deepStrictEqual([
			claudeChatSearchLine('First line\nWe added retry backoff here\nLast', 'retry backoff'),
			claudeChatSearchLine('Nothing\nbackoff then retry', 'retry backoff'),
			claudeChatSearchLine(long, 'retry backoff').length <= 122,
			claudeChatSearchLine(long, 'retry backoff').includes('retry backoff'),
		], ['We added retry backoff here', 'backoff then retry', true, true]);
	});

	test('indexes old chats from their transcript once, finds the turn, and saves beside the sessions', async () => {
		const storage = new MemorySearchStorage({
			old: [...turn('o1', 'Set up the build', 'Done'), ...turn('o2', 'Why does the login redirect loop?', 'The cookie domain is wrong.')],
			other: turn('x1', 'Rename the logger', 'Renamed the logger.'),
		});
		const index = new ClaudeChatSearchIndex(storage);
		const sessions = [{ id: 'other', updatedAt: 20 }, { id: 'old', updatedAt: 10 }];
		const first = await index.search('login redir', sessions);
		const second = await index.search('LOGGER', sessions);
		await index.flush();
		const saved = JSON.parse(storage.file ?? '{}');
		index.dispose();
		assert.deepStrictEqual({ first, second, reads: storage.reads, savedSessions: Object.keys(saved.sessions).sort() }, {
			first: [{ sessionId: 'old', turnId: 'o2', role: 'user', line: 'Why does the login redirect loop?' }],
			second: [
				{ sessionId: 'other', turnId: 'x1', role: 'user', line: 'Rename the logger' },
				{ sessionId: 'other', turnId: 'x1', role: 'assistant', line: 'Renamed the logger.' },
			],
			reads: ['other', 'old'],
			savedSessions: ['old', 'other'],
		});
	});

	test('a saved chat updates the index, a reload reads the file, and a deleted chat leaves it', async () => {
		const storage = new MemorySearchStorage();
		const first = new ClaudeChatSearchIndex(storage);
		first.update('s1', 5, turns(turn('t1', 'Add a dark theme', 'Added the theme tokens.')));
		first.update('s2', 6, turns(turn('t2', 'Fix the theme switcher', 'Fixed.')));
		first.remove('s2');
		await first.flush();
		first.dispose();
		const second = new ClaudeChatSearchIndex(storage);
		const sessions = [{ id: 's2', updatedAt: 6 }, { id: 's1', updatedAt: 5 }];
		const hits = await second.search('theme', sessions);
		const short = await second.search('th', sessions);
		second.dispose();
		assert.deepStrictEqual({ hits, short, reads: storage.reads }, {
			hits: [
				{ sessionId: 's1', turnId: 't1', role: 'user', line: 'Add a dark theme' },
				{ sessionId: 's1', turnId: 't1', role: 'assistant', line: 'Added the theme tokens.' },
			],
			short: [],
			// s2 is not in the file, so its transcript is read; it has none.
			reads: ['s2'],
		});
	});

	test('every word must start a word of the turn; the exact phrase ranks first', async () => {
		const index = new ClaudeChatSearchIndex(new MemorySearchStorage());
		index.update('s', 1, turns([
			...turn('a', 'cache the token later', 'ok'),
			...turn('b', 'the token cache is stale', 'ok'),
			...turn('c', 'precache tokens', 'ok'),
		]));
		const hits = await index.search('token cache', [{ id: 's', updatedAt: 1 }]);
		index.dispose();
		assert.deepStrictEqual(hits.map(hit => hit.turnId), ['b', 'a']);
	});
});
