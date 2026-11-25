/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { ClaudeKlawlyHookRequest, ClaudeKlawlyHookResult } from '../../../../platform/claude/common/claudeKlawlyHooks.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IOutputService } from '../../output/common/output.js';
import { CLAUDE_AGENT_OUTPUT_CHANNEL_ID } from './claudeAgentLog.js';

export const IClaudeKlawlyHooksService = createDecorator<IClaudeKlawlyHooksService>('claudeKlawlyHooksService');

/** What a Klawly surface may do after its hooks ran. */
export interface ClaudeKlawlyHookVerdict {
	readonly allowed: boolean;
	readonly reason?: string;
}

/** Tab asks again for the same file within this window without starting the hooks again. */
const TAB_DECISION_MS = 30_000;

const ALLOWED: ClaudeKlawlyHookVerdict = { allowed: true };

/**
 * Runs the hooks on Klawly's own events (issue 514): `KlawlyTabRead`,
 * `KlawlyInlineEdit` and `KlawlyWorkspaceOpen`. Hooks run node-side, only in a
 * trusted workspace; every denial, error and hook message goes to the Claude
 * Agent output channel.
 */
export interface IClaudeKlawlyHooksService {
	readonly _serviceBrand: undefined;
	/** Whether Tab may send this file. Allowed when the workspace is not trusted or no hook denies. Never rejects. */
	checkTabRead(uri: URI): Promise<ClaudeKlawlyHookVerdict>;
	/** The inline edit hook, before (a denial blocks the edit) or after the edit is in the file. Never rejects. */
	checkInlineEdit(uri: URI, phase: 'before' | 'after', instruction: string): Promise<ClaudeKlawlyHookVerdict>;
	/** The workspace open hook, once per folder. Does nothing when the workspace is not trusted. */
	runWorkspaceOpen(): Promise<void>;
}

export class ClaudeKlawlyHooksService extends Disposable implements IClaudeKlawlyHooksService {
	declare readonly _serviceBrand: undefined;

	private readonly _tab = new Map<string, { readonly at: number; readonly verdict: Promise<ClaudeKlawlyHookVerdict> }>();

	constructor(
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly _trust: IWorkspaceTrustManagementService,
		@IOutputService private readonly _output: IOutputService,
	) {
		super();
		// A trust change can change every answer, and the settings files may have changed with it.
		this._register(this._trust.onDidChangeTrust(() => this._tab.clear()));
	}

	checkTabRead(uri: URI): Promise<ClaudeKlawlyHookVerdict> {
		const key = uri.toString();
		const now = Date.now();
		const cached = this._tab.get(key);
		if (cached && now - cached.at < TAB_DECISION_MS) {
			return cached.verdict;
		}
		const cwd = this._cwd(uri);
		const verdict = cwd ? this._check({ event: 'KlawlyTabRead', cwd, filePath: filePath(uri) }) : Promise.resolve(ALLOWED);
		this._tab.set(key, { at: now, verdict });
		for (const [other, entry] of this._tab) {
			if (now - entry.at >= TAB_DECISION_MS) {
				this._tab.delete(other);
			}
		}
		return verdict;
	}

	checkInlineEdit(uri: URI, phase: 'before' | 'after', instruction: string): Promise<ClaudeKlawlyHookVerdict> {
		const cwd = this._cwd(uri);
		return cwd ? this._check({ event: 'KlawlyInlineEdit', cwd, phase, filePath: filePath(uri), instruction }) : Promise.resolve(ALLOWED);
	}

	async runWorkspaceOpen(): Promise<void> {
		const folders = this._workspace.getWorkspace().folders.filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
		await Promise.all(folders.map(cwd => this._check({ event: 'KlawlyWorkspaceOpen', cwd, folders })));
	}

	private async _check(request: ClaudeKlawlyHookRequest): Promise<ClaudeKlawlyHookVerdict> {
		if (!this._runtime.runKlawlyHooks || !this._trust.isWorkspaceTrusted()) {
			return ALLOWED;
		}
		let result: ClaudeKlawlyHookResult;
		try {
			result = await this._runtime.runKlawlyHooks(request);
		} catch (error) {
			this._log(`[claude] hooks for ${request.event} could not run: ${error instanceof Error ? error.message : String(error)}\n`);
			return ALLOWED;
		}
		const subject = request.event === 'KlawlyWorkspaceOpen' ? request.cwd : `${request.filePath}${request.event === 'KlawlyInlineEdit' ? ` (${request.phase})` : ''}`;
		for (const run of result.runs) {
			if (run.outcome !== 'allowed' || run.message) {
				this._log(`[claude] hook ${request.event} ${run.outcome} ${subject} after ${run.durationMs}ms: ${run.command}${run.message ? ` - ${run.message}` : ''}\n`);
			}
		}
		return result.allowed ? ALLOWED : { allowed: false, reason: result.reason };
	}

	private _log(line: string): void {
		this._output.getChannel(CLAUDE_AGENT_OUTPUT_CHANNEL_ID)?.append(line);
	}

	/** The file's workspace folder, else the first folder, else the file's own folder. */
	private _cwd(uri: URI): string | undefined {
		const folder = this._workspace.getWorkspaceFolder(uri) ?? this._workspace.getWorkspace().folders[0];
		if (folder?.uri.scheme === 'file') {
			return folder.uri.fsPath;
		}
		return uri.scheme === 'file' ? dirname(uri.fsPath) : undefined;
	}
}

function filePath(uri: URI): string {
	return uri.scheme === 'file' ? uri.fsPath : uri.toString();
}
