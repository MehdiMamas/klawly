/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { hasKey } from '../../../../base/common/types.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ClaudeAutomationScope } from '../../../../platform/claude/common/claudeAutomation.js';
import { CLAUDE_NOTIFICATIONS_APPROVAL_SETTING } from '../../../../platform/claude/common/claudeConfiguration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { FocusMode } from '../../../../platform/native/common/native.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { ClaudeAutomationNeedsYou, CLAUDE_OPEN_AUTOMATIONS_COMMAND_ID, CLAUDE_RUN_AUTOMATION_COMMAND_ID, IClaudeAutomationService } from '../../../services/claude/common/claudeAutomationService.js';
import { ITaskService } from '../../tasks/common/taskService.js';
import { TaskEventKind } from '../../tasks/common/tasks.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { ITestResultService } from '../../testing/common/testResultService.js';
import { TestResultState } from '../../testing/common/testTypes.js';
import { CLAUDE_AGENT_ENABLED } from '../../claude/common/claudeContextKeys.js';
import { CLAUDE_FOCUS_AGENT_COMMAND_ID, KLAWLY_CATEGORY } from '../../claude/common/claudeViews.js';

/** Most failed tests a run's prompt lists. */
const MAX_FAILED_TESTS = 20;

/** A new `automations.json`: one disabled example that shows each field. */
const AUTOMATIONS_TEMPLATE = `{
	"automations": [
		{
			"id": "review-commits",
			"name": "Review yesterday's commits",
			"prompt": "Review the commits from the last day and list risky changes.",
			"trigger": { "type": "schedule", "cron": "0 9 * * 1-5" },
			"permissionMode": "plan",
			"budgetUsd": 1,
			"maxTurns": 20,
			"allowedTools": ["Bash(git log:*)", "Bash(git show:*)"],
			"enabled": false
		}
	]
}
`;

/**
 * Starts the automation service with the window, so schedules run and missed
 * runs are reported, forwards failed tasks (with their terminal output) and
 * test runs to it, and tells the person when a run needs them: a notification
 * in a focused window, an OS notification otherwise (spec 48,
 * `claude.notifications.approval`). A run's end is announced like any
 * background agent's, under `claude.notifications.finished`.
 */
class ClaudeAutomationsContribution extends Disposable {
	static readonly ID = 'workbench.contrib.claudeAutomations';

	constructor(
		@IClaudeAutomationService automations: IClaudeAutomationService,
		@ITaskService tasks: ITaskService,
		@ITestResultService testResults: ITestResultService,
		@ITerminalService private readonly _terminals: ITerminalService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IHostService private readonly _host: IHostService,
		@INotificationService private readonly _notifications: INotificationService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@ICommandService private readonly _commands: ICommandService,
	) {
		super();
		this._register(automations.onDidNeedYou(event => void this.needsYou(event)));
		this._register(tasks.onDidStateChange(event => {
			if (event.kind === TaskEventKind.ProcessEnded && event.exitCode !== undefined && event.exitCode !== 0) {
				const summary = localize('claudeAutomationTaskFailed', "Task {0} exited with code {1}.", event.taskName ?? event.taskId, event.exitCode);
				const output = this.terminalOutput(event.terminalId);
				automations.notifyFailure('onTaskFailed', {
					name: event.taskName,
					details: output ? `${summary}\n${localize('claudeAutomationTaskOutput', "Terminal output:")}\n${output}` : summary,
				});
			}
		}));
		this._register(testResults.onResultsChanged(event => {
			if (!hasKey(event, { completed: true })) {
				return;
			}
			const result = event.completed;
			const failed = result.counts[TestResultState.Failed] + result.counts[TestResultState.Errored];
			if (!failed) {
				return;
			}
			const lines: string[] = [];
			for (const test of result.tests) {
				if (lines.length >= MAX_FAILED_TESTS) {
					break;
				}
				if (test.ownComputedState !== TestResultState.Failed && test.ownComputedState !== TestResultState.Errored) {
					continue;
				}
				const messages = test.tasks.flatMap(task => task.messages).map(message => typeof message.message === 'string' ? message.message : message.message.value);
				lines.push(`- ${test.item.label}${messages.length ? `: ${messages.join(' ').slice(0, 500)}` : ''}`);
			}
			automations.notifyFailure('onTestFailed', {
				details: `${localize('claudeAutomationTestsFailed', "{0} tests failed.", failed)}\n${lines.join('\n')}`,
			});
		}));
	}

