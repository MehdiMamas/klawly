/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Range } from '../../../../editor/common/core/range.js';
import { CodeAction, CodeActionContext, CodeActionList, CodeActionProvider } from '../../../../editor/common/languages.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { CodeActionKind } from '../../../../editor/contrib/codeAction/common/types.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClaudeActionService } from '../../../../platform/claude/common/claudeActions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarker, IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { Marker, ResourceMarkers } from '../../markers/browser/markersModel.js';
import { IMarkersView } from '../../markers/browser/markers.js';
import { Markers, MarkersContextKeys } from '../../markers/common/markers.js';
import { DiagnosticSummary } from '../../../../platform/claude/common/claudePrompt.js';
import { chooseFixProblems, DIAGNOSTIC_SEND_LIMIT, isDiagnosticSummaryList } from '../../../services/claude/common/claudeDiagnostics.js';
import { CLAUDE_AGENT_VIEW_ID, CLAUDE_FIX_PROBLEMS_COMMAND_ID, KLAWLY_CATEGORY } from '../common/claudeViews.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { CLAUDE_AGENT_ENABLED_SETTING, readClaudeAgentEnabled } from '../../../../platform/claude/common/claudeConfiguration.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { summariesFromMarkers } from './claudeDiagnosticsService.js';

export function registerClaudeDiagnosticsActions(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_FIX_PROBLEMS_COMMAND_ID,
				title: localize2('claudeFixProblems', "Fix Problems with Claude"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				menu: {
					id: MenuId.ProblemsPanelContext,
					group: 'navigation',
					order: 0,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, MarkersContextKeys.MarkerFocusContextKey, MarkersContextKeys.RelatedInformationFocusContextKey.toNegated()),
				},
			});
		}

		run(accessor: ServicesAccessor, items?: unknown): Promise<void> {
			return runFixProblems(accessor, items);
		}
	});
}

export class ClaudeFixProblemsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'claude.fixProblemsCodeAction';

	constructor(
		@ILanguageFeaturesService languageFeatures: ILanguageFeaturesService,
		@IMarkerService markers: IMarkerService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super();
		const agentEnabled = () => readClaudeAgentEnabled(configuration.getValue(CLAUDE_AGENT_ENABLED_SETTING));
		this._register(languageFeatures.codeActionProvider.register('*', new ClaudeFixProblemsCodeActionProvider(markers, workspace, agentEnabled)));
	}
}

export class ClaudeFixProblemsCodeActionProvider implements CodeActionProvider {
	readonly providedCodeActionKinds = [CodeActionKind.QuickFix.value];

	/** `agentEnabled` reads `claude.agent.enabled`: with the agent off the lightbulb offers nothing. */
	constructor(
		private readonly _markers: IMarkerService,
		private readonly _workspace: IWorkspaceContextService,
		private readonly _agentEnabled: () => boolean,
	) { }

	provideCodeActions(model: ITextModel, range: Range, _context: CodeActionContext, _token: CancellationToken): CodeActionList | undefined {
		if (!this._agentEnabled()) {
			return undefined;
		}
		const markers = this._markers.read({ resource: model.uri }).filter(marker => Range.intersectRanges(range, marker));
		if (markers.length === 0) {
			return undefined;
		}
		const items = summariesFromMarkers(markers, this._workspace);
		if (items.length === 0) {
			return undefined;
		}
		const action: CodeAction = {
			title: localize('claudeFixProblemsLightbulb', "Fix Problems with Agent"),
			kind: CodeActionKind.QuickFix.value,
			command: {
				id: CLAUDE_FIX_PROBLEMS_COMMAND_ID,
				title: localize('claudeFixProblemsLightbulb', "Fix Problems with Agent"),
				arguments: [items],
			},
		};
		return { actions: [action], dispose() { } };
	}
}

async function runFixProblems(accessor: ServicesAccessor, items: unknown): Promise<void> {
	const actions = accessor.get(IClaudeActionService);
	const views = accessor.get(IViewsService);
	const notifications = accessor.get(INotificationService);
	const diagnostics = resolveFixProblems(accessor, items);
	if (diagnostics.length === 0) {
		notifications.info(localize('claudeNoProblems', "No problems to send."));
		return;
	}
	await views.openView(CLAUDE_AGENT_VIEW_ID, true);
	await actions.run({
		id: 'fixProblems',
		source: 'menu',
		attachments: [{ kind: 'diagnostics', items: diagnostics }],
	});
}

export function resolveFixProblems(accessor: ServicesAccessor, items: unknown): DiagnosticSummary[] {
	const notifications = accessor.get(INotificationService);
	const views = accessor.get(IViewsService);
	const workspace = accessor.get(IWorkspaceContextService);
	let provided: readonly DiagnosticSummary[] | undefined;
	let selected: readonly DiagnosticSummary[] | undefined;
	let activeEditor: readonly DiagnosticSummary[] | undefined;
	let allMarkers: readonly DiagnosticSummary[] = [];
	if (isDiagnosticSummaryList(items) && items.length > 0) {
		provided = items;
	} else {
		const markersView = views.getActiveViewWithId<IMarkersView>(Markers.MARKERS_VIEW_ID);
		if (markersView) {
			const models = selectedMarkerModels(markersView);
			if (models.length > 0) {
				selected = summariesFromMarkers(models, workspace);
			}
		}
		if (!selected) {
			const markers = accessor.get(IMarkerService);
			const editors = accessor.get(IEditorService);
			const resource = editors.activeEditor?.resource;
			if (resource) {
				activeEditor = summariesFromMarkers(markers.read({ resource, severities: MarkerSeverity.Error }), workspace);
			} else {
				allMarkers = summariesFromMarkers(markers.read({ severities: MarkerSeverity.Error }), workspace);
			}
		}
	}
	const chosen = chooseFixProblems({ provided, selected, activeEditor, allMarkers });
	if (chosen.truncated) {
		notifications.info(localize('claudeProblemsTruncated', "Sending the first {0} of {1} problems.", DIAGNOSTIC_SEND_LIMIT, chosen.total));
	}
	return chosen.items;
}

function selectedMarkerModels(view: IMarkersView): IMarker[] {
	const selection = view.getFocusedSelectedElements() || view.getAllResourceMarkers();
	const markers: IMarker[] = [];
	const add = (marker: IMarker) => {
		if (!markers.includes(marker)) {
			markers.push(marker);
		}
	};
	for (const selected of selection) {
		if (selected instanceof ResourceMarkers) {
			for (const marker of selected.markers) {
				add(marker.marker);
			}
		} else if (selected instanceof Marker) {
			add(selected.marker);
		}
	}
	return markers;
}
