/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { claudeGoalPillOutcome, formatClaudeInterval, parseClaudeGoalLoopCommand } from '../../../../../platform/claude/common/claudeGoalLoop.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { ClaudeGoalView, ClaudeLoopView, IClaudeGoalLoopService } from '../../common/claudeGoalLoopService.js';

interface StripButton {
	readonly icon: ThemeIcon;
	readonly label: string;
	readonly run: () => unknown;
}

/**
 * The chat's goal and loop, pinned above the composer as one row each (issue
 * 486): what runs, how far it got, and Pause, Resume and Stop. It follows the
 * pane's session and hides when the chat has neither (DL-61: one compact row
 * per running thing, actions on the row).
 */
export class ClaudeGoalLoopStrip extends Disposable {
	readonly element: HTMLElement;
	private readonly _rows = this._register(new DisposableStore());
	private _key = '';

	constructor(
		container: HTMLElement,
		private readonly _onDidResize: () => void,
		private readonly _report: (error: unknown) => void,
		@IClaudeGoalLoopService private readonly _service: IClaudeGoalLoopService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IHoverService private readonly _hovers: IHoverService,
	) {
		super();
		this.element = append(container, $('.claude-goal-strip'));
		this.element.setAttribute('role', 'status');
		this.element.hidden = true;
		this._register(this._service.onDidChange(sessionId => {
			if (sessionId === this._agent.getCurrentSession()?.id) {
				this.render();
			}
		}));
		this._register(this._agent.onDidChangeSession(() => this.render()));
		this.render();
	}

	/**
	 * Runs `/goal` or `/loop` typed in the composer. False when `text` is
	 * neither, so the composer sends it as a message.
	 */
	handle(sessionId: string, text: string, cwd: string): boolean {
		const command = parseClaudeGoalLoopCommand(text);
		if (!command) {
			return false;
		}
		const run = async () => {
			switch (command.kind) {
				case 'goal': return this._service.startGoal(sessionId, cwd, command);
				case 'loop': return this._service.startLoop(sessionId, cwd, command);
				case 'stop': return this._service.stop(sessionId, command.target);
				case 'invalid': throw new Error(command.message);
			}
		};
		run().catch(error => this._report(error));
		return true;
	}

	private render(): void {
		const sessionId = this._agent.getCurrentSession()?.id;
		const goal = sessionId ? this._service.getGoal(sessionId) : undefined;
		const loop = sessionId ? this._service.getLoop(sessionId) : undefined;
		const key = JSON.stringify([sessionId, goal, loop]);
		if (key === this._key) {
			return;
		}
		this._key = key;
		this._rows.clear();
		clearNode(this.element);
		this.element.hidden = !sessionId || (!goal && !loop);
		if (sessionId && goal) {
			this.goalRow(sessionId, goal);
		}
		if (sessionId && loop) {
			this.loopRow(sessionId, loop);
		}
		this._onDidResize();
	}

	private goalRow(sessionId: string, view: ClaudeGoalView): void {
		const icon = goalIcon(view);
		const spend = view.maxBudgetUsd !== undefined
			? localize('claudeGoalSpendOf', "${0} of ${1}", view.spentUsd.toFixed(2), view.maxBudgetUsd.toFixed(2))
			: localize('claudeGoalSpend', "${0}", view.spentUsd.toFixed(2));
		const detail = [
			goalStatusLabel(view),
			localize('claudeGoalTurns', "turn {0}/{1}", view.turn, view.maxTurns),
			spend,
		].join(' · ');
		const check = view.goal.check ? localize('claudeGoalCheckHover', "Done when `{0}` exits 0.", view.goal.check) : localize('claudeGoalReplyHover', "Done when Claude says the goal is met.");
		const ended = view.status === 'met' || view.status === 'limit';
		const buttons: StripButton[] = [];
		if (view.status === 'paused') {
			buttons.push({ icon: Codicon.debugContinue, label: localize('claudeGoalResume', "Resume Goal"), run: () => this._service.resume(sessionId, 'goal') });
		} else if (!ended) {
			buttons.push({ icon: Codicon.debugPause, label: localize('claudeGoalPause', "Pause Goal"), run: () => this._service.pause(sessionId, 'goal') });
		}
		if (!ended) {
			buttons.push({ icon: Codicon.cloud, label: localize('claudeGoalKeepRunning', "Keep Goal Running in the Background"), run: () => this._service.keepRunning(sessionId, 'goal') });
		}
		buttons.push(ended
			? { icon: Codicon.close, label: localize('claudeGoalDismiss', "Dismiss Goal"), run: () => this._service.stop(sessionId, 'goal') }
			: { icon: Codicon.debugStop, label: localize('claudeGoalStop', "Stop Goal"), run: () => this._service.stop(sessionId, 'goal') });
		this.row(`is-${view.status}`, icon, localize('claudeGoalLabel', "Goal: {0}", claudeGoalPillOutcome(view.goal.outcome)), detail, `${view.goal.outcome}\n${check}`, buttons);
	}

