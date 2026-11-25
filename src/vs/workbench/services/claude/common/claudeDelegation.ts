/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { dirname as pathDirname } from '../../../../base/common/path.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ClaudeSessionMessageRequest, IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { CLAUDE_AUTO_ENABLED_SETTING, CLAUDE_AUTO_REUSE_HELPERS_SETTING, CLAUDE_DELEGATION_ENABLED_SETTING, readClaudeAutoReuseHelpers, readClaudeDelegationEnabled } from '../../../../platform/claude/common/claudeConfiguration.js';
import { UsageInfo } from '../../../../platform/claude/common/claudeProtocol.js';
import { claudeDelegateArgsProblem, ClaudeDelegateToolRequest, ClaudeDelegateToolResult } from '../../../../platform/claude/common/claudeDelegate.js';
import { ClaudeDelegateTier, claudeDelegateBudgetNotice, claudeDelegateBudgetState, claudeDelegateContractProblem, claudeDelegateContractPrompt, claudeDelegateReport, hasClaudeDelegateContract } from '../../../../platform/claude/common/claudeDelegateContract.js';
import { claudeAutoReviewHandoffMessage, formatClaudeAutoReviewLogLine, nextClaudeAutoReviewStep, readClaudeAutoReviewMaxRounds } from '../../../../platform/claude/common/claudeAutoReviewRounds.js';
import { addDecisionTokens, CLAUDE_DELEGATION_TIER_MODEL_SETTINGS, ClaudeDelegateDecision, ClaudeDelegateRoute, ClaudeDelegateRunTokens, ClaudeDelegationTierModels, formatDecisionLogLine, pickReusableHelper, readClaudeDelegationTierModel, routeAutoStep, routeDelegateTier } from '../../../../platform/claude/common/claudeDelegateTier.js';
import { CLAUDE_WORKER_PROFILE_SETTING, readClaudeWorkerProfile } from '../../../../platform/claude/common/claudeWorkerProfile.js';
import { CLAUDE_DELEGATION_LADDER_DEFAULTS, CLAUDE_DELEGATION_WORKER_FAILED_CALLS_SETTING, ClaudeEscalation, climbClaudeDelegateLadder, countTrailingFailedCalls, formatEscalationLogLine, readClaudeDelegationLadderThreshold, reachedClaudeLadderThreshold } from '../../../../platform/claude/common/claudeDelegateLadder.js';
import { ClaudeAutoComplexity, estimateClaudeAutoComplexity } from '../../../../platform/claude/common/claudeAutoModel.js';
import { claudeAutoReport, ClaudeAutoTaskEntry, claudeCiWaitOutcome, parseClaudeAutoTaskLog, upsertClaudeAutoTaskLine } from '../../../../platform/claude/common/claudeAutoTaskLog.js';
import { CLAUDE_DELEGATION_COST_WATCHER_CADENCE_SETTING, CLAUDE_DELEGATION_COST_WATCHER_ENABLED_SETTING, CLAUDE_DELEGATION_COST_WATCHER_REFUSE_SETTING, claudeCostWatcherDelegated, claudeCostWatcherJudgePrompt, claudeCostWatcherNudge, claudeCostWatcherReasonAccepted, claudeCostWatcherRefusal, claudeCostWatcherRejected, claudeCostWatcherVerdict, ClaudeCostWatchState, formatCostWatchLogLine, newClaudeCostWatchState, parseClaudeKeepReason, readClaudeCostWatcherSettings, stepClaudeCostWatcher } from '../../../../platform/claude/common/claudeDelegateCostWatcher.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { hasPendingElicitation } from './claudeAgentState.js';
import { claudeModelDisplayName } from '../../../../platform/claude/common/claudeModels.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { CLAUDE_DELEGATE_HELPER_WORKTREES_SETTING, claudeDelegateWorktreeId, readClaudeDelegateHelperWorktrees, ClaudeDelegateScheduler, claudeDelegateDepthLimit, readClaudeDelegateCodingCap, CLAUDE_DELEGATE_CODING_CAP_SETTING, CLAUDE_DELEGATE_DEPTH_HARD_MAX, CLAUDE_DELEGATE_DEPTH_SETTING } from '../../../../platform/claude/common/claudeDelegateScheduler.js';
import { backgroundBranchName, backgroundWorktreePath, IClaudeWorktreeService } from '../../../../platform/claude/common/claudeBackground.js';
import { CLAUDE_GIT_BRANCH_PREFIX_SETTING, readClaudeBranchPrefix } from '../../../../platform/claude/common/claudeGitSettings.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IClaudeAgentService } from './claudeAgentService.js';
import { ClaudeDelegateCard, claudeDelegateTitle, ClaudeDelegateRequest, claudeEscalationSentence } from './claudeDelegationModel.js';
import { ClaudeWorkerRunPatch, IClaudeWorkerRegistry, workerUsagePatch } from './claudeWorkerRegistry.js';

export const IClaudeDelegationService = createDecorator<IClaudeDelegationService>('claudeDelegationService');

/** The question a Stop on a delegate card asks in the top-level chat (issue 693). */
export interface ClaudeDelegateQuestion {
	readonly rootSessionId: string;
	/** The card whose Stop asked it. */
	readonly cardId: string;
	/** The chat's own model, which Yes keeps. */
	readonly modelLabel: string;
}

/**
 * Delegation (issue 693): runs delegated chats for Auto and for Claude's
 * `klawly_delegate` tool, tracks their cards, and handles Stop.
 *
 * Stop on a card stops that delegated chat and every chat under it. When the
 * top-level chat runs on Auto, it pauses and asks once whether to switch from
 * Auto to its own model: Yes turns Auto off and nothing is delegated after;
 * No keeps Auto, the chat goes on, and the card offers Rerun, which never runs
 * by itself.
 */
/** A delegated chat's link to its parent chat and what it cost on its own. */
export interface ClaudeCostNode {
	readonly sessionId: string;
	readonly parentSessionId: string;
	readonly costUsd?: number;
}

/**
 * What the chats under `rootSessionId` cost on their own, nested ones included (issue 848).
 * Undefined when none reported a cost. A chat is counted once, and a loop in the links ends.
 */
export function claudeDescendantCost(rootSessionId: string, nodes: readonly ClaudeCostNode[]): number | undefined {
	let total: number | undefined;
	const seen = new Set<string>([rootSessionId]);
	const queue = [rootSessionId];
	while (queue.length) {
		const parent = queue.shift()!;
		for (const node of nodes) {
			if (node.parentSessionId !== parent || seen.has(node.sessionId)) {
				continue;
			}
			seen.add(node.sessionId);
			queue.push(node.sessionId);
			if (node.costUsd !== undefined) {
				total = (total ?? 0) + node.costUsd;
			}
		}
	}
	return total;
}

/** A chat's own cost plus every descendant's: the number the cost guard (issue 1218) reads. */
export function claudeRolledUpCost(rootSessionId: string, ownCostUsd: number | undefined, nodes: readonly ClaudeCostNode[]): number | undefined {
	const delegated = claudeDescendantCost(rootSessionId, nodes);
	return ownCostUsd === undefined && delegated === undefined ? undefined : (ownCostUsd ?? 0) + (delegated ?? 0);
}

/** Every chat under `rootSessionId`, nested ones included, once each. A loop in the links ends (issue 1240). */
export function claudeDescendants(rootSessionId: string, nodes: readonly { readonly sessionId: string; readonly parentSessionId: string }[]): string[] {
	const found: string[] = [];
	const seen = new Set<string>([rootSessionId]);
	const queue = [rootSessionId];
	while (queue.length) {
		const parent = queue.shift()!;
		for (const node of nodes) {
			if (node.parentSessionId === parent && !seen.has(node.sessionId)) {
				seen.add(node.sessionId);
				queue.push(node.sessionId);
				found.push(node.sessionId);
			}
		}
	}
	return found;
}

