/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { match } from '../../../../base/common/glob.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase, isEqual, joinPath, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { BackgroundAgentTask } from '../../../../platform/claude/common/claudeBackground.js';
import { ClaudeAutomation, CLAUDE_AUTOMATION_DEFAULT_DEBOUNCE_MS, CLAUDE_AUTOMATION_DEFAULT_MAX_TURNS, CLAUDE_AUTOMATION_MEMORY_FILE_NAME, ClaudeAutomationMemory, claudeAutomationMemoryFolder, CLAUDE_AUTOMATIONS_ENABLED_SETTING, CLAUDE_AUTOMATIONS_FILE_NAME, CLAUDE_AUTOMATIONS_FOLDER, claudeAutomationAllows, claudeAutomationIdOfTask, claudeAutomationNextRun, claudeAutomationPrompt, ClaudeAutomationRun, claudeAutomationRunState, ClaudeAutomationEntry, ClaudeAutomationScope, claudeAutomationTaskId, ClaudeAutomationTriggerContext, readClaudeAutomationsFile, removeClaudeAutomation, writeClaudeAutomation } from '../../../../platform/claude/common/claudeAutomation.js';
import { CLAUDE_AUTOMATION_GITHUB_EVENTS_PER_RUN, CLAUDE_AUTOMATION_GITHUB_POLL_DEFAULT_MINUTES, CLAUDE_AUTOMATION_GITHUB_POLL_SETTING, claudeGitHubEventDetails, IClaudeGitHubApiService, isClaudeAutomationGitHubTrigger } from '../../../../platform/claude/common/claudeAutomationGitHub.js';
import { claudeOsWantedSchedules, ClaudeOsScheduleOwner, IClaudeOsScheduleService } from '../../../../platform/claude/common/claudeAutomationOsScheduleService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IPathService } from '../../path/common/pathService.js';
import { ITextFileService } from '../../textfile/common/textfiles.js';
import { IClaudeAgentService } from './claudeAgentService.js';
import { permissionsForTimeline } from './claudeAgentState.js';
import { ClaudeAutomationGitHubPoller } from './claudeAutomationGitHubPoller.js';
import { CLAUDE_AUTOMATION_HEARTBEAT_MS, CLAUDE_AUTOMATION_STATE_KEY_PREFIX, CLAUDE_AUTOMATION_USER_GROUP, ClaudeAutomationScheduler, claudeAutomationWorkspaceGroup } from './claudeAutomationScheduler.js';
import { IClaudeBackgroundAgentService } from './claudeBackgroundAgent.js';
import { IClaudePermissionService } from './claudePermissionService.js';

export const IClaudeAutomationService = createDecorator<IClaudeAutomationService>('claudeAutomationService');

/** Run Automation: picks an automation and starts it now. */
export const CLAUDE_RUN_AUTOMATION_COMMAND_ID = 'claude.automations.run';
/** Open Automations File: opens (and creates) the workspace or user `automations.json`. */
export const CLAUDE_OPEN_AUTOMATIONS_COMMAND_ID = 'claude.automations.open';

const MINUTE = 60 * 1000;

/** A run that had a request denied and waits for a person. */
export interface ClaudeAutomationNeedsYou {
	readonly automation: ClaudeAutomationEntry;
	readonly sessionId: string;
	readonly message: string;
}

/** One automation and what it last did. */
export interface ClaudeAutomationView {
	readonly automation: ClaudeAutomationEntry;
	readonly lastRun?: ClaudeAutomationRun;
	/** Next start of a schedule automation while automations are on. */
	readonly nextRunAt?: number;
}

/**
 * Automations (issue 426), phase 1: while Klawly is running, start a
 * background agent in its own worktree on a schedule, on a save, on a failed
 * task or test run, or from Run Now. A run never asks and waits: a request
 * its allow-list does not cover is denied and the run needs you. It never
 * applies its changes; they wait in the Background Agents view. One window
 * runs each group's schedules (see `ClaudeAutomationScheduler`).
 */
