/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { ClaudeGoalCommand, ClaudeLoopCommand } from '../../../../platform/claude/common/claudeGoalLoop.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * `running`: a goal turn is out. `checking`: the check runs. `paused`: Stop, a
 * failed turn or a card that needs the user halted it; Resume goes on. `met` and
 * `limit` are final and stay on the pill until the user dismisses it.
 */
export type ClaudeGoalStatus = 'running' | 'checking' | 'paused' | 'met' | 'limit';

/** Why a goal paused or ended early. */
export type ClaudeGoalReason = 'stopped-turn' | 'failed-turn' | 'needs-user' | 'max-turns' | 'budget' | 'check-failed';

export interface ClaudeGoalView {
	readonly goal: ClaudeGoalCommand;
	readonly status: ClaudeGoalStatus;
	readonly reason?: ClaudeGoalReason;
	/** Goal turns sent so far, the first one included. */
	readonly turn: number;
	readonly maxTurns: number;
	readonly spentUsd: number;
	/** Undefined when `claude.goal.maxBudgetUsd` is 0. */
	readonly maxBudgetUsd?: number;
}

/** `done`: a self-paced loop that Claude ended. It stays on the pill until dismissed. */
export type ClaudeLoopStatus = 'running' | 'waiting' | 'paused' | 'done';

export interface ClaudeLoopView {
	readonly loop: ClaudeLoopCommand;
	readonly status: ClaudeLoopStatus;
	/** Loop turns sent so far. */
	readonly runs: number;
	/** When the next turn goes out, while `waiting`. */
	readonly nextAt?: number;
}

/**
 * How a goal ended (met, turn limit, spend limit), kept after the pill is dismissed so
 * the chat can say so for good (issue 1102). It lasts until a new goal starts.
 */
export interface ClaudeGoalEnd {
	readonly view: ClaudeGoalView;
	readonly cwd: string;
	/** The chat's last turn when the goal ended; the notice shows while it is still the last. */
	readonly afterTurnId: string | undefined;
	readonly at: number;
}

export const IClaudeGoalLoopService = createDecorator<IClaudeGoalLoopService>('claudeGoalLoopService');

/**
 * Runs `/goal` and `/loop` for the chats of this window (issue 486). Both live
 * as long as the chat's tab: closing it stops them.
 */
export interface IClaudeGoalLoopService {
	readonly _serviceBrand: undefined;
	/** Fires with the pane session whose goal or loop changed. */
	readonly onDidChange: Event<string>;
	getGoal(sessionId: string): ClaudeGoalView | undefined;
	/** The goal that last ended in this chat, even after its pill was dismissed. */
	getEnded(sessionId: string): ClaudeGoalEnd | undefined;
	/** Forgets the ended goal, so its chat notice goes (issue 1117). */
	dismissEnded(sessionId: string): void;
	getLoop(sessionId: string): ClaudeLoopView | undefined;
	/** Replaces the chat's goal and sends its first turn now, or after the running turn. */
	startGoal(sessionId: string, cwd: string, goal: ClaudeGoalCommand): Promise<void>;
	/** Replaces the chat's loop and sends its first turn now, or after the running turn. */
	startLoop(sessionId: string, cwd: string, loop: ClaudeLoopCommand): Promise<void>;
	/** Halts after the running turn. The running turn itself goes on. */
	pause(sessionId: string, kind: 'goal' | 'loop'): void;
	/** Goes on from a pause: a goal checks again, a loop runs its prompt now. */
	resume(sessionId: string, kind: 'goal' | 'loop'): Promise<void>;
	/**
	 * Hands the chat's goal or loop to an automation that goes on without the chat (issue 1026), then ends it here.
	 * A loop becomes a schedule (it runs while automations are on); a goal starts as a background run now.
	 */
	keepRunning(sessionId: string, kind: 'goal' | 'loop'): Promise<void>;
	/** Ends the goal or loop and removes it from the pill. The running turn goes on. */
	stop(sessionId: string, kind: 'goal' | 'loop'): void;
}
