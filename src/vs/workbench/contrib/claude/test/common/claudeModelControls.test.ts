/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeModelInfo } from '../../../../../platform/claude/common/claude.js';
import { claudeContextChoice, claudeEffortValue, claudeFastModeBadge, claudeFastModeDetail, claudeFastModeDropNotice, claudeModelDescription, claudeModelFamily, claudeModelHover, claudeModelName, claudeModelQualifier, claudeModelSectionLabel, groupClaudeModels, isLongClaudePrompt } from '../../common/claudeModelControls.js';

const models: ClaudeModelInfo[] = [
	{ id: 'sonnet', displayName: 'Sonnet', source: 'alias', resolvedModel: 'claude-sonnet-5' },
	{ id: 'opus', displayName: 'Opus', source: 'alias', resolvedModel: 'claude-opus-5-5', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'xhigh'], supportsFastMode: true, supportsAdaptiveThinking: true },
	{ id: 'opus[1m]', displayName: 'Opus (1M)', source: 'alias', resolvedModel: 'claude-opus-5-5[1m]' },
	{ id: 'sonnet-legacy[1m]', displayName: 'Sonnet Legacy (1M)', source: 'runtime' },
	{ id: 'opusplan', displayName: 'opusplan', source: 'alias' },
	{ id: 'haiku', displayName: 'Haiku', source: 'alias', resolvedModel: 'claude-haiku-4-5' },
	{ id: 'mystery', displayName: 'Mystery', source: 'runtime' },
	{ id: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5', source: 'runtime', older: true },
	{ id: 'claude-opus-4-6', displayName: 'Opus 4.6', source: 'runtime', older: true },
	{ id: 'my-model', displayName: 'my-model', source: 'custom' },
];

