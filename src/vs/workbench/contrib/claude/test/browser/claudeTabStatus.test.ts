/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeModelInfo, IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { CLAUDE_AGENT_ENABLED_SETTING, CLAUDE_AUTOCOMPLETE_ENABLED_SETTING, CLAUDE_AUTOCOMPLETE_MODEL_SETTING } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationChangeEvent } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { IClaudeAutocompleteService } from '../../../../services/claude/common/claudeAutocompleteService.js';
import { IStatusbarEntry, IStatusbarService, ToggleTooltipCommand } from '../../../../services/statusbar/browser/statusbar.js';
import { CLAUDE_TAB_PICK_MODEL_COMMAND_ID, CLAUDE_TAB_SNOOZE_MINUTES, CLAUDE_TAB_STATUS_ENTRY_ID, ClaudeTabStatusContribution } from '../../browser/claudeTabStatus.js';
import { CLAUDE_OPEN_SETTINGS_COMMAND_ID } from '../../common/claudeViews.js';

/** Writes land in the in-memory configuration, as the real service would. */
class WritableConfigurationService extends TestConfigurationService {
	override async updateValue(key: string, value: unknown): Promise<void> {
		await this.setUserConfiguration(key, value);
	}
}

/** Only the enablement half of the autocomplete service, which is all the item reads. */
class FakeAutocomplete {
	private readonly _onDidChangeEnablement = new Emitter<void>();
	readonly onDidChangeEnablement = this._onDidChangeEnablement.event;
	until: number | undefined;
	readonly snoozes: number[] = [];

	snoozedUntil(): number | undefined {
		return this.until;
	}

	snooze(minutes: number): void {
		this.snoozes.push(minutes);
		this.until = Date.now() + minutes * 60_000;
		this._onDidChangeEnablement.fire();
	}

	resume(): void {
		this.until = undefined;
		this._onDidChangeEnablement.fire();
	}

	dispose(): void {
		this._onDidChangeEnablement.dispose();
	}
}

/** Only the workbench state half of the workspace service, which is all the item reads. */
class FakeWorkspace {
	private readonly _onDidChangeWorkbenchState = new Emitter<WorkbenchState>();
	readonly onDidChangeWorkbenchState = this._onDidChangeWorkbenchState.event;

	constructor(private _state: WorkbenchState) { }

	getWorkbenchState(): WorkbenchState {
		return this._state;
	}

	open(state: WorkbenchState): void {
		this._state = state;
		this._onDidChangeWorkbenchState.fire(state);
	}

	dispose(): void {
		this._onDidChangeWorkbenchState.dispose();
	}
}

function changeOf(key: string): IConfigurationChangeEvent {
	return {
		source: ConfigurationTarget.USER,
		affectedKeys: new Set([key]),
		change: { keys: [key], overrides: [] },
		affectsConfiguration: candidate => candidate === key,
	};
}

/** What a reader sees in the popover: each row's text, and the role and state of its controls. */
function describePopover(root: HTMLElement): string[] {
	return [...root.children].map(row => {
		if (row.classList.contains('claude-tab-popover-separator')) {
			return '---';
		}
		const parts = [row.querySelector('.label')?.textContent ?? ''];
		const value = row.querySelector('.value');
		if (value) {
			parts.push(value.textContent ?? '');
		}
		for (const control of row.matches('button') ? [row] : [...row.querySelectorAll('button')]) {
			const button = control as HTMLButtonElement;
			const role = button.getAttribute('role');
			if (role === 'switch') {
				parts.push(`switch:${button.getAttribute('aria-checked')}`);
			} else if (button !== row) {
				parts.push(`${button.disabled ? 'disabled ' : ''}link:${button.textContent}`);
			}
		}
		return parts.join(' | ');
	});
}

