/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { escapeIcons } from '../../../../base/common/iconLabels.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { CLAUDE_AUTOCOMPLETE_ENABLED_SETTING, CLAUDE_MODELS_CUSTOM_SETTING, CLAUDE_MODELS_ENABLED_SETTING, readClaudeAutocompleteEnabled } from '../../../../platform/claude/common/claudeConfiguration.js';
import { withChatAttachment } from '../../../../platform/claude/common/claudeChatReference.js';
import { cycleClaudeModel, pickableClaudeModels, readClaudeModelIdList } from '../../../../platform/claude/common/claudeModels.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IListService } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ActiveEditorContext, FocusedViewContext } from '../../../common/contextkeys.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { IClaudeModelSwitchService } from './claudeModelSwitch.js';
import { redactSecrets } from '../../../services/claude/common/claudeAgentLog.js';
import { askClaudeStoppedChanges } from './chat/claudeStoppedChanges.js';
import { IClaudeCheckpointService } from '../../../services/claude/common/claudeCheckpointService.js';
import { IClaudeDelegationService } from '../../../services/claude/common/claudeDelegation.js';
import { CLAUDE_MULTITASK_START_COMMAND_ID } from '../../../services/claude/common/claudeMultitask.js';
import { IClaudeReviewService } from '../../../services/claude/common/claudeReview.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { getMultiSelectedResources, IExplorerService } from '../../files/browser/files.js';
import { claudeChatFind, ClaudeChatFindMatch } from '../common/claudeChatFind.js';
import { claudeChatOutline, ClaudeChatOutlineNode, flattenClaudeChatOutline } from '../common/claudeChatOutline.js';
import { claudeCommandState } from '../common/claudeCommandState.js';
import { CLAUDE_AGENT_ENABLED, CLAUDE_AGENT_RUNNING, CLAUDE_AUTOCOMPLETE_ON, CLAUDE_KLAWLY_KEYMAP, CLAUDE_KLAWLY_KEY_WEIGHT, CLAUDE_DEFAULT_KEY_LABEL_WEIGHT, CLAUDE_DEFAULT_KEY_LABEL_WHEN, CLAUDE_HAS_OTHER_SESSIONS, CLAUDE_HAS_PENDING_CHANGES, CLAUDE_HAS_TURNS } from '../common/claudeContextKeys.js';
import { CLAUDE_ACCEPT_ALL_CHANGES_COMMAND_ID, CLAUDE_ADD_FILE_COMMAND_ID, CLAUDE_ADD_FILE_TO_NEW_AGENT_COMMAND_ID, CLAUDE_ADD_SELECTION_COMMAND_ID, CLAUDE_AGENT_VIEW_ID, CLAUDE_ASK_SIDE_QUESTION_COMMAND_ID, CLAUDE_CREATE_SKILL_COMMAND_ID, CLAUDE_CYCLE_MODEL_COMMAND_ID, CLAUDE_EDIT_MESSAGE_COMMAND_ID, CLAUDE_FIND_IN_CHAT_COMMAND_ID, CLAUDE_FIND_IN_CHAT_LIST_COMMAND_ID, CLAUDE_FOCUS_AGENT_COMMAND_ID, CLAUDE_GO_TO_TURN_COMMAND_ID, CLAUDE_OPEN_BACKGROUND_AGENTS_COMMAND_ID, CLAUDE_OPEN_INSPECTOR_COMMAND_ID, CLAUDE_OPEN_SESSION_HISTORY_COMMAND_ID, CLAUDE_OPEN_SETTINGS_COMMAND_ID, CLAUDE_OPEN_SUBAGENT_COMMAND_ID, CLAUDE_PICK_MODEL_COMMAND_ID, CLAUDE_QUEUE_MESSAGE_COMMAND_ID, CLAUDE_REFERENCE_CHAT_COMMAND_ID, CLAUDE_REJECT_ALL_CHANGES_COMMAND_ID, CLAUDE_REMOVE_INSTRUMENTATION_COMMAND_ID, CLAUDE_RESTORE_CHECKPOINT_COMMAND_ID, CLAUDE_SHOW_SENT_PROMPT_COMMAND_ID, CLAUDE_START_GOAL_COMMAND_ID, CLAUDE_START_LOOP_COMMAND_ID, CLAUDE_STOP_AGENT_COMMAND_ID, CLAUDE_STOP_SUBAGENT_COMMAND_ID, CLAUDE_TOGGLE_AUTOCOMPLETE_COMMAND_ID, CLAUDE_V5_COMMAND_ALIASES, KLAWLY_CATEGORY } from '../common/claudeViews.js';
import { revealClaudeChat } from './chat/claudeAgentEditorActions.js';
import { ClaudeAgentEditorInput, isClaudeChatInEditor } from './chat/claudeAgentEditorInput.js';
import { claudeChatOutlineIcon } from './chat/claudeChatOutline.js';
import { ClaudeChatWidget } from './chat/claudeChatWidget.js';
import { claudeSideQuestionUnavailable } from './chat/claudeSideQuestion.js';
import { showClaudeAgentsSidebar } from './claudeAgentsSidebar.js';
import { findClaudeDebugLines, removeClaudeDebugLines } from './claudeDebugCleanup.js';
import { CLAUDE_EDITOR_FILE_PENDING, claudeUndoAllPending } from './review/claudeKeepAll.js';
import { claudeSubagentKindLabel } from '../common/claudeCommandMirror.js';

