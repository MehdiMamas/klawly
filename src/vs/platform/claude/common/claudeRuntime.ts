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
	readonly permissionMode?: 'default' | 'acceptEdits' | 'plan';
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
	| { readonly type: 'started'; readonly sessionId: string; readonly model?: string }
	| { readonly type: 'text'; readonly sessionId: string; readonly text: string }
	| { readonly type: 'toolUse'; readonly sessionId: string; readonly toolUseId: string; readonly name: string; readonly input: Record<string, unknown> }
	| { readonly type: 'toolResult'; readonly sessionId: string; readonly toolUseId: string; readonly output: string; readonly isError: boolean }
	| { readonly type: 'permission'; readonly sessionId: string; readonly requestId: string; readonly toolName: string; readonly input: Record<string, unknown>; readonly description?: string }
	| { readonly type: 'rateLimit'; readonly sessionId: string; readonly status: string; readonly resetsAt?: number }
	| { readonly type: 'result'; readonly sessionId: string; readonly isError: boolean; readonly text: string; readonly costUsd?: number; readonly usage?: IClaudeUsage }
	| { readonly type: 'error'; readonly sessionId: string; readonly message: string }
	| { readonly type: 'ended'; readonly sessionId: string; readonly exitCode: number | null };

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
	answerPermission(sessionId: string, requestId: string, allow: boolean, message?: string): Promise<void>;
	/** Interrupts the running turn; the session stays open. */
	stop(sessionId: string): Promise<void>;
	/** Ends the session's CLI process. The session can be resumed later. */
	close(sessionId: string): Promise<void>;
	/** Ids of sessions that currently have a CLI process (the owners). */
	getRunningSessions(): Promise<string[]>;
	/** Reads Claude Code settings with the documented precedence. */
	readSettings(cwd: string): Promise<IClaudeSettings>;
}
