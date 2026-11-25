/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { PlanArtifact, parsePlanArtifact } from '../../../../platform/claude/common/claudePlan.js';
import { SentPromptRecord } from '../../../../platform/claude/common/claudePrompt.js';
import { ClaudeAutoModelPick } from '../../../../platform/claude/common/claudeAutoModel.js';
import { AgentMode } from '../../../../platform/claude/common/claudeContext.js';
import { ClaudeUsageLimit } from '../../../../platform/claude/common/claudeAccounts.js';
import { ClaudeElicitationOutcome, ClaudeElicitationRequest, ClaudeElicitationSource } from '../../../../platform/claude/common/claudeElicitation.js';
import { ClaudeQuestionAnswers, ClaudeQuestionNotes } from '../../../../platform/claude/common/claudeQuestion.js';
import { AgentFailureKind, ClaudeGitHubReference, ClaudeSubagentRun, ClaudeSubagentState, CommandRisk, NormalizedClaudeEvent, PermissionOutcome, PermissionRequest, PermissionSource, TodoItem, ToolCategory, ToolResult, UsageInfo } from '../../../../platform/claude/common/claudeProtocol.js';
import { ClaudeEscalation } from '../../../../platform/claude/common/claudeDelegateLadder.js';
import { CLAUDE_DELEGATE_TOOL_ID } from '../../../../platform/claude/common/claudeDelegate.js';
import { appendCardOutput, completeToolCard, isSubagentToolName, outputText, projectToolCard, ToolCardModel } from './claudeToolCards.js';
import { ClaudeDelegateCard, replaceClaudeDelegateCard } from './claudeDelegationModel.js';

export type { ToolCardModel, ToolCardState } from './claudeToolCards.js';

export type TurnStatus = 'running' | 'complete' | 'failed' | 'stopped';

/**
 * One permission request in a turn. It is pending until the host or the user
 * settles it, then it stays as the record that session history shows.
 */
export interface PermissionEntry {
	readonly id: string;
	readonly toolName: string;
	readonly category?: ToolCategory;
	readonly command?: string;
	readonly cwd?: string;
	readonly targetPath?: string;
	readonly outsideWorkspace?: boolean;
	readonly risk?: CommandRisk;
	readonly why?: string;
	readonly reason?: string;
	/** False when only "Allow once" may be offered. */
	readonly canRemember: boolean;
	readonly state: 'pending' | 'allowed' | 'denied';
	readonly scope?: 'once' | 'session' | 'workspace';
	readonly source?: PermissionSource;
	/** What the decision covered, when the request was settled without a card. */
	readonly subject?: string;
	readonly message?: string;
	/** Subagent that asked, when the call happened inside one. */
	readonly askedBy?: string;
	/** Mode of the turn that asked. */
	readonly mode?: AgentMode;
	/** True when the card may offer Allow All Commands. */
	readonly canAllowAllCommands?: boolean;
	/** False when the workspace was untrusted when the host asked. */
	readonly workspaceTrusted?: boolean;
	/** The mode that refused a file write. */
	readonly blockedByMode?: AgentMode;
}

/**
 * One MCP elicitation in a turn (issue 428): a form or a sign-in URL an MCP
 * server asked for. It is pending until the user answers, it times out or the
 * session stops. It never holds what the user typed into a form; Claude's own
 * questions (issue 477) keep the answers, which Claude reads anyway.
 */
export interface ElicitationEntry extends ClaudeElicitationRequest {
	readonly state: 'pending' | 'accepted' | 'declined' | 'cancelled';
	readonly source?: ClaudeElicitationSource;
	/** The answers of an accepted question request, shown on the collapsed card. */
	readonly answers?: ClaudeQuestionAnswers;
	/** The notes added to those answers. */
	readonly notes?: ClaudeQuestionNotes;
	/** The text sent in place of answers, shown as "Replied: …". */
	readonly reply?: string;
	/** True once the server said the URL sign-in finished (`elicitation.completed`). */
	readonly completed?: boolean;
}

export interface TurnFailure {
	readonly message: string;
	readonly kind?: AgentFailureKind;
	/** Turns the query took when it stopped at its cap (kind `turn-limit`). */
	readonly turns?: number;
	/** The plan limit a `usage-limit` stop hit, for the banner that says which and when it resets (issue 450). */
	readonly limit?: ClaudeUsageLimit;
}

/** A run of assistant text between two other parts of a turn. */
export interface TurnTextPart {
	readonly kind: 'text';
	readonly id: string;
	readonly text: string;
	/** True while deltas still append to this segment. A tool start closes it. */
	readonly open: boolean;
	/** True once `assistant.completed` gave this segment its final text. */
	readonly completed: boolean;
}

/** The plan a Plan-mode turn ended with. `text` is the Markdown it was read from. */
export interface TurnPlanPart {
	readonly kind: 'plan';
	readonly id: string;
	readonly text: string;
}

/**
 * Claude's extended thinking before an answer or a tool. `text` is empty when
 * the runtime omitted or redacted it. `lastAt - startedAt` is how long it took.
 */
export interface TurnThinkingPart {
	readonly kind: 'thinking';
	readonly id: string;
	readonly text: string;
	/** True while the block still streams. Its end, text or another part closes it. */
	readonly open: boolean;
	readonly startedAt: number;
	readonly lastAt: number;
	/** The runtime's estimate of the block's size in tokens, when it sent one (issue 740). */
	readonly tokens?: number;
}

/**
 * One piece of a turn, in the order it happened. Tool, subagent and permission
 * parts name their model by id: `cards`, `AgentViewState.subagents` and
 * `permissions` hold the data.
 */
