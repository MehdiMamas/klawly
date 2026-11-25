/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ClaudeModelInfo } from '../../../../../platform/claude/common/claude.js';
import { ClaudeFastModeStatus } from '../../../../../platform/claude/common/claudeFastMode.js';
import { claudeEffortLevelsFor, ClaudeSessionSettings, claudeSupportsUltracode } from '../../../../../platform/claude/common/claudeSessionSettings.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { claudeAutoModelEntryText } from '../../common/claudeAutoSwitch.js';
import { claudeContextChoice, claudeEffortLabel, claudeEffortValue, claudeFastModeDetail, claudeModelHover, claudeModelName, claudeModelSectionLabel, groupClaudeModels } from '../../common/claudeModelControls.js';
import { ClaudePopoverEntry, ClaudePopoverMenu } from '../widgets/claudePopoverMenu.js';

/** What the model menu shows and changes for one session. */
export interface ClaudeModelControls {
	/** The models the user may pick: the ones Claude Code reported and enabled, plus custom ids. */
	readonly models: readonly ClaudeModelInfo[];
	/** The model the next turn uses, checked in the list. */
	readonly currentId: string | undefined;
	/** What that model supports. Undefined when Claude Code did not report it: only the model list shows. */
	readonly model: ClaudeModelInfo | undefined;
	readonly settings: ClaudeSessionSettings;
	readonly pickModel: (id: string) => void;
	/** Picks Auto: Claude chooses the model for each turn (issue 1579). */
	/** Absent where Auto does not apply (an inline edit). */
	readonly pickAuto?: () => void;
	readonly setSettings: (settings: ClaudeSessionSettings) => void;
	readonly manage: () => void;
	/** Opens Compare Models (issue 424). Absent: the entry is not shown. */
	readonly compare?: () => void;
	/** Auto model's strategy while it picks the model (issue 521). Undefined while the user picks it. */
	readonly autoOn?: boolean;
	/** Fast mode's real state from Claude Code, once known (issue 456). */
	readonly fastMode?: ClaudeFastModeStatus;
}

/**
 * The model menu anchored above the model pill (Phase 33). Each row is a
 * Claude Code setting of the model the next turn uses, shown only when that
 * model has it: fast mode, the 1M-token context, effort with Ultracode, and
 * adaptive thinking. The last row opens the model list: one line per model,
 * Claude Code's lineup first, then the older models it still runs.
 *
 * Switches flip in place and keep the menu open; a pick in a submenu closes it.
 * Arrow keys move, Right opens a submenu, Escape steps back and then closes.
 */
export class ClaudeModelMenu extends Disposable {
	private readonly _menu: ClaudePopoverMenu;

	constructor(
		@IContextViewService contextView: IContextViewService,
		@IHoverService hoverService: IHoverService,
	) {
		super();
		this._menu = this._register(new ClaudePopoverMenu(contextView, hoverService));
	}

	get isOpen(): boolean {
		return this._menu.isOpen;
	}

	show(anchor: HTMLElement, controls: ClaudeModelControls, onHide?: () => void): void {
		this._menu.show({
			anchor,
			entries: claudeModelMenuEntries(controls),
			label: localize('claudeModelMenu', "Model"),
			className: 'is-narrow claude-model-menu',
			position: AnchorPosition.ABOVE,
			onHide,
		});
	}

	close(): void {
		this._menu.close();
	}
}

