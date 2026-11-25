/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname, join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { applyBackgroundAgent, assertIsolatedWorktree, ClaudeBackgroundRunOptions, isBackgroundTaskId, BackgroundAgentStatus, BackgroundAgentTask, BackgroundApplyResult, BackgroundConflict, BackgroundFileChange, backgroundBranchName, backgroundWorktreePath, CLAUDE_MAX_PARALLEL_SESSIONS_SETTING, commandStatus, IClaudeWorktreeService, isActiveBackgroundStatus, isPathInside, normalizeRepoRoot, pathsInDiff, readMaxParallelSessions, resolveSafeChild } from '../../../../platform/claude/common/claudeBackground.js';
import { CLAUDE_GIT_BRANCH_PREFIX_SETTING, readClaudeBranchPrefix } from '../../../../platform/claude/common/claudeGitSettings.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { Schemas } from '../../../../base/common/network.js';
import { IEditorService } from '../../editor/common/editorService.js';
import { IClaudeAgentService } from './claudeAgentService.js';
import { claudeReviewOriginalUri, IClaudeReviewService, ReviewFileText } from './claudeReview.js';
import { ClaudeWorkerState, IClaudeWorkerRegistry, workerUsagePatch } from './claudeWorkerRegistry.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { CLAUDE_WORKTREE_SETUP_FILE, CLAUDE_WORKTREES_MAX_SETTING, readClaudeWorktreeSetup, readClaudeWorktreesMax } from '../../../../platform/claude/common/claudeWorktreeSetup.js';
import { OperatingSystem, OS } from '../../../../base/common/platform.js';

export const IClaudeBackgroundAgentService = createDecorator<IClaudeBackgroundAgentService>('claudeBackgroundAgentService');

export const IClaudeBackgroundPreview = createDecorator<IClaudeBackgroundPreview>('claudeBackgroundPreview');

export const BACKGROUND_APPLY_TURN_ID = 'background-apply';

/**
 * Start Background Agent. With a prompt argument it starts with that prompt and
 * throws on failure; without one it asks for the prompt. Registered only where
 * background agents run.
 */
export const CLAUDE_BACKGROUND_PROMPT_COMMAND_ID = 'klawly.background.start';

export interface IClaudeBackgroundPreview {
	readonly _serviceBrand: undefined;
	/**
	 * Opens the review diff. Does not write the workspace.
	 */
	show(sessionId: string, taskId: string, files: readonly BackgroundFileChange[]): Promise<boolean>;
	/**
	 * Shows the worktree patch in the review diff, then asks before anything
	 * is written to the workspace. Declining leaves the workspace alone.
	 */
	openExternalPatch(sessionId: string, taskId: string, files: readonly BackgroundFileChange[]): Promise<{ accepted: boolean }>;
}

export interface IClaudeBackgroundAgentService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeTasks: Event<void>;
	getTasks(): readonly BackgroundAgentTask[];
	maxParallelSessions(): number;
	canStart(): boolean;
	/**
	 * Creates `<prefix><id>` (`claude.git.branchPrefix`) at `<userData>/worktrees/<repo-hash>/<id>` and starts
	 * the Claude session with `cwd` set to that worktree. `options` set the
	 * task id, model, effort and spend cap of this run.
	 */
	start(prompt: string, options?: ClaudeBackgroundRunOptions): Promise<BackgroundAgentTask>;
	stop(taskId: string): Promise<void>;
	/**
	 * Removes the worktree, its branch and the session. A worktree with changes
	 * asks first, unless the caller already confirmed (`confirmed`).
	 */
	delete(taskId: string, options?: { readonly confirmed?: boolean }): Promise<void>;
	/** Deletes the finished agents with nothing left to apply (issue 511). */
	cleanUp(): Promise<{ readonly removed: number; readonly kept: number }>;
	/** Opens the review diff and does not apply it. */
	review(taskId: string): Promise<void>;
	/** Diff, then the review preview, then a three-way apply. */
	apply(taskId: string): Promise<BackgroundApplyResult>;
	openConflicts(taskId: string): Promise<void>;
}