export type TurnPart =
	| TurnTextPart
	| TurnPlanPart
	| TurnThinkingPart
	| { readonly kind: 'tool'; readonly id: string }
	| { readonly kind: 'subagent'; readonly id: string }
	| { readonly kind: 'permission'; readonly id: string }
	/** A pull request or issue card (issue 430). `id` is the reference's URL. */
	| { readonly kind: 'github'; readonly id: string; readonly reference: ClaudeGitHubReference }
	| { readonly kind: 'elicitation'; readonly id: string }
	/** A delegated chat's card (issue 693). `delegates` holds the data. */
	| { readonly kind: 'delegate'; readonly id: string };

export interface TurnViewModel {
	readonly id: string;
	readonly user: { readonly text: string; readonly sent?: SentPromptRecord };
	/** Markdown. Streamed text plus completed message segments. */
	readonly assistantText: string;
	readonly status: TurnStatus;
	readonly cards: readonly ToolCardModel[];
	readonly changedFiles: readonly string[];
	readonly permissions: readonly PermissionEntry[];
	/** MCP forms and sign-ins the turn asked for. Absent until the first one. */
	readonly elicitations?: readonly ElicitationEntry[];
	/** Delegated chats the turn started (issue 693). Absent until the first one. */
	readonly delegates?: readonly ClaudeDelegateCard[];
	/** Issue 1009: set when a cheap turn Auto picked went back to the chat's own model. */
	readonly fallback?: ClaudeEscalation;
	readonly failure?: TurnFailure;
	/** Set when a Plan-mode turn completed with a numbered or bulleted answer. */
	readonly plan?: PlanArtifact;
	/** True while a streamed message has deltas but no `assistant.completed` yet. */
	readonly segmentOpen: boolean;
	readonly segmentStart: number;
	/** User messages pushed into this turn with Steer now. Oldest first. */
	readonly steered: readonly string[];
	/**
	 * Text, tools, subagents, permissions and the plan in event order. The
	 * reducer always sets it. `assistantText`, `cards` and `permissions` stay as
	 * views of the same data for readers that do not need the order.
	 */
	readonly parts?: readonly TurnPart[];
	/** When the pane submitted the turn. Absent in history written before turns were timed. */
	readonly startedAt?: number;
	/** When the turn completed, failed or was stopped. */
	readonly endedAt?: number;
	/**
	 * Claude Code's id for the last chain entry of a completed turn. A rewind to the
	 * next turn resumes the conversation there (issue 702). Absent on stopped or
	 * failed turns and in history written before rewinds.
	 */
	readonly anchor?: string;
}

/**
 * One subagent Claude started. Its chat is a normal timeline. It is not inlined
 * into the parent assistant text.
 */
export interface SubagentViewModel {
	readonly run: ClaudeSubagentRun;
	/** Pane turn that was running when this subagent started. */
	readonly parentTurnId: string;
	/** Subagents Claude started in the same turn share a group. */
	readonly groupId: string;
	readonly latestTool?: string;
	readonly chat: TurnViewModel;
}

export interface AgentViewState {
	readonly turns: readonly TurnViewModel[];
	readonly subagents: readonly SubagentViewModel[];
	/** The newest to-do list the main agent reported (`todo.changed`). */
	readonly todos?: readonly TodoItem[];
	/** The newest token counts the runtime reported (`usage.changed`). Never estimated. */
	readonly usage?: UsageInfo;
	/** The newest pull request this session created (`gh pr create`), for its pill (issue 430). */
	readonly pullRequest?: ClaudeGitHubReference;
}

export const EMPTY_AGENT_VIEW_STATE: AgentViewState = { turns: [], subagents: [] };

/** True while a subagent, delegated chat or background command started by `subagent.started` has not finished (issue 1617). */
export function hasLiveChildren(state: AgentViewState): boolean {
	return state.subagents.some(subagent => subagent.run.state === 'running');
}

/**
 * Actions the pane itself takes. Durable history stores them beside Claude
 * events so a reopened session can show the sent prompt. `turn.stopped` is
 * how Stop ends a turn: the runtime emits no terminal event after `interrupt()`.
 * `session.recovered` marks a crash. It does not start a tool.
 */
export type AgentLocalAction =
	| { type: 'turn.submitted'; turnId: string; text: string; sent?: SentPromptRecord; startedAt?: number }
	| { type: 'turn.stopped'; endedAt?: number }
	| { type: 'turn.failed'; message: string; kind?: AgentFailureKind; endedAt?: number }
	| { type: 'turn.steered'; text: string }
	/** Auto model picked the turn's model after the turn was submitted (issue 521). */
	| { type: 'turn.routed'; turnId: string; auto: ClaudeAutoModelPick }
	/** A delegated chat started or changed (issue 693). The card goes in its parent turn. */
	| { type: 'turn.delegate'; card: ClaudeDelegateCard }
	/** Auto delegated the turn and the delegated chat answered, so the turn is complete (issue 693). */
	| { type: 'turn.delegated'; turnId: string; endedAt?: number }
	| { type: 'session.recovered'; endedAt?: number }
	/** The user went back to edit this turn's prompt: it and every later turn leave the chat (issue 702). */
	| { type: 'turn.rewound'; turnId: string }
	| { type: 'command.rerun'; command: string; cwd?: string; allowed: boolean; source: 'user' | 'policy'; reason?: string };

export type AgentReducerEvent = NormalizedClaudeEvent | AgentLocalAction;

const SEGMENT_SEPARATOR = '\n\n';

