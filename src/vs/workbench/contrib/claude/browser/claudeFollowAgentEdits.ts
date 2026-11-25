/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveElement, isEditableElement } from '../../../../base/browser/dom.js';
import { basename } from '../../../../base/common/resources.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { claudeFollowAction } from './claudeFollowAction.js';
import { IClaudeFileTouchService } from '../../../services/claude/common/claudeFileTouchService.js';

export const CLAUDE_FOLLOW_AGENT_EDITS_SETTING = 'claude.editor.followAgentEdits';
const CLAUDE_FOLLOW_OPEN_COMMAND_ID = 'claude.followAgentEdits.open';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'claude',
	order: 102,
	title: localize('claudeFollowConfigurationTitle', "AI / Claude"),
	type: 'object',
	properties: {
		[CLAUDE_FOLLOW_AGENT_EDITS_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeFollowAgentEdits', "Opens a file in a preview tab when Claude starts editing it. While you are typing, a \"Claude is editing\" item in the status bar replaces the tab so your focus is never taken."),
		},
	},
});

/** Follow mode (issue 1176): the editor follows the file Claude is editing, without stealing focus from typing. */
class ClaudeFollowAgentEditsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.claudeFollowAgentEdits';

	private readonly _pill = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private _target: URI | undefined;

	constructor(
		@IClaudeFileTouchService touch: IClaudeFileTouchService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IEditorService private readonly _editors: IEditorService,
		@IStatusbarService private readonly _statusbar: IStatusbarService,
	) {
		super();
		this._register(CommandsRegistry.registerCommand(CLAUDE_FOLLOW_OPEN_COMMAND_ID, () => {
			const target = this._target;
			this._pill.clear();
			this._target = undefined;
			return target ? this._editors.openEditor({ resource: target, options: { preserveFocus: false } }) : undefined;
		}));
		this._register(touch.onDidChange(paths => {
			const active = paths.find(path => touch.petsOf(path).active.length > 0);
			if (active) {
				this.follow(URI.file(active));
			} else if (this._target && touch.petsOf(this._target.fsPath).active.length === 0) {
				this._pill.clear();
				this._target = undefined;
			}
		}));
	}

	private follow(resource: URI): void {
		const enabled = this._configuration.getValue<boolean>(CLAUDE_FOLLOW_AGENT_EDITS_SETTING) !== false;
		const element = getActiveElement();
		const action = claudeFollowAction(enabled, !!element && isEditableElement(element));
		if (action === 'open') {
			this._pill.clear();
			this._target = undefined;
			this._editors.openEditor({ resource, options: { preserveFocus: true, pinned: false } });
		} else if (action === 'pill') {
			this._target = resource;
			const name = basename(resource);
			this._pill.value = this._statusbar.addEntry({
				name: localize('claudeFollowPillName', "Claude Is Editing"),
				text: `$(edit) ${localize("claudeFollowPill", "Claude is editing {0}", name)}`,
				ariaLabel: localize('claudeFollowPillAria', "Claude is editing {0}. Select to open it.", name),
				tooltip: localize('claudeFollowPillTooltip', "Open {0} where Claude is editing it", name),
				command: CLAUDE_FOLLOW_OPEN_COMMAND_ID,
			}, 'claude.followAgentEdits', StatusbarAlignment.LEFT, 100);
		}
	}
}

registerWorkbenchContribution2(ClaudeFollowAgentEditsContribution.ID, ClaudeFollowAgentEditsContribution, WorkbenchPhase.AfterRestored);