const category = KLAWLY_CATEGORY;

/**
 * Default keymap (spec 45). Code - OSS keeps Ctrl/Cmd+L (Expand Line Selection),
 * Ctrl/Cmd+I (Trigger Suggest) and Ctrl/Cmd+K chords, so the defaults add Alt:
 * - Focus Agent: Ctrl/Cmd+Alt+A (Ctrl/Cmd+Alt+L is taken by find and quick chat)
 * - Cycle Model: Ctrl/Cmd+Alt+M; Pick Model: Ctrl/Cmd+Alt+Shift+M
 * - Stop Agent: Ctrl/Cmd+Alt+X while a turn runs
 * - Keep All Changes: Ctrl/Cmd+Alt+Shift+Enter; Undo All Changes: Ctrl/Cmd+Alt+Shift+Backspace, while changes wait
 * The Klawly Keys preset (`claude.keybindings.klawlyKeys`, on by default) adds
 * Ctrl/Cmd+L, Ctrl/Cmd+I, Ctrl/Cmd+K, Ctrl/Cmd+/ in the Agent view, and
 * Ctrl/Cmd+Shift+Backspace.
 */
export const CLAUDE_FOCUS_AGENT_KEY = KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyA;
export const CLAUDE_CYCLE_MODEL_KEY = KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyM;
export const CLAUDE_PICK_MODEL_KEY = KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.KeyM;
export const CLAUDE_STOP_AGENT_KEY = KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyX;
export const CLAUDE_ACCEPT_ALL_KEY = KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.Enter;
export const CLAUDE_REJECT_ALL_KEY = KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.Backspace;
export const CLAUDE_ADD_SELECTION_KEY = KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.KeyL;

/**
 * Default keys weigh more than the preset's Focus, Cycle and Stop keys. When no
 * `when` clause holds (for example while the Command Palette has focus), the
 * palette labels a command with its heaviest key, which then works without the
 * preset. Inline Edit and Add to Agent are the exception: their preset keys weigh
 * more (`CLAUDE_KLAWLY_KEY_WEIGHT`), so labels show Ctrl/Cmd+K and Ctrl/Cmd+L
 * while the preset is on, and a `CLAUDE_DEFAULT_KEY_LABEL_WHEN` rule gives them
 * their Alt keys while it is off.
 */
export const CLAUDE_DEFAULT_KEY_WEIGHT = KeybindingWeight.WorkbenchContrib + 2;

/** Keys the Klawly Keys preset adds. Inline Edit's Ctrl/Cmd+K lives with the inline controller. */
export const CLAUDE_KLAWLY_FOCUS_KEY = KeyMod.CtrlCmd | KeyCode.KeyL;
export const CLAUDE_KLAWLY_AGENT_KEY = KeyMod.CtrlCmd | KeyCode.KeyI;
export const CLAUDE_KLAWLY_CYCLE_KEY = KeyMod.CtrlCmd | KeyCode.Slash;
export const CLAUDE_KLAWLY_STOP_KEY = KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Backspace;

/**
 * The chat has keyboard focus: in the Agent view, or in its editor tab while no
 * view has focus. Ctrl/Cmd+/ keeps Toggle Line Comment everywhere else.
 */
export const AGENT_VIEW_FOCUSED = ContextKeyExpr.or(
	FocusedViewContext.isEqualTo(CLAUDE_AGENT_VIEW_ID),
	ContextKeyExpr.and(ActiveEditorContext.isEqualTo(ClaudeAgentEditorInput.EDITOR_ID), FocusedViewContext.isEqualTo('')),
);

interface ClaudeChatHostServices {
	readonly views: IViewsService;
	readonly editors: IEditorService;
	readonly instantiation: IInstantiationService;
}

/** Services are read before any await: an accessor is only valid until the first one. */
function chatHost(accessor: ServicesAccessor): ClaudeChatHostServices {
	return { views: accessor.get(IViewsService), editors: accessor.get(IEditorService), instantiation: accessor.get(IInstantiationService) };
}

/** Shows the chat where it lives (the Agent view or its editor tab) and returns its widget. */
function agentPane(host: ClaudeChatHostServices, focus: boolean): Promise<ClaudeChatWidget | undefined> {
	return revealClaudeChat(host.views, host.editors, host.instantiation, focus);
}

/** The side bar part that holds views at `location`; the panel and the editor area grow no wider. */
function sideBarPart(location: ViewContainerLocation | null): Parts | undefined {
	switch (location) {
		case ViewContainerLocation.Sidebar: return Parts.SIDEBAR_PART;
		case ViewContainerLocation.AuxiliaryBar: return Parts.AUXILIARYBAR_PART;
		default: return undefined;
	}
}

/**
 * Add File to Agent and Add to New Agent: the files picked in the Explorer or
 * the tabs, else the active editor's file, else whatever the file dialog returns.
 */