export function reduceAgentState(state: AgentViewState, event: AgentReducerEvent): AgentViewState {
	if (event.type === 'session.recovered') {
		return recoverInterrupted(state, event.endedAt);
	}
	if (event.type === 'command.rerun') {
		return recordCommandRerun(state, event);
	}
	if (event.type === 'turn.rewound') {
		return rewindTurns(state, event.turnId);
	}
	if (event.type === 'todo.changed') {
		return event.parentRunId === undefined ? { ...state, todos: event.items } : state;
	}
	if (event.type === 'usage.changed') {
		return event.parentRunId === undefined ? { ...state, usage: event.usage } : state;
	}
	if (event.type === 'github.referenceDetected' && event.reference.createdBySession && event.reference.kind === 'pullRequest') {
		state = { ...state, pullRequest: event.reference };
	}
	if (event.type === 'turn.routed') {
		return routeTurn(state, event.turnId, event.auto);
	}
	if (event.type === 'turn.delegate') {
		return noteDelegate(state, event.card);
	}
	if (event.type === 'turn.submitted') {
		const current = state.turns[state.turns.length - 1];
		if (current?.status === 'running') {
			return state;
		}
		const turn: TurnViewModel = {
			id: event.turnId,
			user: { text: event.text, sent: event.sent },
			assistantText: '',
			status: 'running',
			cards: [],
			changedFiles: [],
			permissions: [],
			segmentOpen: false,
			segmentStart: 0,
			steered: [],
			parts: [],
			...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
		};
		return { ...state, turns: [...state.turns, turn] };
	}
	// A sign-in can finish after its turn ended, so it marks the entry wherever it is.
	if (event.type === 'elicitation.completed') {
		return completeElicitation(state, event.server, event.elicitationId);
	}
	// Subagent output belongs to its own chat (section 16a), never the parent text.
	if (isRuntimeEvent(event) && event.parentRunId !== undefined) {
		return reduceSubagentEvent(state, event);
	}
	const last = state.turns[state.turns.length - 1];
	if (!last || last.status !== 'running') {
		return reduceIdleParent(state, event);
	}
	if (isRuntimeEvent(event) && event.type === 'subagent.started') {
		return addSubagent(state, last.id, event.run);
	}
	if (isRuntimeEvent(event) && event.type === 'subagent.finished') {
		return finishSubagent(state, event);
	}
	let next = reduceTurn(last, event);
	if (next === last) {
		return state;
	}
	const endedAt = next.status !== last.status ? endedAtOf(event) : undefined;
	if (endedAt !== undefined) {
		next = { ...next, endedAt };
	}
	const turns = [...state.turns.slice(0, -1), next];
	const subagents = next.status === last.status ? state.subagents : settleSubagents(state.subagents, last.id, next.status, endedAtOf(event));
	return { ...state, turns, subagents };
}

/** Drops the turn and every later one, with the subagents they started (issue 702). */
function rewindTurns(state: AgentViewState, turnId: string): AgentViewState {
	const index = state.turns.findIndex(turn => turn.id === turnId);
	if (index < 0) {
		return state;
	}
	const dropped = new Set(state.turns.slice(index).map(turn => turn.id));
	return { ...state, turns: state.turns.slice(0, index), subagents: state.subagents.filter(subagent => !dropped.has(subagent.parentTurnId)) };
}

/** A background subagent can finish after its parent turn has already ended. */
function reduceIdleParent(state: AgentViewState, event: AgentReducerEvent): AgentViewState {
	if (!isRuntimeEvent(event)) {
		return state;
	}
	if (event.type === 'subagent.started') {
		const turn = [...state.turns].reverse().find(candidate => candidate.status === 'complete' || candidate.status === 'running') ?? state.turns[state.turns.length - 1];
		return turn ? addSubagent(state, turn.id, event.run) : state;
	}
	if (event.type === 'subagent.finished') {
		return finishSubagent(state, event);
	}
	return state;
}

/** Records Auto's pick on the turn's sent prompt, so its header names the model it ran. */
function routeTurn(state: AgentViewState, turnId: string, auto: ClaudeAutoModelPick): AgentViewState {
	const index = state.turns.findIndex(turn => turn.id === turnId);
	const turn = state.turns[index];
	if (!turn?.user.sent) {
		return state;
	}
	const turns = state.turns.slice();
	turns[index] = { ...turn, user: { ...turn.user, sent: { ...turn.user.sent, modelId: auto.modelId, auto } } };
	return { ...state, turns };
}

/** Puts a delegate card in its turn, or updates it there (issue 693). */
function noteDelegate(state: AgentViewState, card: ClaudeDelegateCard): AgentViewState {
	let index = state.turns.findIndex(turn => turn.id === card.parentTurnId);
	if (index < 0) {
		index = state.turns.length - 1;
	}
	const turn = state.turns[index];
	if (!turn) {
		return state;
	}
	const known = turn.delegates?.some(entry => entry.id === card.id);
	const delegates = replaceClaudeDelegateCard(turn.delegates ?? [], card);
	const next = known ? { ...turn, delegates } : { ...addPart(turn, { kind: 'delegate', id: card.id }), delegates };
	const turns = state.turns.slice();
	turns[index] = next;
	return { ...state, turns };
}

function isRuntimeEvent(event: AgentReducerEvent): event is NormalizedClaudeEvent {
	return event.type !== 'turn.submitted' && event.type !== 'turn.routed' && event.type !== 'turn.delegate' && event.type !== 'turn.delegated' && event.type !== 'turn.stopped' && event.type !== 'turn.failed' && event.type !== 'turn.steered' && event.type !== 'turn.rewound' && event.type !== 'command.rerun';
}

function endedAtOf(event: AgentReducerEvent): number | undefined {
	switch (event.type) {
		case 'session.completed':
		case 'session.failed':
		case 'turn.stopped':
		case 'turn.failed':
		case 'turn.delegated':
		case 'subagent.finished':
			return event.endedAt;
		default:
			return undefined;
	}
}

