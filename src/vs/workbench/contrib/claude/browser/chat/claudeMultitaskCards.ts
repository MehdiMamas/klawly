/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { AgentMode } from '../../../../../platform/claude/common/claudeContext.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { BackgroundAgentCard, backgroundAgentCard } from '../../../../services/claude/common/claudeBackgroundCards.js';
import { IClaudeMultitaskService, MultitaskGroup, MultitaskPrompt, MultitaskRun } from '../../../../services/claude/common/claudeMultitask.js';

const CARD_ICONS: Record<BackgroundAgentCard['icon'], ThemeIcon> = {
	'loading': Codicon.loading,
	'pass': Codicon.pass,
	'error': Codicon.error,
	'git-merge': Codicon.gitMerge,
	'shield': Codicon.shield,
};

interface RunLook {
	readonly icon: ThemeIcon;
	readonly badge: string;
	readonly kind: BackgroundAgentCard['badgeKind'];
}

/** How a run with no background agent looks: a read-only run, or one restored after a reload (issue 686). */
function runLook(run: MultitaskRun): RunLook {
	switch (run.status) {
		case 'queued':
			return { icon: Codicon.clock, badge: localize('claudeMultitaskQueued', "waiting for a slot"), kind: 'running' };
		case 'starting':
			return { icon: ThemeIcon.modify(Codicon.loading, 'spin'), badge: localize('claudeMultitaskStarting', "starting"), kind: 'running' };
		case 'running':
			return { icon: ThemeIcon.modify(Codicon.loading, 'spin'), badge: localize('claudeMultitaskRunningBadge', "running"), kind: 'running' };
		case 'waiting':
			return { icon: Codicon.shield, badge: localize('claudeMultitaskApproval', "approval"), kind: 'warning' };
		case 'complete':
			return { icon: Codicon.pass, badge: localize('claudeMultitaskDone', "done"), kind: 'success' };
		case 'failed':
			return {
				icon: Codicon.error,
				badge: run.stopped ? localize('claudeMultitaskStopped', "stopped") : localize('claudeMultitaskFailed', "failed"),
				kind: 'error',
			};
	}
}

/**
 * Live cards above the composer for the chat's multitasks (issue 487): one row
 * per prompt with its run's status, in the queue's quiet row style (DL-07,
 * DL-60). A row opens that run's chat; the header stops the runs or, once they
 * ended, dismisses the cards. A multitask a window reload interrupted offers
 * Send Results instead of sending on its own (issue 686).
 */
export class ClaudeMultitaskCards extends Disposable {
	private readonly _root: HTMLElement;
	private readonly _rendered = this._register(new DisposableStore());

	constructor(
		container: HTMLElement,
		private readonly _requestLayout: () => void,
		@IClaudeMultitaskService private readonly _multitask: IClaudeMultitaskService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IHoverService private readonly _hovers: IHoverService,
	) {
		super();
		this._root = append(container, $('.claude-multitask'));
		this._root.setAttribute('aria-label', localize('claudeMultitaskCards', "Parallel tasks"));
		this._root.hidden = true;
		this._register(this._multitask.onDidChange(() => this.render()));
		this._register(this._agent.onDidChangeSession(() => this.render()));
		this.render();
	}

	/** Starts the prompts of a `/multitask` message in a chat, in that chat's mode. */
	start(sessionId: string, prompts: readonly (string | MultitaskPrompt)[], cwd: string, mode: AgentMode): void {
		this._multitask.start(sessionId, prompts, cwd, mode);
	}

	private render(): void {
		this._rendered.clear();
		clearNode(this._root);
		const session = this._agent.getCurrentSession();
		const groups = session ? this._multitask.getGroups(session.id) : [];
		this._root.hidden = groups.length === 0;
		for (const group of groups) {
			this.renderGroup(group, session!.id);
		}
		this._requestLayout();
	}

