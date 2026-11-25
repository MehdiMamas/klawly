/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { BackgroundAgentStatus, BackgroundAgentTask, isActiveBackgroundStatus } from '../../../../platform/claude/common/claudeBackground.js';
import { AgentMode, ContextAttachment } from '../../../../platform/claude/common/claudeContext.js';
import { isReadOnlyMode } from '../../../../platform/claude/common/claudeModePolicy.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IClaudeAgentService } from './claudeAgentService.js';
import { IClaudeBackgroundAgentService } from './claudeBackgroundAgent.js';
import { ClaudeWorkerState, IClaudeWorkerRegistry, workerUsagePatch } from './claudeWorkerRegistry.js';

export const IClaudeMultitaskService = createDecorator<IClaudeMultitaskService>('claudeMultitaskService');

/** The composer command: `/multitask` followed by one prompt per line. */
export const CLAUDE_MULTITASK_COMMAND = 'multitask';

/** Run Queued in Parallel: the current chat's queued messages become one multitask. */
export const CLAUDE_MULTITASK_RUN_QUEUED_COMMAND_ID = 'claude.multitask.runQueued';

/** Most prompts one multitask takes. Runs past `claude.agent.maxParallelSessions` wait for a free slot. */
export const CLAUDE_MULTITASK_MAX_PROMPTS = 8;

/** Characters of each run's final answer the combined turn carries. */
const RESULT_CHARS = 6000;

/** Open the composer with `/multitask` ready for one prompt per line. */
export const CLAUDE_MULTITASK_START_COMMAND_ID = 'claude.multitask.start';

/** Where the chat's multitasks are kept across a window reload (issue 686), per workspace. */
const STORAGE_KEY = 'claude.multitask.groups';

/** Most multitasks kept per workspace; the oldest ended ones go first. */
const MAX_KEPT_GROUPS = 20;

/** `queued` waits for a free background slot; the others are the background agent's own status. */
export type MultitaskRunStatus = 'queued' | BackgroundAgentStatus;

/** One prompt of a multitask, and what Claude gets for it when that differs (its attachments, issue 686). */
export interface MultitaskPrompt {
	readonly text: string;
	/** The prompt compiled with its attachments. Default: `text`. */
	readonly compiled?: string;
	/** The chips `compiled` holds, shown on a read-only run's message in its chat. */
	readonly attachments?: readonly ContextAttachment[];
}

export interface MultitaskRun {
	readonly prompt: string;
	/** The background agent's task id, once it started. Read-only runs have none. */
	readonly taskId?: string;
	/** The run's own chat, once it started. */
	readonly runSessionId?: string;
	/**
	 * Runs in the sending chat's folder instead of a worktree (issue 686): its mode
	 * (Ask or Plan) cannot change project files, so it needs no branch.
	 */
	readonly readOnly?: boolean;
	/** The mode a `ask:`, `plan:` or `agent:` prefix gave this line; absent when it runs in the multitask's mode (issue 759). */
	readonly mode?: AgentMode;
	readonly status: MultitaskRunStatus;
	/** Why the run could not start, or why it ended early. */
	readonly error?: string;
	/** True when the user stopped it. */
	readonly stopped?: boolean;
}

/** One `/multitask`: its prompts run as background agents, then one combined turn goes back to the chat. */
export interface MultitaskGroup {
	readonly id: string;
	/** The chat that sent it and gets the combined turn. */
	readonly sessionId: string;
	readonly runs: readonly MultitaskRun[];
	readonly startedAt: number;
	/** Set when every run ended. */
	readonly endedAt?: number;
	/**
	 * A window reload interrupted the runs still going (issue 686), so the combined
	 * turn was not sent; Send Results sends it with what finished.
	 */
	readonly unsent?: boolean;
}

/**
 * Multitask (issue 487): several prompts sent at once run in parallel as
 * background agents (each in its own worktree, through the background agent
 * path) instead of queueing. When every run ends, their results go back to the
 * chat that sent them as one turn, which Claude combines. A read-only run (Ask
 * or Plan) runs in the chat's folder instead (issue 686), and the multitasks
 * are kept per workspace across a window reload.
 */