function reduceTurn(turn: TurnViewModel, event: Exclude<AgentReducerEvent, { type: 'turn.submitted' }>): TurnViewModel {
	switch (event.type) {
		case 'assistant.delta':
			return appendDelta(turn, event.text);
		case 'assistant.completed':
			return completeText(turn, event.text, false);
		case 'thinking.delta':
			return appendThinking(turn, event.text, event.at, event.done === true, event.tokens);
		case 'tool.started':
			// The delegate tool shows as its delegate card, not as a tool card (issue 693).
			if (isSubagentToolName(event.call.name) || event.call.name === CLAUDE_DELEGATE_TOOL_ID || turn.cards.some(card => card.id === event.call.id)) {
				return turn;
			}
			return { ...addPart(turn, { kind: 'tool', id: event.call.id }), cards: [...turn.cards, projectToolCard(event.call)] };
		case 'tool.updated':
			return updateCardOutput(turn, event.callId, outputText(event.update));
		case 'tool.completed':
			return completeCard(turn, event.callId, event.result);
		case 'permission.requested':
			return turn.permissions.some(entry => entry.id === event.request.id)
				? turn
				: { ...addPart(turn, { kind: 'permission', id: event.request.id }), permissions: [...turn.permissions, toPendingEntry(event.request)] };
		case 'permission.resolved':
			return settlePermission(turn, event.outcome);
		case 'github.referenceDetected':
			return addGitHubReference(turn, event.reference);
		case 'elicitation.requested':
			return turn.elicitations?.some(entry => entry.id === event.request.id)
				? turn
				: { ...addPart(turn, { kind: 'elicitation', id: event.request.id }), elicitations: [...turn.elicitations ?? [], { ...event.request, state: 'pending' }] };
		case 'elicitation.resolved':
			return settleElicitation(turn, event.outcome);
		case 'file.afterWrite':
			return turn.changedFiles.includes(event.uri) ? turn : { ...turn, changedFiles: [...turn.changedFiles, event.uri] };
		case 'session.completed': {
			const finished = finish(turn, 'complete', 'cancelled');
			const done = event.anchor ? { ...finished, anchor: event.anchor } : finished;
			return turn.user.sent?.mode === 'plan' ? withPlan(done) : done;
		}
		case 'session.failed':
			return { ...finish(turn, 'failed', 'failed'), failure: { message: event.message, kind: event.kind, ...(event.turns !== undefined ? { turns: event.turns } : {}), ...(event.limit ? { limit: event.limit } : {}) } };
		case 'turn.failed':
			return { ...finish(turn, 'failed', 'failed'), failure: { message: event.message, kind: event.kind } };
		case 'turn.stopped':
			return finish(turn, 'stopped', 'cancelled');
		case 'turn.delegated':
			return event.turnId === turn.id ? finish(turn, 'complete', 'cancelled') : turn;
		case 'turn.steered': {
			const text = event.text.trim();
			return text ? { ...turn, steered: [...turn.steered, text] } : turn;
		}
		default:
			return turn;
	}
}

/**
 * The parts of a turn in event order. A turn built without `parts` (for
 * example by older code) gets its text first, then its tools, then its
 * permissions, which is the order the timeline used before parts existed.
 */
export function turnParts(turn: TurnViewModel): readonly TurnPart[] {
	if (turn.parts) {
		return turn.parts;
	}
	const parts: TurnPart[] = [];
	if (turn.assistantText) {
		parts.push(turn.plan
			? { kind: 'plan', id: 'text', text: turn.assistantText }
			: { kind: 'text', id: 'text', text: turn.assistantText, open: turn.segmentOpen, completed: !turn.segmentOpen });
	}
	for (const card of turn.cards) {
		parts.push({ kind: 'tool', id: card.id });
	}
	for (const entry of turn.permissions) {
		parts.push({ kind: 'permission', id: entry.id });
	}
	return parts;
}

/** Appends streamed text to the open segment, or opens a new one after any other part. */
function appendDelta(turn: TurnViewModel, text: string): TurnViewModel {
	if (text.length === 0) {
		return turn;
	}
	const parts = turnParts(turn);
	const last = parts[parts.length - 1];
	if (last?.kind === 'text' && last.open) {
		const next = parts.slice();
		next[next.length - 1] = { ...last, text: last.text + text };
		// The open segment is the newest text, so the joined text only grows at its end.
		return last.text.length > 0
			? { ...turn, parts: next, assistantText: turn.assistantText + text, segmentOpen: true }
			: withParts(turn, next);
	}
	return withParts(turn, [...closeOpenPart(parts), { kind: 'text', id: `t${parts.length}`, text, open: true, completed: false }]);
}

/** Appends to the open thinking block, or starts one after any other part. */
function appendThinking(turn: TurnViewModel, text: string, at: number, done: boolean, tokens: number | undefined): TurnViewModel {
	const parts = turnParts(turn);
	const last = parts[parts.length - 1];
	if (last?.kind === 'thinking' && last.open) {
		const next = parts.slice();
		next[next.length - 1] = { ...last, text: last.text + text, open: !done, lastAt: Math.max(last.lastAt, at), tokens: tokens === undefined ? last.tokens : Math.max(last.tokens ?? 0, tokens) };
		return { ...turn, parts: next };
	}
	if (tokens !== undefined && text.length === 0) {
		// A size estimate only updates an open block; it never starts one.
		return turn;
	}
	return addPart(turn, { kind: 'thinking', id: `k${parts.length}`, text, open: !done, startedAt: at, lastAt: at });
}

/**
 * Gives the newest text segment its final text while it still waits for one.
 * A tool can start between the deltas and the completion of the same message,
 * so that segment may already be closed. Otherwise the text is a new segment.
 * With `skipSame`, text equal to the newest segment is not repeated.
 */
