/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClaudeRuntimeService, ClaudeModelInfo } from '../../../../platform/claude/common/claude.js';
import { CLAUDE_COMPARE_MAX_BUDGET_SETTING, CLAUDE_COMPARE_MAX_RUNS, CLAUDE_COMPARE_MIN_RUNS, ClaudeComparisonView, readClaudeCompareBudget } from '../../../../platform/claude/common/claudeComparison.js';
import { CLAUDE_MODELS_CUSTOM_SETTING, CLAUDE_MODELS_ENABLED_SETTING } from '../../../../platform/claude/common/claudeConfiguration.js';
import { claudeModelDisplayName, pickableClaudeModels, readClaudeModelIdList } from '../../../../platform/claude/common/claudeModels.js';
import { ClaudeComparisonRunSpec } from '../../../../platform/claude/common/claudeProtocol.js';
import { claudeEffortLevelsFor } from '../../../../platform/claude/common/claudeSessionSettings.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { CLAUDE_COMPARE_MODELS_COMMAND_ID, CLAUDE_OPEN_COMPARISON_COMMAND_ID, IClaudeComparisonService } from '../../../services/claude/common/claudeComparison.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { CLAUDE_AGENT_ENABLED } from '../../claude/common/claudeContextKeys.js';
import { claudeEffortLabel } from '../../claude/common/claudeModelControls.js';
import { KLAWLY_CATEGORY } from '../../claude/common/claudeViews.js';
import { ClaudeComparisonEditor, ClaudeComparisonInput } from './claudeComparisonEditor.js';

interface RunPick extends IQuickPickItem {
	readonly spec: ClaudeComparisonRunSpec;
}

interface JudgePick extends IQuickPickItem {
	/** Absent on No Judge. */
	readonly modelId?: string;
}

/**
 * Every model and effort pair a comparison may run: one row per effort a
 * model takes, or one row for a model that takes none. Older models are left
 * out, as the model list keeps them under their own heading.
 */
function claudeComparisonRunPicks(models: readonly ClaudeModelInfo[]): RunPick[] {
	const picks: RunPick[] = [];
	for (const model of models) {
		if (model.older) {
			continue;
		}
		const name = claudeModelDisplayName(model);
		const efforts = claudeEffortLevelsFor(model);
		if (!efforts.length) {
			picks.push({ label: name, spec: { modelId: model.id, label: name } });
			continue;
		}
		for (const effort of efforts) {
			const label = localize('claudeCompareRunLabel', "{0}, {1}", name, claudeEffortLabel(effort));
			picks.push({ label: name, description: claudeEffortLabel(effort), spec: { modelId: model.id, effort, label } });
		}
	}
	return picks;
}

/** The judge the dialog offers first: the newest Opus, else the first model. */
function claudeDefaultJudgeModel(models: readonly ClaudeModelInfo[]): ClaudeModelInfo | undefined {
	const current = models.filter(model => !model.older);
	return current.find(model => /opus/i.test(model.resolvedModel ?? model.id)) ?? current[0];
}

/**
 * Compare Models (issue 424): the prompt, two to four model and effort pairs,
 * the judge and the budget per run, each its own quick input step (DL-21),
 * then the Compare editor, which follows the runs and keeps one.
 */