	private loopRow(sessionId: string, view: ClaudeLoopView): void {
		const icon = view.status === 'done' ? Codicon.passFilled
			: view.status === 'paused' ? Codicon.debugPause
				: view.status === 'waiting' ? Codicon.history
					: ThemeIcon.modify(Codicon.loading, 'spin');
		const label = view.loop.intervalMs !== undefined
			? localize('claudeLoopEvery', "Loop every {0}", formatClaudeInterval(view.loop.intervalMs))
			: localize('claudeLoopSelfPaced', "Loop, Claude picks the wait");
		const status = view.status === 'done' ? localize('claudeLoopDone', "done")
			: view.status === 'paused' ? localize('claudeLoopPaused', "paused")
				: view.status === 'running' ? localize('claudeLoopRunning', "running")
					: view.nextAt !== undefined ? localize('claudeLoopNext', "next {0}", new Date(view.nextAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
						: localize('claudeLoopWaiting', "waiting");
		const detail = [status, localize('claudeLoopRuns', "run {0}", view.runs)].join(' · ');
		const buttons: StripButton[] = [];
		if (view.status === 'paused') {
			buttons.push({ icon: Codicon.debugContinue, label: localize('claudeLoopResume', "Run Loop Now"), run: () => this._service.resume(sessionId, 'loop') });
		} else if (view.status !== 'done') {
			buttons.push({ icon: Codicon.debugPause, label: localize('claudeLoopPause', "Pause Loop"), run: () => this._service.pause(sessionId, 'loop') });
		}
		if (view.status !== 'done') {
			buttons.push({ icon: Codicon.cloud, label: localize('claudeLoopKeepRunning', "Keep Loop Running in the Background"), run: () => this._service.keepRunning(sessionId, 'loop') });
		}
		buttons.push(view.status === 'done'
			? { icon: Codicon.close, label: localize('claudeLoopDismiss', "Dismiss Loop"), run: () => this._service.stop(sessionId, 'loop') }
			: { icon: Codicon.debugStop, label: localize('claudeLoopStop', "Stop Loop"), run: () => this._service.stop(sessionId, 'loop') });
		this.row(`is-${view.status}`, icon, label, detail, view.loop.prompt, buttons);
	}

	private row(stateClass: string, icon: ThemeIcon, label: string, detail: string, hover: string, buttons: readonly StripButton[]): void {
		const row = append(this.element, $('.claude-goal-strip-row'));
		row.classList.add(stateClass);
		append(row, $('span.state' + ThemeIcon.asCSSSelector(icon))).setAttribute('aria-hidden', 'true');
		const text = append(row, $('span.label'));
		text.textContent = label;
		this._rows.add(this._hovers.setupDelayedHover(text, { content: hover, additionalClasses: ['claude-root'] }));
		append(row, $('span.detail')).textContent = detail;
		for (const button of buttons) {
			const element = append(row, $<HTMLButtonElement>('button.claude-icon-btn' + ThemeIcon.asCSSSelector(button.icon)));
			element.type = 'button';
			element.setAttribute('aria-label', button.label);
			this._rows.add(this._hovers.setupDelayedHover(element, { content: button.label, additionalClasses: ['claude-root'] }));
			this._rows.add(addDisposableListener(element, EventType.CLICK, async () => {
				try {
					await button.run();
				} catch (error) {
					this._report(error);
				}
			}));
		}
	}
}

/** The icon of a goal's state, on the strip, the tab and the chat notice. */
export function goalIcon(view: ClaudeGoalView): ThemeIcon {
	return view.status === 'met' ? Codicon.passFilled
		: view.status === 'limit' ? Codicon.warning
			: view.status === 'paused' ? Codicon.debugPause
				: ThemeIcon.modify(Codicon.loading, 'spin');
}

/**
 * The one sentence for a goal that hit a limit, reason first: "Goal not finished: reached the turn limit (5 turns)
 * at 2:41 PM. {outcome}". The chat notice and the tab icon's tooltip both use it (issue 1117).
 */
export function goalLimitSentence(view: ClaudeGoalView, time: string): string {
	return view.reason === 'budget'
		? localize('claudeGoalNotFinishedBudget', "Goal not finished: reached the spend limit (${0}) at {1}. {2}", (view.maxBudgetUsd ?? view.spentUsd).toFixed(2), time, view.goal.outcome)
		: localize('claudeGoalNotFinishedTurns', "Goal not finished: reached the turn limit ({0} turns) at {1}. {2}", view.maxTurns, time, view.goal.outcome);
}

export function goalStatusLabel(view: ClaudeGoalView): string {
	switch (view.status) {
		case 'running': return localize('claudeGoalRunning', "working");
		case 'checking': return localize('claudeGoalChecking', "checking");
		case 'met': return localize('claudeGoalMet', "met");
		case 'limit': return view.reason === 'budget' ? localize('claudeGoalBudget', "spend limit reached") : localize('claudeGoalMaxTurns', "turn limit reached");
		case 'paused':
			switch (view.reason) {
				case 'needs-user': return localize('claudeGoalNeedsUser', "paused, Claude needs you");
				case 'failed-turn': return localize('claudeGoalFailedTurn', "paused, the turn failed");
				case 'check-failed': return localize('claudeGoalCheckFailed', "paused, the check did not run");
				default: return localize('claudeGoalPaused', "paused");
			}
	}
}
