/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { CLAUDE_AGENT_ENABLED_SETTING, CLAUDE_AUTOCOMPLETE_ENABLED_SETTING, CLAUDE_AUTOCOMPLETE_MODEL_SETTING, CLAUDE_MODELS_CUSTOM_SETTING, CLAUDE_MODELS_ENABLED_SETTING, readClaudeAgentEnabled, readClaudeAutocompleteEnabled, readClaudeModelId } from '../../../../platform/claude/common/claudeConfiguration.js';
import { pickableClaudeModels, readClaudeModelIdList } from '../../../../platform/claude/common/claudeModels.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IClaudeAutocompleteService } from '../../../services/claude/common/claudeAutocompleteService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment, ToggleTooltipCommand } from '../../../services/statusbar/browser/statusbar.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { claudeModelName } from '../common/claudeModelControls.js';
import { CLAUDE_OPEN_SETTINGS_COMMAND_ID, KLAWLY_CATEGORY } from '../common/claudeViews.js';

export const CLAUDE_TAB_STATUS_ENTRY_ID = 'claude.tab.status';
export const CLAUDE_TAB_SNOOZE_COMMAND_ID = 'klawly.tab.snooze';
export const CLAUDE_TAB_RESUME_COMMAND_ID = 'klawly.tab.resume';
export const CLAUDE_TAB_PICK_MODEL_COMMAND_ID = 'klawly.tab.pickModel';

/** How long Snooze pauses Tab. */
export const CLAUDE_TAB_SNOOZE_MINUTES = 30;

export type ClaudeTabStatusState = 'on' | 'off' | 'snoozed';

/** The state the item shows. A snooze wins over the setting so Resume stays reachable. */
export function claudeTabStatusState(settingOn: boolean, snoozedUntil: number | undefined): ClaudeTabStatusState {
	if (snoozedUntil !== undefined) {
		return 'snoozed';
	}
	return settingOn ? 'on' : 'off';
}