export function registerClaudeCompareModels(): void {
	registerClaudeComparisonEditor();
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_COMPARE_MODELS_COMMAND_ID,
				title: localize2('claudeCompareModels', "Compare Models"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		async run(accessor: ServicesAccessor, given?: unknown): Promise<void> {
			const quickInput = accessor.get(IQuickInputService);
			const runtime = accessor.get(IClaudeRuntimeService);
			const configuration = accessor.get(IConfigurationService);
			const notifications = accessor.get(INotificationService);
			const comparisons = accessor.get(IClaudeComparisonService);
			const editors = accessor.get(IEditorService);
			const instantiation = accessor.get(IInstantiationService);
			const draft = accessor.get(IClaudeAgentService).getCurrentSession()?.draft.trim();

			const prompt = typeof given === 'string' && given.trim() ? given.trim() : (await quickInput.input({
				title: localize('claudeCompareTitle', "Compare Models"),
				prompt: localize('claudeComparePrompt', "What should each model do? Every run gets its own worktree."),
				value: draft,
			}))?.trim();
			if (!prompt) {
				return;
			}

			let models: ClaudeModelInfo[];
			try {
				models = pickableClaudeModels(
					await runtime.listModels(),
					readClaudeModelIdList(configuration.getValue(CLAUDE_MODELS_ENABLED_SETTING)),
					readClaudeModelIdList(configuration.getValue(CLAUDE_MODELS_CUSTOM_SETTING)),
				);
			} catch (error) {
				notifications.error(error instanceof Error ? error.message : String(error));
				return;
			}
			const runs = await pickRuns(quickInput, claudeComparisonRunPicks(models));
			if (!runs) {
				return;
			}

			const strongest = claudeDefaultJudgeModel(models);
			const judgePicks: JudgePick[] = models.filter(model => !model.older).map(model => ({
				label: claudeModelDisplayName(model),
				description: model === strongest ? localize('claudeCompareJudgeDefault', "Default") : undefined,
				modelId: model.id,
			}));
			judgePicks.sort((a, b) => Number(b.modelId === strongest?.id) - Number(a.modelId === strongest?.id));
			judgePicks.push({ label: localize('claudeCompareNoJudge', "No Judge"), description: localize('claudeCompareNoJudgeDetail', "Compare the runs yourself") });
			const judge = await quickInput.pick(judgePicks, {
				title: localize('claudeCompareJudgeTitle', "Judge"),
				placeHolder: localize('claudeCompareJudgePlaceholder', "Which model ranks the runs once they all end?"),
			});
			if (!judge) {
				return;
			}

			const budgetSetting = readClaudeCompareBudget(configuration.getValue(CLAUDE_COMPARE_MAX_BUDGET_SETTING));
			const budgetText = await quickInput.input({
				title: localize('claudeCompareBudgetTitle', "Budget per Run"),
				prompt: localize('claudeCompareBudgetPrompt', "Most each run may spend, in US dollars. Claude Code stops a run that reaches it."),
				value: String(budgetSetting),
				validateInput: async value => Number(value) > 0 && Number.isFinite(Number(value)) ? undefined : localize('claudeCompareBudgetInvalid', "Enter an amount above 0."),
			});
			if (budgetText === undefined) {
				return;
			}

			let view: ClaudeComparisonView;
			try {
				view = await comparisons.start({
					prompt,
					runs,
					judge: judge.modelId ? { modelId: judge.modelId } : undefined,
					maxBudgetUsd: Number(budgetText),
				});
			} catch (error) {
				notifications.error(error instanceof Error ? error.message : String(error));
				return;
			}
			await editors.openEditor(instantiation.createInstance(ClaudeComparisonInput, view.id), { pinned: true });
		}
	});
}

/** The multi-select step: 2 to 4 rows, with the count checked before it accepts. */
async function pickRuns(quickInput: IQuickInputService, picks: readonly RunPick[]): Promise<ClaudeComparisonRunSpec[] | undefined> {
	const store = new DisposableStore();
	const picker = store.add(quickInput.createQuickPick<RunPick>());
	picker.title = localize('claudeCompareRunsTitle', "Models to Compare");
	picker.placeholder = localize('claudeCompareRunsPlaceholder', "Pick {0} to {1} models and efforts", CLAUDE_COMPARE_MIN_RUNS, CLAUDE_COMPARE_MAX_RUNS);
	picker.canSelectMany = true;
	picker.matchOnDescription = true;
	picker.items = picks;
	try {
		return await new Promise<ClaudeComparisonRunSpec[] | undefined>(resolve => {
			store.add(picker.onDidChangeSelection(selected => {
				picker.validationMessage = selected.length > CLAUDE_COMPARE_MAX_RUNS ? localize('claudeCompareTooMany', "Pick at most {0}.", CLAUDE_COMPARE_MAX_RUNS) : undefined;
			}));
			store.add(picker.onDidAccept(() => {
				const selected = picker.selectedItems;
				if (selected.length < CLAUDE_COMPARE_MIN_RUNS || selected.length > CLAUDE_COMPARE_MAX_RUNS) {
					picker.validationMessage = localize('claudeCompareCountHint', "Pick {0} to {1} models and efforts.", CLAUDE_COMPARE_MIN_RUNS, CLAUDE_COMPARE_MAX_RUNS);
					return;
				}
				resolve(selected.map(item => item.spec));
				picker.hide();
			}));
			store.add(picker.onDidHide(() => resolve(undefined)));
			picker.show();
		});
	} finally {
		store.dispose();
	}
}

class ClaudeComparisonInputSerializer implements IEditorSerializer {
	canSerialize(editor: EditorInput): boolean {
		return editor instanceof ClaudeComparisonInput;
	}

	serialize(editor: EditorInput): string | undefined {
		return editor instanceof ClaudeComparisonInput ? editor.comparisonId : undefined;
	}

	deserialize(instantiationService: IInstantiationService, serialized: string): EditorInput | undefined {
		return serialized ? instantiationService.createInstance(ClaudeComparisonInput, serialized) : undefined;
	}
}

/** The Compare editor, its tab across reloads, and the command History opens it with. */
function registerClaudeComparisonEditor(): void {
	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(ClaudeComparisonEditor, ClaudeComparisonEditor.ID, localize('claudeComparisonEditor', "Compare Models")),
		[new SyncDescriptor(ClaudeComparisonInput)],
	);
	Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(ClaudeComparisonInput.ID, ClaudeComparisonInputSerializer);
	CommandsRegistry.registerCommand(CLAUDE_OPEN_COMPARISON_COMMAND_ID, async (accessor, comparisonId: unknown) => {
		if (typeof comparisonId !== 'string' || !comparisonId) {
			return;
		}
		const instantiation = accessor.get(IInstantiationService);
		await accessor.get(IEditorService).openEditor(instantiation.createInstance(ClaudeComparisonInput, comparisonId), { pinned: true });
	});
}