export interface IClaudeAutomationService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** A run had a request denied. The workbench tells the person (in the window, or an OS notification). */
	readonly onDidNeedYou: Event<ClaudeAutomationNeedsYou>;
	/** Workspace automations first, then the user's. */
	getAutomations(): readonly ClaudeAutomationView[];
	/** The automation that started a background task, or undefined. */
	automationOfTask(taskId: string): ClaudeAutomationEntry | undefined;
	/** True when the session's latest turn is an automation run's own, whose requests the run answers itself. */
	isUnattended(sessionId: string): boolean;
	/** Reads both `automations.json` files again. */
	reload(): Promise<void>;
	/** Starts a run now, whatever its trigger and even while automations are off. */
	run(key: string, context?: ClaudeAutomationTriggerContext): Promise<BackgroundAgentTask>;
	/** A failed task or test run, from the workbench. Starts the matching automations while they are on. */
	notifyFailure(trigger: 'onTaskFailed' | 'onTestFailed', failure: { readonly name?: string; readonly details: string }): void;
	/** `<workspace folder>/.klawly/automations.json` or `~/.klawly/automations.json`; undefined with no folder open. */
	fileFor(scope: ClaudeAutomationScope): Promise<URI | undefined>;
	/** Adds or replaces an automation in its file. `replaceId` renames one. */
	save(scope: ClaudeAutomationScope, automation: ClaudeAutomation, replaceId?: string): Promise<void>;
	/** Removes an automation from its file. */
	remove(key: string): Promise<void>;
	/** `~/.klawly/automations/<folder>/memory.md` of an automation (issue 518), whether or not it keeps one. */
	memoryFile(key: string): Promise<URI | undefined>;
	/** The automation's memory, or '' when it has none yet. */
	readMemory(key: string): Promise<string>;
	writeMemory(key: string, text: string): Promise<void>;
}

/** A run this window started, while its task exists. */
interface LiveRun {
	readonly automation: ClaudeAutomationEntry;
	readonly group: string;
	run: ClaudeAutomationRun;
	/**
	 * Each turn of the run's session, and whether the run's allow-list answers
	 * it. A turn that started while a person had the run open in the chat is
	 * theirs; every other turn (the first, a resumed or queued one) is the
	 * automation's, so its requests never wait for a person.
	 */
	readonly turns: Map<string, boolean>;
	/** Requests already answered for the run. */
	readonly answered: Set<string>;
	denied?: string;
	/** The automation's memory file, which the run may rewrite without asking. */
	readonly memoryPath?: string;
	/** The task has been seen, so its absence later means it was deleted. */
	seen: boolean;
}

/** A Write or Edit of the run's own memory file, which a run may always make. */
function isMemoryWrite(live: LiveRun, entry: { readonly toolName: string; readonly targetPath?: string; readonly risk?: string }): boolean {
	return !!live.memoryPath && !!entry.targetPath && entry.risk !== 'credentials' && ['Write', 'Edit', 'MultiEdit'].includes(entry.toolName)
		&& extUriBiasedIgnorePathCase.isEqual(URI.file(entry.targetPath), URI.file(live.memoryPath));
}