function completeText(turn: TurnViewModel, text: string, skipSame: boolean): TurnViewModel {
	const parts = turnParts(turn);
	const index = newestTextIndex(parts);
	const newest = index >= 0 ? parts[index] : undefined;
	if (newest?.kind === 'text' && !newest.completed) {
		const next = parts.slice();
		next[index] = { ...newest, text, open: false, completed: true };
		return withParts(turn, next);
	}
	if (!text || (skipSame && newest?.kind === 'text' && newest.text === text)) {
		return turn;
	}
	return withParts(turn, [...closeOpenPart(parts), { kind: 'text', id: `t${parts.length}`, text, open: false, completed: true }]);
}

function newestTextIndex(parts: readonly TurnPart[]): number {
	for (let index = parts.length - 1; index >= 0; index--) {
		if (parts[index].kind === 'text') {
			return index;
		}
	}
	return -1;
}

/** Closes the open text segment or thinking block and appends `part` after it. */
/** One card per URL in a turn; a second sighting only marks it as created by this session. */
function addGitHubReference(turn: TurnViewModel, reference: ClaudeGitHubReference): TurnViewModel {
	const parts = turnParts(turn);
	const index = parts.findIndex(part => part.kind === 'github' && part.id === reference.url);
	if (index < 0) {
		return addPart(turn, { kind: 'github', id: reference.url, reference });
	}
	if (!reference.createdBySession) {
		return turn;
	}
	const next = parts.slice();
	next[index] = { kind: 'github', id: reference.url, reference };
	return withParts(turn, next);
}

function addPart(turn: TurnViewModel, part: TurnPart): TurnViewModel {
	return withParts(turn, [...closeOpenPart(turnParts(turn)), part]);
}

/** Closes the open text segment or thinking block, which is always the newest part. */
function closeOpenPart(parts: readonly TurnPart[]): readonly TurnPart[] {
	const last = parts[parts.length - 1];
	if ((last?.kind !== 'text' && last?.kind !== 'thinking') || !last.open) {
		return parts;
	}
	const next = parts.slice();
	next[next.length - 1] = { ...last, open: false };
	return next;
}

/** Sets `parts` and the views derived from them: the joined text and the open segment. */
function withParts(turn: TurnViewModel, parts: readonly TurnPart[]): TurnViewModel {
	let assistantText = '';
	let segmentOpen = false;
	let segmentStart = turn.segmentStart;
	for (const part of parts) {
		if (part.kind !== 'text' && part.kind !== 'plan') {
			continue;
		}
		const joined = assistantText.length > 0 && part.text.length > 0 ? assistantText + SEGMENT_SEPARATOR : assistantText;
		if (part.kind === 'text' && part.open) {
			segmentOpen = true;
			segmentStart = joined.length;
		}
		if (part.text.length > 0) {
			assistantText = joined + part.text;
		}
	}
	return { ...turn, parts, assistantText, segmentOpen, segmentStart };
}

/**
 * Reads the plan of a finished Plan-mode turn. The newest text segment is the
 * answer, so the plan takes its place and earlier narration stays. A plan
 * spread over several segments is read from all the text, which then shows
 * only as the plan, where the newest segment was.
 */
function withPlan(turn: TurnViewModel): TurnViewModel {
	const parts = turnParts(turn);
	const index = newestTextIndex(parts);
	const newest = index >= 0 ? parts[index] : undefined;
	if (newest?.kind !== 'text') {
		return turn;
	}
	const own = parsePlanArtifact(newest.text);
	if (own) {
		const next = parts.slice();
		next[index] = { kind: 'plan', id: newest.id, text: newest.text };
		return { ...withParts(turn, next), plan: own };
	}
	const whole = parsePlanArtifact(turn.assistantText);
	if (!whole) {
		return turn;
	}
	const next: TurnPart[] = [];
	parts.forEach((part, position) => {
		if (position === index) {
			next.push({ kind: 'plan', id: newest.id, text: turn.assistantText });
		} else if (part.kind !== 'text') {
			next.push(part);
		}
	});
	return { ...withParts(turn, next), plan: whole };
}

function finish(turn: TurnViewModel, status: TurnStatus, runningCardsBecome: 'failed' | 'cancelled' | 'interrupted'): TurnViewModel {
	// Keep partial text and cards. Tools that never reported a result are not claimed as done.
	return {
		...turn,
		status,
		parts: closeOpenPart(turnParts(turn)),
		segmentOpen: false,
		cards: turn.cards.map(card => card.state === 'running' ? {
			...card,
			state: runningCardsBecome,
			verb: runningCardsBecome === 'interrupted' ? localize('claudeToolInterrupted', "Interrupted") : card.verb,
		} : card),
		// A request nobody answered is a denial: the host denies it when the session stops.
		permissions: turn.permissions.map(entry => entry.state === 'pending' ? { ...entry, state: 'denied' as const, source: 'session-stopped' as const } : entry),
		// The runtime answers an open form or sign-in with cancel when the session stops.
		...(turn.elicitations ? { elicitations: turn.elicitations.map(entry => entry.state === 'pending' ? { ...entry, state: 'cancelled' as const, source: 'session-stopped' as const } : entry) } : {}),
	};
}

function settleElicitation(turn: TurnViewModel, outcome: ClaudeElicitationOutcome): TurnViewModel {
	const state = outcome.action === 'accept' ? 'accepted' : outcome.action === 'decline' ? 'declined' : 'cancelled';
	if (!turn.elicitations?.some(entry => entry.id === outcome.id && entry.state === 'pending')) {
		return turn;
	}
	return { ...turn, elicitations: turn.elicitations.map(entry => entry.id === outcome.id ? { ...entry, state, source: outcome.source, ...(outcome.answers ? { answers: outcome.answers } : {}), ...(outcome.notes ? { notes: outcome.notes } : {}), ...(outcome.reply ? { reply: outcome.reply } : {}) } : entry) };
}

