/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry } from '../../../common/views.js';
import { CLAUDE_MAX_PARALLEL_SESSIONS_DEFAULT, CLAUDE_MAX_PARALLEL_SESSIONS_SETTING } from '../../../../platform/claude/common/claudeBackground.js';
import { CLAUDE_COMPARE_MAX_BUDGET_DEFAULT, CLAUDE_COMPARE_MAX_BUDGET_SETTING } from '../../../../platform/claude/common/claudeComparison.js';
import { CLAUDE_BACKGROUND_PROMPT_COMMAND_ID, IClaudeBackgroundAgentService } from '../../../services/claude/common/claudeBackgroundAgent.js';
import { CLAUDE_VIEW_CONTAINER_ID, KLAWLY_CATEGORY } from '../../claude/common/claudeViews.js';
import { CLAUDE_AGENT_ENABLED } from '../../claude/common/claudeContextKeys.js';
import { CLAUDE_BACKGROUND_VIEW_ID, CLAUDE_SESSIONS_VIEW_ID, CLAUDE_WORKERS_VIEW_ID } from '../common/claudeBackground.js';
import { ClaudeWorkersViewPane } from './claudeWorkersViewPane.js';
import { ClaudeMachineSessionsViewPane } from './claudeMachineSessionsViewPane.js';
import { registerClaudeSessionCommands } from './claudeSessionActions.js';
import { ClaudeBackgroundViewPane } from './claudeBackgroundViewPane.js';
import { registerClaudeCompareModels } from './claudeCompareModels.js';
import { CLAUDE_AUTOMATIONS_ENABLED_SETTING, CLAUDE_AUTOMATIONS_RUN_AT_LOGIN_SETTING } from '../../../../platform/claude/common/claudeAutomation.js';
import { CLAUDE_AUTOMATION_GITHUB_POLL_DEFAULT_MINUTES, CLAUDE_AUTOMATION_GITHUB_POLL_SETTING } from '../../../../platform/claude/common/claudeAutomationGitHub.js';
import { registerClaudeAutomations } from './claudeAutomations.js';
import { registerClaudeWorkerControls } from './claudeWorkerActions.js';
import { registerClaudeMultitask } from './claudeMultitask.js';
import { registerClaudeWorktreeCommands } from './claudeWorktreeCommands.js';
import { registerClaudeWorktreeRetention } from './claudeWorktreeRetention.js';
import { CLAUDE_WORKTREES_CLEANUP_DAYS_DEFAULT, CLAUDE_WORKTREES_CLEANUP_DAYS_MAX, CLAUDE_WORKTREES_CLEANUP_DAYS_SETTING } from '../../../../platform/claude/common/claudeWorktreeRetention.js';
import { CLAUDE_WORKERS_FINISHED_MINUTES_SETTING, CLAUDE_WORKERS_HUNG_MINUTES_SETTING, CLAUDE_WORKERS_VIEW_DEFAULTS } from '../../../../platform/claude/common/claudeWorkersViewSettings.js';
import { CLAUDE_WORKTREES_MAX_DEFAULT, CLAUDE_WORKTREES_MAX_SETTING } from '../../../../platform/claude/common/claudeWorktreeSetup.js';

let registered = false;

/** Klawly: Clean Up Worktrees (issue 511). */
export const CLAUDE_CLEAN_UP_WORKTREES_COMMAND_ID = 'claude.cleanUpWorktrees';

/**
 * The Background Agents view. Hidden until opened (More > Background Agents),
 * so the Agent view is the only visible view in its container and its title
 * merges into one header (audit 4).
 */
export function claudeBackgroundViewDescriptor(): IViewDescriptor {
	return {
		id: CLAUDE_BACKGROUND_VIEW_ID,
		name: localize2('claudeBackground', "Background Agents"),
		ctorDescriptor: new SyncDescriptor(ClaudeBackgroundViewPane),
		canToggleVisibility: true,
		canMoveView: true,
		order: 2,
		weight: 30,
		hideByDefault: true,
		collapsed: false,
		containerIcon: Codicon.repoForked,
		when: CLAUDE_AGENT_ENABLED,
	};
}

