/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { addDecisionTokens, CLAUDE_DELEGATION_TIER_MODEL_DEFAULTS, formatDecisionLogLine, pickReusableHelper, readClaudeDelegationTierModel, routeAutoStep, routeDelegateTier } from '../../common/claudeDelegateTier.js';

suite('Claude delegate tier router', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const models = CLAUDE_DELEGATION_TIER_MODEL_DEFAULTS;

	test('settings: a blank or missing value is the tier default', () => {
		assert.deepStrictEqual([
			readClaudeDelegationTierModel('small', undefined),
			readClaudeDelegationTierModel('small', '  '),
			readClaudeDelegationTierModel('medium', ' opus '),
			readClaudeDelegationTierModel('large', 5),
		], ['haiku', 'haiku', 'opus', '']);
	});

	test('a named model wins and the classifier is skipped', () => {
		assert.deepStrictEqual([
			routeDelegateTier({ model: 'opus', models }),
			routeDelegateTier({ model: 'opus', tier: 'small', models }),
		], [
			{ modelAlias: 'opus', classifierSkipped: true, why: 'model named' },
			{ tier: 'small', modelAlias: 'opus', classifierSkipped: true, why: 'model named' },
		]);
	});

	test('a tier maps to its model; large needs a reason and an Opus chat needs orchestrates', () => {
		const large = { tier: 'large' as const, reason: 'New project', models: { ...models, large: 'opus' } };
		assert.deepStrictEqual([
			routeDelegateTier({ tier: 'small', models }),
			routeDelegateTier({ tier: 'medium', reason: 'Build', models: { ...models, medium: 'haiku' } }),
			routeDelegateTier({ tier: 'large', models }).tier,
			routeDelegateTier({ ...large, parentModel: 'Claude Opus 5' }).tier,
			routeDelegateTier({ ...large, parentModel: 'claude-opus-5-5', orchestrates: true }).tier,
			routeDelegateTier({ ...large, parentModel: 'sonnet' }).tier,
		], [
			{ tier: 'small', modelAlias: 'haiku', classifierSkipped: true, why: 'tier given' },
			{ tier: 'medium', modelAlias: 'haiku', classifierSkipped: true, why: 'tier and reason given' },
			'medium',
			'medium',
			'large',
			'large',
		]);
	});

	test('without a tier or a model the rating picks the tier; an empty large model is the chat\'s own', () => {
		assert.deepStrictEqual([
			routeDelegateTier({ complexity: 'simple', models }),
			routeDelegateTier({ complexity: 'moderate', models }).tier,
			routeDelegateTier({ complexity: 'complex', classifierReason: 'Many files', models }),
			routeDelegateTier({ complexity: 'complex', classifierReason: 'Many files', parentModel: 'opus', models }).tier,
		], [
			{ tier: 'small', modelAlias: 'haiku', classifierSkipped: false, why: 'classifier rated it simple' },
			'medium',
			{ tier: 'large', modelAlias: undefined, classifierSkipped: false, why: 'classifier rated it complex' },
			'medium',
		]);
	});

	test('the decision log line is one JSON line', () => {
		const line = formatDecisionLogLine({ time: 0, tier: 'medium', requestedTier: 'large', model: 'sonnet', why: 'tier given', classifierSkipped: true });
		assert.deepStrictEqual([line.includes('\n'), JSON.parse(line)], [false, {
			time: '1970-01-01T00:00:00.000Z', tier: 'medium', requestedTier: 'large', reason: null, model: 'sonnet', why: 'tier given', classifierSkipped: true,
		}]);
	});

	test('the tokens of a run go on its decision line only (issue 987)', () => {
		const tokens = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 };
		const decision = formatDecisionLogLine({ time: 0, tier: 'small', model: 'haiku', why: 'tier given', classifierSkipped: true, runId: 'r1' });
		const other = formatDecisionLogLine({ time: 0, tier: 'small', model: 'haiku', why: 'tier given', classifierSkipped: true, runId: 'r2' });
		const escalation = JSON.stringify({ kind: 'escalation', runId: 'r1' });
		assert.deepStrictEqual([
			JSON.parse(addDecisionTokens(decision, 'r1', tokens)).tokens,
			JSON.parse(decision).runId,
			addDecisionTokens(other, 'r1', tokens),
			addDecisionTokens(escalation, 'r1', tokens),
			addDecisionTokens('not json', 'r1', tokens),
		], [tokens, 'r1', other, escalation, 'not json']);
	});

	suite('mixed models in Auto mode', () => {
		const long = [
			{ id: 'a', kind: 'judgment' as const, toolCalls: 5 },
			{ id: 'b', kind: 'build' as const, toolCalls: 30 },
			{ id: 'c', kind: 'mechanical' as const, toolCalls: 10 },
			{ id: 'd', kind: 'mechanical' as const, toolCalls: 3, freeTool: true },
		];
		const route = (i: number, failures?: number) => routeAutoStep({ step: long[i], steps: long, models, failures });

		test('long task: strong judges, medium builds, small and free tools do mechanical steps', () => {
			assert.deepStrictEqual([0, 1, 2, 3].map(i => route(i)).map(r => [r.approach, r.inline, r.freeTool, r.tier, r.modelAlias, r.plannerAlias]), [
				['solo-strong', true, false, undefined, undefined, undefined],
				['plan-build', false, false, 'medium', 'sonnet', undefined],
				['mechanical', false, false, 'small', 'haiku', undefined],
				['mechanical', false, true, undefined, undefined, undefined],
			]);
		});

		test('a short task runs in the chat with no helper', () => {
			const steps = [{ id: 'x', kind: 'build' as const, toolCalls: 6 }];
			const r = routeAutoStep({ step: steps[0], steps, models });
			assert.deepStrictEqual([r.inline, r.tier], [true, undefined]);
		});

		test('a step that failed twice goes to the strong model in the chat', () => {
			const r = route(1, 2);
			assert.deepStrictEqual([r.approach, r.inline, r.tier], ['solo-strong', true, undefined]);
		});

		test('an unknown step falls back to the chat', () => {
			assert.strictEqual(routeAutoStep({ step: { id: 'nope', kind: 'build', toolCalls: 1 }, steps: long, models }).inline, true);
		});

		test('reuse: newest idle finished helper of the same tier and folder', () => {
			const h = (id: string, o: Partial<{ tier: 'small' | 'medium'; idle: boolean; sameFolder: boolean; finishedAt: number }>) => ({ id, tier: 'medium' as const, idle: true, finished: true, sameFolder: true, finishedAt: 1, ...o });
			assert.strictEqual(pickReusableHelper('medium', [h('old', {}), h('new', { finishedAt: 5 }), h('busy', { idle: false, finishedAt: 9 }), h('small', { tier: 'small', finishedAt: 9 }), h('elsewhere', { sameFolder: false, finishedAt: 9 })])?.id, 'new');
			assert.strictEqual(pickReusableHelper('medium', []), undefined);
		});
	});
});
