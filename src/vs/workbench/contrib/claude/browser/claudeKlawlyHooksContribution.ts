/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IClaudeKlawlyHooksService } from '../../../services/claude/common/claudeKlawlyHooksService.js';

/** Runs the `KlawlyWorkspaceOpen` hooks once per window, as soon as the workspace is trusted (issue 514). */
export class ClaudeKlawlyWorkspaceOpenHooks extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeKlawlyWorkspaceOpenHooks';

	private readonly _waitForTrust = this._register(new MutableDisposable());

	constructor(
		@IClaudeKlawlyHooksService private readonly _hooks: IClaudeKlawlyHooksService,
		@IWorkspaceTrustManagementService private readonly _trust: IWorkspaceTrustManagementService,
	) {
		super();
		void this._start();
	}

	private async _start(): Promise<void> {
		await this._trust.workspaceTrustInitialized;
		if (this._store.isDisposed) {
			return;
		}
		if (this._trust.isWorkspaceTrusted()) {
			void this._hooks.runWorkspaceOpen();
			return;
		}
		this._waitForTrust.value = this._trust.onDidChangeTrust(trusted => {
			if (trusted) {
				this._waitForTrust.clear();
				void this._hooks.runWorkspaceOpen();
			}
		});
	}
}

registerWorkbenchContribution2(ClaudeKlawlyWorkspaceOpenHooks.ID, ClaudeKlawlyWorkspaceOpenHooks, WorkbenchPhase.Eventually);