function completeElicitation(state: AgentViewState, server: string, elicitationId: string): AgentViewState {
	const matches = (entry: ElicitationEntry) => entry.server === server && entry.elicitationId === elicitationId && !entry.completed;
	const index = state.turns.findIndex(turn => turn.elicitations?.some(matches));
	if (index < 0) {
		return state;
	}
	const turn = state.turns[index];
	const turns = [...state.turns];
	turns[index] = { ...turn, elicitations: turn.elicitations?.map(entry => matches(entry) ? { ...entry, completed: true } : entry) };
	return { ...state, turns };
}

/** True while an MCP server waits for a form or a sign-in in this turn. */
export function hasPendingElicitation(turn: TurnViewModel): boolean {
	return turn.elicitations?.some(entry => entry.state === 'pending') ?? false;
}

function toPendingEntry(request: PermissionRequest): PermissionEntry {
	return {
		id: request.id,
		toolName: request.toolName,
		category: request.category,
		command: request.command,
		cwd: request.cwd,
		targetPath: request.targetPath,
		outsideWorkspace: request.outsideWorkspace,
		risk: request.risk,
		why: request.why,
		reason: request.reason,
		canRemember: request.canRemember !== false,
		state: 'pending',
		mode: request.mode,
		canAllowAllCommands: request.canAllowAllCommands === true,
		workspaceTrusted: request.workspaceTrusted,
	};
}

/** Settles a pending entry, or records a decision the host made without a card. */
function settlePermission(turn: TurnViewModel, outcome: PermissionOutcome): TurnViewModel {
	const state = outcome.decision === 'allow' ? 'allowed' as const : 'denied' as const;
	const existing = turn.permissions.find(entry => entry.id === outcome.requestId);
	if (!existing) {
		const entry: PermissionEntry = { id: outcome.requestId, toolName: outcome.toolName, canRemember: false, state, scope: outcome.scope, source: outcome.source, subject: outcome.subject, message: outcome.message, blockedByMode: outcome.blockedByMode };
		return { ...addPart(turn, { kind: 'permission', id: entry.id }), permissions: [...turn.permissions, entry] };
	}
	if (existing.state !== 'pending') {
		return turn;
	}
	const settled: PermissionEntry = { ...existing, state, scope: outcome.scope, source: outcome.source, subject: outcome.subject ?? existing.subject, message: outcome.message };
	return { ...turn, permissions: turn.permissions.map(entry => entry.id === existing.id ? settled : entry) };
}

function updateCardOutput(turn: TurnViewModel, callId: string, text: string): TurnViewModel {
	if (!text || !turn.cards.some(card => card.id === callId)) {
		return turn;
	}
	return { ...turn, cards: turn.cards.map(card => card.id === callId ? appendCardOutput(card, text) : card) };
}

function completeCard(turn: TurnViewModel, callId: string, result: ToolResult): TurnViewModel {
	if (!turn.cards.some(card => card.id === callId)) {
		return turn;
	}
	return { ...turn, cards: turn.cards.map(card => card.id === callId ? completeToolCard(card, result) : card) };
}

function addSubagent(state: AgentViewState, parentTurnId: string, run: ClaudeSubagentRun): AgentViewState {
	if (state.subagents.some(subagent => subagent.run.id === run.id)) {
		return state;
	}
	const parent = state.subagents.find(subagent => subagent.run.id === run.parentRunId);
	const groupId = parent?.groupId ?? parentTurnId;
	const view: SubagentViewModel = {
		run,
		parentTurnId: parent?.parentTurnId ?? parentTurnId,
		groupId,
		chat: emptyChat(`subagent:${run.id}`, run.description),
	};
	const part: TurnPart = { kind: 'subagent', id: run.id };
	// A subagent shows where it started: in its parent subagent's chat, or in the pane turn.
	if (parent) {
		const subagents = state.subagents.map(subagent => subagent === parent ? { ...subagent, chat: addPart(subagent.chat, part) } : subagent);
		return { ...state, subagents: [...subagents, view] };
	}
	const turns = run.parentRunId === undefined
		? state.turns.map(turn => turn.id === parentTurnId ? addPart(turn, part) : turn)
		: state.turns;
	return { ...state, turns, subagents: [...state.subagents, view] };
}

/** The subagent's result ends its chat, unless its newest message already says the same. */
function withResult(chat: TurnViewModel, resultText: string | undefined): TurnViewModel {
	return resultText ? completeText(chat, resultText, true) : chat;
}

function finishSubagent(state: AgentViewState, event: Extract<NormalizedClaudeEvent, { type: 'subagent.finished' }>): AgentViewState {
	if (!state.subagents.some(subagent => subagent.run.id === event.runId)) {
		return state;
	}
	return {
		...state,
		subagents: state.subagents.map(subagent => subagent.run.id === event.runId ? {
			...subagent,
			run: {
				...subagent.run,
				state: event.state,
				resultText: event.resultText ?? subagent.run.resultText,
				endedAt: subagent.run.endedAt ?? event.endedAt,
				interruptedParent: event.interruptedParent === true || subagent.run.interruptedParent === true,
			},
			chat: withResult(finish(subagent.chat, event.state === 'failed' ? 'failed' : event.state === 'stopped' ? 'stopped' : 'complete', event.state === 'failed' ? 'failed' : 'cancelled'), event.resultText),
		} : subagent),
	};
}

