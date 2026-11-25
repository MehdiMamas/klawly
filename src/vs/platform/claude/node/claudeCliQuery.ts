/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { ClaudeAccountDetails, claudeMcpServerState, ClaudeUsageWindow, ClaudeUsageWindowKind } from '../common/claudeAccount.js';
import { claudeUsageLimitFromRateLimitInfo } from '../common/claudeAccounts.js';
import { ClaudeFlagSettingsPatch } from '../common/claudeSessionSettings.js';
import { buildClaudeCliArguments, CLAUDE_PERMISSION_MCP_SERVER, CLAUDE_PERMISSION_TOOL } from './claudeCliArgs.js';
import { claudeCliSessionId, claudeUserLine, ClaudeCliInitMessage, ClaudeJsonLineParser, isClaudeCliResult, readClaudeCliInit } from './claudeCliProtocol.js';
import { createClaudeTargetSpawner, defaultClaudeTargetHost } from './claudeExecutionTarget.js';
import { ClaudeLocalBridge, ClaudeLocalToolResult } from './claudeLocalBridge.js';
import { ClaudeQuery, ClaudeQueryCommand, ClaudeQueryFactory, ClaudeQueryModel, ClaudeQueryOptions, ClaudeQueryPermissionMode, ClaudeQueryStart } from './claudeQuery.js';
import { defaultExecFile, parseAuthStatusAccount } from './claudeRuntime.js';
import { localize } from '../../../nls.js';
import { claudeCommand } from './claudeWindowsCommand.js';
import { claudeSecurityOptions } from './claudeSecurityOptions.js';
import { CLAUDE_KLAWLY_MCP_SERVER } from '../common/claudeTerminalRun.js';
import { claudeKlawlyMcpServer, CLAUDE_TERMINAL_TOOL_TIMEOUT_MS } from './claudeTerminalTool.js';

/** How long a process gets to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 3000;
/** Remembered `tool_use_id` to `agent_id` pairs, so a permission request knows its subagent. */
const MAX_AGENT_IDS = 512;
/** The last stderr text kept for an error message. */
const STDERR_TAIL_BYTES = 4096;

/** An async queue with a failure state: what the runner iterates. */
class MessageQueue implements AsyncIterableIterator<unknown> {
	private readonly _items: unknown[] = [];
	private readonly _waiting: { resolve(result: IteratorResult<unknown>): void; reject(error: Error): void }[] = [];
	private _done = false;
	private _error: Error | undefined;

	push(item: unknown): void {
		if (this._done) {
			return;
		}
		const waiter = this._waiting.shift();
		if (waiter) {
			waiter.resolve({ value: item, done: false });
		} else {
			this._items.push(item);
		}
	}

	close(): void {
		this._done = true;
		for (const waiter of this._waiting.splice(0)) {
			waiter.resolve({ value: undefined, done: true });
		}
	}

	fail(error: Error): void {
		if (this._done) {
			return;
		}
		this._error = error;
		this._done = true;
		for (const waiter of this._waiting.splice(0)) {
			waiter.reject(error);
		}
	}

	next(): Promise<IteratorResult<unknown>> {
		if (this._items.length > 0) {
			return Promise.resolve({ value: this._items.shift(), done: false });
		}
		if (this._error) {
			const error = this._error;
			this._error = undefined;
			return Promise.reject(error);
		}
		if (this._done) {
			return Promise.resolve({ value: undefined, done: true });
		}
		return new Promise((resolve, reject) => this._waiting.push({ resolve, reject }));
	}

	return(): Promise<IteratorResult<unknown>> {
		this.close();
		return Promise.resolve({ value: undefined, done: true });
	}

	[Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
		return this;
	}
}

/** The model names Claude Code takes as aliases. The list is static: the CLI prints no model list. */
const MODEL_ALIASES: readonly string[] = ['opus', 'sonnet', 'haiku', 'fable'];

/**
 * One Claude Code conversation over the user's installed `claude` program,
 * driven as a child process with documented flags and stream-json on stdin and
 * stdout (https://code.claude.com/docs/en/headless). It is the program Klawly
 * started as a `ClaudeQuery`.
 *
 * - The process starts with the first prompt and keeps running between prompts.
 * - A change Claude Code takes only at start (model, permission mode, settings)
 *   is recorded and applied by restarting the process with `--resume` before the
 *   next prompt, so the conversation continues.
 * - Interrupt is SIGINT, as Ctrl+C is; the next prompt resumes the conversation.
 * - Klawly's tools, permission prompts and hooks are answered by a localhost
 *   server (`ClaudeLocalBridge`) that Claude Code connects to as an MCP server.
 */
