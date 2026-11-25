/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { readClaudeConfiguredSessionSettings } from '../../common/claudeConfiguration.js';
import { claudeEffortLevelsFor, claudeFlagSettingsPatch, ClaudeSettingsCapabilities, claudeSettingsProblem, claudeStartSettings, claudeSupportsUltracode, fitClaudeSessionSettings, readClaudeSessionSettings, sameClaudeSessionSettings } from '../../common/claudeSessionSettings.js';

const opus: ClaudeSettingsCapabilities = { supportsEffort: true, supportedEffortLevels: ['max', 'low', 'xhigh', 'medium', 'high'], supportsAdaptiveThinking: true, supportsFastMode: true };
const noXhigh: ClaudeSettingsCapabilities = { supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] };
const plain: ClaudeSettingsCapabilities = {};

suite('Claude session settings (Phase 33)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('values from IPC or settings keep only what Claude Code takes', () => {
		assert.deepStrictEqual([
			readClaudeSessionSettings({ effort: 'high', fastMode: true, ultracode: true, thinking: false }),
			readClaudeSessionSettings({ effort: 'extreme', fastMode: 'yes', ultracode: false, thinking: true }),
			readClaudeSessionSettings(null),
			readClaudeSessionSettings('high'),
			sameClaudeSessionSettings({ effort: 'low' }, { effort: 'low' }),
			sameClaudeSessionSettings({ effort: 'low' }, { effort: 'low', fastMode: true }),
		], [
			{ effort: 'high', fastMode: true, ultracode: true, thinking: false },
			{},
			{},
			{},
			true,
			false,
		]);
	});

	test('effort levels come lowest first, only from models that take effort; Ultracode needs extra high', () => {
		assert.deepStrictEqual([
			claudeEffortLevelsFor(opus),
			claudeEffortLevelsFor(noXhigh),
			claudeEffortLevelsFor({ supportsEffort: false, supportedEffortLevels: ['low'] }),
			claudeEffortLevelsFor(plain),
			claudeEffortLevelsFor(undefined),
			[claudeSupportsUltracode(opus), claudeSupportsUltracode(noXhigh), claudeSupportsUltracode(undefined)],
		], [['low', 'medium', 'high', 'xhigh', 'max'], ['low', 'medium', 'high'], [], [], [], [true, false, false]]);
	});

	test('a model refuses what it lacks, in plain words', () => {
		assert.deepStrictEqual([
			claudeSettingsProblem(opus, { effort: 'max', ultracode: true, fastMode: true, thinking: false }),
			claudeSettingsProblem(plain, { effort: 'high' }),
			claudeSettingsProblem(noXhigh, { effort: 'max' }),
			claudeSettingsProblem(noXhigh, { ultracode: true }),
			claudeSettingsProblem(noXhigh, { fastMode: true }),
			claudeSettingsProblem(noXhigh, { thinking: false }),
			claudeSettingsProblem(undefined, {}),
		], [
			undefined,
			'This model takes no effort level.',
			'This model does not take max effort.',
			'Ultracode needs a model with extra high effort.',
			'This model has no fast mode.',
			'Thinking can be turned off only on a model with adaptive thinking.',
			undefined,
		]);
	});

	test('switching models keeps the nearest lower effort and drops switches the model lacks', () => {
		assert.deepStrictEqual([
			fitClaudeSessionSettings(noXhigh, { effort: 'xhigh', ultracode: true, fastMode: true, thinking: false }),
			fitClaudeSessionSettings(noXhigh, { effort: 'max' }),
			fitClaudeSessionSettings({ supportsEffort: true, supportedEffortLevels: ['high', 'max'] }, { effort: 'low' }),
			fitClaudeSessionSettings(plain, { effort: 'high' }),
			fitClaudeSessionSettings(opus, { effort: 'max', ultracode: true, fastMode: true, thinking: false }),
		], [
			{ effort: 'high' },
			{ effort: 'high' },
			{ effort: 'high' },
			{},
			{ effort: 'max', ultracode: true, fastMode: true, thinking: false },
		]);
	});

	test('a session opens with its effort, or with Ultracode instead of an effort', () => {
		assert.deepStrictEqual([
			claudeStartSettings({}),
			claudeStartSettings({ effort: 'max' }),
			claudeStartSettings({ effort: 'low', ultracode: true, fastMode: true, thinking: false }),
		], [
			{ effort: undefined, flagSettings: undefined },
			{ effort: 'max', flagSettings: undefined },
			{ effort: undefined, flagSettings: { fastMode: true, ultracode: true, alwaysThinkingEnabled: false } },
		]);
	});

	test('a live change sends only what differs; Ultracode off restores the chosen effort', () => {
		assert.deepStrictEqual([
			claudeFlagSettingsPatch({ effort: 'high' }, { effort: 'high' }),
			claudeFlagSettingsPatch({}, { effort: 'max' }),
			claudeFlagSettingsPatch({ effort: 'max' }, {}),
			claudeFlagSettingsPatch({ effort: 'medium' }, { effort: 'medium', ultracode: true }),
			claudeFlagSettingsPatch({ effort: 'medium', ultracode: true }, { effort: 'medium' }),
			claudeFlagSettingsPatch({ ultracode: true }, {}),
			claudeFlagSettingsPatch({ effort: 'low', ultracode: true }, { effort: 'high', ultracode: true }),
			claudeFlagSettingsPatch({ fastMode: true }, { thinking: false }),
		], [
			undefined,
			{ effortLevel: 'max' },
			{ effortLevel: null },
			{ ultracode: true },
			{ ultracode: null, effortLevel: 'medium' },
			{ ultracode: null, effortLevel: null },
			undefined,
			{ fastMode: null, alwaysThinkingEnabled: false },
		]);
	});

	test('configured defaults are read per model; Max is never a configured default', () => {
		const effort = { default: 'medium', opus: 'xhigh', sonnet: 'max', haiku: 7 };
		assert.deepStrictEqual([
			readClaudeConfiguredSessionSettings(undefined, effort, false, false),
			readClaudeConfiguredSessionSettings('opus', effort, true, true),
			readClaudeConfiguredSessionSettings('sonnet', effort, undefined, undefined),
			readClaudeConfiguredSessionSettings('haiku', effort, 'yes', 1),
			readClaudeConfiguredSessionSettings('opus', ['high'], undefined, undefined),
		], [
			{ effort: 'medium' },
			{ effort: 'xhigh', fastMode: true, ultracode: true },
			{},
			{},
			{},
		]);
	});
});