function settleSubagents(subagents: readonly SubagentViewModel[], turnId: string, status: TurnStatus, endedAt: number | undefined): readonly SubagentViewModel[] {
	return subagents.map(subagent => {
		if (subagent.parentTurnId !== turnId || subagent.run.state !== 'running') {
			return subagent;
		}
		if (status === 'complete' && subagent.run.background) {
			return subagent;
		}
		const next: ClaudeSubagentState = status === 'stopped' ? 'stopped' : status === 'failed' ? 'failed' : 'success';
		return {
			...subagent,
			run: { ...subagent.run, state: next, endedAt: subagent.run.endedAt ?? endedAt },
			chat: finish(subagent.chat, status === 'running' ? 'complete' : status, next === 'failed' ? 'failed' : 'cancelled'),
		};
	});
}

/** Crash recovery. Running tools become interrupted. Nothing is sent to Claude. */
function recoverInterrupted(state: AgentViewState, endedAt: number | undefined): AgentViewState {
	const message = localize('claudeSessionInterrupted', "Agent session was interrupted");
	return {
		...state,
		turns: state.turns.map(turn => {
			if (turn.status !== 'running') {
				return turn;
			}
			const stopped = finish(turn, 'stopped', 'interrupted');
			return { ...stopped, failure: turn.failure ?? { message, kind: 'process-crash' } };
		}),
		subagents: state.subagents.map(subagent => {
			if (subagent.run.state !== 'running') {
				return subagent;
			}
			return {
				...subagent,
				run: { ...subagent.run, state: 'stopped', endedAt: subagent.run.endedAt ?? endedAt },
				chat: finish(subagent.chat, 'stopped', 'interrupted'),
			};
		}),
	};
}

function recordCommandRerun(state: AgentViewState, event: Extract<AgentLocalAction, { type: 'command.rerun' }>): AgentViewState {
	const index = state.turns.length - 1;
	const turn = state.turns[index];
	if (!turn) {
		return state;
	}
	const entry: PermissionEntry = {
		id: `rerun:${turn.permissions.length}:${event.command}`,
		toolName: 'Bash',
		category: 'shell',
		command: event.command,
		cwd: event.cwd,
		canRemember: false,
		state: event.allowed ? 'allowed' : 'denied',
		source: event.source,
		subject: event.command,
		message: event.reason,
	};
	const turns = state.turns.slice();
	turns[index] = { ...addPart(turn, { kind: 'permission', id: entry.id }), permissions: [...turn.permissions, entry] };
	return { ...state, turns };
}

function emptyChat(id: string, description: string): TurnViewModel {
	return {
		id,
		user: { text: description },
		assistantText: '',
		status: 'running',
		cards: [],
		changedFiles: [],
		permissions: [],
		segmentOpen: false,
		segmentStart: 0,
		steered: [],
		parts: [],
	};
}

function reduceSubagentEvent(state: AgentViewState, event: NormalizedClaudeEvent): AgentViewState {
	const parentRunId = event.parentRunId;
	if (!parentRunId) {
		return state;
	}
	if (event.type === 'subagent.started') {
		const host = state.turns[state.turns.length - 1];
		return host ? addSubagent(state, host.id, event.run) : state;
	}
	if (event.type === 'subagent.finished') {
		return finishSubagent(state, event);
	}
	const owner = state.subagents.find(subagent => subagent.run.id === parentRunId);
	if (!owner) {
		if (event.type !== 'permission.requested' && event.type !== 'permission.resolved') {
			return state;
		}
		const host = state.turns[state.turns.length - 1];
		if (!host) {
			return state;
		}
		const next = reduceTurn(host, event);
		if (next === host) {
			return state;
		}
		const turns = state.turns.slice();
		turns[turns.length - 1] = next;
		return { ...state, turns };
	}
	const chat = reduceTurn(owner.chat, event);
	const named = event.type === 'permission.requested' ? namePermission(chat, owner.run.agentType, event.request.id) : chat;
	let latestTool = owner.latestTool;
	let toolCallCount = owner.run.toolCallCount;
	if (event.type === 'tool.started' && !isSubagentToolName(event.call.name) && !owner.chat.cards.some(candidate => candidate.id === event.call.id)) {
		const card = named.cards.find(candidate => candidate.id === event.call.id);
		latestTool = card ? `${card.verb} ${card.target}` : event.call.display.label;
		toolCallCount += 1;
	}
	if (named === owner.chat && latestTool === owner.latestTool && toolCallCount === owner.run.toolCallCount) {
		return state;
	}
	return {
		...state,
		subagents: state.subagents.map(subagent => subagent.run.id === owner.run.id ? { ...subagent, chat: named, latestTool, run: { ...subagent.run, toolCallCount } } : subagent),
	};
}

function namePermission(chat: TurnViewModel, agentType: string, requestId: string): TurnViewModel {
	return {
		...chat,
		permissions: chat.permissions.map(entry => entry.id === requestId ? { ...entry, askedBy: entry.askedBy ?? agentType } : entry),
	};
}

/**
 * Title and optional detail for a failed turn. The title comes from the failure
 * kind. The runtime message is the detail when it adds something. This does not
 * invent checkpoint or review state.
 */