suite('Claude model controls (Phase 33)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the pill qualifier names the effort the session sends, Ultracode and fast mode, and nothing when it sends none (#95)', () => {
		assert.deepStrictEqual([
			claudeModelQualifier({}),
			claudeModelQualifier({ effort: 'xhigh' }),
			claudeModelQualifier({ effort: 'low', ultracode: true }),
			claudeModelQualifier({ fastMode: true }),
			claudeModelQualifier({ effort: 'max', fastMode: true }),
			claudeEffortValue({ thinking: false }),
		], [undefined, 'Extra High', 'Ultracode', 'Fast', 'Max · Fast', undefined]);
	});

	test('fast mode reads on, cooling down or unavailable in the badge and the menu row, and drops are announced once (issue 456)', () => {
		const time = (ms: number) => `t${ms}`;
		const on = { state: 'on' } as const;
		const cooling = { state: 'cooldown', resumesAt: 5 } as const;
		const unavailable = { state: 'unavailable', reason: 'billing' } as const;
		assert.deepStrictEqual({
			badges: [claudeFastModeBadge(undefined), claudeFastModeBadge(on), claudeFastModeBadge(cooling), claudeFastModeBadge(unavailable)],
			qualifier: [claudeModelQualifier({ effort: 'max', fastMode: true }, cooling), claudeModelQualifier({ fastMode: true }, unavailable)],
			details: [claudeFastModeDetail(undefined), claudeFastModeDetail(on), claudeFastModeDetail(cooling, time), claudeFastModeDetail({ state: 'cooldown' }), claudeFastModeDetail(unavailable), claudeFastModeDetail({ state: 'unavailable', reason: 'other', detail: 'maintenance' })],
			notices: [
				claudeFastModeDropNotice(on, cooling),
				claudeFastModeDropNotice(on, unavailable),
				claudeFastModeDropNotice(cooling, unavailable),
				claudeFastModeDropNotice(undefined, cooling),
				claudeFastModeDropNotice(cooling, on),
			],
		}, {
			badges: ['Fast', 'Fast', 'Fast (cooling down)', 'Fast (unavailable)'],
			qualifier: ['Max · Fast (cooling down)', 'Fast (unavailable)'],
			details: ['Faster, costs more', 'Faster, costs more', 'Cooling down, back around t5', 'Cooling down, using standard speed', 'Unavailable: billing does not allow it', 'Unavailable: maintenance'],
			notices: ['Fast mode paused after a rate limit; using standard speed', 'Fast mode is unavailable (billing does not allow it); using standard speed', undefined, undefined, undefined],
		});
	});

	test('the lineup comes first, then older models, then custom ids, each by family; a 1M variant folds into its standard model', () => {
		assert.deepStrictEqual([
			...groupClaudeModels(models).map(group => [group.section, claudeModelSectionLabel(group.section), group.models.map(model => model.id)]),
			claudeModelFamily({ id: 'x', displayName: 'X', source: 'custom', resolvedModel: 'claude-opus-5-5' }),
		], [
			['current', undefined, ['opus', 'opusplan', 'sonnet', 'sonnet-legacy[1m]', 'haiku', 'mystery']],
			['older', 'Older Models', ['claude-opus-4-6', 'claude-sonnet-4-5']],
			['custom', 'Custom', ['my-model']],
			'custom',
		]);
	});

	test('a model named by its family alone reads with the version it resolves to; a 1M row keeps its qualifier', () => {
		assert.deepStrictEqual([
			...models.map(claudeModelName),
			claudeModelName({ id: 'default', displayName: 'Default (recommended)', source: 'runtime', resolvedModel: 'claude-opus-5-5[1m]' }),
			claudeModelName({ id: 'claude-fable-5-1[1m]', displayName: 'Fable', source: 'runtime', resolvedModel: 'claude-fable-5-1' }),
			claudeModelName({ id: 'haiku', displayName: 'Haiku', source: 'runtime', resolvedModel: 'claude-haiku-4-5-20251001' }),
		], [
			'Sonnet 5', 'Opus 5.5', 'Opus 5.5 (1M)', 'Sonnet Legacy (1M)', 'Opus Plan', 'Haiku 4.5', 'Mystery', 'Sonnet 4.5', 'Opus 4.6', 'my-model',
			'Opus 5.5', 'Fable 5.1', 'Haiku 4.5',
		]);
	});

	test('hover cards are short: the name, what the model is for, and its effort range', () => {
		const [sonnet, opus, , , opusplan, , , , , custom] = models;
		assert.deepStrictEqual([
			[claudeModelName(opusplan), claudeModelDescription(opusplan)],
			[claudeModelName(custom), claudeModelDescription(custom)],
			claudeModelHover(opus)?.split('\n'),
			claudeModelHover(sonnet),
			claudeModelHover(custom)?.split('\n'),
			claudeModelHover({ ...opus, description: 'For complex work', supportedEffortLevels: ['max'] })?.split('\n'),
		], [
			['Opus Plan', 'Opus plans, Sonnet builds'],
			['my-model', 'Custom model ID'],
			['Opus 5.5', 'Effort: Low to Extra High'],
			undefined,
			['my-model', 'Custom model ID'],
			['Opus 5.5', 'For complex work', 'Effort: Max'],
		]);
	});

	test('the Context row appears only when both variants are reported', () => {
		const choice = (id: string | undefined) => {
			const found = claudeContextChoice(models, id);
			return found && [found.standard.id, found.long.id, found.isLong];
		};
		assert.deepStrictEqual([choice('opus'), choice('opus[1m]'), choice('sonnet'), choice('sonnet-legacy[1m]'), choice(undefined)], [
			['opus', 'opus[1m]', false],
			['opus', 'opus[1m]', true],
			undefined,
			undefined,
			undefined,
		]);
	});

	test('a prompt counts as long at 60 words or 6 lines', () => {
		assert.deepStrictEqual([
			isLongClaudePrompt(''),
			isLongClaudePrompt('fix the bug'),
			isLongClaudePrompt(Array(59).fill('word').join(' ')),
			isLongClaudePrompt(Array(60).fill('word').join(' ')),
			isLongClaudePrompt('a\nb\nc\nd\ne'),
			isLongClaudePrompt('a\nb\nc\nd\ne\nf'),
			isLongClaudePrompt('\n\n\nshort\n\n\n'),
		], [false, false, false, true, false, true, false]);
	});
});
