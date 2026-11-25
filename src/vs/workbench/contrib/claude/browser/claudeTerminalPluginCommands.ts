/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Severity from '../../../../base/common/severity.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CLAUDE_ADD_TERMINAL_PLUGIN_COMMAND_ID, CLAUDE_REMOVE_TERMINAL_PLUGIN_COMMAND_ID, CLAUDE_TERMINAL_PLUGIN, CLAUDE_TERMINAL_PLUGIN_ID } from '../../../../platform/claude/common/claudeTerminalPlugin.js';
import { ClaudePluginCommand, ClaudePluginCommandResult, IClaudePluginService } from '../../../../platform/claude/common/claudePlugins.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { KLAWLY_CATEGORY } from '../common/claudeViews.js';

/** Runs plugin commands in order and returns the first that did not finish, or the last result. */
async function runPluginCommands(plugins: IClaudePluginService, commands: readonly ClaudePluginCommand[]): Promise<ClaudePluginCommandResult> {
	let result: ClaudePluginCommandResult = { outcome: 'done', message: '' };
	for (const command of commands) {
		result = await plugins.run(command);
		if (result.outcome !== 'done') {
			return result;
		}
	}
	return result;
}

/**
 * Add and Remove /klawly (issue 1186): the bundled plugin that lets a terminal
 * Claude Code session open itself in Klawly. Adding asks first and shows the
 * two `claude plugin` commands it runs; nothing is installed without a yes.
 */
export function registerClaudeTerminalPluginCommands(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_ADD_TERMINAL_PLUGIN_COMMAND_ID,
				title: { ...localize2('klawlyAddTerminalPlugin', "Add /klawly to Claude Code..."), original: 'Add /klawly to Claude Code... (Terminal, Handoff, Import)' },
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const plugins = accessor.get(IClaudePluginService);
			const dialogs = accessor.get(IDialogService);
			const notifications = accessor.get(INotificationService);
			const { confirmed } = await dialogs.confirm({
				type: Severity.Info,
				message: localize('claudeAddTerminalPluginTitle', "Add /klawly to Claude Code?"),
				detail: localize('claudeAddTerminalPluginDetail', "This adds a small plugin that ships with Klawly to Claude Code, for you in every folder. It adds one command, /klawly, which opens the terminal session you run it in as a Klawly chat with the same conversation. Klawly asks again before it opens the session.\n\nIt runs:\nclaude plugin marketplace add <Klawly's plugin folder>\nclaude plugin install {0} --scope user\n\nRemove it any time with Remove /klawly from Claude Code.", CLAUDE_TERMINAL_PLUGIN_ID),
				primaryButton: localize({ key: 'claudeAddTerminalPluginRun', comment: ['&& denotes a mnemonic'] }, "&&Add"),
			});
			if (!confirmed) {
				return;
			}
			try {
				const source = await plugins.prepareTerminalPlugin();
				const result = await runPluginCommands(plugins, [
					{ action: 'addMarketplace', source, scope: 'user' },
					{ action: 'install', plugin: CLAUDE_TERMINAL_PLUGIN_ID, scope: 'user' },
				]);
				if (result.outcome === 'done') {
					notifications.info(localize('claudeAddTerminalPluginDone', "Added. Type /klawly in a Claude Code terminal session to open it in Klawly."));
				} else {
					notifications.error(localize('claudeAddTerminalPluginFailed', "Claude Code could not add /klawly: {0}", result.message));
				}
			} catch (error) {
				notifications.error(localize('claudeAddTerminalPluginError', "Claude Code could not add /klawly: {0}", error instanceof Error ? error.message : String(error)));
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_REMOVE_TERMINAL_PLUGIN_COMMAND_ID,
				title: localize2('klawlyRemoveTerminalPlugin', "Remove /klawly from Claude Code"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const plugins = accessor.get(IClaudePluginService);
			const notifications = accessor.get(INotificationService);
			try {
				const result = await runPluginCommands(plugins, [
					{ action: 'uninstall', plugin: CLAUDE_TERMINAL_PLUGIN_ID, scope: 'user' },
					{ action: 'removeMarketplace', name: CLAUDE_TERMINAL_PLUGIN },
				]);
				if (result.outcome === 'done') {
					notifications.info(localize('claudeRemoveTerminalPluginDone', "Removed /klawly from Claude Code."));
				} else {
					notifications.error(localize('claudeRemoveTerminalPluginFailed', "Claude Code could not remove /klawly: {0}", result.message));
				}
			} catch (error) {
				notifications.error(localize('claudeRemoveTerminalPluginError', "Claude Code could not remove /klawly: {0}", error instanceof Error ? error.message : String(error)));
			}
		}
	});
}
