/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import Severity from '../../../../base/common/severity.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService, NeverShowAgainScope } from '../../../../platform/notification/common/notification.js';
import { CLAUDE_ADD_TERMINAL_PLUGIN_COMMAND_ID } from '../../../../platform/claude/common/claudeTerminalPlugin.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { claudeShouldOfferComingFromTerminal } from '../common/claudeComingFromTerminal.js';
import { CLAUDE_TERMINAL_BROWSER_COMMAND_ID } from './claudeTerminalBrowserCommand.js';

const OFFERED_KEY = 'klawly.comingFromTerminal.offered';

/**
 * Issue 1186: on the first run, when `~/.claude` exists, says what Klawly shares with Claude Code and offers to
 * continue a recent terminal session or add `/klawly` to the terminal. Shown once per profile.
 */
export class ClaudeComingFromTerminalContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeComingFromTerminal';

	constructor(
		@IStorageService private readonly _storage: IStorageService,
		@IFileService private readonly _files: IFileService,
		@IPathService private readonly _paths: IPathService,
		@INotificationService private readonly _notifications: INotificationService,
		@ICommandService private readonly _commands: ICommandService,
	) {
		super();
		void this.offer();
	}

	private async offer(): Promise<void> {
		const offered = this._storage.getBoolean(OFFERED_KEY, StorageScope.PROFILE, false);
		if (offered) {
			return;
		}
		const home = joinPath(await this._paths.userHome({ preferLocal: true }), '.claude');
		const exists = await this._files.exists(home).catch(() => false);
		if (!claudeShouldOfferComingFromTerminal(exists, offered)) {
			return;
		}
		this._storage.store(OFFERED_KEY, true, StorageScope.PROFILE, StorageTarget.MACHINE);
		this._notifications.prompt(
			Severity.Info,
			localize('klawlyComingFromTerminal', "Coming from Claude Code? Klawly shares your sessions, settings, plugins and CLAUDE.md with it, so you can pick up where the terminal left off."),
			[
				{ label: localize('klawlyComingFromTerminalContinue', "Continue a Session"), run: () => this._commands.executeCommand(CLAUDE_TERMINAL_BROWSER_COMMAND_ID) },
				{ label: localize('klawlyComingFromTerminalPlugin', "Add /klawly"), run: () => this._commands.executeCommand(CLAUDE_ADD_TERMINAL_PLUGIN_COMMAND_ID) },
			],
			{ neverShowAgain: { id: OFFERED_KEY, scope: NeverShowAgainScope.PROFILE } },
		);
	}
}
