/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeKeybinding } from '../../../../../base/common/keybindings.js';
import { KeyChord, KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { hasKey } from '../../../../../base/common/types.js';
import { Event } from '../../../../../base/common/event.js';
import { IClaudeGoalLoopService } from '../../common/claudeGoalLoopService.js';
import { matchesBaseContiguousSubString, matchesWords, or } from '../../../../../base/common/filters.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { OS } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MenuId, MenuRegistry, isIMenuItem } from '../../../../../platform/actions/common/actions.js';
import { CLAUDE_AUTOCOMPLETE_ENABLED_SETTING, CLAUDE_INLINE_REJECT_ON_ESCAPE_SETTING, CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING, CLAUDE_MODELS_CUSTOM_SETTING, CLAUDE_MODELS_ENABLED_SETTING } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { FakeClaudeRuntimeService } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { CLAUDE_SHARE_TO_PHONE_COMMAND_ID } from '../../../../../platform/claude/common/claudeRemoteControl.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyExpr, ContextKeyExpression, IContextKeyService, ContextKeyExprType, IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { IConfirmation, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { MockContextKeyService, MockKeybindingService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { AbstractCommandsQuickAccessProvider, ICommandQuickPick, matchesCommandAliasTerm } from '../../../../../platform/quickinput/browser/commandsQuickAccess.js';
import { Pick, PicksWithActive } from '../../../../../platform/quickinput/browser/pickerQuickAccess.js';
import { InMemoryStorageService, IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IViewDescriptorService, IViewsRegistry, Extensions as ViewExtensions, ViewContainerLocation } from '../../../../common/views.js';
import { CLAUDE_BACKGROUND_VIEW_ID } from '../../../claudeBackground/common/claudeBackground.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { CLAUDE_SESSION_LIST_LOCATION_SETTING } from '../../common/claudeAgentsList.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { ClaudeAgentService, IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudeReviewService, ReviewPendingSummary, ReviewScope } from '../../../../services/claude/common/claudeReview.js';
import { agentWorkspaceStubs } from '../../../../services/claude/test/common/claudeAgentTestUtils.js';
import { registerClaudePaneActions } from '../../browser/claudeActions.js';
import { CLAUDE_ADD_SELECTION_KEY, CLAUDE_KLAWLY_AGENT_KEY, CLAUDE_KLAWLY_CYCLE_KEY, CLAUDE_KLAWLY_FOCUS_KEY, CLAUDE_CYCLE_MODEL_KEY, CLAUDE_FOCUS_AGENT_KEY, CLAUDE_STOP_AGENT_KEY, registerClaudeCommands } from '../../browser/claudeCommands.js';
import { ClaudeModelSwitchService, IClaudeModelSwitchService } from '../../browser/claudeModelSwitch.js';
import { INLINE_EDIT_KLAWLY_KEY, INLINE_EDIT_DEFAULT_KEY } from '../../../../services/claude/common/claudeInlineEdit.js';
import { CLAUDE_TERMINAL_PROMPT_COMMAND_ID, registerClaudeTerminalPrompt } from '../../browser/terminal/claudeTerminalPrompt.js';
import { registerClaudeChatShareCommands } from '../../browser/chat/claudeChatShare.js';
import { registerClaudeShareToPhone } from '../../browser/chat/claudeShareToPhone.js';
import { registerClaudeVoice } from '../../browser/chat/claudeVoiceActions.js';
import { registerClaudeAccountCommands } from '../../browser/claudeAccountCommands.js';
import { registerClaudeContextActions } from '../../browser/claudeContextActions.js';
import { registerClaudeDiagnosticsActions } from '../../browser/claudeDiagnosticsActions.js';
import { registerClaudeGitActions } from '../../browser/claudeGitActions.js';
import { registerClaudeInlineContributions } from '../../browser/inline/claudeInlineController.js';
import { registerClaudePlanEditor } from '../../browser/plan/claudePlan.contribution.js';
import { registerClaudeReviewEditor } from '../../browser/review/claudeReviewEditorActions.js';
import { registerClaudeAgentEditor } from '../../browser/chat/claudeAgentEditorActions.js';
import { registerClaudeSettingsEditor } from '../../browser/settings/claudeSettingsEditorActions.js';
import { registerClaudeReviewContributions } from '../../browser/review/claudeReviewPane.js';
import { ClaudeAgentViewPane } from '../../browser/chat/claudeViewPane.js';
import { ClaudeAgentEditor } from '../../browser/chat/claudeAgentEditor.js';
import { registerClaudeImportCommands } from '../../browser/claudeImport.js';
import { registerClaudePreviewActions } from '../../browser/claudePreviewActions.js';
import { registerClaudeSetupCommands } from '../../browser/claudeSetup.js';
import { registerClaudeStatusCommands } from '../../browser/claudeStatus.js';
import { registerClaudeViewDescriptors } from '../../browser/claudeViewRegistration.js';
import { registerClaudeMenuItems } from '../../browser/claudeMenus.js';
import { registerClaudeBackground } from '../../../claudeBackground/browser/claudeBackground.contribution.js';
import { CLAUDE_AGENT_ENABLED } from '../../common/claudeContextKeys.js';
import { CLAUDE_IMPORT_FROM_CURSOR_COMMAND_ID, CLAUDE_IMPORT_FROM_VSCODE_COMMAND_ID, CLAUDE_UNDO_IMPORT_COMMAND_ID } from '../../common/claudeImport.js';
import { CLAUDE_VOICE_TOGGLE_COMMAND_ID } from '../../common/claudeVoiceInput.js';
import { CLAUDE_OPEN_AGENTS_WINDOW_COMMAND_ID, CLAUDE_OPEN_BACKGROUND_AGENTS_COMMAND_ID, CLAUDE_SHOW_STATUS_COMMAND_ID, CLAUDE_SIGN_IN_COMMAND_ID, CLAUDE_SWITCH_ACCOUNT_COMMAND_ID } from '../../common/claudeViews.js';

/** Every command spec 45 requires, with the palette title it must have. */
const SECTION_45: readonly [string, string][] = [
	['claude.focusAgent', 'Focus Agent'],
	['claude.newSession', 'New Agent'],
	['claude.openSessionHistory', 'Open Agent History'],
	['claude.addSelection', 'Add Selection to Agent'],
	['claude.addFile', 'Add File to Agent'],
	['klawly.inlineEdit.start', 'Inline Edit'],
	['klawly.inlineEdit.accept', 'Accept Inline Edit'],
	['klawly.inlineEdit.reject', 'Reject AI Edit'],
	['klawly.review.nextChange', 'Review Next Change'],
	['klawly.review.previousChange', 'Review Previous Change'],
	['claude.acceptAllChanges', 'Keep All Changes'],
	['claude.rejectAllChanges', 'Undo All Changes'],
	['claude.restoreCheckpoint', 'Restore Checkpoint'],
	['claude.stopAgent', 'Stop Agent'],
	['claude.queueMessage', 'Queue Message'],
	['claude.cycleModel', 'Cycle Model'],
	['claude.pickModel', 'Pick Model'],
	['claude.showSentPrompt', 'Show Sent Prompt'],
	['claude.openSessionInspector', 'Open Session Inspector'],
	['claude.openSubagentChat', 'Open Subagent Chat'],
	['claude.stopSubagent', 'Stop Subagent'],
	['claude.referenceChat', 'Reference Chat in Composer'],
	['claude.reviewChanges', 'Review Changes with Claude'],
	['claude.splitIntoPullRequests', 'Split into Pull Requests'],
	['claude.fixProblems', 'Fix Problems with Claude'],
	['claude.openBackgroundAgents', 'Open Background Agents'],
	['claude.toggleAutocomplete', 'Toggle Autocomplete'],
	['claude.preview.fixElement', 'Fix Selected Preview Element with Agent'],
];

/**
 * Commands that start an agent turn, open agent UI or change review state. Each
 * needs `claude.agent.enabled`: in its precondition, every menu `when` and every
 * keybinding `when`.
 */
const AGENT_COMMANDS: readonly string[] = [
	'claude.focusAgent',
	'claude.newSession',
	'claude.openSessionHistory',
	'claude.addSelection',
	'claude.addSelectionToNewAgent',
	'claude.explainSelection',
	'claude.addFile',
	'claude.addFileToNewAgent',
	'klawly.inlineEdit.start',
	'klawly.inlineEdit.accept',
	'klawly.inlineEdit.reject',
	'klawly.inlineEdit.nextHunk',
	'klawly.inlineEdit.previousHunk',
	'klawly.review.acceptHunk',
	'klawly.review.openEditor',
	'klawly.review.keepFile',
	'klawly.review.undoFile',
	'klawly.review.openFile',
	'klawly.review.rejectHunk',
	'klawly.review.nextChange',
	'klawly.review.previousChange',
	'klawly.review.keepEditorFile',
	'klawly.review.toggleAutoKeep',
	'klawly.review.pendingMenu',
	'claude.acceptAllChanges',
	'claude.rejectAllChanges',
	'claude.restoreCheckpoint',
	'claude.stopAgent',
	'claude.queueMessage',
	'claude.cycleModel',
	'claude.pickModel',
	'claude.manageModels',
	'claude.changePermissionLevel',
	'claude.showPlanUsage',
	'claude.openCustomize',
	'claude.showSentPrompt',
	'claude.askSideQuestion',
	'claude.goToTurn',
	'claude.findInChat',
	'claude.findInChatAsList',
	'claude.openSessionInspector',
	'claude.openSubagentChat',
	'claude.stopSubagent',
	'claude.referenceChat',
	'claude.reviewChanges',
	'claude.generateCommitMessage',
	'claude.explainDiff',
	'claude.explainCommit',
	'claude.resolveConflicts',
	'claude.splitIntoPullRequests',
	'claude.commitAcceptedChanges',
	'claude.fixProblems',
	'claude.openBackgroundAgents',
	'klawly.background.start',
	'klawly.plan.openFromChat',
	'klawly.plan.build',
	'klawly.plan.saveToWorkspace',
	'claude.preview.addScreenshot',
	'claude.preview.addConsoleErrors',
	'claude.preview.addElement',
	'claude.preview.fixElement',
	'claude.showStatus',
	'claude.redetectRuntime',
	'claude.signIn',
	'claude.installRuntime',
	'claude.chooseRuntime',
	'claude.openChatInEditor',
	'claude.openChatInWindow',
	CLAUDE_OPEN_AGENTS_WINDOW_COMMAND_ID,
	'claude.moveChatToSideBar',
	'claude.agentEditor.toggleHistory',
	'claude.agentEditor.more',
	'claude.copyChatMarkdown',
	'claude.exportTranscript',
	'claude.shareChatLink',
];

/** Registered `claude.*` and `klawly.*` commands that work with the agent off, and why. */
const WITHOUT_AGENT = new Map<string, string>([
	['claude.tabStopGoal', 'chat tab menu item, shown only when the tab has a goal'],
	['claude.stopGoal', 'palette entry; says so when the current chat has no goal'],
	['claude.editGoal', 'palette entry; says so when the current chat has no goal'],
	['claude.resumeGoal', 'palette entry; says so when the current chat has no paused goal'],
	['claude.tabEditGoal', 'chat tab menu item, shown only when the tab has a goal'],
	['claude.toggleAutocomplete', 'Tab autocomplete has its own setting'],
	['klawly.tab.acceptNextEdit', 'Tab autocomplete'],
	['klawly.tab.dismissNextEdit', 'Tab autocomplete'],
	['klawly.tab.showLatency', 'Tab autocomplete'],
	['claude.enableAgent', 'turns the agent back on'],
	['claude.openSettings', 'the settings hold the switch that turns the agent back on'],
	[CLAUDE_IMPORT_FROM_VSCODE_COMMAND_ID, 'imports editor settings, no AI'],
	[CLAUDE_IMPORT_FROM_CURSOR_COMMAND_ID, 'imports editor settings, no AI'],
	[CLAUDE_UNDO_IMPORT_COMMAND_ID, 'restores the backup an import made, no AI'],
	['claude.agentView.header', 'the Agent view title item that renders the header row; it runs nothing'],
	['claude.preview.open', 'the browser preview works without the agent'],
	['claude.preview.back', 'preview navigation'],
	['claude.preview.forward', 'preview navigation'],
	['claude.preview.refresh', 'preview navigation'],
	['claude.preview.device.desktop', 'preview device'],
	['claude.preview.device.tablet', 'preview device'],
	['claude.preview.device.mobile', 'preview device'],
	['claude.preview.pickElement', 'shows the picked selector in the preview'],
	['claude.preview.toggleDesignMode', 'design picks stay in the preview until they are added to the agent'],
	['claude.preview.copyConsoleErrors', 'copies to the clipboard'],
	['claude.openComparison', 'reopens a saved model comparison from History; it has no palette entry and runs no agent'],
	['claude.agentView.header', 'a no-op title item that only draws the Agent view header row'],
	['claude.toggleLineAttribution', 'line attribution also marks Tab lines, and Tab works without the agent'],
	['claude.clearLineAttribution', 'clears a local record, no AI'],
	['claude.openAttributedTurn', 'a hover link with no palette entry; it does nothing when the turn\'s chat is gone'],
]);

/** Menus the Claude contributions add items to. */
const CLAUDE_MENUS = [MenuId.CommandPalette, MenuId.EditorContext, MenuId.ExplorerContext, MenuId.EditorTitleContext, MenuId.MenubarFileMenu, MenuId.MenubarViewMenu, MenuId.ProblemsPanelContext, MenuId.SCMTitle, MenuId.SCMInputBox, MenuId.SCMResourceContext, MenuId.SCMHistoryItemContext, MenuId.SCMResourceGroupContext, MenuId.EditorTitle, MenuId.MultiDiffEditorFileToolbar];

/** True when `expr` can only hold while the agent is enabled: it is the agent key, or an AND that contains it. */
function requiresAgent(expr: ContextKeyExpression | null | undefined): boolean {
	if (!expr) {
		return false;
	}
	if (expr.equals(CLAUDE_AGENT_ENABLED)) {
		return true;
	}
	if (expr.type === ContextKeyExprType.And) {
		return expr.expr.some(requiresAgent);
	}
	if (expr.type === ContextKeyExprType.Or) {
		return expr.expr.every(requiresAgent);
	}
	return false;
}

function registerOnce(id: string, register: () => void): void {
	if (!CommandsRegistry.getCommand(id)) {
		register();
	}
}

/**
 * Other test files register some of these at load time without a guard, so
 * this suite registers only what is missing once every file has loaded.
 */
function registerAll(): void {
	registerOnce('claude.focusAgent', registerClaudeCommands);
	registerOnce('claude.openSettings', registerClaudeSettingsEditor);
	registerOnce('claude.openChatInEditor', registerClaudeAgentEditor);
	registerOnce('claude.newSession', registerClaudePaneActions);
	registerOnce('claude.addSelection', registerClaudeContextActions);
	registerOnce('klawly.inlineEdit.start', registerClaudeInlineContributions);
	registerOnce('klawly.review.nextChange', registerClaudeReviewContributions);
	registerOnce('claude.reviewChanges', registerClaudeGitActions);
	registerOnce('claude.fixProblems', registerClaudeDiagnosticsActions);
	registerOnce('claude.preview.addScreenshot', registerClaudePreviewActions);
	registerOnce(CLAUDE_SIGN_IN_COMMAND_ID, registerClaudeSetupCommands);
	registerOnce(CLAUDE_SHOW_STATUS_COMMAND_ID, registerClaudeStatusCommands);
	registerOnce(CLAUDE_IMPORT_FROM_VSCODE_COMMAND_ID, registerClaudeImportCommands);
	registerOnce('klawly.plan.build', registerClaudePlanEditor);
	registerOnce('klawly.review.openEditor', registerClaudeReviewEditor);
	registerOnce(CLAUDE_TERMINAL_PROMPT_COMMAND_ID, registerClaudeTerminalPrompt);
	registerOnce('claude.exportTranscript', registerClaudeChatShareCommands);
	registerOnce(CLAUDE_SWITCH_ACCOUNT_COMMAND_ID, registerClaudeAccountCommands);
	registerOnce(CLAUDE_SHARE_TO_PHONE_COMMAND_ID, registerClaudeShareToPhone);
	registerOnce(CLAUDE_VOICE_TOGGLE_COMMAND_ID, registerClaudeVoice);
}

/**
 * The platform Command Palette provider, fed the Klawly palette commands the
 * way the workbench feeds it (label from the title, alias from the English
 * title), so a test sees the order the palette really shows.
 */
class TestCommandsQuickAccess extends AbstractCommandsQuickAccessProvider {
	constructor(
		private readonly commandPicks: readonly ICommandQuickPick[],
		@IInstantiationService instantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ICommandService commandService: ICommandService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IDialogService dialogService: IDialogService
	) {
		super({ showAlias: true }, instantiationService, keybindingService, commandService, telemetryService, dialogService);
	}

	/** The command IDs the palette lists for `filter`, in order. */
	async rank(filter: string): Promise<string[]> {
		const disposables = new DisposableStore();
		const result = await this._getPicks(filter, disposables, CancellationToken.None);
		disposables.dispose();
		const picks = result === null ? [] : hasKey(result, { picks: true }) ? result.picks : result;
		const list: readonly Pick<ICommandQuickPick>[] = Array.isArray(picks) ? picks : (picks as PicksWithActive<ICommandQuickPick>).items;
		return list.flatMap(pick => pick.type === 'separator' ? [] : [pick.commandId]);
	}

	protected async getCommandPicks(): Promise<ICommandQuickPick[]> {
		return this.commandPicks.map(pick => ({ ...pick }));
	}

	protected hasAdditionalCommandPicks(): boolean {
		return false;
	}

	protected async getAdditionalCommandPicks(): Promise<ICommandQuickPick[]> {
		return [];
	}
}

/**
 * Start Background Agent registers with the Background Agents view, once the
 * Agent view container exists. Returns a function that removes that view again,
 * so the layout tests in other files see only the views they register.
 */
function registerBackground(): () => void {
	const container = registerClaudeViewDescriptors(new SyncDescriptor(ClaudeAgentViewPane));
	const views = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
	const before = views.getViews(container).some(view => view.id === CLAUDE_BACKGROUND_VIEW_ID);
	registerClaudeBackground();
	return () => {
		const added = before ? [] : views.getViews(container).filter(view => view.id === CLAUDE_BACKGROUND_VIEW_ID);
		if (added.length) {
			views.deregisterViews(added, container);
		}
	};
}

function context(values: Record<string, unknown>): IContext {
	return { getValue: <T>(key: string) => values[key] as T };
}

/** Commands bound to `key` whose `when` holds in `values`. */
function boundCommands(key: number, values: Record<string, unknown>): string[] {
	const wanted = decodeKeybinding(key, OS)?.getHashCode();
	return KeybindingsRegistry.getDefaultKeybindings()
		.filter(rule => rule.command && rule.keybinding?.getHashCode() === wanted && (!rule.when || rule.when.evaluate(context(values))))
		.map(rule => rule.command!)
		.filter(command => command.startsWith('claude.') || command.startsWith('klawly.'));
}

suite('Claude commands (spec 45)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let unregisterBackground: () => void = () => undefined;
	let menuItems: IDisposable | undefined;
	suiteSetup(() => {
		registerAll();
		unregisterBackground = registerBackground();
		menuItems = registerClaudeMenuItems();
	});
	suiteTeardown(() => {
		unregisterBackground();
		menuItems?.dispose();
	});

	test('every required command is in the Command Palette with the spec 45 title', () => {
		const palette = new Map(MenuRegistry.getMenuItems(MenuId.CommandPalette).filter(isIMenuItem).map(item => [item.command.id, item.command]));
		const titles = SECTION_45.map(([id]) => {
			const command = palette.get(id);
			const title = command?.title;
			return [id, typeof title === 'string' ? title : title?.value, command?.category && typeof command.category !== 'string' ? command.category.value : command?.category];
		});
		assert.deepStrictEqual(titles, SECTION_45.map(([id, title]) => [id, title, 'Klawly']));
		assert.ok(palette.has('claude.manageModels'));
	});

	test('the Command Palette finds Keep All and Undo All by their other names (issue 706)', () => {
		const palette = new Map(MenuRegistry.getMenuItems(MenuId.CommandPalette).filter(isIMenuItem).map(item => [item.command.id, item.command]));
		// The palette matches a filter against "Category: Title" and the English alias, as the commands quick access does.
		const filter = or(matchesBaseContiguousSubString, matchesWords);
		const finds = (id: string, words: string) => {
			const title = palette.get(id)?.title;
			const original = typeof title === 'string' ? title : title?.original ?? '';
			return !!filter(words, `Klawly: ${original}`);
		};
		assert.deepStrictEqual(
			['accept all', 'approve all', 'keep all', 'reject all', 'discard all', 'undo all'].map(words => [words, finds('claude.acceptAllChanges', words), finds('claude.rejectAllChanges', words)]),
			[['accept all', true, false], ['approve all', true, false], ['keep all', true, false], ['reject all', false, true], ['discard all', false, true], ['undo all', false, true]],
		);
	});

	test('the Command Palette finds each job by the words users type (issue 723)', () => {
		const palette = new Map(MenuRegistry.getMenuItems(MenuId.CommandPalette).filter(isIMenuItem).map(item => [item.command.id, item.command]));
		const filter = or(matchesBaseContiguousSubString, matchesWords);
		const found = (words: string) => [...palette.values()].filter(command => {
			const title = command.title;
			const original = typeof title === 'string' ? title : title?.original ?? '';
			return command.id.startsWith('claude.') && !!filter(words, `Klawly: ${original}`);
		}).map(command => command.id).sort();
		const words = ['permissions', 'yolo', 'bypass', 'auto approve', 'allow everything', 'plan mode', 'usage', 'limits', 'skills', 'mcp', 'hooks', 'new chat', 'old chats', 'resume', 'revert', 'switch model', 'opus', 'login', 'cancel', 'agents window', 'export chat', 'save chat', 'copy chat', 'share chat', 'agent history', 'session history'];
		assert.deepStrictEqual(words.map(w => [w, found(w)]), [
			['permissions', ['claude.changePermissionLevel']],
			['yolo', ['claude.changePermissionLevel']],
			['bypass', ['claude.changePermissionLevel']],
			['auto approve', ['claude.changePermissionLevel']],
			['allow everything', ['claude.changePermissionLevel']],
			['plan mode', ['claude.pickMode']],
			['usage', ['claude.showPlanUsage']],
			['limits', ['claude.showPlanUsage']],
			['skills', ['claude.createSkill', 'claude.openCustomize']],
			['mcp', ['claude.openCustomize']],
			['hooks', ['claude.openCustomize']],
			['new chat', ['claude.newSession']],
			['old chats', ['claude.openSessionHistory']],
			['resume', ['claude.openSessionHistory', 'claude.resumeGoal']],
			['revert', ['claude.restoreCheckpoint']],
			['switch model', ['claude.pickModel']],
			['opus', ['claude.pickModel']],
			['login', ['claude.signIn']],
			['cancel', ['claude.stopAgent']],
			['agents window', ['claude.openAgentsWindow']],
			['export chat', ['claude.exportTranscript']],
			['save chat', ['claude.exportTranscript']],
			['copy chat', ['claude.copyChatMarkdown']],
			['share chat', ['claude.openSharedChat', 'claude.shareChatLink']],
			['agent history', ['claude.openSessionHistory']],
			['session history', ['claude.openSessionHistory']],
		]);
	});

	test('the Command Palette reaches the chat jobs that had no command: goal, loop, edit, rewind, skills, instrumentation (issue 901)', () => {
		const palette = new Map(MenuRegistry.getMenuItems(MenuId.CommandPalette).filter(isIMenuItem).map(item => [item.command.id, item.command]));
		const filter = or(matchesBaseContiguousSubString, matchesWords);
		const found = (words: string) => [...palette.values()].filter(command => {
			const title = command.title;
			const original = typeof title === 'string' ? title : title?.original ?? '';
			return command.id.startsWith('claude.') && !!filter(words, `Klawly: ${original}`);
		}).map(command => command.id).sort();
		const words = ['goal', 'loop', 'edit message', 'rewind', 'create skill', 'remove instrumentation', 'debug lines'];
		assert.deepStrictEqual(words.map(w => [w, found(w)]), [
			['goal', ['claude.editGoal', 'claude.resumeGoal', 'claude.startGoal', 'claude.stopGoal']],
			['loop', ['claude.startLoop']],
			['edit message', ['claude.editMessage']],
			['rewind', ['claude.restoreCheckpoint']],
			['create skill', ['claude.createSkill']],
			['remove instrumentation', ['claude.removeInstrumentation']],
			['debug lines', ['claude.removeInstrumentation']],
		]);
	});

	test('the Command Palette lists the main command first for the word typed (issues 902, 903)', async () => {
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IStorageService, store.add(new InMemoryStorageService()));
		instantiation.stub(IConfigurationService, new TestConfigurationService());
		instantiation.stub(ILogService, new NullLogService());
		instantiation.stub(IKeybindingService, new MockKeybindingService());
		instantiation.stub(ITelemetryService, NullTelemetryService);
		const picks: ICommandQuickPick[] = MenuRegistry.getMenuItems(MenuId.CommandPalette).filter(isIMenuItem)
			.filter(item => item.command.id.startsWith('claude.') || item.command.id.startsWith('klawly.'))
			.map(({ command }) => {
				const title = typeof command.title === 'string' ? { value: command.title, original: command.title } : command.title;
				return { commandId: command.id, label: `Klawly: ${title.value}`, commandAlias: `Klawly: ${title.original}`, commandCategory: 'Klawly' };
			});
		const palette = store.add(instantiation.createInstance(TestCommandsQuickAccess, picks));
		const first = async (words: string) => (await palette.rank(words))[0];
		assert.deepStrictEqual(await Promise.all(['model', 'voice', 'accounts', 'remote control', 'rewind'].map(async words => [words, await first(words)])), [
			['model', 'claude.pickModel'],
			['voice', CLAUDE_VOICE_TOGGLE_COMMAND_ID],
			['accounts', CLAUDE_SWITCH_ACCOUNT_COMMAND_ID],
			['remote control', CLAUDE_SHARE_TO_PHONE_COMMAND_ID],
			['rewind', 'claude.restoreCheckpoint'],
		]);
		assert.deepStrictEqual(
			[matchesCommandAliasTerm(' Model ', { commandAlias: 'Klawly: Pick Model (Model, Switch Model)' }), matchesCommandAliasTerm('model', { commandAlias: 'Klawly: Delete Voice Model' }), matchesCommandAliasTerm('mod', { commandAlias: 'Klawly: Pick Model (Model, Switch Model)' })],
			[true, false, false],
		);
	});

	test('Keep All Changes and Undo All Changes cover every chat, and Undo asks first, listing the files (issue 706)', async () => {
		const instantiation = store.add(new TestInstantiationService());
		const calls: unknown[] = [];
		const answers = [false, true];
		const summary: ReviewPendingSummary = { hunks: 14, files: 2, turns: 4, chats: 3, sessionIds: ['a', 'b', 'c'], uris: [URI.file('/repo/src/auth.ts'), URI.file('/repo/docs/readme.md')] };
		instantiation.stub(IClaudeReviewService, {
			pendingSummary: () => summary,
			keepAllPending: (scope: ReviewScope) => { calls.push(['keep', scope]); return 14; },
			undoAllPending: async (scope: ReviewScope) => { calls.push(['undo', scope]); },
		} as unknown as IClaudeReviewService);
		instantiation.stub(IDialogService, { confirm: async (confirmation: IConfirmation) => { calls.push(['ask', confirmation.primaryButton, confirmation.detail]); return { confirmed: answers.shift() === true }; } } as unknown as IDialogService);
		instantiation.stub(ILabelService, { getUriLabel: (uri: URI) => uri.path.slice('/repo/'.length) } as unknown as ILabelService);
		instantiation.stub(INotificationService, { warn: () => undefined } as unknown as INotificationService);
		await instantiation.invokeFunction(accessor => CommandsRegistry.getCommand('claude.acceptAllChanges')?.handler(accessor));
		await instantiation.invokeFunction(accessor => CommandsRegistry.getCommand('claude.rejectAllChanges')?.handler(accessor));
		await instantiation.invokeFunction(accessor => CommandsRegistry.getCommand('claude.rejectAllChanges')?.handler(accessor));
		assert.deepStrictEqual(calls, [
			['keep', { kind: 'all' }],
			['ask', 'Undo 14 Changes in 2 Files from 3 Chats', 'src/auth.ts\ndocs/readme.md'],
			['ask', 'Undo 14 Changes in 2 Files from 3 Chats', 'src/auth.ts\ndocs/readme.md'],
			['undo', { kind: 'all' }],
		]);
	});

	test('default keys add Alt so core bindings keep working; the preset takes the Klawly Keys', () => {
		const on = {};
		const editor = { ...on, editorTextFocus: true, editorHasSelection: false };
		assert.deepStrictEqual({
			focusDefault: boundCommands(CLAUDE_FOCUS_AGENT_KEY, on),
			ctrlLDefault: boundCommands(CLAUDE_KLAWLY_FOCUS_KEY, editor),
			ctrlIDefault: boundCommands(CLAUDE_KLAWLY_AGENT_KEY, editor),
			ctrlKDefault: boundCommands(KeyMod.CtrlCmd | KeyCode.KeyK, editor),
		}, {
			focusDefault: ['claude.focusAgent'],
			ctrlLDefault: [],
			ctrlIDefault: [],
			ctrlKDefault: [],
		});
		const preset = { [`config.${CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING}`]: true };
		assert.deepStrictEqual({
			ctrlL: boundCommands(CLAUDE_KLAWLY_FOCUS_KEY, { ...preset, ...editor }),
			ctrlLWithSelection: boundCommands(CLAUDE_KLAWLY_FOCUS_KEY, { ...preset, ...editor, editorHasSelection: true }),
			ctrlI: boundCommands(CLAUDE_KLAWLY_AGENT_KEY, { ...preset, ...editor }),
			ctrlK: boundCommands(KeyMod.CtrlCmd | KeyCode.KeyK, { ...preset, ...editor }),
			ctrlSlashInEditor: boundCommands(CLAUDE_KLAWLY_CYCLE_KEY, { ...preset, ...editor }),
			ctrlSlashInAgent: boundCommands(CLAUDE_KLAWLY_CYCLE_KEY, { ...preset, ...on, focusedView: 'claude.agentView' }),
			agentOff: boundCommands(CLAUDE_KLAWLY_FOCUS_KEY, { ...preset, ...editor, 'claude.agentDisabled': true }),
		}, {
			ctrlL: ['claude.focusAgent'],
			ctrlLWithSelection: ['claude.addSelection'],
			ctrlI: ['claude.focusAgent'],
			ctrlK: ['klawly.inlineEdit.start'],
			ctrlSlashInEditor: [],
			ctrlSlashInAgent: ['claude.cycleModel'],
			agentOff: [],
		});
	});

	test('labels show the active key: Ctrl/Cmd+K and Ctrl/Cmd+L while the preset is on, the Alt keys while it is off', () => {
		// Mirrors KeybindingResolver.lookupPrimaryKeybinding: the heaviest rule whose `when` holds, else the heaviest rule.
		const label = (command: string, values: Record<string, unknown>) => {
			const rules = KeybindingsRegistry.getDefaultKeybindings().filter(rule => rule.command === command);
			const rule = rules.findLast(candidate => !candidate.when || candidate.when.evaluate(context(values))) ?? rules.at(-1);
			return rule?.keybinding?.getHashCode();
		};
		const hash = (key: number) => decodeKeybinding(key, OS)?.getHashCode();
		const preset = { [`config.${CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING}`]: true };
		const selection = { editorTextFocus: true, editorHasSelection: true };
		const labels = (values: Record<string, unknown>) => ['klawly.inlineEdit.start', 'claude.addSelection', 'claude.focusAgent', 'claude.cycleModel', 'claude.stopAgent', CLAUDE_TERMINAL_PROMPT_COMMAND_ID].map(command => label(command, values));
		assert.deepStrictEqual({
			presetWithSelection: labels({ ...preset, ...selection }),
			presetPalette: labels(preset),
			offWithSelection: labels(selection),
			offPalette: labels({}),
		}, {
			presetWithSelection: [INLINE_EDIT_KLAWLY_KEY, CLAUDE_KLAWLY_FOCUS_KEY, CLAUDE_FOCUS_AGENT_KEY, CLAUDE_CYCLE_MODEL_KEY, CLAUDE_STOP_AGENT_KEY, INLINE_EDIT_KLAWLY_KEY].map(hash),
			presetPalette: [INLINE_EDIT_KLAWLY_KEY, CLAUDE_KLAWLY_FOCUS_KEY, CLAUDE_FOCUS_AGENT_KEY, CLAUDE_CYCLE_MODEL_KEY, CLAUDE_STOP_AGENT_KEY, INLINE_EDIT_KLAWLY_KEY].map(hash),
			offWithSelection: [INLINE_EDIT_DEFAULT_KEY, CLAUDE_ADD_SELECTION_KEY, CLAUDE_FOCUS_AGENT_KEY, CLAUDE_CYCLE_MODEL_KEY, CLAUDE_STOP_AGENT_KEY, INLINE_EDIT_DEFAULT_KEY].map(hash),
			offPalette: [INLINE_EDIT_DEFAULT_KEY, CLAUDE_ADD_SELECTION_KEY, CLAUDE_FOCUS_AGENT_KEY, CLAUDE_CYCLE_MODEL_KEY, CLAUDE_STOP_AGENT_KEY, INLINE_EDIT_DEFAULT_KEY].map(hash),
		});
	});

	test('the preset Ctrl/Cmd+K beats built-in extension chords in a file editor, and gives them back when off', () => {
		// The git extension's Ctrl/Cmd+K Ctrl/Cmd+Alt+S holds in every file editor, at BuiltinExtension plus its index.
		KeybindingsRegistry.setExtensionKeybindings([{
			id: 'git.stageSelectedRanges',
			keybinding: decodeKeybinding(KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyS), OS),
			weight: KeybindingWeight.BuiltinExtension,
			when: ContextKeyExpr.deserialize('editorTextFocus && resourceScheme == file'),
			isBuiltinExtension: true,
		}]);
		try {
			// Mirrors KeybindingResolver.resolve: the heaviest rule on that first chord whose `when` holds.
			const ctrlK = decodeKeybinding(INLINE_EDIT_KLAWLY_KEY, OS)?.chords[0].getHashCode();
			const firstChord = (values: Record<string, unknown>) => KeybindingsRegistry.getDefaultKeybindings()
				.findLast(rule => rule.keybinding?.chords[0].getHashCode() === ctrlK && (!rule.when || rule.when.evaluate(context(values))))?.command;
			const fileEditor = { editorTextFocus: true, resourceScheme: 'file' };
			assert.deepStrictEqual({
				preset: firstChord({ ...fileEditor, [`config.${CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING}`]: true }),
				off: firstChord(fileEditor),
			}, {
				preset: 'klawly.inlineEdit.start',
				off: 'git.stageSelectedRanges',
			});
		} finally {
			KeybindingsRegistry.setExtensionKeybindings([]);
		}
	});

	test('Stop Agent and Stop Subagent stay in the Command Palette when nothing runs, and say so (issue 1503)', async () => {
		const palette = new Map(MenuRegistry.getMenuItems(MenuId.CommandPalette).filter(isIMenuItem).map(item => [item.command.id, item.when?.serialize()]));
		const preconditions = ['claude.stopAgent', 'claude.stopSubagent'].map(id => [id, MenuRegistry.getCommand(id)?.precondition?.serialize(), palette.has(id)]);
		assert.deepStrictEqual(preconditions, [['claude.stopAgent', '!claude.agentDisabled', true], ['claude.stopSubagent', '!claude.agentDisabled', true]]);
		const instantiation = store.add(new TestInstantiationService());
		const infos: string[] = [];
		instantiation.stub(INotificationService, { info: (message: string) => { infos.push(message); } } as unknown as INotificationService);
		instantiation.stub(IClaudeAgentService, { getCurrentSession: () => undefined } as unknown as IClaudeAgentService);
		instantiation.stub(IQuickInputService, {} as unknown as IQuickInputService);
		await instantiation.invokeFunction(accessor => CommandsRegistry.getCommand('claude.stopAgent')?.handler(accessor));
		await instantiation.invokeFunction(accessor => CommandsRegistry.getCommand('claude.stopSubagent')?.handler(accessor));
		assert.deepStrictEqual(infos, ['No agent is running.', 'No subagent is running.']);
	});

	test('Toggle Autocomplete flips the user setting', async () => {
		const instantiation = store.add(new TestInstantiationService());
		const writes: [string, unknown, ConfigurationTarget | undefined][] = [];
		class RecordingConfiguration extends TestConfigurationService {
			override updateValue(key: string, value: unknown, target?: unknown): Promise<void> {
				writes.push([key, value, target as ConfigurationTarget | undefined]);
				return this.setUserConfiguration(key, value);
			}
		}
		instantiation.stub(IConfigurationService, new RecordingConfiguration());
		instantiation.stub(INotificationService, { status: () => ({ close: () => undefined }) } as unknown as INotificationService);
		await instantiation.invokeFunction(accessor => CommandsRegistry.getCommand('claude.toggleAutocomplete')?.handler(accessor));
		await instantiation.invokeFunction(accessor => CommandsRegistry.getCommand('claude.toggleAutocomplete')?.handler(accessor));
		assert.deepStrictEqual(writes, [
			[CLAUDE_AUTOCOMPLETE_ENABLED_SETTING, false, ConfigurationTarget.USER],
			[CLAUDE_AUTOCOMPLETE_ENABLED_SETTING, true, ConfigurationTarget.USER],
		]);
	});

	test('Open Background Agents shows the agents sidebar filtered to background agents, widening a narrow side bar but not for a chat in an editor tab (issue 334)', async () => {
		const instantiation = store.add(new TestInstantiationService());
		const writes: [string, unknown][] = [];
		class RecordingConfiguration extends TestConfigurationService {
			override updateValue(key: string, value: unknown): Promise<void> {
				writes.push([key, value]);
				return this.setUserConfiguration(key, value);
			}
		}
		const filters: string[] = [];
		const resizes: [Parts, number, number][] = [];
		let short = 120;
		const widget = { showAgents: (filter: string) => { filters.push(filter); return short; } };
		const view = Object.create(ClaudeAgentViewPane.prototype);
		Object.defineProperty(view, 'widget', { value: widget });
		instantiation.stub(IConfigurationService, new RecordingConfiguration());
		instantiation.stub(IViewsService, { openView: async () => view } as unknown as IViewsService);
		const editorPane = Object.create(ClaudeAgentEditor.prototype);
		Object.defineProperty(editorPane, 'widget', { value: widget });
		let chatInEditor = false;
		instantiation.stub(IClaudeAgentService, { onDidChangeSession: Event.None, getCurrentSession: () => undefined } as unknown as IClaudeAgentService);
		instantiation.stub(IClaudeGoalLoopService, { onDidChange: Event.None, getGoal: () => undefined } as unknown as IClaudeGoalLoopService);
		instantiation.stub(IContextKeyService, store.add(new MockContextKeyService()));
		instantiation.stub(IEditorService, {
			onDidActiveEditorChange: Event.None,
			findEditors: () => chatInEditor ? [{ groupId: 1 }] : [],
			openEditor: async (input: EditorInput) => { input.dispose(); return editorPane; },
		} as unknown as IEditorService);
		instantiation.stub(IViewDescriptorService, { getViewLocationById: () => ViewContainerLocation.AuxiliaryBar } as unknown as IViewDescriptorService);
		instantiation.stub(IWorkbenchLayoutService, { resizePart: (part: Parts, width: number, height: number) => { resizes.push([part, width, height]); } } as unknown as IWorkbenchLayoutService);
		await instantiation.invokeFunction(accessor => CommandsRegistry.getCommand(CLAUDE_OPEN_BACKGROUND_AGENTS_COMMAND_ID)?.handler(accessor));
		short = 0;
		await instantiation.invokeFunction(accessor => CommandsRegistry.getCommand(CLAUDE_OPEN_BACKGROUND_AGENTS_COMMAND_ID)?.handler(accessor));
		// The chat in a narrow editor tab: the empty secondary side bar stays as it is.
		short = 120;
		chatInEditor = true;
		await instantiation.invokeFunction(accessor => CommandsRegistry.getCommand(CLAUDE_OPEN_BACKGROUND_AGENTS_COMMAND_ID)?.handler(accessor));
		assert.deepStrictEqual({ writes, filters, resizes }, {
			writes: [[CLAUDE_SESSION_LIST_LOCATION_SETTING, 'side']],
			filters: ['background', 'background', 'background'],
			resizes: [[Parts.AUXILIARYBAR_PART, 120, 0]],
		});
	});

	test('Cycle Model walks enabled models and custom ids only', async () => {
		const instantiation = store.add(new TestInstantiationService());
		const runtime = store.add(new FakeClaudeRuntimeService(new Map()));
		const configuration = new TestConfigurationService({
			[CLAUDE_MODELS_ENABLED_SETTING]: ['fixture-opus'],
			[CLAUDE_MODELS_CUSTOM_SETTING]: ['my-model'],
		});
		const output = { getChannel: () => ({ append: () => undefined }) } as unknown as IOutputService;
		const agent = store.add(new ClaudeAgentService(runtime, output, ...agentWorkspaceStubs({ configuration })));
		instantiation.stub(IConfigurationService, configuration);
		instantiation.stub(IClaudeRuntimeService, runtime);
		instantiation.stub(IClaudeAgentService, agent);
		instantiation.stub(IClaudeGoalLoopService, { onDidChange: Event.None, getGoal: () => undefined } as unknown as IClaudeGoalLoopService);
		instantiation.stub(IContextKeyService, store.add(new MockContextKeyService()));
		instantiation.stub(IClaudeModelSwitchService, store.add(instantiation.createInstance(ClaudeModelSwitchService)));
		instantiation.stub(INotificationService, { status: () => ({ close: () => undefined }), error: (message: string) => assert.fail(message) } as unknown as INotificationService);
		const seen: (string | undefined)[] = [];
		for (let i = 0; i < 3; i++) {
			await instantiation.invokeFunction(accessor => CommandsRegistry.getCommand('claude.cycleModel')?.handler(accessor));
			seen.push(agent.getCurrentSession()?.modelId);
		}
		assert.deepStrictEqual(seen, ['fixture-opus', 'my-model', 'fixture-opus']);
	});

	test('Reference Chat in Composer twice adds the chat once', async () => {
		const instantiation = store.add(new TestInstantiationService());
		const runtime = store.add(new FakeClaudeRuntimeService(new Map()));
		const output = { getChannel: () => ({ append: () => undefined }) } as unknown as IOutputService;
		const agent = store.add(new ClaudeAgentService(runtime, output, ...agentWorkspaceStubs({ configuration: new TestConfigurationService() })));
		const other = agent.createSession();
		const current = agent.createSession();
		instantiation.stub(IClaudeAgentService, agent);
		instantiation.stub(IClaudeGoalLoopService, { onDidChange: Event.None, getGoal: () => undefined } as unknown as IClaudeGoalLoopService);
		instantiation.stub(IContextKeyService, store.add(new MockContextKeyService()));
		instantiation.stub(IViewsService, { openView: async () => undefined } as unknown as IViewsService);
		instantiation.stub(IEditorService, { onDidActiveEditorChange: Event.None, findEditors: () => [] } as unknown as IEditorService);
		instantiation.stub(IQuickInputService, { pick: async <T>(items: readonly T[]) => items[0] } as unknown as IQuickInputService);
		for (let i = 0; i < 2; i++) {
			await instantiation.invokeFunction(accessor => CommandsRegistry.getCommand('claude.referenceChat')?.handler(accessor));
		}
		const chats = agent.getSessions().find(session => session.id === current.id)?.attachments.filter(attachment => attachment.kind === 'chat');
		assert.deepStrictEqual(chats?.map(attachment => attachment.kind === 'chat' ? attachment.sessionId : undefined), [other.id]);
	});

	test('New Agent from the chat editor opens the new chat in the side bar and closes the tab; in the Agents Window it stays there (issue 333)', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(new Map()));
		const output = { getChannel: () => ({ append: () => undefined }) } as unknown as IOutputService;
		const agent = store.add(new ClaudeAgentService(runtime, output, ...agentWorkspaceStubs({ configuration: new TestConfigurationService() })));
		const open = agent.createSession();
		const mainPart = {};
		async function newAgent(chatPart: object | undefined): Promise<string[]> {
			const calls: string[] = [];
			const instantiation = store.add(new TestInstantiationService());
			instantiation.stub(IClaudeAgentService, agent);
			instantiation.stub(IClaudeGoalLoopService, { onDidChange: Event.None, getGoal: () => undefined } as unknown as IClaudeGoalLoopService);
			instantiation.stub(IContextKeyService, store.add(new MockContextKeyService()));
			instantiation.stub(IViewsService, { openView: async (id: string) => { calls.push(`openView ${id}`); return undefined; } } as unknown as IViewsService);
			instantiation.stub(IEditorGroupsService, { mainPart, getPart: () => chatPart } as unknown as IEditorGroupsService);
			instantiation.stub(IEditorService, {
				onDidActiveEditorChange: Event.None,
				findEditors: () => chatPart ? [{ groupId: 1 }] : [],
				closeEditors: async (closed: readonly unknown[]) => { calls.push(`closeEditors ${closed.length}`); return true; },
				openEditor: async (input: EditorInput) => { calls.push(`openEditor ${input.typeId}`); input.dispose(); return undefined; },
			} as unknown as IEditorService);
			await instantiation.invokeFunction(accessor => CommandsRegistry.getCommand('claude.newSession')?.handler(accessor));
			return calls;
		}
		const results = {
			pane: await newAgent(undefined),
			editor: await newAgent(mainPart),
			window: await newAgent({}),
		};
		assert.deepStrictEqual({ results, sessions: agent.getSessions().length, open: agent.getSessions().some(session => session.id === open.id) }, {
			results: {
				pane: ['closeEditors 0', 'openView claude.agentView'],
				editor: ['closeEditors 1', 'openView claude.agentView'],
				window: ['openEditor workbench.input.claudeAgent'],
			},
			sessions: 4,
			open: true,
		});
	});

	test('with claude.agent.enabled off, every agent command, menu entry and key is off', () => {
		const disabled = context({ 'claude.agentDisabled': true });
		const problems: string[] = [];
		for (const id of AGENT_COMMANDS) {
			// A command shown only in a menu (not in the palette) carries its precondition on the menu item.
			const precondition = MenuRegistry.getCommand(id)?.precondition
				?? CLAUDE_MENUS.flatMap(menu => MenuRegistry.getMenuItems(menu)).filter(isIMenuItem).find(item => item.command.id === id)?.command.precondition;
			if (!CommandsRegistry.getCommand(id)) {
				problems.push(`${id}: not registered`);
			} else if (!requiresAgent(precondition) || precondition?.evaluate(disabled)) {
				problems.push(`${id}: precondition ${precondition?.serialize()}`);
			}
			for (const menu of CLAUDE_MENUS) {
				for (const item of MenuRegistry.getMenuItems(menu).filter(isIMenuItem).filter(candidate => candidate.command.id === id)) {
					if (!requiresAgent(item.when) || item.when?.evaluate(disabled)) {
						problems.push(`${id} in ${menu.id}: when ${item.when?.serialize()}`);
					}
				}
			}
			for (const rule of KeybindingsRegistry.getDefaultKeybindings().filter(candidate => candidate.command === id)) {
				if (!requiresAgent(rule.when) || rule.when?.evaluate(disabled)) {
					problems.push(`${id} key: when ${rule.when?.serialize()}`);
				}
			}
		}
		assert.deepStrictEqual(problems, []);
	});

	test('every registered claude and klawly command is gated on the agent, or listed as working without it', () => {
		const ungated = [...CommandsRegistry.getCommands().keys()]
			.filter(id => id.startsWith('claude.') || id.startsWith('klawly.'))
			.filter(id => !WITHOUT_AGENT.has(id) && !AGENT_COMMANDS.includes(id))
			.filter(id => !requiresAgent(MenuRegistry.getCommand(id)?.precondition));
		assert.deepStrictEqual(ungated, []);
	});

	test('with the agent off its keys do nothing, and Ctrl/Cmd+K goes back to the Code - OSS chords', () => {
		const editor = { editorTextFocus: true, editorHasSelection: true, 'claude.agentDisabled': true };
		const preset = { ...editor, [`config.${CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING}`]: true };
		const busy = { ...preset, 'klawly.inlineEdit.reviewing': true, [`config.${CLAUDE_INLINE_REJECT_ON_ESCAPE_SETTING}`]: true, 'claude.agentRunning': true, 'claude.hasPendingChanges': true };
		const keys = (values: Record<string, unknown>) => ({
			inlineEdit: boundCommands(INLINE_EDIT_DEFAULT_KEY, values),
			ctrlK: boundCommands(KeyMod.CtrlCmd | KeyCode.KeyK, values),
			ctrlL: boundCommands(CLAUDE_KLAWLY_FOCUS_KEY, values),
			ctrlI: boundCommands(CLAUDE_KLAWLY_AGENT_KEY, values),
			focus: boundCommands(CLAUDE_FOCUS_AGENT_KEY, values),
			addSelection: boundCommands(CLAUDE_ADD_SELECTION_KEY, values),
			stop: boundCommands(CLAUDE_STOP_AGENT_KEY, values),
			acceptInline: boundCommands(KeyMod.CtrlCmd | KeyCode.Enter, values),
			rejectInline: boundCommands(KeyCode.Escape, values),
			nextHunk: boundCommands(KeyMod.Alt | KeyCode.BracketRight, values),
		});
		assert.deepStrictEqual({ off: keys(busy), on: keys({ ...busy, 'claude.agentDisabled': false }) }, {
			off: { inlineEdit: [], ctrlK: [], ctrlL: [], ctrlI: [], focus: [], addSelection: [], stop: [], acceptInline: [], rejectInline: [], nextHunk: [] },
			on: {
				inlineEdit: ['klawly.inlineEdit.start'],
				ctrlK: ['klawly.inlineEdit.start'],
				ctrlL: ['claude.addSelection'],
				ctrlI: ['claude.focusAgent'],
				focus: ['claude.focusAgent'],
				addSelection: ['claude.addSelection'],
				stop: ['claude.stopAgent'],
				acceptInline: ['klawly.inlineEdit.accept'],
				rejectInline: ['klawly.inlineEdit.reject'],
				nextHunk: ['klawly.inlineEdit.nextHunk'],
			},
		});
	});
});
