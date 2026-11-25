/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { OS } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { addClaudeQueryCost, CLAUDE_GOAL_MAX_BUDGET_DEFAULT, CLAUDE_GOAL_MAX_BUDGET_SETTING, CLAUDE_GOAL_MAX_TURNS_DEFAULT, CLAUDE_GOAL_MAX_TURNS_SETTING, CLAUDE_LOOP_DEFAULT_WAKEUP_MS, CLAUDE_SCHEDULE_WAKEUP_TOOL, ClaudeGoalCommand, claudeGoalContinuePrompt, claudeGoalStartPrompt, ClaudeGoalVerdict, claudeGoalVerdictFromReply, ClaudeLoopCommand, claudeLoopPacingFromReply, claudeLoopPrompt, claudeWakeupDelayMs } from '../../../../../platform/claude/common/claudeGoalLoop.js';
import { claudeGoalAutomation, claudeGoalLoopAutomationId, claudeLoopAutomation } from '../../../../../platform/claude/common/claudeGoalLoopAutomation.js';
import { claudeAutomationKey } from '../../../../../platform/claude/common/claudeAutomation.js';
import { NormalizedClaudeEvent } from '../../../../../platform/claude/common/claudeProtocol.js';
import { claudeTerminalLastOutput, claudeTerminalShellArgs } from '../../../../../platform/claude/common/claudeTerminalRun.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudeAutomationService } from '../../../../services/claude/common/claudeAutomationService.js';
import { TurnViewModel } from '../../../../services/claude/common/claudeAgentState.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { ITerminalProfileResolverService } from '../../../terminal/common/terminal.js';
import { ClaudeGoalEnd, ClaudeGoalReason, ClaudeGoalStatus, ClaudeGoalView, ClaudeLoopStatus, ClaudeLoopView, IClaudeGoalLoopService } from '../../common/claudeGoalLoopService.js';

/** Lines of the check's output Claude reads back. */
const CHECK_OUTPUT_LINES = 30;
const CHECK_OUTPUT_CHARS = 3000;
/** Longest check command shown in the terminal tab's name. */
const MAX_TERMINAL_NAME = 32;

/** Shared by goals and loops: which turn of the chat the record waits for. */
interface TurnWait {
	readonly sessionId: string;
	readonly cwd: string;
	/** True from sending a turn until it ends. */
	awaiting: boolean;
	/** The chat's last turn when the record sent its turn; its end is not ours. */
	baseline: string | undefined;
	readonly store: DisposableStore;
}

interface GoalRecord extends TurnWait {
	readonly goal: ClaudeGoalCommand;
	status: ClaudeGoalStatus;
	reason?: ClaudeGoalReason;
	turn: number;
	readonly maxTurns: number;
	readonly maxBudgetUsd?: number;
	spentUsd: number;
	lastCostUsd?: number;
	/** The terminal of the last check; the next check replaces it. */
	readonly check: MutableDisposable<DisposableStore>;
}

interface LoopRecord extends TurnWait {
	readonly loop: ClaudeLoopCommand;
	status: ClaudeLoopStatus;
	runs: number;
	nextAt?: number;
	/** The wait Claude asked for with `ScheduleWakeup` during the running turn. */
	wakeupMs?: number;
	readonly timer: MutableDisposable<IDisposable>;
}

/**
 * Runs `/goal` and `/loop` (issue 486). After each turn of a goal it runs the
 * check (a command in a terminal of this window, or Claude's own verdict) and
 * sends another turn while it fails, within the goal's turn and spend limits.
 * A loop sends its prompt again after its interval, or when Claude asks with
 * `ScheduleWakeup` (clamped to 1 to 60 minutes). Stop, a failed turn or a card
 * that needs the user pauses a goal; closing the chat ends both.
 */
