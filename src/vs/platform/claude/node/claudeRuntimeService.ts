/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import { ILogService } from '../../log/common/log.js';
import { ClaudeEvent, IClaudeAuthStatus, IClaudeCliStatus, IClaudeGitStatus, IClaudeRuntimeService, IClaudeSendRequest, IClaudeSendResult, IClaudeSessionInfo, IClaudeSettings, IClaudeSettingsSource, IClaudeTranscriptMessage } from '../common/claudeRuntime.js';
import { ClaudeSessionOwners } from '../common/claudeSessionOwners.js';
import { claudeProjectFolderName, countClaudeEditedFiles, parseClaudeTranscript } from '../common/claudeSessions.js';
import { addAllowRuleToSettings, mergeClaudeSettings, parseClaudeSettingsFile } from '../common/claudeSettings.js';
import { ClaudeStreamParser } from '../common/claudeStreamParser.js';
import { checkClaudeCli, checkClaudeSignIn } from './claudeCli.js';
import { checkGitFolder, initGitFolder, trustGitFolder } from './claudeGit.js';

interface IClaudeSession {
	readonly sessionId: string;
	readonly process: ChildProcessWithoutNullStreams;
	/** Permission requests waiting for an answer, request id to the tool input the CLI needs echoed back. */
	readonly pendingPermissions: Map<string, Record<string, unknown>>;
	/** True from a prompt until the CLI reports the result of the turn. */
	busy: boolean;
	/** The permission mode the CLI is in, from the request that started it and then its own reports. */
	mode: string | undefined;
	/** Set when the person asked to stop: the CLI then exits on a signal, which is not an error. */
	stopRequested: boolean;
}

/** How long the CLI gets to honour an interrupt before its process is ended. */
const STOP_GRACE_MS = 1500;

/**
 * Drives the user's installed, untouched `claude` command headless over stream-json.
 * Runs in the shared process; views talk to it through the normalized {@link ClaudeEvent} protocol.
 */