function formatTime(time: number): string {
	return new Date(time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** The status bar entry for a state, without its popover. Exported for tests. */
export function claudeTabStatusEntry(state: ClaudeTabStatusState, snoozedUntil?: number): IStatusbarEntry {
	const opens = localize('claudeTabStatusOpens', "Opens the Tab options.");
	switch (state) {
		case 'on':
			return { name: localize('claudeTabStatusName', "Tab Suggestions"), text: '$(arrow-right) Tab', ariaLabel: localize('claudeTabStatusOn', "Tab suggestions on. {0}", opens), role: 'button', command: ToggleTooltipCommand };
		case 'off':
			return { name: localize('claudeTabStatusName', "Tab Suggestions"), text: '$(circle-slash) Tab', ariaLabel: localize('claudeTabStatusOff', "Tab suggestions off. {0}", opens), role: 'button', command: ToggleTooltipCommand };
		case 'snoozed': {
			const until = snoozedUntil === undefined ? '' : formatTime(snoozedUntil);
			return { name: localize('claudeTabStatusName', "Tab Suggestions"), text: '$(clock) Tab', ariaLabel: localize('claudeTabStatusSnoozed', "Tab suggestions snoozed until {0}. {1}", until, opens), role: 'button', command: ToggleTooltipCommand };
		}
	}
}

/**
 * The Tab item on the right of the status bar (ide-46). Clicking it pins a
 * small popover: the on/off switch, the Tab model, Snooze or Resume, and a
 * link to the Tab settings page. Hidden while `claude.agent.enabled` is off
 * and in an empty window, where there is no folder to suggest edits in.
 */
export class ClaudeTabStatusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeTabStatus';

	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	/** The last model name the runtime gave, so a redraw doesn't flash the raw id. */
	private _modelName: { readonly id: string; readonly name: string } | undefined;

	constructor(
		@IStatusbarService private readonly _statusbar: IStatusbarService,
		@IClaudeAutocompleteService private readonly _autocomplete: IClaudeAutocompleteService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@ICommandService private readonly _commands: ICommandService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
	) {
		super();
		this._register(this._autocomplete.onDidChangeEnablement(() => this.update()));
		this._register(this._workspace.onDidChangeWorkbenchState(() => this.update()));
		this._register(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_AGENT_ENABLED_SETTING)) {
				this.update();
			}
		}));
		this.update();
	}

	private update(): void {
		if (!readClaudeAgentEnabled(this._configuration.getValue(CLAUDE_AGENT_ENABLED_SETTING)) || this._workspace.getWorkbenchState() === WorkbenchState.EMPTY) {
			this._entry.clear();
			return;
		}
		const until = this._autocomplete.snoozedUntil();
		const entry: IStatusbarEntry = {
			...claudeTabStatusEntry(claudeTabStatusState(this.settingOn(), until), until),
			tooltip: { element: () => this.renderPopover(), contentOwnsPadding: true },
		};
		if (this._entry.value) {
			this._entry.value.update(entry);
		} else {
			this._entry.value = this._statusbar.addEntry(entry, CLAUDE_TAB_STATUS_ENTRY_ID, StatusbarAlignment.RIGHT, 99);
		}
	}

	private settingOn(): boolean {
		return readClaudeAutocompleteEnabled(this._configuration.getValue(CLAUDE_AUTOCOMPLETE_ENABLED_SETTING));
	}

	/** Builds the popover. Each control redraws it in place and keeps focus on itself. */
	renderPopover(): HTMLElement {
		const root = $('.claude-root.claude-tab-popover');
		const render = (focusKey?: string) => {
			clearNode(root);
			const controls = new Map<string, HTMLElement>();
			const on = this.settingOn();
			const until = this._autocomplete.snoozedUntil();

			const switchRow = append(root, $('.claude-tab-popover-row'));
			const switchLabel = append(switchRow, $('span.label'));
			switchLabel.textContent = localize('claudeTabPopoverSuggestions', "Tab suggestions");
			switchLabel.id = 'claude-tab-popover-switch-label';
			const toggle = append(switchRow, $<HTMLButtonElement>('button.claude-switch'));
			toggle.type = 'button';
			toggle.dataset.key = 'switch';
			controls.set('switch', toggle);
			toggle.setAttribute('role', 'switch');
			toggle.setAttribute('aria-checked', String(on));
			toggle.setAttribute('aria-labelledby', switchLabel.id);
			toggle.classList.toggle('is-on', on);
			toggle.addEventListener(EventType.CLICK, async () => {
				await this._configuration.updateValue(CLAUDE_AUTOCOMPLETE_ENABLED_SETTING, !on);
				render('switch');
			});

			const modelRow = append(root, $<HTMLButtonElement>('button.claude-tab-popover-row.is-action'));
			modelRow.type = 'button';
			modelRow.dataset.key = 'model';
			controls.set('model', modelRow);
			append(modelRow, $('span.label')).textContent = localize('claudeTabPopoverModel', "Model");
			const value = append(modelRow, $('span.value'));
			const current = readClaudeModelId(this._configuration.getValue(CLAUDE_AUTOCOMPLETE_MODEL_SETTING));
			value.textContent = current === undefined ? localize('claudeTabPopoverDefaultModel', "Claude Code Default") : this._modelName?.id === current ? this._modelName.name : current;
			append(modelRow, $(ThemeIcon.asCSSSelector(Codicon.chevronRight)));
			modelRow.addEventListener(EventType.CLICK, () => void this._commands.executeCommand(CLAUDE_TAB_PICK_MODEL_COMMAND_ID));
			if (current) {
				void this._runtime.listModels().then(models => {
					const model = models.find(candidate => candidate.id === current);
					if (model) {
						this._modelName = { id: current, name: claudeModelName(model) };
						value.textContent = this._modelName.name;
					}
				}, () => undefined);
			}

			const snoozeRow = append(root, $('.claude-tab-popover-row'));
			if (until !== undefined) {
				append(snoozeRow, $('span.label.is-muted')).textContent = localize('claudeTabPopoverSnoozedUntil', "Snoozed until {0}", formatTime(until));
				const resume = append(snoozeRow, $<HTMLButtonElement>('button.claude-tab-popover-link'));
				resume.type = 'button';
				resume.dataset.key = 'snooze';
				controls.set('snooze', resume);
				resume.textContent = localize('claudeTabPopoverResume', "Resume");
				resume.addEventListener(EventType.CLICK, () => {
					this._autocomplete.resume();
					render('snooze');
				});
			} else {
				const snooze = append(snoozeRow, $<HTMLButtonElement>('button.claude-tab-popover-link'));
				snooze.type = 'button';
				snooze.dataset.key = 'snooze';
				controls.set('snooze', snooze);
				snooze.disabled = !on;
				snooze.textContent = localize('claudeTabPopoverSnooze', "Snooze for {0} Minutes", CLAUDE_TAB_SNOOZE_MINUTES);
				snooze.addEventListener(EventType.CLICK, () => {
					this._autocomplete.snooze(CLAUDE_TAB_SNOOZE_MINUTES);
					render('snooze');
				});
			}

			append(root, $('.claude-tab-popover-separator'));
			const settings = append(root, $<HTMLButtonElement>('button.claude-tab-popover-row.is-action'));
			settings.type = 'button';
			settings.dataset.key = 'settings';
			controls.set('settings', settings);
			append(settings, $(ThemeIcon.asCSSSelector(Codicon.settingsGear)));
			append(settings, $('span.label')).textContent = localize('claudeTabPopoverSettings', "Tab Settings");
			settings.addEventListener(EventType.CLICK, () => void this._commands.executeCommand(CLAUDE_OPEN_SETTINGS_COMMAND_ID, 'tab'));

			if (focusKey) {
				controls.get(focusKey)?.focus();
			}
		};
		render();
		return root;
	}
}