async function addFilesToAgent(accessor: ServicesAccessor, resource: unknown, newAgent: boolean): Promise<void> {
	const chat = chatHost(accessor);
	const editors = accessor.get(IEditorService);
	const dialogs = accessor.get(IFileDialogService);
	const workspace = accessor.get(IWorkspaceContextService);
	const agent = accessor.get(IClaudeAgentService);
	let uris: URI[] = URI.isUri(resource)
		? getMultiSelectedResources(resource, accessor.get(IListService), editors, accessor.get(IEditorGroupsService), accessor.get(IExplorerService))
		: [];
	if (uris.length === 0) {
		const active = EditorResourceAccessor.getOriginalUri(editors.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
		if (active && (active.scheme === Schemas.file || active.scheme === Schemas.vscodeRemote)) {
			uris = [active];
		}
	}
	if (uris.length === 0) {
		const picked = await dialogs.showOpenDialog({
			title: newAgent ? localize('claudeAddFileNewPick', "Add File to New Agent") : localize('claudeAddFilePick', "Add File to Agent"),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: true,
			defaultUri: workspace.getWorkspace().folders[0]?.uri,
		});
		uris = picked ?? [];
	}
	if (uris.length === 0) {
		return;
	}
	if (newAgent || !agent.getCurrentSession()) {
		agent.createSession();
	}
	const pane = await agentPane(chat, true);
	await pane?.attachFiles(uris);
}

/** Whether the current chat has any turn; the commands that read a chat say so when it has none (issue 1507). */
function currentChatHasTurns(agent: IClaudeAgentService): boolean {
	const session = agent.getCurrentSession();
	return !!session && agent.getViewState(session.id).turns.length > 0;
}

function noChatNotice(notifications: INotificationService): void {
	notifications.info(localize('claudeNoChatTurns', "This chat has no messages yet."));
}

function report(notifications: INotificationService, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	notifications.error(redactSecrets(message));
}

/** Registers the spec 45 commands that Phase 22 adds, their default keys and the Klawly Keys preset. */
/** What kind of text a find result is in, for the list. */
function findKindLabel(from: ClaudeChatFindMatch['from']): string {
	switch (from) {
		case 'prompt': return localize('claudeFindInChatPrompt', "Prompt");
		case 'reply': return localize('claudeFindInChatReply', "Reply");
		case 'command': return localize('claudeFindInChatCommand', "Command");
		case 'output': return localize('claudeFindInChatOutput', "Tool output");
		case 'edit': return localize('claudeFindInChatEdit', "Edit");
	}
}

export function registerClaudeCommands(): void {
	for (const [v5Id, id] of Object.entries(CLAUDE_V5_COMMAND_ALIASES)) {
		CommandsRegistry.registerCommandAlias(v5Id, id);
	}
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_FOCUS_AGENT_COMMAND_ID,
				title: localize2('claudeFocusAgent', "Focus Agent"),
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				keybinding: [{
					primary: CLAUDE_FOCUS_AGENT_KEY,
					weight: CLAUDE_DEFAULT_KEY_WEIGHT,
					when: CLAUDE_AGENT_ENABLED,
				}, {
					primary: CLAUDE_KLAWLY_FOCUS_KEY,
					weight: KeybindingWeight.WorkbenchContrib + 1,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_KLAWLY_KEYMAP, EditorContextKeys.hasNonEmptySelection.negate()),
				}, {
					primary: CLAUDE_KLAWLY_AGENT_KEY,
					weight: KeybindingWeight.WorkbenchContrib + 1,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_KLAWLY_KEYMAP),
				}],
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const chat = chatHost(accessor);
			const agent = accessor.get(IClaudeAgentService);
			if (!agent.getCurrentSession()) {
				agent.createSession();
			}
			const pane = await agentPane(chat, true);
			pane?.focus();
		}
	});

	KeybindingsRegistry.registerKeybindingRule({
		id: CLAUDE_ADD_SELECTION_COMMAND_ID,
		weight: CLAUDE_DEFAULT_KEY_WEIGHT,
		when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, EditorContextKeys.editorTextFocus, EditorContextKeys.hasNonEmptySelection),
		primary: CLAUDE_ADD_SELECTION_KEY,
	});

	// Klawly Keys: Ctrl/Cmd+L with a selection adds it to the Agent.
	KeybindingsRegistry.registerKeybindingRule({
		id: CLAUDE_ADD_SELECTION_COMMAND_ID,
		weight: CLAUDE_KLAWLY_KEY_WEIGHT,
		when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_KLAWLY_KEYMAP, EditorContextKeys.editorTextFocus, EditorContextKeys.hasNonEmptySelection),
		primary: CLAUDE_KLAWLY_FOCUS_KEY,
	});

	// With the preset off, labels outside the editor show Ctrl/Cmd+Alt+Shift+L, not Ctrl/Cmd+L.
	KeybindingsRegistry.registerKeybindingRule({
		id: CLAUDE_ADD_SELECTION_COMMAND_ID,
		weight: CLAUDE_DEFAULT_KEY_LABEL_WEIGHT,
		when: CLAUDE_DEFAULT_KEY_LABEL_WHEN,
		primary: CLAUDE_ADD_SELECTION_KEY,
	});

	// Klawly Keys: Ctrl/Cmd+/ cycles models while the Agent view has focus.
	KeybindingsRegistry.registerKeybindingRule({
		id: CLAUDE_CYCLE_MODEL_COMMAND_ID,
		weight: KeybindingWeight.WorkbenchContrib + 1,
		when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_KLAWLY_KEYMAP, AGENT_VIEW_FOCUSED),
		primary: CLAUDE_KLAWLY_CYCLE_KEY,
	});

	// Default key for the existing Pick Model command.
	KeybindingsRegistry.registerKeybindingRule({
		id: CLAUDE_PICK_MODEL_COMMAND_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		when: CLAUDE_AGENT_ENABLED,
		primary: CLAUDE_PICK_MODEL_KEY,
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_OPEN_SESSION_HISTORY_COMMAND_ID,
				// One name per job (DL-30, issue 766): the History button's "Agent History"; the older name is an alias.
				title: { ...localize2('claudeOpenSessionHistory', "Open Agent History"), original: 'Open Agent History (Open Session History, Old Chats, Past Chats, Resume Chat)' },
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			(await agentPane(chatHost(accessor), false))?.showHistory();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'claude.showAutoReport',
				title: localize2('claudeShowAutoReport', "Show Auto Report"),
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const editors = accessor.get(IEditorService);
			const report = await accessor.get(IClaudeDelegationService).readAutoReport();
			await editors.openEditor({ resource: undefined, contents: report, languageId: 'markdown', options: { pinned: true } });
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_ADD_FILE_COMMAND_ID,
				title: localize2('claudeAddFile', "Add File to Agent"),
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		run(accessor: ServicesAccessor, resource?: unknown): Promise<void> {
			return addFilesToAgent(accessor, resource, false);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_ADD_FILE_TO_NEW_AGENT_COMMAND_ID,
				title: localize2('claudeAddFileToNewAgent', "Add File to New Agent"),
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		run(accessor: ServicesAccessor, resource?: unknown): Promise<void> {
			return addFilesToAgent(accessor, resource, true);
		}
	});

	// issue 706: Keep All and Undo All cover every chat, background and delegated agent.
	// The English title carries the other names ("accept all", "approve all", "reject all",
	// "discard all") so the Command Palette finds the command by them too.
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_ACCEPT_ALL_CHANGES_COMMAND_ID,
				title: { ...localize2('claudeKeepAllChanges', "Keep All Changes"), original: 'Keep All Changes (Accept All, Approve All)' },
				metadata: { description: localize2('claudeKeepAllChangesDescription', "Keeps every change Claude made that waits for review, in every chat. Also called Accept All or Approve All.") },
				category,
				icon: Codicon.checkAll,
				f1: true,
				// Findable in the palette whenever the agent is on; the keys still need pending changes (issue 1507).
				precondition: CLAUDE_AGENT_ENABLED,
				keybinding: {
					primary: CLAUDE_ACCEPT_ALL_KEY,
					weight: KeybindingWeight.WorkbenchContrib,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_HAS_PENDING_CHANGES),
				},
				menu: { id: MenuId.EditorTitle, group: 'navigation', order: -19, when: CLAUDE_EDITOR_FILE_PENDING },
			});
		}
		run(accessor: ServicesAccessor): void {
			const review = accessor.get(IClaudeReviewService);
			if (review.pendingSummary({ kind: 'all' }).hunks === 0) {
				accessor.get(INotificationService).info(localize('claudeNoChangesToKeep', "No changes are waiting for review."));
				return;
			}
			review.keepAllPending({ kind: 'all' });
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_REJECT_ALL_CHANGES_COMMAND_ID,
				title: { ...localize2('claudeUndoAllChanges', "Undo All Changes"), original: 'Undo All Changes (Reject All, Discard All)' },
				metadata: { description: localize2('claudeUndoAllChangesDescription', "Undoes every change Claude made that waits for review, in every chat, after you confirm. Also called Reject All or Discard All.") },
				category,
				f1: true,
				// Findable in the palette whenever the agent is on; the keys still need pending changes (issue 1507).
				precondition: CLAUDE_AGENT_ENABLED,
				keybinding: {
					primary: CLAUDE_REJECT_ALL_KEY,
					weight: KeybindingWeight.WorkbenchContrib,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_HAS_PENDING_CHANGES),
				},
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const review = accessor.get(IClaudeReviewService);
			const notifications = accessor.get(INotificationService);
			if (review.pendingSummary({ kind: 'all' }).hunks === 0) {
				notifications.info(localize('claudeNoChangesToUndo', "No changes are waiting for review."));
				return;
			}
			await claudeUndoAllPending(review, accessor.get(IDialogService), notifications, accessor.get(ILabelService), { kind: 'all' });
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_RESTORE_CHECKPOINT_COMMAND_ID,
				title: { ...localize2('claudeRestoreCheckpoint', "Restore Checkpoint"), original: 'Restore Checkpoint (Rewind, Revert, Rollback)' },
				category,
				f1: true,
				precondition: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_HAS_TURNS, CLAUDE_AGENT_RUNNING.negate()),
			});
		}
		/** `turnId` comes from Restore Checkpoint on a prompt; without it the user picks the turn. */
		async run(accessor: ServicesAccessor, turnId?: unknown): Promise<void> {
			const agent = accessor.get(IClaudeAgentService);
			const quickInput = accessor.get(IQuickInputService);
			const dialogs = accessor.get(IDialogService);
			const checkpoints = accessor.get(IClaudeCheckpointService);
			const notifications = accessor.get(INotificationService);
			const session = agent.getCurrentSession();
			if (!session) {
				return;
			}
			const turns = agent.getViewState(session.id).turns;
			if (turns.some(turn => turn.status === 'running')) {
				// Files the running turn is writing would be put back underneath it.
				notifications.info(localize('claudeCheckpointWhileRunning', "Stop the agent before restoring a checkpoint."));
				return;
			}
			const items: (IQuickPickItem & { turnId: string; index: number })[] = turns.map((turn, index) => ({
				turnId: turn.id,
				index: index + 1,
				label: localize('claudeCheckpointTurn', "Before turn {0}", index + 1),
				description: turn.user.text.split('\n')[0].slice(0, 120),
			})).reverse();
			if (items.length === 0) {
				return;
			}
			const given = typeof turnId === 'string' ? items.find(item => item.turnId === turnId) : undefined;
			const picked = given ?? await quickInput.pick(items, { placeHolder: localize('claudeCheckpointPick', "Restore files to how they were before a turn") });
			if (!picked) {
				return;
			}
			const answer = await dialogs.confirm({
				type: 'warning',
				message: localize('claudeCheckpointConfirm', "Restore files to how they were before turn {0}?", picked.index),
				detail: localize('claudeCheckpointConfirmDetail', "Files that turn changed go back to how they were before it. The chat history stays."),
				primaryButton: localize('claudeCheckpointRestore', "Restore"),
			});
			if (!answer.confirmed) {
				return;
			}
			try {
				const restored = await checkpoints.restore(session.id, picked.turnId);
				if (restored) {
					notifications.info(localize('claudeCheckpointRestored', "Restored the checkpoint from before turn {0}.", picked.index));
				} else {
					notifications.info(localize('claudeCheckpointNotRestored', "Nothing was restored. The turn has no saved checkpoint, or the restore was cancelled."));
				}
			} catch (error) {
				report(notifications, error);
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_STOP_AGENT_COMMAND_ID,
				title: { ...localize2('claudeStopAgent', "Stop Agent"), original: 'Stop Agent (Cancel, Interrupt)' },
				category,
				f1: true,
				// Findable in the palette whenever the agent is on; the keys still need a running turn (issue 1503).
				precondition: CLAUDE_AGENT_ENABLED,
				keybinding: [{
					primary: CLAUDE_STOP_AGENT_KEY,
					weight: CLAUDE_DEFAULT_KEY_WEIGHT,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_AGENT_RUNNING),
				}, {
					primary: CLAUDE_KLAWLY_STOP_KEY,
					weight: KeybindingWeight.WorkbenchContrib + 1,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_AGENT_RUNNING, CLAUDE_KLAWLY_KEYMAP),
				}],
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const agent = accessor.get(IClaudeAgentService);
			const session = agent.getCurrentSession();
			if (!session || !claudeCommandState(agent.getViewState(session.id).turns, [], []).running) {
				accessor.get(INotificationService).info(localize('claudeNoAgentRunning', "No agent is running."));
				return;
			}
			const checkpoints = accessor.get(IClaudeCheckpointService);
			const dialogs = accessor.get(IDialogService);
			const storage = accessor.get(IStorageService);
			await agent.stopAndTakeBack(session.id, turnId => askClaudeStoppedChanges(session.id, turnId, checkpoints, dialogs, storage));
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_QUEUE_MESSAGE_COMMAND_ID,
				title: localize2('claudeQueueMessage', "Queue Message"),
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const chat = chatHost(accessor);
			const pane = await agentPane(chat, true);
			pane?.queueMessage();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_CYCLE_MODEL_COMMAND_ID,
				title: localize2('claudeCycleModel', "Cycle Model"),
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				keybinding: {
					primary: CLAUDE_CYCLE_MODEL_KEY,
					weight: CLAUDE_DEFAULT_KEY_WEIGHT,
					when: CLAUDE_AGENT_ENABLED,
				},
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const agent = accessor.get(IClaudeAgentService);
			const modelSwitches = accessor.get(IClaudeModelSwitchService);
			const runtime = accessor.get(IClaudeRuntimeService);
			const configuration = accessor.get(IConfigurationService);
			const notifications = accessor.get(INotificationService);
			const session = agent.getCurrentSession() ?? agent.createSession();
			try {
				const models = pickableClaudeModels(
					await runtime.listModels(),
					readClaudeModelIdList(configuration.getValue(CLAUDE_MODELS_ENABLED_SETTING)),
					readClaudeModelIdList(configuration.getValue(CLAUDE_MODELS_CUSTOM_SETTING)),
				);
				const next = cycleClaudeModel(models, session.modelId);
				if (!next) {
					notifications.info(localize('claudeNoModels', "Claude has not reported any models."));
					return;
				}
				await modelSwitches.switchModel(session.id, next.id);
				notifications.status(localize('claudeCycledModel', "Model for the next turn: {0}", next.displayName), { hideAfter: 3000 });
			} catch (error) {
				report(notifications, error);
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_SHOW_SENT_PROMPT_COMMAND_ID,
				title: localize2('claudeShowSentPrompt', "Show Sent Prompt"),
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const chat = chatHost(accessor);
			const agent = accessor.get(IClaudeAgentService);
			const quickInput = accessor.get(IQuickInputService);
			const session = agent.getCurrentSession();
			if (!session) {
				noChatNotice(accessor.get(INotificationService));
				return;
			}
			const turns = agent.getViewState(session.id).turns.map((turn, index) => ({ turn, index: index + 1 })).filter(entry => !!entry.turn.user.sent);
			if (turns.length === 0) {
				accessor.get(INotificationService).info(localize('claudeNoSentPrompt', "This chat has no sent prompt yet."));
				return;
			}
			let turnId = turns[turns.length - 1].turn.id;
			if (turns.length > 1) {
				const items: (IQuickPickItem & { turnId: string })[] = turns.map(entry => ({
					turnId: entry.turn.id,
					label: localize('claudeSentTurn', "Turn {0}", entry.index),
					description: entry.turn.user.text.split('\n')[0].slice(0, 120),
				})).reverse();
				const picked = await quickInput.pick(items, { placeHolder: localize('claudeSentPick', "Show what was sent for a turn") });
				if (!picked) {
					return;
				}
				turnId = picked.turnId;
			}
			const pane = await agentPane(chat, true);
			pane?.revealSentPrompt(turnId);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_ASK_SIDE_QUESTION_COMMAND_ID,
				title: localize2('claudeAskSideQuestion', "Ask a Side Question"),
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const chat = chatHost(accessor);
			const agent = accessor.get(IClaudeAgentService);
			const notifications = accessor.get(INotificationService);
			// A side question forks the chat's Claude Code conversation, so it needs one (issue 433).
			if (!agent.getCurrentSession()?.claudeSessionId) {
				notifications.info(claudeSideQuestionUnavailable());
				return;
			}
			const pane = await agentPane(chat, true);
			if (pane && !pane.askSideQuestion()) {
				notifications.info(claudeSideQuestionUnavailable());
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_MULTITASK_START_COMMAND_ID,
				title: localize2('claudeMultitaskStart', "Run Parallel Agents (Multitask)"),
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				// Issue 686: the words people search for when they want several agents at once.
				metadata: { description: localize2('claudeMultitaskStartDescription', "Starts /multitask in the chat: write one prompt per line and each runs as its own agent at the same time. Also called parallel agents, multi agent or multi-agent, or run several prompts at once. Start a line with ask:, plan: or agent: to give it its own mode.") },
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const chat = chatHost(accessor);
			const pane = await agentPane(chat, true);
			pane?.beginMultitask();
		}
	});

	// Issue 901: jobs that only had a slash command or a hover action get a palette entry (DL-30).
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_START_GOAL_COMMAND_ID,
				title: { ...localize2('claudeStartGoal', "Start Goal"), original: 'Start Goal (Goal, Keep Going Until Done)' },
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				metadata: { description: localize2('claudeStartGoalDescription', "Starts /goal in the chat: Claude keeps working, turn after turn, until the goal you write is met.") },
			});
		}
		async run(accessor: ServicesAccessor, prefill?: string): Promise<void> {
			const pane = await agentPane(chatHost(accessor), true);
			pane?.beginSlashCommand('goal', typeof prefill === 'string' ? prefill : undefined);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_START_LOOP_COMMAND_ID,
				title: { ...localize2('claudeStartLoop', "Start Loop"), original: 'Start Loop (Loop, Repeat Prompt, Run Every)' },
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				metadata: { description: localize2('claudeStartLoopDescription', "Starts /loop in the chat: the prompt you write runs again on a timer.") },
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const pane = await agentPane(chatHost(accessor), true);
			pane?.beginSlashCommand('loop');
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_EDIT_MESSAGE_COMMAND_ID,
				title: { ...localize2('claudeEditMessage', "Edit Last Message"), original: 'Edit Last Message (Edit Message, Edit Prompt)' },
				category,
				f1: true,
				precondition: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_HAS_TURNS, CLAUDE_AGENT_RUNNING.negate()),
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const pane = await agentPane(chatHost(accessor), true);
			pane?.editLastMessage();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_CREATE_SKILL_COMMAND_ID,
				title: { ...localize2('claudeCreateSkill', "Create Skill"), original: 'Create Skill (New Skill, Add Skill)' },
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(ICommandService).executeCommand(CLAUDE_OPEN_SETTINGS_COMMAND_ID, { page: 'customize', form: 'skills' });
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_REMOVE_INSTRUMENTATION_COMMAND_ID,
				title: { ...localize2('claudeRemoveInstrumentation', "Remove Instrumentation"), original: 'Remove Instrumentation (Debug Lines, Remove Debug Logs, Clean Up Debug)' },
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const agent = accessor.get(IClaudeAgentService);
			const files = accessor.get(IFileService);
			const textFiles = accessor.get(ITextFileService);
			const notifications = accessor.get(INotificationService);
			const session = agent.getCurrentSession();
			if (!session) {
				noChatNotice(notifications);
				return;
			}
			// Every file this chat changed, not only the last turn's: the marks can be turns old.
			const changed = [...new Set(agent.getViewState(session.id).turns.flatMap(turn => turn.changedFiles))];
			const found = await findClaudeDebugLines(files, textFiles, changed);
			if (found.length === 0) {
				notifications.info(localize('claudeRemoveInstrumentationNone', "No lines marked by Debug mode in the files this chat changed."));
				return;
			}
			await removeClaudeDebugLines(textFiles, found.map(file => file.uri));
			notifications.info(localize('claudeRemoveInstrumentationDone', "Removed {0} marked lines from {1} files.", found.reduce((sum, file) => sum + file.lines, 0), found.length));
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_GO_TO_TURN_COMMAND_ID,
				title: localize2('claudeGoToTurn', "Go to Turn..."),
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const chat = chatHost(accessor);
			const agent = accessor.get(IClaudeAgentService);
			const quickInput = accessor.get(IQuickInputService);
			const session = agent.getCurrentSession();
			if (!session || !currentChatHasTurns(agent)) {
				noChatNotice(accessor.get(INotificationService));
				return;
			}
			const items: (IQuickPickItem & { node: ClaudeChatOutlineNode })[] = flattenClaudeChatOutline(claudeChatOutline(agent.getViewState(session.id))).map(({ node, depth }) => ({
				node,
				label: `${'\u2003'.repeat(depth)}$(${claudeChatOutlineIcon(node.kind).id}) ${escapeIcons(node.label)}`,
				description: node.description,
			}));
			if (items.length === 0) {
				return;
			}
			const picked = await quickInput.pick(items, { placeHolder: localize('claudeGoToTurnPick', "Go to a prompt, plan, to-do update, edit or subagent"), matchOnDescription: true });
			if (!picked) {
				return;
			}
			const pane = await agentPane(chat, true);
			pane?.revealTurn(picked.node.turnId, picked.node.targetId);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_FIND_IN_CHAT_COMMAND_ID,
				title: localize2('claudeFindInChat', "Find in Chat"),
				category,
				f1: true,
				// Findable in the palette whenever the agent is on; the key still needs a chat with turns (issue 1507).
				precondition: CLAUDE_AGENT_ENABLED,
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyCode.KeyF,
					weight: KeybindingWeight.WorkbenchContrib + 1,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_HAS_TURNS, ContextKeyExpr.or(ContextKeyExpr.equals('focusedView', CLAUDE_AGENT_VIEW_ID), ContextKeyExpr.equals('activeEditor', 'workbench.editor.claudeAgent'))),
				},
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			if (!currentChatHasTurns(accessor.get(IClaudeAgentService))) {
				noChatNotice(accessor.get(INotificationService));
				return;
			}
			const pane = await agentPane(chatHost(accessor), true);
			pane?.findInChat();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_FIND_IN_CHAT_LIST_COMMAND_ID,
				title: localize2('claudeFindInChatList', "Find in Chat as List..."),
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const chat = chatHost(accessor);
			const agent = accessor.get(IClaudeAgentService);
			const quickInput = accessor.get(IQuickInputService);
			const session = agent.getCurrentSession();
			if (!session || !currentChatHasTurns(agent)) {
				noChatNotice(accessor.get(INotificationService));
				return;
			}
			const state = agent.getViewState(session.id);
			const picker = quickInput.createQuickPick<IQuickPickItem & { turnId: string; targetId?: string }>();
			picker.placeholder = localize('claudeFindInChatPlaceholder', "Find text in this chat's prompts, replies, tool output and edits");
			picker.matchOnDescription = false;
			picker.sortByLabel = false;
			picker.canSelectMany = false;
			const disposables = new DisposableStore();
			disposables.add(picker);
			disposables.add(picker.onDidChangeValue(value => {
				picker.items = claudeChatFind(state, value).map(match => ({
					turnId: match.turnId,
					targetId: match.targetId,
					label: match.snippet,
					description: findKindLabel(match.from),
					alwaysShow: true,
				}));
			}));
			const picked = await new Promise<(IQuickPickItem & { turnId: string; targetId?: string }) | undefined>(resolve => {
				disposables.add(picker.onDidAccept(() => resolve(picker.selectedItems[0])));
				disposables.add(picker.onDidHide(() => resolve(undefined)));
				picker.show();
			});
			disposables.dispose();
			if (!picked) {
				return;
			}
			const pane = await agentPane(chat, true);
			pane?.revealTurn(picked.turnId, picked.targetId);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_OPEN_INSPECTOR_COMMAND_ID,
				title: localize2('claudeOpenInspector', "Open Session Inspector"),
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const chat = chatHost(accessor);
			const pane = await agentPane(chat, true);
			pane?.openInspector();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_OPEN_SUBAGENT_COMMAND_ID,
				title: localize2('claudeOpenSubagentChat', "Open Subagent Chat"),
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const chat = chatHost(accessor);
			const agent = accessor.get(IClaudeAgentService);
			const quickInput = accessor.get(IQuickInputService);
			const session = agent.getCurrentSession();
			if (!session || agent.getViewState(session.id).subagents.length === 0) {
				accessor.get(INotificationService).info(localize('claudeNoSubagentToOpen', "This chat has no subagents."));
				return;
			}
			const runId = await pickSubagent(agent, quickInput, false);
			if (runId) {
				const pane = await agentPane(chat, true);
				pane?.showSubagent(runId);
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_STOP_SUBAGENT_COMMAND_ID,
				title: localize2('claudeStopSubagentCommand', "Stop Subagent"),
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const notifications = accessor.get(INotificationService);
			const quickInput = accessor.get(IQuickInputService);
			const agent = accessor.get(IClaudeAgentService);
			const session = agent.getCurrentSession();
			if (!session || !claudeCommandState([], agent.getViewState(session.id).subagents, []).hasRunningSubagent) {
				notifications.info(localize('claudeNoSubagentRunning', "No subagent is running."));
				return;
			}
			const runId = await pickSubagent(agent, quickInput, true);
			if (!runId) {
				return;
			}
			try {
				await agent.stopSubagent(session.id, runId);
			} catch (error) {
				report(notifications, error);
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_REFERENCE_CHAT_COMMAND_ID,
				title: localize2('claudeReferenceChat', "Reference Chat in Composer"),
				category,
				f1: true,
				precondition: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_HAS_OTHER_SESSIONS),
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const chat = chatHost(accessor);
			const agent = accessor.get(IClaudeAgentService);
			const quickInput = accessor.get(IQuickInputService);
			const session = agent.getCurrentSession() ?? agent.createSession();
			const mentions = agent.listChatMentions('').filter(mention => mention.id !== session.id);
			if (mentions.length === 0) {
				return;
			}
			const picked = await quickInput.pick(mentions.map(mention => ({ id: mention.id, label: mention.title, detail: mention.detail.trim() })), {
				placeHolder: localize('claudeReferencePick', "Pick a chat to add to the composer as context"),
				matchOnDetail: true,
			});
			const mention = mentions.find(candidate => candidate.id === picked?.id);
			const current = agent.getSessions().find(candidate => candidate.id === session.id);
			if (!mention || !current) {
				return;
			}
			agent.setAttachments(current.id, withChatAttachment(current.attachments, mention.attachment));
			await agentPane(chat, true);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_OPEN_BACKGROUND_AGENTS_COMMAND_ID,
				title: localize2('claudeOpenBackgroundAgents', "Open Background Agents"),
				category,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const host = chatHost(accessor);
			const configuration = accessor.get(IConfigurationService);
			const viewDescriptors = accessor.get(IViewDescriptorService);
			const layout = accessor.get(IWorkbenchLayoutService);
			// The agents sidebar beside the chat, filtered to background agents (issue 334).
			await showClaudeAgentsSidebar(configuration);
			const short = (await agentPane(host, true))?.showAgents('background') ?? 0;
			// The chat in an editor tab is not in the Agent view's side bar: widening that bar would only narrow the editor.
			const part = short && !isClaudeChatInEditor(host.editors) ? sideBarPart(viewDescriptors.getViewLocationById(CLAUDE_AGENT_VIEW_ID)) : undefined;
			if (part) {
				// A narrow side bar widens until the sidebar fits beside the chat.
				layout.resizePart(part, short, 0);
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_TOGGLE_AUTOCOMPLETE_COMMAND_ID,
				title: localize2('claudeToggleAutocomplete', "Toggle Autocomplete"),
				category,
				f1: true,
				toggled: CLAUDE_AUTOCOMPLETE_ON,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const configuration = accessor.get(IConfigurationService);
			const notifications = accessor.get(INotificationService);
			const enabled = readClaudeAutocompleteEnabled(configuration.getValue(CLAUDE_AUTOCOMPLETE_ENABLED_SETTING));
			await configuration.updateValue(CLAUDE_AUTOCOMPLETE_ENABLED_SETTING, !enabled, ConfigurationTarget.USER);
			notifications.status(enabled
				? localize('claudeAutocompleteOff', "AI autocomplete is off.")
				: localize('claudeAutocompleteOn', "AI autocomplete is on."), { hideAfter: 3000 });
		}
	});
}

