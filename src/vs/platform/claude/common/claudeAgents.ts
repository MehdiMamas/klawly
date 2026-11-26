/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { fromNow } from '../../../base/common/date.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { claudeAllowRule, ClaudeConversation, claudeQuestion, IClaudePermissionItem, IClaudeToolItem } from './claudeConversation.js';
import { ClaudeEvent, IClaudeRuntimeService, IClaudeSendRequest, IClaudeSessionInfo, IClaudeTranscriptMessage, IClaudeWorktreeDiff } from './claudeRuntime.js';
import { worktreeSlug } from './claudeWorktrees.js';

/** The three groups of the Agents list (v5-S25). */
export type ClaudeAgentStatus = 'needsYou' | 'running' | 'done';

/** The part of the runtime the agents need; the real service and a test double both fit. */
export type IClaudeAgentsRuntime = Pick<IClaudeRuntimeService, 'onDidEvent' | 'send' | 'stop' | 'answerPermission' | 'addAllowRule' | 'worktreeDiff' | 'applyWorktree'>;

function clock(ms: number): string {
	return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function minutes(ms: number): string {
	return localize('claude.agents.minutes', "{0} min", Math.max(1, Math.round(ms / 60000)));
}

function stopwatch(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function firstLine(text: string): string {
	return text.trim().split('\n')[0];
}

/** The verb the list shows for the tool an agent runs now ("Testing · 0:21"). */
function toolVerb(tool: IClaudeToolItem): string {
	switch (tool.name) {
		case 'Bash':
			return /\b(test|vitest|jest|pytest|mocha)\b/.test(String(tool.input.command ?? '')) ? localize('claude.agents.testing', "Testing") : localize('claude.agents.runningCommand', "Running");
		case 'Edit':
		case 'MultiEdit':
		case 'Write':
			return localize('claude.agents.editing', "Editing");
		case 'Read':
			return localize('claude.agents.reading', "Reading");
		case 'Grep':
		case 'Glob':
			return localize('claude.agents.searching', "Searching");
		default:
			return tool.name;
	}
}

/**
 * One agent: a conversation, the folder it works in and, for a Run Parallel Agents attempt, the worktree and group
 * it belongs to. The pane shows one agent at a time; the list and Needs you read the status of all of them.
 */
export class ClaudeAgent extends Disposable {

	readonly conversation = this._register(new ClaudeConversation());
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	readonly createdAt = Date.now();
	/** Prompts typed while the turn runs; sent one by one when it ends. */
	queue: string[] = [];
	/** The `--worktree` name when the agent is a parallel attempt. */
	worktree: string | undefined;
	/** The attempt number (1-based) inside its group. */
	attempt: number | undefined;
	groupId: string | undefined;
	model: string | undefined;
	/** The first error of a failed run, and the turn it happened in (E11: say it failed, show the first error). */
	failure: { readonly turn: number; readonly message: string } | undefined;
	/** What the attempt changed, read from its worktree once it finished. */
	diff: IClaudeWorktreeDiff | undefined;
	diffRequested = false;
	private turns = 0;
	private lastEventAt = Date.now();

	constructor(readonly cwd: string | undefined) {
		super();
		this._register(this.conversation.onDidChange(() => this._onDidChange.fire()));
	}

	get title(): string {
		return this.conversation.title ?? localize('claude.agents.new', "New agent");
	}

	/** Nothing was typed or restored yet, so the list does not show it. */
	get blank(): boolean {
		return this.conversation.items.length === 0 && !this.conversation.sessionId;
	}

	/** The permission or question the agent waits on, oldest first. */
	get pending(): IClaudePermissionItem | undefined {
		return this.conversation.items.find((item): item is IClaudePermissionItem => item.kind === 'permission' && item.state === 'pending');
	}

	get status(): ClaudeAgentStatus {
		if (this.pending || this.conversation.edge?.kind === 'limited') {
			return 'needsYou';
		}
		return this.conversation.working ? 'running' : 'done';
	}

	/** A finished run that did not fail. */
	get passed(): boolean {
		return this.status === 'done' && !this.failure && this.conversation.items.length > 0 && this.conversation.edge?.kind !== 'crashed';
	}

	/** Starts a run: clears the last failure. */
	beginRun(): void {
		this.failure = undefined;
		this.diff = undefined;
		this.diffRequested = false;
		this.turns = 0;
	}

	handle(event: ClaudeEvent): void {
		this.lastEventAt = Date.now();
		if (event.type === 'toolResult') {
			this.turns++;
		}
		this.conversation.handle(event);
		const edge = this.conversation.edge;
		if (!this.failure && (!edge || edge.kind === 'crashed')) {
			const message = event.type === 'error' ? event.message
				: event.type === 'result' && event.isError ? event.text
					: event.type === 'ended' && event.exitCode ? localize('claude.agents.exitCode', "Exited with code {0}", event.exitCode)
						: undefined;
			if (message) {
				this.failure = { turn: this.turns + 1, message: firstLine(message) };
			}
		}
		this._onDidChange.fire();
	}

	/** The line under the title in the list (v5-S25). */
	statusLine(now: number): string {
		const conversation = this.conversation;
		const pending = this.pending;
		if (pending) {
			return claudeQuestion(pending.input) || pending.toolName === 'ExitPlanMode'
				? localize('claude.agents.status.question', "Question · {0}", minutes(now - pending.askedAt))
				: localize('claude.agents.status.permission', "Permission · {0}", pending.target || pending.toolName);
		}
		const edge = conversation.edge;
		if (edge?.kind === 'limited') {
			return edge.resetsAt ? localize('claude.agents.status.limit', "Usage limit · resets {0}", clock(edge.resetsAt)) : localize('claude.agents.status.limit.unknown', "Usage limit");
		}
		if (conversation.working) {
			const tool = [...conversation.items].reverse().find((item): item is IClaudeToolItem => item.kind === 'tool' && item.status === 'running');
			if (tool) {
				return `${toolVerb(tool)} · ${stopwatch(now - tool.startedAt)}`;
			}
			return this.worktree ? localize('claude.agents.status.worktree', "Worktree · {0}", minutes(now - this.createdAt)) : localize('claude.agents.status.working', "Working · {0}", minutes(now - this.createdAt));
		}
		if (this.failure) {
			return localize('claude.agents.status.failed', "Failed · {0}", this.failure.message);
		}
		if (edge?.kind === 'offline') {
			return localize('claude.agents.status.offline', "Offline");
		}
		const changes = conversation.changes;
		if (changes.length) {
			const added = changes.reduce((sum, c) => sum + c.added, 0);
			const removed = changes.reduce((sum, c) => sum + c.removed, 0);
			return localize('claude.agents.status.review', "+{0} \u2212{1} · Review", added, removed);
		}
		return localize('claude.agents.status.done', "Done · {0}", fromNow(this.lastEventAt, true));
	}

}

/** A Run Parallel Agents task: one prompt, several attempts, each in its own worktree. Shown as one row. */
export interface IClaudeMultitask {
	readonly id: string;
	readonly prompt: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly model: string | undefined;
	readonly permissionMode: IClaudeSendRequest['permissionMode'];
	readonly attempts: ClaudeAgent[];
}

export type ClaudeAgentRow =
	| { readonly kind: 'agent'; readonly agent: ClaudeAgent }
	| { readonly kind: 'multitask'; readonly group: IClaudeMultitask };

export interface IClaudeAgentSection {
	readonly status: ClaudeAgentStatus;
	readonly rows: readonly ClaudeAgentRow[];
}

/** One entry of the Needs you list (v5-S26). A finding item can join the union later. */
export type ClaudeNeedsYouItem =
	| { readonly kind: 'permission'; readonly agent: ClaudeAgent; readonly card: IClaudePermissionItem }
	| { readonly kind: 'question'; readonly agent: ClaudeAgent; readonly card: IClaudePermissionItem; readonly question: string }
	| { readonly kind: 'limit'; readonly agents: readonly ClaudeAgent[]; readonly resetsAt: number | undefined };

export function claudeGroupTitle(group: IClaudeMultitask): string {
	return group.prompt.trim().split('\n')[0].slice(0, 60);
}

export function claudeGroupStatus(group: IClaudeMultitask): ClaudeAgentStatus {
	const statuses = group.attempts.map(a => a.status);
	return statuses.includes('needsYou') ? 'needsYou' : statuses.includes('running') ? 'running' : 'done';
}

export function claudeGroupStatusLine(group: IClaudeMultitask): string {
	const total = group.attempts.length;
	const failed = group.attempts.filter(a => a.failure && a.status === 'done').length;
	const running = group.attempts.filter(a => a.status !== 'done').length;
	if (failed) {
		return localize('claude.agents.group.failed', "{0} failed of {1}", failed, total);
	}
	return running ? localize('claude.agents.group.running', "{0} of {1} running", running, total) : localize('claude.agents.group.done', "{0} done · Compare", total);
}

/** The Compare view of v5-S30: which attempts passed and which one changed the least. */
export function claudeCompare(group: IClaudeMultitask): { readonly passed: readonly ClaudeAgent[]; readonly smallest: ClaudeAgent | undefined; readonly headline: string } {
	const passed = group.attempts.filter(a => a.passed && a.diff);
	const size = (a: ClaudeAgent) => (a.diff?.added ?? 0) + (a.diff?.removed ?? 0);
	const smallest = passed.length > 1 ? passed.reduce((best, a) => size(a) < size(best) ? a : best) : undefined;
	const headline = !passed.length ? localize('claude.compare.none', "No attempt passed")
		: !smallest ? localize('claude.compare.one', "1 attempt passed")
			: localize('claude.compare.many', "{0} attempts passed · Attempt {1} is the smallest change", passed.length, smallest.attempt);
	return { passed, smallest, headline };
}

/**
 * Every open conversation of the window, keyed by session id, fed by the runtime's events. The Agent pane shows the
 * selected one; the Agents list, Needs you and the title bar read the status of all of them.
 */
export class ClaudeAgents extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** Fires when an agent, the list or the selection changes. */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly agents: ClaudeAgent[] = [];
	private readonly groups: IClaudeMultitask[] = [];
	private _selected: ClaudeAgent;
	private _selectedGroup: IClaudeMultitask | undefined;
	/** Events of sessions that started but whose id the runtime has not returned yet. */
	private orphans: ClaudeEvent[] = [];
	private sending = 0;
	private groupCount = 0;

	constructor(protected readonly runtime: IClaudeAgentsRuntime, private readonly folder: () => string | undefined) {
		super();
		this._selected = this.add(new ClaudeAgent(folder()));
		this._register(runtime.onDidEvent(event => this.onRuntimeEvent(event)));
	}

	private add(agent: ClaudeAgent): ClaudeAgent {
		this.agents.push(agent);
		this._register(agent);
		this._register(agent.onDidChange(() => this._onDidChange.fire()));
		return agent;
	}

	get selected(): ClaudeAgent {
		return this._selected;
	}

	/** The parallel task whose attempts the chat shows, instead of one conversation. */
	get selectedGroup(): IClaudeMultitask | undefined {
		return this._selectedGroup;
	}

	/** The parallel task an attempt belongs to. */
	groupOf(agent: ClaudeAgent): IClaudeMultitask | undefined {
		return this.groups.find(group => group.id === agent.groupId);
	}

	get(sessionId: string): ClaudeAgent | undefined {
		return this.agents.find(a => a.conversation.sessionId === sessionId);
	}

	/** Agents with something to show, attempts included. */
	all(): readonly ClaudeAgent[] {
		return this.agents.filter(a => !a.blank);
	}

	select(agent: ClaudeAgent): void {
		this._selected = agent;
		this._selectedGroup = undefined;
		this._onDidChange.fire();
	}

	selectGroup(group: IClaudeMultitask): void {
		this._selectedGroup = group;
		this._onDidChange.fire();
	}

	/** A blank agent in the pane; a blank one that is already selected is reused. */
	create(): ClaudeAgent {
		const agent = this._selected.blank && !this._selectedGroup ? this._selected : this.add(new ClaudeAgent(this.folder()));
		this.select(agent);
		return agent;
	}

	/** Opens a stored session as an agent (or selects the one that already shows it). */
	open(session: IClaudeSessionInfo, messages: readonly IClaudeTranscriptMessage[]): ClaudeAgent {
		const existing = this.get(session.id);
		if (existing) {
			this.select(existing);
			return existing;
		}
		const agent = this._selected.blank && !this._selectedGroup ? this._selected : this.add(new ClaudeAgent(this.folder()));
		agent.conversation.restore(session.id, messages);
		this.select(agent);
		return agent;
	}

	private onRuntimeEvent(event: ClaudeEvent): void {
		const agent = this.get(event.sessionId);
		if (agent) {
			agent.handle(event);
			if (agent.groupId && (event.type === 'result' || event.type === 'ended')) {
				this.refreshDiff(agent);
			}
		} else if (this.sending) {
			this.orphans.push(event);
		}
	}

	/** Adds the person's message and sends it. The runtime's first events can arrive before it returns the session id; they are kept and replayed. */
	async send(agent: ClaudeAgent, prompt: { text: string; files?: readonly string[]; mentions?: string; model?: string; permissionMode?: IClaudeSendRequest['permissionMode'] }, cwd: string): Promise<void> {
		const conversation = agent.conversation;
		agent.beginRun();
		agent.model = prompt.model ?? agent.model;
		conversation.addUser(prompt.text, prompt.files);
		const fresh = !conversation.sessionId;
		this.sending++;
		try {
			const result = await this.runtime.send({ cwd, prompt: prompt.text + (prompt.mentions ?? ''), sessionId: conversation.sessionId, model: prompt.model, permissionMode: prompt.permissionMode, worktree: fresh ? agent.worktree : undefined });
			conversation.sessionId = result.sessionId;
			const early = this.orphans.filter(e => e.sessionId === result.sessionId);
			this.orphans = this.orphans.filter(e => e.sessionId !== result.sessionId);
			early.forEach(e => agent.handle(e));
		} catch (error) {
			conversation.setWorking(false);
			conversation.setNotice(error instanceof Error ? error.message : String(error));
			agent.failure = { turn: 1, message: firstLine(error instanceof Error ? error.message : String(error)) };
		} finally {
			if (--this.sending === 0) {
				this.orphans = [];
			}
		}
		this._onDidChange.fire();
	}

	async stop(agent: ClaudeAgent): Promise<void> {
		if (agent.conversation.sessionId && agent.conversation.working) {
			await this.runtime.stop(agent.conversation.sessionId);
			agent.conversation.stop();
		}
	}

	/**
	 * Answers a permission or question card. The agent's own card and the Needs you row are views of the same item,
	 * so answering from either one resolves it for both.
	 */
	async answerPermission(agent: ClaudeAgent, card: IClaudePermissionItem, allow: boolean, options: { always?: boolean; updatedInput?: Record<string, unknown>; denyMessage?: string } = {}): Promise<void> {
		if (card.state !== 'pending') {
			return;
		}
		if (options.always && agent.cwd) {
			this.runtime.addAllowRule(agent.cwd, claudeAllowRule(card.toolName, card.input).rule).catch(error => agent.conversation.setNotice(localize('claude.allowRule.failed', "Could not save the rule: {0}", error instanceof Error ? error.message : String(error))));
		}
		agent.conversation.resolvePermission(card, allow);
		await this.runtime.answerPermission(card.sessionId, card.requestId, allow, options.denyMessage, options.updatedInput);
	}

	// --- The list (v5-S25)

	/** The rows of the list in the groups NEEDS YOU, RUNNING and DONE; attempts show under their parallel task. `query` filters by title. */
	sections(query: string = ''): IClaudeAgentSection[] {
		const needle = query.trim().toLowerCase();
		const rows: { status: ClaudeAgentStatus; row: ClaudeAgentRow; at: number; title: string }[] = [];
		for (const agent of this.all()) {
			if (!agent.groupId) {
				rows.push({ status: agent.status, row: { kind: 'agent', agent }, at: agent.createdAt, title: agent.title });
			}
		}
		for (const group of this.groups) {
			rows.push({ status: claudeGroupStatus(group), row: { kind: 'multitask', group }, at: group.createdAt, title: claudeGroupTitle(group) });
		}
		return (['needsYou', 'running', 'done'] as const)
			.map(status => ({ status, rows: rows.filter(r => r.status === status && r.title.toLowerCase().includes(needle)).sort((a, b) => b.at - a.at).map(r => r.row) }))
			.filter(section => section.rows.length > 0);
	}

	/** The number after "<folder> ·" in the title bar. */
	get count(): number {
		return this.sections().reduce((sum, section) => sum + section.rows.length, 0);
	}

	// --- Needs you (v5-S26)

	needsYou(): ClaudeNeedsYouItem[] {
		const items: ClaudeNeedsYouItem[] = [];
		const limited: ClaudeAgent[] = [];
		for (const agent of this.all()) {
			const card = agent.pending;
			if (card) {
				const question = claudeQuestion(card.input);
				if (question) {
					items.push({ kind: 'question', agent, card, question: question.question });
				} else if (card.toolName === 'ExitPlanMode') {
					items.push({ kind: 'question', agent, card, question: localize('claude.needs.plan', "Plan ready for review") });
				} else {
					items.push({ kind: 'permission', agent, card });
				}
			} else if (agent.conversation.edge?.kind === 'limited') {
				limited.push(agent);
			}
		}
		const asked = (item: ClaudeNeedsYouItem) => item.kind === 'limit' ? 0 : item.card.askedAt;
		items.sort((a, b) => asked(a) - asked(b));
		if (limited.length) {
			const edges = limited.map(a => a.conversation.edge).filter(e => e?.kind === 'limited');
			items.push({ kind: 'limit', agents: limited, resetsAt: edges.map(e => e?.kind === 'limited' ? e.resetsAt : undefined).find(Boolean) });
		}
		return items;
	}

	// --- Run Parallel Agents (v5-S28)

	/** Starts `attempts` agents on one prompt, each in its own worktree `try/<slug>-<n>`. Resolves when all were sent. */
	async startMultitask(prompt: string, attempts: number, options: { cwd: string; model?: string; permissionMode?: IClaudeSendRequest['permissionMode'] }): Promise<IClaudeMultitask> {
		const slug = worktreeSlug(prompt);
		const suffix = this.groupCount++ ? `-${this.groupCount}` : '';
		const group: IClaudeMultitask = { id: `multitask-${Date.now()}-${this.groupCount}`, prompt, cwd: options.cwd, createdAt: Date.now(), model: options.model, permissionMode: options.permissionMode, attempts: [] };
		for (let n = 1; n <= attempts; n++) {
			group.attempts.push(this.newAttempt(group, n, `try/${slug}${suffix}-${n}`));
		}
		this.groups.push(group);
		this.selectGroup(group);
		await Promise.all(group.attempts.map(attempt => this.sendAttempt(group, attempt)));
		return group;
	}

	private newAttempt(group: IClaudeMultitask, n: number, worktree: string): ClaudeAgent {
		const attempt = this.add(new ClaudeAgent(group.cwd));
		attempt.worktree = worktree;
		attempt.attempt = n;
		attempt.groupId = group.id;
		return attempt;
	}

	private async sendAttempt(group: IClaudeMultitask, attempt: ClaudeAgent): Promise<void> {
		await this.send(attempt, { text: group.prompt, model: group.model, permissionMode: group.permissionMode }, group.cwd);
	}

	/** Starts a failed attempt again under a new worktree name, in the same place of its group. */
	async retry(group: IClaudeMultitask, attempt: ClaudeAgent): Promise<void> {
		const index = group.attempts.indexOf(attempt);
		if (index < 0 || !attempt.attempt || !attempt.worktree) {
			return;
		}
		const next = this.newAttempt(group, attempt.attempt, `${attempt.worktree.replace(/-retry\d+$/, '')}-retry${Date.now().toString(36)}`);
		group.attempts[index] = next;
		this._onDidChange.fire();
		await this.sendAttempt(group, next);
	}

	/** Reads what a finished attempt changed. Fires a change when it is known. */
	async refreshDiff(attempt: ClaudeAgent): Promise<void> {
		if (!attempt.cwd || !attempt.worktree || !attempt.passed || attempt.diff || attempt.diffRequested) {
			return;
		}
		attempt.diffRequested = true;
		try {
			attempt.diff = await this.runtime.worktreeDiff(attempt.cwd, attempt.worktree);
		} catch {
			attempt.diff = undefined;
		}
		this._onDidChange.fire();
	}

	/** Apply this one: the attempt's diff goes onto the main folder; rejects with the conflict message and changes nothing. */
	applyAttempt(attempt: ClaudeAgent): Promise<void> {
		return this.runtime.applyWorktree(attempt.cwd ?? '', attempt.worktree ?? '');
	}
}
