/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/claudeAttribution.css';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Color } from '../../../../base/common/color.js';
import { createMarkdownCommandLink, MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IEditorDecorationsCollection } from '../../../../editor/common/editorCommon.js';
import { IModelDeltaDecoration, OverviewRulerLane } from '../../../../editor/common/model.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerColor } from '../../../../platform/theme/common/colorRegistry.js';
import { themeColorFromId } from '../../../../platform/theme/common/themeService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { ClaudeAttributionService, ClaudeAttributionSource, ClaudeLineOwner, CLAUDE_LINE_ATTRIBUTION_SETTING, IClaudeAttributionService } from '../../../services/claude/common/claudeAttribution.js';
import { IClaudeReviewService } from '../../../services/claude/common/claudeReview.js';
import { revealClaudeChat } from './chat/claudeAgentEditorActions.js';
import { KLAWLY_CATEGORY } from '../common/claudeViews.js';

registerSingleton(IClaudeAttributionService, ClaudeAttributionService, InstantiationType.Delayed);

const CLAUDE_TOGGLE_LINE_ATTRIBUTION_COMMAND_ID = 'claude.toggleLineAttribution';
const CLAUDE_CLEAR_LINE_ATTRIBUTION_COMMAND_ID = 'claude.clearLineAttribution';
const CLAUDE_OPEN_ATTRIBUTED_TURN_COMMAND_ID = 'claude.openAttributedTurn';

// DL-01: the marks are theme colors. Claude's lines take the brand orange (DL-09; the light value is the
// orange used as ink), a person's a neutral gray. High contrast keeps its earlier values (DL-02).
const claudeAttributionAgent = registerColor(
	'claude.attribution.agent',
	{ dark: Color.fromHex('#dd8f52'), light: Color.fromHex('#9e5522'), hcDark: Color.fromHex('#f0a487'), hcLight: Color.fromHex('#8f3c1c') },
	localize('claude.attribution.agent', "Gutter mark of lines a kept Claude turn wrote, when line attribution is on.")
);

registerColor(
	'claude.attribution.human',
	{ dark: Color.fromHex('#8b949e'), light: Color.fromHex('#6e7781'), hcDark: Color.fromHex('#c9d1d9'), hcLight: Color.fromHex('#424a53') },
	localize('claude.attribution.human', "Gutter mark of lines a person changed after Claude wrote the file, when line attribution is on.")
);

/** The Markdown shown on the line number of an attributed line. */
function ownerHover(owner: ClaudeLineOwner): MarkdownString {
	if (owner.kind === 'human') {
		return new MarkdownString(localize('claudeAttributionHumanHover', "Changed by hand after Claude's last kept change."));
	}
	const markdown = new MarkdownString('', { isTrusted: { enabledCommands: [CLAUDE_OPEN_ATTRIBUTED_TURN_COMMAND_ID] } });
	markdown.appendMarkdown(owner.kind === 'pending'
		? localize('claudeAttributionPendingHover', "Written by Claude, waiting for review.")
		: localize('claudeAttributionAgentHover', "Written by Claude."));
	markdown.appendMarkdown('\n\n');
	markdown.appendText(sourceLabel(owner.source));
	if (owner.source.origin === 'tab' || owner.source.origin === 'inline') {
		// No chat turn wrote these lines, so there is no turn to open.
		return markdown;
	}
	markdown.appendMarkdown('\n\n');
	markdown.appendMarkdown(createMarkdownCommandLink({
		text: localize('claudeAttributionOpenTurn', "Open Turn"),
		id: CLAUDE_OPEN_ATTRIBUTED_TURN_COMMAND_ID,
		arguments: [owner.source.sessionId, owner.source.turnId],
		tooltip: localize('claudeAttributionOpenTurnTooltip', "Show this turn in the chat"),
	}));
	return markdown;
}

/** "Turn 3 · Sonnet 4.5 · Fix the parser", with what is known, or the Tab completion or inline edit that wrote the line. */
function sourceLabel(source: ClaudeAttributionSource): string {
	if (source.origin === 'tab') {
		return localize('claudeAttributionTab', "Accepted from Klawly Tab");
	}
	if (source.origin === 'inline') {
		return localize('claudeAttributionInline', "Accepted from an inline edit");
	}
	const parts: string[] = [];
	parts.push(source.turn !== undefined ? localize('claudeAttributionTurn', "Turn {0}", source.turn) : localize('claudeAttributionTurnUnknown', "A past turn"));
	if (source.model) {
		parts.push(source.model);
	}
	if (source.sessionTitle) {
		parts.push(source.sessionTitle);
	}
	return parts.join(' · ');
}

function ownerKey(owner: ClaudeLineOwner | undefined): string {
	if (!owner) {
		return '';
	}
	return owner.kind === 'human' ? 'human' : `${owner.kind}\n${owner.source.sessionId}\n${owner.source.turnId}`;
}

