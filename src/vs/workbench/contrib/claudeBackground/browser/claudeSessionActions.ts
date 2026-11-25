/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { CLAUDE_AGENT_ENABLED } from '../../claude/common/claudeContextKeys.js';
import { KLAWLY_CATEGORY } from '../../claude/common/claudeViews.js';
import { CLAUDE_SESSIONS_VIEW_ID } from '../common/claudeBackground.js';
import { ClaudeMachineSessionsViewPane } from './claudeMachineSessionsViewPane.js';

/** The Show All Claude Sessions and Clean Up Finished and Idle Sessions commands (issue 1251). */
export function registerClaudeSessionCommands(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'claude.sessions.show',
				title: localize2('claudeSessionsShow', "Show All Claude Sessions"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IViewsService).openView(CLAUDE_SESSIONS_VIEW_ID, true);
		}
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'claude.sessions.cleanUp',
				title: localize2('claudeSessionsCleanUpCommand', "Clean Up Finished and Idle Sessions"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const pane = await accessor.get(IViewsService).openView<ClaudeMachineSessionsViewPane>(CLAUDE_SESSIONS_VIEW_ID, true);
			await pane?.refresh();
			await pane?.cleanUp();
		}
	});
}