	private renderGroup(group: MultitaskGroup, sessionId: string): void {
		const box = append(this._root, $('.claude-multitask-group'));
		const header = append(box, $('.claude-multitask-header'));
		const readOnly = group.runs.every(run => run.readOnly);
		append(header, $(ThemeIcon.asCSSSelector(readOnly ? Codicon.eye : Codicon.layers)));
		const title = append(header, $('span.text'));
		const ended = group.endedAt !== undefined;
		const count = group.runs.length;
		const done = group.runs.filter(run => run.status === 'complete' || run.status === 'failed').length;
		if (group.unsent) {
			title.textContent = localize('claudeMultitaskReloaded', "{0} of {1} tasks done before the reload", group.runs.filter(run => run.status === 'complete').length, count);
		} else if (ended) {
			title.textContent = readOnly
				? localize('claudeMultitaskEndedReadOnly', "{0} read-only tasks ended, results sent to this chat", count)
				: localize('claudeMultitaskEnded', "{0} parallel tasks ended, results sent to this chat", count);
		} else {
			title.textContent = readOnly
				? localize('claudeMultitaskRunningReadOnly', "{0} of {1} read-only tasks done in this folder", done, count)
				: localize('claudeMultitaskRunning', "{0} of {1} parallel tasks done", done, count);
		}
		// A header cut off in a narrow pane still reads whole on hover; a read-only one also says why it has no worktrees (issue 759).
		const readOnlyNote = readOnly ? localize('claudeMultitaskReadOnlyHover', "These tasks run in this chat's folder without worktrees: Ask and Plan do not change files.") : undefined;
		this._rendered.add(this._hovers.setupDelayedHover(title, {
			content: readOnlyNote ? `${title.textContent}
${readOnlyNote}` : title.textContent ?? '',
			additionalClasses: ['claude-root'],
		}));
		if (group.unsent) {
			// DL-15: a quiet secondary action; the chat's one primary stays Send.
			const send = append(header, $<HTMLButtonElement>('button.claude-btn.is-small'));
			send.type = 'button';
			append(send, $(ThemeIcon.asCSSSelector(Codicon.send)));
			append(send, $('span')).textContent = localize('claudeMultitaskSendResults', "Send Results");
			this._rendered.add(this._hovers.setupDelayedHover(send, {
				content: localize('claudeMultitaskSendResultsHover', "Send what finished to this chat as one turn"),
				additionalClasses: ['claude-root'],
			}));
			this._rendered.add(addDisposableListener(send, EventType.CLICK, event => {
				event.preventDefault();
				this._multitask.sendResults(group.id, sessionId);
			}));
		}
		const button = append(header, $<HTMLButtonElement>('button.claude-btn.is-icon.is-small'));
		button.type = 'button';
		const label = ended ? localize('claudeMultitaskDismiss', "Dismiss") : localize('claudeMultitaskStop', "Stop All");
		button.setAttribute('aria-label', label);
		append(button, $(ThemeIcon.asCSSSelector(ended ? Codicon.close : Codicon.debugStop)));
		this._rendered.add(this._hovers.setupDelayedHover(button, { content: label, additionalClasses: ['claude-root'] }));
		this._rendered.add(addDisposableListener(button, EventType.CLICK, event => {
			event.preventDefault();
			if (ended) {
				this._multitask.dismiss(group.id);
			} else {
				void this._multitask.stop(group.id);
			}
		}));
		group.runs.forEach((run, index) => this.renderRun(box, run, index));
	}

	private renderRun(box: HTMLElement, run: MultitaskRun, index: number): void {
		const task = this._multitask.getTask(run);
		const card = task ? backgroundAgentCard(task) : undefined;
		const row = append(box, $<HTMLButtonElement>('button.claude-multitask-run'));
		row.type = 'button';
		const openable = this._multitask.canOpen(run);
		row.disabled = !openable;
		let look = runLook(run);
		if (card && !run.error) {
			look = { icon: card.spin ? ThemeIcon.modify(Codicon.loading, 'spin') : CARD_ICONS[card.icon], badge: card.badge, kind: card.badgeKind };
		}
		row.classList.add(`is-${look.kind}`);
		append(row, $(ThemeIcon.asCSSSelector(look.icon)));
		const text = append(row, $('span.text'));
		text.textContent = run.prompt;
		if (task && task.filesChanged > 0) {
			const diff = append(row, $('span.claude-multitask-diff'));
			append(diff, $('span.added')).textContent = `+${task.added}`;
			append(diff, $('span.removed')).textContent = `-${task.removed}`;
		}
		append(row, $('span.claude-multitask-badge')).textContent = look.badge;
		row.setAttribute('aria-label', localize('claudeMultitaskRunLabel', "Task {0}: {1}, {2}", index + 1, run.prompt, look.badge));
		let hover = run.error ?? run.prompt;
		if (!run.error && openable) {
			hover = task
				? localize('claudeMultitaskOpen', "Open this task's chat ({0})", task.branchName)
				: localize('claudeMultitaskOpenReadOnly', "Open this task's chat");
		}
		this._rendered.add(this._hovers.setupDelayedHover(row, { content: hover, additionalClasses: ['claude-root'] }));
		this._rendered.add(addDisposableListener(row, EventType.CLICK, event => {
			event.preventDefault();
			this._multitask.open(run);
		}));
	}
}
