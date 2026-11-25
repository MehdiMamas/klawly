/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { goalIcon, goalLimitSentence } from './claudeGoalLoopStrip.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { language } from '../../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { basename } from '../../../../../base/common/path.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { ClaudeGoalView, IClaudeGoalLoopService } from '../../common/claudeGoalLoopService.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { CLAUDE_START_GOAL_COMMAND_ID, KLAWLY_CATEGORY } from '../../common/claudeViews.js';

/** The one resource of the chat editor: the chat follows the current session, so there is one tab. */
export const CLAUDE_AGENT_EDITOR_RESOURCE = URI.from({ scheme: 'klawly-agent', path: '/chat' });

/** True when the chat is open in an editor tab of any group or window. */
export function isClaudeChatInEditor(editors: IEditorService): boolean {
	return editors.findEditors(CLAUDE_AGENT_EDITOR_RESOURCE).length > 0;
}

/** True while the current chat has a goal, so its tab menu offers Stop Goal and Edit Goal (issue 1080). */
const CLAUDE_TAB_HAS_GOAL = new RawContextKey<boolean>('claude.tabHasGoal', false);
/** True while the current chat's goal works, checks or is paused, so Stop Goal and Edit Goal have a goal to act on (issues 1099, 1116). */
export const CLAUDE_GOAL_RUNNING = new RawContextKey<boolean>('claude.goalRunning', false);
/** True only while the current chat's goal is paused, so the palette offers Resume Goal (issue 1116). */
export const CLAUDE_GOAL_PAUSED = new RawContextKey<boolean>('claude.goalPaused', false);
export const CLAUDE_STOP_GOAL_COMMAND_ID = 'claude.stopGoal';
export const CLAUDE_EDIT_GOAL_COMMAND_ID = 'claude.editGoal';
export const CLAUDE_RESUME_GOAL_COMMAND_ID = 'claude.resumeGoal';
const CLAUDE_TAB_STOP_GOAL_COMMAND_ID = 'claude.tabStopGoal';
const CLAUDE_TAB_EDIT_GOAL_COMMAND_ID = 'claude.tabEditGoal';

/** The folder name a worktree agent runs in, or undefined for an agent in the project folder. */
function worktreeName(worktreePath: string | undefined): string | undefined {
	return worktreePath ? basename(worktreePath.replace(/\\/g, '/').replace(/\/+$/, '')) : undefined;
}

/** The pill text of a goal: turns while it works, why it ended once it did (issue 1080). */
function goalPill(goal: ClaudeGoalView): string {
	switch (goal.status) {
		case 'met': return localize('claudeTabGoalMet', "Goal met");
		case 'limit': return goal.reason === 'budget'
			? localize('claudeTabGoalBudget', "Goal stopped: spend limit")
			: localize('claudeTabGoalMaxTurns', "Goal stopped: {0} turns", goal.maxTurns);
		case 'paused': return localize('claudeTabGoalPaused', "Goal paused {0}/{1}", goal.turn, goal.maxTurns);
		default: return localize('claudeTabGoalTurn', "Goal {0}/{1}", goal.turn, goal.maxTurns);
	}
}

