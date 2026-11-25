/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname } from '../../../base/common/path.js';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { ILogService } from '../../log/common/log.js';
import { CLAUDE_AUTOMATIONS_ENABLED_SETTING, CLAUDE_AUTOMATIONS_RUN_AT_LOGIN_SETTING } from '../common/claudeAutomation.js';
import { ClaudeLoginHelper } from '../node/claudeLoginHelper.js';

/**
 * Keeps the OS login item in step with the run-at-login setting (issue 463). Runs at start and
 * on every change of either setting; errors are logged, never thrown.
 */
export function registerClaudeLoginItem(configurationService: IConfigurationService, logService: ILogService): IDisposable {
	const helper = new ClaudeLoginHelper({
		platform: process.platform,
		execPath: process.execPath,
		homeDir: homedir(),
		electron: app,
		files: {
			write: (path, content) => {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, content);
			},
			remove: path => rmSync(path, { force: true }),
		},
	});
	const sync = () => {
		try {
			helper.applySettings(key => configurationService.getValue(key));
		} catch (error) {
			logService.error('Failed to update the automations login item', error);
		}
	};
	sync();
	return configurationService.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration(CLAUDE_AUTOMATIONS_RUN_AT_LOGIN_SETTING) || e.affectsConfiguration(CLAUDE_AUTOMATIONS_ENABLED_SETTING)) {
			sync();
		}
	});
}