export class ClaudeAutomationService extends Disposable implements IClaudeAutomationService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidNeedYou = this._register(new Emitter<ClaudeAutomationNeedsYou>());
	readonly onDidNeedYou = this._onDidNeedYou.event;

	private _automations: readonly ClaudeAutomationEntry[] = [];
	private _userFile: URI | undefined;
	private readonly _scheduler: ClaudeAutomationScheduler;
	private readonly _live = new Map<string, LiveRun>();
	private readonly _saveTimers = this._register(new DisposableMap<string>());
	private readonly _savedPaths = new Map<string, Set<string>>();
	private readonly _tick = this._register(new RunOnceScheduler(() => this.tick(), MINUTE));
	private readonly _heartbeat = this._register(new RunOnceScheduler(() => this.heartbeat(), CLAUDE_AUTOMATION_HEARTBEAT_MS));
	private readonly _gitHub: ClaudeAutomationGitHubPoller;
	private readonly _gitHubPoll = this._register(new RunOnceScheduler(() => void this.pollGitHub(), MINUTE));
	/** GitHub errors already shown, so a poll that keeps failing tells the person once. */
	private readonly _gitHubErrors = new Set<string>();
	private _loaded: Promise<void> | undefined;
	/** The last wanted OS entries, so an unchanged reload does not call the scheduler again. */
	private _osScheduleKey: string | undefined;
	private readonly _osErrors = new Set<string>();

	constructor(
		@IClaudeBackgroundAgentService private readonly _background: IClaudeBackgroundAgentService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudePermissionService private readonly _permissions: IClaudePermissionService,
		@IFileService private readonly _files: IFileService,
		@IPathService private readonly _paths: IPathService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly _trust: IWorkspaceTrustManagementService,
		@ITextFileService private readonly _textFiles: ITextFileService,
		@IStorageService storage: IStorageService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@INotificationService private readonly _notifications: INotificationService,
		@ILogService private readonly _log: ILogService,
		@IClaudeGitHubApiService gitHubApi: IClaudeGitHubApiService,
		@IClaudeOsScheduleService private readonly _osSchedule: IClaudeOsScheduleService,
	) {
		super();
		this._scheduler = this._register(new ClaudeAutomationScheduler(generateUuid(), storage, () => Date.now()));
		this._gitHub = new ClaudeAutomationGitHubPoller(gitHubApi, () => Date.now());
		this._scheduler.setGroups(this.groups());
		this._register(this._background.onDidChangeTasks(() => this.syncRuns()));
		this._register(this._agent.onDidChangeViewState(() => this.syncRuns()));
		this._register(this._textFiles.files.onDidSave(event => this.onDidSave(event.model.resource)));
		this._register(this._files.onDidFilesChange(event => {
			const file = this.workspaceFile();
			if (file && event.contains(file)) {
				void this.reload();
			}
		}));
		this._register(this._trust.onDidChangeTrust(() => void this.reload()));
		this._register(this._workspace.onDidChangeWorkspaceFolders(() => {
			this._scheduler.setGroups(this.groups());
			void this.reload();
		}));
		this._register(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_AUTOMATIONS_ENABLED_SETTING)) {
				this._onDidChange.fire();
				void this.syncOsSchedule();
			}
			if (event.affectsConfiguration(CLAUDE_AUTOMATION_GITHUB_POLL_SETTING) && this._gitHubPoll.isScheduled()) {
				this._gitHubPoll.schedule(this.gitHubPollMs());
			}
		}));
		const listeners = this._register(new DisposableStore());
		this._register(storage.onDidChangeValue(StorageScope.APPLICATION, undefined, listeners)(event => {
			if (event.key.startsWith(CLAUDE_AUTOMATION_STATE_KEY_PREFIX)) {
				this._onDidChange.fire(); // A run or check from another window.
				return;
			}
			const group = this._scheduler.groupOfLeaseKey(event.key);
			if (group && storage.get(event.key, StorageScope.APPLICATION) === undefined) {
				// The runner window gave its lease up: claim it now rather than at the next heartbeat.
				this._scheduler.heartbeat([group]);
			}
		}));
		this._loaded = this.reload().then(() => {
			if (this._store.isDisposed) {
				return;
			}
			this.heartbeat();
			this._tick.schedule(MINUTE - Date.now() % MINUTE);
			this._gitHubPoll.schedule(this.gitHubPollMs());
		});
	}

	getAutomations(): readonly ClaudeAutomationView[] {
		const now = Date.now();
		return this._automations.map(automation => ({
			automation,
			lastRun: this._scheduler.getState(this.groupOf(automation)).runs?.[automation.key],
			nextRunAt: this.enabled() ? claudeAutomationNextRun(automation, now) : undefined,
		}));
	}

	automationOfTask(taskId: string): ClaudeAutomationEntry | undefined {
		const live = this._live.get(taskId);
		if (live) {
			return live.automation;
		}
		const id = claudeAutomationIdOfTask(taskId);
		return id === undefined ? undefined : this._automations.find(automation => automation.id === id);
	}

	isUnattended(sessionId: string): boolean {
		const task = this._background.getTasks().find(candidate => candidate.sessionId === sessionId);
		const live = task && this._live.get(task.id);
		const turn = live && this._agent.getViewState(sessionId).turns.at(-1);
		return !!turn && (live.turns.get(turn.id) ?? this._agent.getCurrentSession()?.id !== sessionId);
	}

	async reload(): Promise<void> {
		const workspace = this._trust.isWorkspaceTrusted() ? await this.readFile(this.workspaceFile(), 'workspace') : [];
		this._userFile = await this.fileFor('user');
		const user = await this.readFile(this._userFile, 'user');
		this._automations = [...workspace, ...user];
		this._onDidChange.fire();
		void this.syncOsSchedule();
	}

	/**
	 * Keeps the OS scheduler in step with the automations that opted in to run while Klawly is closed (issue 463).
	 * Skipped when nothing changed since the last sync; a failure is told once and never stops the reload.
	 */
	private async syncOsSchedule(): Promise<void> {
		const folder = this._workspace.getWorkspace().folders[0]?.uri.fsPath;
		const owners: ClaudeOsScheduleOwner[] = folder ? [{ scope: 'user' }, { scope: 'workspace', folder }] : [{ scope: 'user' }];
		const wanted = claudeOsWantedSchedules(this._automations, this.enabled(), folder);
		const key = JSON.stringify([owners, wanted]);
		if (key === this._osScheduleKey) {
			return;
		}
		this._osScheduleKey = key;
		try {
			for (const failure of await this._osSchedule.sync(owners, wanted)) {
				const text = localize('claudeAutomationOsFailed', "Could not schedule \"{0}\" to run when Klawly is closed: {1}", failure.id, failure.reason);
				if (this._osErrors.add(text)) {
					this._notifications.warn(text);
				}
			}
		} catch (error) {
			this._osScheduleKey = undefined;
			this._log.warn('Claude automations: the system scheduler could not be updated', error);
		}
	}

	async fileFor(scope: ClaudeAutomationScope): Promise<URI | undefined> {
		if (scope === 'workspace') {
			return this.workspaceFile();
		}
		return joinPath(await this._paths.userHome(), CLAUDE_AUTOMATIONS_FOLDER, CLAUDE_AUTOMATIONS_FILE_NAME);
	}

	async save(scope: ClaudeAutomationScope, automation: ClaudeAutomation, replaceId?: string): Promise<void> {
		await this.editFile(scope, file => writeClaudeAutomation(file, automation, replaceId));
	}

	async remove(key: string): Promise<void> {
		const automation = this._automations.find(candidate => candidate.key === key);
		if (automation) {
			await this.editFile(automation.scope, file => removeClaudeAutomation(file, automation.id));
		}
	}

	async run(key: string, context?: ClaudeAutomationTriggerContext): Promise<BackgroundAgentTask> {
		await this._loaded;
		const automation = this._automations.find(candidate => candidate.key === key);
		if (!automation) {
			throw new Error(localize('claudeAutomationMissing', "That automation is no longer in automations.json."));
		}
		const taskId = claudeAutomationTaskId(automation.id, generateUuid().slice(0, 8));
		const memory = automation.memory ? await this.prepareMemory(automation) : undefined;
		const live: LiveRun = {
			automation,
			group: this.groupOf(automation),
			run: { automationKey: key, taskId, trigger: context?.trigger ?? 'manual', startedAt: Date.now(), state: 'running', ...(context?.missedWhileClosed ? { missedWhileClosed: true } : {}) },
			turns: new Map(),
			answered: new Set(),
			memoryPath: memory?.path,
			seen: false,
		};
		// Known before the start, so a request asked during it is answered by this run's rules.
		this._live.set(taskId, live);
		this.record(live);
		try {
			return await this._background.start(claudeAutomationPrompt(automation, context, memory), {
				taskId,
				title: context?.missedWhileClosed
					? localize('claudeAutomationMissedRunTitle', "{0} (automation, missed while closed)", automation.name)
					: localize('claudeAutomationRunTitle', "{0} (automation)", automation.name),
				modelId: automation.model,
				effort: automation.effort,
				maxBudgetUsd: automation.budgetUsd,
				maxTurns: automation.maxTurns ?? CLAUDE_AUTOMATION_DEFAULT_MAX_TURNS,
				mode: automation.permissionMode,
				select: false,
			});
		} catch (error) {
			this._live.delete(taskId);
			live.run = { ...live.run, state: 'failed', message: error instanceof Error ? error.message : String(error) };
			this.record(live);
			throw error;
		}
	}

	notifyFailure(trigger: 'onTaskFailed' | 'onTestFailed', failure: { readonly name?: string; readonly details: string }): void {
		if (!this.enabled()) {
			return;
		}
		for (const automation of this._automations) {
			const matches = automation.enabled && automation.trigger.type === trigger
				&& (automation.trigger.type !== 'onTaskFailed' || !automation.trigger.task || automation.trigger.task === failure.name);
			if (matches) {
				this.start(automation, { trigger, details: failure.details });
			}
		}
	}

	/** Answers what each run asked, from its allow-list, and keeps its state up to date. */
	private syncRuns(): void {
		const tasks = this._background.getTasks();
		for (const [taskId, live] of this._live) {
			const task = tasks.find(candidate => candidate.id === taskId);
			if (!task) {
				if (live.seen) {
					// Deleted from Background Agents.
					this._live.delete(taskId);
					if (live.run.state === 'running') {
						live.run = { ...live.run, state: 'stopped' };
						this.record(live);
					}
				}
				continue; // Otherwise not added yet: the start is still creating the worktree.
			}
			live.seen = true;
			this.answer(live, task.sessionId);
			const state = claudeAutomationRunState(task, live.denied !== undefined);
			if (state !== live.run.state) {
				const message = state === 'needsYou' ? localize('claudeAutomationNeedsYou', "Needs approval for {0}. Open the run to continue.", live.denied) : undefined;
				live.run = { ...live.run, state, message };
				this.record(live);
				if (state === 'needsYou') {
					this._onDidNeedYou.fire({ automation: live.automation, sessionId: task.sessionId, message: message ?? '' });
				}
			}
		}
	}

	/**
	 * Decides every pending request in the run's own turns, subagents
	 * included: an allowed tool is allowed once, anything else is denied.
	 * Nothing in those turns is left waiting for a person.
	 */
	private answer(live: LiveRun, sessionId: string): void {
		const view = this._agent.getViewState(sessionId);
		for (const turn of view.turns) {
			if (!live.turns.has(turn.id)) {
				live.turns.set(turn.id, this._agent.getCurrentSession()?.id !== sessionId);
			}
			if (!live.turns.get(turn.id)) {
				continue;
			}
			for (const entry of permissionsForTimeline(turn, view.subagents, undefined)) {
				if (entry.state !== 'pending' || live.answered.has(entry.id)) {
					continue;
				}
				live.answered.add(entry.id);
				const allowed = isMemoryWrite(live, entry) || claudeAutomationAllows(live.automation.allowedTools, entry);
				if (!allowed && !live.denied) {
					live.denied = entry.command ?? entry.targetPath ?? entry.toolName;
				}
				this._permissions.respond(sessionId, entry.id, allowed ? 'allow-once' : 'deny').catch(error => this._log.warn('[claude] automation could not answer a request', error));
			}
		}
	}

	/** Starts a run unless the automation is still running one. False when it was skipped. */
	private start(automation: ClaudeAutomationEntry, context: ClaudeAutomationTriggerContext): boolean {
		// One run at a time per automation in this window: a trigger while one works is dropped.
		const tasks = this._background.getTasks();
		const busy = [...this._live].some(([taskId, live]) => {
			const task = tasks.find(candidate => candidate.id === taskId);
			return live.automation.key === automation.key && (!task ? !live.seen : !task.stopped && task.status !== 'complete' && task.status !== 'failed');
		});
		if (busy) {
			this._log.info(`[claude] automation ${automation.key} is still running; ${context.trigger} skipped`);
			return false;
		}
		this.run(automation.key, context).catch(error => {
			this._notifications.error(localize('claudeAutomationStartFailed', "{0} could not start: {1}", automation.name, error instanceof Error ? error.message : String(error)));
		});
		return true;
	}

	/**
	 * Polls the GitHub triggers of the groups this window runs (issue 518) and
	 * starts each automation with the events that wait for it. Events that come
	 * while a run works wait for the next poll after it ends.
	 */
	private async pollGitHub(): Promise<void> {
		try {
			const automations = this.enabled() ? this._automations.filter(automation => isClaudeAutomationGitHubTrigger(automation.trigger) && this._scheduler.holds(this.groupOf(automation))) : [];
			for (const result of await this._gitHub.poll(automations)) {
				if (result.error) {
					this._log.warn(`[claude] automation ${result.automation.key} could not read GitHub: ${result.error}`);
					if (!this._gitHubErrors.has(result.error)) {
						this._gitHubErrors.add(result.error);
						this._notifications.warn(localize('claudeAutomationGitHubFailed', "{0} could not read GitHub through the GitHub CLI: {1}", result.automation.name, result.error));
					}
				}
				const events = result.pending.slice(0, CLAUDE_AUTOMATION_GITHUB_EVENTS_PER_RUN);
				if (events.length && !this._store.isDisposed && this.start(result.automation, { trigger: result.automation.trigger.type, details: claudeGitHubEventDetails(events), github: events })) {
					this._gitHub.consume(result.automation.key, events.length);
				}
			}
		} finally {
			if (!this._store.isDisposed) {
				this._gitHubPoll.schedule(this.gitHubPollMs());
			}
		}
	}

	private gitHubPollMs(): number {
		const minutes = this._configuration.getValue<number>(CLAUDE_AUTOMATION_GITHUB_POLL_SETTING);
		return (typeof minutes === 'number' && minutes >= 1 ? minutes : CLAUDE_AUTOMATION_GITHUB_POLL_DEFAULT_MINUTES) * MINUTE;
	}

	async memoryFile(key: string): Promise<URI | undefined> {
		const automation = this._automations.find(candidate => candidate.key === key);
		if (!automation) {
			return undefined;
		}
		const folder = claudeAutomationMemoryFolder(automation, this._workspace.getWorkspace().folders[0]?.uri.toString());
		return joinPath(await this._paths.userHome(), CLAUDE_AUTOMATIONS_FOLDER, 'automations', folder, CLAUDE_AUTOMATION_MEMORY_FILE_NAME);
	}

	async readMemory(key: string): Promise<string> {
		const file = await this.memoryFile(key);
		try {
			return file ? (await this._files.readFile(file)).value.toString() : '';
		} catch {
			return ''; // No memory yet.
		}
	}

	async writeMemory(key: string, text: string): Promise<void> {
		const file = await this.memoryFile(key);
		if (!file) {
			throw new Error(localize('claudeAutomationMissing', "That automation is no longer in automations.json."));
		}
		await this._files.writeFile(file, VSBuffer.fromString(text));
	}

	/** The memory a run gets. The file is made when missing, so the run can rewrite it. */
	private async prepareMemory(automation: ClaudeAutomationEntry): Promise<ClaudeAutomationMemory | undefined> {
		const file = await this.memoryFile(automation.key);
		if (!file) {
			return undefined;
		}
		let text = '';
		try {
			text = (await this._files.readFile(file)).value.toString();
		} catch {
			await this._files.writeFile(file, VSBuffer.fromString(''));
		}
		return { path: file.fsPath, text };
	}

	private onDidSave(resource: URI): void {
		if (this.isAutomationsFile(resource)) {
			void this.reload();
			return;
		}
		const folder = this._workspace.getWorkspace().folders[0]?.uri;
		const path = folder ? relativePath(folder, resource) : undefined;
		if (!path || !this.enabled()) {
			return;
		}
		for (const automation of this._automations) {
			if (!automation.enabled || automation.trigger.type !== 'onSave' || !match(automation.trigger.glob, path)) {
				continue;
			}
			const paths = this._savedPaths.get(automation.key) ?? new Set<string>();
			paths.add(path);
			this._savedPaths.set(automation.key, paths);
			const handle = setTimeout(() => {
				this._saveTimers.deleteAndDispose(automation.key);
				const saved = [...this._savedPaths.get(automation.key) ?? []];
				this._savedPaths.delete(automation.key);
				this.start(automation, { trigger: 'onSave', details: localize('claudeAutomationSaved', "Saved: {0}", saved.join(', ')) });
			}, automation.trigger.debounceMs ?? CLAUDE_AUTOMATION_DEFAULT_DEBOUNCE_MS);
			this._saveTimers.set(automation.key, toDisposable(() => clearTimeout(handle)));
		}
	}

	/** Renews this window's leases; checks a group's schedules at once when this window just became its runner. */
	private heartbeat(): void {
		for (const group of this._scheduler.heartbeat()) {
			this.checkSchedules([group]);
		}
		// Up to a quarter more at random, so windows that opened together do not claim in step.
		this._heartbeat.schedule(CLAUDE_AUTOMATION_HEARTBEAT_MS * (1 + Math.random() / 4));
	}

	/** Each whole minute: the schedules that fell due in the groups this window runs. */
	private tick(): void {
		this.checkSchedules(this.groups());
		this._tick.schedule(MINUTE - Date.now() % MINUTE);
	}

	/**
	 * Starts what fell due. An automation that fell due while Klawly was closed
	 * runs once, marked "missed while closed", however many slots it missed
	 * (issue 463). Only the window that holds the group's lease gets a check
	 * result, and `start` skips an automation that is already running, so the
	 * catch-up happens once. It goes through the same allow-list and worktree as
	 * any run, and a run that needs a person notifies them.
	 */
	private checkSchedules(groups: readonly string[]): void {
		for (const group of groups) {
			const automations = this._automations.filter(automation => this.groupOf(automation) === group);
			const check = this._scheduler.check(group, automations, this.enabled());
			for (const automation of check.run) {
				this.start(automation, { trigger: 'schedule' });
			}
			for (const automation of check.missed) {
				this.start(automation, { trigger: 'schedule', missedWhileClosed: true });
			}
		}
	}

	private enabled(): boolean {
		return this._configuration.getValue<boolean>(CLAUDE_AUTOMATIONS_ENABLED_SETTING) === true;
	}

	/** The user's group, and the first workspace folder's when one is open. */
	private groups(): string[] {
		const folder = this._workspace.getWorkspace().folders[0]?.uri;
		return folder ? [CLAUDE_AUTOMATION_USER_GROUP, claudeAutomationWorkspaceGroup(folder.toString())] : [CLAUDE_AUTOMATION_USER_GROUP];
	}

	private groupOf(automation: ClaudeAutomationEntry): string {
		const folder = this._workspace.getWorkspace().folders[0]?.uri;
		return automation.scope === 'workspace' && folder ? claudeAutomationWorkspaceGroup(folder.toString()) : CLAUDE_AUTOMATION_USER_GROUP;
	}

	private workspaceFile(): URI | undefined {
		const folder = this._workspace.getWorkspace().folders[0]?.uri;
		return folder ? joinPath(folder, CLAUDE_AUTOMATIONS_FOLDER, CLAUDE_AUTOMATIONS_FILE_NAME) : undefined;
	}

	private isAutomationsFile(resource: URI): boolean {
		return isEqual(resource, this.workspaceFile()) || isEqual(resource, this._userFile);
	}

	private async readFile(file: URI | undefined, scope: ClaudeAutomationScope): Promise<readonly ClaudeAutomationEntry[]> {
		if (!file) {
			return [];
		}
		let text: string;
		try {
			text = (await this._files.readFile(file)).value.toString();
		} catch {
			return []; // No file: no automations.
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			this._notifications.warn(localize('claudeAutomationsBadJson', "{0} is not valid JSON, so its automations are off.", file.fsPath));
			return [];
		}
		const result = readClaudeAutomationsFile(parsed, scope);
		if (result.skipped.length) {
			this._notifications.warn(localize('claudeAutomationsSkipped', "Skipped automations in {0}: {1}. Check their fields.", file.fsPath, result.skipped.join(', ')));
		}
		return result.automations;
	}

	/** Reads the scope's file (none yet: empty), applies `edit` and writes it back. A file that is not JSON is left alone. */
	private async editFile(scope: ClaudeAutomationScope, edit: (file: unknown) => unknown): Promise<void> {
		const file = await this.fileFor(scope);
		if (!file) {
			throw new Error(localize('claudeAutomationNoFolder', "Open a folder to keep workspace automations."));
		}
		let parsed: unknown = {};
		if (await this._files.exists(file)) {
			try {
				parsed = JSON.parse((await this._files.readFile(file)).value.toString());
			} catch {
				throw new Error(localize('claudeAutomationsBadJsonEdit', "{0} is not valid JSON. Fix it before editing automations here.", file.fsPath));
			}
		}
		await this._files.writeFile(file, VSBuffer.fromString(`${JSON.stringify(edit(parsed), undefined, '\t')}\n`));
		await this.reload();
	}

	private record(live: LiveRun): void {
		this._scheduler.record(live.group, live.run);
		this._onDidChange.fire();
	}
}