export class ClaudeRuntimeService extends Disposable implements IClaudeRuntimeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidEvent = this._register(new Emitter<ClaudeEvent>());
	readonly onDidEvent = this._onDidEvent.event;

	private readonly owners = new ClaudeSessionOwners<IClaudeSession>();

	constructor(
		@ILogService private readonly logService: ILogService,
		private readonly env: NodeJS.ProcessEnv = process.env,
		private readonly home: string = homedir(),
	) {
		super();
	}

	checkCli(): Promise<IClaudeCliStatus> {
		return checkClaudeCli(this.env);
	}

	checkSignIn(): Promise<IClaudeAuthStatus> {
		return checkClaudeSignIn(this.env);
	}

	checkGit(cwd: string): Promise<IClaudeGitStatus> {
		return checkGitFolder(cwd, this.env);
	}

	initGit(cwd: string): Promise<void> {
		return initGitFolder(cwd, this.env);
	}

	trustGitFolder(cwd: string): Promise<void> {
		return trustGitFolder(cwd, this.env);
	}

	async send(request: IClaudeSendRequest): Promise<IClaudeSendResult> {
		const sessionId = request.sessionId ?? generateUuid();
		let failure: string | undefined;
		const { owner, followed } = await this.claim(sessionId, request, message => failure = message);
		if (!owner) {
			throw new Error(failure);
		}
		if (request.permissionMode && owner.mode !== request.permissionMode) {
			// a running CLI keeps the mode it started with; the documented control message changes it
			owner.mode = request.permissionMode;
			owner.process.stdin.write(JSON.stringify({ type: 'control_request', request_id: generateUuid(), request: { subtype: 'set_permission_mode', mode: request.permissionMode } }) + '\n');
		}
		owner.busy = true;
		owner.stopRequested = false;
		owner.process.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: request.prompt } }) + '\n');
		return { sessionId, followed };
	}

	private async claim(sessionId: string, request: IClaudeSendRequest, fail: (message: string) => void): Promise<{ owner: IClaudeSession | undefined; followed: boolean }> {
		const existing = this.owners.get(sessionId);
		if (existing) {
			return { owner: existing, followed: true };
		}
		const cli = await this.checkCli();
		if (!cli.found || !cli.path) {
			fail(cli.error ?? localize('claudeMissing', "Claude Code is not installed."));
			return { owner: undefined, followed: false };
		}
		// checkCli awaited, so another caller may have become the owner meanwhile
		return this.owners.claim(sessionId, () => this.spawnSession(cli.path!, sessionId, request));
	}

	private spawnSession(path: string, sessionId: string, request: IClaudeSendRequest): IClaudeSession {
		const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio'];
		// a given id is resumed; a new session is started under an id we choose so the view knows it up front
		args.push(request.sessionId ? '--resume' : '--session-id', sessionId);
		if (request.model) {
			args.push('--model', request.model);
		}
		// allowed as an option only: it lets the person switch to Bypass later in the session, it does not start in it
		args.push('--allow-dangerously-skip-permissions');
		if (request.permissionMode) {
			args.push('--permission-mode', request.permissionMode);
		}
		const child = spawn(path, args, { cwd: request.cwd, env: this.env, windowsHide: true });
		const session: IClaudeSession = { sessionId, process: child, pendingPermissions: new Map(), busy: false, mode: request.permissionMode, stopRequested: false };
		const parser = new ClaudeStreamParser();
		let buffer = '';
		let stderr = '';

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			buffer += chunk;
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				for (const event of parser.parseLine(line)) {
					if (event.type === 'result') {
						session.busy = false;
					}
					if (event.type === 'mode') {
						session.mode = event.mode;
					}
					if (event.type === 'permission') {
						session.pendingPermissions.set(event.requestId, event.input);
					}
					this._onDidEvent.fire({ ...event, sessionId });
				}
			}
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => stderr = (stderr + chunk).slice(-2000));
		child.on('error', error => {
			this.logService.warn(`[ClaudeRuntime] ${error.message}`);
			this._onDidEvent.fire({ type: 'error', sessionId, message: error.message });
		});
		child.on('close', code => {
			this.owners.release(sessionId, session);
			if (code && !session.stopRequested) {
				this._onDidEvent.fire({ type: 'error', sessionId, message: stderr.trim() || localize('claudeExited', "Claude Code stopped with exit code {0}.", code) });
			}
			this._onDidEvent.fire({ type: 'ended', sessionId, exitCode: code });
		});
		return session;
	}

	async answerPermission(sessionId: string, requestId: string, allow: boolean, message?: string, updatedInput?: Record<string, unknown>): Promise<void> {
		const session = this.owners.get(sessionId);
		const input = session?.pendingPermissions.get(requestId);
		if (!session || !input) {
			return;
		}
		session.pendingPermissions.delete(requestId);
		const response = allow ? { behavior: 'allow', updatedInput: updatedInput ?? input } : { behavior: 'deny', message: message ?? 'The user denied this action.' };
		session.process.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) + '\n');
	}

	async stop(sessionId: string): Promise<void> {
		const session = this.owners.get(sessionId);
		if (!session) {
			return;
		}
		session.busy = false;
		session.stopRequested = true;
		session.pendingPermissions.clear();
		session.process.stdin.write(JSON.stringify({ type: 'control_request', request_id: generateUuid(), request: { subtype: 'interrupt' } }) + '\n');
		// a CLI that ignores the interrupt would keep working: end it, the session resumes on the next prompt
		const timer = setTimeout(() => {
			if (this.owners.get(sessionId) === session) {
				session.process.kill();
			}
		}, STOP_GRACE_MS);
		session.process.once('close', () => clearTimeout(timer));
	}

	async close(sessionId: string): Promise<void> {
		this.owners.get(sessionId)?.process.stdin.end();
	}

	async getRunningSessions(): Promise<string[]> {
		return this.owners.ids();
	}

	async getBusySessions(): Promise<string[]> {
		return this.owners.ids().filter(id => this.owners.get(id)?.busy);
	}

	/** Precedence: https://code.claude.com/docs/en/settings, lowest first here: user, project, project local. */
	async readSettings(cwd: string): Promise<IClaudeSettings> {
		const files: Pick<IClaudeSettingsSource, 'scope' | 'path'>[] = [
			{ scope: 'user', path: join(this.home, '.claude', 'settings.json') },
			{ scope: 'project', path: join(cwd, '.claude', 'settings.json') },
			{ scope: 'local', path: join(cwd, '.claude', 'settings.local.json') },
		];
		const layers: Record<string, unknown>[] = [];
		const sources: IClaudeSettingsSource[] = [];
		for (const file of files) {
			let text: string;
			try {
				text = await readFile(file.path, 'utf8');
			} catch {
				sources.push({ ...file, loaded: false });
				continue;
			}
			const parsed = parseClaudeSettingsFile(text);
			if (parsed.value) {
				layers.push(parsed.value);
			}
			sources.push({ ...file, loaded: !!parsed.value, error: parsed.error });
		}
		return { settings: mergeClaudeSettings(layers), sources };
	}

	async addAllowRule(cwd: string, rule: string): Promise<void> {
		const dir = join(cwd, '.claude');
		const path = join(dir, 'settings.local.json');
		let existing: string | undefined;
		try {
			existing = await readFile(path, 'utf8');
		} catch {
			// no file yet
		}
		await mkdir(dir, { recursive: true });
		await writeFile(path, addAllowRuleToSettings(existing, rule));
	}

	/** The CLI names the folder after the real path of the working folder (`/tmp` is `/private/tmp` on macOS). */
	private async sessionsFolder(cwd: string): Promise<string> {
		const real = await realpath(cwd).catch(() => cwd);
		return join(this.home, '.claude', 'projects', claudeProjectFolderName(real));
	}

	async listSessions(cwd: string): Promise<IClaudeSessionInfo[]> {
		const folder = await this.sessionsFolder(cwd);
		let names: string[];
		try {
			names = (await readdir(folder)).filter(name => name.endsWith('.jsonl'));
		} catch {
			return [];
		}
		const sessions: IClaudeSessionInfo[] = [];
		for (const name of names) {
			const path = join(folder, name);
			try {
				const text = await readFile(path, 'utf8');
				const first = parseClaudeTranscript(text).find(m => m.role === 'user');
				if (first) {
					sessions.push({ id: name.slice(0, -'.jsonl'.length), title: first.text.split('\n')[0].slice(0, 60), modified: (await stat(path)).mtimeMs, files: countClaudeEditedFiles(text) });
				}
			} catch {
				// unreadable file: not listed
			}
		}
		return sessions.sort((a, b) => b.modified - a.modified || (a.id < b.id ? -1 : 1));
	}

	async readTranscript(cwd: string, sessionId: string): Promise<IClaudeTranscriptMessage[]> {
		// an id is a file name inside the project folder, never a path
		if (!/^[\w-]+$/.test(sessionId)) {
			return [];
		}
		try {
			return parseClaudeTranscript(await readFile(join(await this.sessionsFolder(cwd), `${sessionId}.jsonl`), 'utf8'));
		} catch {
			return [];
		}
	}

	override dispose(): void {
		for (const id of this.owners.ids()) {
			this.owners.get(id)?.process.kill();
		}
		super.dispose();
	}
}
