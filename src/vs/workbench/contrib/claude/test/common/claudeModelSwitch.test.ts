/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeModelInfo } from '../../../../../platform/claude/common/claude.js';
import { canonicalClaudeModel, ClaudeModelSwitchInput, claudeFinishedTurns, claudeModelSwitchTokens, claudeModelSwitchWarns } from '../../common/claudeModelSwitch.js';

const models: ClaudeModelInfo[] = [
	{ id: 'default', displayName: 'Default', source: 'alias', resolvedModel: 'claude-opus-5-5' },
	{ id: 'opus', displayName: 'Opus', source: 'alias', resolvedModel: 'claude-opus-5-5' },
	{ id: 'sonnet', displayName: 'Sonnet', source: 'alias', resolvedModel: 'claude-sonnet-5-5' },
	{ id: 'claude-opus-5-5', displayName: 'Opus 5.5', source: 'runtime' },
	{ id: 'my-model', displayName: 'my-model', source: 'custom' },
];

suite('Claude model switch notice (issue 703)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('warns only for another model in a chat with a finished turn, never for Auto or with the setting off', () => {
		const base: ClaudeModelSwitchInput = { finishedTurns: 2, from: 'opus', to: 'sonnet', models, auto: false, enabled: true };
		assert.deepStrictEqual({
			otherModel: claudeModelSwitchWarns(base),
			emptyChat: claudeModelSwitchWarns({ ...base, finishedTurns: 0 }),
			auto: claudeModelSwitchWarns({ ...base, auto: true }),
			off: claudeModelSwitchWarns({ ...base, enabled: false }),
			sameModel: claudeModelSwitchWarns({ ...base, to: 'opus' }),
			aliasToItsModel: claudeModelSwitchWarns({ ...base, to: 'claude-opus-5-5' }),
			defaultToItsModel: claudeModelSwitchWarns({ ...base, from: undefined, to: 'opus' }),
			defaultToAnother: claudeModelSwitchWarns({ ...base, from: undefined, to: 'sonnet' }),
			customModel: claudeModelSwitchWarns({ ...base, to: 'my-model' }),
		}, {
			otherModel: true,
			emptyChat: false,
			auto: false,
			off: false,
			sameModel: false,
			aliasToItsModel: false,
			defaultToItsModel: false,
			defaultToAnother: true,
			customModel: true,
		});
	});

	test('an alias counts as the model it resolves to; with no default row the first model runs', () => {
		const noDefault = models.filter(model => model.id !== 'default');
		assert.deepStrictEqual([
			canonicalClaudeModel('opus', models),
			canonicalClaudeModel(undefined, models),
			canonicalClaudeModel('my-model', models),
			canonicalClaudeModel('unknown', models),
			canonicalClaudeModel(undefined, noDefault),
			canonicalClaudeModel(undefined, []),
		], ['claude-opus-5-5', 'claude-opus-5-5', 'my-model', 'unknown', 'claude-opus-5-5', 'default']);
	});

	test('a turn that ended in any way counts as finished; the size comes from the context meter, rounded, never guessed', () => {
		assert.deepStrictEqual({
			turns: [
				claudeFinishedTurns([]),
				claudeFinishedTurns([{ status: 'running' }]),
				claudeFinishedTurns([{ status: 'complete' }, { status: 'failed' }, { status: 'stopped' }, { status: 'running' }]),
			],
			tokens: [
				claudeModelSwitchTokens(undefined),
				claudeModelSwitchTokens({ inputTokens: 5000 }),
				claudeModelSwitchTokens({ contextTokens: 0, contextWindow: 200000 }),
				claudeModelSwitchTokens({ contextTokens: 640, contextWindow: 200000 }),
				claudeModelSwitchTokens({ contextTokens: 18450, contextWindow: 200000 }),
			],
		}, {
			turns: [0, 0, 3],
			tokens: [undefined, undefined, undefined, 640, 18000],
		});
	});
});
