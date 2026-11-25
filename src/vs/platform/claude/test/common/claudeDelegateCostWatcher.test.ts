/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeCostWatcherCallCost, claudeCostWatcherDelegated, claudeCostWatcherInterval, claudeCostWatcherReasonAccepted, claudeCostWatcherVerdict, ClaudeCostWatchAction, ClaudeCostWatcherSettings, ClaudeCostWatchState, CLAUDE_COST_WATCHER_DEFAULT_CADENCE, CLAUDE_COST_WATCHER_MIN_INTERVAL, formatCostWatchLogLine, newClaudeCostWatchState, parseClaudeKeepReason, readClaudeCostWatcherSettings, stepClaudeCostWatcher } from '../../common/claudeDelegateCostWatcher.js';

/** Issue 847: the cost watcher's cadence, exemptions and refusal. */
suite('Claude delegate cost watcher', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const opus = 'claude-opus-5-5';
	const settings: ClaudeCostWatcherSettings = { enabled: true, cadence: 10, refuse: false };

	/** Runs `calls` tool calls one at a time and returns every action that was not `none`. */
	function run(model: string, contextTokens: number, calls: number, options: Partial<ClaudeCostWatcherSettings> = {}, start: ClaudeCostWatchState = newClaudeCostWatchState(0)): { state: ClaudeCostWatchState; actions: { at: number; action: ClaudeCostWatchAction }[] } {
		let state = start;
		const actions: { at: number; action: ClaudeCostWatchAction }[] = [];
		for (let call = start.calls + 1; call <= start.calls + calls; call++) {
			const step = stepClaudeCostWatcher(state, { calls: call, model, contextTokens, settings: { ...settings, ...options } });
			state = step.state;
			if (step.action.kind !== 'none') {
				actions.push({ at: call, action: step.action });
			}
		}
		return { state, actions };
	}

	test('settings read with defaults, refusal off unless set', () => {
		assert.deepStrictEqual(readClaudeCostWatcherSettings(undefined, undefined, undefined), { enabled: true, cadence: CLAUDE_COST_WATCHER_DEFAULT_CADENCE, refuse: false });
		assert.deepStrictEqual(readClaudeCostWatcherSettings(false, 4.7, true), { enabled: false, cadence: 4, refuse: true });
		assert.deepStrictEqual(readClaudeCostWatcherSettings(true, 0, 'yes'), { enabled: true, cadence: CLAUDE_COST_WATCHER_DEFAULT_CADENCE, refuse: false });
	});

	test('a call costs the context at the cache-read price plus its output', () => {
		// Opus: 100k × $1.5/M + 90 × $75/M.
		assert.strictEqual(claudeCostWatcherCallCost(opus, 100_000)?.toFixed(5), '0.15675');
		assert.strictEqual(claudeCostWatcherCallCost('sonnet', 100_000)?.toFixed(5), '0.03135');
		assert.strictEqual(claudeCostWatcherCallCost('auto', 100_000), undefined);
	});

	test('the interval between nudges shrinks as calls get dearer, within bounds', () => {
		assert.deepStrictEqual([
			claudeCostWatcherInterval(10, 0.05),
			claudeCostWatcherInterval(10, 0.025),
			claudeCostWatcherInterval(10, 0.5),
			claudeCostWatcherInterval(10, 0.0001),
			claudeCostWatcherInterval(10, 0),
		], [10, 20, CLAUDE_COST_WATCHER_MIN_INTERVAL, 100, Number.POSITIVE_INFINITY]);
	});

	test('nudges fire every interval, sooner on a bigger Opus context than a Sonnet one', () => {
		// Opus at 30k: about $0.052 a call, interval 10.
		assert.deepStrictEqual(run(opus, 30_000, 30).actions.map(entry => entry.at), [10, 20, 30]);
		// Opus at 150k: about $0.232 a call, so the floor of 3.
		assert.deepStrictEqual(run(opus, 150_000, 9).actions.map(entry => entry.at), [3, 6, 9]);
		// Sonnet at 50k: about $0.016 a call, interval 31.
		assert.deepStrictEqual(run('claude-sonnet-5-5', 50_000, 62).actions.map(entry => entry.at), [31, 62]);
	});

	test('several calls seen at once count as several calls', () => {
		const step = stepClaudeCostWatcher(newClaudeCostWatchState(0), { calls: 12, model: opus, contextTokens: 30_000, settings });
		assert.strictEqual(step.action.kind, 'nudge');
		assert.strictEqual(step.state.callsSinceNudge, 0);
	});

	test('never nudges a Haiku chat, an unpriced model, or when turned off', () => {
		assert.deepStrictEqual(run('claude-haiku-5-5', 150_000, 200).actions, []);
		assert.deepStrictEqual(run('haiku', 150_000, 200, { refuse: true }).actions, []);
		assert.deepStrictEqual(run('auto', 150_000, 200).actions, []);
		assert.deepStrictEqual(run(opus, 150_000, 200, { enabled: false }).actions, []);
	});

	test('counts ignored nudges and refuses after three when refusal is on', () => {
		const { state, actions } = run(opus, 150_000, 15, { refuse: true });
		assert.deepStrictEqual(actions.map(entry => [entry.at, entry.action.kind, entry.action.kind === 'none' ? 0 : entry.action.ignored]), [
			[3, 'nudge', 0],
			[6, 'nudge', 1],
			[9, 'nudge', 2],
			[12, 'refuse', 3],
		]);
		// While refusing it neither nudges nor refuses again.
		assert.strictEqual(state.refusing, true);
	});

	test('with refusal off it keeps nudging past three ignored nudges', () => {
		const kinds = run(opus, 150_000, 15).actions.map(entry => entry.action.kind);
		assert.deepStrictEqual(kinds, ['nudge', 'nudge', 'nudge', 'nudge', 'nudge']);
	});

	test('a delegation resets the count, so a nudge that was followed is not ignored', () => {
		const first = run(opus, 150_000, 6, { refuse: true });
		const reset = claudeCostWatcherDelegated(first.state);
		assert.deepStrictEqual({ ignored: reset.ignored, nudged: reset.nudged, calls: reset.calls }, { ignored: 0, nudged: false, calls: 6 });
		const after = run(opus, 150_000, 12, { refuse: true }, reset);
		assert.deepStrictEqual(after.actions.map(entry => entry.action.kind), ['nudge', 'nudge', 'nudge', 'refuse']);
	});

	test('an accepted reason lifts the refusal and starts the ignored count over', () => {
		const refused = run(opus, 150_000, 12, { refuse: true }).state;
		const accepted = claudeCostWatcherReasonAccepted(refused);
		assert.deepStrictEqual({ refusing: accepted.refusing, ignored: accepted.ignored }, { refusing: false, ignored: 0 });
		assert.deepStrictEqual(run(opus, 150_000, 3, { refuse: true }, accepted).actions.map(entry => entry.action.kind), ['nudge']);
	});

	test('reads the keep reason and judges it with the router\'s rating', () => {
		assert.strictEqual(parseClaudeKeepReason('Done.\nKeep reason: the fix needs the design we just agreed.\nNext.'), 'the fix needs the design we just agreed.');
		assert.strictEqual(parseClaudeKeepReason('keep reason:   '), undefined);
		assert.strictEqual(parseClaudeKeepReason(undefined), undefined);
		assert.deepStrictEqual([claudeCostWatcherVerdict('simple'), claudeCostWatcherVerdict('moderate'), claudeCostWatcherVerdict('complex')], ['rejected', 'accepted', 'accepted']);
	});

	test('formats a decision log line', () => {
		assert.deepStrictEqual(JSON.parse(formatCostWatchLogLine({ time: 0, sessionId: 's1', decision: 'nudge', model: opus, interval: 3, callCostUsd: 0.2321234, ignored: 1 })), {
			time: '1970-01-01T00:00:00.000Z', kind: 'costWatcher', sessionId: 's1', decision: 'nudge', model: opus, interval: 3, callCostUsd: 0.23212, ignored: 1,
		});
	});
});
