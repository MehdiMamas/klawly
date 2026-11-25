/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename, extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { CLAUDE_CHAT_REFERENCE_SUMMARY_DEFAULT, ChatReferenceInput, forkSessionSeed } from '../../../../platform/claude/common/claudeChatReference.js';
import { ClaudeLimitPolicy } from '../../../../platform/claude/common/claudeLimitPolicy.js';
import { rankContextCandidate, SentPromptRecord, sentChips, sentImages } from '../../../../platform/claude/common/claudePrompt.js';
import { ClaudeAutoModelPick, ClaudeAutoModelClassification, CLAUDE_MODELS_AUTO_SETTING, estimateClaudeAutoComplexity, pickClaudeAutoModel, readClaudeAutoOn } from '../../../../platform/claude/common/claudeAutoModel.js';
import { ChatReferenceFileSpec, JsonlSessionStore } from '../../../../platform/claude/common/claudeSessionStore.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IdeAgentSession, SessionIndexRecord } from '../../../../platform/claude/common/claudeStorage.js';
import { ActionResolution } from '../../../../platform/claude/common/claudeActions.js';
import { ClaudeCommandInfo, claudeCommandsFromNames, ClaudeSubagentInfo } from '../../../../platform/claude/common/claudeCommands.js';
import { AgentMode, ContextAttachment, PendingInput } from '../../../../platform/claude/common/claudeContext.js';
import { buildPlanPrompt, PlanArtifact } from '../../../../platform/claude/common/claudePlan.js';
import { acceptEditedPlan, isPlanEdited, planToMarkdown } from '../../../../platform/claude/common/claudePlanEdit.js';
import { ClaudeModelInfo, ClaudeRunHandle, ClaudeRuntimeState, IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { ClaudeWorkerProfile } from '../../../../platform/claude/common/claudeWorkerProfile.js';
import { isClaudeResumeRejection } from '../../../../platform/claude/common/claudeResume.js';
import { CLAUDE_TEST_SESSION_FIXTURE } from '../../../../platform/claude/common/claudeTestSession.js';
import { ClaudeFastModeStatus } from '../../../../platform/claude/common/claudeFastMode.js';
import { NormalizedClaudeEvent } from '../../../../platform/claude/common/claudeProtocol.js';
import { ClaudeExecutionTarget, ClaudeExecutionTargetInfo, claudeExecutionTargetInfo, readClaudeExecutionTarget } from '../../../../platform/claude/common/claudeExecutionTarget.js';
import { ClaudeSessionPermissions, effectiveClaudePermissionLevel, NO_SESSION_PERMISSIONS, withClaudePermissionLevel } from '../../../../platform/claude/common/claudeSessionPermissions.js';
import { claudeUnaskedDisabledBy, claudeUnaskedDisabledByManagedFiles } from '../../../../platform/claude/common/claudeUnaskedPolicy.js';
import { CLAUDE_DELEGATION_LADDER_DEFAULTS, CLAUDE_DELEGATION_SESSION_FAILED_CALLS_SETTING, CLAUDE_DELEGATION_SESSION_STEPS_SETTING, ClaudeEscalation, countTrailingFailedCalls, formatEscalationLogLine, readClaudeDelegationLadderThreshold, sessionFallbackCause } from '../../../../platform/claude/common/claudeDelegateLadder.js';
import { CLAUDE_MANAGED_SETTINGS_SETTING, readClaudeSecuritySettings } from '../../../../platform/claude/common/claudeSecuritySettings.js';
import { OS } from '../../../../base/common/platform.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { CLAUDE_AGENT_ALLOW_EVERYTHING_CONFIRM_SETTING, CLAUDE_AGENT_DEFAULT_MODE_SETTING, CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, ClaudePermissionPreset, CLAUDE_AGENT_ENABLED_SETTING, CLAUDE_AGENT_NEW_CHATS_FIRST_SETTING, CLAUDE_CONFIGURABLE_EFFORT_LEVELS, CLAUDE_INLINE_EDIT_MODEL_SETTING, CLAUDE_MODELS_CUSTOM_SETTING, CLAUDE_MODELS_DEFAULT_SETTING, CLAUDE_MODELS_EFFORT_SETTING, CLAUDE_MODELS_ENABLED_SETTING, CLAUDE_MODELS_FAST_MODE_SETTING, CLAUDE_MODELS_ULTRACODE_SETTING, readClaudeAgentEnabled, readClaudeAllowEverythingConfirm, readClaudeConfiguredSessionSettings, readClaudeDefaultMode, readClaudeModelId, readClaudePermissionPreset } from '../../../../platform/claude/common/claudeConfiguration.js';
import { ClaudeEffortLevel, claudeSettingsProblem, ClaudeSessionSettings, DEFAULT_CLAUDE_SESSION_SETTINGS, fitClaudeSessionSettings, readClaudeSessionSettings, sameClaudeSessionSettings } from '../../../../platform/claude/common/claudeSessionSettings.js';
import { claudeModelDisplayName, isKnownClaudeModel, pickableClaudeModels, readClaudeModelIdList } from '../../../../platform/claude/common/claudeModels.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { Schemas } from '../../../../base/common/network.js';
import { IOutputService } from '../../output/common/output.js';
import { AgentReducerEvent, AgentViewState, EMPTY_AGENT_VIEW_STATE, hasLiveChildren, hasPendingElicitation, reduceAgentState, turnParts } from './claudeAgentState.js';
import { continueSummaryFor, eventsThroughTurn, exportTranscript, replayDurableEvents } from './claudeTranscript.js';
import { ClaudeChatSearchHit, ClaudeChatSearchIndex } from './claudeChatSearch.js';
import { CLAUDE_AGENT_OUTPUT_CHANNEL_ID, CLAUDE_COMMAND_LOG_CHANNEL_ID, formatClaudeAgentEvent, formatClaudeAgentFailure, formatClaudeRuntimeState, redactSecrets } from './claudeAgentLog.js';
import { outputText, unstreamedCommandOutput } from './claudeToolCards.js';
import { IClaudeCheckpointService } from './claudeCheckpointService.js';
import { claudeRewindCheck, claudeRewindNote, claudeRewindTurnIds, claudeTurnHasNoOutput } from './claudeRewind.js';
import { readClaudeLastPick, storeClaudeLastPick } from './claudeLastPick.js';
import { ClaudeAgentDelegateHandler, claudeAutoRoute, ClaudeDelegateCard, claudeDelegateNote, claudeDelegateTask } from './claudeDelegationModel.js';
import { ClaudeDelegateToolResult } from '../../../../platform/claude/common/claudeDelegate.js';

export const CLAUDE_EVENT_LOG_CAP = 2000;
export const CLAUDE_RAW_LOG_CAP = 200;

export function appendCapped<T>(list: T[], item: T, cap: number): void {
	list.push(item);
	if (list.length > cap) {
		list.splice(0, list.length - cap);
	}
}

function stampTimes(event: AgentReducerEvent, now: number): AgentReducerEvent {
	switch (event.type) {
		case 'turn.submitted':
			return event.startedAt === undefined ? { ...event, startedAt: now } : event;
		case 'session.completed':
		case 'session.failed':
		case 'turn.stopped':
		case 'turn.failed':
		case 'subagent.finished':
			return event.endedAt === undefined ? { ...event, endedAt: now } : event;
		default:
			return event;
	}
}

export const IClaudeAgentService = createDecorator<IClaudeAgentService>('claudeAgentService');

export interface ClaudeAgentSession {
	readonly id: string;
	readonly title: string;
	readonly mode: AgentMode;
	/** Model id stored for the next turn. Absent until the user picks one. */
	readonly modelId?: string;
	readonly modelName?: string;
	readonly draft: string;
	readonly attachments: readonly ContextAttachment[];
	readonly additionalDirectories: readonly string[];
	readonly slashCommands: readonly string[];
	readonly skills: readonly string[];
	/** The `/` menu's commands with their sources: names from `session.started`, then Claude Code's full listing. */
	readonly commands: readonly ClaudeCommandInfo[];
	/** Subagents the session can call with `@agent-<name>`. */
	readonly agents: readonly ClaudeSubagentInfo[];
	readonly claudeSessionId?: string;
	readonly workspaceName?: string;
	readonly worktreePath?: string;
	/** Where the next turn runs Claude Code, from the Run in picker (issue 425). Absent runs it locally. */
	readonly executionTarget?: ClaudeExecutionTarget;
	/** Where Claude Code runs, as the last `session.started` reported it. */
	readonly targetInfo?: ClaudeExecutionTargetInfo;
	/** A crash left tools unfinished. Opening the session does not rerun them. */
	readonly interrupted?: boolean;
	/** Claude refused the stored resume id. The transcript is still here. */
	readonly resumeFailed?: boolean;
	readonly updatedAt?: number;
	/** Listed first in history. */
	readonly pinned?: boolean;
	/** Kept out of the history lists until it is unarchived or opened again. */
	readonly archived?: boolean;
	/** A command or skill pinned to the chat, which every message runs (issue 488). The name, without the slash. */
	readonly pinnedCommand?: string;
	/** A read-only delegated chat: the id of the chat that delegated to it (issue 693). */
	readonly delegatedFrom?: string;
}

/** Auto model's state in one session (issue 521). */
export interface ClaudeAutoModelState {
	/** What Auto picked for the session's newest turn. */
	readonly last?: ClaudeAutoModelPick;
}

export interface ClaudeSubmitOptions {
	/** Compiled prompt. When set, this is what the runtime receives instead of `text`. */
	readonly compiled?: string;
	readonly resolution?: ActionResolution;
	/** Shown on the user turn instead of the raw composer text. */
	readonly label?: string;
	/** Keeps the composer draft and chips. Build uses this because it does not send what is typed. */
	readonly keepDraft?: boolean;
	/** Chips held with a queued or steered message. */
	readonly attachments?: readonly ContextAttachment[];
	/**
	 * Editor text snapshotted before the turn starts, including a clean buffer.
	 * Listed ahead of other dirty buffers so this text is the one the checkpoint keeps.
	 */
	readonly checkpointBuffers?: readonly { readonly path: string; readonly text: string }[];
	/**
	 * Model for this turn only, such as `claude.inlineEdit.model`. The session's
	 * own model applies again on the next turn.
	 */
	readonly modelId?: string;
	/**
	 * Inline edit shows its own diff, so Open After Agent Edit leaves the turn
	 * alone. Its turn uses `claude.inlineEdit.model` unless `modelId` is set.
	 */
	readonly origin?: 'inline-edit';
}

/** The runtime refused a model. The turn went on with `fallback`, or the model the query already had when it is absent. */
export interface ClaudeModelRejection {
	readonly sessionId: string;
	readonly modelId: string;
	readonly fallback?: string;
	readonly message: string;
}

export type ClaudeAgentSessionChangeReason = 'created' | 'selected' | 'closed' | 'model' | 'settings' | 'context' | 'mode' | 'permissions' | 'history' | 'target' | 'plugins' | 'restored' | 'reordered';

export interface ClaudeAgentSessionChange {
	readonly reason: ClaudeAgentSessionChangeReason;
	readonly session: ClaudeAgentSession | undefined;
	readonly sessions: readonly ClaudeAgentSession[];
}

/**
 * Workbench-facing Claude session entry. The pane keeps the current session,
 * the model chosen for the next turn, and the timeline reduced from events.
 * Durable history is optional until `attachDurableHistory` runs.
 */
export interface IClaudeAgentService {
	readonly _serviceBrand: undefined;
	readonly onDidReceiveEvent: Event<NormalizedClaudeEvent>;
	readonly onDidChangeSession: Event<ClaudeAgentSessionChange>;
	/**
	 * `plugins` are absolute plugin folders every query of this session loads without installing them (Try in a New Session).
	 * `draft` is the composer's text when the chat opens (Customize's Create with Claude, issue 500).
	 */
	createSession(options?: { readonly plugins?: readonly string[]; readonly draft?: string }): ClaudeAgentSession;
	/**
	 * Delegation (issue 693): opens a read-only delegated chat under `parentId`
	 * without making it current. It takes the parent's mode, permissions,
	 * plugins, folders and where it runs; Auto is off and it runs on `modelId`.
	 * Optional so test doubles need not delegate.
	 */
	createDelegatedSession?(parentId: string, options: { readonly modelId?: string; readonly modelName?: string; readonly effort?: ClaudeEffortLevel; readonly title: string; readonly profile?: ClaudeWorkerProfile }): ClaudeAgentSession;
	/** Registers who runs delegated chats. Without one, Auto runs each turn on its pick as before. */
	setDelegateHandler?(handler: ClaudeAgentDelegateHandler): IDisposable;
	/** Shows a delegated chat's card, or its new state, in the parent chat's turn. */
	noteDelegation?(sessionId: string, card: ClaudeDelegateCard): void;
	/**
	 * Later submit, retry, queue, and build-plan calls for this session use
	 * `cwd` even when the caller passes the main workspace.
	 */
	pinWorkingDirectory(sessionId: string, cwd: string): void;
	/**
	 * Spend cap in US dollars for each query this session opens from now on
	 * (`maxBudgetUsd`, issue 424). Claude Code stops a query that reaches it with
	 * a failed turn. `undefined` removes the cap. Background runs set it.
	 */
	setSessionBudget(sessionId: string, maxBudgetUsd: number | undefined): void;
	/**
	 * Turn cap for each query this session opens from now on (`maxTurns`,
	 * issue 426). `undefined` goes back to no cap. Automation runs set it.
	 */
	setSessionMaxTurns(sessionId: string, maxTurns: number | undefined): void;
	/** The open tabs. */
	getSessions(): readonly ClaudeAgentSession[];
	/**
	 * Every session in history: the open tabs, then the closed ones from durable
	 * history. Opening a closed one with `resume` brings it back as a tab.
	 */
	getHistory(): readonly ClaudeAgentSession[];
	getCurrentSession(): ClaudeAgentSession | undefined;
	selectSession(sessionId: string): void;
	closeSession(sessionId: string): void;
	/**
	 * Moves a tab so it sits before `beforeSessionId`, or at the end when that is
	 * undefined. The new order is remembered for this workspace (issue 964).
	 */
	moveSession(sessionId: string, beforeSessionId: string | undefined): void;
	setDraft(sessionId: string, text: string): void;
	/**
	 * Stores a model the runtime reported, or an id from `claude.models.custom`.
	 * The next turn reads it: a live query gets the runtime `setModel`, a new
	 * query starts with it.
	 */
	setNextModel(sessionId: string, modelId: string): Promise<void>;
	/**
	 * Effort, fast mode, Ultracode and thinking for the session's next turn
	 * (Phase 33). Until the user picks any, they come from `claude.models.effort`,
	 * `claude.models.fastMode` and `claude.models.ultracode`, fitted to the model.
	 */
	getSessionSettings(sessionId: string): ClaudeSessionSettings;
	/** Fast mode's real state for the session as Claude Code last reported it, or undefined before it did (issue 456). */
	getFastModeStatus(sessionId: string): ClaudeFastModeStatus | undefined;
	/** Fires once when fast mode drops from running to cooling down or unavailable, never for a repeat (issue 456). */
	readonly onDidDropFastMode: Event<{ readonly sessionId: string; readonly previous: ClaudeFastModeStatus; readonly status: ClaudeFastModeStatus }>;
	/**
	 * Stores settings for the next turn: a live query changes without a restart,
	 * a new query starts with them. Rejects what the session's model does not
	 * take, such as Ultracode on a model without extra high effort. A model the
	 * runtime did not report is not checked here; the runtime refuses it.
	 */
	setNextSettings(sessionId: string, settings: ClaudeSessionSettings): Promise<void>;
	/**
	 * Auto model (issue 521): whether the session's turns pick their effort
	 * with, and the last pick. Undefined while the user picks the model. A new
	 * session starts from `claude.models.auto`.
	 */
	getAutoModel(sessionId: string): ClaudeAutoModelState | undefined;
	/**
	 * Turns Auto on or off. Picking a model with `setNextModel`
	 * turns it off too: an explicit pick always wins. A running turn keeps the
	 * model it started on.
	 */
	setAutoModel(sessionId: string, on: boolean, remember?: boolean): void;
	/**
	 * Sets the mode for the next turn. The user's choice is the only thing that
	 * changes it. Throws while a turn is running because the permission bridge
	 * applies the mode to the turn in flight.
	 */
	setMode(sessionId: string, mode: AgentMode): void;
	/**
	 * Sets where the session's Claude Code runs (issue 425). Only before Claude
	 * Code has a conversation for it: a started session stays where it began.
	 */
	setExecutionTarget(sessionId: string, target: ClaudeExecutionTarget | undefined): void;
	/**
	 * Allow All Commands and Allow Everything for a pane session (Phase 27). The
	 * session's own switches start off, last as long as the session, and are never
	 * written to disk; the permission level setting adds Allow Everything to every
	 * session (issue 453).
	 */
	getSessionPermissions(sessionId: string): ClaudeSessionPermissions;
	/**
	 * True when the organization turned off running Claude Code without asking
	 * (issue 694), so the Allow Everything level works as Ask Before Edits.
	 * Optional so test doubles stay small.
	 */
	isUnaskedBlocked?(): boolean;
	/**
	 * Replaces the switches and passes them to the running runtime session, or
	 * to the next one. Throws when a switch would turn on in an untrusted
	 * workspace. Confirmation is the caller's job (`IClaudePermissionService`).
	 */
	setSessionPermissions(sessionId: string, permissions: ClaudeSessionPermissions): void;
	/**
	 * Build for a finished Plan-mode turn: switches the session to Agent and sends
	 * the accepted plan plus `notes` as a new turn. `compile` wraps the Build text
	 * with IDE context; without it the Build text is sent as is. `edited` is the
	 * plan after the user renamed or reordered steps on the card; it may not add
	 * or drop steps, and Build is refused when it does.
	 */
	buildPlan(sessionId: string, turnId: string, notes: string, cwd: string, compile?: (buildText: string) => Promise<string>, edited?: PlanArtifact): Promise<void>;
	/**
	 * Open Plan on a plan card: writes the plan of `turnId` as Markdown to
	 * `target`, a file in the workspace's plans folder. `edited` follows the
	 * same rules as in `buildPlan`.
	 */
	writePlanFile(sessionId: string, turnId: string, target: URI, notes: string, edited?: PlanArtifact): Promise<void>;
	runTestSession(cwd: string): Promise<ClaudeRunHandle>;

	readonly onDidChangeViewState: Event<{ readonly sessionId: string }>;
	readonly onDidChangePending: Event<{ readonly sessionId: string }>;
	/** Messages waiting above the composer, oldest first. */
	getPending(sessionId: string): readonly PendingInput[];
	/**
	 * Stores a composer message while a turn is running.
	 * `queue` waits until that turn ends, then sends it.
	 * `steer` is pushed into the open streaming query when the runtime accepts it.
	 * When nothing is running, both send immediately.
	 */
	queue(sessionId: string, text: string, cwd: string, behavior: PendingInput['behavior'], options?: ClaudeSubmitOptions): Promise<PendingInput>;
	/**
	 * Hands the agent a reminder the chat never shows as the user's own message.
	 * Pushed into the open streaming query; returns false when no turn is running
	 * or the runtime does not accept it, and then nothing is sent.
	 */
	remind(sessionId: string, text: string): Promise<boolean>;
	/**
	 * Replaces the text of a queued message. Pass `compiled` when the prompt was rebuilt.
	 * Returns false when that item was already sent or removed, or the text is empty.
	 * Attachments on the item stay as they were.
	 */
	updatePending(sessionId: string, id: string, text: string, compiled?: string): boolean;
	removePending(sessionId: string, id: string): void;
	/**
	 * Enter again on a queued message (issue 1242): interrupts the running turn, then sends the first
	 * queued message once the turn has stopped. Returns false when nothing is queued.
	 */
	sendQueuedNow(sessionId: string): Promise<boolean>;
	/** True when Steer now can deliver into the turn that is running. */
	supportsSteer(sessionId: string): Promise<boolean>;
	/** Timeline state rebuilt from events by `reduceAgentState`. */
	getViewState(sessionId: string): AgentViewState;
	/**
	 * True while the head turn runs or a subagent, delegated chat or background command under it still
	 * runs (issue 1617). The Stop button follows this. Sending and queueing follow the head turn only.
	 */
	isWorking(sessionId: string): boolean;
	/** The runtime session behind a pane session, once its first turn has started. */
	getRuntimeSessionId(sessionId: string): string | undefined;
	/**
	 * Sends composer text as a new turn. The first turn starts a Claude session in
	 * `cwd`; later turns reuse it. A start failure becomes a failed turn, not a throw.
	 * Rejects only when the session is unknown, the text is empty, or a turn is running.
	 */
	submit(sessionId: string, text: string, cwd: string, options?: ClaudeSubmitOptions): Promise<void>;
	setAttachments(sessionId: string, attachments: readonly ContextAttachment[]): void;
	/** The attachments (context chips and images) the chat's latest message was sent with; empty when none. */
	getSentAttachments(sessionId: string): readonly ContextAttachment[];
	addAdditionalDirectory(sessionId: string, directory: string): void;
	/** Interrupts the running turn. The turn ends as `stopped` and keeps its partial output. */
	stop(sessionId: string): Promise<void>;
	/**
	 * Stop for the user's Stop button. When the turn has produced nothing yet, the message
	 * leaves the chat and its text and attachments go back into the composer (issue 948).
	 * Returns whether it did; otherwise it only stops, as `stop` does.
	 */
	stopAndTakeBack(sessionId: string, resolveChanges?: (turnId: string) => Promise<readonly string[] | undefined>): Promise<boolean>;
	/** The stopped turn whose prompt Stop put back in the composer; sending replaces it (issue 1178). */
	pendingEditTurnId(sessionId: string): string | undefined;
	/** Esc: the stopped turn stays as it is and the next message is a new turn (issue 1178). */
	discardPendingEdit(sessionId: string): void;
	/** Stops one subagent. The runtime interrupts the parent turn when it cannot stop that run alone. */
	stopSubagent(sessionId: string, runId: string): Promise<void>;
	/** Normalized events and local turn actions, oldest first. */
	getSessionEvents(sessionId: string): readonly AgentReducerEvent[];
	/** Raw SDK messages retained only while `claude.debug.retainRawEvents` was on. */
	getRawSdkMessages(sessionId: string): readonly unknown[];
	/** Bumps when the inspector's event or raw log changes. */
	getInspectorRevision(sessionId: string): number;
	readonly onDidChangeInspector: Event<{ readonly sessionId: string }>;
	/** Records a command-card Re-run in the session permission history. */
	recordCommandRerun(sessionId: string, command: string, cwd: string | undefined, allowed: boolean, source: 'user' | 'policy', reason?: string): void;
	/**
	 * Sends the text of the last failed or stopped turn again as a new turn.
	 * Does not clear the composer draft.
	 */
	retry(sessionId: string, cwd: string, accountId?: string): Promise<void>;
	/**
	 * Picks the account a chat runs under; undefined follows the active account. Takes effect on the next turn.
	 * Delegated chats start with their parent's account.
	 */
	setSessionAccount(sessionId: string, accountId: string | undefined): void;
	/** The account a chat was pinned to, or undefined when it follows the active account. */
	getSessionAccount(sessionId: string): string | undefined;
	/** What this chat does on a plan limit, overriding the global setting; undefined follows the setting. */
	setSessionLimitPolicy(sessionId: string, policy: ClaudeLimitPolicy | undefined): void;
	getSessionLimitPolicy(sessionId: string): ClaudeLimitPolicy | undefined;
	/**
	 * Remembers sessions on disk. Passing a store a second time replaces it.
	 * `reveal` opens a worktree folder in the OS file manager.
	 */
	attachDurableHistory(store: JsonlSessionStore, reveal?: (path: string) => Promise<void>): void;
	/** Loads the index into the history list. Events load when a row is opened. */
	loadDurableHistory(): Promise<void>;
	/**
	 * Picks up turns another window appended to this session's saved history (issue 1509). Does nothing
	 * for a session that is not loaded here or is running here, or when nothing new is on disk.
	 */
	syncExternalHistory(sessionId: string): Promise<void>;
	/** Reopens a saved session and its transcript. Does not start Claude or any tool. */
	resume(sessionId: string): Promise<void>;
	/** Turns of saved chats whose prompt or reply has the words of `query`, newest chat first (issue 489). */
	searchChats(query: string): Promise<readonly ClaudeChatSearchHit[]>;
	renameSession(sessionId: string, title: string): Promise<void>;
	/** Pins or unpins a chat in history, open or closed. */
	setPinned(sessionId: string, pinned: boolean): void;
	/** Archives a chat, closing its tab, or brings it back to the history lists. */
	setArchived(sessionId: string, archived: boolean): void;
	/** Pins a command or skill to an open chat so every message runs it, or unpins it (issue 488). */
	setPinnedCommand(sessionId: string, command: string | undefined): void;
	deleteSession(sessionId: string): Promise<void>;
	forkSession(sessionId: string, fromTurnId: string): Promise<string>;
	/** Whether the chat can go back to this turn's message to edit it, and if not, why (issue 702). */
	canRewind(sessionId: string, turnId: string): { readonly enabled: boolean; readonly reason?: string };
	/** The context chips sent with this turn's message, so editing it can carry them (issue 1054). Empty after a restart. */
	getTurnAttachments(sessionId: string, turnId: string): readonly ContextAttachment[];
	/**
	 * Takes the chat back to before this turn: it and every later turn leave the chat, and the
	 * next message continues Claude Code's conversation as it was then. Stops a running turn.
	 * Files are not touched here; `keptFiles` are the changed files the user chose to keep,
	 * which Claude is told about with the next message.
	 */
	rewind(sessionId: string, turnId: string, keptFiles?: readonly string[]): Promise<void>;
	exportSession(sessionId: string, format: 'markdown' | 'json', raw?: boolean): Promise<string>;
	/** Writes the redacted export at `target`. The view does not touch the file service. */
	writeExportedTranscript(sessionId: string, format: 'markdown' | 'json', target: URI, raw?: boolean): Promise<void>;
	revealWorktree(sessionId: string): Promise<void>;
	/** New chat whose draft is a summary. The old transcript stays. Tools are not rerun. */
	continueInNewSession(sessionId: string): Promise<string>;
	/** New chat with one chat chip pointing at this session, turn, or subagent. */
	referenceInNewSession(sessionId: string, options?: { readonly turnId?: string; readonly subagentId?: string }): Promise<string>;
	/**
	 * Opens the Klawly chat that continues Claude Code session `claudeSessionId` (issue 618): the
	 * open tab, else the saved chat, else a new tab whose next message resumes that session, so
	 * Claude remembers the turns another window ran. `adopted` is true for that new tab, titled
	 * `title` when given (a terminal session brought in by `klawly://agent/import`, issue 1186).
	 */
	openClaudeCodeSession(claudeSessionId: string, title?: string): Promise<{ readonly sessionId: string; readonly adopted: boolean }>;
	listChatMentions(query: string): readonly { readonly id: string; readonly title: string; readonly detail: string; readonly attachment: ContextAttachment }[];
	prepareChatReference(composerSessionId: string, attachment: Extract<ContextAttachment, { kind: 'chat' }>, summaryChars?: number): Promise<ChatReferenceInput>;
	readonly onDidLoadSession: Event<{ readonly sessionId: string }>;
	/** A begin that did not resume the previous Claude session. */
	readonly onDidStartFreshClaudeSession: Event<{ readonly sessionId: string; readonly title: string }>;
	/** Fires when the runtime refuses a model and the turn falls back to the default. */
	readonly onDidRejectModel: Event<ClaudeModelRejection>;
	/** True for a turn started by inline edit (`origin: 'inline-edit'`). */
	isInlineEditTurn(sessionId: string, turnId: string): boolean;
	/**
	 * A Claude Code plugin was installed, updated or removed. Each session whose
	 * Claude Code query is running lists it until it restarts; a session that has
	 * not started loads it when it does.
	 */
	notePluginChange(plugin: string, removed: boolean): void;
	/** Plugins changed since the session's Claude Code query started. */
	getPluginChanges(sessionId: string): readonly ClaudePluginChange[];
	/** Starts Claude Code again for the next turn, resuming this conversation, so it loads plugin changes. */
	restartSession(sessionId: string): void;
}

/** A plugin installed, updated or removed while a session's query was running. */
export interface ClaudePluginChange {
	readonly plugin: string;
	readonly removed: boolean;
}

const DISK_COALESCE_MS = 40;
const META_PERSIST_MS = 200;
const TAB_ORDER_STORAGE_KEY = 'claude.tabOrder';
/** How long a turn waits for Auto's classifier before it estimates the rating itself. */
const AUTO_CLASSIFY_TIMEOUT_MS = 8000;

export { isClaudeResumeRejection };

/** Thrown when `submit` is asked to start a turn that is already running. The message is localized; callers match the class. */
export class ClaudeTurnBusyError extends Error {
	constructor() {
		super(localize('claudeSubmitBusy', "The agent is still answering. Stop it first."));
		this.name = 'ClaudeTurnBusyError';
	}
}

/** True only for a busy turn. A translated message with the same words does not match. */
export function shouldRequeuePending(error: unknown): boolean {
	return error instanceof ClaudeTurnBusyError;
}

interface StoredPending extends PendingInput {
	cwd: string;
}

interface MutablePaneSession {
	id: string;
	title: string;
	titleIsDefault: boolean;
	/** The number in a default title ("New Agent" is 1). Counts only while `titleIsDefault` holds. */
	defaultTitleIndex?: number;
	/** True while the title is the first request cut short, so a generated `session.titled` may replace it. */
	titleFromPrompt?: boolean;
	mode: AgentMode;
	modelId?: string;
	modelName?: string;
	draft: string;
	attachments: ContextAttachment[];
	additionalDirectories: string[];
	slashCommands: string[];
	skills: string[];
	commands: readonly ClaudeCommandInfo[];
	agents: readonly ClaudeSubagentInfo[];
	claudeSessionId?: string;
	workspaceId: string;
	workspaceName: string;
	worktreePath?: string;
	executionTarget?: ClaudeExecutionTarget;
	targetInfo?: ClaudeExecutionTargetInfo;
	interrupted: boolean;
	resumeFailed: boolean;
	resumeBlocked: boolean;
	createdAt: number;
	updatedAt: number;
	checkpointIds: string[];
	loaded: boolean;
	/** A fork's summary, sent ahead of the next message until Claude has a session. */
	forkContext?: string;
	/** After a rewind: the chain entry the next resume cuts Claude Code's conversation after (issue 702). */
	resumeAt?: string;
	/** After a rewind that kept changed files: what Claude is told ahead of the next message. */
	rewindNote?: string;
	/** Stop put this turn's prompt back in the composer; the next send replaces the turn (issue 1178). Not saved. */
	pendingEdit?: string;
	/** Files the user chose to keep when stopping the pending-edit turn (issue 1178); Claude is told about them on rewind. */
	pendingEditKept?: readonly string[];
	pinned?: boolean;
	archived?: boolean;
	pinnedCommand?: string;
	delegatedFrom?: string;
}

export class ClaudeAgentService extends Disposable implements IClaudeAgentService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidReceiveEvent = this._register(new Emitter<NormalizedClaudeEvent>());
	readonly onDidReceiveEvent = this._onDidReceiveEvent.event;

	/** The latest message each chat sent, with the attachments it went with, so Stop can give them back (issue 948). */
	private readonly _turnAttachments = new Map<string, Map<string, readonly ContextAttachment[]>>();
	private readonly _lastSubmitted = new Map<string, { readonly turnId: string; readonly attachments: readonly ContextAttachment[] }>();
	private readonly _onDidChangeSession = this._register(new Emitter<ClaudeAgentSessionChange>());
	readonly onDidChangeSession = this._onDidChangeSession.event;
	/** Fast mode's state per pane session, from `session.fastMode` events (issue 456). */
	private readonly _fastMode = new Map<string, ClaudeFastModeStatus>();
	private readonly _onDidDropFastMode = this._register(new Emitter<{ readonly sessionId: string; readonly previous: ClaudeFastModeStatus; readonly status: ClaudeFastModeStatus }>());
	readonly onDidDropFastMode = this._onDidDropFastMode.event;

	private readonly _paneSessions: MutablePaneSession[] = [];
	private _currentSessionId: string | undefined;
	/** Allow All Commands and Allow Everything per pane session. In memory only. */
	private readonly _sessionPermissions = new Map<string, ClaudeSessionPermissions>();
	/** The permission level last sent to the running sessions (issue 453). */
	private _appliedPermissionLevel: ClaudePermissionPreset;

	private readonly _onDidChangeViewState = this._register(new Emitter<{ readonly sessionId: string }>());
	readonly onDidChangeViewState = this._onDidChangeViewState.event;

	private readonly _onDidChangePending = this._register(new Emitter<{ readonly sessionId: string }>());
	readonly onDidChangePending = this._onDidChangePending.event;

	private readonly _pending = new Map<string, StoredPending[]>();
	private readonly _flushing = new Set<string>();

	private readonly _onDidChangeInspector = this._register(new Emitter<{ readonly sessionId: string }>());
	readonly onDidChangeInspector = this._onDidChangeInspector.event;

	private readonly _onDidLoadSession = this._register(new Emitter<{ readonly sessionId: string }>());
	readonly onDidLoadSession = this._onDidLoadSession.event;

	private readonly _onDidStartFreshClaudeSession = this._register(new Emitter<{ readonly sessionId: string; readonly title: string }>());
	readonly onDidStartFreshClaudeSession = this._onDidStartFreshClaudeSession.event;

	private readonly _onDidRejectModel = this._register(new Emitter<ClaudeModelRejection>());
	readonly onDidRejectModel = this._onDidRejectModel.event;

	/** Turns inline edit started, by pane session. Dropped when the session closes. */
	private readonly _inlineTurns = new Map<string, Set<string>>();
	/** Model the runtime reported when a query started without one. A per-turn model switches back to it. */
	private readonly _baseModel = new Map<string, string>();
	/** Display names from the last model list, for sessions that start with `claude.models.default`. */
	private readonly _modelNames = new Map<string, string>();
	/** The last model list, by id, for what each model supports. */
	private readonly _modelInfo = new Map<string, ClaudeModelInfo>();
	private _modelInfoLoad: Promise<readonly ClaudeModelInfo[]> | undefined;
	/** Settings the user picked, by pane session. Absent follows the `claude.models.*` defaults. */
	private readonly _sessionSettings = new Map<string, ClaudeSessionSettings>();
	/** Auto model's last pick, by pane session (issue 521). */
	private readonly _autoModel = new Map<string, ClaudeAutoModelState>();
	/** Settings Auto picked for the newest turn. They win over `_sessionSettings` while Auto is on. */
	private readonly _autoSettings = new Map<string, ClaudeSessionSettings>();
	/** `setSessionBudget`: spend caps of background runs (issue 424). */
	private readonly _sessionBudgets = new Map<string, number>();
	private readonly _sessionAccounts = new Map<string, string>();
	private readonly _sessionLimitPolicies = new Map<string, ClaudeLimitPolicy>();
	/** `setSessionMaxTurns`: turn caps of automation runs (issue 426). */
	private readonly _sessionMaxTurns = new Map<string, number>();
	/** Settings last applied to a runtime session. Follow-up turns change them only when they differ. */
	private readonly _appliedSettings = new Map<string, ClaudeSessionSettings>();

	private _history: JsonlSessionStore | undefined;
	/** Search inside past chats (issue 489). Set with the durable history. */
	private readonly _chatSearch = this._register(new MutableDisposable<ClaudeChatSearchIndex>());
	private _revealWorktree: ((path: string) => Promise<void>) | undefined;
	private _indexTail: Promise<void> = Promise.resolve();
	private readonly _diskEvents = new Map<string, AgentReducerEvent[]>();
	private readonly _deletedSessions = new Set<string>();
	/** The durable index as last read or written, so history lists closed chats without reading the disk. */
	private readonly _historyRecords = new Map<string, SessionIndexRecord>();
	private readonly _loadingSessions = new Map<string, Promise<void>>();
	private readonly _diskBuffers = new Map<string, AgentReducerEvent[]>();
	private readonly _diskTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly _metaTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Pane sessions whose next begin must not resume, so a successful start is a new Claude session. */
	private readonly _freshStarts = new Set<string>();
	/** Pane ids whose current begin passed a Claude resume id. Cleared when that begin starts or fails. */
	private readonly _resumeAttempts = new Set<string>();
	/** Plugins changed since each running query started, by pane session. */
	private readonly _pluginChanges = new Map<string, ClaudePluginChange[]>();
	/** Pane sessions whose next turn starts a new query that resumes, so Claude Code loads plugin changes. */
	private readonly _restartNext = new Set<string>();
	/** Plugin folders a session tries without installing them, passed with every query it opens. */
	private readonly _sessionPlugins = new Map<string, readonly string[]>();
	/** Lean or full, for delegated chats (issue 843). A chat the user opened has none. */
	private readonly _sessionProfiles = new Map<string, ClaudeWorkerProfile>();
	/** Runs delegated chats (issue 693). Registered by the delegation service. */
	private _delegateHandler: ClaudeAgentDelegateHandler | undefined;
	/** What Auto's delegated chats answered, read by the chat's own model ahead of its next message (issue 693). */
	private readonly _delegateNotes = new Map<string, string[]>();

	private readonly _viewStates = new Map<string, AgentViewState>();
	private readonly _eventLog = new Map<string, AgentReducerEvent[]>();
	/** Redacted command output already written to the log, keyed by session and call. */
	private readonly _commandStreamed = new Map<string, string>();
	private readonly _rawLog = new Map<string, unknown[]>();
	private readonly _inspectorRevision = new Map<string, number>();
	private readonly _runtimeToPane = new Map<string, string>();
	private readonly _paneToRuntime = new Map<string, string>();
	/** Bumped by stop and close so a begin that resolves late is discarded. */
	private readonly _turnTokens = new Map<string, number>();
	/** Panes the user stopped and has not sent to since: late child work there is dropped (issue 1617). */
	private readonly _stoppedPanes = new Set<string>();
	/** Turns whose cheap model already went back to the chat's own (issue 839). */
	private readonly _fellBack = new Set<string>();
	/** Model id last applied to a runtime session. Follow-up turns call setModel only when it changes. */
	private readonly _appliedModel = new Map<string, string | undefined>();
	/** Directories the open runtime query actually received. Later additions wait for the next begin. */
	private readonly _appliedDirectories = new Map<string, readonly string[]>();
	private _turnSerial = 0;

	/** Background agents pin cwd so a later turn cannot start in the main workspace. */
	private readonly _pinnedCwd = new Map<string, string>();
	private readonly _ownedSessions = new Set<string>();
	private readonly _bufferedEvents = new Map<string, NormalizedClaudeEvent[]>();
	private readonly _lastEventAt = new Map<string, number>();
	private _beginsInFlight = 0;
	private _lastStateLine: string | undefined;
	/** True when a managed settings file turns off running Claude Code without asking (issue 694). */
	private _unaskedBlockedByFiles = false;

	constructor(
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IOutputService private readonly _output: IOutputService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly _trust: IWorkspaceTrustManagementService,
		@IClaudeCheckpointService private readonly _checkpoints: IClaudeCheckpointService,
		@IFileService private readonly _files: IFileService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IStorageService private readonly _storage: IStorageService,
	) {
		super();
		this._register(this._runtime.onDidEmitEvent(event => this.handleRuntimeEvent(event)));
		if (this._runtime.onDidEmitRawMessage) {
			this._register(this._runtime.onDidEmitRawMessage(message => {
				const paneId = this._runtimeToPane.get(message.sessionId);
				if (!paneId) {
					return;
				}
				const list = this._rawLog.get(paneId) ?? [];
				appendCapped(list, message.message, CLAUDE_RAW_LOG_CAP);
				this._rawLog.set(paneId, list);
				this.bumpInspector(paneId);
			}));
		}
		this._register(this._runtime.onDidChangeRuntimeState(state => this.logState(state)));
		// Losing trust turns both switches off for good: trusting the workspace again
		// must not bring Allow Everything back without its confirm.
		this._appliedPermissionLevel = this.permissionLevel();
		this._register(this._trust.onDidChangeTrust(trusted => {
			if (!trusted) {
				this.clearSessionPermissions();
			}
			this.applyPermissionLevel();
		}));
		// The permission level applies to every session (issue 453), the running ones included.
		this._register(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING) || event.affectsConfiguration(CLAUDE_AGENT_ALLOW_EVERYTHING_CONFIRM_SETTING) || event.affectsConfiguration(CLAUDE_MANAGED_SETTINGS_SETTING)) {
				this.applyPermissionLevel();
			}
		}));
		// Claude Code enforces its managed settings files itself; reading them lets the menu say why (issue 694).
		claudeUnaskedDisabledByManagedFiles(this._files, OS).then(blocked => {
			this._unaskedBlockedByFiles = blocked;
			this.applyPermissionLevel();
		}, () => undefined);
	}

	isUnaskedBlocked(): boolean {
		if (this._unaskedBlockedByFiles) {
			return true;
		}
		// Klawly hands this policy to Claude Code too, which enforces it there.
		const security = readClaudeSecuritySettings(key => this._configuration.getValue(key), key => this._configuration.inspect?.(key)?.policyValue);
		return claudeUnaskedDisabledBy(security.managed.settings);
	}

	/** The level every session runs at now: the setting, held back while untrusted or unconfirmed. */
	private permissionLevel(): ClaudePermissionPreset {
		return effectiveClaudePermissionLevel(
			readClaudePermissionPreset(this._configuration.getValue(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING)),
			this._trust.isWorkspaceTrusted(),
			!readClaudeAllowEverythingConfirm(this._configuration.getValue(CLAUDE_AGENT_ALLOW_EVERYTHING_CONFIRM_SETTING)),
			this.isUnaskedBlocked(),
		);
	}

	private applyPermissionLevel(): void {
		const level = this.permissionLevel();
		if (level === this._appliedPermissionLevel) {
			return;
		}
		this._appliedPermissionLevel = level;
		for (const session of this._paneSessions) {
			const runtimeId = this._paneToRuntime.get(session.id);
			if (runtimeId) {
				void this._runtime.setSessionPermissions?.(runtimeId, this.getSessionPermissions(session.id))?.catch(error => this.append(formatClaudeAgentFailure(error instanceof Error ? error.message : String(error))));
			}
		}
		this.fireSessionChange('permissions');
	}

	private clearSessionPermissions(): void {
		for (const sessionId of [...this._sessionPermissions.keys()]) {
			this.setSessionPermissions(sessionId, NO_SESSION_PERMISSIONS);
		}
	}

	/** Opens an in-memory pane session and makes it current. */
	createSession(options?: { readonly plugins?: readonly string[]; readonly draft?: string }): ClaudeAgentSession {
		const defaultTitleIndex = this.nextDefaultTitleIndex();
		const place = this.workspaceIdentity();
		const defaultModel = this.startModel();
		const session: MutablePaneSession = {
			id: generateUuid(),
			title: defaultTitleIndex === 1
				? localize('claudeNewAgent', "New Agent")
				: localize('claudeNewAgentNumbered', "New Agent {0}", defaultTitleIndex),
			titleIsDefault: true,
			defaultTitleIndex,
			mode: readClaudeDefaultMode(this._configuration?.getValue(CLAUDE_AGENT_DEFAULT_MODE_SETTING)),
			modelId: defaultModel,
			modelName: defaultModel ? this._modelNames.get(defaultModel) ?? defaultModel : undefined,
			draft: options?.draft ?? '',
			attachments: [],
			additionalDirectories: [],
			slashCommands: [],
			skills: [],
			commands: [],
			agents: [],
			workspaceId: place.id,
			workspaceName: place.name,
			interrupted: false,
			resumeFailed: false,
			resumeBlocked: false,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			checkpointIds: [],
			loaded: true,
		};
		this.addPaneSession(session);
		this._currentSessionId = session.id;
		this._diskEvents.set(session.id, []);
		if (readClaudeAutoOn(this._configuration?.getValue(CLAUDE_MODELS_AUTO_SETTING)) || readClaudeAutoOn(readClaudeLastPick(this._storage, 'auto'))) {
			this._autoModel.set(session.id, {});
		}
		if (options?.plugins?.length) {
			this._sessionPlugins.set(session.id, options.plugins.slice());
		}
		this.fireSessionChange('created');
		void this.persistMeta(session);
		void this.primeCommands(session);
		return this.snapshot(session);
	}

	/**
	 * Fills the `/` menu of a chat that has sent nothing yet (issue 968): Claude
	 * Code reports its commands and skills only once a query starts, so ask it
	 * for them with no turn. A catalog a query already reported is kept, and a
	 * runtime that cannot list leaves the menu as it was.
	 */
	private async primeCommands(session: MutablePaneSession): Promise<void> {
		const cwd = this.workspaceFolders()[0];
		if (!cwd || !this._runtime.listCommands) {
			return;
		}
		try {
			const listing = await this._runtime.listCommands(cwd);
			if (session.commands.length > 0 || listing.commands.length === 0 || !this._paneSessions.includes(session)) {
				return;
			}
			session.commands = listing.commands.slice();
			if (session.agents.length === 0) {
				session.agents = listing.agents.slice();
			}
			this.fireSessionChange('context');
		} catch {
			// The menu keeps only the built-in commands until the first message.
		}
	}

	createDelegatedSession(parentId: string, options: { readonly modelId?: string; readonly modelName?: string; readonly effort?: ClaudeEffortLevel; readonly title: string; readonly profile?: ClaudeWorkerProfile }): ClaudeAgentSession {
		const parent = this._paneSessions.find(candidate => candidate.id === parentId);
		if (!parent) {
			throw new Error(localize('claudeSubmitClosed', "That agent session is not open."));
		}
		const modelId = options.modelId ?? parent.modelId;
		const session: MutablePaneSession = {
			id: generateUuid(),
			title: options.title,
			titleIsDefault: false,
			mode: parent.mode,
			modelId,
			modelName: options.modelId ? options.modelName ?? options.modelId : parent.modelName,
			draft: '',
			attachments: [],
			additionalDirectories: parent.additionalDirectories.slice(),
			slashCommands: [],
			skills: [],
			commands: [],
			agents: [],
			workspaceId: parent.workspaceId,
			workspaceName: parent.workspaceName,
			executionTarget: parent.executionTarget,
			interrupted: false,
			resumeFailed: false,
			resumeBlocked: false,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			checkpointIds: [],
			loaded: true,
			delegatedFrom: parentId,
		};
		this._paneSessions.push(session);
		this._diskEvents.set(session.id, []);
		// The delegated chat works where its parent works, with its permissions and plugins.
		const cwd = this._pinnedCwd.get(parentId) ?? parent.worktreePath;
		if (cwd) {
			this._pinnedCwd.set(session.id, cwd);
		}
		const permissions = this._sessionPermissions.get(parentId);
		if (permissions) {
			this._sessionPermissions.set(session.id, permissions);
		}
		if (options.profile) {
			this._sessionProfiles.set(session.id, options.profile);
		}
		const plugins = this._sessionPlugins.get(parentId);
		if (plugins) {
			this._sessionPlugins.set(session.id, plugins);
		}
		const parentPolicy = this._sessionLimitPolicies.get(parentId);
		if (parentPolicy !== undefined) {
			this._sessionLimitPolicies.set(session.id, parentPolicy);
		}
		const parentAccount = this._sessionAccounts.get(parentId);
		if (parentAccount !== undefined) {
			this._sessionAccounts.set(session.id, parentAccount);
		}
		const budget = this._sessionBudgets.get(parentId);
		if (budget !== undefined) {
			this._sessionBudgets.set(session.id, budget);
		}
		const base = this.getSessionSettings(parentId);
		this._sessionSettings.set(session.id, fitClaudeSessionSettings(modelId ? this._modelInfo.get(modelId) : undefined, readClaudeSessionSettings({ ...base, effort: options.effort ?? base.effort, ultracode: false })));
		this.fireSessionChange('created');
		void this.persistMeta(session);
		return this.snapshot(session);
	}

	setDelegateHandler(handler: ClaudeAgentDelegateHandler): IDisposable {
		this._delegateHandler = handler;
		return toDisposable(() => {
			if (this._delegateHandler === handler) {
				this._delegateHandler = undefined;
			}
		});
	}

	noteDelegation(sessionId: string, card: ClaudeDelegateCard): void {
		if (this._paneSessions.some(session => session.id === sessionId)) {
			this.dispatch(sessionId, { type: 'turn.delegate', card });
		}
	}

	/**
	 * The lowest number no open tab with a default title uses, so closed or renamed
	 * chats free theirs and the only default tab is plain "New Agent".
	 */
	private nextDefaultTitleIndex(): number {
		const used = new Set(this._paneSessions.filter(session => session.titleIsDefault).map(session => session.defaultTitleIndex));
		let index = 1;
		while (used.has(index)) {
			index++;
		}
		return index;
	}

	/**
	 * The model a new session starts on: `claude.models.default`, else the model
	 * the user last picked while the runtime still reports it. Undefined runs
	 * Claude Code's default, which the picker names by the model it resolves to.
	 */
	private startModel(): string | undefined {
		const configured = readClaudeModelId(this._configuration?.getValue(CLAUDE_MODELS_DEFAULT_SETTING));
		if (configured) {
			return configured;
		}
		const last = readClaudeLastPick(this._storage, 'model');
		if (!last || (this._modelInfo.size > 0 && !this._modelInfo.has(last) && !readClaudeModelIdList(this._configuration?.getValue(CLAUDE_MODELS_CUSTOM_SETTING)).includes(last))) {
			return undefined;
		}
		return last;
	}

	pinWorkingDirectory(sessionId: string, cwd: string): void {
		if (!this._paneSessions.some(session => session.id === sessionId) || !cwd) {
			return;
		}
		this._pinnedCwd.set(sessionId, cwd);
	}

	setSessionBudget(sessionId: string, maxBudgetUsd: number | undefined): void {
		if (!this._paneSessions.some(session => session.id === sessionId)) {
			return;
		}
		if (maxBudgetUsd !== undefined && Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0) {
			this._sessionBudgets.set(sessionId, maxBudgetUsd);
		} else {
			this._sessionBudgets.delete(sessionId);
		}
	}

	setSessionMaxTurns(sessionId: string, maxTurns: number | undefined): void {
		if (!this._paneSessions.some(session => session.id === sessionId)) {
			return;
		}
		if (maxTurns !== undefined && Number.isInteger(maxTurns) && maxTurns > 0) {
			this._sessionMaxTurns.set(sessionId, maxTurns);
		} else {
			this._sessionMaxTurns.delete(sessionId);
		}
	}

	private workingDirectory(sessionId: string, cwd: string): string {
		return this._pinnedCwd.get(sessionId) ?? cwd;
	}

	getSessions(): readonly ClaudeAgentSession[] {
		return this._paneSessions.map(session => this.snapshot(session));
	}

	getHistory(): readonly ClaudeAgentSession[] {
		return [...this.getSessions(), ...this.closedRecords().map(record => this.snapshot(this.sessionFromRecord(record)))];
	}

	/** Saved sessions that are not open tabs. Empty chats are left out. */
	private closedRecords(): SessionIndexRecord[] {
		return [...this._historyRecords.values()].filter(record => !!record.firstUser && !this._deletedSessions.has(record.id) && !this._paneSessions.some(session => session.id === record.id));
	}

	getCurrentSession(): ClaudeAgentSession | undefined {
		const session = this.currentMutable();
		return session ? this.snapshot(session) : undefined;
	}

	selectSession(sessionId: string): void {
		if (!this._paneSessions.some(session => session.id === sessionId) || this._currentSessionId === sessionId) {
			return;
		}
		this._currentSessionId = sessionId;
		this.fireSessionChange('selected');
		this.loadInBackground(sessionId);
	}

	/** Adds a new chat at the end of the tab strip, or at the front when `claude.agent.newChatsFirst` is on. */
	private addPaneSession(session: MutablePaneSession): void {
		if (this._configuration?.getValue(CLAUDE_AGENT_NEW_CHATS_FIRST_SETTING) === true) {
			this._paneSessions.unshift(session);
		} else {
			this._paneSessions.push(session);
		}
		this.storeTabOrder();
	}

	moveSession(sessionId: string, beforeSessionId: string | undefined): void {
		const from = this._paneSessions.findIndex(session => session.id === sessionId);
		if (from < 0 || sessionId === beforeSessionId) {
			return;
		}
		const [moved] = this._paneSessions.splice(from, 1);
		const to = beforeSessionId ? this._paneSessions.findIndex(session => session.id === beforeSessionId) : -1;
		if (to < 0) {
			this._paneSessions.push(moved);
		} else {
			this._paneSessions.splice(to, 0, moved);
		}
		if (this._paneSessions.findIndex(session => session.id === sessionId) === from) {
			return;
		}
		this.storeTabOrder();
		this.fireSessionChange('reordered');
	}

	/** Remembers the order of the open tabs for this workspace. */
	private storeTabOrder(): void {
		this._storage.store(TAB_ORDER_STORAGE_KEY, JSON.stringify(this._paneSessions.map(session => session.id)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	/** Puts `sessions` in the order the user left the tabs in; chats with no remembered place keep their order after the rest. */
	private applyTabOrder<T extends { readonly id: string }>(sessions: T[]): T[] {
		let order: string[] = [];
		try {
			const parsed: unknown = JSON.parse(this._storage.get(TAB_ORDER_STORAGE_KEY, StorageScope.WORKSPACE) ?? '[]');
			order = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
		} catch {
			return sessions;
		}
		const place = (session: T) => { const at = order.indexOf(session.id); return at < 0 ? order.length : at; };
		return sessions.map((session, at) => ({ session, at })).sort((a, b) => place(a.session) - place(b.session) || a.at - b.at).map(entry => entry.session);
	}

	closeSession(sessionId: string): void {
		if (!this._paneSessions.some(session => session.id === sessionId)) {
			return;
		}
		// Its delegated chats stop and close with it (issue 693).
		this._delegateHandler?.stopUnder(sessionId, true);
		this._delegateNotes.delete(sessionId);
		const index = this._paneSessions.findIndex(session => session.id === sessionId);
		if (index < 0) {
			return;
		}
		this.saveClosed(this._paneSessions[index]);
		this._paneSessions.splice(index, 1);
		this.storeTabOrder();
		this._pinnedCwd.delete(sessionId);
		this._sessionBudgets.delete(sessionId);
		this._sessionAccounts.delete(sessionId);
		this._sessionLimitPolicies.delete(sessionId);
		this._sessionMaxTurns.delete(sessionId);
		this._sessionPermissions.delete(sessionId);
		this._sessionSettings.delete(sessionId);
		this._autoModel.delete(sessionId);
		this._autoSettings.delete(sessionId);
		this._sessionPlugins.delete(sessionId);
		this._sessionProfiles.delete(sessionId);
		this._viewStates.delete(sessionId);
		this._eventLog.delete(sessionId);
		this._rawLog.delete(sessionId);
		this._inspectorRevision.delete(sessionId);
		this._turnTokens.delete(sessionId);
		this._pending.delete(sessionId);
		this._flushing.delete(sessionId);
		this._inlineTurns.delete(sessionId);
		const runtimeId = this.unmapRuntime(sessionId);
		if (runtimeId) {
			void this.interruptAndDispose(runtimeId, true);
		}
		if (this._currentSessionId === sessionId) {
			// A delegated chat is not a tab of its own, so the next tab is never one.
			const tabs = this._paneSessions.filter(session => !session.delegatedFrom);
			const closed = this._paneSessions.slice(0, index).filter(session => !session.delegatedFrom).length;
			const next = tabs[closed] ?? tabs[closed - 1];
			this._currentSessionId = next?.id;
		}
		this.fireSessionChange('closed');
	}

	setDraft(sessionId: string, text: string): void {
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (session) {
			session.draft = text;
		}
	}

	async setNextModel(sessionId: string, modelId: string): Promise<void> {
		if (!this._paneSessions.some(session => session.id === sessionId)) {
			throw new Error('That agent session is not open.');
		}
		const models = await this._runtime.listModels();
		if (this._store.isDisposed) {
			return;
		}
		this.noteModels(models);
		const custom = readClaudeModelIdList(this._configuration?.getValue(CLAUDE_MODELS_CUSTOM_SETTING));
		if (!isKnownClaudeModel(modelId, models, custom)) {
			throw new Error(models.length === 0
				? 'Claude has not reported any models.'
				: 'That model is not in the list Claude reported.');
		}
		const reported = models.find(model => model.id === modelId);
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (!session) {
			return;
		}
		session.modelId = modelId;
		session.modelName = reported ? claudeModelDisplayName(reported) : modelId;
		this._autoModel.delete(sessionId);
		this._autoSettings.delete(sessionId);
		storeClaudeLastPick(this._storage, 'model', modelId);
		if (readClaudeAutoOn(readClaudeLastPick(this._storage, 'auto'))) {
			storeClaudeLastPick(this._storage, 'auto', 'off');
		}
		const picked = this._sessionSettings.get(sessionId);
		if (picked && reported) {
			// Keep what the new model takes: effort falls to its nearest lower level.
			this._sessionSettings.set(sessionId, fitClaudeSessionSettings(reported, picked));
		}
		this.fireSessionChange('model');
	}

	getFastModeStatus(sessionId: string): ClaudeFastModeStatus | undefined {
		return this._fastMode.get(sessionId);
	}

	getSessionSettings(sessionId: string): ClaudeSessionSettings {
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (this._modelInfo.size === 0) {
			// The effort a session sends depends on what its model takes: once known, the views show it.
			void this.loadModelInfo().then(loaded => {
				if (loaded) {
					this.fireSessionChange('settings');
				}
			});
		}
		return this.settingsFor(sessionId, session?.modelId);
	}

	async setNextSettings(sessionId: string, settings: ClaudeSessionSettings): Promise<void> {
		if (!this._paneSessions.some(session => session.id === sessionId)) {
			throw new Error(localize('claudeSubmitClosed', "That agent session is not open."));
		}
		const next = readClaudeSessionSettings(settings);
		if (this._modelInfo.size === 0) {
			this.noteModels(await this._runtime.listModels());
			if (this._store.isDisposed) {
				return;
			}
		}
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (!session) {
			return;
		}
		const model = this.modelInfo(session.modelId);
		const problem = model ? claudeSettingsProblem(model, next) : undefined;
		if (problem) {
			throw new Error(problem);
		}
		const previous = this.getSessionSettings(sessionId);
		if (sameClaudeSessionSettings(previous, next)) {
			return;
		}
		// A level the user picks starts the next new session too. Max and Ultracode stay with this one.
		if (next.effort && !next.ultracode && (next.effort !== previous.effort || previous.ultracode) && CLAUDE_CONFIGURABLE_EFFORT_LEVELS.includes(next.effort)) {
			storeClaudeLastPick(this._storage, 'effort', next.effort);
		}
		this._sessionSettings.set(sessionId, next);
		this._autoSettings.delete(sessionId);
		this.fireSessionChange('settings');
	}

	getAutoModel(sessionId: string): ClaudeAutoModelState | undefined {
		return this._autoModel.get(sessionId);
	}

	setAutoModel(sessionId: string, on: boolean, remember = false): void {
		if (!this._paneSessions.some(session => session.id === sessionId)) {
			throw new Error(localize('claudeSubmitClosed', "That agent session is not open."));
		}
		if (remember) {
			// Issue 950: a pick of Auto in the model picker is what new chats start with, like any model.
			storeClaudeLastPick(this._storage, 'auto', on ? 'auto' : 'off');
		}
		if (this._autoModel.has(sessionId) === on) {
			return;
		}
		if (on) {
			this._autoModel.set(sessionId, {});
		} else {
			this._autoModel.delete(sessionId);
		}
		this._autoSettings.delete(sessionId);
		this.fireSessionChange('model');
	}

	/** Info for a model id, or for the runtime's default model when the id is absent. */
	private modelInfo(modelId: string | undefined): ClaudeModelInfo | undefined {
		return this._modelInfo.get(modelId ?? 'default');
	}

	private noteModels(models: readonly ClaudeModelInfo[]): void {
		for (const model of models) {
			this._modelNames.set(model.id, claudeModelDisplayName(model));
			this._modelInfo.set(model.id, model);
		}
	}

	/**
	 * What a turn on `modelId` runs with: the user's pick, or the configured
	 * defaults, fitted to the model. Configured defaults apply only to a model
	 * the runtime reported, so a setting never stops a turn on another model.
	 * A model that takes effort always gets an explicit level, so the user's own
	 * Claude Code `effortLevel` never decides it silently.
	 */
	private settingsFor(sessionId: string, modelId: string | undefined): ClaudeSessionSettings {
		const model = this.modelInfo(modelId);
		const picked = this._autoSettings.get(sessionId) ?? this._sessionSettings.get(sessionId);
		if (!model) {
			return picked ?? DEFAULT_CLAUDE_SESSION_SETTINGS;
		}
		const wanted = picked ?? this.configuredSettings(modelId);
		return fitClaudeSessionSettings(model, wanted.effort ? wanted : { ...wanted, effort: this.startEffort(modelId) });
	}

	/** The effort a session picks none for: `claude.models.effort` for the model, else the last level picked, else medium. */
	private startEffort(modelId: string | undefined): ClaudeEffortLevel {
		const last = readClaudeLastPick(this._storage, 'effort');
		const remembered = CLAUDE_CONFIGURABLE_EFFORT_LEVELS.find(level => level === last);
		return this.configuredSettings(modelId).effort ?? remembered ?? 'medium';
	}

	private configuredSettings(modelId: string | undefined): ClaudeSessionSettings {
		return readClaudeConfiguredSessionSettings(
			modelId,
			this._configuration?.getValue(CLAUDE_MODELS_EFFORT_SETTING),
			this._configuration?.getValue(CLAUDE_MODELS_FAST_MODE_SETTING),
			this._configuration?.getValue(CLAUDE_MODELS_ULTRACODE_SETTING),
		);
	}

	/**
	 * Lists what each model supports, once: every session resolves an effort
	 * for its model. True when this call noted a non-empty list.
	 */
	private async loadModelInfo(): Promise<boolean> {
		if (this._modelInfo.size > 0) {
			return false;
		}
		this._modelInfoLoad ??= (async () => {
			try {
				return await this._runtime.listModels();
			} catch {
				return [];
			}
		})();
		const load = this._modelInfoLoad;
		const models = await load;
		if (this._modelInfoLoad === load) {
			// An empty list (Claude Code not ready yet) lets the next call ask again.
			this._modelInfoLoad = undefined;
		}
		if (this._store.isDisposed || this._modelInfo.size > 0) {
			return false;
		}
		this.noteModels(models);
		return models.length > 0;
	}

	setMode(sessionId: string, mode: AgentMode): void {
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (!session) {
			throw new Error(localize('claudeSubmitClosed', "That agent session is not open."));
		}
		if (session.mode === mode) {
			return;
		}
		if (this.isRunning(sessionId)) {
			throw new Error(localize('claudeModeBusy', "Wait for the agent to finish or stop it before changing the mode."));
		}
		session.mode = mode;
		this.fireSessionChange('mode');
	}

	setExecutionTarget(sessionId: string, target: ClaudeExecutionTarget | undefined): void {
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (!session) {
			throw new Error(localize('claudeSubmitClosed', "That agent session is not open."));
		}
		if (session.claudeSessionId || this.isRunning(sessionId)) {
			throw new Error(localize('claudeTargetStarted', "This agent already started; start a new agent to run it somewhere else."));
		}
		session.executionTarget = target?.kind === 'local' ? undefined : target;
		this.fireSessionChange('target');
	}

	getSessionPermissions(sessionId: string): ClaudeSessionPermissions {
		return withClaudePermissionLevel(this._sessionPermissions.get(sessionId) ?? NO_SESSION_PERMISSIONS, this.permissionLevel());
	}

	setSessionPermissions(sessionId: string, permissions: ClaudeSessionPermissions): void {
		if (!this._paneSessions.some(candidate => candidate.id === sessionId)) {
			throw new Error(localize('claudeSubmitClosed', "That agent session is not open."));
		}
		const next: ClaudeSessionPermissions = { allowAllCommands: permissions.allowAllCommands, allowEverything: permissions.allowEverything };
		if ((next.allowAllCommands || next.allowEverything) && !this._trust.isWorkspaceTrusted()) {
			throw new Error(localize('claudeSwitchUntrusted', "Trust this workspace first. Allow All Commands and Allow Everything are not available in an untrusted workspace."));
		}
		const previous = this._sessionPermissions.get(sessionId) ?? NO_SESSION_PERMISSIONS;
		if (previous.allowAllCommands === next.allowAllCommands && previous.allowEverything === next.allowEverything) {
			return;
		}
		if (next.allowAllCommands || next.allowEverything) {
			this._sessionPermissions.set(sessionId, next);
		} else {
			this._sessionPermissions.delete(sessionId);
		}
		const runtimeId = this._paneToRuntime.get(sessionId);
		if (runtimeId) {
			// A turn that is waiting on a card sees the change at its next tool call.
			void this._runtime.setSessionPermissions?.(runtimeId, this.getSessionPermissions(sessionId))?.catch(error => this.append(formatClaudeAgentFailure(error instanceof Error ? error.message : String(error))));
		}
		this.fireSessionChange('permissions');
	}

	async buildPlan(sessionId: string, turnId: string, notes: string, cwd: string, compile?: (buildText: string) => Promise<string>, edited?: PlanArtifact): Promise<void> {
		cwd = this.workingDirectory(sessionId, cwd);
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (!session) {
			throw new Error(localize('claudeSubmitClosed', "That agent session is not open."));
		}
		const turns = this.getViewState(sessionId).turns;
		const last = turns[turns.length - 1];
		if (!last || last.id !== turnId || last.status !== 'complete' || !last.plan) {
			throw new Error(localize('claudeBuildNoPlan', "There is no finished plan to build."));
		}
		const plan = edited ? acceptEditedPlan(last.plan, edited) : last.plan;
		if (!plan) {
			throw new Error(localize('claudeBuildBadEdit', "The edited plan no longer matches the plan Claude wrote."));
		}
		const buildText = buildPlanPrompt(plan, notes, isPlanEdited(last.plan, plan));
		const compiled = compile ? await compile(buildText) : buildText;
		if (this._store.isDisposed || !this._paneSessions.includes(session) || this.getViewState(sessionId).turns[turns.length - 1] !== last) {
			return;
		}
		// Pressing Build is the user's explicit choice to leave Plan, so the pill shows Agent.
		this.setMode(sessionId, 'agent');
		// The message shows the notes the user typed under the plan title, not the whole build prompt (issue 320).
		const shownNotes = notes.trim();
		const label = shownNotes
			? localize('claudeBuildLabelWithNotes', "Build: {0}\n{1}", plan.title, shownNotes)
			: localize('claudeBuildLabel', "Build: {0}", plan.title);
		await this.submit(sessionId, buildText, cwd, { compiled, label, keepDraft: true });
	}

	async writePlanFile(sessionId: string, turnId: string, target: URI, notes: string, edited?: PlanArtifact): Promise<void> {
		const turn = this.getViewState(sessionId).turns.find(candidate => candidate.id === turnId);
		const original = turn?.plan;
		if (!turn || !original) {
			throw new Error(localize('claudeSaveNoPlan', "That turn has no plan to save."));
		}
		const plan = edited ? acceptEditedPlan(original, edited) : original;
		if (!plan) {
			throw new Error(localize('claudeBuildBadEdit', "The edited plan no longer matches the plan Claude wrote."));
		}
		const source = turnParts(turn).map(part => part.kind === 'plan' ? part.text : '').join('\n');
		await this._files.writeFile(target, VSBuffer.fromString(planToMarkdown(plan, notes, source)));
	}

	override dispose(): void {
		for (const session of this._paneSessions) {
			this.flushDisk(session);
			this.flushMeta(session);
		}
		const owned = [...this._ownedSessions, ...this._runtimeToPane.keys()];
		this._ownedSessions.clear();
		this._runtimeToPane.clear();
		this._paneToRuntime.clear();
		this._bufferedEvents.clear();
		this._lastEventAt.clear();
		this._inlineTurns.clear();
		this._beginsInFlight = 0;
		for (const sessionId of owned) {
			void this._runtime.disposeSession(sessionId);
		}
		super.dispose();
	}

	/**
	 * Starts one session in `cwd`. The fake runtime replays `test-session`.
	 * The live runtime ignores that fixture and sends the prompt to Claude.
	 */
	async runTestSession(cwd: string): Promise<ClaudeRunHandle> {
		this._beginsInFlight++;
		try {
			const state = await this._runtime.ensureRuntime();
			this.logState(state);
			const handle = await this._runtime.begin({
				prompt: 'Reply with the single word ok.',
				cwd,
				mode: 'agent',
				workspaceFolders: this.workspaceFolders(),
				workspaceTrusted: this._trust.isWorkspaceTrusted(),
				fixture: CLAUDE_TEST_SESSION_FIXTURE,
			});
			if (this._store.isDisposed) {
				void this._runtime.disposeSession(handle.sessionId);
				throw new Error('Claude agent service is disposed.');
			}
			this._ownedSessions.add(handle.sessionId);
			this.drain(handle.sessionId);
			return handle;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.append(formatClaudeAgentFailure(message));
			throw error;
		} finally {
			this._beginsInFlight--;
			if (this._beginsInFlight === 0) {
				this._bufferedEvents.clear();
			}
		}
	}

	getRuntimeSessionId(sessionId: string): string | undefined {
		return this._paneToRuntime.get(sessionId);
	}

	getViewState(sessionId: string): AgentViewState {
		return this._viewStates.get(sessionId) ?? EMPTY_AGENT_VIEW_STATE;
	}

	getSentAttachments(sessionId: string): readonly ContextAttachment[] {
		return this._lastSubmitted.get(sessionId)?.attachments ?? [];
	}

	setAttachments(sessionId: string, attachments: readonly ContextAttachment[]): void {
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (!session) {
			return;
		}
		session.attachments = attachments.slice();
		this.fireSessionChange('context');
	}

	addAdditionalDirectory(sessionId: string, directory: string): void {
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (!session || session.additionalDirectories.includes(directory)) {
			return;
		}
		session.additionalDirectories = [...session.additionalDirectories, directory];
		this.fireSessionChange('context');
	}

	async submit(sessionId: string, text: string, cwd: string, options?: ClaudeSubmitOptions): Promise<void> {
		cwd = this.workingDirectory(sessionId, cwd);
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (!session) {
			throw new Error(localize('claudeSubmitClosed', "That agent session is not open."));
		}
		this.assertAgentEnabled();
		const visible = (options?.label ?? text).trim();
		let prompt = (options?.compiled ?? text).trim();
		if (!prompt) {
			throw new Error(localize('claudeSubmitEmpty', "Write a message first."));
		}
		if (this.isRunning(sessionId)) {
			throw new ClaudeTurnBusyError();
		}
		if (session.pendingEdit) {
			// The stopped turn is replaced by the edited prompt, like Edit (issue 1178).
			const stoppedTurnId = session.pendingEdit;
			const keptFiles = session.pendingEditKept;
			session.pendingEdit = undefined;
			session.pendingEditKept = undefined;
			if (this.getViewState(sessionId).turns.at(-1)?.id === stoppedTurnId && this.canRewind(sessionId, stoppedTurnId).enabled) {
				// Messages queued during the stopped turn are not lost by the rewind (issue 1178).
				const queued = [...(this._pending.get(sessionId) ?? [])];
				await this.rewind(sessionId, stoppedTurnId, keptFiles);
				if (queued.length > 0) {
					this._pending.set(sessionId, queued);
					this.firePending(sessionId);
				}
			}
		}
		if (!session.loaded) {
			// A tab restored after a restart has not read its transcript yet. The new turn goes after it.
			await this.ensureLoaded(sessionId);
			if (!this._paneSessions.includes(session)) {
				throw new Error(localize('claudeSubmitClosed', "That agent session is not open."));
			}
		}
		if (session.forkContext && !session.claudeSessionId) {
			// A fork starts a new Claude session. Its summary goes ahead of the message; the turn shows only what the user wrote.
			prompt = `${session.forkContext}\n\n${prompt}`;
		}
		if (session.rewindNote) {
			// Kept files after a rewind: Claude hears about them; the turn shows only what the user wrote.
			prompt = `${session.rewindNote}\n\n${prompt}`;
		}
		if (!options?.keepDraft) {
			session.draft = '';
			session.attachments = [];
		}
		const explicitModel = options?.modelId?.trim()
			|| (options?.origin === 'inline-edit' ? readClaudeModelId(this._configuration?.getValue(CLAUDE_INLINE_EDIT_MODEL_SETTING)) : undefined);
		// Auto routes plain prompts (issue 521). A slash command stays on the model Auto last ran.
		const routable = !explicitModel && !prompt.startsWith('/');
		// With delegation, Auto never moves the chat off its model, so a command stays on it too (issue 693).
		const modelOverride = explicitModel || (routable || this._delegateHandler ? undefined : this._autoModel.get(sessionId)?.last?.modelId);
		const images = sentImages(options?.attachments);
		const chips = sentChips(options?.attachments);
		const sent: SentPromptRecord = {
			compiled: prompt,
			resolution: options?.resolution,
			modelId: modelOverride ?? session.modelId,
			mode: session.mode,
			additionalDirectories: this.directoriesForTurn(session).slice(),
			...(images ? { images } : {}),
			...(chips ? { chips } : {}),
		};
		this.fireSessionChange('context');
		// A message of images alone shows its images, not the compiled prompt that carries them (issue 744).
		await this.startTurn(session, visible || (images ? '' : prompt), prompt, cwd, sent, options?.attachments, options?.checkpointBuffers, modelOverride, options?.origin, routable);
	}

	getPending(sessionId: string): readonly PendingInput[] {
		return (this._pending.get(sessionId) ?? []).map(item => this.pendingSnapshot(item));
	}

	async queue(sessionId: string, text: string, cwd: string, behavior: PendingInput['behavior'], options?: ClaudeSubmitOptions): Promise<PendingInput> {
		this.assertAgentEnabled();
		cwd = this.workingDirectory(sessionId, cwd);
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (!session) {
			throw new Error(localize('claudeSubmitClosed', "That agent session is not open."));
		}
		const visible = (options?.label ?? text).trim();
		const prompt = (options?.compiled ?? text).trim();
		if (!prompt) {
			throw new Error(localize('claudeSubmitEmpty', "Write a message first."));
		}
		const item = this.storePending(session, visible || prompt, prompt, cwd, behavior, options);
		if (!this.isRunning(sessionId)) {
			await this.submit(sessionId, item.text, cwd, { compiled: item.compiled, label: item.text, keepDraft: options?.keepDraft, resolution: options?.resolution, attachments: item.attachments, checkpointBuffers: options?.checkpointBuffers });
			return this.pendingSnapshot(item);
		}
		if (behavior === 'steer') {
			const runtimeId = this._paneToRuntime.get(sessionId);
			const delivered = runtimeId ? await this._runtime.steer(runtimeId, prompt) : false;
			if (!delivered || this._store.isDisposed || !this._paneSessions.includes(session)) {
				throw new Error(localize('claudeSteerUnavailable', "Steer now is not available for this turn."));
			}
			this.dispatch(sessionId, { type: 'turn.steered', text: visible || prompt });
			this.clearComposer(session, options);
			return this.pendingSnapshot(item);
		}
		const list = this._pending.get(sessionId) ?? [];
		list.push(item);
		this._pending.set(sessionId, list);
		this.clearComposer(session, options);
		this.firePending(sessionId);
		return this.pendingSnapshot(item);
	}

	async remind(sessionId: string, text: string): Promise<boolean> {
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		const runtimeId = this._paneToRuntime.get(sessionId);
		if (!session || !runtimeId || !this.isRunning(sessionId) || !text.trim()) {
			return false;
		}
		return this._runtime.steer(runtimeId, text.trim());
	}

	updatePending(sessionId: string, id: string, text: string, compiled?: string): boolean {
		const next = text.trim();
		const item = next ? this._pending.get(sessionId)?.find(candidate => candidate.id === id) : undefined;
		if (!item) {
			return false;
		}
		item.text = next;
		item.compiled = compiled?.trim() || undefined;
		this.firePending(sessionId);
		return true;
	}

	removePending(sessionId: string, id: string): void {
		const list = this._pending.get(sessionId);
		if (!list) {
			return;
		}
		const index = list.findIndex(item => item.id === id);
		if (index < 0) {
			return;
		}
		list.splice(index, 1);
		if (list.length === 0) {
			this._pending.delete(sessionId);
		}
		this.firePending(sessionId);
	}

	async sendQueuedNow(sessionId: string): Promise<boolean> {
		const list = this._pending.get(sessionId);
		const next = list?.[0];
		if (!list || !next || this._flushing.has(sessionId)) {
			return false;
		}
		// Taken out first so the stop cannot flush it a second time.
		list.shift();
		if (list.length === 0) {
			this._pending.delete(sessionId);
		}
		this.firePending(sessionId);
		this._flushing.add(sessionId);
		try {
			await this.stop(sessionId);
		} catch (error) {
			this._flushing.delete(sessionId);
			list.unshift(next);
			this._pending.set(sessionId, list);
			this.firePending(sessionId);
			throw error;
		}
		await this.dispatchPending(sessionId, next);
		return true;
	}

	supportsSteer(sessionId: string): Promise<boolean> {
		const runtimeId = this._paneToRuntime.get(sessionId);
		if (!runtimeId || !this.isRunning(sessionId)) {
			return Promise.resolve(false);
		}
		return this._runtime.canSteer(runtimeId);
	}

	isWorking(sessionId: string): boolean {
		return this.isRunning(sessionId) || hasLiveChildren(this.getViewState(sessionId));
	}

	async stop(sessionId: string): Promise<void> {
		// Stop on a chat stops every delegated chat under it, without a question (issue 693).
		this._delegateHandler?.stopUnder(sessionId, false);
		// Until the user sends again, late work from this chat's children is dropped (issue 1617).
		this._stoppedPanes.add(sessionId);
		if (!this.isRunning(sessionId)) {
			// The head turn is over, so only its running children are left: stop each one like its row's stop square.
			for (const subagent of this.getViewState(sessionId).subagents) {
				if (subagent.run.state === 'running') {
					void this.stopSubagent(sessionId, subagent.run.id).catch(() => undefined);
				}
			}
			return;
		}
		// The runtime emits no terminal event after interrupt(), so Stop ends the
		// turn itself as `stopped`. The Claude session is discarded because its
		// state after an interrupt is not something the pane can rely on.
		this.bumpToken(sessionId);
		const runtimeId = this.unmapRuntime(sessionId);
		this.dispatch(sessionId, { type: 'turn.stopped' });
		if (runtimeId) {
			await this.interruptAndDispose(runtimeId, true);
		}
	}

	async stopAndTakeBack(sessionId: string, resolveChanges?: (turnId: string) => Promise<readonly string[] | undefined>): Promise<boolean> {
		const turn = this.getViewState(sessionId).turns.at(-1);
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (!session || !turn || turn.status !== 'running' || this._lastSubmitted.get(sessionId)?.turnId !== turn.id || !this.canRewind(sessionId, turn.id).enabled) {
			await this.stop(sessionId);
			return false;
		}
		const attachments = this._lastSubmitted.get(sessionId)?.attachments ?? [];
		const hadOutput = !claudeTurnHasNoOutput(turn);
		await this.stop(sessionId);
		if (hadOutput) {
			// Partial output stays until the edited prompt is sent. A turn that changed files asks Keep or Undo first.
			let kept: readonly string[] = [];
			if ((await this._checkpoints.readTurnsChanges(sessionId, [turn.id])).length > 0) {
				const answer = await resolveChanges?.(turn.id);
				if (!answer) {
					return false;
				}
				kept = answer;
			}
			session.pendingEdit = turn.id;
			session.pendingEditKept = kept;
		} else {
			await this.rewind(sessionId, turn.id);
		}
		// Whatever the user already typed for the next message stays after the restored one.
		const typed = session.draft.trim();
		session.draft = typed ? `${turn.user.text}

${session.draft}` : turn.user.text;
		session.attachments = [...attachments, ...session.attachments];
		this.fireSessionChange('restored');
		return true;
	}

	pendingEditTurnId(sessionId: string): string | undefined {
		return this._paneSessions.find(candidate => candidate.id === sessionId)?.pendingEdit;
	}

	discardPendingEdit(sessionId: string): void {
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (session?.pendingEdit) {
			session.pendingEdit = undefined;
			session.pendingEditKept = undefined;
			this.fireSessionChange('context');
		}
	}

	async stopSubagent(sessionId: string, runId: string): Promise<void> {
		const runtimeId = this.getRuntimeSessionId(sessionId);
		if (!runtimeId) {
			throw new Error(localize('claudeSubagentNoSession', "The agent session has ended."));
		}
		await this._runtime.interruptSubagent(runtimeId, runId);
	}

	getSessionEvents(sessionId: string): readonly AgentReducerEvent[] {
		return this._eventLog.get(sessionId) ?? [];
	}

	getRawSdkMessages(sessionId: string): readonly unknown[] {
		return this._rawLog.get(sessionId) ?? [];
	}

	getInspectorRevision(sessionId: string): number {
		return this._inspectorRevision.get(sessionId) ?? 0;
	}

	recordCommandRerun(sessionId: string, command: string, cwd: string | undefined, allowed: boolean, source: 'user' | 'policy', reason?: string): void {
		if (!this._paneSessions.some(session => session.id === sessionId)) {
			return;
		}
		this.dispatch(sessionId, { type: 'command.rerun', command, cwd, allowed, source, reason });
	}

	setSessionAccount(sessionId: string, accountId: string | undefined): void {
		if (accountId === undefined) {
			this._sessionAccounts.delete(sessionId);
		} else {
			this._sessionAccounts.set(sessionId, accountId);
		}
	}

	getSessionAccount(sessionId: string): string | undefined {
		return this._sessionAccounts.get(sessionId);
	}

	setSessionLimitPolicy(sessionId: string, policy: ClaudeLimitPolicy | undefined): void {
		if (policy === undefined) {
			this._sessionLimitPolicies.delete(sessionId);
		} else {
			this._sessionLimitPolicies.set(sessionId, policy);
		}
	}

	getSessionLimitPolicy(sessionId: string): ClaudeLimitPolicy | undefined {
		return this._sessionLimitPolicies.get(sessionId);
	}

	async retry(sessionId: string, cwd: string, accountId?: string): Promise<void> {
		this.assertAgentEnabled();
		if (accountId !== undefined) {
			this.setSessionAccount(sessionId, accountId);
		}
		cwd = this.workingDirectory(sessionId, cwd);
		const turns = this.getViewState(sessionId).turns;
		const last = turns[turns.length - 1];
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (!session || !last || (last.status !== 'failed' && last.status !== 'stopped')) {
			return;
		}
		await this.startTurn(session, last.user.text, last.user.sent?.compiled ?? last.user.text, cwd, last.user.sent);
	}

	attachDurableHistory(store: JsonlSessionStore, reveal?: (path: string) => Promise<void>): void {
		this._history = store;
		this._revealWorktree = reveal;
		this._chatSearch.value = new ClaudeChatSearchIndex(store);
	}

	async searchChats(query: string): Promise<readonly ClaudeChatSearchHit[]> {
		const search = this._chatSearch.value;
		if (!search) {
			return [];
		}
		const sessions = [...this._historyRecords.values()]
			.filter(record => !this._deletedSessions.has(record.id))
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map(record => ({ id: record.id, updatedAt: record.updatedAt }));
		return search.search(query, sessions);
	}

	async syncExternalHistory(sessionId: string): Promise<void> {
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (!this._history || !session?.loaded || this.isRunning(sessionId)) {
			return;
		}
		const known = this._diskEvents.get(sessionId) ?? [];
		const lines = await this._history.read(sessionId);
		const replay = replayDurableEvents(lines.map(line => line.event as AgentReducerEvent));
		// A turn started here while the file was being read owns the state; the next change picks the rest up.
		if (replay.events.length <= known.length || this.isRunning(sessionId) || (this._diskEvents.get(sessionId)?.length ?? 0) !== known.length) {
			return;
		}
		this._diskEvents.set(sessionId, replay.events.slice());
		this._eventLog.set(sessionId, replay.events.slice(-CLAUDE_EVENT_LOG_CAP));
		this._viewStates.set(sessionId, replay.state);
		this.bumpInspector(sessionId);
		if (!this._store.isDisposed) {
			this._onDidChangeViewState.fire({ sessionId });
		}
	}

	async loadDurableHistory(): Promise<void> {
		if (!this._history) {
			return;
		}
		const index = await this._history.readIndex();
		for (const record of index.sessions) {
			if (!this._historyRecords.has(record.id)) {
				this._historyRecords.set(record.id, record);
			}
		}
		const workspaceId = this.workspaceIdentity().id;
		// Only the chats that were open tabs in this workspace come back. Closed ones stay in history.
		const restored = index.sessions
			.filter(record => record.open === true && record.workspaceId === workspaceId && !!record.firstUser && !this._paneSessions.some(session => session.id === record.id))
			.map(record => this.sessionFromRecord(record));
		for (const session of restored) {
			void this.primeCommands(session);
		}
		if (restored.length === 0) {
			this.fireSessionChange('history');
			return;
		}
		const current = this.currentMutable();
		const replace = current && this._paneSessions.length === 1 && this.isPristine(current) ? current : undefined;
		// Oldest on the left; the chat used last is selected.
		const last = restored[0];
		this._paneSessions.push(...this.applyTabOrder(restored.reverse()));
		if (!this._currentSessionId || replace) {
			this._currentSessionId = last.id;
		}
		if (replace) {
			// An empty chat the pane opened before history loaded gives way to the restored ones.
			void this.deleteSession(replace.id);
		}
		this.fireSessionChange('created');
		this.loadInBackground(this._currentSessionId);
	}

	/** A chat with no turns, no draft and no attachments: nothing is lost when it closes. */
	private isPristine(session: MutablePaneSession): boolean {
		return session.loaded && !session.claudeSessionId && !session.draft.trim() && session.attachments.length === 0 && this.getViewState(session.id).turns.length === 0;
	}

	private loadInBackground(sessionId: string | undefined): void {
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (session && !session.loaded) {
			void this.ensureLoaded(session.id).catch(error => {
				this.append(formatClaudeAgentFailure(error instanceof Error ? error.message : String(error)));
			});
		}
	}

	/** Saves a tab that is closing as closed, so a restart does not reopen it. */
	private saveClosed(session: MutablePaneSession): void {
		const handle = this._metaTimers.get(session.id);
		if (handle) {
			clearTimeout(handle);
			this._metaTimers.delete(session.id);
		}
		if (!this._history || this._deletedSessions.has(session.id)) {
			return;
		}
		if (session.loaded) {
			void this.persistMeta(session, false);
		} else {
			const known = this._historyRecords.get(session.id);
			const record = known && { ...known, open: false, pinned: session.pinned || undefined, archived: session.archived || undefined };
			if (record) {
				this._historyRecords.set(session.id, record);
			}
			// The transcript is not read, so only the index record changes. A pin or archive goes with it.
			const flagsChanged = !!known && (!!known.pinned !== !!session.pinned || !!known.archived !== !!session.archived);
			const history = this._history;
			const run = () => record && flagsChanged ? history.upsertIndex(record) : history.setOpen(session.id, false);
			const next = this._indexTail.then(run, run);
			this._indexTail = next.then(() => undefined, () => undefined);
		}
	}

	async resume(sessionId: string): Promise<void> {
		await this.ensureLoaded(sessionId);
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (!session) {
			throw new Error(localize('claudeSubmitClosed', "That agent session is not open."));
		}
		this._currentSessionId = sessionId;
		this.fireSessionChange('selected');
		if (session.archived) {
			// Opening an archived chat brings it back.
			session.archived = false;
			this.fireSessionChange('history');
			this.flushMeta(session);
		}
	}

	async renameSession(sessionId: string, title: string): Promise<void> {
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		const next = title.trim();
		if (!next) {
			return;
		}
		if (!session) {
			this.renameClosed(sessionId, next);
			return;
		}
		session.title = next;
		session.titleIsDefault = false;
		session.titleFromPrompt = false;
		this.fireSessionChange('context');
		this.flushMeta(session);
	}

	setPinned(sessionId: string, pinned: boolean): void {
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (!session) {
			this.updateClosed(sessionId, { pinned: pinned || undefined });
			return;
		}
		if (!!session.pinned === pinned) {
			return;
		}
		session.pinned = pinned;
		this.fireSessionChange('history');
		this.flushMeta(session);
	}

	setPinnedCommand(sessionId: string, command: string | undefined): void {
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		const name = command?.trim().replace(/^\//, '') || undefined;
		if (!session || session.pinnedCommand === name) {
			return;
		}
		session.pinnedCommand = name;
		this.fireSessionChange('context');
		this.flushMeta(session);
	}

	setArchived(sessionId: string, archived: boolean): void {
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (!session) {
			this.updateClosed(sessionId, { archived: archived || undefined });
			return;
		}
		if (!!session.archived === archived) {
			return;
		}
		session.archived = archived;
		if (archived) {
			// An archived chat leaves the tabs. Closing it saves the flag.
			this.closeSession(sessionId);
			this.fireSessionChange('history');
			return;
		}
		this.fireSessionChange('history');
		this.flushMeta(session);
	}

	/** Renames a chat that is in history but not open. Only its index record changes. */
	private renameClosed(sessionId: string, title: string): void {
		this.updateClosed(sessionId, { title });
	}

	/** Changes the index record of a chat that is in history but not open. */
	private updateClosed(sessionId: string, patch: Partial<Pick<SessionIndexRecord, 'title' | 'pinned' | 'archived'>>): void {
		const known = this._historyRecords.get(sessionId);
		if (!known || !this._history || this._deletedSessions.has(sessionId)) {
			return;
		}
		const record: SessionIndexRecord = { ...known, ...patch };
		this._historyRecords.set(sessionId, record);
		const history = this._history;
		const run = () => history.upsertIndex(record);
		const next = this._indexTail.then(run, run);
		this._indexTail = next.then(() => undefined, () => undefined);
		this.fireSessionChange('history');
	}

	async deleteSession(sessionId: string): Promise<void> {
		const wasOpen = this._paneSessions.some(session => session.id === sessionId);
		this._deletedSessions.add(sessionId);
		this._historyRecords.delete(sessionId);
		this._chatSearch.value?.remove(sessionId);
		const meta = this._metaTimers.get(sessionId);
		if (meta) {
			clearTimeout(meta);
		}
		this._metaTimers.delete(sessionId);
		const disk = this._diskTimers.get(sessionId);
		if (disk) {
			clearTimeout(disk);
		}
		this._diskTimers.delete(sessionId);
		this._diskBuffers.delete(sessionId);
		this.closeSession(sessionId);
		this._diskEvents.delete(sessionId);
		if (!wasOpen) {
			this.fireSessionChange('history');
		}
		await this._history?.deleteSession(sessionId);
	}

	getTurnAttachments(sessionId: string, turnId: string): readonly ContextAttachment[] {
		return this._turnAttachments.get(sessionId)?.get(turnId) ?? [];
	}

	canRewind(sessionId: string, turnId: string): { readonly enabled: boolean; readonly reason?: string } {
		const check = claudeRewindCheck(this._diskEvents.get(sessionId) ?? [], this.getViewState(sessionId), turnId);
		return check.enabled ? { enabled: true } : { enabled: false, reason: check.reason };
	}

	async rewind(sessionId: string, turnId: string, keptFiles?: readonly string[]): Promise<void> {
		const session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (!session) {
			throw new Error(localize('claudeRewindClosed', "That agent session is not open."));
		}
		if (this.isRunning(sessionId)) {
			await this.stop(sessionId);
		}
		const check = claudeRewindCheck(this._diskEvents.get(sessionId) ?? [], this.getViewState(sessionId), turnId);
		if (!check.enabled) {
			throw new Error(check.reason);
		}
		const dropped = claudeRewindTurnIds(this.getViewState(sessionId), turnId);
		this.dispatch(sessionId, { type: 'turn.rewound', turnId });
		// The next message opens a new query: a copy of Claude Code's conversation cut after the kept reply.
		const runtimeId = this.unmapRuntime(sessionId);
		if (runtimeId) {
			void this._runtime.disposeSession(runtimeId);
		}
		session.claudeSessionId = check.target.claudeSessionId;
		session.resumeAt = check.target.anchor;
		session.resumeBlocked = false;
		session.resumeFailed = false;
		session.forkContext = undefined;
		session.rewindNote = claudeRewindNote(keptFiles ?? []);
		session.checkpointIds = session.checkpointIds.filter(id => !dropped.includes(id));
		this._pending.delete(sessionId);
		this.firePending(sessionId);
		this._delegateNotes.delete(sessionId);
		this.fireSessionChange('context');
		this.flushMeta(session);
	}

	async forkSession(sessionId: string, fromTurnId: string): Promise<string> {
		// The source session is read now; it closes again if it was not an open tab.
		const { source, sliced } = await this.borrowSession(sessionId, source => ({ source, sliced: eventsThroughTurn(this._diskEvents.get(sessionId) ?? [], fromTurnId) }));
		if (sliced.length === 0) {
			throw new Error(localize('claudeForkMissing', "That turn is not in the session."));
		}
		const replay = replayDurableEvents(sliced);
		const created = this.createSession();
		const session = this._paneSessions.find(candidate => candidate.id === created.id);
		if (!session) {
			return created.id;
		}
		session.title = localize('claudeForkTitle', "Fork: {0}", source.title);
		session.titleIsDefault = false;
		session.mode = source.mode;
		session.claudeSessionId = undefined;
		session.checkpointIds = [];
		session.interrupted = replay.interrupted;
		this._diskEvents.set(session.id, []);
		this._eventLog.set(session.id, []);
		this._viewStates.set(session.id, EMPTY_AGENT_VIEW_STATE);
		const turnIds: string[] = [];
		for (const event of replay.events) {
			this.dispatch(session.id, event);
			if (event.type === 'turn.submitted' && !turnIds.includes(event.turnId)) {
				turnIds.push(event.turnId);
			}
		}
		session.claudeSessionId = undefined;
		session.resumeBlocked = false;
		session.resumeFailed = false;
		session.checkpointIds = turnIds.slice();
		if (this._history && turnIds.length) {
			await this._history.copyForkArtifacts(sessionId, session.id, turnIds);
		}
		const state = this.getViewState(session.id);
		const last = [...state.turns].reverse().find(turn => turn.assistantText.trim());
		session.forkContext = forkSessionSeed({
			title: source.title,
			workspaceName: source.workspaceName,
			firstUser: state.turns[0]?.user.text ?? '',
			finalAssistant: last?.assistantText ?? '',
			changedFiles: [...new Set(state.turns.flatMap(turn => [...turn.changedFiles]))],
		});
		this.fireSessionChange('created');
		this.flushMeta(session);
		return session.id;
	}

	async exportSession(sessionId: string, format: 'markdown' | 'json', raw = false): Promise<string> {
		const exported = await this.borrowSession(sessionId, session => exportTranscript(this.getViewState(sessionId), session.title, { raw }));
		return format === 'json' ? exported.json : exported.markdown;
	}

	async writeExportedTranscript(sessionId: string, format: 'markdown' | 'json', target: URI, raw = false): Promise<void> {
		const text = await this.exportSession(sessionId, format, raw);
		await this._files.writeFile(target, VSBuffer.fromString(text));
	}

	async revealWorktree(sessionId: string): Promise<void> {
		const open = this._paneSessions.find(candidate => candidate.id === sessionId);
		// A chat that is not open is read from the index, so revealing its worktree does not open it.
		const worktreePath = open ? open.worktreePath : (await this._history?.readIndex())?.sessions.find(record => record.id === sessionId)?.worktree?.path;
		if (!worktreePath || !this._revealWorktree) {
			throw new Error(localize('claudeNoWorktree', "This session has no worktree to reveal."));
		}
		await this._revealWorktree(worktreePath);
	}

	async continueInNewSession(sessionId: string): Promise<string> {
		const { source, summary } = await this.borrowSession(sessionId, source => ({ source, summary: continueSummaryFor(this.getViewState(sessionId), source.title, source.workspaceName) }));
		const created = this.createSession();
		this.setDraft(created.id, summary);
		const session = this._paneSessions.find(candidate => candidate.id === created.id);
		if (session) {
			session.title = localize('claudeContinueTitle', "Continue: {0}", source.title);
			session.titleIsDefault = false;
		}
		this.fireSessionChange('created');
		return created.id;
	}

	async referenceInNewSession(sessionId: string, options?: { readonly turnId?: string; readonly subagentId?: string }): Promise<string> {
		const { source, state } = await this.borrowSession(sessionId, source => ({ source, state: this.getViewState(sessionId) }));
		const turnIndex = options?.turnId ? state.turns.findIndex(turn => turn.id === options.turnId) : state.turns.length - 1;
		const asOfTurn = Math.max(1, turnIndex + 1);
		const created = this.createSession();
		const attachment: ContextAttachment = {
			kind: 'chat',
			sessionId,
			subagentId: options?.subagentId,
			turnRange: options?.turnId ? [asOfTurn, asOfTurn] : [1, asOfTurn],
			scope: 'summary',
			asOfTurn,
			title: source.title,
			workspaceId: source.workspaceId,
			workspaceName: source.workspaceName,
		};
		this.setAttachments(created.id, [attachment]);
		return created.id;
	}

	async openClaudeCodeSession(claudeSessionId: string, title?: string): Promise<{ readonly sessionId: string; readonly adopted: boolean }> {
		const open = this._paneSessions.find(session => session.claudeSessionId === claudeSessionId);
		if (open) {
			await this.resume(open.id);
			return { sessionId: open.id, adopted: false };
		}
		// The index is read too: a window opened for this session may not have loaded its history yet.
		const indexed = this._history ? (await this._history.readIndex()).sessions : [];
		const saved = [...this._historyRecords.values(), ...indexed]
			.filter(record => record.claudeSessionId === claudeSessionId && !this._deletedSessions.has(record.id))
			.sort((a, b) => b.updatedAt - a.updatedAt)[0];
		if (saved) {
			await this.resume(saved.id);
			return { sessionId: saved.id, adopted: false };
		}
		// Claude Code keeps the transcript; this tab only holds the id its next message resumes.
		const created = this.createSession();
		const session = this._paneSessions.find(candidate => candidate.id === created.id);
		if (session) {
			session.claudeSessionId = claudeSessionId;
			session.title = title ?? localize('claudeFromAgentsWindowTitle', "From the Agents Window");
			session.titleIsDefault = false;
			this.fireSessionChange('context');
			this.flushMeta(session);
		}
		return { sessionId: created.id, adopted: true };
	}

	listChatMentions(query: string): readonly { readonly id: string; readonly title: string; readonly detail: string; readonly attachment: ContextAttachment }[] {
		const items = [];
		for (const session of this._paneSessions) {
			const state = this.getViewState(session.id);
			const first = state.turns[0]?.user.text ?? '';
			const files = state.turns.flatMap(turn => turn.changedFiles).join(' ');
			const hay = `${session.title} ${first} ${files}`;
			if (rankContextCandidate(query, hay) === 0 && query.trim()) {
				continue;
			}
			const asOfTurn = Math.max(1, state.turns.length);
			items.push({
				id: session.id,
				title: session.title,
				detail: `${session.workspaceName} ${state.turns[0]?.user.text ?? ''} ${state.turns.flatMap(turn => turn.changedFiles).join(' ')}`,
				attachment: {
					kind: 'chat' as const,
					sessionId: session.id,
					scope: 'summary' as const,
					asOfTurn,
					turnRange: [1, asOfTurn] as [number, number],
					title: session.title,
					workspaceId: session.workspaceId,
					workspaceName: session.workspaceName,
				},
			});
		}
		// Closed chats are matched on what the index saved about them.
		for (const record of this.closedRecords()) {
			const files = (record.changedFiles ?? []).join(' ');
			if (rankContextCandidate(query, `${record.title} ${record.firstUser ?? ''} ${files}`) === 0 && query.trim()) {
				continue;
			}
			const workspaceName = recordWorkspaceName(record);
			const asOfTurn = Math.max(1, record.turnCount ?? record.checkpointIds?.length ?? 1);
			items.push({
				id: record.id,
				title: record.title,
				detail: `${workspaceName} ${record.firstUser ?? ''} ${files}`,
				attachment: {
					kind: 'chat' as const,
					sessionId: record.id,
					scope: 'summary' as const,
					asOfTurn,
					turnRange: [1, asOfTurn] as [number, number],
					title: record.title,
					workspaceId: record.workspaceId,
					workspaceName,
				},
			});
		}
		return items;
	}

	async prepareChatReference(composerSessionId: string, attachment: Extract<ContextAttachment, { kind: 'chat' }>, summaryChars = CLAUDE_CHAT_REFERENCE_SUMMARY_DEFAULT): Promise<ChatReferenceInput> {
		const composer = this._paneSessions.find(candidate => candidate.id === composerSessionId);
		const missing: ChatReferenceInput = {
			title: attachment.title ?? attachment.sessionId,
			sessionId: attachment.sessionId,
			turnStart: attachment.turnRange?.[0] ?? 1,
			turnEnd: attachment.turnRange?.[1] ?? attachment.asOfTurn,
			asOfTurn: attachment.asOfTurn,
			path: '',
			summary: '',
			scope: attachment.scope,
			deleted: true,
			workspaceName: attachment.workspaceName,
			otherWorkspace: false,
		};
		if (!composer || !this._history) {
			return missing;
		}
		let borrowed: { source: MutablePaneSession; state: AgentViewState };
		try {
			borrowed = await this.borrowSession(attachment.sessionId, source => ({ source, state: this.getViewState(attachment.sessionId) }));
		} catch {
			return missing;
		}
		const { source, state } = borrowed;
		const turnRange = attachment.turnRange ?? [1, attachment.asOfTurn] as [number, number];
		const exported = exportTranscript(state, source.title, {
			summaryChars,
			asOfTurn: attachment.asOfTurn,
			turnRange,
			subagentId: attachment.subagentId,
		});
		const spec: ChatReferenceFileSpec = {
			asOfTurn: attachment.asOfTurn,
			turnStart: turnRange[0],
			scope: attachment.scope,
			subagentId: attachment.subagentId,
		};
		const path = this._history.referencePath(attachment.sessionId, spec);
		await this._history.writeReference(attachment.sessionId, spec, exported.markdown);
		if (!composer.additionalDirectories.includes(path)) {
			composer.additionalDirectories = [...composer.additionalDirectories, path];
			this.fireSessionChange('context');
		}
		const place = this.workspaceIdentity();
		return {
			title: source.title,
			sessionId: source.id,
			turnStart: turnRange[0],
			turnEnd: turnRange[1],
			asOfTurn: attachment.asOfTurn,
			path,
			summary: exported.summary,
			fullTranscript: exported.markdown,
			scope: attachment.scope,
			deleted: false,
			workspaceName: source.workspaceName,
			otherWorkspace: source.workspaceId !== place.id,
		};
	}

	private async startTurn(session: MutablePaneSession, visible: string, prompt: string, cwd: string, sent?: SentPromptRecord, attachments?: readonly ContextAttachment[], checkpointBuffers?: readonly { readonly path: string; readonly text: string }[], modelOverride?: string, origin?: ClaudeSubmitOptions['origin'], routable?: boolean): Promise<void> {
		// A retry keeps the mode the turn first ran in.
		const mode = sent?.mode ?? session.mode;
		const turnId = `turn-${++this._turnSerial}`;
		const autoOn = routable && this._autoModel.has(session.id);
		const previousFailed = this._viewStates.get(session.id)?.turns.at(-1)?.status === 'failed';
		if (origin === 'inline-edit') {
			let turns = this._inlineTurns.get(session.id);
			if (!turns) {
				turns = new Set();
				this._inlineTurns.set(session.id, turns);
			}
			turns.add(turnId);
		}
		this._stoppedPanes.delete(session.id);
		this.dispatch(session.id, { type: 'turn.submitted', turnId, text: visible, sent });
		this._lastSubmitted.set(session.id, { turnId, attachments: attachments?.slice() ?? [] });
		let byTurn = this._turnAttachments.get(session.id);
		if (!byTurn) {
			byTurn = new Map();
			this._turnAttachments.set(session.id, byTurn);
		}
		byTurn.set(turnId, attachments?.slice() ?? []);
		const token = this.bumpToken(session.id);
		if (autoOn) {
			const auto = await this.routeAuto(session, prompt, cwd, previousFailed, token);
			if (this._turnTokens.get(session.id) !== token || this._store.isDisposed) {
				return;
			}
			if (auto) {
				const route = claudeAutoRoute({
					canDelegate: !!this._delegateHandler,
					delegated: !!session.delegatedFrom,
					hasConversation: !!session.claudeSessionId || !!this._viewStates.get(session.id)?.turns.some(turn => turn.id !== turnId),
					chatModel: this.chatModel(session),
					pick: auto.modelId,
				});
				if (route === 'delegate') {
					// The turn shows the pick, and ends when the delegated chat answers; submit does not wait for it.
					this.dispatch(session.id, { type: 'turn.routed', turnId, auto });
					void this.delegateTurn(session, turnId, prompt, visible, auto, token);
					return;
				}
				if (route === 'adopt') {
					// A chat without a conversation starts on the pick; that is not a switch (issue 693).
					session.modelId = auto.modelId;
					session.modelName = auto.modelName ?? auto.modelId;
					this.fireSessionChange('model');
				} else if (route === 'switch') {
					modelOverride = auto.modelId;
				}
				this.dispatch(session.id, { type: 'turn.routed', turnId, auto });
			}
		}
		prompt = this.withDelegateNotes(session.id, prompt);
		let existing = this._paneToRuntime.get(session.id);
		if (existing && this._restartNext.has(session.id)) {
			this.unmapRuntime(session.id);
			void this._runtime.disposeSession(existing);
			existing = undefined;
		}
		if (existing && !(modelOverride ?? session.modelId ?? this._baseModel.get(existing)) && this._appliedModel.get(existing) !== undefined) {
			// A per-turn model is still applied and there is no model to switch back
			// to, so this turn starts a new query that resumes on the runtime default.
			this.unmapRuntime(session.id);
			void this._runtime.disposeSession(existing);
			existing = undefined;
		}
		const resuming = !existing && !session.resumeBlocked && !!session.claudeSessionId;
		try {
			const dirtyBuffers = mergeCheckpointBuffers(checkpointBuffers, await this._checkpoints.captureDirtyBuffers());
			if (this._turnTokens.get(session.id) !== token || this._store.isDisposed) {
				return;
			}
			if (existing) {
				const desired = modelOverride ?? session.modelId ?? this._baseModel.get(existing);
				if (desired && desired !== this._appliedModel.get(existing) && !await this.applyModel(session, existing, desired, modelOverride !== undefined, token)) {
					return;
				}
				if (!await this.applySettings(session, existing, this.settingsModel(existing, modelOverride ?? session.modelId), token)) {
					return;
				}
				if (this._turnTokens.get(session.id) !== token || this._store.isDisposed) {
					return;
				}
				await this._runtime.send(existing, {
					text: prompt,
					mode,
					workspaceTrusted: this._trust.isWorkspaceTrusted(),
					sessionPermissions: this.getSessionPermissions(session.id),
					turnId,
					checkpointSessionId: session.id,
					dirtyBuffers,
					attachments: attachments?.slice(),
					accountId: this._sessionAccounts.get(session.id),
				});
				return;
			}
			await this.beginTurn(session, prompt, cwd, token, mode, turnId, dirtyBuffers, attachments, modelOverride);
		} catch (error) {
			if (this._turnTokens.get(session.id) !== token || this._store.isDisposed) {
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			this.append(formatClaudeAgentFailure(message));
			const runtimeId = this.unmapRuntime(session.id);
			if (runtimeId) {
				void this._runtime.disposeSession(runtimeId);
			}
			this._freshStarts.delete(session.id);
			if (resuming && isClaudeResumeRejection(error)) {
				session.resumeFailed = true;
				session.resumeBlocked = true;
				this.fireSessionChange('context');
				this.flushMeta(session);
			}
			this.dispatch(session.id, { type: 'turn.failed', message });
		}
	}

	/** The model the chat's own turns run on: the one it stores, else the one its query reported. */
	private chatModel(session: MutablePaneSession): string | undefined {
		const runtimeId = this._paneToRuntime.get(session.id);
		return session.modelId ?? (runtimeId ? this._baseModel.get(runtimeId) : undefined);
	}

	/**
	 * Auto picked another model than the chat's (issue 693): a delegated chat on
	 * the pick answers the message and the chat keeps its model and cache. The
	 * turn ends with the delegated chat, and its answer goes ahead of the chat's
	 * next message. `prompt` is what the runtime would have read; the card and
	 * the delegated chat show `visible`, the user's own message.
	 */
	private async delegateTurn(session: MutablePaneSession, turnId: string, prompt: string, visible: string, auto: ClaudeAutoModelPick, token: number): Promise<void> {
		const history = (this._viewStates.get(session.id)?.turns ?? []).filter(turn => turn.id !== turnId).map(turn => ({ user: turn.user.text, assistant: turn.assistantText }));
		const modelLabel = auto.modelName ?? auto.modelId;
		let result: ClaudeDelegateToolResult;
		try {
			result = await this._delegateHandler!.delegate({ parentSessionId: session.id, parentTurnId: turnId, task: claudeDelegateTask(prompt, history), prompt: visible, model: auto.modelId, effort: auto.effort, auto: true });
		} catch (error) {
			result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
		}
		if (this._turnTokens.get(session.id) !== token || this._store.isDisposed) {
			return;
		}
		const state = result.kind === 'messaged' ? 'done' : result.kind;
		const note = claudeDelegateNote({ task: visible, modelLabel, state, result: result.kind === 'done' ? result.text : undefined, message: result.kind === 'failed' ? result.message : undefined });
		this._delegateNotes.set(session.id, [...this._delegateNotes.get(session.id) ?? [], note]);
		switch (result.kind) {
			case 'done':
			case 'messaged':
				this.dispatch(session.id, { type: 'turn.delegated', turnId });
				break;
			case 'stopped':
				this.dispatch(session.id, { type: 'turn.stopped' });
				break;
			case 'failed':
				this.dispatch(session.id, { type: 'turn.failed', message: result.message });
				break;
		}
	}

	/** Puts what Auto's delegated chats answered ahead of the prompt, once. */
	private withDelegateNotes(sessionId: string, prompt: string): string {
		const notes = this._delegateNotes.get(sessionId);
		if (!notes?.length) {
			return prompt;
		}
		this._delegateNotes.delete(sessionId);
		return `${notes.join('\n\n')}\n\n${prompt}`;
	}

	/**
	 * Auto model (issue 521): rates the prompt with Claude Code's fastest model,
	 * or estimates the rating when that fails or takes too long, then picks the
	 * turn's model and effort and stores the effort for `settingsFor`. Undefined
	 * when no offered model fits, so the turn runs on the session's model.
	 */
	private async routeAuto(session: MutablePaneSession, prompt: string, cwd: string, retry: boolean, token: number): Promise<ClaudeAutoModelPick | undefined> {
		await this.loadModelInfo();
		const models = pickableClaudeModels([...this._modelInfo.values()], readClaudeModelIdList(this._configuration?.getValue(CLAUDE_MODELS_ENABLED_SETTING)), []);
		if (this._turnTokens.get(session.id) !== token || this._store.isDisposed || !pickClaudeAutoModel('moderate', models)) {
			return undefined;
		}
		const request = { id: generateUuid(), prompt, cwd, contextTokens: this._viewStates.get(session.id)?.usage?.contextTokens, retry };
		let classification: ClaudeAutoModelClassification | undefined;
		if (this._runtime.classifyAutoModel) {
			try {
				classification = await raceTimeout(this._runtime.classifyAutoModel(request), AUTO_CLASSIFY_TIMEOUT_MS, () => void this._runtime.cancelAutoModel?.(request.id));
			} catch {
				classification = undefined;
			}
			if (this._turnTokens.get(session.id) !== token || this._store.isDisposed) {
				return undefined;
			}
		}
		const rated = classification?.ok ? classification : undefined;
		const complexity = rated?.complexity ?? estimateClaudeAutoComplexity(request);
		const choice = pickClaudeAutoModel(complexity, models);
		if (!choice) {
			return undefined;
		}
		const base = this._sessionSettings.get(session.id) ?? this.configuredSettings(choice.modelId);
		const settings = fitClaudeSessionSettings(this._modelInfo.get(choice.modelId), readClaudeSessionSettings({ ...base, effort: choice.effort, ultracode: false }));
		this._autoSettings.set(session.id, settings);
		const pick: ClaudeAutoModelPick = { complexity, modelId: choice.modelId, modelName: this._modelNames.get(choice.modelId), effort: settings.effort, reason: rated?.reason, source: rated ? 'claude' : 'estimate' };
		this._autoModel.set(session.id, { last: pick });
		this.fireSessionChange('model');
		return pick;
	}

	/**
	 * Switches a live query to `modelId`. When the runtime refuses it, the user is
	 * told and the turn goes on with `claude.models.default`, or with the model
	 * the query already has. Returns false when the turn was stopped meanwhile.
	 */
	private async applyModel(session: MutablePaneSession, runtimeId: string, modelId: string, perTurn: boolean, token: number): Promise<boolean> {
		try {
			await this._runtime.setModel(runtimeId, modelId);
			if (this._turnTokens.get(session.id) !== token || this._store.isDisposed) {
				return false;
			}
			this._appliedModel.set(runtimeId, modelId);
			return true;
		} catch (error) {
			if (this._turnTokens.get(session.id) !== token || this._store.isDisposed) {
				return false;
			}
			const configured = readClaudeModelId(this._configuration?.getValue(CLAUDE_MODELS_DEFAULT_SETTING));
			const fallback = configured && configured !== modelId ? configured : undefined;
			const message = error instanceof Error ? error.message : String(error);
			this.append(formatClaudeAgentFailure(message));
			if (!perTurn && session.modelId === modelId) {
				session.modelId = fallback;
				session.modelName = fallback ? this._modelNames.get(fallback) ?? fallback : undefined;
				this.fireSessionChange('model');
			}
			this._onDidRejectModel.fire({ sessionId: session.id, modelId, fallback, message: redactSecrets(message) });
			if (fallback && fallback !== this._appliedModel.get(runtimeId)) {
				// A second refusal fails the turn through the caller's catch.
				await this._runtime.setModel(runtimeId, fallback);
				if (this._turnTokens.get(session.id) !== token || this._store.isDisposed) {
					return false;
				}
				this._appliedModel.set(runtimeId, fallback);
			}
			return true;
		}
	}

	/**
	 * The model id a live query's settings are read for. A query that started on
	 * the runtime default has the resolved id from `session.started` (say
	 * `claude-opus-5-5`), which is not a model list id, so it reads as the default
	 * unless the turn asked for that very id.
	 */
	private settingsModel(runtimeId: string, wanted: string | undefined): string | undefined {
		const applied = this._appliedModel.get(runtimeId);
		if (applied === wanted) {
			return applied;
		}
		return applied === this._baseModel.get(runtimeId) ? undefined : applied;
	}

	/**
	 * Brings a live query to the settings the next turn should run with. When the
	 * runtime refuses them, the user is told, the pick goes back to what the query
	 * has, and the turn goes on. Returns false when the turn was stopped meanwhile.
	 */
	private async applySettings(session: MutablePaneSession, runtimeId: string, modelId: string | undefined, token: number): Promise<boolean> {
		if (this._modelInfo.size === 0) {
			await this.loadModelInfo();
			if (this._turnTokens.get(session.id) !== token || this._store.isDisposed) {
				return false;
			}
		}
		const desired = this.settingsFor(session.id, modelId);
		const applied = this._appliedSettings.get(runtimeId) ?? DEFAULT_CLAUDE_SESSION_SETTINGS;
		if (sameClaudeSessionSettings(desired, applied) || !this._runtime.setSessionSettings) {
			return true;
		}
		try {
			await this._runtime.setSessionSettings(runtimeId, desired);
			if (this._turnTokens.get(session.id) !== token || this._store.isDisposed) {
				return false;
			}
			this._appliedSettings.set(runtimeId, desired);
		} catch (error) {
			if (this._turnTokens.get(session.id) !== token || this._store.isDisposed) {
				return false;
			}
			this.append(formatClaudeAgentFailure(error instanceof Error ? error.message : String(error)));
			this._sessionSettings.set(session.id, applied);
			this.fireSessionChange('settings');
		}
		return true;
	}

	isInlineEditTurn(sessionId: string, turnId: string): boolean {
		return this._inlineTurns.get(sessionId)?.has(turnId) ?? false;
	}

	notePluginChange(plugin: string, removed: boolean): void {
		let changed = false;
		for (const paneId of this._paneToRuntime.keys()) {
			if (this._restartNext.has(paneId)) {
				continue;
			}
			const changes = (this._pluginChanges.get(paneId) ?? []).filter(change => change.plugin !== plugin);
			changes.push({ plugin, removed });
			this._pluginChanges.set(paneId, changes);
			changed = true;
		}
		if (changed) {
			this.fireSessionChange('plugins');
		}
	}

	getPluginChanges(sessionId: string): readonly ClaudePluginChange[] {
		return this._pluginChanges.get(sessionId) ?? [];
	}

	restartSession(sessionId: string): void {
		if (!this._pluginChanges.delete(sessionId) || !this._paneToRuntime.has(sessionId)) {
			return;
		}
		// The running query ends at the next turn, which resumes this conversation in a new one.
		this._restartNext.add(sessionId);
		this.fireSessionChange('plugins');
	}

	private assertAgentEnabled(): void {
		if (this._configuration && !readClaudeAgentEnabled(this._configuration.getValue(CLAUDE_AGENT_ENABLED_SETTING))) {
			throw new Error(localize('claudeAgentDisabled', "Agent features are turned off. Turn on the Claude: Agent Enabled setting to use them."));
		}
	}

	private async beginTurn(session: MutablePaneSession, prompt: string, cwd: string, token: number, mode: AgentMode, turnId: string, dirtyBuffers: readonly { readonly path: string; readonly text: string }[], attachments?: readonly ContextAttachment[], modelOverride?: string): Promise<void> {
		this._beginsInFlight++;
		const resumeSessionId = session.resumeBlocked ? undefined : session.claudeSessionId;
		if (resumeSessionId) {
			this._resumeAttempts.add(session.id);
		} else {
			this._resumeAttempts.delete(session.id);
		}
		if (!resumeSessionId && session.claudeSessionId) {
			this._freshStarts.add(session.id);
		}
		try {
			const state = await this._runtime.ensureRuntime();
			this.logState(state);
			const modelId = modelOverride ?? session.modelId;
			await this.loadModelInfo();
			const sessionSettings = this.settingsFor(session.id, modelId);
			const handle = await this._runtime.begin({
				prompt,
				cwd,
				mode,
				modelId,
				resumeSessionId,
				resumeSessionAt: resumeSessionId ? session.resumeAt : undefined,
				additionalDirectories: session.additionalDirectories,
				workspaceFolders: this.workspaceFolders(),
				workspaceTrusted: this._trust.isWorkspaceTrusted(),
				sessionPermissions: this.getSessionPermissions(session.id),
				sessionSettings,
				plugins: this._sessionPlugins.get(session.id),
				workerProfile: this._sessionProfiles.get(session.id),
				maxBudgetUsd: this._sessionBudgets.get(session.id),
				maxTurns: this._sessionMaxTurns.get(session.id),
				turnId,
				checkpointSessionId: session.id,
				dirtyBuffers,
				attachments: attachments?.slice(),
				executionTarget: session.executionTarget,
				accountId: this._sessionAccounts.get(session.id),
			});
			if (this._store.isDisposed || this._turnTokens.get(session.id) !== token) {
				void this.interruptAndDispose(handle.sessionId, true);
				return;
			}
			this._runtimeToPane.set(handle.sessionId, session.id);
			this._paneToRuntime.set(session.id, handle.sessionId);
			this._appliedModel.set(handle.sessionId, modelId);
			this._appliedSettings.set(handle.sessionId, sessionSettings);
			this._appliedDirectories.set(session.id, session.additionalDirectories.slice());
			const buffered = this._bufferedEvents.get(handle.sessionId) ?? [];
			this._bufferedEvents.delete(handle.sessionId);
			for (const event of buffered) {
				this.routeTurnEvent(session.id, event);
			}
		} finally {
			this._beginsInFlight--;
			if (this._beginsInFlight === 0) {
				this._bufferedEvents.clear();
			}
		}
	}

	/** Local folders only. A remote or virtual folder has no path the runtime can guard. */
	private workspaceFolders(): string[] {
		return this._workspace.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.file).map(folder => folder.uri.fsPath);
	}

	private routeTurnEvent(paneId: string, event: NormalizedClaudeEvent): void {
		if (event.type === 'session.started') {
			const session = this._paneSessions.find(candidate => candidate.id === paneId);
			if (event.model && this._appliedModel.get(event.sessionId) === undefined) {
				// The query started on the runtime default. A per-turn model switches back to it.
				this._baseModel.set(event.sessionId, event.model);
				this._appliedModel.set(event.sessionId, event.model);
			}
			if (session) {
				// Resume needs Claude Code's conversation id. `event.sessionId` is the runtime's own id.
				if (event.claudeSessionId) {
					session.claudeSessionId = event.claudeSessionId;
				}
				session.targetInfo = event.target ?? session.targetInfo;
				if (event.target?.kind === 'local' && session.executionTarget) {
					// The saved host or container was gone, so Claude Code started here. Later turns stay here.
					session.executionTarget = undefined;
					void this.persistMeta(session);
				}
				// A started session replaces a rejected resume id, so the new id can be resumed later.
				this._resumeAttempts.delete(paneId);
				session.resumeBlocked = false;
				session.resumeFailed = false;
				// A rewind's cut and note were used by the query that just started (issue 702).
				session.resumeAt = undefined;
				session.rewindNote = undefined;
				if (event.slashCommands || event.skills) {
					session.slashCommands = [...(event.slashCommands ?? [])];
					session.skills = [...(event.skills ?? [])];
					session.commands = claudeCommandsFromNames(session.slashCommands, session.skills);
				}
				if (this._freshStarts.delete(paneId)) {
					this._onDidStartFreshClaudeSession.fire({ sessionId: paneId, title: session.title });
				}
				this.fireSessionChange('context');
			}
		}
		if (event.type === 'session.fastMode') {
			const previous = this._fastMode.get(paneId);
			this._fastMode.set(paneId, event.status);
			this.fireSessionChange('settings');
			// Running to paused or unavailable is the only drop worth one notice; a repeat of the same state is not.
			if (previous?.state === 'on' && (event.status.state === 'cooldown' || event.status.state === 'unavailable')) {
				this._onDidDropFastMode.fire({ sessionId: paneId, previous, status: event.status });
			}
		}
		if (event.type === 'session.catalog') {
			const session = this._paneSessions.find(candidate => candidate.id === paneId);
			if (session) {
				if (event.commands.length > 0) {
					session.commands = event.commands.slice();
				}
				if (event.agents.length > 0) {
					session.agents = event.agents.slice();
				}
				this.fireSessionChange('context');
			}
		}
		if (event.type === 'session.titled') {
			// The generated title replaces only the cut-off first request, never a name the user chose.
			const session = this._paneSessions.find(candidate => candidate.id === paneId);
			const title = event.title.trim();
			if (session?.titleFromPrompt && title) {
				session.title = title;
				session.titleFromPrompt = false;
				this.fireSessionChange('context');
				this.flushMeta(session);
			}
		}
		if (event.type === 'session.failed') {
			const session = this._paneSessions.find(candidate => candidate.id === paneId);
			if (session && this._resumeAttempts.has(paneId) && isClaudeResumeRejection(event.message)) {
				session.resumeFailed = true;
				session.resumeBlocked = true;
				this.fireSessionChange('context');
				this.flushMeta(session);
			}
			this._resumeAttempts.delete(paneId);
		}
		const now = Date.now();
		const previous = this._lastEventAt.get(event.sessionId);
		this._lastEventAt.set(event.sessionId, now);
		this.append(formatClaudeAgentEvent(event, previous === undefined ? 0 : Math.max(0, now - previous)));
		this._onDidReceiveEvent.fire(event);
		if (this.dropsAfterStop(paneId, event)) {
			return;
		}
		this.dispatch(paneId, event);
		if (event.type === 'session.failed') {
			this._lastEventAt.delete(event.sessionId);
			this.unmapRuntime(paneId);
			void this._runtime.disposeSession(event.sessionId);
		}
	}

	/**
	 * Issue 1617: after Stop, a child that starts work late must not bring the chat back to life. The event
	 * is dropped and the child stopped again. Permission requests still pass, so the user can answer them.
	 */
	private dropsAfterStop(paneId: string, event: NormalizedClaudeEvent): boolean {
		if (!this._stoppedPanes.has(paneId) || this.isRunning(paneId)) {
			return false;
		}
		if (event.type === 'subagent.started') {
			this._delegateHandler?.stopUnder(paneId, false);
			void this.stopSubagent(paneId, event.run.id).catch(() => undefined);
			return true;
		}
		if (event.type === 'tool.started') {
			this._delegateHandler?.stopUnder(paneId, false);
			return true;
		}
		return false;
	}

	private dispatch(paneId: string, event: AgentReducerEvent): void {
		const stamped = stampTimes(event, Date.now());
		const log = this._eventLog.get(paneId) ?? [];
		appendCapped(log, stamped, CLAUDE_EVENT_LOG_CAP);
		this._eventLog.set(paneId, log);
		this.rememberEvent(paneId, stamped);
		this.bumpInspector(paneId);
		this.noteCommandOutput(paneId, stamped);
		const before = this.getViewState(paneId);
		const after = reduceAgentState(before, stamped);
		if (after === before) {
			return;
		}
		this._viewStates.set(paneId, after);
		if (!this._store.isDisposed) {
			this._onDidChangeViewState.fire({ sessionId: paneId });
		}
		this.fallBackToChatModel(paneId, after);
		this.maybeFlush(paneId);
	}

	/**
	 * Issue 839: a cheap turn Auto picked goes back to the chat's own model once
	 * it fails too many calls in a row or runs too many steps. Once per turn.
	 */
	private fallBackToChatModel(paneId: string, state: AgentViewState): void {
		const turn = state.turns[state.turns.length - 1];
		const pick = this._autoModel.get(paneId)?.last;
		const session = this._paneSessions.find(candidate => candidate.id === paneId);
		const runtimeId = this._paneToRuntime.get(paneId);
		if (!turn || turn.status !== 'running' || !pick?.modelId || !session || !runtimeId || this._fellBack.has(turn.id)) {
			return;
		}
		const chatModel = this.chatModel(session);
		if (!chatModel || chatModel === pick.modelId || this._appliedModel.get(runtimeId) !== pick.modelId) {
			return;
		}
		const read = (key: string, fallback: number) => readClaudeDelegationLadderThreshold(this._configuration.getValue(key), fallback);
		const cause = sessionFallbackCause(turn.cards, {
			sessionFailedCalls: read(CLAUDE_DELEGATION_SESSION_FAILED_CALLS_SETTING, CLAUDE_DELEGATION_LADDER_DEFAULTS.sessionFailedCalls),
			sessionSteps: read(CLAUDE_DELEGATION_SESSION_STEPS_SETTING, CLAUDE_DELEGATION_LADDER_DEFAULTS.sessionSteps),
		});
		if (!cause) {
			return;
		}
		this._fellBack.add(turn.id);
		const token = this._turnTokens.get(paneId) ?? 0;
		void this.applyModel(session, runtimeId, chatModel, true, token).then(applied => {
			if (!applied) {
				return;
			}
			const escalation: ClaudeEscalation = {
				time: Date.now(),
				from: pick.modelName ?? pick.modelId!,
				to: session.modelName ?? this._modelNames.get(chatModel) ?? chatModel,
				cause,
				count: cause === 'steps' ? turn.cards.length : countTrailingFailedCalls(turn.cards),
			};
			this.append(formatEscalationLogLine(escalation));
			this.noteFallback(paneId, turn.id, escalation);
		}).catch(() => undefined);
	}

	/** Issue 1009: the turn itself says it went back to the chat's model, not only the output log. */
	private noteFallback(paneId: string, turnId: string, escalation: ClaudeEscalation): void {
		const state = this.getViewState(paneId);
		const index = state.turns.findIndex(turn => turn.id === turnId);
		if (index < 0 || this._store.isDisposed) {
			return;
		}
		const turns = state.turns.slice();
		turns[index] = { ...turns[index], fallback: escalation };
		this._viewStates.set(paneId, { ...state, turns });
		this._onDidChangeViewState.fire({ sessionId: paneId });
	}

	private maybeFlush(sessionId: string): void {
		if (this._flushing.has(sessionId) || this.isRunning(sessionId) || this._store.isDisposed) {
			return;
		}
		// A stopped or failed turn did not finish the work the follow-up was waiting for.
		const last = this.getViewState(sessionId).turns.at(-1);
		if (!last || last.status !== 'complete') {
			return;
		}
		const list = this._pending.get(sessionId);
		const next = list?.[0];
		if (!list || !next) {
			return;
		}
		list.shift();
		if (list.length === 0) {
			this._pending.delete(sessionId);
		}
		this.firePending(sessionId);
		this._flushing.add(sessionId);
		void this.dispatchPending(sessionId, next);
	}

	private async dispatchPending(sessionId: string, item: StoredPending): Promise<void> {
		try {
			if (!this._paneSessions.some(session => session.id === sessionId)) {
				return;
			}
			await this.submit(sessionId, item.text, item.cwd, { compiled: item.compiled, label: item.text, keepDraft: true, attachments: item.attachments });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const open = this._paneSessions.some(session => session.id === sessionId);
			if (open && shouldRequeuePending(error)) {
				const list = this._pending.get(sessionId) ?? [];
				list.unshift(item);
				this._pending.set(sessionId, list);
				this.firePending(sessionId);
			}
			this.append(formatClaudeAgentFailure(message));
		} finally {
			this._flushing.delete(sessionId);
			this.maybeFlush(sessionId);
		}
	}

	private storePending(session: MutablePaneSession, visible: string, prompt: string, cwd: string, behavior: PendingInput['behavior'], options?: ClaudeSubmitOptions): StoredPending {
		return {
			id: generateUuid(),
			text: visible,
			attachments: [...(options?.attachments ?? session.attachments)],
			behavior,
			createdAt: Date.now(),
			cwd,
			compiled: prompt,
		};
	}

	private clearComposer(session: MutablePaneSession, options?: ClaudeSubmitOptions): void {
		if (options?.keepDraft) {
			return;
		}
		session.draft = '';
		session.attachments = [];
		this.fireSessionChange('context');
	}

	private pendingSnapshot(item: StoredPending): PendingInput {
		return {
			id: item.id,
			text: item.text,
			attachments: item.attachments.slice(),
			behavior: item.behavior,
			createdAt: item.createdAt,
			...(item.compiled && item.compiled !== item.text ? { compiled: item.compiled } : {}),
		};
	}

	private firePending(sessionId: string): void {
		if (!this._store.isDisposed) {
			this._onDidChangePending.fire({ sessionId });
		}
	}

	private noteCommandOutput(paneId: string, event: AgentReducerEvent): void {
		if (event.type !== 'tool.updated' && event.type !== 'tool.completed') {
			return;
		}
		const callId = event.callId;
		const state = this.getViewState(paneId);
		const cards = [
			...state.turns.flatMap(turn => turn.cards),
			...state.subagents.flatMap(subagent => subagent.chat.cards),
		];
		const card = cards.find(candidate => candidate.id === callId && candidate.kind === 'command');
		if (!card) {
			return;
		}
		const key = `${paneId}\n${callId}`;
		const streamed = this._commandStreamed.get(key) ?? '';
		const text = event.type === 'tool.updated' ? redactSecrets(outputText(event.update)) : unstreamedCommandOutput(streamed, event.result.output);
		if (event.type === 'tool.updated') {
			if (text) {
				this._commandStreamed.set(key, streamed + text);
			}
		} else {
			this._commandStreamed.delete(key);
		}
		if (!text) {
			return;
		}
		const channel = this._output.getChannel(CLAUDE_COMMAND_LOG_CHANNEL_ID);
		channel?.append(text.endsWith('\n') ? text : `${text}\n`);
	}

	private isRunning(paneId: string): boolean {
		const turns = this.getViewState(paneId).turns;
		return turns.length > 0 && turns[turns.length - 1].status === 'running';
	}

	private bumpToken(paneId: string): number {
		const token = (this._turnTokens.get(paneId) ?? 0) + 1;
		this._turnTokens.set(paneId, token);
		return token;
	}

	private directoriesForTurn(session: MutablePaneSession): readonly string[] {
		if (this._paneToRuntime.has(session.id)) {
			return this._appliedDirectories.get(session.id) ?? [];
		}
		return session.additionalDirectories;
	}

	private unmapRuntime(paneId: string): string | undefined {
		const runtimeId = this._paneToRuntime.get(paneId);
		this._paneToRuntime.delete(paneId);
		// The next query starts Claude Code again, which loads every plugin change.
		this._pluginChanges.delete(paneId);
		this._restartNext.delete(paneId);
		this._appliedDirectories.delete(paneId);
		for (const key of [...this._commandStreamed.keys()]) {
			if (key.startsWith(`${paneId}\n`)) {
				this._commandStreamed.delete(key);
			}
		}
		if (runtimeId) {
			this._runtimeToPane.delete(runtimeId);
			this._lastEventAt.delete(runtimeId);
			this._appliedModel.delete(runtimeId);
			this._appliedSettings.delete(runtimeId);
			this._baseModel.delete(runtimeId);
		}
		return runtimeId;
	}

	private async interruptAndDispose(runtimeId: string, interrupt: boolean): Promise<void> {
		try {
			if (interrupt) {
				await this._runtime.interrupt(runtimeId);
			}
		} catch (error) {
			this.append(formatClaudeAgentFailure(error instanceof Error ? error.message : String(error)));
		}
		try {
			await this._runtime.disposeSession(runtimeId);
		} catch {
			// The session is already gone.
		}
	}

	private handleRuntimeEvent(event: NormalizedClaudeEvent): void {
		if (this._store.isDisposed) {
			return;
		}
		const paneId = this._runtimeToPane.get(event.sessionId);
		if (paneId) {
			this.routeTurnEvent(paneId, event);
			return;
		}
		if (this._ownedSessions.has(event.sessionId)) {
			this.logOwnedEvent(event);
			return;
		}
		if (this._beginsInFlight > 0) {
			const buffered = this._bufferedEvents.get(event.sessionId) ?? [];
			buffered.push(event);
			this._bufferedEvents.set(event.sessionId, buffered);
		}
	}

	private drain(sessionId: string): void {
		const buffered = this._bufferedEvents.get(sessionId) ?? [];
		this._bufferedEvents.delete(sessionId);
		for (const event of buffered) {
			this.logOwnedEvent(event);
		}
	}

	private logOwnedEvent(event: NormalizedClaudeEvent): void {
		const now = Date.now();
		const previous = this._lastEventAt.get(event.sessionId);
		const elapsed = previous === undefined ? 0 : Math.max(0, now - previous);
		this._lastEventAt.set(event.sessionId, now);
		this.append(formatClaudeAgentEvent(event, elapsed));
		this._onDidReceiveEvent.fire(event);
		if (event.type === 'session.completed' || event.type === 'session.failed') {
			this._ownedSessions.delete(event.sessionId);
			this._lastEventAt.delete(event.sessionId);
			void this._runtime.disposeSession(event.sessionId);
		}
	}

	private logState(state: ClaudeRuntimeState): void {
		const line = formatClaudeRuntimeState(state);
		if (line === this._lastStateLine) {
			return;
		}
		this._lastStateLine = line;
		this.append(line);
	}

	private bumpInspector(paneId: string): void {
		this._inspectorRevision.set(paneId, (this._inspectorRevision.get(paneId) ?? 0) + 1);
		if (!this._store.isDisposed) {
			this._onDidChangeInspector.fire({ sessionId: paneId });
		}
	}

	private append(line: string): void {
		this._output.getChannel(CLAUDE_AGENT_OUTPUT_CHANNEL_ID)?.append(line.endsWith('\n') ? line : `${line}\n`);
	}

	private currentMutable(): MutablePaneSession | undefined {
		return this._paneSessions.find(session => session.id === this._currentSessionId);
	}

	private rememberEvent(paneId: string, event: AgentReducerEvent): void {
		const session = this._paneSessions.find(candidate => candidate.id === paneId);
		if (!session) {
			return;
		}
		const disk = this._diskEvents.get(paneId) ?? [];
		disk.push(event);
		this._diskEvents.set(paneId, disk);
		session.updatedAt = Date.now();
		if (event.type === 'turn.submitted') {
			// Interrupted stays through later reopens until the user sends another turn.
			if (session.interrupted) {
				session.interrupted = false;
				this.fireSessionChange('context');
			}
			if (session.titleIsDefault && event.text.trim()) {
				session.title = event.text.trim().slice(0, 80);
				session.titleIsDefault = false;
				session.titleFromPrompt = true;
				this.fireSessionChange('context');
			}
			if (!session.checkpointIds.includes(event.turnId)) {
				session.checkpointIds.push(event.turnId);
			}
		}
		if (!this._history || this._deletedSessions.has(paneId)) {
			return;
		}
		if (isStreamedDiskEvent(event)) {
			this.bufferDisk(session, event);
			this.scheduleMeta(session);
			return;
		}
		this.flushDisk(session);
		this.enqueueDisk(session, event);
		if (event.type === 'session.started' || event.type === 'session.completed' || event.type === 'session.failed' || event.type === 'turn.submitted' || event.type === 'turn.failed' || event.type === 'turn.stopped') {
			this.flushMeta(session);
		} else {
			this.scheduleMeta(session);
		}
	}

	private bufferDisk(session: MutablePaneSession, event: AgentReducerEvent): void {
		const list = this._diskBuffers.get(session.id) ?? [];
		const previous = list[list.length - 1];
		const merged = previous ? mergeStreamEvent(previous, event) : undefined;
		if (merged) {
			list[list.length - 1] = merged;
		} else {
			list.push(event);
		}
		this._diskBuffers.set(session.id, list);
		if (this._diskTimers.has(session.id)) {
			return;
		}
		const handle = setTimeout(() => {
			this._diskTimers.delete(session.id);
			this.flushDisk(session);
		}, DISK_COALESCE_MS);
		this._diskTimers.set(session.id, handle);
	}

	private flushDisk(session: MutablePaneSession): void {
		const handle = this._diskTimers.get(session.id);
		if (handle) {
			clearTimeout(handle);
			this._diskTimers.delete(session.id);
		}
		const list = this._diskBuffers.get(session.id);
		this._diskBuffers.delete(session.id);
		if (!list || this._deletedSessions.has(session.id)) {
			return;
		}
		for (const event of list) {
			this.enqueueDisk(session, event);
		}
	}

	private enqueueDisk(session: MutablePaneSession, event: AgentReducerEvent): void {
		if (!this._history || this._deletedSessions.has(session.id)) {
			return;
		}
		void this._history.append(session.id, event).catch(error => {
			this.append(formatClaudeAgentFailure(error instanceof Error ? error.message : String(error)));
		});
	}

	private scheduleMeta(session: MutablePaneSession): void {
		if (this._deletedSessions.has(session.id) || this._metaTimers.has(session.id)) {
			return;
		}
		const handle = setTimeout(() => {
			this._metaTimers.delete(session.id);
			if (!this._deletedSessions.has(session.id)) {
				void this.persistMeta(session);
			}
		}, META_PERSIST_MS);
		this._metaTimers.set(session.id, handle);
	}

	private flushMeta(session: MutablePaneSession): void {
		const handle = this._metaTimers.get(session.id);
		if (handle) {
			clearTimeout(handle);
			this._metaTimers.delete(session.id);
		}
		if (this._deletedSessions.has(session.id)) {
			return;
		}
		void this.persistMeta(session);
	}

	/**
	 * Saves the session's index record and `session.json`. The record is taken now, so a
	 * tab that is closing saves its turns before they leave memory. A closed tab's later
	 * writes are dropped; it is saved again when it opens.
	 */
	private persistMeta(session: MutablePaneSession, open = true): Promise<void> {
		if (!this._history || this._deletedSessions.has(session.id) || (open && !this._paneSessions.includes(session))) {
			return Promise.resolve();
		}
		const known = this._historyRecords.get(session.id);
		let record: SessionIndexRecord = { ...this.indexRecord(session), open };
		if (!session.loaded && known) {
			// The transcript is not read yet, so the turns are not in memory. Keep the saved summary.
			record = { ...record, status: known.status, firstUser: known.firstUser, changedFiles: known.changedFiles, turnCount: known.turnCount };
		}
		this._historyRecords.set(session.id, record);
		const writeSession = session.loaded;
		const saved: IdeAgentSession = {
			id: session.id,
			claudeSessionId: session.claudeSessionId,
			workspaceId: session.workspaceId,
			title: session.title,
			mode: session.mode,
			createdAt: session.createdAt,
			updatedAt: record.updatedAt,
			status: record.status ?? 'idle',
			turns: this.getViewState(session.id).turns.map(turn => ({ id: turn.id, createdAt: session.createdAt, userText: turn.user.text })),
			checkpointIds: session.checkpointIds.slice(),
			worktree: session.worktreePath ? { path: session.worktreePath } : undefined,
			modelId: session.modelId,
			forkContext: session.claudeSessionId ? undefined : session.forkContext,
			pinnedCommand: session.pinnedCommand,
			resumeAt: session.resumeAt,
			rewindNote: session.rewindNote,
		};
		const history = this._history;
		const searchTurns = writeSession ? this.getViewState(session.id).turns : undefined;
		const run = async () => {
			if (this._deletedSessions.has(session.id)) {
				return;
			}
			if (writeSession) {
				await history.writeSession(saved);
			}
			if (searchTurns) {
				this._chatSearch.value?.update(session.id, record.updatedAt, searchTurns);
			}
			await history.upsertIndex(record);
		};
		const next = this._indexTail.then(run, run);
		this._indexTail = next.then(() => undefined, () => undefined);
		return next;
	}

	private indexRecord(session: MutablePaneSession): SessionIndexRecord {
		const state = this.getViewState(session.id);
		const changed = [...new Set(state.turns.flatMap(turn => [...turn.changedFiles]))];
		return {
			id: session.id,
			workspaceId: session.workspaceId,
			workspaceName: session.workspaceName,
			projectFolder: session.worktreePath ?? this.workspaceFolders()[0],
			title: session.title,
			updatedAt: Date.now(),
			createdAt: session.createdAt,
			mode: session.mode,
			status: this.liveStatus(session.id),
			claudeSessionId: session.claudeSessionId,
			checkpointIds: session.checkpointIds.slice(),
			worktree: session.worktreePath ? { path: session.worktreePath } : undefined,
			interrupted: session.interrupted,
			resumeFailed: session.resumeFailed,
			firstUser: state.turns[0]?.user.text,
			changedFiles: changed,
			turnCount: state.turns.length,
			pinned: session.pinned || undefined,
			archived: session.archived || undefined,
			executionTarget: session.executionTarget,
		};
	}

	private liveStatus(sessionId: string): IdeAgentSession['status'] {
		const last = this.getViewState(sessionId).turns.at(-1);
		if (!last) {
			return 'idle';
		}
		if (last.status === 'running') {
			return last.permissions.some(entry => entry.state === 'pending') || hasPendingElicitation(last) ? 'waiting-permission' : 'running';
		}
		if (last.status === 'failed') {
			return 'failed';
		}
		if (last.status === 'complete') {
			return 'complete';
		}
		return 'idle';
	}

	/**
	 * Loads a session, reads from it, and closes it again when it was not an open tab, so a
	 * history action on a closed chat does not bring it back as a tab, not even when its
	 * transcript fails to load (issue 82).
	 */
	private async borrowSession<T>(sessionId: string, read: (session: MutablePaneSession) => T): Promise<T> {
		const wasOpen = this._paneSessions.some(candidate => candidate.id === sessionId);
		try {
			await this.ensureLoaded(sessionId);
			const session = this._paneSessions.find(candidate => candidate.id === sessionId);
			if (!session) {
				throw new Error(localize('claudeSubmitClosed', "That agent session is not open."));
			}
			return read(session);
		} finally {
			if (!wasOpen && this._currentSessionId !== sessionId) {
				this.closeSession(sessionId);
			}
		}
	}

	private ensureLoaded(sessionId: string): Promise<void> {
		const existing = this._loadingSessions.get(sessionId);
		if (existing) {
			return existing;
		}
		const run = this.loadSession(sessionId).finally(() => {
			if (this._loadingSessions.get(sessionId) === run) {
				this._loadingSessions.delete(sessionId);
			}
		});
		this._loadingSessions.set(sessionId, run);
		return run;
	}

	private async loadSession(sessionId: string): Promise<void> {
		if (this._deletedSessions.has(sessionId)) {
			throw new Error(localize('claudeSubmitClosed', "That agent session is not open."));
		}
		let session = this._paneSessions.find(candidate => candidate.id === sessionId);
		if (!session && this._history) {
			const index = await this._history.readIndex();
			const record = index.sessions.find(candidate => candidate.id === sessionId);
			if (record) {
				// A pin or archive may still be on its way to disk. The cached record has it.
				const cached = this._historyRecords.get(sessionId);
				session = this.sessionFromRecord(cached ? { ...record, pinned: cached.pinned, archived: cached.archived } : record);
				this._paneSessions.push(session);
			}
		}
		if (!session) {
			throw new Error(localize('claudeSubmitClosed', "That agent session is not open."));
		}
		if (session.loaded || !this._history) {
			session.loaded = true;
			return;
		}
		const lines = await this._history.read(sessionId);
		const stored = lines.map(line => line.event as AgentReducerEvent);
		const replay = replayDurableEvents(stored);
		session.loaded = true;
		session.interrupted = replay.interrupted;
		this._diskEvents.set(sessionId, replay.events.slice());
		this._eventLog.set(sessionId, replay.events.slice(-CLAUDE_EVENT_LOG_CAP));
		this._viewStates.set(sessionId, replay.state);
		const saved = await this._history.readSession(sessionId);
		if (saved?.claudeSessionId) {
			session.claudeSessionId = saved.claudeSessionId;
		}
		if (saved?.checkpointIds) {
			session.checkpointIds = saved.checkpointIds.slice();
		}
		if (saved?.forkContext && !session.claudeSessionId) {
			session.forkContext = saved.forkContext;
		}
		if (typeof saved?.pinnedCommand === 'string' && saved.pinnedCommand) {
			session.pinnedCommand = saved.pinnedCommand;
		}
		if (typeof saved?.resumeAt === 'string' && saved.resumeAt && session.claudeSessionId) {
			session.resumeAt = saved.resumeAt;
		}
		if (typeof saved?.rewindNote === 'string' && saved.rewindNote) {
			session.rewindNote = saved.rewindNote;
		}
		if (replay.interrupted && stored.at(-1)?.type !== 'session.recovered') {
			await this._history.append(sessionId, { type: 'session.recovered' });
		}
		this.bumpInspector(sessionId);
		if (!this._store.isDisposed) {
			this._onDidChangeViewState.fire({ sessionId });
			this._onDidLoadSession.fire({ sessionId });
		}
		this.flushMeta(session);
	}

	private sessionFromRecord(record: SessionIndexRecord): MutablePaneSession {
		return {
			id: record.id,
			title: record.title,
			titleIsDefault: false,
			mode: record.mode,
			draft: '',
			attachments: [],
			additionalDirectories: [],
			slashCommands: [],
			skills: [],
			commands: [],
			agents: [],
			claudeSessionId: record.claudeSessionId,
			workspaceId: record.workspaceId,
			workspaceName: recordWorkspaceName(record),
			worktreePath: record.worktree?.path,
			interrupted: record.interrupted === true,
			resumeFailed: record.resumeFailed === true,
			resumeBlocked: false,
			createdAt: record.createdAt ?? record.updatedAt,
			updatedAt: record.updatedAt,
			checkpointIds: [...(record.checkpointIds ?? [])],
			loaded: false,
			pinned: record.pinned === true,
			archived: record.archived === true,
			...this.targetFromRecord(record),
		};
	}

	/** The saved Run in target, so a resumed session runs on the same host or container. A malformed one runs locally. */
	private targetFromRecord(record: SessionIndexRecord): Pick<MutablePaneSession, 'executionTarget' | 'targetInfo'> {
		const target = readClaudeExecutionTarget(record.executionTarget);
		return target && target.kind !== 'local' ? { executionTarget: target, targetInfo: claudeExecutionTargetInfo(target) } : {};
	}

	private workspaceIdentity(): { id: string; name: string } {
		const workspace = this._workspace.getWorkspace();
		const folder = workspace.folders[0];
		const name = folder ? basename(folder.uri) : workspace.configuration ? basename(workspace.configuration) : emptyWindowName();
		return { id: workspace.id || folder?.uri.toString() || 'workspace', name: name || emptyWindowName() };
	}

	private snapshot(session: MutablePaneSession): ClaudeAgentSession {
		return {
			id: session.id,
			title: session.title,
			mode: session.mode,
			modelId: session.modelId,
			modelName: session.modelName,
			draft: session.draft,
			attachments: session.attachments.slice(),
			additionalDirectories: session.additionalDirectories.slice(),
			slashCommands: session.slashCommands.slice(),
			skills: session.skills.slice(),
			commands: session.commands.slice(),
			agents: session.agents.slice(),
			claudeSessionId: session.claudeSessionId,
			workspaceName: session.workspaceName,
			worktreePath: session.worktreePath,
			executionTarget: session.executionTarget,
			targetInfo: session.targetInfo,
			interrupted: session.interrupted,
			resumeFailed: session.resumeFailed,
			updatedAt: session.updatedAt,
			pinned: session.pinned,
			archived: session.archived,
			pinnedCommand: session.pinnedCommand,
			delegatedFrom: session.delegatedFrom,
		};
	}

	private fireSessionChange(reason: ClaudeAgentSessionChangeReason): void {
		if (this._store.isDisposed) {
			return;
		}
		const sessions = this.getSessions();
		this._onDidChangeSession.fire({
			reason,
			session: sessions.find(session => session.id === this._currentSessionId),
			sessions,
		});
	}
}

function isStreamedDiskEvent(event: AgentReducerEvent): boolean {
	return event.type === 'assistant.delta' || event.type === 'thinking.delta' || event.type === 'tool.updated';
}

function mergeStreamEvent(left: AgentReducerEvent, right: AgentReducerEvent): AgentReducerEvent | undefined {
	if (left.type === 'assistant.delta' && right.type === 'assistant.delta' && left.parentRunId === right.parentRunId) {
		return { ...right, text: left.text + right.text };
	}
	// The empty delta that starts a thinking block keeps its own time, so a reopened session still knows how long Claude thought.
	if (left.type === 'thinking.delta' && right.type === 'thinking.delta' && left.parentRunId === right.parentRunId && (left.text.length > 0 || left.tokens !== undefined) && !left.done) {
		return { ...right, text: left.text + right.text, tokens: right.tokens ?? left.tokens };
	}
	if (left.type === 'tool.updated' && right.type === 'tool.updated' && left.callId === right.callId) {
		const update = mergeToolUpdate(left.update, right.update);
		return update === undefined ? undefined : { ...right, update };
	}
	return undefined;
}

function mergeToolUpdate(left: unknown, right: unknown): unknown {
	if (typeof left === 'string' && typeof right === 'string') {
		return left + right;
	}
	if (!isPlainRecord(left) || !isPlainRecord(right)) {
		return undefined;
	}
	const out: Record<string, unknown> = { ...right };
	for (const key of ['stdout', 'stderr', 'output', 'text']) {
		if (typeof left[key] === 'string' || typeof right[key] === 'string') {
			out[key] = `${typeof left[key] === 'string' ? left[key] : ''}${typeof right[key] === 'string' ? right[key] : ''}`;
		}
	}
	return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Puts an explicit snapshot ahead of buffers captured because they were dirty.
 * The checkpoint store keeps the first copy of a path, so the inline target wins.
 */
export function mergeCheckpointBuffers(explicit: readonly { readonly path: string; readonly text: string }[] | undefined, captured: readonly { readonly path: string; readonly text: string }[]): { path: string; text: string }[] {
	const merged: { path: string; text: string }[] = [];
	for (const buffer of explicit ?? []) {
		if (buffer.path && !merged.some(item => sameCheckpointPath(item.path, buffer.path))) {
			merged.push({ path: buffer.path, text: buffer.text });
		}
	}
	for (const buffer of captured) {
		if (buffer.path && !merged.some(item => sameCheckpointPath(item.path, buffer.path))) {
			merged.push({ path: buffer.path, text: buffer.text });
		}
	}
	return merged;
}

/** Checkpoint paths are file paths. Case follows the platform, not string equality. */
function sameCheckpointPath(left: string, right: string): boolean {
	return extUriBiasedIgnorePathCase.isEqual(URI.file(left), URI.file(right));
}

/** The workspace name of a chat started in a window with no folder. */
function emptyWindowName(): string {
	return localize('claudeEmptyWindow', "Empty Window");
}

/** Chats from a window with no folder were saved with its id, a timestamp, as the name (#82). */
function recordWorkspaceName(record: SessionIndexRecord): string {
	return record.workspaceName && record.workspaceName !== record.workspaceId ? record.workspaceName : emptyWindowName();
}
