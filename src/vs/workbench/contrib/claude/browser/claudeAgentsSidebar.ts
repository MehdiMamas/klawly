/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { CLAUDE_SESSION_LIST_LOCATION_SETTING, CLAUDE_TOGGLE_AGENTS_SIDEBAR_COMMAND_ID, readClaudeSessionListLocation } from '../common/claudeAgentsList.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { KLAWLY_CATEGORY } from '../common/claudeViews.js';

/**
 * Flips where the Agent pane lists its sessions: tabs on top only, or the
 * agents sidebar on the right too (issue 98). The choice is a user setting, so
 * every window and later session keeps it.
 */
export async function toggleClaudeAgentsSidebar(configuration: IConfigurationService): Promise<void> {
	const side = readClaudeSessionListLocation(configuration.getValue(CLAUDE_SESSION_LIST_LOCATION_SETTING)) === 'side';
	await configuration.updateValue(CLAUDE_SESSION_LIST_LOCATION_SETTING, side ? 'top' : 'side', ConfigurationTarget.USER);
}

/** Turns the agents sidebar on (a no-op when it already is), for actions that open the agents list. */
export async function showClaudeAgentsSidebar(configuration: IConfigurationService): Promise<void> {
	if (readClaudeSessionListLocation(configuration.getValue(CLAUDE_SESSION_LIST_LOCATION_SETTING)) !== 'side') {
		await configuration.updateValue(CLAUDE_SESSION_LIST_LOCATION_SETTING, 'side', ConfigurationTarget.USER);
	}
}

/** Registers Toggle Agents Sidebar for the Command Palette. */
export function registerClaudeAgentsSidebarCommands(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_TOGGLE_AGENTS_SIDEBAR_COMMAND_ID,
				title: localize2('claudeToggleAgentsSidebar', "Toggle Agents Sidebar"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				toggled: ContextKeyExpr.equals(`config.${CLAUDE_SESSION_LIST_LOCATION_SETTING}`, 'side'),
			});
		}
		run(accessor: ServicesAccessor): Promise<void> {
			return toggleClaudeAgentsSidebar(accessor.get(IConfigurationService));
		}
	});
}
