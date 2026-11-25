/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService, NeverShowAgainScope, Severity } from '../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { CLAUDE_AGENT_ENABLED_SETTING, readClaudeAgentEnabled } from '../../../../platform/claude/common/claudeConfiguration.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ClaudeSetupPhase } from '../common/claudeRuntimeStatus.js';
import { IClaudeSetupService } from '../browser/claudeSetup.js';

const OFFERED_KEY = 'klawly.shellCommand.offered';
/** Same id as the upstream Shell Command: Install action. */
const INSTALL_COMMAND_ID = 'workbench.action.installCommandLine';

/** What decides whether the offer shows. */
export interface ShellCommandOfferState {
	readonly isMacintosh: boolean;
	readonly isBuilt: boolean;
	readonly offered: boolean;
	readonly agentEnabled: boolean;
	readonly phase: ClaudeSetupPhase;
}

/**
 * The offer waits until the Claude setup card is gone (Claude ready, or Claude
 * features off), so it never competes with it. macOS only: the Windows and
 * Linux installers already put the command on PATH. A dev build has no app
 * bundle to link to.
 */
export function shouldOfferShellCommand(state: ShellCommandOfferState): boolean {
	return state.isMacintosh && state.isBuilt && !state.offered && (!state.agentEnabled || state.phase === 'ready');
}

/**
 * Once per machine, offers to install the `klawly` terminal command so
 * `klawly .` opens a folder, like the Install Claude Code step (issue 1606).
 * Skipped when the command is already in /usr/local/bin. The palette keeps
 * Shell Command: Install 'klawly' command in PATH for later.
 */
export class ClaudeShellCommandOfferContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.klawlyShellCommandOffer';

	private readonly _listener = this._register(new MutableDisposable());

	constructor(
		@IClaudeSetupService private readonly _setup: IClaudeSetupService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IEnvironmentService private readonly _environment: IEnvironmentService,
		@IStorageService private readonly _storage: IStorageService,
		@IFileService private readonly _files: IFileService,
		@IProductService private readonly _product: IProductService,
		@INotificationService private readonly _notifications: INotificationService,
		@ICommandService private readonly _commands: ICommandService,
	) {
		super();
		if (!this.check()) {
			this._listener.value = this._setup.onDidChange(() => this.check());
		}
	}

	/** Returns true once nothing is left to wait for. */
	private check(): boolean {
		const state: ShellCommandOfferState = {
			isMacintosh,
			isBuilt: this._environment.isBuilt,
			offered: this._storage.getBoolean(OFFERED_KEY, StorageScope.APPLICATION, false),
			agentEnabled: readClaudeAgentEnabled(this._configuration.getValue(CLAUDE_AGENT_ENABLED_SETTING)),
			phase: this._setup.phase,
		};
		if (!state.isMacintosh || !state.isBuilt || state.offered) {
			return true;
		}
		if (!shouldOfferShellCommand(state)) {
			return false;
		}
		this._listener.clear();
		this._storage.store(OFFERED_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.offer();
		return true;
	}

	private async offer(): Promise<void> {
		const name = this._product.applicationName;
		if (await this._files.exists(URI.file(`/usr/local/bin/${name}`))) {
			return;
		}
		this._notifications.prompt(
			Severity.Info,
			localize('klawly.shellCommand.offer', "Open folders from the terminal with '{0} .'. Install the '{0}' command?", name),
			[{
				label: localize('klawly.shellCommand.install', "Install '{0}' Command", name),
				run: () => this._commands.executeCommand(INSTALL_COMMAND_ID),
			}],
			{ neverShowAgain: { id: 'klawly.shellCommand.offer', scope: NeverShowAgainScope.APPLICATION } },
		);
	}
}