export class ClaudeCliQuery implements ClaudeQuery {
	private readonly _output = new MessageQueue();
	private readonly _parser = new ClaudeJsonLineParser();
	private readonly _agentIds = new Map<string, string>();
	private _options: ClaudeQueryOptions;
	private _child: ChildProcess | undefined;
	private _sessionId: string | undefined;
	private _init: ClaudeCliInitMessage | undefined;
	private _pendingTurns = 0;
	private _dirty = false;
	private readonly _mcpOff = new Set<string>();
	private readonly _limits = new Map<string, ClaudeUsageWindow>();
	private _promptDone = false;
	private _closed = false;
	/** True while an exit is one Klawly asked for, so it is not an error. */
	private _expectedExit = false;
	private _exited: Promise<void> = Promise.resolve();
	private _stderrTail = '';

	constructor(
		private readonly _start: ClaudeQueryStart,
		private readonly _bridge: ClaudeLocalBridge | undefined,
		private readonly _spawnContext: { readonly args: (options: ClaudeQueryOptions, sessionId: string | undefined) => string[]; readonly forwardPort?: number },
	) {
		this._options = _start.options;
		this._sessionId = _start.options.resume;
		_start.options.abortController.signal.addEventListener('abort', () => this.close(), { once: true });
		void this._pump();
	}

	[Symbol.asyncIterator](): AsyncIterator<unknown> {
		return this._output;
	}

	/** Writes every prompt message to Claude Code, starting or restarting the process first when needed. */
	private async _pump(): Promise<void> {
		try {
			for await (const message of this._start.prompt) {
				if (this._closed) {
					return;
				}
				if (this._child && this._dirty && this._pendingTurns === 0) {
					await this._stopProcess();
				}
				if (!this._child) {
					this._spawn();
				}
				this._dirty = false;
				this._pendingTurns++;
				this._child!.stdin!.write(claudeUserLine(message));
			}
			this._promptDone = true;
			if (this._child) {
				// Claude Code finishes the turn it is in, then exits.
				this._child.stdin!.end();
			} else {
				this._output.close();
			}
		} catch (error) {
			this._output.fail(error instanceof Error ? error : new Error(String(error)));
			this._killNow();
		}
	}