	/** The task's terminal text, trailing blank lines dropped. The run's prompt keeps its end. */
	private terminalOutput(terminalId: number | undefined): string | undefined {
		const text = terminalId === undefined ? undefined : this._terminals.getInstanceFromId(terminalId)?.xterm?.getContentsAsText();
		return text?.replace(/\s+$/, '') || undefined;
	}

	private async needsYou(event: ClaudeAutomationNeedsYou): Promise<void> {
		const open = async () => {
			this._agent.selectSession(event.sessionId);
			await this._commands.executeCommand(CLAUDE_FOCUS_AGENT_COMMAND_ID);
		};
		if (this._host.hasFocus) {
			this._notifications.prompt(Severity.Warning, localize('claudeAutomationNeedsYouNotice', "{0} needs you: {1}", event.automation.name, event.message), [{
				label: localize('claudeAutomationOpenRun', "Open Run"),
				run: () => void open(),
			}]);
			return;
		}
		if (this._configuration.getValue(CLAUDE_NOTIFICATIONS_APPROVAL_SETTING) === false) {
			return;
		}
		const result = await this._host.showToast({
			title: localize('claudeAutomationNeedsYouToast', "{0} needs you", event.automation.name),
			body: event.message,
			actions: [localize('claudeAutomationOpenRun', "Open Run")],
			dedupeKey: `claude.automation.${event.sessionId}`,
		}, CancellationToken.None);
		if (result.clicked || typeof result.actionIndex === 'number') {
			await this._host.focus(mainWindow, { mode: FocusMode.Force });
			await open();
		}
	}
}

interface AutomationPick extends IQuickPickItem {
	readonly key: string;
}

interface ScopePick extends IQuickPickItem {
	readonly scope: ClaudeAutomationScope;
}

let registered = false;

/** Run Automation, Open Automations File, and the contribution that runs them. */
export function registerClaudeAutomations(): void {
	if (registered) {
		return;
	}
	registered = true;
	registerWorkbenchContribution2(ClaudeAutomationsContribution.ID, ClaudeAutomationsContribution, WorkbenchPhase.Eventually);

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_RUN_AUTOMATION_COMMAND_ID,
				title: localize2('claudeRunAutomation', "Run Automation"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		async run(accessor: ServicesAccessor, key?: unknown): Promise<void> {
			const automations = accessor.get(IClaudeAutomationService);
			const quickInput = accessor.get(IQuickInputService);
			const notifications = accessor.get(INotificationService);
			if (typeof key !== 'string') {
				await automations.reload();
				const picks: AutomationPick[] = automations.getAutomations().map(view => ({
					key: view.automation.key,
					label: view.automation.name,
					description: view.automation.scope === 'workspace' ? localize('claudeAutomationWorkspace', "Workspace") : localize('claudeAutomationUser', "User"),
					detail: view.automation.prompt,
				}));
				if (!picks.length) {
					notifications.info(localize('claudeAutomationsNone', "No automations yet. Run Open Automations File to add one."));
					return;
				}
				key = (await quickInput.pick(picks, { placeHolder: localize('claudeAutomationPick', "Automation to run now") }))?.key;
				if (typeof key !== 'string') {
					return;
				}
			}
			try {
				await automations.run(key);
			} catch (error) {
				notifications.error(error instanceof Error ? error.message : String(error));
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_OPEN_AUTOMATIONS_COMMAND_ID,
				title: localize2('claudeOpenAutomations', "Open Automations File"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const automations = accessor.get(IClaudeAutomationService);
			const quickInput = accessor.get(IQuickInputService);
			const files = accessor.get(IFileService);
			const editors = accessor.get(IEditorService);
			const picks: ScopePick[] = [
				{ scope: 'workspace', label: localize('claudeAutomationsWorkspaceFile', "Workspace"), description: '.klawly/automations.json' },
				{ scope: 'user', label: localize('claudeAutomationsUserFile', "User"), description: '~/.klawly/automations.json' },
			];
			const scope = (await quickInput.pick(picks, { placeHolder: localize('claudeAutomationsWhich', "Which automations file?") }))?.scope;
			const file = scope ? await automations.fileFor(scope) : undefined;
			if (!file) {
				return;
			}
			if (!await files.exists(file)) {
				await files.writeFile(file, VSBuffer.fromString(AUTOMATIONS_TEMPLATE));
			}
			await editors.openEditor({ resource: file });
		}
	});
}