export function describeFailure(failure: TurnFailure | undefined): { readonly title: string; readonly description?: string } {
	const message = failure?.message.trim() || undefined;
	switch (failure?.kind) {
		case 'auth':
			return withDetail(localize('claudeFailAuth', "Claude is not signed in."), message);
		case 'usage-limit':
			return withDetail(localize('claudeFailUsage', "Claude reached its current usage limit."), message);
		case 'network':
			return withDetail(localize('claudeFailNetwork', "Claude could not be reached."), message);
		case 'runtime-missing':
			return withDetail(localize('claudeFailRuntimeMissing', "Claude is not installed."), message);
		case 'runtime-version':
			return withDetail(localize('claudeFailRuntimeVersion', "This Claude version is not supported."), message);
		case 'permission-denied':
			return withDetail(localize('claudeFailPermission', "Claude was not allowed to use a tool."), message);
		case 'tool-failure':
			return withDetail(localize('claudeFailTool', "A tool failed."), message);
		case 'process-crash':
			return withDetail(localize('claudeFailCrash', "Claude stopped unexpectedly."), message);
		case 'workspace-conflict':
			return withDetail(localize('claudeFailWorkspace', "The workspace changed while Claude was working."), message);
		case 'session-owned':
			return withDetail(localize('claudeFailSessionOwned', "This chat is already running in another window."), message);
		case 'turn-limit':
			// A cap, not an error (issues 696, 707): the timeline shows it as a note with Continue.
			return failure?.turns === undefined
				? { title: localize('claudeFailTurnLimit', "Claude stopped at its step limit.") }
				: { title: localize('claudeFailTurnLimitN', "Claude stopped after {0} steps.", failure.turns) };
		case 'unknown':
			return withDetail(localize('claudeFailUnknown', "The agent stopped with an error."), message);
		default:
			return { title: message ?? localize('claudeFailedGeneric', "The agent stopped with an error.") };
	}
}

function withDetail(title: string, message: string | undefined): { readonly title: string; readonly description?: string } {
	return message && message !== title ? { title, description: message } : { title };
}

/**
 * Permission cards shown with a turn. A focused subagent includes requests from
 * nested runs. The parent turn includes every subagent of that turn.
 */
export function permissionsForTimeline(turn: TurnViewModel, subagents: readonly SubagentViewModel[], focusRunId: string | undefined): readonly PermissionEntry[] {
	const related = focusRunId
		? descendantsOf(focusRunId, subagents)
		: subagents.filter(subagent => subagent.parentTurnId === turn.id);
	const seen = new Set(turn.permissions.map(entry => entry.id));
	const extra: PermissionEntry[] = [];
	for (const subagent of related) {
		for (const entry of subagent.chat.permissions) {
			if (!seen.has(entry.id)) {
				seen.add(entry.id);
				extra.push(entry);
			}
		}
	}
	return extra.length === 0 ? turn.permissions : [...turn.permissions, ...extra];
}

function descendantsOf(runId: string, subagents: readonly SubagentViewModel[]): SubagentViewModel[] {
	const children = subagents.filter(subagent => subagent.run.parentRunId === runId);
	return [...children, ...children.flatMap(child => descendantsOf(child.run.id, subagents))];
}

/** Title for a permission card. A subagent is named when `askedBy` is set. */
export function describePermissionPrompt(entry: PermissionEntry): string {
	if (entry.askedBy && entry.risk === 'credentials') {
		return localize('claudePermissionNamedCredentials', "{0}: this touches credentials", entry.askedBy);
	}
	if (entry.askedBy && entry.risk === 'destructive') {
		return localize('claudePermissionNamedDestructive', "{0}: this command can delete data", entry.askedBy);
	}
	if (entry.askedBy) {
		if (entry.command) {
			return localize('claudePermissionNamedCommand', "{0} wants to run `{1}`", entry.askedBy, entry.command);
		}
		if (entry.targetPath) {
			return localize('claudePermissionNamedPath', "{0} wants to use {1}", entry.askedBy, entry.targetPath);
		}
		return localize('claudePermissionNamedTool', "{0} wants to use {1}", entry.askedBy, entry.toolName);
	}
	if (entry.risk === 'credentials') {
		return localize('claudePermissionTitleCredentials', "This touches credentials");
	}
	if (entry.risk === 'destructive') {
		return localize('claudePermissionTitleDestructive', "This command can delete data");
	}
	switch (entry.category) {
		case 'shell': return localize('claudePermissionTitleShell', "Run this command?");
		case 'write': return entry.outsideWorkspace
			? localize('claudePermissionTitleWriteOutside', "Write a file outside this workspace?")
			: localize('claudePermissionTitleWrite', "Change this file?");
		case 'read':
		case 'search': return localize('claudePermissionTitleRead', "Read outside this workspace?");
		case 'web': return localize('claudePermissionTitleWeb', "Use the network?");
		default: return localize('claudePermissionTitleTool', "Use this tool?");
	}
}

/**
 * One short line for the newest running tool, for example "Reading src/x.ts".
 * Returns undefined when no tool is running. Never prints tool input.
 */
export function describeActivity(turn: TurnViewModel): string | undefined {
	if (turn.status !== 'running') {
		return undefined;
	}
	if (turn.permissions.some(entry => entry.state === 'pending')) {
		return localize('claudeActivityPermission', "Waiting for your approval");
	}
	if (hasPendingElicitation(turn)) {
		return localize('claudeActivityElicitation', "Waiting for your input");
	}
	const running = turn.cards.filter(card => card.state === 'running');
	const card = running[running.length - 1];
	if (!card) {
		return undefined;
	}
	switch (card.category) {
		case 'read':
			return card.file ? localize('claudeActivityRead', "Reading {0}", card.file) : card.label;
		case 'search':
			return card.query ? localize('claudeActivitySearch', "Searching \"{0}\"", card.query) : card.label;
		case 'write': {
			const writes = running.filter(candidate => candidate.category === 'write');
			if (writes.length > 1) {
				return localize('claudeActivityEditMany', "Editing {0} files", writes.length);
			}
			return card.file ? localize('claudeActivityEdit', "Editing {0}", card.file) : card.label;
		}
		case 'shell':
			return card.command ? localize('claudeActivityRun', "Running {0}", card.command) : card.label;
		default:
			return card.label;
	}
}