interface MutableTask extends BackgroundAgentTask {
	conflicts: BackgroundConflict[];
}

export class ClaudeBackgroundPreview extends Disposable implements IClaudeBackgroundPreview {
	declare readonly _serviceBrand: undefined;

	constructor(
		private readonly _userDataPath: string,
		@IClaudeReviewService private readonly _review: IClaudeReviewService,
		@IDialogService private readonly _dialog: IDialogService,
		@IEditorService private readonly _editor: IEditorService,
		@IFileService private readonly _files: IFileService,
	) {
		super();
	}

	async show(sessionId: string, taskId: string, files: readonly BackgroundFileChange[]): Promise<boolean> {
		if (files.length === 0) {
			return false;
		}
		const previewRoot = join(this._userDataPath, 'worktrees', 'preview', taskId);
		const reviewFiles: ReviewFileText[] = [];
		for (const file of files) {
			const previewPath = resolveSafeChild(previewRoot, file.relativePath);
			const previewUri = URI.file(previewPath);
			await writeText(this._files, previewUri, file.modifiedText);
			reviewFiles.push({
				uri: previewUri,
				originalText: file.originalText,
				modifiedText: file.modifiedText,
				existed: file.existed,
			});
		}
		const review = this._review.replaceTurn(sessionId, BACKGROUND_APPLY_TURN_ID, reviewFiles);
		this._review.focus(sessionId, BACKGROUND_APPLY_TURN_ID);
		const first = review.files[0];
		if (!first) {
			return false;
		}
		await this._editor.openEditor({
			original: { resource: claudeReviewOriginalUri(first.uri, sessionId, BACKGROUND_APPLY_TURN_ID) },
			modified: { resource: first.uri },
			label: localize('claudeBackgroundReviewLabel', "{0} (background review)", first.name),
			options: { pinned: true },
		});
		return true;
	}

	async openExternalPatch(sessionId: string, taskId: string, files: readonly BackgroundFileChange[]): Promise<{ accepted: boolean }> {
		const shown = await this.show(sessionId, taskId, files);
		if (!shown) {
			return { accepted: false };
		}
		const result = await this._dialog.confirm({
			message: localize('claudeBackgroundApplyConfirm', "Apply these worktree changes to the workspace?"),
			detail: localize('claudeBackgroundApplyDetail', "The diff is open for review. Apply uses a three-way merge and does not copy the worktree over the workspace."),
			primaryButton: localize('claudeBackgroundApplyButton', "Apply"),
		});
		return { accepted: result.confirmed };
	}
}