export interface IClaudeMultitaskService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/**
	 * The multitasks a chat sent, oldest first, until they are dismissed. A reloaded
	 * one waiting for Send Results whose chat did not reopen shows in every chat.
	 */
	getGroups(sessionId: string): readonly MultitaskGroup[];
	/** The background agent behind a run, while it exists. */
	getTask(run: MultitaskRun): BackgroundAgentTask | undefined;
	/**
	 * Starts every prompt that fits under `claude.agent.maxParallelSessions`; the rest wait for a free slot.
	 * `mode` is the sending chat's: each run starts in it, and a read-only one runs in `cwd` without a worktree.
	 */
	start(sessionId: string, prompts: readonly (string | MultitaskPrompt)[], cwd: string, mode?: AgentMode): MultitaskGroup;
	/** Takes the chat's queued messages off the queue and runs them as one multitask, with their attachments. */
	runQueued(sessionId: string, cwd: string, mode?: AgentMode): MultitaskGroup;
	/** True when a run's chat is open to show. */
	canOpen(run: MultitaskRun): boolean;
	/** Shows a run's chat in the chat pane. */
	open(run: MultitaskRun): void;
	/** Stops every run still going. The combined turn still goes out with what finished. */
	stop(groupId: string): Promise<void>;
	/** Sends the combined turn of a multitask a window reload interrupted, to `sessionId` when the chat that sent it did not reopen. */
	sendResults(groupId: string, sessionId: string): void;
	/** Removes an ended multitask's cards. Its background agents stay in the Background view. */
	dismiss(groupId: string): void;
}

/**
 * The prompts of a `/multitask` message: the text after the command, one per
 * line, list markers dropped. Undefined when the message is not `/multitask`.
 */
export function parseMultitaskPrompts(text: string): string[] | undefined {
	const match = /^\s*\/multitask(?<rest>(?:[ \t]|\r?\n)[\s\S]*)?$/.exec(text);
	if (!match) {
		return undefined;
	}
	return (match.groups?.rest ?? '')
		.split(/\r?\n/)
		.map(line => line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim())
		.filter(line => line.length > 0);
}

/** The modes a line of a `/multitask` can name before its text (issue 759). */
const LINE_MODES: readonly AgentMode[] = ['agent', 'ask', 'plan', 'debug'];

/**
 * A `/multitask` line may start with `ask:`, `plan:`, `agent:` or `debug:` to run
 * in that mode instead of the chat's, so Ask and Agent lines mix (issue 759).
 */
export function splitMultitaskLineMode(line: string): { readonly text: string; readonly mode?: AgentMode } {
	const match = /^(?<mode>[a-z]+)\s*:\s*(?<rest>\S[\s\S]*)$/i.exec(line.trim());
	const mode = LINE_MODES.find(candidate => candidate === match?.groups?.mode.toLowerCase());
	return mode && match?.groups ? { text: match.groups.rest, mode } : { text: line.trim() };
}

/** Why these prompts cannot run as a multitask, or undefined when they can. */
export function multitaskPromptsProblem(prompts: readonly string[]): string | undefined {
	if (prompts.length < 2) {
		return localize('claudeMultitaskTooFew', "Write at least two prompts after /multitask, one per line.");
	}
	if (prompts.length > CLAUDE_MULTITASK_MAX_PROMPTS) {
		return localize('claudeMultitaskTooMany', "A multitask runs at most {0} prompts.", CLAUDE_MULTITASK_MAX_PROMPTS);
	}
	return undefined;
}

/**
 * The chips of a `/multitask` message each task gets (issue 686). A chip goes to
 * the prompts that name it (a file or folder by its name, a symbol, a terminal
 * or chat by its title); a chip no prompt names goes to every task.
 */
export function assignMultitaskAttachments(prompts: readonly string[], attachments: readonly ContextAttachment[]): ContextAttachment[][] {
	const assigned = prompts.map((): ContextAttachment[] => []);
	for (const attachment of attachments) {
		const names = attachmentNames(attachment);
		const owners = prompts.map((prompt, index) => names.some(name => mentions(prompt, name)) ? index : -1).filter(index => index >= 0);
		for (const index of owners.length ? owners : prompts.map((_prompt, index) => index)) {
			assigned[index].push(attachment);
		}
	}
	return assigned;
}

