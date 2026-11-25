/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../../nls.js';
import { buildPlanTodoPrompt, parsePlanDocument, PlanDocument, PlanTodoBranch, readyPlanTodos, setPlanTodoDone } from '../../../../../platform/claude/common/claudePlanDocument.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { CLAUDE_MULTITASK_MAX_PROMPTS, IClaudeMultitaskService, MultitaskRun, MultitaskRunStatus } from '../../../../services/claude/common/claudeMultitask.js';

export const IClaudePlanParallelBuilds = createDecorator<IClaudePlanParallelBuilds>('claudePlanParallelBuilds');

/** What the plan editor shows for a to-do built in parallel. */
export type PlanParallelState = 'building' | 'failed';

/**
 * Build in Parallel (issue 495): the to-dos of a plan file that do not wait
 * on each other run as one multitask, one background agent per to-do on its
 * own worktree. Each to-do is ticked in the file when its agent completes.
 * A to-do with a `Depends:` line starts by itself, as a later wave, once the
 * to-dos it waits for are ticked (issue 898). Its agent is told to merge the
 * branches of those to-dos first, because its worktree starts from the
 * checkout's HEAD. A to-do whose agent failed is not started again, and the
 * to-dos waiting on it stay open.
 */
export interface IClaudePlanParallelBuilds {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/**
	 * Starts the ready to-dos of `document` (at most eight) from chat
	 * `sessionId`, which gets the combined turn. Throws when fewer than two are ready.
	 */
	start(resource: URI, document: PlanDocument, path: string, sessionId: string, cwd: string): void;
	/** The to-dos of `resource` built in parallel and not ticked yet, by to-do text. */
	getStates(resource: URI): ReadonlyMap<string, PlanParallelState>;
	/** True when the agent that builds the to-do `todo` of `resource` has a chat to open (issue 898). */
	canOpen(resource: URI, todo: string): boolean;
	/** Shows the chat of the agent behind a to-do in the chat pane (issue 898). */
	open(resource: URI, todo: string): void;
}

interface TrackedBuild {
	readonly groupId: string;
	readonly sessionId: string;
	readonly resource: URI;
	/** The plan file's path as the agents get it, and the folder they were started for. */
	readonly path: string;
	readonly cwd: string;
	/** The to-do text of each run, in run order. */
	readonly todos: readonly string[];
	/** Runs already ticked in the file. */
	readonly ticked: Set<number>;
}

export class ClaudePlanParallelBuilds extends Disposable implements IClaudePlanParallelBuilds {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _builds: TrackedBuild[] = [];
	/** Per plan file: the to-dos started so far, which a later wave never starts again, even when they failed. */
	private readonly _started = new Map<string, Set<string>>();
	/** Per plan file: the branch each finished to-do's agent left its changes on. */
	private readonly _branches = new Map<string, Map<string, string>>();
	/** Plan files whose next wave is being worked out. */
	private readonly _waving = new Set<string>();

	constructor(
		@IClaudeMultitaskService private readonly _multitask: IClaudeMultitaskService,
		@ITextModelService private readonly _textModels: ITextModelService,
		@ITextFileService private readonly _textFiles: ITextFileService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this._register(this._multitask.onDidChange(() => this.sync()));
	}

	start(resource: URI, document: PlanDocument, path: string, sessionId: string, cwd: string): void {
		const ready = readyPlanTodos(document).ready.slice(0, CLAUDE_MULTITASK_MAX_PROMPTS);
		if (ready.length < 2) {
			throw new Error(localize('claudePlanParallelTooFew', "Build in Parallel needs at least two open to-dos that don't wait on another. Use Build instead, or edit the Depends lines."));
		}
		const group = this._multitask.start(sessionId, ready.map(todo => buildPlanTodoPrompt(document, path, todo)), cwd);
		this.track(group.id, sessionId, resource, path, cwd, ready.map(todo => todo.text));
	}

	private track(groupId: string, sessionId: string, resource: URI, path: string, cwd: string, todos: readonly string[]): void {
		const key = resource.toString();
		const started = this._started.get(key) ?? new Set<string>();
		todos.forEach(todo => started.add(todo));
		this._started.set(key, started);
		this._builds.push({ groupId, sessionId, resource, path, cwd, todos, ticked: new Set() });
		this._onDidChange.fire();
	}

	canOpen(resource: URI, todo: string): boolean {
		const run = this.findRun(resource, todo);
		return !!run && this._multitask.canOpen(run);
	}

	open(resource: URI, todo: string): void {
		const run = this.findRun(resource, todo);
		if (run && this._multitask.canOpen(run)) {
			this._multitask.open(run);
		}
	}

	private findRun(resource: URI, todo: string): MultitaskRun | undefined {
		for (const build of this._builds) {
			const index = build.todos.indexOf(todo);
			if (index >= 0 && build.resource.toString() === resource.toString()) {
				return this._multitask.getGroups(build.sessionId).find(group => group.id === build.groupId)?.runs[index];
			}
		}
		return undefined;
	}