/** In Auto, a helper the approach picker leaves to the chat's own model (large) runs on Sonnet (medium) instead (issue 848). */
export function claudeAutoHelperTier(picked: ClaudeDelegateTier | undefined, freeTool: boolean): ClaudeDelegateTier {
	return picked ?? (freeTool ? 'small' : 'medium');
}

export interface IClaudeDelegationService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	delegate(request: ClaudeDelegateRequest): Promise<ClaudeDelegateToolResult>;
	/** A card by id, with its nested cards. */
	getCard(cardId: string): ClaudeDelegateCard | undefined;
	/** The card of a delegated chat, by the delegated chat's session id. */
	getCardForChild(childSessionId: string): ClaudeDelegateCard | undefined;
	/** Stop on a card. */
	stop(cardId: string): Promise<void>;
	/** The open question of a top-level chat. */
	getQuestion(rootSessionId: string): ClaudeDelegateQuestion | undefined;
	/** `switchModel` true is Yes: Auto off, the chat keeps its model. */
	answer(rootSessionId: string, switchModel: boolean): void;
	/**
	 * Sends the task again to the top-level chat as a new message. Resolves false when the card cannot be sent again.
	 * A stopped card offers it after the user kept Auto; a failed card always does (issue 1220).
	 * `modelId` sends the message on that model for this turn only, such as Retry on Opus.
	 */
	rerun(cardId: string, options?: { readonly modelId?: string }): Promise<boolean>;
	/**
	 * Sends a message to a worker's own chat (issue 841). It is queued while the worker is busy and starts a new turn when the worker
	 * has finished, which resumes it. Resolves false when the card has no chat to send to.
	 */
	message(cardId: string, text: string): Promise<boolean>;
	/** What the chats a chat delegated to cost, nested ones included. Undefined when none reported a cost. */
	getDelegatedCost(sessionId: string): number | undefined;
	/** The chat's own cost plus everything under it, for the cost pill and the cost guard. Undefined when nothing reported a cost. */
	getRolledUpCost(sessionId: string): number | undefined;
	/** The top-level chat above a delegated chat, or the chat itself. */
	getRoot(sessionId: string): string;
	/** The Auto report, as markdown, read from the local Auto log (issue 849). */
	readAutoReport(): Promise<string>;
}

interface LiveDelegate {
	card: ClaudeDelegateCard;
	readonly resolve: (result: ClaudeDelegateToolResult) => void;
	readonly store: DisposableStore;
	/** The answer waits until the top-level chat's question is answered. */
	waitsForQuestion?: string;
	held?: ClaudeDelegateToolResult;
	/** The model alias the worker runs by now, once it moved up a tier. */
	alias?: string;
	/** Calls the worker had made when it last moved up: only later ones count toward the next move. */
	callsAtEscalation?: number;
	/** A move is being applied. */
	escalating?: boolean;
	/** The worker was told it reached 80% of its budget. */
	noticed?: boolean;
	/** The worker was stopped at 100% of its budget. */
	budgetStopped?: boolean;
	/** The turn that delegated was still running when this worker started (issue 1238). */
	parentTurnRunning?: boolean;
	/** That turn ended while this worker still ran: its report needs a new turn (issue 1238). */
	parentTurnEnded?: boolean;
	/** The worktree this coding helper works in (issue 1397). */
	worktree?: { readonly repo: string; readonly path: string; readonly branch: string; readonly base: string };
}

/** What the local Auto log counts for one top-level chat between writes (issue 849). */
interface ClaudeAutoTaskTally {
	readonly models: string[];
	compactions: number;
	retries: number;
	ciFirstTry?: 'pass' | 'fail';
	asked?: boolean;
	/** The last line written, without its time, so an unchanged chat is not written again. */
	written?: string;
}

/** The follow-up turn that hands a chat the reports of the workers that finished after its turn ended. One turn holds all of them. */
export function claudeDelegateFollowUpText(reports: readonly { readonly title: string; readonly state: string; readonly text?: string }[]): string {
	const lines = reports.map(report => `- ${report.title} (${report.state}): ${report.text?.trim() || localize('claudeDelegateNoReport', "no report")}`);
	return [localize('claudeDelegateFollowUp', "The chats you delegated to have finished. Continue with their results:"), ...lines].join('\n');
}

