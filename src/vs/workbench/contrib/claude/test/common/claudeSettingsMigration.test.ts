/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CLAUDE_LEGACY_LONG_PASTE_SETTING, CLAUDE_LONG_PASTE_SETTING } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { ConfigurationTarget, IConfigurationValue } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { ConfigurationMigrationWorkbenchContribution } from '../../../../common/configuration.js';
import { registerClaudeSettingsMigrations } from '../../common/claudeSettingsMigration.js';

/** User settings only, as `inspect` reports them, with every write recorded. */
class UserSettings extends TestConfigurationService {
	readonly writes: [string, unknown, ConfigurationTarget | undefined][] = [];

	constructor(private readonly _user: Record<string, unknown>) {
		super();
	}

	override inspect<T>(key: string): IConfigurationValue<T> {
		const value = this._user[key] as T | undefined;
		return { value, userValue: value, user: value === undefined ? undefined : { value } };
	}

	override updateValue(key: string, value: unknown, ...rest: unknown[]): Promise<void> {
		const target = rest.find((arg): arg is ConfigurationTarget => typeof arg === 'number');
		this.writes.push([key, value, target]);
		if (value === undefined) {
			delete this._user[key];
		} else {
			this._user[key] = value;
		}
		return Promise.resolve();
	}

	get user(): Record<string, unknown> {
		return { ...this._user };
	}
}

const workspace = {
	onDidChangeWorkspaceFolders: Event.None,
	getWorkspace: () => ({ folders: [] }),
	getWorkbenchState: () => WorkbenchState.EMPTY,
} as unknown as IWorkspaceContextService;

suite('Claude settings migration', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function migrate(user: Record<string, unknown>): Promise<UserSettings> {
		registerClaudeSettingsMigrations();
		registerClaudeSettingsMigrations();
		const settings = new UserSettings(user);
		store.add(new ConfigurationMigrationWorkbenchContribution(settings, workspace));
		await timeout(0);
		return settings;
	}

	const ours = (settings: UserSettings) => settings.writes.filter(([key]) => key === CLAUDE_LONG_PASTE_SETTING || key === CLAUDE_LEGACY_LONG_PASTE_SETTING);

	test('the old long-paste key moves to claude.composer.longPasteChipChars and is removed', async () => {
		const settings = await migrate({ [CLAUDE_LEGACY_LONG_PASTE_SETTING]: 900 });
		assert.deepStrictEqual({ writes: ours(settings), user: settings.user }, {
			writes: [
				[CLAUDE_LONG_PASTE_SETTING, 900, ConfigurationTarget.USER],
				[CLAUDE_LEGACY_LONG_PASTE_SETTING, undefined, ConfigurationTarget.USER],
			],
			user: { [CLAUDE_LONG_PASTE_SETTING]: 900 },
		});
	});

	test('a value already set under the new key wins; the old key is still removed', async () => {
		const settings = await migrate({ [CLAUDE_LEGACY_LONG_PASTE_SETTING]: 900, [CLAUDE_LONG_PASTE_SETTING]: 3000 });
		assert.deepStrictEqual({ writes: ours(settings), user: settings.user }, {
			writes: [[CLAUDE_LEGACY_LONG_PASTE_SETTING, undefined, ConfigurationTarget.USER]],
			user: { [CLAUDE_LONG_PASTE_SETTING]: 3000 },
		});
	});

	test('nothing to migrate writes nothing', async () => {
		const settings = await migrate({ [CLAUDE_LONG_PASTE_SETTING]: 1200 });
		assert.deepStrictEqual(ours(settings), []);
	});
});
