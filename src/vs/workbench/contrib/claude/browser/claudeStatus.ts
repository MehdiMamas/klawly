/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { ClaudeUsageWindow } from '../../../../platform/claude/common/claudeAccount.js';
import { CLAUDE_AGENT_ENABLED_SETTING, readClaudeAgentEnabled } from '../../../../platform/claude/common/claudeConfiguration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { CLAUDE_AGENT_OUTPUT_CHANNEL_ID } from '../../../services/claude/common/claudeAgentLog.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IOutputService } from '../../../services/output/common/output.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { claudeAgentActivity, ClaudeStatusKind, claudeStatusKind, claudeStatusMenu, ClaudeStatusMenuAction, claudeStatusPresentation } from '../common/claudeRuntimeStatus.js';
import { claudeUsageRowParts, watchClaudePlanUsage } from '../common/claudeUsageRow.js';
import { CLAUDE_FOCUS_AGENT_COMMAND_ID, CLAUDE_LOG_OUT_COMMAND_ID, CLAUDE_OPEN_SETTINGS_COMMAND_ID, CLAUDE_SHOW_STATUS_COMMAND_ID, CLAUDE_SWITCH_ACCOUNT_COMMAND_ID, KLAWLY_CATEGORY } from '../common/claudeViews.js';
import { IClaudeSetupService } from './claudeSetup.js';

export const CLAUDE_STATUS_ENTRY_ID = 'claude.status';

/**
 * The status bar entry for a state. When signed in and Claude Code reported
 * plan windows, the item also shows the first one (the session window when
 * there is one), and the status menu it opens lists them. Exported for tests.
 */
export function claudeStatusEntry(kind: ClaudeStatusKind, windows?: readonly ClaudeUsageWindow[], now = Date.now()): IStatusbarEntry {
	const presentation = claudeStatusPresentation(kind);
	const parts = kind === 'sign-in' || kind === 'runtime-missing' ? [] : claudeUsageRowParts(windows, now);
	const usage = parts.find(part => part.kind === 'session') ?? parts[0];
	const label = usage ? localize('claudeStatusUsageText', "{0} · {1}%", presentation.label, usage.percent) : presentation.label;
	const usageNote = usage ? localize('claudeStatusUsageTooltip', "{0} usage: {1}%.", usage.name, usage.percent) : undefined;
	return {
		name: localize('claudeStatusName', "Claude Status"),
		text: `$(${presentation.icon}) ${label}`,
		ariaLabel: usageNote ? localize('claudeStatusUsageAria', "{0} {1}", presentation.ariaLabel, usageNote) : presentation.ariaLabel,
		tooltip: usageNote ? localize('claudeStatusUsageTooltipLines', "{0}\n{1}", presentation.tooltip, usageNote) : presentation.tooltip,
		role: 'button',
		kind: presentation.kind,
		command: usage ? { id: CLAUDE_SHOW_STATUS_COMMAND_ID, title: localize('claudeShowStatusTitle', "Show Claude Status"), arguments: [windows] } : CLAUDE_SHOW_STATUS_COMMAND_ID,
	};
}

/**
 * One item on the right of the status bar (spec 47): Ready, Working, Needs
 * approval, Sign in, Limit reached or Runtime missing. Hidden while
 * `claude.agent.enabled` is off and until the runtime has answered a probe.
 */