/** What a prompt may call a chip: its file name with and without the extension, or its title. */
function attachmentNames(attachment: ContextAttachment): string[] {
	const names: string[] = [];
	const addPath = (value: string | undefined) => {
		if (!value) {
			return;
		}
		const name = (value.includes('://') ? basename(URI.parse(value)) : value.split(/[\\/]/).pop()) ?? '';
		names.push(name);
		const dot = name.lastIndexOf('.');
		if (dot >= 3) {
			names.push(name.slice(0, dot));
		}
	};
	switch (attachment.kind) {
		case 'file':
		case 'folder':
		case 'selection':
			addPath(attachment.uri);
			break;
		case 'symbol':
			names.push(attachment.name);
			addPath(attachment.uri);
			break;
		case 'diagnostics':
			addPath(attachment.uri);
			break;
		case 'git-diff':
			addPath(attachment.path);
			names.push(attachment.title ?? '');
			break;
		case 'terminal':
		case 'chat':
			names.push(attachment.title ?? '');
			break;
		case 'image':
			addPath(attachment.localUri);
			break;
	}
	return names.map(name => name.trim()).filter(name => name.length >= 2);
}

/** True when `prompt` names `name` as a whole word, ignoring case. `app` does not match `app.ts`. */
function mentions(prompt: string, name: string): boolean {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(?<!\\w)${escaped}(?!\\w|\\.\\w)`, 'i').test(prompt);
}

/** What one run ended with, for the combined turn. */
export interface MultitaskRunResult {
	readonly prompt: string;
	readonly status: MultitaskRunStatus;
	readonly stopped?: boolean;
	readonly error?: string;
	readonly branchName?: string;
	readonly filesChanged?: number;
	readonly added?: number;
	readonly removed?: number;
	readonly answer?: string;
	/** Ran in the chat's folder, so it changed no files (issue 686). */
	readonly readOnly?: boolean;
}

/**
 * The prompt Claude gets for the combined turn. It is the model's input, not UI
 * text, so it is not localized; the chat shows {@link multitaskSummaryLabel}.
 */
export function multitaskSummaryPrompt(results: readonly MultitaskRunResult[]): string {
	const lines = [results.every(result => result.readOnly)
		? `These ${results.length} tasks ran in parallel as read-only agents in this folder, so they changed no files. Combine their results into one answer: what each one found, where they agree or conflict, and what to do next. Do not redo the tasks.`
		: `These ${results.length} tasks ran in parallel as background agents, each in its own git worktree of this repository. Combine their results into one answer: what each one found or changed, where they agree or conflict, and what to do next. Do not redo the tasks. Changes stay on each task's branch until they are applied from the Background view.`,
	];
	results.forEach((result, index) => {
		lines.push('', `## Task ${index + 1}: ${result.prompt}`);
		let status: string = result.status;
		if (result.status === 'failed') {
			status = result.stopped ? 'stopped' : result.error ? `failed: ${result.error}` : 'failed';
		}
		lines.push(`Status: ${status}`);
		if (result.branchName) {
			lines.push(`Branch: ${result.branchName} (${result.filesChanged ?? 0} files changed, +${result.added ?? 0} -${result.removed ?? 0})`);
		}
		const answer = result.answer?.trim();
		if (answer) {
			lines.push('Result:', answer.length > RESULT_CHARS ? `${answer.slice(0, RESULT_CHARS)}\n[cut at ${RESULT_CHARS} characters]` : answer);
		}
	});
	return lines.join('\n');
}

/** What the chat shows as the combined turn's message. */
export function multitaskSummaryLabel(count: number): string {
	return localize('claudeMultitaskSummary', "Combine the results of the {0} parallel tasks.", count);
}

/** What a settled run ended with, kept so the combined turn can still go out after a reload. */
interface RunOutcome {
	branchName?: string;
	filesChanged?: number;
	added?: number;
	removed?: number;
	answer?: string;
	failure?: string;
}

