/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentReducerEvent, AgentViewState, EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../../../services/claude/common/claudeAgentState.js';
import { ClaudeAnnouncementBatcher, ClaudeAnnouncementTracker } from '../../common/claudeAnnouncer.js';

function apply(state: AgentViewState, ...events: AgentReducerEvent[]): AgentViewState {
	return events.reduce(reduceAgentState, state);
}

const delta = (text: string): AgentReducerEvent => ({ type: 'assistant.delta', sessionId: 's', text });

suite('Claude announcer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('announces a turn start, an approval and the finish, never streamed tokens', () => {
		const tracker = new ClaudeAnnouncementTracker();
		const heard: string[][] = [];
		const observe = (state: AgentViewState) => heard.push(tracker.observe('s', state).map(item => `${item.urgent ? '!' : ''}${item.text}`));

		let state = EMPTY_AGENT_VIEW_STATE;
		observe(state);
		state = apply(state, { type: 'turn.submitted', turnId: 't1', text: 'Fix it' });
		observe(state);
		for (const token of ['Look', 'ing ', 'at ', 'the ', 'file']) {
			state = apply(state, delta(token));
			observe(state);
		}
		state = apply(state, {
			type: 'permission.requested',
			sessionId: 's',
			request: { id: 'p1', toolName: 'Bash', input: {}, category: 'shell', command: 'npm test', canRemember: true },
		});
		observe(state);
		observe(state);
		state = apply(state, { type: 'permission.resolved', sessionId: 's', outcome: { requestId: 'p1', toolName: 'Bash', decision: 'allow', scope: 'once', source: 'user' } });
		state = apply(state, { type: 'session.completed', sessionId: 's' });
		observe(state);

		assert.deepStrictEqual(heard, [
			[],
			['Agent started working.'],
			[], [], [], [], [],
			['!Approval needed: Run this command?'],
			[],
			['Agent finished.'],
		]);
	});

	test('a failed or stopped turn gets one short sentence', () => {
		const tracker = new ClaudeAnnouncementTracker();
		let state = apply(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 't1', text: 'Go' });
		tracker.observe('s', state);
		state = apply(state, { type: 'turn.failed', message: '401', kind: 'auth' });
		assert.deepStrictEqual(tracker.observe('s', state).map(item => item.text), ['Agent turn failed.']);
		state = apply(state, { type: 'turn.submitted', turnId: 't2', text: 'Again' });
		tracker.observe('s', state);
		state = apply(state, { type: 'turn.stopped' });
		assert.deepStrictEqual(tracker.observe('s', state).map(item => item.text), ['Agent stopped. Partial output is kept.']);
	});

	test('opening another session or loading history announces nothing', () => {
		const tracker = new ClaudeAnnouncementTracker();
		tracker.observe('a', EMPTY_AGENT_VIEW_STATE);
		const history = apply(EMPTY_AGENT_VIEW_STATE,
			{ type: 'turn.submitted', turnId: 'h1', text: 'One' },
			{ type: 'session.completed', sessionId: 'b' },
			{ type: 'turn.submitted', turnId: 'h2', text: 'Two' },
		);
		assert.deepStrictEqual(tracker.observe('b', history), []);
		assert.deepStrictEqual(tracker.observe('a', EMPTY_AGENT_VIEW_STATE), []);
		const loaded = apply(EMPTY_AGENT_VIEW_STATE,
			{ type: 'turn.submitted', turnId: 'r1', text: 'One' },
			{ type: 'turn.stopped' },
			{ type: 'turn.submitted', turnId: 'r2', text: 'Two' },
			{ type: 'turn.stopped' },
		);
		assert.deepStrictEqual(tracker.observe('a', loaded), []);
	});

	test('the batcher joins a burst into one message per urgency and drops repeats', () => {
		const batcher = new ClaudeAnnouncementBatcher();
		assert.strictEqual(batcher.hasPending, false);
		batcher.add([{ text: 'Agent started working.', urgent: false }]);
		batcher.add([{ text: 'Agent started working.', urgent: false }, { text: 'Agent finished.', urgent: false }]);
		assert.strictEqual(batcher.hasUrgent, false);
		batcher.add([{ text: 'Approval needed: Run this command?', urgent: true }]);
		assert.strictEqual(batcher.hasUrgent, true);
		assert.deepStrictEqual(batcher.flush(), {
			polite: 'Agent started working. Agent finished.',
			urgent: 'Approval needed: Run this command?',
		});
		assert.deepStrictEqual(batcher.flush(), { polite: undefined, urgent: undefined });
		assert.strictEqual(batcher.hasPending, false);
	});
});
