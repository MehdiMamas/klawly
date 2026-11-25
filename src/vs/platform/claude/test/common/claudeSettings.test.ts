/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_AGENT_AUTO_APPROVE_READS_SETTING, CLAUDE_AGENT_AUTO_APPROVE_WRITES_SETTING, CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING, CLAUDE_LEGACY_KEYBINDINGS_PRESET_SETTING, CLAUDE_LEGACY_LONG_PASTE_SETTING, CLAUDE_LONG_PASTE_DEFAULT, CLAUDE_LONG_PASTE_SETTING, CLAUDE_PERMISSION_SETTINGS, migrateClaudeKeybindingsPresetSetting, migrateClaudeLongPasteSetting, readClaudeAgentEnabled, readClaudeAllowEverythingConfirm, readClaudePermissionPreset, readClaudeBuiltInAgents, readClaudeDefaultMode, readClaudeLongPasteChars, readClaudeModelId, readClaudePasteAsReference, readClaudePermissionPolicy, readClaudeSaveBeforeCommands } from '../../common/claudeConfiguration.js';
import { DEFAULT_PERMISSION_POLICY } from '../../common/claudePermissions.js';
import { decidePaste } from '../../common/claudePrompt.js';

suite('Claude settings (spec 46)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the old long-paste key moves to longPasteChipChars unless that is already set', () => {
		assert.deepStrictEqual(migrateClaudeLongPasteSetting(900, undefined), [
			[CLAUDE_LONG_PASTE_SETTING, { value: 900 }],
			[CLAUDE_LEGACY_LONG_PASTE_SETTING, { value: undefined }],
		]);
		assert.deepStrictEqual(migrateClaudeLongPasteSetting(900, 3000), [[CLAUDE_LEGACY_LONG_PASTE_SETTING, { value: undefined }]]);
		assert.deepStrictEqual(migrateClaudeLongPasteSetting('lots', undefined), [[CLAUDE_LEGACY_LONG_PASTE_SETTING, { value: undefined }]]);
	});

	test('the old keymap preset key moves to klawlyKeys unless that is already set (issue 553)', () => {
		const remove = [CLAUDE_LEGACY_KEYBINDINGS_PRESET_SETTING, { value: undefined }];
		assert.deepStrictEqual({
			off: migrateClaudeKeybindingsPresetSetting(false, undefined),
			alreadySet: migrateClaudeKeybindingsPresetSetting(false, true),
			notBoolean: migrateClaudeKeybindingsPresetSetting('yes', undefined),
		}, {
			off: [[CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING, { value: false }], remove],
			alreadySet: [remove],
			notBoolean: [remove],
		});
	});

	test('readers use the new key, then the old one until migration ran, then the default', () => {
		assert.deepStrictEqual([
			readClaudeLongPasteChars(3000, 900),
			readClaudeLongPasteChars(undefined, 900),
			readClaudeLongPasteChars(undefined, undefined),
			readClaudeLongPasteChars(0, -1),
			readClaudeLongPasteChars(12.7, undefined),
		], [3000, 900, CLAUDE_LONG_PASTE_DEFAULT, CLAUDE_LONG_PASTE_DEFAULT, 12]);
	});

	test('pasteAsReference off inserts copied code and long text instead of chips', () => {
		const long = 'x'.repeat(CLAUDE_LONG_PASTE_DEFAULT);
		const base = { plain: false, hasImage: false, longPasteCharacters: CLAUDE_LONG_PASTE_DEFAULT };
		assert.deepStrictEqual([
			decidePaste({ ...base, text: 'a', copied: true }),
			decidePaste({ ...base, text: long, copied: false }),
			decidePaste({ ...base, text: 'a', copied: true, asReference: false }),
			decidePaste({ ...base, text: long, copied: false, asReference: false }),
			decidePaste({ ...base, text: '', copied: false, hasImage: true, asReference: false }),
			readClaudePasteAsReference(undefined),
			readClaudePasteAsReference(false),
		], ['selection-chip', 'paste-pill', 'insert', 'insert', 'image', true, false]);
	});

	test('missing or invalid values take the safe default', () => {
		assert.deepStrictEqual([
			readClaudeAgentEnabled(undefined),
			readClaudeAgentEnabled(false),
			readClaudeDefaultMode('plan'),
			readClaudeDefaultMode('ask'),
			readClaudeDefaultMode('bogus'),
			readClaudeModelId('  '),
			readClaudeModelId(' opus '),
			readClaudeBuiltInAgents(undefined),
			readClaudeBuiltInAgents(false),
		], [true, false, 'plan', 'ask', 'agent', undefined, 'opus', true, false]);
	});

	test('saveBeforeCommands reads the three modes and takes prompt for anything else', () => {
		assert.deepStrictEqual(['always', 'never', 'prompt', undefined, 'sometimes'].map(readClaudeSaveBeforeCommands), ['always', 'never', 'prompt', 'prompt', 'prompt']);
	});

	test('the permission settings map onto the one host policy', () => {
		const policy = (values: Record<string, unknown>) => readClaudePermissionPolicy(key => values[key]);
		// No setting: Strict, the default for a new install (issue 453).
		assert.deepStrictEqual(policy({}), policy({ [CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING]: 'strict' }));
		assert.strictEqual(DEFAULT_PERMISSION_POLICY.writeWorkspace, 'ask');
		// prompt makes workspace edits ask, unless another opt-in allows them.
		const prompt = { [CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING]: 'prompt' };
		assert.strictEqual(policy(prompt).writeWorkspace, 'ask');
		assert.strictEqual(policy({ ...prompt, [CLAUDE_AGENT_AUTO_APPROVE_WRITES_SETTING]: true }).writeWorkspace, 'allow');
		assert.strictEqual(policy({ ...prompt, [CLAUDE_PERMISSION_SETTINGS.writeWorkspace]: 'allow' }).writeWorkspace, 'allow');
		assert.strictEqual(policy({ ...prompt, [CLAUDE_AGENT_AUTO_APPROVE_WRITES_SETTING]: 'yes' }).writeWorkspace, 'ask');
		assert.strictEqual(policy({ [CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING]: 'acceptEdits' }).writeWorkspace, 'allow');
		// Only an explicit false makes workspace reads ask. The PreToolUse screen enforces it.
		assert.deepStrictEqual([false, true, undefined, 'no'].map(value => policy({ [CLAUDE_AGENT_AUTO_APPROVE_READS_SETTING]: value }).readWorkspace), ['ask', 'allow', 'allow', 'allow']);
		// Strict asks for edits and turns the other questions into refusals.
		assert.deepStrictEqual(policy({ [CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING]: 'strict' }), {
			readWorkspace: 'allow',
			writeWorkspace: 'ask',
			writeOutsideWorkspace: 'deny',
			shellSafe: 'allow',
			shellDestructive: 'deny',
			network: 'deny',
		});
		assert.strictEqual(policy({ [CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING]: 'strict', [CLAUDE_PERMISSION_SETTINGS.network]: 'allow' }).network, 'allow');
		// An unknown preset is read as strict, the cautious choice. The Allow Everything levels keep the prompt
		// policy: the session switches approve what asks, and what the settings refuse stays refused (issue 453).
		assert.deepStrictEqual(policy({ [CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING]: 'bypass' }), policy({}));
		assert.deepStrictEqual(policy({ [CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING]: 'allowEverything' }), policy(prompt));
		assert.deepStrictEqual([undefined, 'prompt', 'acceptEdits', 'strict', 'allowEverythingExceptCredentials', 'allowEverything', 'bypass', 42].map(readClaudePermissionPreset), ['strict', 'prompt', 'acceptEdits', 'strict', 'allowEverythingExceptCredentials', 'allowEverything', 'strict', 'strict']);
	});

	test('the Allow Everything confirm is on unless explicitly false', () => {
		assert.deepStrictEqual([undefined, true, 'no', false].map(readClaudeAllowEverythingConfirm), [true, true, true, false]);
	});
});