interface MutableRun {
	prompt: string;
	compiled?: string;
	/** Not saved: a restored run never starts again. */
	attachments?: readonly ContextAttachment[];
	taskId?: string;
	runSessionId?: string;
	readOnly?: boolean;
	mode?: AgentMode;
	status: MultitaskRunStatus;
	error?: string;
	stopped?: boolean;
	outcome?: RunOutcome;
}

interface MutableGroup {
	id: string;
	sessionId: string;
	cwd: string;
	mode?: AgentMode;
	runs: MutableRun[];
	startedAt: number;
	endedAt?: number;
	unsent?: boolean;
}

const RUN_STATUSES: readonly MultitaskRunStatus[] = ['queued', 'starting', 'running', 'waiting', 'complete', 'failed'];
const MODES: readonly AgentMode[] = ['agent', 'ask', 'plan', 'debug'];

function isSettled(status: MultitaskRunStatus): boolean {
	return status === 'complete' || status === 'failed';
}

function isRunActive(run: MutableRun): boolean {
	return run.status !== 'queued' && isActiveBackgroundStatus(run.status);
}

/** Drops keys whose value is undefined, so stored, restored and shown runs compare equal. */
function defined<T extends object>(value: T): T {
	for (const key of Object.keys(value) as (keyof T)[]) {
		if (value[key] === undefined) {
			delete value[key];
		}
	}
	return value;
}

function publicRun(run: MutableRun): MultitaskRun {
	return defined({
		prompt: run.prompt,
		taskId: run.taskId,
		runSessionId: run.runSessionId,
		readOnly: run.readOnly,
		mode: run.mode,
		status: run.status,
		error: run.error,
		stopped: run.stopped,
	});
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A stored run, or undefined when it is not one this version wrote. */
function readRun(value: unknown): MutableRun | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const run = value as Record<string, unknown>;
	if (typeof run.prompt !== 'string' || !RUN_STATUSES.includes(run.status as MultitaskRunStatus)) {
		return undefined;
	}
	const outcome = run.outcome && typeof run.outcome === 'object' ? run.outcome as Record<string, unknown> : undefined;
	return defined<MutableRun>({
		prompt: run.prompt,
		taskId: optionalString(run.taskId),
		runSessionId: optionalString(run.runSessionId),
		readOnly: run.readOnly === true || undefined,
		mode: MODES.includes(run.mode as AgentMode) ? run.mode as AgentMode : undefined,
		status: run.status as MultitaskRunStatus,
		error: optionalString(run.error),
		stopped: run.stopped === true || undefined,
		outcome: outcome ? defined<RunOutcome>({
			branchName: optionalString(outcome.branchName),
			filesChanged: optionalNumber(outcome.filesChanged),
			added: optionalNumber(outcome.added),
			removed: optionalNumber(outcome.removed),
			answer: optionalString(outcome.answer),
			failure: optionalString(outcome.failure),
		}) : undefined,
	});
}

/** A stored group, or undefined when it is not one this version wrote. */
function readGroup(value: unknown): MutableGroup | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== 'string' || typeof raw.sessionId !== 'string' || typeof raw.cwd !== 'string' || typeof raw.startedAt !== 'number' || !Array.isArray(raw.runs)) {
		return undefined;
	}
	const runs = (raw.runs as unknown[]).map(readRun);
	if (runs.length < 2 || runs.length > CLAUDE_MULTITASK_MAX_PROMPTS || runs.some(run => !run)) {
		return undefined;
	}
	return defined<MutableGroup>({
		id: raw.id,
		sessionId: raw.sessionId,
		cwd: raw.cwd,
		mode: MODES.includes(raw.mode as AgentMode) ? raw.mode as AgentMode : undefined,
		runs: runs as MutableRun[],
		startedAt: raw.startedAt,
		endedAt: optionalNumber(raw.endedAt),
		unsent: raw.unsent === true || undefined,
	});
}

