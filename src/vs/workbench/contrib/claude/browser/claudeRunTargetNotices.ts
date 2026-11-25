/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { localize } from '../../../../nls.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { ClaudeTargetInstall } from '../../../../platform/claude/common/claudeExecutionTarget.js';
import { NormalizedClaudeEvent } from '../../../../platform/claude/common/claudeProtocol.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';

/**
 * What the user must know about where an agent runs (issue 425): a resumed
 * agent that fell back to this computer, and a dev container or SSH host
 * without Claude Code, which Klawly offers to install after asking.
 */
export class ClaudeRunTargetNoticesContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeRunTargetNotices';

	constructor(
		@IClaudeRuntimeService runtime: IClaudeRuntimeService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@INotificationService private readonly _notifications: INotificationService,
		@IDialogService private readonly _dialogs: IDialogService,
		@ITerminalService private readonly _terminals: ITerminalService,
	) {
		super();
		this._register(runtime.onDidEmitEvent(event => this.handle(event)));
	}

	private handle(event: NormalizedClaudeEvent): void {
		if (event.parentRunId !== undefined || !this.ownsSession(event.sessionId)) {
			return;
		}
		if (event.type === 'session.started' && event.target?.notice) {
			this._notifications.notify({ severity: Severity.Warning, message: event.target.notice });
		} else if (event.type === 'session.failed' && event.targetInstall) {
			const install = event.targetInstall;
			this._notifications.prompt(Severity.Warning, localize('claudeTargetInstallNotice', "Claude Code is not installed on {0}.", install.where), [{
				label: localize('claudeTargetInstallAction', "Install Claude Code"),
				run: () => void this.install(install),
			}]);
		}
	}

	/** Every window hears runtime events; only the window that started the session tells the user. */
	private ownsSession(runtimeSessionId: string): boolean {
		return this._agent.getSessions().some(session => this._agent.getRuntimeSessionId(session.id) === runtimeSessionId);
	}

	/** Shows the exact command first, then runs it in a visible terminal. Nothing is installed without a yes. */
	private async install(install: ClaudeTargetInstall): Promise<void> {
		const { confirmed } = await this._dialogs.confirm({
			type: Severity.Info,
			message: localize('claudeTargetInstallTitle', "Install Claude Code on {0}?", install.where),
			detail: localize('claudeTargetInstallDetail', "Klawly runs the official Claude Code installer on {0} in a terminal:\n\n{1}\n\nIt installs Claude Code for that user account. When it finishes, sign in there with `claude auth login` if it asks, then send your message again.", install.where, install.display),
			primaryButton: localize({ key: 'claudeTargetInstallRun', comment: ['&& denotes a mnemonic'] }, "&&Run Installer"),
		});
		if (!confirmed) {
			return;
		}
		const instance = await this._terminals.createTerminal({
			config: {
				name: localize('claudeTargetInstallTerminal', "Install Claude Code on {0}", install.where),
				executable: install.executable,
				args: [...install.args],
				env: install.env ? { ...install.env } : undefined,
			},
		});
		await this._terminals.revealTerminal(instance);
	}
}