async function pickSubagent(agent: IClaudeAgentService, quickInput: IQuickInputService, runningOnly: boolean): Promise<string | undefined> {
	const session = agent.getCurrentSession();
	if (!session) {
		return undefined;
	}
	const subagents = agent.getViewState(session.id).subagents
		.filter(subagent => !runningOnly || subagent.run.state === 'running')
		.slice()
		.sort((left, right) => Number(right.run.state === 'running') - Number(left.run.state === 'running'));
	if (subagents.length === 0) {
		return undefined;
	}
	if (subagents.length === 1) {
		return subagents[0].run.id;
	}
	const picked = await quickInput.pick(subagents.map(subagent => ({
		id: subagent.run.id,
		label: claudeSubagentKindLabel(subagent.run.agentType),
		description: subagentStateLabel(subagent.run.state),
		detail: subagent.run.description,
	})), {
		placeHolder: runningOnly
			? localize('claudeStopSubagentPick', "Pick the subagent to stop")
			: localize('claudeOpenSubagentPick', "Pick a subagent to open"),
		matchOnDetail: true,
	});
	return picked?.id;
}

function subagentStateLabel(state: string): string {
	switch (state) {
		case 'running': return localize('claudeSubagentRunning', "Running");
		case 'success': return localize('claudeSubagentDone', "Finished");
		case 'failed': return localize('claudeSubagentFailed', "Failed");
		case 'stopped': return localize('claudeSubagentStopped', "Stopped");
		default: return state;
	}
}