export class ClaudeGoalLoopService extends Disposable implements IClaudeGoalLoopService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _goals = new Map<string, GoalRecord>();
	private readonly _ended = new Map<string, ClaudeGoalEnd>();
	private readonly _loops = new Map<string, LoopRecord>();

	constructor(
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@ITerminalService private readonly _terminals: ITerminalService,
		@ITerminalProfileResolverService private readonly _profiles: ITerminalProfileResolverService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@ILogService private readonly _log: ILogService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IClaudeAutomationService private readonly _automations: IClaudeAutomationService,
		@INotificationService private readonly _notifications: INotificationService,
	) {
		super();
		this._register(this._agent.onDidChangeViewState(({ sessionId }) => this.onViewState(sessionId)));
		this._register(this._agent.onDidReceiveEvent(event => this.onEvent(event)));
		this._register(this._agent.onDidChangeSession(change => {
			if (change.reason === 'closed') {
				const open = new Set(change.sessions.map(session => session.id));
				for (const id of this._ended.keys()) {
					if (!open.has(id)) {
						this._ended.delete(id);
					}
				}
				for (const id of [...this._goals.keys(), ...this._loops.keys()]) {
					if (!open.has(id)) {
						this.offerKeepRunning(id);
						this.stop(id, 'goal');
						this.stop(id, 'loop');
					}
				}
			}
		}));
	}

	override dispose(): void {
		for (const record of [...this._goals.values(), ...this._loops.values()]) {
			record.store.dispose();
		}
		this._goals.clear();
		this._loops.clear();
		super.dispose();
	}

	getGoal(sessionId: string): ClaudeGoalView | undefined {
		const record = this._goals.get(sessionId);
		return record && { goal: record.goal, status: record.status, reason: record.reason, turn: record.turn, maxTurns: record.maxTurns, spentUsd: record.spentUsd, maxBudgetUsd: record.maxBudgetUsd };
	}

	getEnded(sessionId: string): ClaudeGoalEnd | undefined {
		return this._ended.get(sessionId);
	}

	dismissEnded(sessionId: string): void {
		if (this._ended.delete(sessionId)) {
			this._onDidChange.fire(sessionId);
		}
	}

	getLoop(sessionId: string): ClaudeLoopView | undefined {
		const record = this._loops.get(sessionId);
		return record && { loop: record.loop, status: record.status, runs: record.runs, nextAt: record.nextAt };
	}

	async startGoal(sessionId: string, cwd: string, goal: ClaudeGoalCommand): Promise<void> {
		this.stop(sessionId, 'goal');
		this._ended.delete(sessionId);
		const store = new DisposableStore();
		const maxTurns = Math.max(1, Math.floor(goal.maxTurns ?? this._configuration.getValue<number>(CLAUDE_GOAL_MAX_TURNS_SETTING) ?? CLAUDE_GOAL_MAX_TURNS_DEFAULT));
		const budget = goal.maxBudgetUsd ?? this._configuration.getValue<number>(CLAUDE_GOAL_MAX_BUDGET_SETTING) ?? CLAUDE_GOAL_MAX_BUDGET_DEFAULT;
		const record: GoalRecord = {
			sessionId, cwd, store, goal,
			awaiting: false,
			baseline: undefined,
			status: 'running',
			turn: 0,
			maxTurns,
			maxBudgetUsd: budget > 0 ? budget : undefined,
			spentUsd: 0,
			lastCostUsd: this._agent.getViewState(sessionId).usage?.costUsd,
			check: store.add(new MutableDisposable<DisposableStore>()),
		};
		this._goals.set(sessionId, record);
		await this.sendGoalTurn(record, localize('claudeGoalStartLabel', "Goal: {0}", goal.outcome), claudeGoalStartPrompt(goal));
	}

	async startLoop(sessionId: string, cwd: string, loop: ClaudeLoopCommand): Promise<void> {
		this.stop(sessionId, 'loop');
		const store = new DisposableStore();
		const record: LoopRecord = {
			sessionId, cwd, store, loop,
			awaiting: false,
			baseline: undefined,
			status: 'running',
			runs: 0,
			timer: store.add(new MutableDisposable()),
		};
		this._loops.set(sessionId, record);
		await this.sendLoopTurn(record);
	}

	pause(sessionId: string, kind: 'goal' | 'loop'): void {
		if (kind === 'goal') {
			const record = this._goals.get(sessionId);
			if (record && (record.status === 'running' || record.status === 'checking')) {
				record.check.clear();
				this.setGoal(record, 'paused');
			}
			return;
		}
		const record = this._loops.get(sessionId);
		if (record && (record.status === 'running' || record.status === 'waiting')) {
			record.timer.clear();
			record.nextAt = undefined;
			record.status = 'paused';
			this._onDidChange.fire(sessionId);
		}
	}

	async resume(sessionId: string, kind: 'goal' | 'loop'): Promise<void> {
		if (kind === 'goal') {
			const record = this._goals.get(sessionId);
			if (record?.status !== 'paused') {
				return;
			}
			const last = this.lastTurn(sessionId);
			if (last?.status === 'running') {
				// The turn that needed the user is still going: check when it ends.
				record.awaiting = true;
				record.baseline = undefined;
				this.setGoal(record, 'running');
				return;
			}
			record.awaiting = false;
			this.setGoal(record, 'running');
			await this.checkGoal(record, last);
			return;
		}
		const record = this._loops.get(sessionId);
		if (record?.status === 'paused') {
			await this.sendLoopTurn(record);
		}
	}

	async keepRunning(sessionId: string, kind: 'goal' | 'loop'): Promise<void> {
		if (await this.saveFromRecord(sessionId, kind, this._goals.get(sessionId), this._loops.get(sessionId))) {
			this.stop(sessionId, kind);
		}
	}

	/** A chat is closing with a goal or loop in it: say it can go on as an automation (issue 1026). The default is to stop. */
	private offerKeepRunning(sessionId: string): void {
		const kinds: ('goal' | 'loop')[] = [];
		if (this._goals.get(sessionId)?.status === 'running' || this._goals.get(sessionId)?.status === 'checking') {
			kinds.push('goal');
		}
		const loop = this._loops.get(sessionId);
		if (loop && loop.status !== 'done') {
			kinds.push('loop');
		}
		if (!kinds.length) {
			return;
		}
		const message = kinds.length === 2
			? localize('claudeKeepRunningBoth', "The goal and loop in the closed chat have stopped.")
			: kinds[0] === 'goal'
				? localize('claudeKeepRunningGoal', "The goal in the closed chat has stopped.")
				: localize('claudeKeepRunningLoop', "The loop in the closed chat has stopped.");
		const records = kinds.map(kind => ({ kind, goal: this._goals.get(sessionId), loop: this._loops.get(sessionId) }));
		this._notifications.prompt(Severity.Info, message, [{
			label: localize('claudeKeepRunningAction', "Keep Running as Automation"),
			run: async () => {
				for (const { kind, goal, loop } of records) {
					await this.saveFromRecord(sessionId, kind, goal, loop);
				}
			},
		}], { sticky: false });
	}

	private async saveFromRecord(sessionId: string, kind: 'goal' | 'loop', goal: GoalRecord | undefined, loop: LoopRecord | undefined): Promise<boolean> {
		const scope = this._workspace.getWorkspace().folders.length > 0 ? 'workspace' : 'user';
		const id = claudeGoalLoopAutomationId(kind, sessionId);
		const automation = kind === 'goal' && goal
			? claudeGoalAutomation(goal.goal, id, { maxTurns: goal.maxTurns, maxBudgetUsd: goal.maxBudgetUsd })
			: kind === 'loop' && loop ? claudeLoopAutomation(loop.loop, id) : undefined;
		if (!automation) {
			return false;
		}
		await this._automations.save(scope, automation);
		if (kind === 'goal') {
			await this._automations.run(claudeAutomationKey(scope, id));
		}
		return true;
	}

	stop(sessionId: string, kind: 'goal' | 'loop'): void {
		const records: Map<string, TurnWait> = kind === 'goal' ? this._goals : this._loops;
		const record = records.get(sessionId);
		if (record) {
			records.delete(sessionId);
			record.store.dispose();
			this._onDidChange.fire(sessionId);
		}
	}

	// --- turns ---

	private lastTurn(sessionId: string): TurnViewModel | undefined {
		const turns = this._agent.getViewState(sessionId).turns;
		return turns[turns.length - 1];
	}

	/** Queues a turn: it goes out now, or after the turn that is running. */
	private async send(record: TurnWait, label: string, prompt: string): Promise<boolean> {
		record.baseline = this.lastTurn(record.sessionId)?.id;
		record.awaiting = true;
		try {
			await this._agent.queue(record.sessionId, label, record.cwd, 'queue', { compiled: prompt });
			return true;
		} catch (error) {
			record.awaiting = false;
			this._log.warn('[claude] Could not send a goal or loop turn.', error);
			return false;
		}
	}

	private async sendGoalTurn(record: GoalRecord, label: string, prompt: string): Promise<void> {
		record.turn++;
		this.setGoal(record, 'running');
		if (!await this.send(record, label, prompt) && this._goals.get(record.sessionId) === record) {
			this.setGoal(record, 'paused', 'failed-turn');
		}
	}

	private async sendLoopTurn(record: LoopRecord): Promise<void> {
		record.runs++;
		record.status = 'running';
		record.nextAt = undefined;
		record.wakeupMs = undefined;
		this._onDidChange.fire(record.sessionId);
		if (!await this.send(record, record.loop.prompt, claudeLoopPrompt(record.loop, record.runs)) && this._loops.get(record.sessionId) === record) {
			record.status = 'paused';
			this._onDidChange.fire(record.sessionId);
		}
	}

	private onViewState(sessionId: string): void {
		const last = this.lastTurn(sessionId);
		if (!last || last.status === 'running') {
			return;
		}
		const goal = this._goals.get(sessionId);
		if (goal?.awaiting && goal.status === 'running' && last.id !== goal.baseline) {
			goal.awaiting = false;
			void this.afterGoalTurn(goal, last);
		}
		const loop = this._loops.get(sessionId);
		if (loop?.awaiting && loop.status === 'running' && last.id !== loop.baseline) {
			loop.awaiting = false;
			this.afterLoopTurn(loop, last);
		}
	}

	private onEvent(event: NormalizedClaudeEvent): void {
		const sessionId = this.paneFor(event.sessionId);
		if (!sessionId) {
			return;
		}
		const goal = this._goals.get(sessionId);
		switch (event.type) {
			case 'usage.changed':
				if (goal && event.usage.costUsd !== undefined && (goal.status === 'running' || goal.status === 'checking')) {
					const next = addClaudeQueryCost(goal, event.usage.costUsd);
					goal.spentUsd = next.spentUsd;
					goal.lastCostUsd = next.lastCostUsd;
					this._onDidChange.fire(sessionId);
				} else if (goal && event.usage.costUsd !== undefined) {
					goal.lastCostUsd = event.usage.costUsd;
				}
				break;
			case 'permission.requested':
			case 'elicitation.requested':
				// A card waits for the user: the goal stops sending turns until Resume.
				if (goal?.status === 'running') {
					this.setGoal(goal, 'paused', 'needs-user');
				}
				break;
			case 'tool.started':
				if (!event.parentRunId && event.call.name === CLAUDE_SCHEDULE_WAKEUP_TOOL) {
					this.onWakeup(sessionId, event.call.input);
				}
				break;
		}
	}

	/** The pane session behind a runtime session, among the chats with a goal or loop. */
	private paneFor(runtimeSessionId: string): string | undefined {
		for (const id of new Set([...this._goals.keys(), ...this._loops.keys()])) {
			if (this._agent.getRuntimeSessionId(id) === runtimeSessionId) {
				return id;
			}
		}
		return this._agent.getSessions().find(session => this._agent.getRuntimeSessionId(session.id) === runtimeSessionId)?.id;
	}

	// --- goals ---

	private setGoal(record: GoalRecord, status: ClaudeGoalStatus, reason?: ClaudeGoalReason): void {
		record.status = status;
		record.reason = reason;
		if (status === 'met' || status === 'limit') {
			const turns = this._agent.getViewState(record.sessionId).turns;
			const view = this.getGoal(record.sessionId);
			if (view) {
				this._ended.set(record.sessionId, { view, cwd: record.cwd, afterTurnId: turns[turns.length - 1]?.id, at: Date.now() });
			}
		}
		this._onDidChange.fire(record.sessionId);
	}

	private async afterGoalTurn(record: GoalRecord, turn: TurnViewModel): Promise<void> {
		if (turn.status === 'stopped') {
			this.setGoal(record, 'paused', 'stopped-turn');
			return;
		}
		if (turn.status === 'failed') {
			this.setGoal(record, 'paused', 'failed-turn');
			return;
		}
		await this.checkGoal(record, turn);
	}

	private async checkGoal(record: GoalRecord, turn: TurnViewModel | undefined): Promise<void> {
		this.setGoal(record, 'checking');
		const verdict = record.goal.check
			? await this.runCheck(record, record.goal.check)
			: claudeGoalVerdictFromReply(turn?.assistantText ?? '');
		if (this._goals.get(record.sessionId) !== record || record.status !== 'checking') {
			return;
		}
		if (!verdict) {
			this.setGoal(record, 'paused', 'check-failed');
			return;
		}
		if (verdict.met) {
			this.setGoal(record, 'met');
			return;
		}
		if (record.turn >= record.maxTurns) {
			this.setGoal(record, 'limit', 'max-turns');
			return;
		}
		if (record.maxBudgetUsd !== undefined && record.spentUsd >= record.maxBudgetUsd) {
			this.setGoal(record, 'limit', 'budget');
			return;
		}
		await this.sendGoalTurn(record, localize('claudeGoalContinueLabel', "Goal turn {0}: continue toward {1}", record.turn + 1, record.goal.outcome), claudeGoalContinuePrompt(record.goal, verdict));
	}

	/**
	 * Runs the check command in a terminal of this window, so the user sees its
	 * output, and reads the exit code. Undefined when the terminal could not
	 * start or was closed before the command ended.
	 */
	private async runCheck(record: GoalRecord, command: string): Promise<ClaudeGoalVerdict | undefined> {
		const store = new DisposableStore();
		record.check.value = store;
		try {
			const shell = await this._profiles.getDefaultShell({ remoteAuthority: undefined, os: OS });
			const instance = await this._terminals.createTerminal({
				config: {
					name: localize('claudeGoalCheckName', "Goal check: {0}", shortCommand(command)),
					executable: shell,
					args: claudeTerminalShellArgs(shell, command),
					cwd: record.cwd,
					waitOnExit: localize('claudeGoalCheckDone', "The goal check ended. Klawly reads the result in the chat. Press any key to close this terminal."),
				},
			});
			if (store.isDisposed) {
				instance.dispose();
				return undefined;
			}
			store.add(instance);
			await this._terminals.revealTerminal(instance, true);
			return await new Promise<ClaudeGoalVerdict | undefined>(resolve => {
				store.add(instance.onExit(exit => {
					const exitCode = typeof exit === 'object' ? undefined : exit ?? instance.exitCode;
					const output = instance.xterm ? claudeTerminalLastOutput(instance.xterm.getBufferReverseIterator(), CHECK_OUTPUT_LINES, CHECK_OUTPUT_CHARS) : '';
					resolve(exitCode === undefined ? undefined : { met: exitCode === 0, exitCode, output: output || undefined });
				}));
				store.add(instance.onDisposed(() => resolve(undefined)));
				store.add({ dispose: () => resolve(undefined) });
			});
		} catch (error) {
			this._log.warn('[claude] Could not run the goal check.', error);
			return undefined;
		}
	}

	// --- loops ---

	private afterLoopTurn(record: LoopRecord, turn: TurnViewModel): void {
		if (turn.status !== 'complete') {
			record.timer.clear();
			record.status = 'paused';
			this._onDidChange.fire(record.sessionId);
			return;
		}
		let delay = record.loop.intervalMs;
		if (delay === undefined) {
			const pacing = claudeLoopPacingFromReply(turn.assistantText);
			if (record.wakeupMs === undefined && pacing?.done) {
				record.status = 'done';
				this._onDidChange.fire(record.sessionId);
				return;
			}
			delay = record.wakeupMs ?? (pacing && !pacing.done ? pacing.delayMs : CLAUDE_LOOP_DEFAULT_WAKEUP_MS);
		}
		record.status = 'waiting';
		record.nextAt = Date.now() + delay;
		record.timer.value = disposableTimeout(() => void this.fireLoop(record), delay);
		this._onDidChange.fire(record.sessionId);
	}

	private async fireLoop(record: LoopRecord): Promise<void> {
		if (this._loops.get(record.sessionId) !== record || record.status !== 'waiting') {
			return;
		}
		if (!this._agent.getSessions().some(session => session.id === record.sessionId)) {
			this.stop(record.sessionId, 'loop');
			return;
		}
		await this.sendLoopTurn(record);
	}

	/**
	 * Claude asked to run again later. A self-paced loop takes the wait; a chat
	 * with no loop starts one from the tool's prompt, so Claude Code's own loop
	 * skills run here too.
	 */
	private onWakeup(sessionId: string, input: unknown): void {
		const delay = claudeWakeupDelayMs(input);
		const fields = typeof input === 'object' && input !== null ? input as { prompt?: unknown; stop?: unknown } : {};
		const loop = this._loops.get(sessionId);
		if (fields.stop === true) {
			if (loop) {
				loop.timer.clear();
				loop.status = 'done';
				loop.nextAt = undefined;
				this._onDidChange.fire(sessionId);
			}
			return;
		}
		if (loop) {
			if (loop.loop.intervalMs === undefined && delay !== undefined) {
				loop.wakeupMs = delay;
			}
			return;
		}
		const prompt = typeof fields.prompt === 'string' ? fields.prompt.trim() : '';
		const cwd = this.cwdOf(sessionId);
		if (!prompt || prompt.startsWith('<<') || delay === undefined || !cwd) {
			return;
		}
		const store = new DisposableStore();
		this._loops.set(sessionId, {
			sessionId, cwd, store,
			loop: { kind: 'loop', prompt },
			awaiting: true,
			baseline: undefined,
			status: 'running',
			runs: 1,
			wakeupMs: delay,
			timer: store.add(new MutableDisposable()),
		});
		this._onDidChange.fire(sessionId);
	}

	/** The folder the chat's turns run in: a goal's, else the workspace's first local folder, as the composer sends. */
	private cwdOf(sessionId: string): string | undefined {
		return this._goals.get(sessionId)?.cwd ?? this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.fsPath;
	}
}

function shortCommand(command: string): string {
	const line = command.split(/\r?\n/, 1)[0].trim();
	return line.length > MAX_TERMINAL_NAME ? `${line.slice(0, MAX_TERMINAL_NAME - 1)}…` : line;
}