function claudeModelMenuEntries(controls: ClaudeModelControls): ClaudePopoverEntry[] {
	const { model } = controls;
	// Switches keep the menu open, so later rows build on what the earlier ones set.
	let settings = controls.settings;
	const set = (next: ClaudeSessionSettings) => {
		settings = next;
		controls.setSettings(next);
	};
	const entries: ClaudePopoverEntry[] = [];
	if (model?.supportsFastMode) {
		entries.push({
			id: 'fast',
			label: localize('claudeFastMode', "Fast"),
			detail: claudeFastModeDetail(controls.fastMode),
			toggle: true,
			checked: !!settings.fastMode,
			// The switches carry no visible effect until the next answer, so the hover says what they change and when (issue 319).
			hover: localize('claudeFastModeHover', "Claude Code's fast mode: faster answers from this model, billed at a higher rate. Changes this agent from your next message. New agents start in fast mode when Fast Mode is on in Settings."),
			dataset: { setting: 'fast' },
			run: () => set({ ...settings, fastMode: settings.fastMode ? undefined : true }),
		});
	}
	// The runtime reports the canonical id (`claude-opus-5-5`); an alias row that resolves to it is the same model.
	const current = controls.models.find(candidate => candidate.id === controls.currentId)
		?? (controls.currentId ? controls.models.find(candidate => candidate.resolvedModel === controls.currentId) : undefined);
	// Auto picks the model and its effort per turn, so the rows that belong to one model step aside.
	const context = controls.autoOn ? undefined : claudeContextChoice(controls.models, current?.id ?? controls.currentId);
	if (context) {
		const standard = localize('claudeContextStandard', "Standard");
		const long = localize('claudeContextLong', "1M");
		entries.push({
			id: 'context',
			label: localize('claudeContext', "Context"),
			value: context.isLong ? long : standard,
			dataset: { setting: 'context' },
			submenu: () => [
				{ id: 'context-standard', label: standard, detail: localize('claudeContextStandardDetail', "Model default"), role: 'menuitemradio', checked: !context.isLong, run: () => controls.pickModel(context.standard.id) },
				{ id: 'context-long', label: localize('claudeContextLongLabel', "1M Tokens"), detail: localize('claudeContextLongDetail', "Long sessions, more usage"), role: 'menuitemradio', checked: context.isLong, run: () => controls.pickModel(context.long.id) },
			],
		});
	}
	const levels = controls.autoOn ? [] : claudeEffortLevelsFor(model);
	if (levels.length > 0) {
		entries.push({
			id: 'effort',
			label: localize('claudeEffort', "Effort"),
			value: claudeEffortValue(settings),
			dataset: { setting: 'effort' },
			submenu: () => {
				const plain = !settings.ultracode;
				const rows: ClaudePopoverEntry[] = [];
				for (const level of levels) {
					rows.push({
						id: `effort-${level}`,
						label: claudeEffortLabel(level),
						// Max is never remembered for the next agent.
						detail: level === 'max' ? localize('claudeEffortMaxDetail', "This session only") : undefined,
						role: 'menuitemradio',
						checked: plain && settings.effort === level,
						dataset: { effort: level },
						run: () => set({ ...settings, effort: level, ultracode: undefined }),
					});
				}
				if (claudeSupportsUltracode(model)) {
					rows.push({ kind: 'separator' });
					rows.push({
						id: 'effort-ultracode',
						label: localize('claudeUltracodeRow', "Ultracode"),
						description: localize('claudeUltracodeDesc', "Extra high effort, and Claude runs multi-step workflows on its own"),
						icon: Codicon.sparkle,
						role: 'menuitemradio',
						checked: !!settings.ultracode,
						dataset: { effort: 'ultracode' },
						run: () => set({ ...settings, ultracode: true }),
					});
				}
				return rows;
			},
		});
	}
	if (model?.supportsAdaptiveThinking) {
		entries.push({
			id: 'thinking',
			label: localize('claudeThinking', "Thinking"),
			detail: localize('claudeThinkingDetail', "Adaptive"),
			toggle: true,
			checked: settings.thinking !== false,
			hover: localize('claudeThinkingHover', "Adaptive thinking: Claude decides when to think before it answers. Turned off, Claude answers without thinking. Changes this agent from your next message."),
			dataset: { setting: 'thinking' },
			run: () => set({ ...settings, thinking: settings.thinking === false ? undefined : false }),
		});
	}
	if (entries.length > 0) {
		entries.push({ kind: 'separator' });
	}
	entries.push({
		id: 'model',
		label: localize('claudeModelRow', "Model"),
		value: controls.autoOn
			? localize('claudeAutoModelValue', "Auto")
			: current ? claudeModelName(current) : controls.currentId ?? localize('claudeModelUnknown', "Unknown"),
		dataset: { setting: 'model' },
		submenu: () => claudeModelListEntries(controls, controls.autoOn ? undefined : current?.id),
	});
	return entries;
}

function claudeModelListEntries(controls: ClaudeModelControls, checkedId: string | undefined): ClaudePopoverEntry[] {
	const entries: ClaudePopoverEntry[] = [];
	// Auto is the first model entry (issue 1579, DL-109); it never touches the permission level.
	if (controls.pickAuto) {
		const autoText = claudeAutoModelEntryText();
		entries.push({
			id: 'auto-model',
			label: autoText.label,
			description: autoText.description,
			icon: Codicon.sparkle,
			role: 'menuitemradio',
			checked: controls.autoOn === true,
			dataset: { auto: 'on' },
			run: controls.pickAuto,
		});
		entries.push({ kind: 'separator' });
	}
	const groups = groupClaudeModels(controls.models);
	if (groups.length === 0) {
		entries.push({ id: 'none', label: localize('claudeNoModels', "Claude has not reported any models."), disabled: true });
	}
	const context = claudeContextChoice(controls.models, checkedId);
	for (const group of groups) {
		const label = claudeModelSectionLabel(group.section);
		if (label) {
			entries.push({ kind: 'header', label });
		}
		for (const model of group.models) {
			// The 1M variant is folded into its standard row; the Context row tells them apart.
			const checked = model.id === checkedId || (context?.isLong === true && model.id === context.standard.id);
			entries.push({
				id: `model-${model.id}`,
				label: claudeModelName(model),
				role: 'menuitemradio',
				checked,
				hover: claudeModelHover(model),
				dataset: { modelId: model.id },
				// Picking the checked row keeps the context it runs with.
				run: () => controls.pickModel(checked ? checkedId ?? model.id : model.id),
			});
		}
	}
	entries.push({ kind: 'separator' });
	if (controls.compare) {
		entries.push({ id: 'compare', label: localize('claudeCompareModelsEntry', "Compare Models..."), icon: Codicon.diffMultiple, run: controls.compare });
	}
	entries.push({ id: 'manage', label: localize('claudeManageModels', "Manage Models..."), icon: Codicon.settingsGear, run: controls.manage });
	return entries;
}
