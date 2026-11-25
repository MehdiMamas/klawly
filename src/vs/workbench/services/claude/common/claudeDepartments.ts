/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';
import { Schemas } from '../../../../base/common/network.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { claudeDepartmentArgsProblem, claudeDepartmentMessage, ClaudeDepartmentProject, ClaudeDepartmentToolRequest, ClaudeDepartmentToolResult, matchClaudeDepartmentProject } from '../../../../platform/claude/common/claudeDepartment.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isRecentFolder, IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IClaudeAgentService } from './claudeAgentService.js';
import { recordClaudeHandoff } from './claudeDepartmentInbox.js';

/** The local folders a hand-off can reach: the open ones and the recent ones, once each. */
export function claudeDepartmentProjects(workspaceFolders: readonly { readonly uri: URI }[], recent: readonly { readonly folderUri: URI }[]): ClaudeDepartmentProject[] {
	const seen = new Set<string>();
	const projects: ClaudeDepartmentProject[] = [];
	for (const uri of [...workspaceFolders.map(folder => folder.uri), ...recent.map(entry => entry.folderUri)]) {
		if (uri.scheme !== Schemas.file || seen.has(uri.fsPath)) {
			continue;
		}
		seen.add(uri.fsPath);
		projects.push({ folder: uri.fsPath, name: basename(uri) });
	}
	return projects;
}

/**
 * Answers `klawly_department` (issue 1177): finds the project the agent named, opens a
 * chat in its folder and sends it the hand-off message. It never selects the new chat, so
 * the user's focus stays where it is.
 */
export class ClaudeDepartmentHandler extends Disposable {
	constructor(
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IWorkspacesService private readonly _workspaces: IWorkspacesService,
		@IStorageService private readonly _storage: IStorageService,
	) {
		super();
		const onRequest = this._runtime.onDidRequestDepartment;
		if (onRequest) {
			this._register(onRequest(request => void this.handle(request)));
		}
	}

	private async handle(request: ClaudeDepartmentToolRequest): Promise<void> {
		const owner = this._agent.getSessions().find(session => this._agent.getRuntimeSessionId(session.id) === request.sessionId);
		if (!owner) {
			return;
		}
		let result: ClaudeDepartmentToolResult;
		try {
			result = await this.handOff(request, owner.title);
		} catch (error) {
			result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
		}
		await this._runtime.resolveDepartmentRequest?.(request.sessionId, request.requestId, result);
	}

	/** Public for tests. */
	async handOff(request: ClaudeDepartmentToolRequest, fromName: string): Promise<ClaudeDepartmentToolResult> {
		const problem = claudeDepartmentArgsProblem(request);
		if (problem) {
			return { kind: 'failed', message: problem };
		}
		const recent = (await this._workspaces.getRecentlyOpened()).workspaces.filter(isRecentFolder);
		const projects = claudeDepartmentProjects(this._workspace.getWorkspace().folders, recent);
		const match = matchClaudeDepartmentProject(request.project, projects);
		if (match.kind === 'none') {
			return { kind: 'failed', message: `No project named "${request.project}" is open or was opened recently.` };
		}
		if (match.kind === 'ambiguous') {
			return { kind: 'needsPick', candidates: match.candidates.map(candidate => candidate.name) };
		}
		const { folder, name } = match.project;
		const session = this._agent.createSession();
		this._agent.pinWorkingDirectory(session.id, folder);
		await this._agent.submit(session.id, claudeDepartmentMessage(fromName, request), folder);
		recordClaudeHandoff(this._storage, { chatId: session.id, from: fromName, folder, project: name, at: Date.now(), read: false });
		return { kind: 'delivered', project: name, opened: true };
	}
}
