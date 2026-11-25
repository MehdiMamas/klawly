/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeAgentSession, ClaudeAgentSessionChange } from '../../../../services/claude/common/claudeAgentService.js';
import { AgentReducerEvent, AgentViewState, EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../../../services/claude/common/claudeAgentState.js';
import { OutlineTarget } from '../../../../services/outline/browser/outline.js';
import { ClaudeChatOutline, ClaudeChatOutlineAgent } from '../../browser/chat/claudeChatOutline.js';

suite('Claude chat outline view (issue 433)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let state: AgentViewState;
	let revealed: string[];
	let onDidChangeViewState: Emitter<{ readonly sessionId: string }>;
	let outline: ClaudeChatOutline;

	setup(() => {
		state = reduce([{ type: 'turn.submitted', turnId: 't1', text: 'Fix the login bug' }]);
		revealed = [];
		onDidChangeViewState = store.add(new Emitter<{ readonly sessionId: string }>());
		const onDidChangeSession = store.add(new Emitter<ClaudeAgentSessionChange>());
		const agent = {
			getCurrentSession: () => ({ id: 's' }) as ClaudeAgentSession,
			getViewState: () => state,
			onDidChangeSession: onDidChangeSession.event,
			onDidChangeViewState: onDidChangeViewState.event,
		} as ClaudeChatOutlineAgent;
		const chat = {
			revealTurn: (turnId: string, targetId?: string) => {
				revealed.push(targetId ? `${turnId}#${targetId}` : turnId);
				return true;
			},
		};
		outline = store.add(new ClaudeChatOutline(chat, OutlineTarget.OutlinePane, agent));
	});

	test('follows the chat, fires only when an entry changes and scrolls the chat to a picked entry', () => {
		let changes = 0;
		store.add(outline.onDidChange(() => changes++));

		state = reduce([
			{ type: 'turn.submitted', turnId: 't1', text: 'Fix the login bug' },
			{ type: 'assistant.delta', sessionId: 's', text: 'Looking' },
		]);
		onDidChangeViewState.fire({ sessionId: 's' });
		state = reduce([
			{ type: 'turn.submitted', turnId: 't1', text: 'Fix the login bug' },
			{ type: 'tool.started', sessionId: 's', call: { id: 'e1', name: 'Edit', category: 'write', input: {}, display: { label: 'Edit', file: 'src/login.ts' } } },
		]);
		onDidChangeViewState.fire({ sessionId: 'other' });
		onDidChangeViewState.fire({ sessionId: 's' });

		const picks = outline.config.quickPickDataSource.getQuickPickElements();
		outline.reveal(picks[1].element, {}, false, false);
		outline.reveal(picks[0].element, {}, false, false);

		assert.deepStrictEqual({
			changes,
			isEmpty: outline.isEmpty,
			picks: picks.map(pick => [pick.label, pick.description]),
			revealed,
		}, {
			changes: 1,
			isEmpty: false,
			picks: [
				['$(comment-discussion) Fix the login bug', 'Turn 1'],
				['$(edit) login.ts', 'src/login.ts'],
			],
			revealed: ['t1#e1', 't1'],
		});
	});
});

function reduce(events: readonly AgentReducerEvent[]): AgentViewState {
	return events.reduce(reduceAgentState, EMPTY_AGENT_VIEW_STATE);
}
