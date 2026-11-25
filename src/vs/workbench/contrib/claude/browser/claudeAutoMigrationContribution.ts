/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { migrateClaudeAutoEnabled } from '../../../../platform/claude/common/claudeAutoMigration.js';
import { CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, CLAUDE_AUTO_ENABLED_SETTING, CLAUDE_MODELS_DEFAULT_SETTING, CLAUDE_REVIEW_AUTO_KEEP_SETTING } from '../../../../platform/claude/common/claudeConfiguration.js';
import { CLAUDE_MODELS_AUTO_SETTING } from '../../../../platform/claude/common/claudeAutoModel.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

const MIGRATED_KEY = 'claude.auto.migrated';

/**
 * Moves the old Auto settings (Auto model, Auto permission level, Auto-Keep) to
 * the one `claude.auto.enabled` switch, once per install (issue 1221). The old
 * keys stay as they are.
 */
export class ClaudeAutoMigrationContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeAutoMigration';

	constructor(
		@IStorageService private readonly _storage: IStorageService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
	) {
		super();
		this.migrate().catch(onUnexpectedError);
	}

	private async migrate(): Promise<void> {
		if (this._storage.getBoolean(MIGRATED_KEY, StorageScope.APPLICATION, false)) {
			return;
		}
		this._storage.store(MIGRATED_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		const user = (key: string) => this._configuration.inspect(key).userValue;
		if (user(CLAUDE_AUTO_ENABLED_SETTING) !== undefined) {
			return;
		}
		const enabled = migrateClaudeAutoEnabled({
			modelsAuto: user(CLAUDE_MODELS_AUTO_SETTING),
			permissionMode: user(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING),
			autoKeep: user(CLAUDE_REVIEW_AUTO_KEEP_SETTING),
			defaultModel: user(CLAUDE_MODELS_DEFAULT_SETTING),
		});
		if (enabled !== undefined) {
			await this._configuration.updateValue(CLAUDE_AUTO_ENABLED_SETTING, enabled, ConfigurationTarget.USER);
		}
	}
}
