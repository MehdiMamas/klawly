/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { KlawlyProject, parseProjectFile, projectContextFolderName, projectContextReadme, projectCoordinatorPrompt, projectFileName, projectName, writeProjectFile } from '../../../../platform/claude/common/claudeProject.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator, IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustRequestService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { IClaudeContextService } from '../../../services/claude/common/claudeContextService.js';
import { IClaudeMultitaskService } from '../../../services/claude/common/claudeMultitask.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { CLAUDE_AGENT_VIEW_ID, KLAWLY_CATEGORY } from '../common/claudeViews.js';

/** Starts a project: a goal, its file and a coordinator chat in Plan mode (issue 496). */
export const CLAUDE_NEW_PROJECT_COMMAND_ID = 'klawly.project.new';

/** Picks a project and opens its coordinator chat. */
export const CLAUDE_OPEN_PROJECT_COMMAND_ID = 'klawly.project.open';

/** A project file and where it is. */
export interface ClaudeProjectEntry {
	readonly resource: URI;
	readonly project: KlawlyProject;
}

function pathOf(resource: URI): string {
	return resource.scheme === Schemas.file ? resource.fsPath : resource.path;
}

/** The project a chat belongs to, as the Agents column groups it. */
export interface ClaudeProjectOfSession {
	readonly key: string;
	readonly name: string;
}

export const IClaudeProjectIndex = createDecorator<IClaudeProjectIndex>('claudeProjectIndex');

/**
 * Which project each chat belongs to (issue 899): its coordinator chat and
 * the background agents that chat started with Build in Parallel. The Agents
 * column lists a project's chats under it.
 */
export interface IClaudeProjectIndex {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** The project of chat `sessionId`, or undefined for a chat outside every project. */
	projectOf(sessionId: string): ClaudeProjectOfSession | undefined;
	/** Reads the project files again. */
	refresh(): Promise<void>;
}

export class ClaudeProjectIndex extends Disposable implements IClaudeProjectIndex {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _projects: ClaudeProjects;
	private _entries: readonly ClaudeProjectEntry[] = [];

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IClaudeMultitaskService private readonly _multitask: IClaudeMultitaskService,
	) {
		super();
		this._projects = instantiationService.createInstance(ClaudeProjects, Date.now);
		this._register(this._multitask.onDidChange(() => this._onDidChange.fire()));
		void this.refresh();
	}

	projectOf(sessionId: string): ClaudeProjectOfSession | undefined {
		for (const { resource, project } of this._entries) {
			if (project.sessionId && (project.sessionId === sessionId || this._multitask.getGroups(project.sessionId).some(group => group.runs.some(run => run.runSessionId === sessionId)))) {
				return { key: basename(resource), name: project.name };
			}
		}
		return undefined;
	}

	async refresh(): Promise<void> {
		this._entries = await this._projects.list().catch(() => []);
		this._onDidChange.fire();
	}
}

/**
 * Klawly projects (issue 496). A project is a file in `~/.klawly/projects`
 * with a goal and its coordinator chat: a Plan mode chat that reads the code,
 * plans to-dos for background agents with `Files:` and `Depends:` lines, and
 * never edits files. Build in Parallel on its plan starts the agents (DL-63).
 */
export class ClaudeProjects {

	constructor(
		private readonly _now: () => number,
		@IFileService private readonly _files: IFileService,
		@IPathService private readonly _paths: IPathService,
		@IProductService private readonly _product: IProductService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeContextService private readonly _context: IClaudeContextService,
		@IViewsService private readonly _views: IViewsService,
	) { }

	/** Klawly's project folder for this user, next to its plan folder. */
	async folder(): Promise<URI> {
		return joinPath(await this._paths.userHome(), this._product.dataFolderName, 'projects');
	}

	/** The projects in the folder, newest first. Files that are not projects are left out. */
	async list(): Promise<ClaudeProjectEntry[]> {
		const folder = await this.folder();
		const stat = await this._files.resolve(folder).catch(() => undefined);
		const entries: ClaudeProjectEntry[] = [];
		for (const child of stat?.children ?? []) {
			if (child.isDirectory || !child.name.toLowerCase().endsWith('.json')) {
				continue;
			}
			const content = await this._files.readFile(child.resource).catch(() => undefined);
			const project = content && parseProjectFile(content.value.toString());
			if (project) {
				entries.push({ resource: child.resource, project });
			}
		}
		return entries.sort((a, b) => b.project.createdAt.localeCompare(a.project.createdAt));
	}

