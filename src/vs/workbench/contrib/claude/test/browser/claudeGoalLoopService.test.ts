/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CLAUDE_GOAL_MAX_BUDGET_SETTING, CLAUDE_GOAL_MAX_TURNS_SETTING } from '../../../../../platform/claude/common/claudeGoalLoop.js';
import { PendingInput } from '../../../../../platform/claude/common/claudeContext.js';
import { NormalizedClaudeEvent } from '../../../../../platform/claude/common/claudeProtocol.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, IPromptChoice } from '../../../../../platform/notification/common/notification.js';
import { ITerminalLaunchError } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspace, IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ICreateTerminalOptions, ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { XtermTerminal } from '../../../terminal/browser/xterm/xtermTerminal.js';
import { ITerminalProfileResolverService } from '../../../terminal/common/terminal.js';
import { IClaudeAutomationService } from '../../../../services/claude/common/claudeAutomationService.js';
import { ClaudeAgentSession, ClaudeAgentSessionChange, IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { AgentViewState, TurnStatus, TurnViewModel } from '../../../../services/claude/common/claudeAgentState.js';
import { ClaudeGoalLoopService } from '../../browser/chat/claudeGoalLoopService.js';

/** A Claude event without its session, one union member at a time. */
type EventBody<E = NormalizedClaudeEvent> = E extends NormalizedClaudeEvent ? Omit<E, 'sessionId'> : never;

suite('Claude goals and loops service (issue 486)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(settings: { maxTurns?: number; maxBudgetUsd?: number } = {}) {
		const viewStates = store.add(new Emitter<{ sessionId: string }>());
		const events = store.add(new Emitter<NormalizedClaudeEvent>());
		const sessionChanges = store.add(new Emitter<ClaudeAgentSessionChange>());
		const exits = store.add(new Emitter<number | ITerminalLaunchError | undefined>());
		const disposed = store.add(new Emitter<ITerminalInstance>());
		const log: string[] = [];
		const turns: TurnViewModel[] = [];
		let open = true;
		const agent = {
			onDidChangeViewState: viewStates.event,
			onDidReceiveEvent: events.event,
			onDidChangeSession: sessionChanges.event,
			getViewState: () => ({ turns }) as Partial<AgentViewState> as AgentViewState,
			getSessions: () => open ? [{ id: 'pane-1' } as ClaudeAgentSession] : [],
			getRuntimeSessionId: (id: string) => id === 'pane-1' ? 'runtime-1' : undefined,
			queue: async (_sessionId: string, text: string, _cwd: string, _behavior: PendingInput['behavior'], options?: { compiled?: string }) => {
				log.push(`queue ${text} | ${options?.compiled?.split('\n')[0]}`);
				return {} as PendingInput;
			},
		} as Partial<IClaudeAgentService> as IClaudeAgentService;
		const instance = {
			onExit: exits.event,
			onDisposed: disposed.event,
			exitCode: undefined,
			xterm: { getBufferReverseIterator: () => ['', '2 failing'][Symbol.iterator]() } as Partial<XtermTerminal> as XtermTerminal,
			dispose: () => log.push('dispose terminal'),
		} as Partial<ITerminalInstance> as ITerminalInstance;
		const terminals = {
			createTerminal: async (created?: ICreateTerminalOptions) => {
				const config = created?.config as { name?: string; args?: string[]; cwd?: string };
				log.push(`terminal ${config.name} ${JSON.stringify(config.args)} in ${config.cwd}`);
				return instance;
			},
			revealTerminal: async () => { },
		} as Partial<ITerminalService> as ITerminalService;
		const profiles = { getDefaultShell: async () => '/bin/zsh' } as Partial<ITerminalProfileResolverService> as ITerminalProfileResolverService;
		const configuration = new TestConfigurationService({
			[CLAUDE_GOAL_MAX_TURNS_SETTING]: settings.maxTurns ?? 10,
			[CLAUDE_GOAL_MAX_BUDGET_SETTING]: settings.maxBudgetUsd ?? 5,
		});
		const workspace = { getWorkspace: () => ({ folders: [{ uri: URI.file('/work/app') }] }) as Partial<IWorkspace> as IWorkspace } as Partial<IWorkspaceContextService> as IWorkspaceContextService;
		const prompts: IPromptChoice[][] = [];
		const notifications = { prompt: (_severity: unknown, _message: string, choices: IPromptChoice[]) => { prompts.push(choices); } } as Partial<INotificationService> as INotificationService;
		const automations = {
			save: async (scope: string, automation: { id: string; name: string; trigger: unknown; prompt: string; budgetUsd: number; maxTurns?: number }) => { log.push(`save ${scope} ${JSON.stringify({ id: automation.id, name: automation.name, trigger: automation.trigger, maxTurns: automation.maxTurns, budgetUsd: automation.budgetUsd })}`); },
			run: async (key: string) => { log.push(`run ${key}`); },
		} as unknown as IClaudeAutomationService;
		const service = store.add(new ClaudeGoalLoopService(agent, terminals, profiles, configuration, new NullLogService(), workspace, automations, notifications));
		let turnCount = 0;
		/** A turn of the chat ends with `reply`. */
		const endTurn = async (assistantText: string, status: TurnStatus = 'complete') => {
			turns.push({ id: `t${++turnCount}`, assistantText, status } as Partial<TurnViewModel> as TurnViewModel);
			viewStates.fire({ sessionId: 'pane-1' });
			await timeout(0);
		};
		const event = (body: EventBody) => events.fire({ sessionId: 'runtime-1', ...body } as NormalizedClaudeEvent);
		const close = () => {
			open = false;
			sessionChanges.fire({ reason: 'closed', session: undefined, sessions: [] });
		};
		return { service, log, exits, endTurn, event, close, prompts };
	}

	test('a goal with a check runs it in a terminal after each turn and continues until it exits 0', () => runWithFakedTimers({}, async () => {
		const h = setup();
		await h.service.startGoal('pane-1', '/work/app', { kind: 'goal', outcome: 'make npm test pass', check: 'npm test' });
		h.event({ type: 'usage.changed', usage: { costUsd: 0.25 } });
		await h.endTurn('I fixed one test.');
		const checking = h.service.getGoal('pane-1')?.status;
		h.exits.fire(1);
		await timeout(0);
		h.event({ type: 'usage.changed', usage: { costUsd: 0.75 } });
		await h.endTurn('I fixed the other one.');
		h.exits.fire(0);
		await timeout(0);
		assert.deepStrictEqual({ checking, log: h.log, goal: h.service.getGoal('pane-1') }, {
			checking: 'checking',
			log: [
				'queue Goal: make npm test pass | Work toward this goal until it is done: make npm test pass',
				'terminal Goal check: npm test ["-c","npm test"] in /work/app',
				'queue Goal turn 2: continue toward make npm test pass | Continue toward the goal: make npm test pass',
				'dispose terminal',
				'terminal Goal check: npm test ["-c","npm test"] in /work/app',
			],
			goal: { goal: { kind: 'goal', outcome: 'make npm test pass', check: 'npm test' }, status: 'met', reason: undefined, turn: 2, maxTurns: 10, spentUsd: 0.75, maxBudgetUsd: 5 },
		});
		h.service.stop('pane-1', 'goal');
	}));

	test('a goal Claude judges stops at its turn or spend limit, and a card that needs the user pauses it until Resume', () => runWithFakedTimers({}, async () => {
		const turnsLimit = setup({ maxTurns: 2 });
		await turnsLimit.service.startGoal('pane-1', '/work/app', { kind: 'goal', outcome: 'the README explains setup' });
		await turnsLimit.endTurn('Goal not met: the Windows steps');
		await turnsLimit.endTurn('Goal not met: still the Windows steps');
		const budget = setup({ maxBudgetUsd: 1 });
		await budget.service.startGoal('pane-1', '/work/app', { kind: 'goal', outcome: 'ship it' });
		budget.event({ type: 'usage.changed', usage: { costUsd: 1.5 } });
		await budget.endTurn('Goal not met');
		const paused = setup();
		await paused.service.startGoal('pane-1', '/work/app', { kind: 'goal', outcome: 'ship it' });
		paused.event({ type: 'permission.requested', request: {} } as EventBody);
		await paused.endTurn('Goal not met: waiting');
		const whilePaused = paused.service.getGoal('pane-1')?.reason;
		await paused.service.resume('pane-1', 'goal');
		await paused.endTurn('Goal met');
		assert.deepStrictEqual({
			turnsLimit: [turnsLimit.log, turnsLimit.service.getGoal('pane-1')?.status, turnsLimit.service.getGoal('pane-1')?.reason],
			budget: [budget.service.getGoal('pane-1')?.status, budget.service.getGoal('pane-1')?.reason, budget.service.getGoal('pane-1')?.turn],
			paused: [whilePaused, paused.log.length, paused.service.getGoal('pane-1')?.status],
		}, {
			turnsLimit: [[
				'queue Goal: the README explains setup | Work toward this goal until it is done: the README explains setup',
				'queue Goal turn 2: continue toward the README explains setup | Continue toward the goal: the README explains setup',
			], 'limit', 'max-turns'],
			budget: ['limit', 'budget', 1],
			paused: ['needs-user', 2, 'met'],
		});
		for (const h of [turnsLimit, budget, paused]) {
			h.service.stop('pane-1', 'goal');
		}
	}));

	test('a goal that met or hit a limit is remembered for the chat after the pill is dismissed, until a new goal starts (issue 1102)', () => runWithFakedTimers({}, async () => {
		const limit = setup({ maxTurns: 1 });
		await limit.service.startGoal('pane-1', '/work/app', { kind: 'goal', outcome: 'ship it' });
		await limit.endTurn('Goal not met');
		const atLimit = limit.service.getEnded('pane-1');
		limit.service.stop('pane-1', 'goal');
		const afterDismiss = limit.service.getEnded('pane-1')?.view.status;
		await limit.service.startGoal('pane-1', '/work/app', { kind: 'goal', outcome: 'again' });
		const afterRestart = limit.service.getEnded('pane-1');
		const met = setup();
		await met.service.startGoal('pane-1', '/work/app', { kind: 'goal', outcome: 'ship it' });
		await met.endTurn('Goal met');
		const budget = setup({ maxBudgetUsd: 1 });
		await budget.service.startGoal('pane-1', '/work/app', { kind: 'goal', outcome: 'ship it' });
		budget.event({ type: 'usage.changed', usage: { costUsd: 1.5 } });
		await budget.endTurn('Goal not met');
		assert.deepStrictEqual({
			limit: [atLimit?.view.status, atLimit?.view.reason, atLimit?.cwd, atLimit?.view.goal.outcome],
			afterDismiss,
			afterRestart,
			met: met.service.getEnded('pane-1')?.view.status,
			budget: budget.service.getEnded('pane-1')?.view.reason,
		}, {
			limit: ['limit', 'max-turns', '/work/app', 'ship it'],
			afterDismiss: 'limit',
			afterRestart: undefined,
			met: 'met',
			budget: 'budget',
		});
		for (const h of [limit, met, budget]) {
			h.service.stop('pane-1', 'goal');
		}
	}));

	test('a loop repeats its prompt after its interval until stopped; closing the chat ends it', () => runWithFakedTimers({}, async () => {
		const h = setup();
		await h.service.startLoop('pane-1', '/work/app', { kind: 'loop', prompt: 'check the build', intervalMs: 600_000 });
		await h.endTurn('Build is green.');
		const waiting = h.service.getLoop('pane-1');
		await timeout(600_000);
		const second = h.service.getLoop('pane-1')?.runs;
		await h.endTurn('Still green.');
		h.close();
		await timeout(600_000);
		assert.deepStrictEqual({ log: h.log, waiting: [waiting?.status, waiting?.runs, waiting?.nextAt !== undefined], second, after: h.service.getLoop('pane-1') }, {
			log: [
				'queue check the build | check the build',
				'queue check the build | check the build',
			],
			waiting: ['waiting', 1, true],
			second: 2,
			after: undefined,
		});
	}));

	test('ScheduleWakeup from Claude paces a self-paced loop, starts one from its prompt, and stop ends it', () => runWithFakedTimers({}, async () => {
		const h = setup();
		h.event({ type: 'tool.started', call: { id: 'c1', name: 'ScheduleWakeup', input: { delaySeconds: 120, prompt: 'check the deploy' } } } as EventBody);
		const started = h.service.getLoop('pane-1');
		await h.endTurn('Deploy at 40%.');
		const waiting = h.service.getLoop('pane-1')?.status;
		await timeout(120_000);
		await h.endTurn('Deploy done.\nLoop done');
		const done = h.service.getLoop('pane-1')?.status;
		await h.service.startLoop('pane-1', '/work/app', { kind: 'loop', prompt: 'watch CI' });
		h.event({ type: 'tool.started', call: { id: 'c2', name: 'ScheduleWakeup', input: { stop: true } } } as EventBody);
		assert.deepStrictEqual({ started, waiting, done, stopped: h.service.getLoop('pane-1')?.status, log: h.log }, {
			started: { loop: { kind: 'loop', prompt: 'check the deploy' }, status: 'running', runs: 1, nextAt: undefined },
			waiting: 'waiting',
			done: 'done',
			stopped: 'done',
			log: [
				'queue check the deploy | check the deploy',
				'queue watch CI | watch CI',
			],
		});
		h.service.stop('pane-1', 'loop');
	}));
	test('Keep Running turns a loop into a schedule and ends it in the chat (issue 1026)', () => runWithFakedTimers({}, async () => {
		const h = setup();
		await h.service.startLoop('pane-1', '/work/app', { kind: 'loop', prompt: 'check the deploy', intervalMs: 5 * 60_000 });
		h.log.length = 0;
		await h.service.keepRunning('pane-1', 'loop');
		assert.deepStrictEqual({ log: h.log.map(line => line.replace(/"budgetUsd":[\d.]+/, '"budgetUsd":N')), loop: h.service.getLoop('pane-1') }, {
			log: ['save workspace {"id":"loop-pane-1","name":"Loop: check the deploy","trigger":{"type":"schedule","cron":"*/5 * * * *"},"budgetUsd":N}'],
			loop: undefined,
		});
	}));

	test('Keep Running starts a goal as a background run now (issue 1026)', () => runWithFakedTimers({}, async () => {
		const h = setup({ maxTurns: 7, maxBudgetUsd: 3 });
		await h.service.startGoal('pane-1', '/work/app', { kind: 'goal', outcome: 'ship it' });
		h.log.length = 0;
		await h.service.keepRunning('pane-1', 'goal');
		assert.deepStrictEqual({ log: h.log.map(line => line.replace(/"budgetUsd":[\d.]+/, '"budgetUsd":N')), goal: h.service.getGoal('pane-1') }, {
			log: ['save workspace {"id":"goal-pane-1","name":"Goal: ship it","trigger":{"type":"manual"},"maxTurns":7,"budgetUsd":N}', 'run workspace:goal-pane-1'],
			goal: undefined,
		});
	}));

	test('closing a chat with a running goal offers to keep it running, and stops it unless taken (issue 1026)', () => runWithFakedTimers({}, async () => {
		const h = setup();
		await h.service.startGoal('pane-1', '/work/app', { kind: 'goal', outcome: 'ship it' });
		h.log.length = 0;
		h.close();
		const offered = h.prompts.map(choices => choices.map(choice => choice.label));
		const stopped = h.service.getGoal('pane-1');
		await h.prompts[0][0].run();
		assert.deepStrictEqual({ offered, stopped, saved: h.log.map(line => line.split(' ').slice(0, 2).join(' ')) }, {
			offered: [['Keep Running as Automation']],
			stopped: undefined,
			saved: ['save workspace', 'run workspace:goal-pane-1'],
		});
	}));
});
