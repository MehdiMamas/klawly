/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING } from '../../../../platform/claude/common/claudeConfiguration.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IClaudePermissionService } from '../../../services/claude/common/claudePermissionService.js';
import { claudePermissionLevelToMigrate } from '../common/claudePermissionLevels.js';

const MIGRATED_KEY = 'claude.permissionLevel.migrated';

/**
 * Keeps the permission level (issue 453) working in every window: it moves an
 * existing install to its old default once, and creates the permission service
 * so the one-time Allow Everything warning shows whenever the level changes.
 */
export class ClaudePermissionLevelContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudePermissionLevel';

	constructor(
		@IStorageService private readonly _storage: IStorageService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IClaudePermissionService _permissions: IClaudePermissionService,
	) {
		super();
		this.migrate().catch(onUnexpectedError);
	}

	private async migrate(): Promise<void> {
		if (this._storage.getBoolean(MIGRATED_KEY, StorageScope.APPLICATION, false)) {
			return;
		}
		this._storage.store(MIGRATED_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		const level = claudePermissionLevelToMigrate(this._storage.isNew(StorageScope.APPLICATION), this._configuration.inspect(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING).userValue);
		if (level) {
			await this._configuration.updateValue(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, level, ConfigurationTarget.USER);
		}
	}
}