	/**
	 * Writes a project for `goal` in workspace folder `cwd`, then opens its
	 * coordinator chat in Plan mode and sends it the coordinator prompt.
	 */
	async create(goal: string, cwd: string): Promise<ClaudeProjectEntry> {
		const folder = await this.folder();
		const stat = await this._files.resolve(folder).catch(() => undefined);
		const name = projectName(goal);
		const resource = joinPath(folder, projectFileName(name, (stat?.children ?? []).map(child => child.name)));
		const session = this._agent.createSession();
		this._agent.setMode(session.id, 'plan');
		const contextFolder = joinPath(folder, projectContextFolderName(basename(resource)));
		const project: KlawlyProject = { version: 1, name, goal: goal.trim(), folder: cwd, createdAt: new Date(this._now()).toISOString(), sessionId: session.id };
		await this._files.writeFile(resource, VSBuffer.fromString(writeProjectFile(project)));
		// The shared context folder: every agent of the project gets it as an extra folder (issue 899).
		await this._files.writeFile(joinPath(contextFolder, 'README.md'), VSBuffer.fromString(projectContextReadme(project)));
		this._agent.addAdditionalDirectory(session.id, pathOf(contextFolder));
		await this._agent.renameSession(session.id, name);
		this._agent.selectSession(session.id);
		await this._views.openView(CLAUDE_AGENT_VIEW_ID, true);
		const text = projectCoordinatorPrompt(project, pathOf(resource), pathOf(contextFolder));
		const compiled = await this._context.preview(text, 'plan', [], session.id);
		await this._agent.submit(session.id, text, cwd, { compiled, label: localize('claudeProjectFirstTurn', "Plan the project: {0}", name) });
		return { resource, project };
	}

	/** Opens the coordinator chat of `entry`. False when that chat is gone. */
	async open(entry: ClaudeProjectEntry): Promise<boolean> {
		const sessionId = entry.project.sessionId;
		if (!sessionId) {
			return false;
		}
		try {
			if (!this._agent.getSessions().some(session => session.id === sessionId)) {
				await this._agent.resume(sessionId);
			}
			this._agent.addAdditionalDirectory(sessionId, pathOf(joinPath(await this.folder(), projectContextFolderName(basename(entry.resource)))));
			this._agent.selectSession(sessionId);
			await this._views.openView(CLAUDE_AGENT_VIEW_ID, true);
			return true;
		} catch {
			return false;
		}
	}
}

export function registerClaudeProjectActions(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_NEW_PROJECT_COMMAND_ID,
				title: localize2('claudeNewProject', "New Project..."),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const quickInput = accessor.get(IQuickInputService);
			const workspace = accessor.get(IWorkspaceContextService);
			const trust = accessor.get(IWorkspaceTrustRequestService);
			const notifications = accessor.get(INotificationService);
			const index = accessor.get(IClaudeProjectIndex);
			const projects = accessor.get(IInstantiationService).createInstance(ClaudeProjects, Date.now);
			const cwd = workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.fsPath;
			if (!cwd) {
				notifications.info(localize('claudeProjectNoFolder', "Open a folder first: a project's agents work in it."));
				return;
			}
			const goal = await quickInput.input({
				title: localize('claudeNewProjectTitle', "New Project"),
				placeHolder: localize('claudeNewProjectPlaceholder', "What should the project do? For example: add dark mode to the settings pages"),
				prompt: localize('claudeNewProjectPrompt', "A coordinator chat in Plan mode plans it as to-dos for background agents. It never edits files; Build in Parallel on its plan starts the agents."),
				validateInput: async value => value.trim() ? undefined : localize('claudeNewProjectEmpty', "Say what the project should do."),
			});
			if (!goal?.trim()) {
				return;
			}
			if (!await trust.requestWorkspaceTrust({ message: localize('claudeProjectTrust', "Klawly's agent runs only in a trusted workspace.") })) {
				return;
			}
			try {
				await projects.create(goal, cwd);
				await index.refresh();
			} catch (error) {
				notifications.error(localize('claudeProjectFailed', "Could not start the project: {0}", error instanceof Error ? error.message : String(error)));
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_OPEN_PROJECT_COMMAND_ID,
				title: localize2('claudeOpenProject', "Open Project..."),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const quickInput = accessor.get(IQuickInputService);
			const notifications = accessor.get(INotificationService);
			const labels = accessor.get(ILabelService);
			const projects = accessor.get(IInstantiationService).createInstance(ClaudeProjects, Date.now);
			const entries = await projects.list();
			if (!entries.length) {
				notifications.info(localize('claudeNoProjects', "No projects yet. Start one with New Project."));
				return;
			}
			const picked = await quickInput.pick<IQuickPickItem & { entry: ClaudeProjectEntry }>(entries.map(entry => ({
				label: entry.project.name,
				description: labels.getUriLabel(URI.file(entry.project.folder), { relative: false }),
				detail: basename(entry.resource),
				entry,
			})), { placeHolder: localize('claudeOpenProjectPlaceholder', "Pick a project to open its coordinator chat") });
			if (picked && !await projects.open(picked.entry)) {
				notifications.warn(localize('claudeProjectNoChat', "That project's coordinator chat is not in this window's history."));
			}
		}
	});
}