suite('Claude Tab status item', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(settings: Record<string, unknown> = {}, state = WorkbenchState.FOLDER) {
		const added: { id: string; entry: IStatusbarEntry; priority: number | undefined; disposed: boolean }[] = [];
		const statusbar = {
			addEntry: (entry: IStatusbarEntry, id: string, _alignment: unknown, priority?: number) => {
				const record = { id, entry, priority, disposed: false };
				added.push(record);
				return { update: (next: IStatusbarEntry) => { record.entry = next; }, dispose: () => { record.disposed = true; } };
			},
		} as unknown as IStatusbarService;
		const configuration = new WritableConfigurationService({ [CLAUDE_AGENT_ENABLED_SETTING]: true, ...settings });
		store.add({ dispose: () => configuration.onDidChangeConfigurationEmitter.dispose() });
		const autocomplete = store.add(new FakeAutocomplete());
		const models: ClaudeModelInfo[] = [{ id: 'fixture-haiku', displayName: 'Haiku 4.5', source: 'runtime' }];
		const runtime = { listModels: async () => models } as unknown as IClaudeRuntimeService;
		const commands: unknown[][] = [];
		const commandService = { executeCommand: async (...args: unknown[]) => { commands.push(args); } } as unknown as ICommandService;
		const workspace = store.add(new FakeWorkspace(state));
		const contribution = store.add(new ClaudeTabStatusContribution(statusbar, autocomplete as unknown as IClaudeAutocompleteService, configuration, runtime, commandService, workspace as unknown as IWorkspaceContextService));
		return { added, configuration, autocomplete, commands, contribution, workspace };
	}

	test('the item follows the setting and a snooze, opens a popover and hides when the agent is off', () => {
		const { added, configuration, autocomplete } = setup();
		const shown = () => added.map(record => ({ id: record.id, text: record.entry.text, role: record.entry.role, command: record.entry.command, priority: record.priority, popover: typeof (record.entry.tooltip as { element?: unknown } | undefined)?.element === 'function', disposed: record.disposed }));
		const states: string[] = [String(added[0].entry.text)];

		configuration.setUserConfiguration(CLAUDE_AUTOCOMPLETE_ENABLED_SETTING, false);
		autocomplete.resume(); // the service announces the setting change the same way
		states.push(String(added[0].entry.text));
		autocomplete.snooze(CLAUDE_TAB_SNOOZE_MINUTES);
		states.push(String(added[0].entry.text), String(added[0].entry.ariaLabel?.startsWith('Tab suggestions snoozed until')));

		configuration.setUserConfiguration(CLAUDE_AGENT_ENABLED_SETTING, false);
		configuration.onDidChangeConfigurationEmitter.fire(changeOf(CLAUDE_AGENT_ENABLED_SETTING));

		assert.deepStrictEqual({ states, shown: shown() }, {
			states: ['$(arrow-right) Tab', '$(circle-slash) Tab', '$(clock) Tab', 'true'],
			shown: [{ id: CLAUDE_TAB_STATUS_ENTRY_ID, text: '$(clock) Tab', role: 'button', command: ToggleTooltipCommand, priority: 99, popover: true, disposed: true }],
		});
	});

	test('the item shows only once a folder or workspace is open', () => {
		const { added, autocomplete, workspace } = setup({}, WorkbenchState.EMPTY);
		const shown = () => added.map(record => ({ text: record.entry.text, disposed: record.disposed }));
		const steps = [shown()];

		autocomplete.snooze(CLAUDE_TAB_SNOOZE_MINUTES);
		steps.push(shown());
		autocomplete.resume();
		workspace.open(WorkbenchState.FOLDER);
		steps.push(shown());
		workspace.open(WorkbenchState.WORKSPACE);
		steps.push(shown());
		workspace.open(WorkbenchState.EMPTY);
		steps.push(shown());

		assert.deepStrictEqual(steps, [
			[],
			[],
			[{ text: '$(arrow-right) Tab', disposed: false }],
			[{ text: '$(arrow-right) Tab', disposed: false }],
			[{ text: '$(arrow-right) Tab', disposed: true }],
		]);
	});

	test('the popover switches Tab, snoozes and resumes in place, and opens the model and settings', async () => {
		const { configuration, autocomplete, commands, contribution } = setup({ [CLAUDE_AUTOCOMPLETE_MODEL_SETTING]: 'fixture-haiku' });
		const root = contribution.renderPopover();
		const steps: string[][] = [];
		await timeout(0); // the model name resolves after listModels answers
		steps.push(describePopover(root));

		root.querySelector<HTMLButtonElement>('[data-key="snooze"]')!.click();
		steps.push(describePopover(root).map(row => row.replace(/until .+ \|/, 'until <time> |')));
		root.querySelector<HTMLButtonElement>('[data-key="snooze"]')!.click();

		root.querySelector<HTMLButtonElement>('[data-key="switch"]')!.click();
		await timeout(0);
		steps.push(describePopover(root));

		root.querySelector<HTMLButtonElement>('[data-key="model"]')!.click();
		root.querySelector<HTMLButtonElement>('[data-key="settings"]')!.click();

		assert.deepStrictEqual({ steps, snoozes: autocomplete.snoozes, until: autocomplete.until, setting: configuration.getValue(CLAUDE_AUTOCOMPLETE_ENABLED_SETTING), commands }, {
			steps: [
				['Tab suggestions | switch:true', 'Model | Haiku 4.5', ' | link:Snooze for 30 Minutes', '---', 'Tab Settings'],
				['Tab suggestions | switch:true', 'Model | Haiku 4.5', 'Snoozed until <time> | link:Resume', '---', 'Tab Settings'],
				['Tab suggestions | switch:false', 'Model | Haiku 4.5', ' | disabled link:Snooze for 30 Minutes', '---', 'Tab Settings'],
			],
			snoozes: [CLAUDE_TAB_SNOOZE_MINUTES],
			until: undefined,
			setting: false,
			commands: [[CLAUDE_TAB_PICK_MODEL_COMMAND_ID], [CLAUDE_OPEN_SETTINGS_COMMAND_ID, 'tab']],
		});
	});
});