/** A multitask prompt's run in the worker registry's words. */
function workerPatch(run: MultitaskRun): { readonly state: ClaudeWorkerState; readonly stateDetail?: string } {
	if (run.stopped) {
		return { state: 'stopped' };
	}
	switch (run.status) {
		case 'queued': return { state: 'queued', stateDetail: localize('claudeMultitaskRunQueued', "waiting for a free slot") };
		case 'starting':
		case 'running': return { state: 'working' };
		case 'waiting': return { state: 'waiting', stateDetail: localize('claudeMultitaskRunWaiting', "waiting for you") };
		case 'complete': return { state: 'finished' };
		default: return { state: 'failed', stateDetail: localize('claudeMultitaskRunFailed', "failed: {0}", run.error ?? '') };
	}
}

export class ClaudeMultitaskService extends Disposable implements IClaudeMultitaskService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _groups: MutableGroup[] = [];
	private _pumping = false;
	/** The JSON last written to storage, so unchanged state is not written again. */
	private _saved: string | undefined;

	constructor(
		@IClaudeBackgroundAgentService private readonly _background: IClaudeBackgroundAgentService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@ILogService private readonly _log: ILogService,
		@IStorageService private readonly _storage: IStorageService,
		@IClaudeWorkerRegistry private readonly _registry: IClaudeWorkerRegistry,
	) {
		super();
		this.restore();
		this._register(this._background.onDidChangeTasks(() => this.sync()));
		this._register(this._agent.onDidChangeViewState(({ sessionId }) => {
			if (this._groups.some(group => group.runs.some(run => run.readOnly && run.runSessionId === sessionId && !isSettled(run.status)))) {
				this.sync();
			}
		}));
	}

	getGroups(sessionId: string): readonly MultitaskGroup[] {
		// A chat with no message of its own does not reopen after a reload, so its waiting multitask goes to whichever chat shows.
		const open = new Set(this._agent.getSessions().map(session => session.id));
		return this._groups.filter(group => group.sessionId === sessionId || (group.unsent && !open.has(group.sessionId))).map(group => defined({
			id: group.id,
			sessionId: group.sessionId,
			runs: group.runs.map(publicRun),
			startedAt: group.startedAt,
			endedAt: group.endedAt,
			unsent: group.unsent,
		}));
	}

	getTask(run: MultitaskRun): BackgroundAgentTask | undefined {
		return run.taskId ? this._background.getTasks().find(task => task.id === run.taskId) : undefined;
	}

	start(sessionId: string, prompts: readonly (string | MultitaskPrompt)[], cwd: string, mode?: AgentMode): MultitaskGroup {
		const cleaned = prompts
			.map(prompt => typeof prompt === 'string' ? { text: prompt.trim(), compiled: undefined, attachments: undefined } : { text: prompt.text.trim(), compiled: prompt.compiled?.trim(), attachments: prompt.attachments })
			.map(prompt => {
				const split = splitMultitaskLineMode(prompt.text);
				// The prefix is not part of what Claude is asked.
				return { ...prompt, ...split, compiled: prompt.compiled && split.mode ? prompt.compiled.replace(prompt.text, () => split.text) : prompt.compiled };
			})
			.filter(prompt => prompt.text.length > 0);
		const problem = multitaskPromptsProblem(cleaned.map(prompt => prompt.text));
		if (problem) {
			throw new Error(problem);
		}
		// Issue 686: Ask and Plan cannot change project files, so their runs share the chat's folder instead of a worktree.
		const group = defined<MutableGroup>({
			id: generateUuid().slice(0, 8),
			sessionId,
			cwd,
			mode,
			runs: cleaned.map(prompt => defined<MutableRun>({
				prompt: prompt.text,
				compiled: prompt.compiled && prompt.compiled !== prompt.text ? prompt.compiled : undefined,
				attachments: prompt.attachments?.length ? prompt.attachments : undefined,
				readOnly: ((prompt.mode ?? mode) && isReadOnlyMode((prompt.mode ?? mode)!)) || undefined,
				mode: prompt.mode && prompt.mode !== mode ? prompt.mode : undefined,
				status: 'queued',
			})),
			startedAt: Date.now(),
		});
		this._groups.push(group);
		this.changed();
		this.pump();
		return this.getGroups(sessionId).find(candidate => candidate.id === group.id)!;
	}

	runQueued(sessionId: string, cwd: string, mode?: AgentMode): MultitaskGroup {
		const pending = this._agent.getPending(sessionId).filter(item => item.text.trim());
		const problem = multitaskPromptsProblem(pending.map(item => item.text));
		if (problem) {
			throw new Error(pending.length < 2 ? localize('claudeMultitaskQueueTooFew', "Queue at least two messages to run them in parallel.") : problem);
		}
		// A queued message keeps its attachments in its compiled text (issue 686).
		const group = this.start(sessionId, pending.map(item => ({ text: item.text, compiled: item.compiled, attachments: item.attachments })), cwd, mode);
		for (const item of pending) {
			this._agent.removePending(sessionId, item.id);
		}
		return group;
	}

	canOpen(run: MultitaskRun): boolean {
		const sessionId = this.getTask(run)?.sessionId ?? run.runSessionId;
		return !!sessionId && this._agent.getSessions().some(session => session.id === sessionId);
	}

	open(run: MultitaskRun): void {
		const sessionId = this.getTask(run)?.sessionId ?? run.runSessionId;
		if (sessionId) {
			this._agent.selectSession(sessionId);
		}
	}

	async stop(groupId: string): Promise<void> {
		const group = this._groups.find(candidate => candidate.id === groupId);
		if (!group) {
			return;
		}
		// Runs still waiting for a slot never start.
		group.runs = group.runs.map(run => run.status === 'queued' ? { ...run, status: 'failed', error: localize('claudeMultitaskNotStarted', "Stopped before it started.") } : run);
		const active = group.runs.filter(run => !isSettled(run.status));
		await Promise.all(active.map(async run => {
			try {
				if (run.readOnly && run.runSessionId) {
					run.stopped = true;
					await this._agent.stop(run.runSessionId);
				} else if (run.taskId) {
					await this._background.stop(run.taskId);
				}
			} catch (error) {
				this._log.warn('[multitask] stop failed', error);
			}
		}));
		this.sync();
	}

	sendResults(groupId: string, sessionId: string): void {
		const group = this._groups.find(candidate => candidate.id === groupId);
		if (!group?.unsent) {
			return;
		}
		if (!this._agent.getSessions().some(session => session.id === group.sessionId)) {
			group.sessionId = sessionId;
		}
		delete group.unsent;
		this.report(group);
		this.changed();
	}

	dismiss(groupId: string): void {
		const index = this._groups.findIndex(group => group.id === groupId);
		if (index >= 0 && this._groups[index].endedAt !== undefined) {
			this._groups.splice(index, 1);
			this.changed();
		}
	}

	/** Slots left under `claude.agent.maxParallelSessions`, counting read-only runs and background runs still starting. */
	private freeSlots(): number {
		const tasks = this._background.getTasks();
		let used = tasks.filter(task => isActiveBackgroundStatus(task.status)).length;
		for (const group of this._groups) {
			for (const run of group.runs) {
				if (run.readOnly ? isRunActive(run) : run.status === 'starting' && !tasks.some(task => task.id === run.taskId)) {
					used++;
				}
			}
		}
		return this._background.maxParallelSessions() - used;
	}

	/** Starts queued runs while slots are free. */
	private pump(): void {
		if (this._pumping) {
			return;
		}
		this._pumping = true;
		try {
			for (const group of this._groups) {
				// `start` may report a task change before it returns, which replaces `group.runs`; read it fresh.
				for (let index = 0; index < group.runs.length; index++) {
					const run = group.runs[index];
					if (run.status !== 'queued' || this.freeSlots() <= 0 || (!run.readOnly && !this._background.canStart())) {
						continue;
					}
					if (run.readOnly) {
						this.startReadOnly(group, run);
						continue;
					}
					const taskId = `multitask-${group.id}-${index + 1}`;
					group.runs[index] = { ...run, taskId, status: 'starting' };
					// `start` reserves its slot before its first await, so `canStart` is current for the next run.
					this._background.start(run.prompt, {
						taskId,
						select: false,
						...((run.mode ?? group.mode) ? { mode: run.mode ?? group.mode } : {}),
						...(run.compiled ? { compiled: run.compiled } : {}),
					}).then(undefined, error => {
						group.runs[index] = { ...group.runs[index], status: 'failed', error: error instanceof Error ? error.message : String(error) };
						this.sync();
					});
				}
			}
		} finally {
			this._pumping = false;
		}
		this.changed();
	}

	/**
	 * Runs a read-only prompt as its own chat in the sending chat's folder, with
	 * no worktree (issue 686). The sending chat stays in front.
	 */
	private startReadOnly(group: MutableGroup, run: MutableRun): void {
		run.status = 'starting';
		const fail = (error: unknown) => {
			run.status = 'failed';
			run.error = error instanceof Error ? error.message : String(error);
			this.sync();
		};
		let sessionId: string;
		try {
			const previous = this._agent.getCurrentSession()?.id;
			sessionId = this._agent.createSession().id;
			if (previous) {
				this._agent.selectSession(previous);
			}
			run.runSessionId = sessionId;
			this._agent.pinWorkingDirectory(sessionId, group.cwd);
			const mode = run.mode ?? group.mode;
			if (mode) {
				this._agent.setMode(sessionId, mode);
			}
		} catch (error) {
			fail(error);
			return;
		}
		const submitted = run.compiled
			? this._agent.submit(sessionId, run.prompt, group.cwd, { compiled: run.compiled, ...(run.attachments ? { attachments: run.attachments } : {}) })
			: this._agent.submit(sessionId, run.prompt, group.cwd);
		submitted.then(() => this.sync(), fail);
	}

	/** A read-only run's status, from its chat's last turn. */
	private readOnlyStatus(run: MutableRun): MutableRun {
		const turns = run.runSessionId ? this._agent.getViewState(run.runSessionId).turns : [];
		const last = turns[turns.length - 1];
		if (!last) {
			return run;
		}
		if (last.permissions.some(permission => permission.state === 'pending')) {
			return { ...run, status: 'waiting' };
		}
		switch (last.status) {
			case 'running':
				return { ...run, status: 'running' };
			case 'complete':
				return { ...run, status: 'complete' };
			case 'failed':
			case 'stopped':
				return defined({ ...run, status: 'failed', stopped: last.status === 'stopped' || run.stopped || undefined });
		}
	}

	/** Copies each started run's status from its background agent or chat, then reports groups that ended. */
	private sync(): void {
		const tasks = this._background.getTasks();
		for (const group of this._groups) {
			group.runs = group.runs.map(run => {
				if (run.readOnly) {
					if (isSettled(run.status) || run.status === 'queued') {
						return run;
					}
					const next = this.readOnlyStatus(run);
					return isSettled(next.status) ? { ...next, outcome: this.outcome(next) } : next;
				}
				const task = run.taskId ? tasks.find(candidate => candidate.id === run.taskId) : undefined;
				if (!task && run.taskId && run.status !== 'starting' && !isSettled(run.status)) {
					// Deleted from the Background view while it ran.
					return { ...run, status: 'failed', error: localize('claudeMultitaskDeleted', "Its background agent was deleted.") };
				}
				if (!task || run.error) {
					return run;
				}
				const next = defined<MutableRun>({ ...run, status: task.status, runSessionId: task.sessionId, stopped: task.stopped || undefined });
				// Keep what it ended with, so the combined turn can still go out after a reload (issue 686).
				return isSettled(next.status) ? { ...next, outcome: this.outcome(next, task) } : next;
			});
		}
		this.pump();
		for (const group of this._groups) {
			if (group.endedAt === undefined && group.runs.every(run => isSettled(run.status))) {
				group.endedAt = Date.now();
				this.report(group);
				this.changed();
			}
		}
	}

	private outcome(run: MutableRun, task?: BackgroundAgentTask): RunOutcome {
		const turns = run.runSessionId ? this._agent.getViewState(run.runSessionId).turns : [];
		const last = turns[turns.length - 1];
		return defined<RunOutcome>({
			branchName: task?.branchName,
			filesChanged: task?.filesChanged,
			added: task?.added,
			removed: task?.removed,
			// One character past what the combined turn keeps, so it still says the answer was cut.
			answer: last?.assistantText?.slice(0, RESULT_CHARS + 1) || undefined,
			failure: last?.failure?.message,
		});
	}

	/** Sends the combined turn to the chat. It waits behind a running turn like any queued message. */
	private report(group: MutableGroup): void {
		const results = group.runs.map(run => defined<MultitaskRunResult>({
			prompt: run.prompt,
			status: run.status,
			stopped: run.stopped ?? (run.outcome && !run.readOnly ? false : undefined),
			error: run.error ?? run.outcome?.failure,
			branchName: run.outcome?.branchName,
			filesChanged: run.outcome?.filesChanged,
			added: run.outcome?.added,
			removed: run.outcome?.removed,
			answer: run.outcome?.answer,
			readOnly: run.readOnly,
		}));
		this._agent.queue(group.sessionId, multitaskSummaryLabel(results.length), group.cwd, 'queue', { compiled: multitaskSummaryPrompt(results) })
			.then(undefined, error => this._log.warn('[multitask] could not send the combined turn', error));
	}

	/**
	 * Brings back this workspace's multitasks after a window reload (issue 686).
	 * Runs still going when the window closed cannot go on, so they end as
	 * interrupted, and the combined turn waits for Send Results instead of
	 * spending tokens on its own.
	 */
	private restore(): void {
		const raw = this._storage.get(STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			this._log.warn('[multitask] could not read the saved multitasks', error);
			return;
		}
		const interrupted = localize('claudeMultitaskInterrupted', "Interrupted by a window reload.");
		for (const value of Array.isArray(parsed) ? parsed : []) {
			const group = readGroup(value);
			if (!group || this._groups.some(candidate => candidate.id === group.id)) {
				continue;
			}
			if (group.endedAt === undefined) {
				group.runs = group.runs.map(run => isSettled(run.status) ? run : { ...run, status: 'failed', error: interrupted });
				group.endedAt = Date.now();
				group.unsent = true;
			}
			this._groups.push(group);
		}
		this._saved = raw;
		this.save();
	}

	private changed(): void {
		this.save();
		this.mirror();
		this._onDidChange.fire();
	}

	/** Keeps the worker registry in step: each multitask is a run, and each of its prompts is a run under it. */
	private mirror(): void {
		for (const group of this._groups) {
			const groupRunId = `multitask-${group.id}`;
			const first = group.runs[0]?.prompt ?? '';
			const owner = group.sessionId;
			this._registry.create({ id: groupRunId, ownerSessionId: owner, name: localize('claudeMultitaskRunName', "Multitask of {0}: {1}", group.runs.length, first), kind: 'multitask', model: '', startedAt: group.startedAt });
			group.runs.forEach((run, index) => {
				const runId = `${groupRunId}-${index + 1}`;
				this._registry.create({ id: runId, parentId: groupRunId, ownerSessionId: owner, name: run.prompt, kind: 'multitask', model: '', startedAt: group.startedAt });
				const sessionId = this.getTask(run)?.sessionId ?? run.runSessionId;
				this._registry.update(runId, { ...workerPatch(run), ...workerUsagePatch(sessionId ? this._agent.getViewState(sessionId).usage : undefined) });
			});
			const states = group.runs.map(run => workerPatch(run).state);
			const live = states.some(state => state === 'queued' || state === 'working' || state === 'waiting');
			this._registry.update(groupRunId, live
				? { state: 'working' }
				: group.unsent
					? { state: 'stopped', stateDetail: localize('claudeMultitaskRunInterrupted', "stopped when Klawly closed") }
					: { state: states.includes('failed') ? 'failed' : states.every(state => state === 'stopped') ? 'stopped' : 'finished' });
		}
	}

	/** Keeps this workspace's newest multitasks. Past the cap, the oldest ended one goes first. */
	private save(): void {
		while (this._groups.length > MAX_KEPT_GROUPS) {
			const oldestEnded = this._groups.findIndex(group => group.endedAt !== undefined);
			this._groups.splice(Math.max(oldestEnded, 0), 1);
		}
		// A restored run never starts again, so what it would send (file text included) stays out of storage.
		const value = this._groups.length ? JSON.stringify(this._groups, (key, item) => key === 'compiled' || key === 'attachments' ? undefined : item) : undefined;
		if (value === this._saved) {
			return;
		}
		this._saved = value;
		if (value) {
			this._storage.store(STORAGE_KEY, value, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this._storage.remove(STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}
}