export class ClaudeDelegationService extends Disposable implements IClaudeDelegationService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _live = new Map<string, LiveDelegate>();
	private _logQueue: Promise<void> = Promise.resolve();
	private readonly _byChild = new Map<string, string>();
	/** Rework rounds sent to each helper chat (issue 1219). */
	private readonly _reworks = new Map<string, number>();
	private readonly _questions = new Map<string, ClaudeDelegateQuestion>();
	/** Top-level chats where the user answered Yes: nothing is delegated there again. */
	private readonly _declined = new Set<string>();
	/** Cost watcher state per top-level chat (issue 847). */
	private readonly _costWatch = new Map<string, ClaudeCostWatchState>();
	/** Finished background cards per parent chat, waiting to go to it in one follow-up turn (issue 1238). */
	private readonly _pendingReports = new Map<string, ClaudeDelegateCard[]>();
	/** Keep reasons already judged, per chat, so one reason is judged once. */
	private readonly _judgedReasons = new Map<string, string>();
	/** What each top-level Auto chat did so far, for the local Auto log (issue 849). */
	private readonly _autoTasks = new Map<string, ClaudeAutoTaskTally>();
	/** Helpers a stop is already stopping, so a nested one is stopped once (issue 1240). */
	private readonly _stopping = new Set<string>();

	/** Holds helpers back when a repository already has its cap of them working, or another helper owns the same files (issue 842). */
	private readonly _scheduler = new ClaudeDelegateScheduler(() => readClaudeDelegateCodingCap(this._configuration.getValue(CLAUDE_DELEGATE_CODING_CAP_SETTING)));

	constructor(
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IClaudeWorkerRegistry private readonly _registry: IClaudeWorkerRegistry,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IFileService private readonly _files: IFileService,
		@IEnvironmentService private readonly _environment: IEnvironmentService,
		@IClaudeWorktreeService private readonly _worktrees: IClaudeWorktreeService,
	) {
		super();
		this._register(this._scheduler.onDidChange(() => this.showQueue()));
		if (this._agent.setDelegateHandler) {
			this._register(this._agent.setDelegateHandler({
				delegate: request => this.delegate(request),
				stopUnder: (sessionId, closing) => this.stopUnder(sessionId, closing),
			}));
		}
		const onRequest = this._runtime.onDidRequestDelegate;
		if (onRequest) {
			this._register(onRequest(request => void this.handleToolRequest(request)));
		}
		const onMessage = this._runtime.onDidRequestSessionMessage;
		if (onMessage) {
			this._register(onMessage(message => void this.handleSessionMessage(message)));
		}
		this._register(this._agent.onDidChangeViewState(event => {
			this.watchCost(event.sessionId);
			this.watchParentTurn(event.sessionId);
			this.recordAutoTask(this.getRoot(event.sessionId));
		}));
		this._register(this._runtime.onDidEmitEvent(event => {
			if (event.type === 'session.compacted' && !event.parentRunId) {
				const owner = this.ownerOf(event.sessionId);
				if (owner) {
					this.autoTally(this.getRoot(owner)).compactions++;
				}
			}
		}));
		this._register({ dispose: () => this.disposeLive() });
	}

	/** A background tool such as `ci_wait` finished: its result goes into the chat that started it (issue 844). */
	private async handleSessionMessage(message: ClaudeSessionMessageRequest): Promise<void> {
		const owner = this._agent.getSessions().find(session => this._agent.getRuntimeSessionId(session.id) === message.sessionId);
		if (!owner) {
			// Another window owns the session: it answers.
			return;
		}
		const outcome = claudeCiWaitOutcome(message.text);
		const tally = outcome ? this.autoTally(this.getRoot(owner.id)) : undefined;
		if (tally && !tally.ciFirstTry) {
			tally.ciFirstTry = outcome;
		}
		const cwd = this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.fsPath ?? '';
		try {
			// The chat is usually still finishing its turn, so a running chat takes it as the next message.
			if (this._agent.getViewState(owner.id).turns.at(-1)?.status === 'running') {
				await this._agent.queue(owner.id, message.text, cwd, 'queue');
			} else {
				await this._agent.submit(owner.id, message.text, cwd, { keepDraft: true });
			}
		} catch {
			// The chat closed meanwhile; the result is still in the log file the message names.
		}
	}

	/** Notes that a chat's delegating turn ended while its workers ran, and sends reports that waited for it to end. */
	private watchParentTurn(sessionId: string): void {
		const turns = this._agent.getViewState(sessionId).turns;
		for (const live of this._live.values()) {
			if (live.card.parentSessionId !== sessionId || live.card.state !== 'running' || !live.parentTurnRunning || live.parentTurnEnded) {
				continue;
			}
			const turn = turns.find(candidate => candidate.id === live.card.parentTurnId);
			if (turn && turn.status !== 'running') {
				live.parentTurnEnded = true;
			}
		}
		if (this._pendingReports.has(sessionId)) {
			void this.sendReports(sessionId);
		}
	}

	/**
	 * Once the chat is idle and none of its workers still run, sends it the finished reports as ONE new turn.
	 * Nothing is sent after the user stopped the chat (`stopUnder` clears the list).
	 */
	private async sendReports(parentId: string): Promise<void> {
		const pending = this._pendingReports.get(parentId);
		const parent = this._agent.getSessions().find(session => session.id === parentId);
		if (!pending?.length || !parent) {
			this._pendingReports.delete(parentId);
			return;
		}
		const turns = this._agent.getViewState(parentId).turns;
		const last = turns[turns.length - 1];
		if (last?.status === 'running' || [...this._live.values()].some(live => live.card.parentSessionId === parentId && live.card.state === 'running')) {
			return;
		}
		this._pendingReports.delete(parentId);
		if (last?.status === 'stopped') {
			return;
		}
		const text = claudeDelegateFollowUpText(pending.map(card => ({ title: card.title, state: card.state, text: card.result ?? card.message })));
		const cwd = this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.fsPath ?? '';
		try {
			await this._agent.submit(parentId, text, cwd, { keepDraft: true });
		} catch {
			// The chat closed meanwhile.
		}
	}

	async delegate(request: ClaudeDelegateRequest): Promise<ClaudeDelegateToolResult> {
		const parent = this._agent.getSessions().find(session => session.id === request.parentSessionId);
		const problem = claudeDelegateArgsProblem(request) ?? claudeDelegateContractProblem(request);
		if (!parent || !this._agent.createDelegatedSession) {
			return { kind: 'failed', message: localize('claudeDelegateClosed', "The chat that delegated is closed.") };
		}
		if (problem) {
			return { kind: 'failed', message: problem };
		}
		const root = this.getRoot(parent.id);
		if (this._declined.has(root)) {
			return { kind: 'failed', message: localize('claudeDelegateDeclined', "The user switched this chat from Auto to its own model, so it does not delegate any more.") };
		}
		const depthLimit = claudeDelegateDepthLimit(this._configuration.getValue(CLAUDE_DELEGATE_DEPTH_SETTING), request.reason);
		if (this.depth(parent.id) >= depthLimit) {
			return { kind: 'failed', message: localize('claudeDelegateTooDeep', "Delegated chats nest at most {0} levels deep. Give a reason to go deeper, up to {1}.", depthLimit, CLAUDE_DELEGATE_DEPTH_HARD_MAX) };
		}
		this.costWatcherDelegated(parent.id);
		const route = await this.route(request, parent.modelId ?? parent.modelName);
		const model = await this.resolveModel(route.modelAlias, parent.modelId, parent.modelName);
		const tier = route.tier;
		const cardId = generateUuid();
		void this.logDecision({ time: Date.now(), tier, requestedTier: request.tier, reason: request.reason?.trim() || undefined, model: model.modelId ?? model.label, why: route.why, classifierSkipped: route.classifierSkipped, runId: cardId });
		// Auto adds the last exchanges ahead of the message; the title and the delegated chat show only the message.
		const title = claudeDelegateTitle(request.prompt ?? request.task, request.title ?? request.name);
		let child;
		const reusable = this.reusableHelper(root, tier);
		if (reusable && (reusable.title === title || (request.task !== undefined && reusable.task === request.task))) {
			// Sending a finished helper more work is one rework round after the parent's review (issue 1219). A different task is plain reuse and resets the count.
			const maxRounds = readClaudeAutoReviewMaxRounds(key => this._configuration.getValue(key));
			const round = (this._reworks.get(reusable.childSessionId) ?? 0) + 1;
			const next = nextClaudeAutoReviewStep(round - 1, { verdict: 'changes', openPoints: (reusable.result ?? '').split(/\r?\n/).slice(0, 5) }, maxRounds);
			void this.logLine(formatClaudeAutoReviewLogLine({ time: Date.now(), sessionId: parent.id, round, maxRounds, next: next.kind }));
			if (next.kind === 'handToUser') {
				return { kind: 'failed', message: claudeAutoReviewHandoffMessage(maxRounds, next.openPoints) };
			}
			this._reworks.set(reusable.childSessionId, round);
		} else if (reusable) {
			this._reworks.delete(reusable.childSessionId);
		}
		const reused = reusable ? this._agent.getSessions().find(session => session.id === reusable.childSessionId) : undefined;
		try {
			child = reused ?? this._agent.createDelegatedSession(parent.id, { modelId: model.modelId, modelName: model.label, effort: request.effort, title, profile: request.profile ?? readClaudeWorkerProfile(this._configuration.getValue(CLAUDE_WORKER_PROFILE_SETTING)) });
		} catch (error) {
			return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
		}
		const turns = this._agent.getViewState(parent.id).turns;
		const card: ClaudeDelegateCard = {
			id: cardId,
			parentSessionId: parent.id,
			parentTurnId: request.parentTurnId ?? turns[turns.length - 1]?.id ?? '',
			childSessionId: child.id,
			task: request.task,
			...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
			title,
			...(model.modelId !== undefined ? { modelId: model.modelId } : {}),
			modelLabel: model.label,
			...(request.effort !== undefined ? { effort: request.effort } : {}),
			auto: request.auto,
			...(request.objective?.trim() ? { objective: request.objective.trim() } : {}),
			...(request.acceptance?.trim() ? { acceptance: request.acceptance.trim() } : {}),
			...(tier !== undefined ? { tier } : {}),
			...(route.reason ? { routeReason: route.reason } : {}),
			routeWhy: route.why,
			...(request.budget && (request.budget.calls || request.budget.usd) ? { budget: request.budget } : {}),
			state: 'running',
			children: [],
			startedAt: Date.now(),
		};
		const store = new DisposableStore();
		const answer = new Promise<ClaudeDelegateToolResult>(resolve => {
			this._live.set(card.id, { card, resolve, store, parentTurnRunning: turns.find(turn => turn.id === card.parentTurnId)?.status === 'running' });
		});
		this._byChild.set(child.id, card.id);
		// A card is its own run, under the run of the card the delegating chat sits in.
		const parentCardId = this._byChild.get(parent.id);
		this._registry.create({
			id: card.id,
			parentId: parentCardId && this._live.has(parentCardId) ? parentCardId : undefined,
			ownerSessionId: parent.id,
			name: title,
			kind: 'delegate',
			model: model.label,
			effort: request.effort,
			tier,
			template: request.template,
			objective: card.objective,
			acceptance: card.acceptance,
			budgetUsd: request.budget?.usd,
			budgetCalls: request.budget?.calls,
			state: 'working',
		});
		store.add(this._agent.onDidChangeViewState(event => {
			if (event.sessionId === child.id) {
				this.check(card.id);
			}
		}));
		this.publish(card.id);
		const cwd = this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.fsPath ?? '';
		try {
			// A coding helper works in its own worktree, so it never waits on another helper's files (issue 1397).
			const worktree = await this.addHelperWorktree(card.id, cwd, request.files);
			const live = this._live.get(card.id);
			if (worktree && live) {
				live.worktree = worktree;
			}
			const workDir = worktree?.path ?? cwd;
			// A helper starts when its repository has a free slot and no running helper owns its files; until then it shows as queued.
			const started = await this._scheduler.acquire({ id: card.id, repo: cwd, files: request.files, ownWorktree: !!worktree });
			if (!started || this._live.get(card.id)?.card.state !== 'running') {
				this._scheduler.release(card.id);
				void this.removeHelperWorktree({ worktree });
				return answer;
			}
			if (worktree) {
				this._agent.pinWorkingDirectory(child.id, worktree.path);
			}
			if (reused) {
				// The helper keeps its model; its old conversation is compacted before the new task.
				await this._agent.submit(child.id, '/compact', workDir, { keepDraft: true });
			}
			// The helper gets the chips and images the delegating message was sent with.
			const attachments = this._agent.getSentAttachments(parent.id);
			await this._agent.submit(child.id, claudeDelegateContractPrompt(request.task, request), workDir, { keepDraft: true, ...(attachments.length ? { attachments } : {}), ...(request.prompt !== undefined ? { label: request.prompt } : {}) });
		} catch (error) {
			this.finish(card.id, 'failed', undefined, error instanceof Error ? error.message : String(error));
		}
		return answer;
	}

	/**
	 * Adds a worktree for a helper that owns files (issue 1397), or returns nothing when the setting is off,
	 * the helper owns no files, or the folder is not a Git repository: the helper then works in the workspace.
	 */
	private async addHelperWorktree(cardId: string, repo: string, files: readonly string[] | undefined): Promise<LiveDelegate['worktree']> {
		if (!files?.length || !repo || !readClaudeDelegateHelperWorktrees(this._configuration.getValue(CLAUDE_DELEGATE_HELPER_WORKTREES_SETTING)) || !this._worktrees.head || !this._worktrees.add) {
			return undefined;
		}
		const id = claudeDelegateWorktreeId(cardId);
		const path = backgroundWorktreePath(pathDirname(this._environment.userRoamingDataHome.fsPath), repo, id);
		const branch = backgroundBranchName(id, readClaudeBranchPrefix(this._configuration.getValue(CLAUDE_GIT_BRANCH_PREFIX_SETTING)));
		try {
			const base = await this._worktrees.head(repo);
			await this._worktrees.add(repo, path, branch, base);
			return { repo, path, branch, base };
		} catch {
			// Not a repository, or Git refused: the helper works in the workspace and waits on overlapping files instead.
			return undefined;
		}
	}

	/** Removes a helper's worktree when it has no changes; one with changes stays for the user to review or merge. */
	private async removeHelperWorktree(live: Pick<LiveDelegate, 'worktree'>): Promise<void> {
		const worktree = live.worktree;
		if (!worktree) {
			return;
		}
		try {
			if (!await this._worktrees.hasChanges(worktree.path, worktree.base)) {
				await this._worktrees.remove(worktree.repo, worktree.path, worktree.branch);
			}
		} catch {
			// A worktree that cannot be checked stays on disk; Clean Up Worktrees lists it.
		}
	}

	/** The tier and model a task runs on: a named model or tier skips the classifier, otherwise Auto's classifier rates it. */
	/** The model alias a tier runs by, from Settings > Agents > Delegation. Empty is the delegating chat's model. */
	private tierAlias(tier: ClaudeDelegateTier): string {
		return readClaudeDelegationTierModel(tier, this._configuration.getValue(CLAUDE_DELEGATION_TIER_MODEL_SETTINGS[tier]));
	}

	/** The route, with the reason it was given or the classifier's, which the card shows (issue 987). */
	private async route(request: ClaudeDelegateRequest, parentModel: string | undefined): Promise<ClaudeDelegateRoute & { readonly reason?: string }> {
		const given = request.reason?.trim() || undefined;
		const models: ClaudeDelegationTierModels = { small: this.tierAlias('small'), medium: this.tierAlias('medium'), large: this.tierAlias('large') };
		const base = { tier: request.tier, reason: request.reason, model: request.model, orchestrates: request.orchestrates, parentModel, models };
		if (request.tier !== undefined || request.model?.trim()) {
			return { ...routeDelegateTier(base), reason: given };
		}
		const auto = this._configuration.getValue(CLAUDE_AUTO_ENABLED_SETTING) !== false;
		const cwd = this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.fsPath ?? '';
		let classified;
		try {
			classified = await this._runtime.classifyAutoModel?.({ id: generateUuid(), prompt: request.task, cwd, retry: false });
		} catch {
			classified = undefined;
		}
		const complexity = classified?.ok ? classified.complexity : estimateClaudeAutoComplexity({ prompt: request.task });
		const reason = classified?.ok ? classified.reason?.trim() || given : given;
		if (auto) {
			const stepRoute = this.autoStepTier(request, complexity, models);
			return { ...routeDelegateTier({ ...base, tier: stepRoute.tier, classifierReason: classified?.ok ? classified.reason : undefined }), why: stepRoute.why, reason };
		}
		return { ...routeDelegateTier({ ...base, complexity, classifierReason: classified?.ok ? classified.reason : undefined }), reason };
	}

	/**
	 * Auto mode (issue 1230): the delegated task is one plan step, routed by `routeAutoStep`.
	 * The strong model keeps judgment work, the medium tier builds, the small tier or a free tool does mechanical steps.
	 * A delegated job is never a short task, so it counts as at least 25 tool calls.
	 */
	private autoStepTier(request: ClaudeDelegateRequest, complexity: ClaudeAutoComplexity, models: ClaudeDelegationTierModels): { readonly tier: ClaudeDelegateTier; readonly why: string } {
		const step = { id: 'delegate', kind: complexity === 'simple' ? 'mechanical' as const : complexity === 'complex' ? 'judgment' as const : 'build' as const, toolCalls: Math.max(request.budget?.calls ?? 0, 25) };
		const route = routeAutoStep({ step, steps: [step], models });
		const tier: ClaudeDelegateTier = claudeAutoHelperTier(route.tier, route.freeTool);
		return { tier, why: `Auto: ${route.approach}, ${route.why}` };
	}

	/** An idle, finished helper of the tier in this chat's tree, when Auto may reuse it (issue 1230). */
	private reusableHelper(rootSessionId: string, tier: ClaudeDelegateTier | undefined): ClaudeDelegateCard | undefined {
		if (!tier || this._configuration.getValue(CLAUDE_AUTO_ENABLED_SETTING) === false || !readClaudeAutoReuseHelpers(this._configuration.getValue(CLAUDE_AUTO_REUSE_HELPERS_SETTING))) {
			return undefined;
		}
		const sessions = this._agent.getSessions();
		const helpers = [...this._live.values()]
			.map(live => live.card)
			// A card whose chat a newer card took over, or whose chat closed, is not offered.
			.filter(card => card.state === 'done' && card.tier && this._byChild.get(card.childSessionId) === card.id && sessions.some(session => session.id === card.childSessionId) && this.getRoot(card.parentSessionId) === rootSessionId)
			.map(card => ({
				id: card.id,
				tier: card.tier!,
				idle: this._agent.getViewState(card.childSessionId).turns.at(-1)?.status !== 'running',
				finished: true,
				// Every delegated chat of a window works in the same workspace folder.
				sameFolder: true,
				finishedAt: card.endedAt ?? 0,
			}));
		const pick = pickReusableHelper(tier, helpers);
		return pick ? [...this._live.values()].find(live => live.card.id === pick.id)?.card : undefined;
	}

	/** Appends one line to the decision log. A failure never fails the delegation. */
	private logDecision(entry: ClaudeDelegateDecision): Promise<void> {
		return this.logLine(formatDecisionLogLine(entry));
	}

	private logLine(line: string): Promise<void> {
		return this.editLog(lines => [...lines, line]);
	}

	/** Adds the tokens a delegated run used to the decision that started it (issue 987). */
	private logRunTokens(runId: string, usage: UsageInfo | undefined): Promise<void> {
		if (!usage) {
			return Promise.resolve();
		}
		const tokens: ClaudeDelegateRunTokens = { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0, cacheRead: usage.cacheReadTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0 };
		return this.editLog(lines => lines.map(line => addDecisionTokens(line, runId, tokens)));
	}

	/** Edits run one after another, so a run's tokens never land before its decision. */
	private editLog(edit: (lines: readonly string[]) => readonly string[]): Promise<void> {
		this._logQueue = this._logQueue.then(() => this.writeLog(edit));
		return this._logQueue;
	}

	private async writeLog(edit: (lines: readonly string[]) => readonly string[]): Promise<void> {
		try {
			const lines = edit(await this.readLog()).slice(-1000);
			await this._files.writeFile(this.logFile(), VSBuffer.fromString(lines.join('\n') + '\n'));
		} catch {
			// Logging is best effort.
		}
	}

	private logFile(): URI {
		return joinPath(dirname(this._environment.userRoamingDataHome), 'claude', 'delegation-decisions.jsonl');
	}

	private async readLog(): Promise<string[]> {
		try {
			return (await this._files.readFile(this.logFile())).value.toString().split('\n').filter(line => line.length > 0);
		} catch {
			// No log yet.
			return [];
		}
	}

	async readAutoReport(): Promise<string> {
		// Pending writes land first, so the report shows the chat that just finished.
		await this._logQueue;
		return claudeAutoReport(parseClaudeAutoTaskLog(await this.readLog()));
	}

	getCard(cardId: string): ClaudeDelegateCard | undefined {
		return this._live.has(cardId) ? this.view(cardId) : undefined;
	}

	getCardForChild(childSessionId: string): ClaudeDelegateCard | undefined {
		const id = this._byChild.get(childSessionId);
		return id ? this.getCard(id) : undefined;
	}

	async stop(cardId: string): Promise<void> {
		const live = this._live.get(cardId);
		if (!live || live.card.state !== 'running') {
			return;
		}
		const root = this.getRoot(live.card.parentSessionId);
		if (this._agent.getAutoModel(root) && !this._declined.has(root)) {
			// The question runs once, in the top-level chat, however deep the card is.
			if (!this._questions.has(root)) {
				this._questions.set(root, { rootSessionId: root, cardId, modelLabel: this.chatModelLabel(root) });
				this.autoTally(root).asked = true;
			}
			live.waitsForQuestion = root;
		}
		await this.stopTree(live);
		this._onDidChange.fire();
	}

	getQuestion(rootSessionId: string): ClaudeDelegateQuestion | undefined {
		return this._questions.get(rootSessionId);
	}

	answer(rootSessionId: string, switchModel: boolean): void {
		const question = this._questions.get(rootSessionId);
		if (!question) {
			return;
		}
		this._questions.delete(rootSessionId);
		if (switchModel) {
			this._declined.add(rootSessionId);
			this._agent.setAutoModel(rootSessionId, false);
		} else {
			const live = this._live.get(question.cardId);
			if (live) {
				live.card = { ...live.card, rerun: true };
				this.publish(live.card.id);
			}
		}
		this.release(rootSessionId);
		this._onDidChange.fire();
	}

	async rerun(cardId: string, options?: { readonly modelId?: string }): Promise<boolean> {
		const live = this._live.get(cardId);
		if (!live || !(live.card.rerun || live.card.state === 'failed')) {
			return false;
		}
		live.card = { ...live.card, rerun: false };
		this.publish(cardId);
		const root = this.getRoot(live.card.parentSessionId);
		this.autoTally(root).retries++;
		const text = live.card.prompt ?? live.card.task;
		const cwd = this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.fsPath ?? '';
		const busy = this._agent.getViewState(root).turns.at(-1)?.status === 'running';
		if (busy) {
			await this._agent.queue(root, text, cwd, 'queue');
		} else {
			await this._agent.submit(root, text, cwd, { keepDraft: true, ...(options?.modelId ? { modelId: options.modelId } : {}) });
		}
		return true;
	}

	async message(cardId: string, text: string): Promise<boolean> {
		const live = this._live.get(cardId);
		const body = text.trim();
		if (!live || !body) {
			return false;
		}
		const child = live.card.childSessionId;
		const cwd = this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.fsPath ?? '';
		if (this._agent.getViewState(child).turns.at(-1)?.status === 'running') {
			await this._agent.queue(child, body, cwd, 'queue');
		} else {
			await this._agent.submit(child, body, cwd, { keepDraft: true });
		}
		return true;
	}

	/** Claude called `klawly_message_helper` (issue 1380): the helper is a card of this chat, by id or title. */
	async messageHelper(ownerSessionId: string, helper: string, text: string): Promise<ClaudeDelegateToolResult> {
		const root = this.getRoot(ownerSessionId);
		const wanted = helper.trim().toLowerCase();
		const mine = [...this._live.values()].map(live => live.card).filter(card => this.getRoot(card.parentSessionId) === root);
		const card = mine.find(candidate => candidate.id === helper.trim()) ?? mine.find(candidate => candidate.title.toLowerCase() === wanted);
		if (!card) {
			return { kind: 'failed', message: `No helper of this chat matches "${helper}". Use the card id, its title or its name.` };
		}
		if (!await this.message(card.id, text)) {
			return { kind: 'failed', message: `The message to ${card.title} was empty.` };
		}
		return { kind: 'messaged', helper: card.title };
	}

	getDelegatedCost(sessionId: string): number | undefined {
		return claudeDescendantCost(sessionId, this.costNodes());
	}

	getRolledUpCost(sessionId: string): number | undefined {
		return claudeRolledUpCost(sessionId, this._agent.getViewState(sessionId).usage?.costUsd, this.costNodes());
	}

	private costNodes(): ClaudeCostNode[] {
		return [...this._live.values()].map(live => ({ sessionId: live.card.childSessionId, parentSessionId: live.card.parentSessionId, costUsd: live.card.costUsd }));
	}

	private ownerOf(runtimeSessionId: string): string | undefined {
		return this._agent.getSessions().find(session => this._agent.getRuntimeSessionId(session.id) === runtimeSessionId)?.id;
	}

	private autoTally(root: string): ClaudeAutoTaskTally {
		let tally = this._autoTasks.get(root);
		if (!tally) {
			tally = { models: [], compactions: 0, retries: 0 };
			this._autoTasks.set(root, tally);
		}
		return tally;
	}

	/**
	 * Writes a top-level Auto chat's line in the local Auto log once it is idle and none of its workers run (issue 849).
	 * The line is rewritten when the chat goes on; nothing leaves the machine.
	 */
	private recordAutoTask(root: string): void {
		const session = this._agent.getSessions().find(candidate => candidate.id === root);
		const auto = this._agent.getAutoModel(root);
		if (!session || session.delegatedFrom || !auto) {
			return;
		}
		const tally = this.autoTally(root);
		const picked = auto.last ? auto.last.modelName ?? auto.last.modelId : undefined;
		const cards = [...this._live.values()].map(live => live.card).filter(card => this.getRoot(card.parentSessionId) === root);
		for (const model of [picked, ...cards.map(card => card.modelLabel)]) {
			if (model && !tally.models.includes(model)) {
				tally.models.push(model);
			}
		}
		const view = this._agent.getViewState(root);
		if (!view.turns.length || view.turns.at(-1)?.status === 'running' || cards.some(card => card.state === 'running')) {
			return;
		}
		const tokens = [view.usage, ...cards.map(card => this._agent.getViewState(card.childSessionId).usage)]
			.reduce((sum, usage) => sum + (usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : 0), 0);
		const entry: Omit<ClaudeAutoTaskEntry, 'time'> = {
			sessionId: root,
			approach: cards.length ? 'delegated' : 'solo',
			models: [...tally.models],
			turns: view.turns.length,
			costUsd: this.getRolledUpCost(root),
			tokens,
			compactions: tally.compactions,
			retries: tally.retries,
			failures: view.turns.filter(turn => turn.status === 'failed').length + cards.filter(card => card.state === 'failed').length,
			stalls: view.turns.filter(turn => turn.status === 'stopped').length + cards.filter(card => card.state === 'stopped').length,
			escalations: cards.reduce((sum, card) => sum + (card.escalations?.length ?? 0), 0),
			ciFirstTry: tally.ciFirstTry,
			reviewRounds: cards.reduce((sum, card) => sum + (this._reworks.get(card.childSessionId) ?? 0), 0),
			asked: tally.asked,
		};
		const signature = JSON.stringify(entry);
		if (signature === tally.written) {
			return;
		}
		tally.written = signature;
		void this.editLog(lines => upsertClaudeAutoTaskLine(lines, { time: Date.now(), ...entry }));
	}

	getRoot(sessionId: string): string {
		const sessions = this._agent.getSessions();
		let current = sessionId;
		for (let hop = 0; hop <= CLAUDE_DELEGATE_DEPTH_HARD_MAX + 1; hop++) {
			const parent = sessions.find(session => session.id === current)?.delegatedFrom;
			if (!parent) {
				break;
			}
			current = parent;
		}
		return current;
	}

	/** Claude called `klawly_delegate` in a chat of this window. */
	private async handleToolRequest(request: ClaudeDelegateToolRequest): Promise<void> {
		const owner = this._agent.getSessions().find(session => this._agent.getRuntimeSessionId(session.id) === request.sessionId);
		if (!owner) {
			// Another window owns the session: it answers.
			return;
		}
		let result: ClaudeDelegateToolResult;
		try {
			result = request.messageHelper ? await this.messageHelper(owner.id, request.messageHelper.helper, request.messageHelper.text) : await this.delegate({ ...request, parentSessionId: owner.id, auto: false });
		} catch (error) {
			result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
		}
		await this._runtime.resolveDelegateRequest?.(request.sessionId, request.requestId, result);
	}

	/** A chat was stopped or closed: its delegated chats stop, without a question. */
	private stopUnder(sessionId: string, closing: boolean): void {
		this._pendingReports.delete(sessionId);
		if (this._questions.has(sessionId)) {
			this._questions.delete(sessionId);
			this.release(sessionId);
			this._onDidChange.fire();
		}
		for (const live of [...this._live.values()]) {
			if (live.card.parentSessionId !== sessionId) {
				continue;
			}
			if (live.card.state === 'running') {
				void this.stopTree(live);
			}
			if (closing) {
				this._agent.closeSession(live.card.childSessionId);
				this._byChild.delete(live.card.childSessionId);
				live.store.dispose();
				this._live.delete(live.card.id);
			}
		}
	}

	/** The folder a helper works in: its own worktree, or the nearest one up its parents. */
	private worktreeOf(sessionId: string): string | undefined {
		const sessions = this._agent.getSessions();
		let current = sessions.find(session => session.id === sessionId);
		for (let hop = 0; current && hop <= CLAUDE_DELEGATE_DEPTH_HARD_MAX + 1; hop++) {
			if (current.worktreePath) {
				return current.worktreePath;
			}
			const parent: string | undefined = current.delegatedFrom;
			current = parent ? sessions.find(session => session.id === parent) : undefined;
		}
		return undefined;
	}

	private async stopTree(live: LiveDelegate): Promise<void> {
		const childId = live.card.childSessionId;
		if (this._stopping.has(childId)) {
			return;
		}
		this._stopping.add(childId);
		live.card = { ...live.card, stoppedByUser: true };
		const folder = live.worktree?.path ?? this.worktreeOf(childId);
		if (folder && this._worktrees.wipCommit) {
			try {
				await this._worktrees.wipCommit(folder, localize('claudeDelegateWipCommit', "WIP: stopped helper {0}", live.card.title));
			} catch {
				// A folder that is not a repository, or a Git failure, never keeps the helper running.
			}
		}
		// The agent's Stop calls `stopUnder` for the delegated chat, which stops the chats under it.
		try {
			await this._agent.stop(childId);
		} finally {
			this._stopping.delete(childId);
		}
		if (live.card.state === 'running') {
			// It had not started a turn yet, so no turn ends it.
			this.finish(live.card.id, 'stopped');
		}
	}

	/** Ends a card when its delegated chat's turn ends. */
	private check(cardId: string): void {
		const live = this._live.get(cardId);
		if (!live || live.card.state !== 'running') {
			return;
		}
		const state = this._agent.getViewState(live.card.childSessionId);
		const turn = state.turns[state.turns.length - 1];
		if (!turn || turn.status === 'running') {
			const waiting = !!turn && (turn.permissions.some(permission => permission.state === 'pending') || hasPendingElicitation(turn));
			if (waiting !== !!live.card.waiting) {
				live.card = { ...live.card, waiting };
				this.publish(cardId);
			}
			const cost = state.usage?.costUsd;
			const calls = state.turns.reduce((sum, candidate) => sum + candidate.cards.length, 0);
			if ((cost !== undefined && cost !== live.card.costUsd) || (live.card.budget && calls !== live.card.callsUsed)) {
				live.card = { ...live.card, ...(cost !== undefined ? { costUsd: cost } : {}), ...(live.card.budget ? { callsUsed: calls } : {}) };
				this.publish(cardId);
			}
			this.enforceBudget(live, calls, cost ?? 0);
			this.escalate(live, state.turns.flatMap(candidate => candidate.cards));
			return;
		}
		if (state.usage?.costUsd !== undefined) {
			live.card = { ...live.card, costUsd: state.usage.costUsd };
		}
		switch (turn.status) {
			case 'complete':
				this.finish(cardId, 'done', turn.assistantText);
				break;
			case 'stopped':
				if (live.budgetStopped) {
					this.finish(cardId, 'failed', turn.assistantText, localize('claudeDelegateBudgetStop', "Stopped at its budget."));
					break;
				}
				this.finish(cardId, 'stopped');
				break;
			case 'failed':
				this.finish(cardId, 'failed', undefined, turn.failure?.message ?? localize('claudeDelegateFailed', "The delegated chat failed."));
				break;
			default:
				this.finish(cardId, 'stopped');
				break;
		}
	}

	/**
	 * Moves a struggling worker up one tier (issue 839): after the threshold of
	 * failed calls in a row it switches to the next tier's model, and the count
	 * starts again from there. Each move goes to the card, the worker registry
	 * and the decision log.
	 */
	private escalate(live: LiveDelegate, calls: readonly { readonly state: 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted' }[]): void {
		const threshold = readClaudeDelegationLadderThreshold(this._configuration.getValue(CLAUDE_DELEGATION_WORKER_FAILED_CALLS_SETTING), CLAUDE_DELEGATION_LADDER_DEFAULTS.workerFailedCalls);
		// Calls before the last move do not count again.
		const fresh = calls.slice(live.callsAtEscalation ?? 0);
		const failed = countTrailingFailedCalls(fresh);
		if (live.escalating || !reachedClaudeLadderThreshold(failed, threshold) || live.card.tier === undefined) {
			return;
		}
		const parent = this._agent.getSessions().find(session => session.id === live.card.parentSessionId);
		const currentAlias = live.alias ?? this.tierAlias(live.card.tier);
		const toTier = climbClaudeDelegateLadder(live.card.tier, currentAlias, tier => this.tierAlias(tier));
		if (!toTier) {
			return;
		}
		live.escalating = true;
		const fromLabel = live.card.modelLabel;
		const toAlias = this.tierAlias(toTier);
		void this.resolveModel(toAlias, parent?.modelId, parent?.modelName).then(async model => {
			if (!model.modelId || live.card.state !== 'running') {
				return;
			}
			await this._agent.setNextModel(live.card.childSessionId, model.modelId);
			const escalation: ClaudeEscalation = { time: Date.now(), from: fromLabel, to: model.label, fromTier: live.card.tier, toTier, cause: 'failed-calls', count: failed };
			live.alias = toAlias;
			live.callsAtEscalation = calls.length;
			live.card = { ...live.card, tier: toTier, modelId: model.modelId, modelLabel: model.label, escalations: [...(live.card.escalations ?? []), escalation] };
			this._registry.update(live.card.id, { tier: toTier, model: model.label, stateDetail: claudeEscalationSentence(escalation), escalations: live.card.escalations });
			void this.logLine(formatEscalationLogLine(escalation));
			this.publish(live.card.id);
		}).catch(() => undefined).finally(() => {
			live.escalating = false;
		});
	}

	/**
	 * Cost watcher (issue 847): counts a top-level chat's tool calls and queues a
	 * nudge to delegate, sooner the dearer each call is. Never on Haiku chats or
	 * delegated chats; with refusal on, refuses its calls after three ignored nudges.
	 */
	private watchCost(sessionId: string): void {
		const session = this._agent.getSessions().find(candidate => candidate.id === sessionId);
		if (!session || session.delegatedFrom || this._declined.has(sessionId) || !readClaudeDelegationEnabled(this._configuration.getValue(CLAUDE_DELEGATION_ENABLED_SETTING))) {
			return;
		}
		const settings = readClaudeCostWatcherSettings(
			this._configuration.getValue(CLAUDE_DELEGATION_COST_WATCHER_ENABLED_SETTING),
			this._configuration.getValue(CLAUDE_DELEGATION_COST_WATCHER_CADENCE_SETTING),
			this._configuration.getValue(CLAUDE_DELEGATION_COST_WATCHER_REFUSE_SETTING),
		);
		const state = this._agent.getViewState(sessionId);
		const calls = state.turns.reduce((sum, turn) => sum + turn.cards.length, 0);
		const previous = this._costWatch.get(sessionId);
		if (!previous) {
			// Calls made before the watcher first saw the chat (a restored chat) do not count.
			this._costWatch.set(sessionId, newClaudeCostWatchState(calls));
			return;
		}
		if (previous.refusing) {
			this._costWatch.set(sessionId, { ...previous, calls });
			if (!settings.enabled || !settings.refuse) {
				this.liftRefusal(sessionId, claudeCostWatcherReasonAccepted(previous));
			} else {
				void this.judgeKeepReason(sessionId, state.turns.at(-1)?.assistantText, state.turns.at(-1)?.cards.slice(-5).map(card => card.name) ?? []);
			}
			return;
		}
		const model = this._agent.getAutoModel(sessionId)?.last?.modelId ?? session.modelId ?? session.modelName;
		const step = stepClaudeCostWatcher(previous, { calls, model, contextTokens: state.usage?.contextTokens, settings });
		this._costWatch.set(sessionId, step.state);
		const action = step.action;
		if (action.kind === 'none') {
			return;
		}
		void this.logLine(formatCostWatchLogLine({ time: Date.now(), sessionId, decision: action.kind, model, interval: action.interval, callCostUsd: action.callCostUsd, ignored: action.ignored }));
		if (action.kind === 'nudge') {
			// Sent hidden: a queued message would show in the chat as if the user wrote it (issue 1256).
			void this._agent.remind(sessionId, claudeCostWatcherNudge(action.interval, action.callCostUsd)).catch(() => undefined);
		} else {
			this._judgedReasons.delete(sessionId);
			this.setRefusal(sessionId, claudeCostWatcherRefusal());
		}
	}

	/** Judges a refused chat's `Keep reason:` line with the router's cheap classifier. */
	private async judgeKeepReason(sessionId: string, text: string | undefined, recentTools: readonly string[]): Promise<void> {
		const reason = parseClaudeKeepReason(text);
		if (!reason || this._judgedReasons.get(sessionId) === reason) {
			return;
		}
		this._judgedReasons.set(sessionId, reason);
		const prompt = claudeCostWatcherJudgePrompt(reason, recentTools);
		const cwd = this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.fsPath ?? '';
		let complexity: ClaudeAutoComplexity;
		let classifierSkipped = false;
		try {
			const classified = await this._runtime.classifyAutoModel?.({ id: generateUuid(), prompt, cwd, retry: false });
			complexity = classified?.ok ? classified.complexity : estimateClaudeAutoComplexity({ prompt });
			classifierSkipped = !classified?.ok;
		} catch {
			complexity = estimateClaudeAutoComplexity({ prompt });
			classifierSkipped = true;
		}
		const current = this._costWatch.get(sessionId);
		if (!current?.refusing) {
			// It delegated while the judge ran.
			return;
		}
		const verdict = claudeCostWatcherVerdict(complexity);
		void this.logLine(formatCostWatchLogLine({ time: Date.now(), sessionId, decision: verdict, reason, complexity, classifierSkipped }));
		if (verdict === 'accepted') {
			this.liftRefusal(sessionId, claudeCostWatcherReasonAccepted(current));
		} else {
			this.setRefusal(sessionId, claudeCostWatcherRejected());
		}
	}

	/** The chat delegated: the watcher starts over and any refusal lifts. */
	private costWatcherDelegated(sessionId: string): void {
		const current = this._costWatch.get(sessionId);
		if (current) {
			this.liftRefusal(sessionId, claudeCostWatcherDelegated(current), current.refusing);
		}
	}

	private liftRefusal(sessionId: string, next: ClaudeCostWatchState, wasRefusing = true): void {
		this._costWatch.set(sessionId, next);
		this._judgedReasons.delete(sessionId);
		if (wasRefusing) {
			this.setRefusal(sessionId, undefined);
		}
	}

	private setRefusal(sessionId: string, message: string | undefined): void {
		const runtimeId = this._agent.getRuntimeSessionId(sessionId);
		if (runtimeId) {
			void this._runtime.setToolRefusal?.(runtimeId, message).catch(() => undefined);
		}
	}

	/** Tells the worker at 80% of its budget to wrap up, and stops it at 100%. */
	private enforceBudget(live: LiveDelegate, calls: number, costUsd: number): void {
		const budget = live.card.budget;
		const status = claudeDelegateBudgetState(budget, calls, costUsd);
		if (status === 'ok' || live.budgetStopped) {
			return;
		}
		const cwd = this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.fsPath ?? '';
		if (status === 'notice' && !live.noticed) {
			live.noticed = true;
			live.card = { ...live.card, budgetState: 'notice' };
			this.publish(live.card.id);
			void this._agent.queue(live.card.childSessionId, claudeDelegateBudgetNotice(), cwd, 'queue').catch(() => undefined);
		} else if (status === 'stop') {
			live.budgetStopped = true;
			live.card = { ...live.card, budgetState: 'stop' };
			this.publish(live.card.id);
			void this.stopTree(live);
		}
	}

	private finish(cardId: string, state: 'done' | 'stopped' | 'failed', result?: string, message?: string): void {
		const live = this._live.get(cardId);
		if (!live || live.card.state !== 'running') {
			return;
		}
		// A worker with a contract reports in at most 300 words, or says nothing with `[[quiet]]`.
		const contract = hasClaudeDelegateContract({ objective: live.card.objective, acceptance: live.card.acceptance, budget: live.card.budget });
		const report = contract && result !== undefined ? claudeDelegateReport(result) : undefined;
		if (report) {
			result = report.text || localize('claudeDelegateQuiet', "The delegated chat finished and had nothing to report.");
			live.card = { ...live.card, report: report.text, ...(report.quiet ? { quiet: true } : {}) };
		}
		this._scheduler.cancel(cardId);
		this._scheduler.release(cardId);
		void this.removeHelperWorktree(live);
		live.card = {
			...live.card,
			state,
			...(result !== undefined ? { result } : {}),
			...(message !== undefined ? { message } : {}),
			endedAt: Date.now(),
		};
		// Queued before `publish` fires its events, so a view-state change can't send the reports without this one.
		const parentTurn = this._agent.getViewState(live.card.parentSessionId).turns.find(turn => turn.id === live.card.parentTurnId);
		const queued = !!live.parentTurnRunning && (live.parentTurnEnded || parentTurn?.status !== 'running') && !live.card.stoppedByUser && state !== 'stopped' && !(live.waitsForQuestion && this._questions.has(live.waitsForQuestion));
		if (queued) {
			const list = this._pendingReports.get(live.card.parentSessionId) ?? [];
			list.push(live.card);
			this._pendingReports.set(live.card.parentSessionId, list);
		}
		live.store.clear();
		this.publish(cardId);
		void this.logRunTokens(cardId, this._agent.getViewState(live.card.childSessionId).usage);
		const view = this.view(cardId);
		const answer: ClaudeDelegateToolResult = state === 'done'
			? { kind: 'done', text: result ?? '', model: view.modelLabel, ...(view.costUsd !== undefined ? { costUsd: view.costUsd } : {}) }
			: state === 'failed' ? { kind: 'failed', message: message ?? '' } : { kind: 'stopped' };
		if (live.waitsForQuestion && this._questions.has(live.waitsForQuestion)) {
			// The top-level chat pauses until the user answers the question.
			live.held = answer;
			return;
		}
		live.resolve(answer);
		if (queued) {
			void this.sendReports(live.card.parentSessionId);
		}
	}

	/** Hands on the answers that waited for a top-level chat's question. */
	private release(rootSessionId: string): void {
		for (const live of this._live.values()) {
			if (live.waitsForQuestion !== rootSessionId) {
				continue;
			}
			live.waitsForQuestion = undefined;
			if (live.held) {
				const held = live.held;
				live.held = undefined;
				live.resolve(held);
			}
		}
	}

	/** Shows the card in its parent chat, and the new nesting and cost on every card above it. */
	private publish(cardId: string): void {
		this.mirrorRun(cardId);
		let id: string | undefined = cardId;
		for (let hop = 0; id && hop <= CLAUDE_DELEGATE_DEPTH_HARD_MAX + 1; hop++) {
			const live = this._live.get(id);
			if (!live) {
				break;
			}
			this._agent.noteDelegation?.(live.card.parentSessionId, this.view(id));
			id = this._byChild.get(live.card.parentSessionId);
		}
		this._onDidChange.fire();
	}

	/** Brings the card's run in the worker registry up to the card's state. Its cost is the chat's own: the registry adds nested runs. */
	private mirrorRun(cardId: string): void {
		const card = this._live.get(cardId)?.card;
		if (!card) {
			return;
		}
		const patch: ClaudeWorkerRunPatch = { ...workerUsagePatch(this._agent.getViewState(card.childSessionId).usage), ...card.costUsd !== undefined ? { costUsd: card.costUsd } : {} };
		switch (card.state) {
			case 'done':
				Object.assign(patch, { state: 'finished', report: card.result, endedAt: card.endedAt, ...(card.quiet ? { quiet: true } : {}) });
				break;
			case 'failed':
				Object.assign(patch, { state: 'failed', stateDetail: localize('claudeDelegateRunFailed', "failed: {0}", card.message ?? ''), endedAt: card.endedAt, ...(card.report !== undefined ? { report: card.report } : {}) });
				break;
			case 'stopped':
				Object.assign(patch, { state: 'stopped', endedAt: card.endedAt });
				break;
			default:
				Object.assign(patch, { state: 'working' });
				break;
		}
		this._registry.update(cardId, patch);
	}

	/** The card with its nested cards, and its cost with theirs. */
	private view(cardId: string): ClaudeDelegateCard {
		const live = this._live.get(cardId)!;
		const children = [...this._live.values()].filter(candidate => candidate.card.parentSessionId === live.card.childSessionId).map(candidate => this.view(candidate.card.id));
		let cost = live.card.costUsd;
		for (const child of children) {
			if (child.costUsd !== undefined) {
				cost = (cost ?? 0) + child.costUsd;
			}
		}
		return { ...live.card, children, ...(cost !== undefined ? { costUsd: cost } : {}) };
	}

	/** Marks the helpers the scheduler holds back as queued in the Workers view, with their place and why, and the others as working. */
	private showQueue(): void {
		const queued = new Map(this._scheduler.queued().map(item => [item.id, item]));
		for (const [cardId, live] of this._live) {
			if (live.card.state !== 'running') {
				continue;
			}
			const item = queued.get(cardId);
			if (item) {
				const detail = item.reason === 'files'
					? localize('claudeDelegateQueuedFiles', "Queued, number {0}: waiting for files another helper owns", item.position)
					: localize('claudeDelegateQueuedCap', "Queued, number {0}: this repository has its limit of helpers working", item.position);
				this._registry.update(cardId, { state: 'queued', stateDetail: detail });
			} else if (this._registry.get(cardId)?.state === 'queued') {
				this._registry.update(cardId, { state: 'working', stateDetail: undefined });
			}
		}
	}

	private depth(sessionId: string): number {
		const sessions = this._agent.getSessions();
		let depth = 0;
		let current: string | undefined = sessionId;
		while (current && depth <= CLAUDE_DELEGATE_DEPTH_HARD_MAX) {
			current = sessions.find(session => session.id === current)?.delegatedFrom;
			if (current) {
				depth++;
			}
		}
		return depth;
	}

	private chatModelLabel(sessionId: string): string {
		const session = this._agent.getSessions().find(candidate => candidate.id === sessionId);
		return session?.modelName ?? session?.modelId ?? localize('claudeDelegateChatModel', "This Chat's Model");
	}

	/** A model id or alias to the model id Claude reported and its name. */
	private async resolveModel(requested: string | undefined, parentModel: string | undefined, parentName: string | undefined): Promise<{ readonly modelId?: string; readonly label: string }> {
		const wanted = requested?.trim();
		if (!wanted) {
			return { modelId: parentModel, label: parentName ?? parentModel ?? localize('claudeDelegateChatModel', "This Chat's Model") };
		}
		const models = await this._runtime.listModels().catch(() => []);
		const lower = wanted.toLowerCase();
		const match = models.find(model => model.id === wanted)
			?? models.find(model => model.id.toLowerCase() === lower)
			?? models.find(model => model.id.toLowerCase().includes(lower) || claudeModelDisplayName(model).toLowerCase().includes(lower));
		return match ? { modelId: match.id, label: claudeModelDisplayName(match) } : { modelId: wanted, label: wanted };
	}

	private disposeLive(): void {
		for (const live of this._live.values()) {
			live.store.dispose();
			live.resolve(live.held ?? { kind: 'stopped' });
		}
		this._live.clear();
	}
}
