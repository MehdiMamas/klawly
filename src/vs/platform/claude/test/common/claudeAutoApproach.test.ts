/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeAutoApproachModels, ClaudeAutoApproachStep, pickAutoApproach } from '../../common/claudeAutoApproach.js';

const all: ClaudeAutoApproachModels = { strong: { id: 'opus' }, mid: { id: 'sonnet' }, cheap: { id: 'haiku' } };
const judgment: ClaudeAutoApproachStep = { id: 'j', kind: 'judgment', toolCalls: 5 };
const build: ClaudeAutoApproachStep = { id: 'b', kind: 'build', toolCalls: 30 };
const mechanical: ClaudeAutoApproachStep = { id: 'm', kind: 'mechanical', toolCalls: 3 };

function pick(steps: ClaudeAutoApproachStep[], models: ClaudeAutoApproachModels = all, extra: { failures?: Record<string, number>; thresholds?: { shortTaskCalls?: number; escalateAfterFailures?: number } } = {}) {
	return pickAutoApproach({ steps, models, ...extra }).map(d => `${d.stepId} ${d.approach} ${d.modelId ?? '-'} ${d.plannerModelId ?? '-'}`);
}

suite('Claude Auto approach picker (issue 1217)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a short task with a judgment step is solo-strong', () => {
		const [d] = pickAutoApproach({ steps: [judgment], models: all });
		assert.deepStrictEqual({ approach: d.approach, modelId: d.modelId }, { approach: 'solo-strong', modelId: 'opus' });
		assert.ok(d.reason.includes('20'));
	});

	test('build steps are plan-build: strong plans, mid builds', () => {
		assert.deepStrictEqual(pick([build]), ['b plan-build sonnet opus']);
	});

	test('mechanical steps use a free tool, else the cheapest model', () => {
		assert.deepStrictEqual(pick([{ ...mechanical, freeTool: true }, mechanical]), ['m mechanical - -', 'm mechanical haiku -']);
	});

	test('a step with two failures goes to the strong model; one failure does not', () => {
		assert.deepStrictEqual(pick([build], all, { failures: { b: 2 } }), ['b solo-strong opus -']);
		assert.deepStrictEqual(pick([build], all, { failures: { b: 1 } }), ['b plan-build sonnet opus']);
		assert.deepStrictEqual(pick([build], all, { failures: { b: 1 }, thresholds: { escalateAfterFailures: 1 } }), ['b solo-strong opus -']);
	});

	test('the short-task threshold is configurable', () => {
		const [d] = pickAutoApproach({ steps: [judgment, build], models: all, thresholds: { shortTaskCalls: 40 } });
		assert.ok(d.reason.includes('40'));
		const [long] = pickAutoApproach({ steps: [judgment, build], models: all });
		assert.ok(!long.reason.includes('20'));
	});

	test('no strong model: the best available does the work, and the reason says so', () => {
		const models = { mid: { id: 'sonnet' }, cheap: { id: 'haiku' } };
		assert.deepStrictEqual(pick([judgment], models), ['j solo-strong sonnet -']);
		assert.ok(pickAutoApproach({ steps: [judgment], models })[0].reason.includes('unavailable'));
	});

	test('a rate-limited or missing mid model moves one tier up', () => {
		assert.deepStrictEqual(pick([build], { ...all, mid: { id: 'sonnet', rateLimited: true } }), ['b plan-build opus opus']);
		assert.deepStrictEqual(pick([build], { strong: { id: 'opus' } }), ['b plan-build opus opus']);
		assert.ok(pickAutoApproach({ steps: [build], models: { strong: { id: 'opus' } } })[0].reason.includes('one tier up'));
	});

	test('no usable model leaves the model undefined', () => {
		const [d] = pickAutoApproach({ steps: [build], models: {} });
		assert.deepStrictEqual({ modelId: d.modelId, plannerModelId: d.plannerModelId }, { modelId: undefined, plannerModelId: undefined });
	});
});