/** The tooltip line under the tab title: what the pill counts and where the goal runs (issue 1080). */
function goalTooltip(goal: ClaudeGoalView, worktree: string | undefined, endedAt: number | undefined): string {
	let detail: string;
	if (goal.status === 'met') {
		detail = localize('claudeTabGoalTipMet', "Goal met after {0} of {1} turns", goal.turn, goal.maxTurns);
	} else if (goal.status === 'limit') {
		// The same sentence as the chat notice (issue 1117).
		detail = goalLimitSentence(goal, new Date(endedAt ?? Date.now()).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' }));
	} else if (goal.status === 'paused') {
		detail = localize('claudeTabGoalTipPaused', "Goal paused, turn {0} of {1}", goal.turn, goal.maxTurns);
	} else {
		detail = localize('claudeTabGoalTipTurn', "Goal: turn {0} of {1}", goal.turn, goal.maxTurns);
	}
	return worktree ? localize('claudeTabGoalTipWorktree', "{0}, runs in {1}", detail, worktree) : detail;
}

/**
 * The chat as an editor tab. It has no state of its own: the editor shows the
 * current session and the tab takes that session's title.
 */
export class ClaudeAgentEditorInput extends EditorInput {

	static readonly ID = 'workbench.input.claudeAgent';
	static readonly EDITOR_ID = 'workbench.editor.claudeAgent';

	/** True once the tab has shown 'Goal met', so the pill clears when the chat is next opened. */
	private _metShown = false;
	private readonly _hasGoal: IContextKey<boolean>;
	private readonly _goalRunning: IContextKey<boolean>;
	private readonly _goalPaused: IContextKey<boolean>;

	constructor(
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeGoalLoopService private readonly _goalLoop: IClaudeGoalLoopService,
		@IEditorService editors: IEditorService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this._hasGoal = CLAUDE_TAB_HAS_GOAL.bindTo(contextKeyService);
		this._goalRunning = CLAUDE_GOAL_RUNNING.bindTo(contextKeyService);
		this._goalPaused = CLAUDE_GOAL_PAUSED.bindTo(contextKeyService);
		this._register(this._agent.onDidChangeSession(() => this.refresh()));
		// A goal or loop on the chat shows as a pill on its tab (issue 888).
		this._register(this._goalLoop.onDidChange(() => this.refresh()));
		// A 'Goal met' pill goes once the tab has shown it and the chat is opened again (issue 1080).
		this._register(editors.onDidActiveEditorChange(() => {
			const sessionId = this._agent.getCurrentSession()?.id;
			if (sessionId && this._metShown && editors.activeEditor?.matches(this) && this._goalLoop.getGoal(sessionId)?.status === 'met') {
				this._metShown = false;
				this._goalLoop.stop(sessionId, 'goal');
			}
		}));
		this.refresh();
	}

	private refresh(): void {
		const sessionId = this._agent.getCurrentSession()?.id;
		const goal = sessionId ? this._goalLoop.getGoal(sessionId) : undefined;
		this._hasGoal.set(!!goal);
		this._goalRunning.set(goal?.status === 'running' || goal?.status === 'checking' || goal?.status === 'paused');
		this._goalPaused.set(goal?.status === 'paused');
		this._onDidChangeLabel.fire();
	}

	override get typeId(): string {
		return ClaudeAgentEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return ClaudeAgentEditorInput.EDITOR_ID;
	}

	override get resource(): URI {
		return CLAUDE_AGENT_EDITOR_RESOURCE;
	}

	override get capabilities(): EditorInputCapabilities {
		// One chat tab: opening it again reveals the tab wherever it is, even in another window.
		return EditorInputCapabilities.Singleton | EditorInputCapabilities.ForceReveal;
	}

	override getName(): string {
		return this._agent.getCurrentSession()?.title || localize('claudeAgentEditorName', "Agent");
	}

	override getDescription(): string | undefined {
		const sessionId = this._agent.getCurrentSession()?.id;
		if (!sessionId) {
			return undefined;
		}
		const goal = this._goalLoop.getGoal(sessionId);
		this._metShown = goal?.status === 'met';
		if (goal) {
			return goalPill(goal);
		}
		const loop = this._goalLoop.getLoop(sessionId);
		return loop ? localize('claudeTabLoopRuns', "Loop ×{0}", loop.runs) : undefined;
	}

	override getTitle(): string {
		const title = localize('claudeAgentEditorTitle', "Agent: {0}", this.getName());
		const session = this._agent.getCurrentSession();
		const goal = session ? this._goalLoop.getGoal(session.id) : undefined;
		return session && goal ? `${title}\n${goalTooltip(goal, worktreeName(session.worktreePath), this._goalLoop.getEnded(session.id)?.at)}` : title;
	}

	/** An ended goal shows on the tab as an icon too, so a truncated title still says it (issue 1102, DL-50). */
	override getIcon(): ThemeIcon {
		const sessionId = this._agent.getCurrentSession()?.id;
		const goal = sessionId ? this._goalLoop.getGoal(sessionId) : undefined;
		return goal && (goal.status === 'met' || goal.status === 'limit') ? goalIcon(goal) : Codicon.sparkle;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof ClaudeAgentEditorInput || super.matches(other);
	}
}

/** The goal of the current chat while it works, checks or is paused; an ended goal is not one to stop or edit. */
function activeGoal(accessor: ServicesAccessor): { readonly sessionId: string; readonly goal: ClaudeGoalView } | undefined {
	const sessionId = accessor.get(IClaudeAgentService).getCurrentSession()?.id;
	const goals = accessor.get(IClaudeGoalLoopService);
	const goal = sessionId ? goals.getGoal(sessionId) : undefined;
	return sessionId && goal && (goal.status === 'running' || goal.status === 'checking' || goal.status === 'paused') ? { sessionId, goal } : undefined;
}

/** Stops the current chat's goal and says so, or says why there is nothing to stop (issue 1116). */
function stopCurrentGoal(accessor: ServicesAccessor): void {
	const notifications = accessor.get(INotificationService);
	const active = activeGoal(accessor);
	if (!active) {
		notifications.info(localize('claudeNoGoalToStop', "This chat has no active goal. Use Start Goal to begin one."));
		return;
	}
	accessor.get(IClaudeGoalLoopService).stop(active.sessionId, 'goal');
	notifications.info(localize('claudeGoalStoppedNotice', "Goal stopped: {0}", active.goal.goal.outcome));
}

/** Resumes the current chat's paused goal and says so, or says why there is nothing to resume (issue 1139). */
async function resumeCurrentGoal(accessor: ServicesAccessor): Promise<void> {
	const notifications = accessor.get(INotificationService);
	const active = activeGoal(accessor);
	if (active?.goal.status !== 'paused') {
		notifications.info(localize('claudeNoGoalToResume', "This chat has no paused goal. Use Start Goal to begin one."));
		return;
	}
	await accessor.get(IClaudeGoalLoopService).resume(active.sessionId, 'goal');
	notifications.info(localize('claudeGoalResumedNotice', "Goal resumed: {0}", active.goal.goal.outcome));
}

/** Opens the composer on /goal with the current outcome and check filled in; sending it replaces the goal (issue 1116). */
function editCurrentGoal(accessor: ServicesAccessor): Promise<void> {
	// A goal that hit a limit can be edited too: the chat notice offers Edit Goal... (issue 1117).
	const sessionId = accessor.get(IClaudeAgentService).getCurrentSession()?.id;
	const ended = sessionId ? accessor.get(IClaudeGoalLoopService).getEnded(sessionId) : undefined;
	const goal = activeGoal(accessor)?.goal ?? (ended?.view.status === 'limit' ? ended.view : undefined);
	if (!goal) {
		accessor.get(INotificationService).info(localize('claudeNoGoalToEdit', "This chat has no active goal. Use Start Goal to begin one."));
		return Promise.resolve();
	}
	const { outcome, check } = goal.goal;
	return accessor.get(ICommandService).executeCommand(CLAUDE_START_GOAL_COMMAND_ID, check ? `${outcome} --check ${check}` : outcome);
}

// Stop Goal and Edit Goal sit in the chat tab's context menu (issue 1080).
const inChatTabWithGoal = ContextKeyExpr.and(ContextKeyExpr.equals('resourceScheme', CLAUDE_AGENT_EDITOR_RESOURCE.scheme), CLAUDE_TAB_HAS_GOAL);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CLAUDE_TAB_STOP_GOAL_COMMAND_ID,
			title: localize2('claudeTabStopGoal', "Stop Goal"),
			f1: false,
			menu: { id: MenuId.EditorTitleContext, group: '3_goal', order: 1, when: inChatTabWithGoal },
		});
	}
	run(accessor: ServicesAccessor): void {
		stopCurrentGoal(accessor);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CLAUDE_TAB_EDIT_GOAL_COMMAND_ID,
			title: localize2('claudeTabEditGoal', "Edit Goal..."),
			f1: false,
			menu: { id: MenuId.EditorTitleContext, group: '3_goal', order: 2, when: inChatTabWithGoal },
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return editCurrentGoal(accessor);
	}
});

// The same two jobs in the Command Palette, for the current chat; always listed, they say when there is no goal (issues 1099, 1116).
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CLAUDE_STOP_GOAL_COMMAND_ID,
			title: localize2('claudeStopGoal', "Stop Goal"),
			category: KLAWLY_CATEGORY,
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): void {
		stopCurrentGoal(accessor);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CLAUDE_EDIT_GOAL_COMMAND_ID,
			title: localize2('claudeEditGoal', "Edit Goal..."),
			category: KLAWLY_CATEGORY,
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return editCurrentGoal(accessor);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CLAUDE_RESUME_GOAL_COMMAND_ID,
			title: localize2('claudeResumeGoal', "Resume Goal"),
			category: KLAWLY_CATEGORY,
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return resumeCurrentGoal(accessor);
	}
});