export class ClaudeBackgroundAgentService extends Disposable implements IClaudeBackgroundAgentService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeTasks = this._register(new Emitter<void>());
	readonly onDidChangeTasks = this._onDidChangeTasks.event;

	private readonly _tasks: MutableTask[] = [];
	private _reserved = 0;

	constructor(
		private readonly _userDataPath: string,
		@IClaudeWorktreeService private readonly _git: IClaudeWorktreeService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeBackgroundPreview private readonly _preview: IClaudeBackgroundPreview,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IEditorService private readonly _editor: IEditorService,
		@IFileService private readonly _files: IFileService,
		@IDialogService private readonly _dialog: IDialogService,
		@IWorkspaceTrustManagementService private readonly _trust: IWorkspaceTrustManagementService,
		@IClaudeWorkerRegistry private readonly _registry: IClaudeWorkerRegistry,
	) {
		super();
		this._register(this._agent.onDidChangeViewState(({ sessionId }) => this.syncFromAgent(sessionId)));
		this._register(this._onDidChangeTasks.event(() => this.mirrorRuns()));
	}

	/** Keeps the worker registry in step. A multitask's own tasks are recorded under their multitask instead. */
	private mirrorRuns(): void {
		for (const task of this._tasks) {
			if (task.id.startsWith('multitask-')) {
				continue;
			}
			const id = `background-${task.id}`;
			this._registry.create({ id, ownerSessionId: task.sessionId, name: task.title, kind: 'background', model: '', repo: task.repoRoot, worktree: task.worktreePath });
			const state: ClaudeWorkerState = task.stopped ? 'stopped' : task.status === 'complete' ? 'finished' : task.status === 'failed' ? 'failed' : task.status === 'waiting' ? 'waiting' : 'working';
			this._registry.update(id, { state, name: task.title, ...workerUsagePatch(this._agent.getViewState(task.sessionId).usage), ...task.status === 'waiting' && !task.stopped ? { stateDetail: localize('claudeBackgroundRunWaiting', "waiting for you") } : { stateDetail: undefined } });
		}
	}

	getTasks(): readonly BackgroundAgentTask[] {
		return this._tasks.map(task => ({ ...task, conflicts: task.conflicts.slice() }));
	}

	maxParallelSessions(): number {
		return readMaxParallelSessions(this._configuration.getValue<number>(CLAUDE_MAX_PARALLEL_SESSIONS_SETTING));
	}

	canStart(): boolean {
		return this.activeCount() < this.maxParallelSessions();
	}

	async start(prompt: string, options?: ClaudeBackgroundRunOptions): Promise<BackgroundAgentTask> {
		const text = prompt.trim();
		if (!text) {
			throw new Error(localize('claudeBackgroundEmpty', "Write what the background agent should do."));
		}
		const title = options?.title?.trim() || text;
		const id = options?.taskId ?? generateUuid();
		if (!isBackgroundTaskId(id) || this._tasks.some(task => task.id === id)) {
			throw new Error(localize('claudeBackgroundBadId', "A background agent named {0} cannot start.", id));
		}
		const max = this.maxParallelSessions();
		if (this.activeCount() >= max) {
			throw new Error(localize('claudeBackgroundLimit', "Background agents are limited to {0} running at once.", max));
		}
		const repoRoot = this.repoRoot();
		// Issue 511: a cap on worktrees per repository, finished ones included, so they do not pile up.
		const maxWorktrees = readClaudeWorktreesMax(this._configuration.getValue(CLAUDE_WORKTREES_MAX_SETTING));
		if (this._tasks.filter(task => normalizeRepoRoot(task.repoRoot) === normalizeRepoRoot(repoRoot)).length >= maxWorktrees) {
			throw new Error(localize('claudeWorktreesLimit', "This repository has {0} background agent worktrees, the most allowed. Run Klawly: Clean Up Worktrees or delete an agent first.", maxWorktrees));
		}
		this._reserved++;
		let registered = false;
		let added = false;
		let worktreePath: string | undefined;
		let branchName: string | undefined;
		let baseRef: string | undefined;
		try {
			baseRef = await this._git.head(repoRoot);
			worktreePath = backgroundWorktreePath(this._userDataPath, repoRoot, id);
			branchName = backgroundBranchName(id, readClaudeBranchPrefix(this._configuration.getValue(CLAUDE_GIT_BRANCH_PREFIX_SETTING)));
			assertIsolatedWorktree(repoRoot, worktreePath, this._tasks.map(task => task.worktreePath));
			await this._git.add(repoRoot, worktreePath, branchName, baseRef);
			added = true;
			await this.setUpWorktree(repoRoot, worktreePath);
			const session = this._agent.createSession();
			this._agent.pinWorkingDirectory(session.id, worktreePath);
			try {
				await this.applyRunOptions(session.id, options);
			} catch (error) {
				this._agent.closeSession(session.id);
				throw error;
			}
			const task: MutableTask = {
				id,
				sessionId: session.id,
				repoRoot,
				baseRef,
				worktreePath,
				branchName,
				status: 'starting',
				title: title.length > 80 ? `${title.slice(0, 77)}...` : title,
				filesChanged: 0,
				added: 0,
				removed: 0,
				testStatus: 'tests not run',
				conflicts: [],
				stopped: false,
			};
			this._tasks.push(task);
			registered = true;
			// The task is active now. Drop the reservation so it is not counted twice.
			this._reserved--;
			this._onDidChangeTasks.fire();
			if (options?.select !== false) {
				this._agent.selectSession(session.id);
			}
			try {
				if (options?.compiled) {
					await this._agent.submit(session.id, text, worktreePath, { compiled: options.compiled });
				} else {
					await this._agent.submit(session.id, text, worktreePath);
				}
			} catch (error) {
				task.status = 'failed';
				this._onDidChangeTasks.fire();
				throw error;
			}
			if (task.status === 'starting') {
				task.status = 'running';
				this._onDidChangeTasks.fire();
			}
			return this.snapshot(task);
		} catch (error) {
			if (!registered) {
				this._reserved--;
			}
			if (added && worktreePath && branchName && baseRef) {
				await this.abandonFailedStart(registered, id, repoRoot, worktreePath, branchName, baseRef);
			}
			throw error;
		}
	}

	/**
	 * Issue 511: copies the files and runs the commands of a trusted project's
	 * `.klawly/worktree-setup.json` in the new worktree. A failing command stops the
	 * start with its output, so the agent never runs in a half-set-up worktree.
	 */
	private async setUpWorktree(repoRoot: string, worktreePath: string): Promise<void> {
		if (!this._git.setup || !this._trust.isWorkspaceTrusted()) {
			return;
		}
		let text: string;
		try {
			text = (await this._files.readFile(URI.file(join(repoRoot, CLAUDE_WORKTREE_SETUP_FILE)))).value.toString();
		} catch {
			return;
		}
		const setup = readClaudeWorktreeSetup(text, OS === OperatingSystem.Windows ? 'win32' : OS === OperatingSystem.Macintosh ? 'darwin' : 'linux');
		if (!setup) {
			return;
		}
		const result = await this._git.setup(repoRoot, worktreePath, setup);
		if (result.failed) {
			const output = result.commands.at(-1)?.output.trim().split(/\r?\n/).slice(-12).join('\n') ?? '';
			throw new Error(localize('claudeWorktreeSetupFailed', "Worktree setup failed at \"{0}\":\n{1}", result.failed, output));
		}
	}

	/**
	 * Klawly: Clean Up Worktrees (issue 511): deletes every background agent that
	 * finished with nothing left to apply, and keeps the ones with changes.
	 */
	async cleanUp(): Promise<{ readonly removed: number; readonly kept: number }> {
		let removed = 0;
		let kept = 0;
		for (const task of this._tasks.filter(candidate => !isActiveBackgroundStatus(candidate.status))) {
			let dirty = true;
			try {
				dirty = await this._git.hasChanges(task.worktreePath, task.baseRef);
			} catch {
				dirty = true;
			}
			if (dirty) {
				kept++;
				continue;
			}
			await this.delete(task.id, { confirmed: true });
			removed++;
		}
		return { removed, kept };
	}

	/** Model, effort and spend cap of one run, set before its first turn. */
	private async applyRunOptions(sessionId: string, options: ClaudeBackgroundRunOptions | undefined): Promise<void> {
		if (options?.modelId) {
			await this._agent.setNextModel(sessionId, options.modelId);
		}
		if (options?.effort) {
			await this._agent.setNextSettings(sessionId, { ...this._agent.getSessionSettings(sessionId), effort: options.effort });
		}
		if (options?.maxBudgetUsd !== undefined) {
			this._agent.setSessionBudget(sessionId, options.maxBudgetUsd);
		}
		if (options?.mode) {
			this._agent.setMode(sessionId, options.mode);
		}
		if (options?.maxTurns !== undefined) {
			this._agent.setSessionMaxTurns(sessionId, options.maxTurns);
		}
	}

	/**
	 * A failed start must not leave a card whose worktree was force-removed.
	 * An empty worktree is removed and the card goes with it. A worktree that
	 * already has changes stays, with its failed card, so Delete can confirm.
	 */
	private async abandonFailedStart(registered: boolean, id: string, repoRoot: string, worktreePath: string, branchName: string, baseRef: string): Promise<void> {
		let keep = false;
		try {
			keep = await this._git.hasChanges(worktreePath, baseRef);
		} catch {
			keep = false;
		}
		if (keep) {
			return;
		}
		let removed = false;
		try {
			await this._git.remove(repoRoot, worktreePath, branchName, true);
			removed = true;
		} catch (error) {
			// A worktree that is already gone is removed. Any other error leaves the card.
			removed = isAbsentWorktreeError(error);
		}
		if (!registered || !removed) {
			return;
		}
		const index = this._tasks.findIndex(task => task.id === id);
		if (index < 0) {
			return;
		}
		this._agent.closeSession(this._tasks[index].sessionId);
		this._tasks.splice(index, 1);
		this._onDidChangeTasks.fire();
	}

	async stop(taskId: string): Promise<void> {
		const task = this.require(taskId);
		task.stopped = true;
		task.status = 'failed';
		this._onDidChangeTasks.fire();
		await this._agent.stop(task.sessionId);
	}

	async delete(taskId: string, options?: { readonly confirmed?: boolean }): Promise<void> {
		const index = this._tasks.findIndex(task => task.id === taskId);
		if (index < 0) {
			return;
		}
		const task = this._tasks[index];
		let dirty = true;
		try {
			dirty = await this._git.hasChanges(task.worktreePath, task.baseRef);
		} catch {
			dirty = true;
		}
		if (dirty && !options?.confirmed) {
			const choice = await this._dialog.confirm({
				message: localize('claudeBackgroundDeleteConfirm', "Delete this background agent and its unapplied changes?"),
				detail: localize('claudeBackgroundDeleteDetail', "The worktree has changes that are not in the workspace. Deleting it removes that work."),
				primaryButton: localize('claudeBackgroundDeleteButton', "Delete"),
			});
			if (!choice.confirmed) {
				return;
			}
		}
		if (isActiveBackgroundStatus(task.status)) {
			task.stopped = true;
			await this._agent.stop(task.sessionId);
		}
		try {
			await this._git.remove(task.repoRoot, task.worktreePath, task.branchName, dirty);
		} catch (error) {
			if (!isAbsentWorktreeError(error)) {
				throw error;
			}
		}
		await this.deleteScratch(task.id);
		this._agent.closeSession(task.sessionId);
		this._tasks.splice(index, 1);
		this._onDidChangeTasks.fire();
	}

	async review(taskId: string): Promise<void> {
		const task = this.require(taskId);
		const files = await this.loadChanges(task);
		await this._preview.show(task.sessionId, task.id, files);
	}

	async apply(taskId: string): Promise<BackgroundApplyResult> {
		const task = this.require(taskId);
		const result = await applyBackgroundAgent({
			diff: () => this._git.diff(task.worktreePath, task.baseRef),
			openExternalPatch: async patch => {
				const files = await this.filesForPatch(task, patch);
				return this._preview.openExternalPatch(task.sessionId, task.id, files);
			},
			applyPatch: patch => this._git.applyThreeWay(task.repoRoot, patch),
			openConflicts: conflicts => this.presentConflicts(task, conflicts),
		});
		task.conflicts = result.conflicts.map(conflict => ({ ...conflict }));
		this._onDidChangeTasks.fire();
		return result;
	}

	async openConflicts(taskId: string): Promise<void> {
		const task = this.require(taskId);
		if (task.conflicts.length === 0) {
			return;
		}
		await this.presentConflicts(task, task.conflicts);
	}

	private activeCount(): number {
		return this._tasks.filter(task => isActiveBackgroundStatus(task.status)).length + this._reserved;
	}

	private repoRoot(): string {
		const folder = this._workspace.getWorkspace().folders.find(candidate => candidate.uri.scheme === Schemas.file);
		if (!folder) {
			throw new Error(localize('claudeBackgroundNoRepo', "Open a local folder before starting a background agent."));
		}
		return folder.uri.fsPath;
	}

	private require(taskId: string): MutableTask {
		const task = this._tasks.find(candidate => candidate.id === taskId);
		if (!task) {
			throw new Error(localize('claudeBackgroundMissing', "That background agent is no longer open."));
		}
		return task;
	}

	private async deleteScratch(taskId: string): Promise<void> {
		for (const name of ['preview', 'merge']) {
			try {
				await this._files.del(URI.file(join(this._userDataPath, 'worktrees', name, taskId)), { recursive: true });
			} catch {
				// The scratch folder is already gone.
			}
		}
	}

	private snapshot(task: MutableTask): BackgroundAgentTask {
		return { ...task, conflicts: task.conflicts.slice() };
	}

	private syncFromAgent(sessionId: string): void {
		const task = this._tasks.find(candidate => candidate.sessionId === sessionId);
		if (!task || task.stopped) {
			return;
		}
		const turns = this._agent.getViewState(sessionId).turns;
		const last = turns[turns.length - 1];
		if (!last) {
			return;
		}
		const pending = last.permissions.some(permission => permission.state === 'pending');
		let status: BackgroundAgentStatus = task.status;
		if (pending) {
			status = 'waiting';
		} else if (last.status === 'running') {
			status = 'running';
		} else if (last.status === 'complete') {
			status = 'complete';
		} else if (last.status === 'failed' || last.status === 'stopped') {
			status = 'failed';
			task.stopped = last.status === 'stopped';
		}
		task.status = status;
		task.testStatus = commandStatus(last.cards);
		this._onDidChangeTasks.fire();
		if (status === 'complete' || status === 'failed') {
			void this.refreshStats(task);
		}
	}

	private async refreshStats(task: MutableTask): Promise<void> {
		try {
			const stats = await this._git.summarize(task.worktreePath, task.baseRef);
			if (!this._tasks.includes(task)) {
				return;
			}
			task.filesChanged = stats.filesChanged;
			task.added = stats.added;
			task.removed = stats.removed;
			this._onDidChangeTasks.fire();
		} catch {
			// The card keeps the last counts. A missing worktree is not a reason to invent them.
		}
	}

	private async loadChanges(task: MutableTask): Promise<BackgroundFileChange[]> {
		const patch = await this._git.diff(task.worktreePath, task.baseRef);
		return this.filesForPatch(task, patch);
	}

	private async filesForPatch(task: MutableTask, patch: string): Promise<BackgroundFileChange[]> {
		const files: BackgroundFileChange[] = [];
		for (const relativePath of pathsInDiff(patch)) {
			files.push(await this._git.readFilePair(task.worktreePath, task.baseRef, relativePath));
		}
		return files;
	}

	private async presentConflicts(task: MutableTask, conflicts: readonly BackgroundConflict[]): Promise<void> {
		task.conflicts = conflicts.map(conflict => ({ ...conflict }));
		this._onDidChangeTasks.fire();
		for (const conflict of conflicts) {
			const folder = join(this._userDataPath, 'worktrees', 'merge', task.id);
			const base = URI.file(resolveSafeChild(join(folder, 'base'), conflict.relativePath));
			const ours = URI.file(resolveSafeChild(join(folder, 'ours'), conflict.relativePath));
			const theirs = URI.file(resolveSafeChild(join(folder, 'theirs'), conflict.relativePath));
			const result = URI.file(resolveSafeChild(task.repoRoot, conflict.relativePath));
			if (isPathInside(task.worktreePath, result.fsPath) || result.fsPath === task.worktreePath) {
				throw new Error('Refusing to copy the worktree onto the workspace.');
			}
			await writeText(this._files, base, conflict.base);
			await writeText(this._files, ours, conflict.ours);
			await writeText(this._files, theirs, conflict.theirs);
			await this._editor.openEditor({
				base: { resource: base },
				input1: { resource: ours, description: localize('claudeBackgroundOurs', "Workspace") },
				input2: { resource: theirs, description: localize('claudeBackgroundTheirs', "Background agent") },
				result: { resource: result },
			});
		}
	}
}

export function isAbsentWorktreeError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const text = message.toLowerCase();
	return text.includes('not a working tree') || text.includes('not a git repository');
}

async function writeText(files: IFileService, resource: URI, text: string): Promise<void> {
	await files.createFolder(URI.file(dirname(resource.fsPath)));
	await files.writeFile(resource, VSBuffer.fromString(text));
}
