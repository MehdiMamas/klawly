/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING, CLAUDE_LEGACY_KEYBINDINGS_PRESET_SETTING, CLAUDE_LEGACY_LONG_PASTE_SETTING, CLAUDE_LONG_PASTE_SETTING, migrateClaudeKeybindingsPresetSetting, migrateClaudeLongPasteSetting } from '../../../../platform/claude/common/claudeConfiguration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, IConfigurationMigrationRegistry } from '../../../common/configuration.js';

let registered = false;

/**
 * Settings renamed after they shipped. `claude.composer.longPasteCharacters`
 * became the spec 46 `claude.composer.longPasteChipChars`: the value moves unless
 * the new key is already set, and the old key is removed. The keymap preset's
 * old key moves to `claude.keybindings.klawlyKeys` the same way (issue 553).
 * Registers once.
 */
export function registerClaudeSettingsMigrations(): void {
	if (registered) {
		return;
	}
	registered = true;
	Registry.as<IConfigurationMigrationRegistry>(Extensions.ConfigurationMigration).registerConfigurationMigrations([{
		key: CLAUDE_LEGACY_LONG_PASTE_SETTING,
		includeApplication: true,
		migrateFn: (value: unknown, valueAccessor: (key: string) => unknown) => migrateClaudeLongPasteSetting(value, valueAccessor(CLAUDE_LONG_PASTE_SETTING)),
	}, {
		key: CLAUDE_LEGACY_KEYBINDINGS_PRESET_SETTING,
		includeApplication: true,
		migrateFn: (value: unknown, valueAccessor: (key: string) => unknown) => migrateClaudeKeybindingsPresetSetting(value, valueAccessor(CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING)),
	}]);
}