/** One decoration per run of lines with the same owner. */
export function attributionDecorations(owners: readonly (ClaudeLineOwner | undefined)[]): IModelDeltaDecoration[] {
	const decorations: IModelDeltaDecoration[] = [];
	let start = 0;
	for (let index = 1; index <= owners.length; index++) {
		if (index < owners.length && ownerKey(owners[index]) === ownerKey(owners[start])) {
			continue;
		}
		const owner = owners[start];
		if (owner) {
			const tooltip = owner.kind === 'human'
				? localize('claudeAttributionHumanTooltip', "Changed by hand")
				: localize('claudeAttributionAgentTooltip', "Written by Claude: {0}", sourceLabel(owner.source));
			decorations.push({
				range: new Range(start + 1, 1, index, 1),
				options: {
					description: 'claude-line-attribution',
					isWholeLine: true,
					linesDecorationsClassName: `claude-attribution claude-attribution-${owner.kind}`,
					linesDecorationsTooltip: tooltip,
					lineNumberHoverMessage: ownerHover(owner),
					overviewRuler: owner.kind === 'human' ? undefined : { color: themeColorFromId(claudeAttributionAgent), position: OverviewRulerLane.Left },
				},
			});
		}
		start = index;
	}
	return decorations;
}

/** Keeps one editor's attribution marks in step with its text. */
class EditorAttribution extends Disposable {
	private readonly _decorations: IEditorDecorationsCollection;
	private readonly _update = this._register(new RunOnceScheduler(() => this.update(), 250));

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _attribution: IClaudeAttributionService,
	) {
		super();
		this._decorations = this._editor.createDecorationsCollection();
		this._register({ dispose: () => this._decorations.clear() });
		this._register(this._editor.onDidChangeModel(() => this.update()));
		this._register(this._editor.onDidChangeModelContent(() => this._update.schedule()));
		this.update();
	}

	schedule(): void {
		this._update.schedule();
	}

	update(): void {
		const model = this._editor.getModel();
		const owners = model && this._attribution.isEnabled() ? this._attribution.ownersFor(model.uri, model.getLinesContent()) : undefined;
		this._decorations.set(owners ? attributionDecorations(owners) : []);
	}
}

/** Marks who wrote each line in every open editor while `claude.editor.lineAttribution` is on. */
class ClaudeAttributionContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeLineAttribution';

	private readonly _editors = this._register(new DisposableMap<ICodeEditor, EditorAttribution>());

	constructor(
		@ICodeEditorService private readonly _codeEditors: ICodeEditorService,
		@IClaudeAttributionService private readonly _attribution: IClaudeAttributionService,
		@IClaudeReviewService review: IClaudeReviewService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super();
		for (const editor of this._codeEditors.listCodeEditors()) {
			this.track(editor);
		}
		this._register(this._codeEditors.onCodeEditorAdd(editor => this.track(editor)));
		this._register(this._codeEditors.onCodeEditorRemove(editor => this._editors.deleteAndDispose(editor)));
		this._register(this._attribution.onDidChange(uri => this.refresh(model => model.toString() === uri.toString())));
		this._register(review.onDidChangeReview(() => this.refresh()));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_LINE_ATTRIBUTION_SETTING)) {
				this.refresh();
			}
		}));
	}

	private track(editor: ICodeEditor): void {
		if (!this._editors.has(editor)) {
			this._editors.set(editor, new EditorAttribution(editor, this._attribution));
		}
	}

	private refresh(matches?: (uri: URI) => boolean): void {
		for (const [editor, attribution] of this._editors) {
			const uri = editor.getModel()?.uri;
			if (uri && (!matches || matches(uri))) {
				attribution.schedule();
			}
		}
	}
}

registerWorkbenchContribution2(ClaudeAttributionContribution.ID, ClaudeAttributionContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CLAUDE_TOGGLE_LINE_ATTRIBUTION_COMMAND_ID,
			title: localize2('claudeToggleLineAttribution', "Toggle Line Attribution"),
			category: KLAWLY_CATEGORY,
			f1: true,
			toggled: ContextKeyExpr.equals(`config.${CLAUDE_LINE_ATTRIBUTION_SETTING}`, true),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		await configuration.updateValue(CLAUDE_LINE_ATTRIBUTION_SETTING, configuration.getValue<boolean>(CLAUDE_LINE_ATTRIBUTION_SETTING) !== true, ConfigurationTarget.USER);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CLAUDE_CLEAR_LINE_ATTRIBUTION_COMMAND_ID,
			title: localize2('claudeClearLineAttribution', "Clear Line Attribution for This Workspace"),
			category: KLAWLY_CATEGORY,
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(IClaudeAttributionService).clear();
	}
});

CommandsRegistry.registerCommand(CLAUDE_OPEN_ATTRIBUTED_TURN_COMMAND_ID, async (accessor: ServicesAccessor, sessionId: unknown, turnId: unknown) => {
	if (typeof sessionId !== 'string' || typeof turnId !== 'string') {
		return;
	}
	const agent = accessor.get(IClaudeAgentService);
	const views = accessor.get(IViewsService);
	const editors = accessor.get(IEditorService);
	const instantiation = accessor.get(IInstantiationService);
	if (!agent.getSessions().some(session => session.id === sessionId)) {
		return;
	}
	agent.selectSession(sessionId);
	const pane = await revealClaudeChat(views, editors, instantiation, true);
	pane?.revealTurn(turnId);
});