	getStates(resource: URI): ReadonlyMap<string, PlanParallelState> {
		const states = new Map<string, PlanParallelState>();
		for (const build of this._builds) {
			if (build.resource.toString() !== resource.toString()) {
				continue;
			}
			this.statuses(build)?.forEach((status, index) => {
				if (!build.ticked.has(index) && status !== 'complete') {
					states.set(build.todos[index], status === 'failed' ? 'failed' : 'building');
				}
			});
		}
		return states;
	}

	/** The status of each run of `build`, or undefined once its multitask was dismissed. */
	private statuses(build: TrackedBuild): MultitaskRunStatus[] | undefined {
		return this._multitask.getGroups(build.sessionId).find(group => group.id === build.groupId)?.runs.map(run => run.status);
	}

	private sync(): void {
		for (let index = this._builds.length - 1; index >= 0; index--) {
			const build = this._builds[index];
			const statuses = this.statuses(build);
			if (!statuses) {
				this._builds.splice(index, 1);
				const key = build.resource.toString();
				if (!this._builds.some(other => other.resource.toString() === key)) {
					this._started.delete(key);
					this._branches.delete(key);
				}
				continue;
			}
			const completed = statuses.map((status, run) => status === 'complete' && !build.ticked.has(run) ? run : -1).filter(run => run >= 0);
			if (completed.length) {
				completed.forEach(run => build.ticked.add(run));
				this.rememberBranches(build, completed);
				void this.tick(build.resource, completed.map(run => build.todos[run])).then(() => this.startNextWave(build));
			}
		}
		this._onDidChange.fire();
	}

	private rememberBranches(build: TrackedBuild, runs: readonly number[]): void {
		const group = this._multitask.getGroups(build.sessionId).find(candidate => candidate.id === build.groupId);
		const key = build.resource.toString();
		const branches = this._branches.get(key) ?? new Map<string, string>();
		for (const run of runs) {
			const task = group?.runs[run] && this._multitask.getTask(group.runs[run]);
			if (task) {
				branches.set(build.todos[run], task.branchName);
			}
		}
		this._branches.set(key, branches);
	}

	/**
	 * Starts the to-dos with a `Depends:` line that became ready now that their
	 * dependencies are ticked, as one more multitask of the same chat (issue 898).
	 */
	private async startNextWave(build: TrackedBuild): Promise<void> {
		const key = build.resource.toString();
		if (this._waving.has(key)) {
			return;
		}
		this._waving.add(key);
		try {
			const reference = await this._textModels.createModelReference(build.resource);
			try {
				const document = parsePlanDocument(reference.object.textEditorModel.getValue());
				const started = this._started.get(key);
				const ready = readyPlanTodos(document).ready
					.filter(todo => (todo.depends?.length ?? 0) > 0 && !started?.has(todo.text))
					.slice(0, CLAUDE_MULTITASK_MAX_PROMPTS);
				if (!started || !this._builds.includes(build) || !ready.length) {
					return;
				}
				const branches = this._branches.get(key);
				const prompts = ready.map(todo => {
					const built: PlanTodoBranch[] = [];
					for (const number of todo.depends ?? []) {
						const branch = branches?.get(document.todos[number - 1]?.text);
						if (branch) {
							built.push({ number, branch });
						}
					}
					return buildPlanTodoPrompt(document, build.path, todo, built);
				});
				const group = this._multitask.start(build.sessionId, prompts, build.cwd);
				this.track(group.id, build.sessionId, build.resource, build.path, build.cwd, ready.map(todo => todo.text));
			} finally {
				reference.dispose();
			}
		} catch (error) {
			this._log.warn('[Klawly] could not start the next wave of the plan built in parallel', error);
		} finally {
			this._waving.delete(key);
		}
	}

	/** Marks the to-dos named `texts` done in the plan file and saves it. */
	private async tick(resource: URI, texts: readonly string[]): Promise<void> {
		try {
			const reference = await this._textModels.createModelReference(resource);
			try {
				const model = reference.object.textEditorModel;
				const document = parsePlanDocument(model.getValue());
				const edits = document.todos
					.filter(todo => !todo.done && texts.includes(todo.text))
					.map(todo => ({ range: new Range(todo.line, 1, todo.line, model.getLineMaxColumn(todo.line)), text: setPlanTodoDone(model.getLineContent(todo.line), true) }));
				if (edits.length) {
					// Saved like a tick in the plan editor: only when the file had no unsaved edits of the user's.
					const wasDirty = this._textFiles.isDirty(resource);
					model.pushStackElement();
					model.pushEditOperations([], edits, () => null);
					model.pushStackElement();
					if (!wasDirty) {
						await this._textFiles.save(resource);
					}
				}
			} finally {
				reference.dispose();
			}
		} catch (error) {
			this._log.warn('[Klawly] could not tick the plan to-dos built in parallel', error);
		}
	}
}
