/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ResourceContextKey } from '../../../common/contextkeys.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { CLAUDE_ADD_FILE_COMMAND_ID, CLAUDE_ADD_FILE_TO_NEW_AGENT_COMMAND_ID, CLAUDE_FOCUS_AGENT_COMMAND_ID, CLAUDE_NEW_SESSION_COMMAND_ID, CLAUDE_OPEN_AGENTS_WINDOW_COMMAND_ID } from '../common/claudeViews.js';

/** The editor context menu's agent group, right after Go to and Peek (ide-18). */
export const CLAUDE_EDITOR_CONTEXT_GROUP = '1_claude';
/** The Explorer context menu's agent group, after Compare and before Find in Folder (ide-19). */
export const CLAUDE_EXPLORER_CONTEXT_GROUP = '4_claude';
/** The editor tab context menu's agent group, after the close and copy-path groups (ide-44). */
const CLAUDE_TAB_CONTEXT_GROUP = '2_claude';

/** Tabs of files on disk; a tab such as Settings has nothing to attach. */
const FILE_ON_DISK = ContextKeyExpr.or(ResourceContextKey.Scheme.isEqualTo(Schemas.file), ResourceContextKey.Scheme.isEqualTo(Schemas.vscodeRemote));

/**
 * The agent's entries in the menu bar and in the Explorer and tab context menus
 * (ide-15, ide-17, ide-19, ide-44): start an agent or a window from File, reach
 * the agent from View, and send files to the current agent or to a new one.
 */
export function registerClaudeMenuItems(): IDisposable {
	const store = new DisposableStore();
	store.add(MenuRegistry.appendMenuItems([
		{
			id: MenuId.MenubarFileMenu, item: {
				command: { id: CLAUDE_NEW_SESSION_COMMAND_ID, title: localize({ key: 'miClaudeNewAgent', comment: ['&& denotes a mnemonic'] }, "New A&&gent") },
				group: '1_new',
				order: 2.5,
				when: CLAUDE_AGENT_ENABLED,
			}
		},
		{
			id: MenuId.MenubarFileMenu, item: {
				command: { id: CLAUDE_OPEN_AGENTS_WINDOW_COMMAND_ID, title: localize('miClaudeAgentsWindow', "Open Agents Window"), precondition: CLAUDE_AGENT_ENABLED },
				group: '1_new',
				order: 3.5,
				when: CLAUDE_AGENT_ENABLED,
			}
		},
		{
			id: MenuId.MenubarViewMenu, item: {
				command: { id: CLAUDE_FOCUS_AGENT_COMMAND_ID, title: localize('miClaudeViewAgent', "Agent") },
				group: '3_views',
				order: 5,
				when: CLAUDE_AGENT_ENABLED,
			}
		},
		{
			id: MenuId.ExplorerContext, item: {
				command: { id: CLAUDE_ADD_FILE_COMMAND_ID, title: localize('claudeExplorerAddToAgent', "Add to Agent") },
				group: CLAUDE_EXPLORER_CONTEXT_GROUP,
				order: 1,
				when: CLAUDE_AGENT_ENABLED,
			}
		},
		{
			id: MenuId.ExplorerContext, item: {
				command: { id: CLAUDE_ADD_FILE_TO_NEW_AGENT_COMMAND_ID, title: localize('claudeExplorerAddToNewAgent', "Add to New Agent") },
				group: CLAUDE_EXPLORER_CONTEXT_GROUP,
				order: 2,
				when: CLAUDE_AGENT_ENABLED,
			}
		},
		{
			id: MenuId.EditorTitleContext, item: {
				command: { id: CLAUDE_ADD_FILE_COMMAND_ID, title: localize('claudeTabAddToAgent', "Add File to Agent") },
				group: CLAUDE_TAB_CONTEXT_GROUP,
				order: 1,
				when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, FILE_ON_DISK),
			}
		},
		{
			id: MenuId.EditorTitleContext, item: {
				command: { id: CLAUDE_ADD_FILE_TO_NEW_AGENT_COMMAND_ID, title: localize('claudeTabAddToNewAgent', "Add File to New Agent") },
				group: CLAUDE_TAB_CONTEXT_GROUP,
				order: 2,
				when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, FILE_ON_DISK),
			}
		},
	]));
	return store;
}
