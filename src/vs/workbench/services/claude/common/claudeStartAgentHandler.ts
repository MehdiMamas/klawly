/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename } from '../../../../base/common/resources.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { matchClaudeDepartmentProject } from '../../../../platform/claude/common/claudeDepartment.js';
import { claudeStartAgentArgsProblem, ClaudeStartAgentToolRequest, ClaudeStartAgentToolResult } from '../../../../platform/claude/common/claudeStartAgent.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isRecentFolder, IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { IClaudeAgentService } from './claudeAgentService.js';
import { claudeDepartmentProjects } from './claudeDepartments.js';

/**
 * Answers `klawly_start_agent` (issue 991): opens a local chat in this project or the one
 * the agent named, gives it the starter's mode and permission level, and sends the first
 * message. It never selects the new chat, so the user's focus stays where it is, and it
 * never waits for the new chat's result.
 */
export class ClaudeStartAgentHandler extends Disposable {
	constructor(
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IWorkspacesService private readonly _workspaces: IWorkspacesService,
	) {
		super();
		const onRequest = this._runtime.onDidRequestStartAgent;
		if (onRequest) {
			this._register(onRequest(request => void this.handle(request)));
		}
	}

	private async handle(request: ClaudeStartAgentToolRequest): Promise<void> {
		const owner = this._agent.getSessions().find(session => this._agent.getRuntimeSessionId(session.id) === request.sessionId);
		if (!owner) {
			return;
		}
		let result: ClaudeStartAgentToolResult;
		try {
			result = await this.start(request, owner.id);
		} catch (error) {
			result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
		}
		await this._runtime.resolveStartAgentRequest?.(request.sessionId, request.requestId, result);
	}

	/** Public for tests. */
	async start(request: ClaudeStartAgentToolRequest, ownerId: string): Promise<ClaudeStartAgentToolResult> {
		const problem = claudeStartAgentArgsProblem(request);
		if (problem) {
			return { kind: 'failed', message: problem };
		}
		const folders = this._workspace.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.file);
		let folder = folders[0]?.uri.fsPath ?? '';
		let name = folders[0] ? basename(folders[0].uri) : '';
		if (request.project?.trim()) {
			const recent = (await this._workspaces.getRecentlyOpened()).workspaces.filter(isRecentFolder);
			const match = matchClaudeDepartmentProject(request.project, claudeDepartmentProjects(folders, recent));
			if (match.kind === 'none') {
				return { kind: 'failed', message: `No project named "${request.project}" is open or was opened recently.` };
			}
			if (match.kind === 'ambiguous') {
				return { kind: 'needsPick', candidates: match.candidates.map(candidate => candidate.name) };
			}
			folder = match.project.folder;
			name = match.project.name;
		}
		if (!folder) {
			return { kind: 'failed', message: 'No local project is open to start the chat in.' };
		}
		const owner = this._agent.getSessions().find(session => session.id === ownerId);
		const session = this._agent.createSession();
		this._agent.pinWorkingDirectory(session.id, folder);
		if (owner) {
			this._agent.setMode(session.id, owner.mode);
			this._agent.setSessionPermissions(session.id, this._agent.getSessionPermissions(ownerId));
		}
		const title = request.title?.trim();
		if (title) {
			await this._agent.renameSession(session.id, title);
		}
		await this._agent.submit(session.id, request.prompt, folder);
		return { kind: 'started', title: title || session.title, project: name };
	}
}
