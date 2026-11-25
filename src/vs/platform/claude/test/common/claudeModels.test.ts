/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeModelInfo } from '../../common/claude.js';
import { claudeModelDisplayName, cycleClaudeModel, enabledClaudeModelsSetting, isClaudeModelEnabled, isKnownClaudeModel, pickableClaudeModels, readClaudeModelIdList, resolveClaudeModel } from '../../common/claudeModels.js';

const reported: ClaudeModelInfo[] = [
	{ id: 'opus', displayName: 'Opus', source: 'runtime' },
	{ id: 'sonnet', displayName: 'Sonnet', source: 'runtime' },
	{ id: 'haiku', displayName: 'Haiku', source: 'runtime' },
];

suite('Claude model settings (spec 34b)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('list settings are trimmed, de-duplicated, and ignore non-strings', () => {
		assert.deepStrictEqual(readClaudeModelIdList([' opus ', 'opus', '', 3, 'my-model']), ['opus', 'my-model']);
		assert.deepStrictEqual(readClaudeModelIdList('opus'), []);
		assert.deepStrictEqual(readClaudeModelIdList(undefined), []);
	});

	test('the picker shows enabled runtime models, then custom ids; empty means all', () => {
		assert.deepStrictEqual(pickableClaudeModels(reported, [], []).map(model => model.id), ['opus', 'sonnet', 'haiku']);
		assert.deepStrictEqual(pickableClaudeModels(reported, ['haiku', 'opus'], ['my-model', 'opus']), [
			{ id: 'opus', displayName: 'Opus', source: 'runtime' },
			{ id: 'haiku', displayName: 'Haiku', source: 'runtime' },
			{ id: 'my-model', displayName: 'my-model', source: 'custom' },
		]);
	});

	test('the picker leaves out the default alias, and names an alias by the model it runs', () => {
		const live: ClaudeModelInfo[] = [
			{ id: 'default', displayName: 'Default (recommended)', source: 'runtime', resolvedModel: 'claude-opus-5-5[1m]' },
			{ id: 'opus[1m]', displayName: 'Opus (1M context)', source: 'runtime', resolvedModel: 'claude-opus-5-5[1m]' },
			{ id: 'opus', displayName: 'Opus', source: 'runtime', resolvedModel: 'claude-opus-5-5' },
		];
		assert.deepStrictEqual([
			pickableClaudeModels(live, [], []).map(model => model.id),
			pickableClaudeModels(live, ['default'], []).map(model => model.id),
			live.map(claudeModelDisplayName),
			reported.map(claudeModelDisplayName),
		], [['opus[1m]', 'opus'], ['opus[1m]', 'opus'], ['Opus 5.5', 'Opus 5.5', 'Opus 5.5'], ['Opus', 'Sonnet', 'Haiku']]);
	});

	test('a stale enabled list does not empty the picker', () => {
		assert.deepStrictEqual(pickableClaudeModels(reported, ['gone'], []).map(model => model.id), ['opus', 'sonnet', 'haiku']);
		assert.strictEqual(isClaudeModelEnabled('sonnet', ['gone'], ['opus', 'sonnet']), true);
		assert.strictEqual(isClaudeModelEnabled('sonnet', ['opus'], ['opus', 'sonnet']), false);
		assert.strictEqual(isClaudeModelEnabled('sonnet', [], ['opus', 'sonnet']), true);
	});

	test('a disabled model is still a known model, so setting it explicitly works', () => {
		assert.strictEqual(isKnownClaudeModel('haiku', reported, []), true);
		assert.strictEqual(isKnownClaudeModel('my-model', reported, ['my-model']), true);
		assert.strictEqual(isKnownClaudeModel('invented', reported, []), false);
	});

	test('Cycle Model wraps and starts at the first model when the current one is not listed', () => {
		const models = pickableClaudeModels(reported, ['opus', 'haiku'], ['my-model']);
		assert.deepStrictEqual([
			cycleClaudeModel(models, undefined)?.id,
			cycleClaudeModel(models, 'opus')?.id,
			cycleClaudeModel(models, 'haiku')?.id,
			cycleClaudeModel(models, 'my-model')?.id,
			cycleClaudeModel(models, 'sonnet')?.id,
			cycleClaudeModel([], 'opus')?.id,
		], ['opus', 'haiku', 'my-model', 'opus', 'opus', undefined]);
	});

	test('Cycle Model skips older models; from one, it goes to the first current model', () => {
		const models: ClaudeModelInfo[] = [
			{ id: 'opus', displayName: 'Opus', source: 'runtime' },
			{ id: 'claude-opus-4-6', displayName: 'Opus 4.6', source: 'runtime', older: true },
			{ id: 'haiku', displayName: 'Haiku', source: 'runtime' },
		];
		assert.deepStrictEqual([
			cycleClaudeModel(models, 'opus')?.id,
			cycleClaudeModel(models, 'haiku')?.id,
			cycleClaudeModel(models, 'claude-opus-4-6')?.id,
			cycleClaudeModel([models[1]], undefined)?.id,
		], ['haiku', 'opus', 'opus', 'claude-opus-4-6']);
	});

	test('the Models page stores all-on as [] and refuses an empty selection', () => {
		const ids = reported.map(model => model.id);
		assert.deepStrictEqual(enabledClaudeModelsSetting(ids, ['haiku', 'opus', 'sonnet']), []);
		assert.deepStrictEqual(enabledClaudeModelsSetting(ids, ['haiku', 'opus']), ['opus', 'haiku']);
		assert.strictEqual(enabledClaudeModelsSetting(ids, []), undefined);
		assert.strictEqual(enabledClaudeModelsSetting(ids, ['gone']), undefined);
	});

	test('the model a turn runs resolves to a reported row, never to "Default"', () => {
		const models: ClaudeModelInfo[] = [
			{ id: 'default', displayName: 'Default (recommended)', source: 'runtime', resolvedModel: 'claude-sonnet-5-5' },
			{ id: 'opus', displayName: 'Opus', source: 'runtime', resolvedModel: 'claude-opus-5-5' },
			{ id: 'sonnet', displayName: 'Sonnet', source: 'runtime', resolvedModel: 'claude-sonnet-5-5' },
		];
		assert.deepStrictEqual([
			resolveClaudeModel(models, undefined)?.id,
			resolveClaudeModel(models, 'opus')?.id,
			resolveClaudeModel(models, 'claude-sonnet-5-5')?.id,
			resolveClaudeModel(models, 'my-model')?.id,
			resolveClaudeModel(models.slice(1), undefined)?.id,
			resolveClaudeModel([], undefined)?.id,
			claudeModelDisplayName(resolveClaudeModel(models, undefined)!),
		], ['default', 'opus', 'sonnet', undefined, 'opus', undefined, 'Sonnet 5.5']);
	});
});