	private _spawn(): void {
		const options = this._options;
		const security = claudeSecurityOptions(options.security, options.sandboxDenyRead);
		const userMcpServers = options.userMcpServers && Object.fromEntries(Object.entries(options.userMcpServers).filter(([name]) => !this._mcpOff.has(name)));
		const args = this._spawnContext.args({ ...options, userMcpServers }, this._sessionId);
		const env: Record<string, string> = {
			...options.env,
			...security.env,
			// A terminal tool call waits for the user, which can take an hour.
			MCP_TOOL_TIMEOUT: String(CLAUDE_TERMINAL_TOOL_TIMEOUT_MS),
		};
		const executable = options.pathToClaudeCodeExecutable ?? 'claude';
		let child: ChildProcessWithoutNullStreams;
		if (options.executionTarget) {
			child = createClaudeTargetSpawner(options.executionTarget, defaultClaudeTargetHost(), options.log)({ args, cwd: options.cwd, env, forwardPort: this._spawnContext.forwardPort });
		} else {
			const command = claudeCommand(executable, args);
			child = spawn(command.file, [...command.args], { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: command.verbatim });
		}
		this._child = child;
		this._expectedExit = false;
		this._stderrTail = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => this._read(this._parser.push(chunk)));
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			this._stderrTail = (this._stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
			if (!options.executionTarget) {
				options.log?.(chunk.trimEnd());
			}
		});
		// stdin errors (EPIPE after an exit) must not crash the process; the exit handler reports.
		child.stdin.on('error', () => { });
		this._exited = new Promise<void>(resolve => {
			child.once('error', error => {
				this._finished(child, undefined, `Claude Code could not start: ${error.message}`);
				resolve();
			});
			child.once('close', (code, signal) => {
				this._finished(child, code, signal ? `Claude Code was stopped (${signal}).` : undefined);
				resolve();
			});
		});
	}

	private _read(batch: { readonly messages: readonly unknown[]; readonly invalid: readonly string[] }): void {
		for (const line of batch.invalid) {
			this._options.log?.(`Claude Code printed a line that is not JSON: ${line.slice(0, 200)}`);
		}
		for (const message of batch.messages) {
			const sessionId = claudeCliSessionId(message);
			if (sessionId) {
				this._sessionId = sessionId;
			}
			const init = readClaudeCliInit(message);
			if (init) {
				this._init = init;
			}
			if ((message as { type?: unknown }).type === 'rate_limit_event') {
				this._rememberLimit((message as { rate_limit_info?: unknown }).rate_limit_info);
			}
			if (isClaudeCliResult(message) && !this._isSubagentMessage(message)) {
				this._pendingTurns = Math.max(0, this._pendingTurns - 1);
			}
			this._output.push(message);
		}
	}

	/** Keeps the newest reading of each plan window Claude Code reports in its rate-limit events. */
	private _rememberLimit(info: unknown): void {
		const limit = claudeUsageLimitFromRateLimitInfo(info);
		const kind = limit ? LIMIT_KINDS[limit.window] : undefined;
		if (limit && kind && limit.percent !== undefined) {
			this._limits.set(limit.window, { kind, percent: limit.percent, resetsAt: limit.resetsAt });
		}
	}

	private _isSubagentMessage(message: unknown): boolean {
		return typeof (message as { parent_tool_use_id?: unknown }).parent_tool_use_id === 'string';
	}

	/** Runs when the process has ended and its output is read. */
	private _finished(child: ChildProcess, code: number | null | undefined, reason: string | undefined): void {
		if (this._child !== child) {
			return;
		}
		this._read(this._parser.end());
		this._child = undefined;
		const expected = this._expectedExit;
		const unfinishedTurn = this._pendingTurns > 0;
		if (this._closed) {
			return;
		}
		if (expected) {
			if (unfinishedTurn) {
				// An interrupt ends the turn, normally with a result; make sure the runner always sees one.
				this._pendingTurns = 0;
				this._output.push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [], session_id: this._sessionId });
			}
			if (this._promptDone) {
				this._output.close();
			}
			return;
		}
		if (code === 0 && !unfinishedTurn) {
			if (this._promptDone) {
				this._output.close();
			}
			return;
		}
		this._pendingTurns = 0;
		const detail = this._stderrTail.trim().split(/\r?\n/).slice(-6).join('\n');
		this._output.fail(new Error(`${reason ?? `Claude Code exited with code ${code}.`}${detail ? `\n${detail}` : ''}`));
	}

	/** Ends the process the polite way: stdin closed, then a wait; SIGTERM and SIGKILL if it hangs. */
	private async _stopProcess(): Promise<void> {
		const child = this._child;
		if (!child) {
			return;
		}
		this._expectedExit = true;
		child.stdin?.end();
		const timer = setTimeout(() => this._terminate(child), KILL_GRACE_MS);
		await this._exited;
		clearTimeout(timer);
	}

	private _terminate(child: ChildProcess): void {
		child.kill('SIGTERM');
		const timer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
		child.once('exit', () => clearTimeout(timer));
	}

	private _killNow(): void {
		this._expectedExit = true;
		if (this._child) {
			this._terminate(this._child);
		}
	}

	async interrupt(): Promise<void> {
		const child = this._child;
		if (!child) {
			return;
		}
		this._expectedExit = true;
		child.kill('SIGINT');
		const timer = setTimeout(() => this._terminate(child), KILL_GRACE_MS);
		await this._exited;
		clearTimeout(timer);
	}

	async setModel(model?: string): Promise<void> {
		this._options = { ...this._options, model };
		this._dirty = true;
	}

	async setPermissionMode(mode: ClaudeQueryPermissionMode): Promise<void> {
		this._options = { ...this._options, permissionMode: mode };
		this._dirty = true;
	}

	async applyFlagSettings(patch: ClaudeFlagSettingsPatch): Promise<void> {
		const flags: Record<string, unknown> = { ...this._options.flagSettings };
		let effort = this._options.effort;
		for (const [key, value] of Object.entries(patch)) {
			if (key === 'effortLevel') {
				effort = value === null ? undefined : value as typeof effort;
			} else if (value === null) {
				delete flags[key];
			} else {
				flags[key] = value;
			}
		}
		this._options = { ...this._options, effort, flagSettings: flags as ClaudeQueryOptions['flagSettings'] };
		this._dirty = true;
	}

	/** Claude Code prints no model list, so these are the aliases it takes, the picker's ids and the model it reported. */
	async supportedModels(): Promise<readonly ClaudeQueryModel[]> {
		const ids = new Set<string>([...MODEL_ALIASES, ...this._options.modelPicker ?? []]);
		if (this._init?.model) {
			ids.add(this._init.model);
		}
		return [...ids].map(id => ({ id, displayName: id }));
	}

	/** The slash commands Claude Code reported when it started; none before the first prompt. */
	async supportedCommands(): Promise<readonly ClaudeQueryCommand[]> {
		return (this._init?.slash_commands ?? []).map(name => ({ name, description: '' }));
	}

	async supportedAgents(): Promise<readonly { readonly name: string; readonly description: string }[]> {
		return (this._init?.agents ?? []).map(name => ({ name, description: '' }));
	}

	async accountInfo(): Promise<ClaudeAccountDetails> {
		const result = await defaultExecFile(this._options.pathToClaudeCodeExecutable ?? 'claude', ['auth', 'status'], { timeout: 15000, windowsHide: true, env: this._options.env, cwd: this._options.cwd });
		const account = parseAuthStatusAccount(result.stdout);
		if (!account) {
			throw new Error('Claude Code did not report an account.');
		}
		return account;
	}

	async mcpServerStatus(): Promise<readonly { readonly name: string; readonly state: ReturnType<typeof claudeMcpServerState>; readonly toolCount: number }[]> {
		const running = (this._init?.mcp_servers ?? []).filter(server => !this._mcpOff.has(server.name)).map(server => ({ name: server.name, state: claudeMcpServerState(server.status), toolCount: 0 }));
		return [...running, ...[...this._mcpOff].map(name => ({ name, state: claudeMcpServerState('disabled'), toolCount: 0 }))];
	}

	/** The plan windows Claude Code has reported in this chat's rate-limit events; none until it reports one, and never invented. */
	async usageLimits(): Promise<readonly ClaudeUsageWindow[] | undefined> {
		return this._limits.size > 0 ? [...this._limits.values()] : undefined;
	}

	/** Claude Code has no command to reconnect one server, so the process restarts with `--resume` before the next prompt. */
	async reconnectMcpServer(name: string): Promise<void> {
		this._requireOwnMcpServer(name);
		this._dirty = true;
	}

	/** A turned-off server is left out of `--mcp-config` when the process restarts with `--resume` before the next prompt. */
	async toggleMcpServer(name: string, enabled: boolean): Promise<void> {
		this._requireOwnMcpServer(name);
		if (enabled) {
			this._mcpOff.delete(name);
		} else {
			this._mcpOff.add(name);
		}
		this._dirty = true;
	}

	private _requireOwnMcpServer(name: string): void {
		if (!this._options.userMcpServers?.[name]) {
			throw new Error(localize('claudeMcpNotToggleable', "Klawly can only restart or turn off the MCP servers it passes to Claude Code. Change {0} in the file that defines it.", name));
		}
	}

	async stopTask(_taskId: string): Promise<void> {
		// Claude Code has no documented command to stop one background task; the runner marks the task stopped itself.
		throw new Error('This version of Klawly cannot stop a single background task. Stop the chat to end it.');
	}

	close(): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		this._killNow();
		this._bridge?.close();
		this._output.close();
	}

	/** The id of the subagent behind a tool call, from the PreToolUse hook. */
	rememberAgent(toolUseId: string, agentId: string): void {
		if (this._agentIds.size >= MAX_AGENT_IDS) {
			this._agentIds.delete(this._agentIds.keys().next().value!);
		}
		this._agentIds.set(toolUseId, agentId);
	}

	agentFor(toolUseId: string): string | undefined {
		return this._agentIds.get(toolUseId);
	}
}