interface ModelPick extends IQuickPickItem {
	readonly value: string;
}

/** Registers Snooze, Resume and Choose Tab Model, which the popover and the command palette run. */
export function registerClaudeTabStatusCommands(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_TAB_SNOOZE_COMMAND_ID,
				title: localize2('claudeTabSnooze', "Snooze Tab Suggestions"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		run(accessor: ServicesAccessor): void {
			accessor.get(IClaudeAutocompleteService).snooze(CLAUDE_TAB_SNOOZE_MINUTES);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_TAB_RESUME_COMMAND_ID,
				title: localize2('claudeTabResume', "Resume Tab Suggestions"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		run(accessor: ServicesAccessor): void {
			accessor.get(IClaudeAutocompleteService).resume();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_TAB_PICK_MODEL_COMMAND_ID,
				title: localize2('claudeTabPickModel', "Choose Tab Model"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const configuration = accessor.get(IConfigurationService);
			const runtime = accessor.get(IClaudeRuntimeService);
			const quickInput = accessor.get(IQuickInputService);
			const current = readClaudeModelId(configuration.getValue(CLAUDE_AUTOCOMPLETE_MODEL_SETTING)) ?? '';
			const reported = await runtime.listModels().catch(() => []);
			const models = pickableClaudeModels(reported, readClaudeModelIdList(configuration.getValue(CLAUDE_MODELS_ENABLED_SETTING)), readClaudeModelIdList(configuration.getValue(CLAUDE_MODELS_CUSTOM_SETTING)));
			const items: ModelPick[] = [
				{ value: '', label: localize('claudeTabPickDefault', "Claude Code Default") },
				...models.map(model => ({ value: model.id, label: claudeModelName(model), description: model.id !== claudeModelName(model) ? model.id : undefined })),
			];
			if (current && !items.some(item => item.value === current)) {
				items.push({ value: current, label: current });
			}
			const picked = await quickInput.pick(items, {
				placeHolder: localize('claudeTabPickPlaceholder', "The model that writes Tab suggestions"),
				activeItem: items.find(item => item.value === current),
			});
			if (picked) {
				await configuration.updateValue(CLAUDE_AUTOCOMPLETE_MODEL_SETTING, picked.value || undefined);
			}
		}
	});
}
