/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IClaudeRuntimeService = createDecorator<IClaudeRuntimeService>('claudeRuntimeService');

/** IPC channel name the shared process registers the runtime under. */
export const CLAUDE_RUNTIME_CHANNEL = 'claudeRuntime';

/** Result of looking for the user's installed `claude` command. Never carries credentials. */
export interface IClaudeCliStatus {
	readonly found: boolean;
	readonly path?: string;
	/** For example `2.1.332`. */
	readonly version?: string;
	readonly error?: string;
}

export interface IClaudeSendRequest {
	/** Omit to start a new session; pass an id to resume it (or to follow its owner when it is already running). */
	readonly sessionId?: string;
	readonly cwd: string;
	readonly prompt: string;
	readonly model?: string;
	readonly permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
}

export interface IClaudeSendResult {
	readonly sessionId: string;
	/** `true` when the session was already running, so this call only followed its owner. */
	readonly followed: boolean;
}

export interface IClaudeUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
}

/**
 * The normalized protocol between the runtime and every view. Views never see the raw
 * stream-json lines of the Claude Code CLI.
 */
export type ClaudeEvent =
	| { readonly type: 'started'; readonly sessionId: string; readonly model?: string; readonly cwd?: string }
	/** The permission mode the CLI is in now: it changes when a plan is approved or the mode is switched. */
	| { readonly type: 'mode'; readonly sessionId: string; readonly mode: NonNullable<IClaudeSendRequest['permissionMode']> }
	| { readonly type: 'text'; readonly sessionId: string; readonly text: string }
	| { readonly type: 'toolUse'; readonly sessionId: string; readonly toolUseId: string; readonly name: string; readonly input: Record<string, unknown> }
	| { readonly type: 'toolResult'; readonly sessionId: string; readonly toolUseId: string; readonly output: string; readonly isError: boolean }
	| { readonly type: 'permission'; readonly sessionId: string; readonly requestId: string; readonly toolName: string; readonly input: Record<string, unknown>; readonly description?: string }
	| { readonly type: 'rateLimit'; readonly sessionId: string; readonly status: string; readonly resetsAt?: number }
	| { readonly type: 'result'; readonly sessionId: string; readonly isError: boolean; readonly text: string; readonly costUsd?: number; readonly usage?: IClaudeUsage }
	| { readonly type: 'error'; readonly sessionId: string; readonly message: string }
	| { readonly type: 'ended'; readonly sessionId: string; readonly exitCode: number | null };

/** One session the CLI keeps on disk for a folder (the Recent list of v5-S07). */
export interface IClaudeSessionInfo {
	readonly id: string;
	/** The first prompt of the session. */
	readonly title: string;
	/** Last change, in milliseconds since the epoch. */
	readonly modified: number;
	/** How many files the session edited or wrote. */
	readonly files: number;
}

/** One message of a stored session. */
export interface IClaudeTranscriptMessage {
	readonly role: 'user' | 'assistant';
	readonly text: string;
}

export interface IClaudeSettingsSource {
	readonly scope: 'user' | 'project' | 'local';
	readonly path: string;
	readonly loaded: boolean;
	readonly error?: string;
}

export interface IClaudeSettings {
	/** Merged settings, highest precedence applied last. */
	readonly settings: Record<string, unknown>;
	readonly sources: readonly IClaudeSettingsSource[];
}

export interface IClaudeRuntimeService {
	readonly _serviceBrand: undefined;

	/** Fires for every session; a view filters by session id. */
	readonly onDidEvent: Event<ClaudeEvent>;

	/** Finds `claude` on PATH and reads its version. Resolves with `found: false` when it is missing. */
	checkCli(): Promise<IClaudeCliStatus>;
	/** Starts, resumes or follows a session and queues the prompt as its next turn. */
	send(request: IClaudeSendRequest): Promise<IClaudeSendResult>;
	/** Answers a `permission` event. */
	answerPermission(sessionId: string, requestId: string, allow: boolean, message?: string, updatedInput?: Record<string, unknown>): Promise<void>;
	/** Interrupts the running turn and ends the CLI process when it does not stop by itself; the session can be resumed. */
	stop(sessionId: string): Promise<void>;
	/** Ends the session's CLI process. The session can be resumed later. */
	close(sessionId: string): Promise<void>;
	/** Ids of sessions that currently have a CLI process (the owners). */
	getRunningSessions(): Promise<string[]>;
	/** Ids of sessions that are working on a turn right now (a finished chat is not busy). */
	getBusySessions(): Promise<string[]>;
	/** Reads Claude Code settings with the documented precedence. */
	readSettings(cwd: string): Promise<IClaudeSettings>;
	/** Adds an allow rule such as `Bash(npm test *)` to the folder's `.claude/settings.local.json` (the "Always allow" button of v5-S13). */
	addAllowRule(cwd: string, rule: string): Promise<void>;
	/** Sessions the CLI stored for this folder, newest first. Read-only. */
	listSessions(cwd: string): Promise<IClaudeSessionInfo[]>;
	/** The messages of a stored session. Read-only. */
	readTranscript(cwd: string, sessionId: string): Promise<IClaudeTranscriptMessage[]>;
}