const LIMIT_KINDS: Readonly<Record<string, ClaudeUsageWindowKind>> = { session: 'session', week: 'week', weekOpus: 'weekOpus', weekSonnet: 'weekSonnet' };

function textResult(value: unknown): ClaudeLocalToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function stringOf(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Wires the bridge for one query: Klawly's tools, the permission tool and the
 * hook routes. `agents` is the query's tool-use to subagent map.
 */
export async function createClaudeBridge(start: ClaudeQueryStart, agents: { remember(toolUseId: string, agentId: string): void; lookup(toolUseId: string): string | undefined }, host: string = '127.0.0.1'): Promise<{ readonly bridge: ClaudeLocalBridge; readonly mcpServers: Record<string, Record<string, unknown>>; readonly hooks: Record<string, unknown> }> {
	const options = start.options;
	const bridge = new ClaudeLocalBridge();
	await bridge.start();
	const port = bridge.port;
	const mcpServers: Record<string, Record<string, unknown>> = {};
	const klawly = await claudeKlawlyMcpServer(options.terminalTool, options.settingsTool, options.debugTool, options.canvasTool, options.delegateTool, options.noModelTool, options.modeTool, options.statusTool, options.departmentTool, options.feedbackTool, options.startAgentTool, options.reviewTool, options.browserTool);
	if (klawly) {
		bridge.addMcpServer(CLAUDE_KLAWLY_MCP_SERVER, klawly);
		mcpServers[CLAUDE_KLAWLY_MCP_SERVER] = { ...bridge.mcpConfig(CLAUDE_KLAWLY_MCP_SERVER, host, port) };
	}
	bridge.addMcpServer(CLAUDE_PERMISSION_MCP_SERVER, {
		tools: [{
			name: CLAUDE_PERMISSION_TOOL,
			description: 'Asks the user in Klawly whether Claude Code may run a tool.',
			inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
			alwaysLoad: false,
			async call(args, signal) {
				const toolName = stringOf(args.tool_name) ?? '';
				const input = typeof args.input === 'object' && args.input !== null ? args.input as Record<string, unknown> : {};
				const toolUseId = stringOf(args.tool_use_id);
				try {
					const decision = await options.canUseTool(toolName, input, { signal, toolUseID: toolUseId ?? '', agentId: toolUseId ? agents.lookup(toolUseId) : undefined });
					return textResult(decision.behavior === 'allow' ? { behavior: 'allow', updatedInput: decision.updatedInput ?? input } : { behavior: 'deny', message: decision.message });
				} catch (error) {
					return textResult({ behavior: 'deny', message: error instanceof Error ? error.message : 'Denied by the IDE: it could not check this request.' });
				}
			},
		}],
	});
	mcpServers[CLAUDE_PERMISSION_MCP_SERVER] = { ...bridge.mcpConfig(CLAUDE_PERMISSION_MCP_SERVER, host, port) };

	// The host's screen for every tool call. A failure becomes a denial, never a pass.
	bridge.addHook('PreToolUse', async input => {
		const toolInput = typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input as Record<string, unknown> : {};
		const toolUseId = stringOf(input.tool_use_id);
		const agentId = stringOf(input.agent_id);
		if (toolUseId && agentId) {
			agents.remember(toolUseId, agentId);
		}
		try {
			const verdict = await options.screenTool(stringOf(input.tool_name) ?? '', toolInput, toolUseId, agentId);
			if (!verdict) {
				return {};
			}
			return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: verdict.decision, permissionDecisionReason: verdict.message } };
		} catch {
			return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Denied by the IDE: it could not check this request.' } };
		}
	});
	const hooks: Record<string, unknown> = {
		PreToolUse: [{ hooks: [{ type: 'http', url: bridge.hookUrl('PreToolUse', host, port), timeout: 3600 }] }],
	};
	const onElicitation = options.onElicitation;
	if (onElicitation) {
		bridge.addHook('Elicitation', async (input, signal) => {
			const result = await onElicitation({
				serverName: stringOf(input.mcp_server_name) ?? '',
				message: stringOf(input.message) ?? '',
				mode: input.mode === 'url' ? 'url' : input.mode === 'form' ? 'form' : undefined,
				url: stringOf(input.url),
				elicitationId: stringOf(input.elicitation_id),
				requestedSchema: typeof input.requested_schema === 'object' && input.requested_schema !== null ? input.requested_schema as Record<string, unknown> : undefined,
			}, signal);
			return { hookSpecificOutput: { hookEventName: 'Elicitation', action: result.action, ...result.content ? { content: result.content } : {} } };
		});
		hooks.Elicitation = [{ hooks: [{ type: 'http', url: bridge.hookUrl('Elicitation', host, port), timeout: 3600 }] }];
	}
	return { bridge, mcpServers, hooks };
}

