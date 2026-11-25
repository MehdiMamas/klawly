/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { agentsWindowTitle } from '../common/agentsWindowTitle.js';

/** Keeps the Agents window's title in step with its folder, so the taskbar and window switcher tell windows apart. */
export class AgentsWindowTitleContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.agentsWindowTitle';

	constructor(@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService) {
		super();
		this._update();
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this._update()));
	}

	private _update(): void {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		mainWindow.document.title = agentsWindowTitle(folder ? basename(folder.uri) : undefined);
	}
}