/** The Workers view (issue 840). Hidden until opened, like Background Agents. */
export function claudeWorkersViewDescriptor(): IViewDescriptor {
	return {
		id: CLAUDE_WORKERS_VIEW_ID,
		name: localize2('claudeWorkers', "Workers"),
		ctorDescriptor: new SyncDescriptor(ClaudeWorkersViewPane),
		canToggleVisibility: true,
		canMoveView: true,
		order: 3,
		weight: 30,
		hideByDefault: true,
		collapsed: false,
		containerIcon: Codicon.organization,
		when: CLAUDE_AGENT_ENABLED,
	};
}

/** The Sessions view (issue 1251): every Claude Code session on this PC. Hidden until opened. */
export function claudeSessionsViewDescriptor(): IViewDescriptor {
	return {
		id: CLAUDE_SESSIONS_VIEW_ID,
		name: localize2('claudeSessions', "Sessions"),
		ctorDescriptor: new SyncDescriptor(ClaudeMachineSessionsViewPane),
		canToggleVisibility: true,
		canMoveView: true,
		order: 4,
		weight: 30,
		hideByDefault: true,
		collapsed: false,
		containerIcon: Codicon.server,
		when: CLAUDE_AGENT_ENABLED,
	};
}

/** Registers the background-agent view and the parallel-session cap. */
export function registerClaudeBackground(): void {
	if (registered) {
		return;
	}
	const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).get(CLAUDE_VIEW_CONTAINER_ID);
	if (!container) {
		return;
	}
	registered = true;
	Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([claudeBackgroundViewDescriptor(), claudeWorkersViewDescriptor(), claudeSessionsViewDescriptor()], container);

	Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
		id: 'claude',
		order: 101,
		title: localize('claudeConfigurationTitle', "AI / Claude"),
		type: 'object',
		properties: {
			[CLAUDE_MAX_PARALLEL_SESSIONS_SETTING]: {
				type: 'number',
				scope: ConfigurationScope.APPLICATION,
				default: CLAUDE_MAX_PARALLEL_SESSIONS_DEFAULT,
				minimum: 1,
				description: localize('claudeMaxParallel', "How many background agents may run at once. Each one uses its own Git worktree."),
			},
			[CLAUDE_COMPARE_MAX_BUDGET_SETTING]: {
				type: 'number',
				scope: ConfigurationScope.APPLICATION,
				default: CLAUDE_COMPARE_MAX_BUDGET_DEFAULT,
				exclusiveMinimum: 0,
				description: localize('claudeCompareMaxBudget', "Most each Compare Models run may spend, in US dollars. Claude Code stops a run that reaches it, and the run shows as failed."),
			},
			[CLAUDE_WORKTREES_MAX_SETTING]: {
				type: 'number',
				scope: ConfigurationScope.APPLICATION,
				default: CLAUDE_WORKTREES_MAX_DEFAULT,
				minimum: 1,
				markdownDescription: localize('claudeWorktreesMax', "Most background agent worktrees one repository may have, finished ones included. Klawly: Clean Up Worktrees removes the finished ones with nothing left to apply. A trusted project's `.klawly/worktree-setup.json` lists files to copy into each new worktree (`copy`, such as `.env*`) and commands to run there first (`setup`, a list or one per OS)."),
			},
			[CLAUDE_WORKTREES_CLEANUP_DAYS_SETTING]: {
				type: 'number',
				scope: ConfigurationScope.APPLICATION,
				default: CLAUDE_WORKTREES_CLEANUP_DAYS_DEFAULT,
				minimum: 0,
				maximum: CLAUDE_WORKTREES_CLEANUP_DAYS_MAX,
				markdownDescription: localize('claudeWorktreesCleanupDays', "Days after which Klawly removes a background agent worktree it has not worked in. Only a worktree with nothing left to apply is removed: one with edits, untracked files or commits beyond its base stays until you delete it. 0 turns this off. Klawly: Show Worktree Disk Use lists what the worktrees take."),
			},
			[CLAUDE_WORKERS_FINISHED_MINUTES_SETTING]: {
				type: 'number',
				scope: ConfigurationScope.WINDOW,
				default: CLAUDE_WORKERS_VIEW_DEFAULTS.finishedMinutes,
				minimum: 0,
				description: localize('claudeWorkersFinishedMinutes', "Minutes after which a finished worker that is still open is flagged in the Workers view. 0 turns it off."),
			},
			[CLAUDE_WORKERS_HUNG_MINUTES_SETTING]: {
				type: 'number',
				scope: ConfigurationScope.WINDOW,
				default: CLAUDE_WORKERS_VIEW_DEFAULTS.hungMinutes,
				minimum: 0,
				description: localize('claudeWorkersHungMinutes', "Minutes without any news after which a working worker is flagged as hung in the Workers view. 0 turns it off."),
			},
			[CLAUDE_AUTOMATIONS_ENABLED_SETTING]: {
				type: 'boolean',
				scope: ConfigurationScope.APPLICATION,
				default: false,
				markdownDescription: localize('claudeAutomationsEnabled', "Start automations from `.klawly/automations.json` (workspace, trusted folders only) and `~/.klawly/automations.json` on their schedule, on a save or on a failed task or test run, while Klawly is open. Each run is a background agent in its own worktree with its own budget; a request outside its allowed tools is denied and the run waits for you. Run Automation works while this is off."),
			},
			[CLAUDE_AUTOMATIONS_RUN_AT_LOGIN_SETTING]: {
				type: 'boolean',
				scope: ConfigurationScope.APPLICATION,
				default: false,
				markdownDescription: localize('claudeAutomationsRunAtLogin', "Start Klawly minimized when you sign in to your computer, so automations keep running while no window is open. This adds a login item for your user (a LaunchAgent on macOS, a startup entry on Windows, an autostart file on Linux); turning it off removes it. Requires `#claude.automations.enabled#`."),
			},
			[CLAUDE_AUTOMATION_GITHUB_POLL_SETTING]: {
				type: 'number',
				scope: ConfigurationScope.APPLICATION,
				default: CLAUDE_AUTOMATION_GITHUB_POLL_DEFAULT_MINUTES,
				minimum: 1,
				markdownDescription: localize('claudeAutomationsGitHubPoll', "How often automations with a GitHub trigger (pull request, push, failed workflow run) ask GitHub for news, in minutes, through your GitHub CLI (`gh`) and its sign-in. An unchanged answer does not count against GitHub's rate limit."),
			},
		},
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_BACKGROUND_PROMPT_COMMAND_ID,
				title: localize2('claudeStartBackground', "Start Background Agent"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		async run(accessor: ServicesAccessor, given?: unknown): Promise<void> {
			const quickInput = accessor.get(IQuickInputService);
			const background = accessor.get(IClaudeBackgroundAgentService);
			const notifications = accessor.get(INotificationService);
			// A caller with a prompt, such as Build in Background Worktree on a plan, reports errors itself.
			if (typeof given === 'string' && given.trim()) {
				await background.start(given.trim());
				return;
			}
			const prompt = await quickInput.input({
				prompt: localize('claudeBackgroundPrompt', "What should the background agent do?"),
			});
			if (!prompt?.trim()) {
				return;
			}
			try {
				await background.start(prompt.trim());
			} catch (error) {
				notifications.error(error instanceof Error ? error.message : String(error));
			}
		}
	});
	// Issue 511: removes the worktrees of finished agents with nothing left to apply.
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_CLEAN_UP_WORKTREES_COMMAND_ID,
				title: localize2('claudeCleanUpWorktrees', "Clean Up Worktrees"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const background = accessor.get(IClaudeBackgroundAgentService);
			const notifications = accessor.get(INotificationService);
			try {
				const { removed, kept } = await background.cleanUp();
				notifications.info(kept > 0
					? localize('claudeCleanUpKept', "Removed {0} finished worktrees. {1} still have changes to review or apply in Background Agents.", removed, kept)
					: localize('claudeCleanUpDone', "Removed {0} finished worktrees.", removed));
			} catch (error) {
				notifications.error(error instanceof Error ? error.message : String(error));
			}
		}
	});
	registerClaudeCompareModels();
	registerClaudeAutomations();
	registerClaudeMultitask();
	registerClaudeWorkerControls();
	registerClaudeSessionCommands();
	registerClaudeWorktreeCommands();
	registerClaudeWorktreeRetention();
}
