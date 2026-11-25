/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeReviewFinding } from '../../../../../platform/claude/common/claudeReviewLoop.js';
import { deserializeFindingThreads, serializeFindingThreads } from '../../../../services/claude/common/claudeReviewPersist.js';
import { ClaudeFindingConversationHost, ClaudeFindingConversations } from '../../common/claudeFindingConversations.js';

const FINDING: ClaudeReviewFinding = { file: 'a.ts', startLine: 2, endLine: 3, severity: 'medium', category: 'bug', title: 'Why a loop?', body: 'Is this intended?', kind: 'question' };

suite('Claude finding conversations', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function fake(answer: () => Promise<string>) {
		const log = { prompts: [] as string[], saved: '[]', chat: [] as string[], failures: [] as string[] };
		const host: ClaudeFindingConversationHost = {
			askReadOnly: prompt => { log.prompts.push(prompt); return answer(); },
			codeAround: () => ['const a = 1;'],
			summary: () => 'Summary',
			save: threads => { log.saved = serializeFindingThreads(threads); },
			continueInChat: id => { log.chat.push(id); },
			fail: message => { log.failures.push(message); },
		};
		return { host, log };
	}

	test('a reply runs a read-only turn with the finding context and saves the thread', async () => {
		const { host, log } = fake(async () => 'It is on purpose.');
		const conversations = store.add(new ClaudeFindingConversations(host));
		await conversations.send('f1', FINDING, '  Why not a loop?  ');
		const replies = [{ role: 'user', text: 'Why not a loop?' }, { role: 'assistant', text: 'It is on purpose.' }];
		assert.deepStrictEqual({
			replies: conversations.view('f1', FINDING).replies(),
			promptHasContext: log.prompts[0].includes('Why a loop?') && log.prompts[0].includes('const a = 1;') && log.prompts[0].includes('Author: Why not a loop?'),
			saved: deserializeFindingThreads(log.saved),
		}, { replies, promptHasContext: true, saved: [{ findingId: 'f1', replies }] });
	});

	test('a failed turn keeps the message and reports why; busy ends', async () => {
		const { host, log } = fake(() => Promise.reject(new Error('offline')));
		const conversations = store.add(new ClaudeFindingConversations(host));
		const view = conversations.view('f1', FINDING);
		const changes: boolean[] = [];
		store.add(view.onDidChange(() => changes.push(view.busy())));
		await conversations.send('f1', FINDING, 'Hi');
		assert.deepStrictEqual({ replies: view.replies(), failures: log.failures, changes }, { replies: [{ role: 'user', text: 'Hi' }], failures: ['offline'], changes: [true, false] });
	});

	test('a message while Claude answers is ignored; Continue in Chat and saved threads work', async () => {
		let release!: (text: string) => void;
		const { host, log } = fake(() => new Promise<string>(resolve => { release = resolve; }));
		const conversations = store.add(new ClaudeFindingConversations(host, [{ findingId: 'f1', replies: [{ role: 'user', text: 'Earlier' }] }]));
		const first = conversations.send('f1', FINDING, 'One');
		await conversations.send('f1', FINDING, 'Two');
		release('Done');
		await first;
		const view = conversations.view('f1', FINDING);
		view.continueInChat();
		assert.deepStrictEqual({ prompts: log.prompts.length, texts: view.replies().map(reply => reply.text), chat: log.chat, hasMarkIntended: view.markIntended !== undefined }, { prompts: 1, texts: ['Earlier', 'One', 'Done'], chat: ['f1'], hasMarkIntended: false });
	});

	test('Mark as Intended saves the thread as intended, counts one signal, and only once', () => {
		const { host, log } = fake(async () => '');
		const signals: string[] = [];
		const conversations = store.add(new ClaudeFindingConversations({ ...host, markIntended: (id, finding) => { signals.push(`${id}:${finding.title}`); } }));
		const view = conversations.view('f1', FINDING);
		const changes: number[] = [];
		store.add(view.onDidChange(() => changes.push(1)));
		view.markIntended?.();
		view.markIntended?.();
		assert.deepStrictEqual({ signals, changes: changes.length, saved: deserializeFindingThreads(log.saved) }, { signals: ['f1:Why a loop?'], changes: 1, saved: [{ findingId: 'f1', replies: [], intended: true }] });
	});
});