export class ClaudeStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeStatusBar';

	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	/** Streaming changes the view state many times a second; the item only needs a few updates. */
	private readonly _streaming = this._register(new RunOnceScheduler(() => this.update(), 150));
	private _kind: ClaudeStatusKind | undefined;
	private _usage: readonly ClaudeUsageWindow[] | undefined;
	private _usageChanged = false;

	constructor(
		@IStatusbarService private readonly _statusbar: IStatusbarService,
		@IClaudeSetupService private readonly _setup: IClaudeSetupService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IClaudeRuntimeService runtime: IClaudeRuntimeService,
		@IHostService hostService: IHostService,
	) {
		super();
		this._register(watchClaudePlanUsage(runtime, windows => {
			this._usage = windows;
			this._usageChanged = true;
			this.update();
		}, hostService));
		this._register(this._setup.onDidChange(() => this.update()));
		this._register(this._agent.onDidChangeViewState(() => {
			if (!this._streaming.isScheduled()) {
				this._streaming.schedule();
			}
		}));
		this._register(this._agent.onDidChangeSession(() => this.update()));
		this._register(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_AGENT_ENABLED_SETTING)) {
				this.update();
			}
		}));
		this.update();
	}

	private update(): void {
		const enabled = readClaudeAgentEnabled(this._configuration.getValue(CLAUDE_AGENT_ENABLED_SETTING));
		const current = this._agent.getCurrentSession();
		const activity = claudeAgentActivity(
			this._agent.getSessions().map(session => this._agent.getViewState(session.id)),
			current ? this._agent.getViewState(current.id) : undefined,
		);
		const kind = enabled ? claudeStatusKind(this._setup.runtime, activity) : undefined;
		if (kind === this._kind && !this._usageChanged && (kind === undefined) === !this._entry.value) {
			return;
		}
		this._kind = kind;
		this._usageChanged = false;
		if (!kind) {
			this._entry.clear();
			return;
		}
		const entry = claudeStatusEntry(kind, this._usage);
		if (this._entry.value) {
			this._entry.value.update(entry);
		} else {
			this._entry.value = this._statusbar.addEntry(entry, CLAUDE_STATUS_ENTRY_ID, StatusbarAlignment.RIGHT, 100);
		}
	}
}

interface StatusPick extends IQuickPickItem {
	readonly action?: ClaudeStatusMenuAction;
}

/** Registers Show Claude Status, which the status bar item runs. */
export function registerClaudeStatusCommands(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_SHOW_STATUS_COMMAND_ID,
				title: localize2('claudeShowStatus', "Show Claude Status"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		/** The status bar item passes the plan windows it shows; F1 has none. */
		async run(accessor: ServicesAccessor, windows?: readonly ClaudeUsageWindow[]): Promise<void> {
			const setup = accessor.get(IClaudeSetupService);
			const agent = accessor.get(IClaudeAgentService);
			const quickInput = accessor.get(IQuickInputService);
			const commands = accessor.get(ICommandService);
			const output = accessor.get(IOutputService);
			const session = agent.getCurrentSession();
			const activity = claudeAgentActivity(agent.getSessions().map(candidate => agent.getViewState(candidate.id)), session ? agent.getViewState(session.id) : undefined);
			const kind = claudeStatusKind(setup.runtime, activity);
			const menu = claudeStatusMenu(setup.runtime, kind, session?.modelName ?? session?.modelId, claudeUsageRowParts(windows, Date.now()));
			const items: (StatusPick | IQuickPickSeparator)[] = [
				{ type: 'separator', label: kind ? claudeStatusPresentation(kind).label : localize('claudeStatusChecking', "Claude") },
				...menu.info.map(row => ({ label: row.label, description: row.detail })),
				{ type: 'separator' },
				...menu.actions.map(action => ({ label: `$(${action.icon}) ${action.label}`, action: action.id, ariaLabel: action.label })),
			];
			const picked = await quickInput.pick<StatusPick>(items, {
				placeHolder: localize('claudeStatusPlaceholder', "Claude status and actions"),
			});
			switch (picked?.action) {
				case 'open-agent':
					await commands.executeCommand(CLAUDE_FOCUS_AGENT_COMMAND_ID);
					break;
				case 'settings':
					await commands.executeCommand(CLAUDE_OPEN_SETTINGS_COMMAND_ID);
					break;
				case 'redetect':
					await setup.redetect();
					break;
				case 'install':
					await setup.install();
					break;
				case 'sign-in':
					await commands.executeCommand(CLAUDE_FOCUS_AGENT_COMMAND_ID);
					await setup.signIn();
					break;
				case 'logs':
					await output.showChannel(CLAUDE_AGENT_OUTPUT_CHANNEL_ID);
					break;
				case 'switch-account':
					await commands.executeCommand(CLAUDE_SWITCH_ACCOUNT_COMMAND_ID);
					break;
				case 'log-out':
					await commands.executeCommand(CLAUDE_LOG_OUT_COMMAND_ID);
					break;
			}
		}
	});
}