/**
 * Starts one query over the user's `claude` program. A dev container has no way
 * back to this machine's permission bridge, and Klawly never runs a session with
 * the prompts off or auto-allowed, so a dev container turn is refused.
 */
export const createClaudeCliQuery: ClaudeQueryFactory = async (start: ClaudeQueryStart) => {
	if (start.options.permissionMode === 'unasked') {
		start.options.log?.('Claude Code runs without permission prompts (Allow Everything in Agent mode).');
	}
	const target = start.options.executionTarget;
	if (target?.kind === 'devcontainer') {
		throw new Error(localize('claudeDevContainerRefused', "Klawly cannot ask for permission inside a dev container yet, so it does not run Claude Code there. Use the SSH or local target."));
	}
	const agents = { remember: (toolUseId: string, agentId: string) => query?.rememberAgent(toolUseId, agentId), lookup: (toolUseId: string) => query?.agentFor(toolUseId) };
	const wired = await createClaudeBridge(start, agents);
	const query: ClaudeCliQuery = new ClaudeCliQuery(start, wired.bridge, {
		args: (options, sessionId) => buildClaudeCliArguments(options, { bridgeMcpServers: wired.mcpServers, hooks: wired.hooks, permissionBridge: true }, sessionId),
		forwardPort: target?.kind === 'ssh' ? wired.bridge.port : undefined,
	});
	return query;
};
