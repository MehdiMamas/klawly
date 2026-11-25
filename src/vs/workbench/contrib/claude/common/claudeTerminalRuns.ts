/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** A `run_in_terminal` call that waits for the user in a terminal of this window (issue 452). */
export interface ClaudeTerminalRunView {
	readonly requestId: string;
	/** The runtime's session id, as on the tool call's events. */
	readonly runtimeSessionId: string;
	readonly command: string;
	/** What Claude told the user to do. */
	readonly reason?: string;
}

export const IClaudeTerminalRunService = createDecorator<IClaudeTerminalRunService>('claudeTerminalRunService');

/**
 * Runs Claude's interactive commands in visible terminals of the window that
 * owns the session, and answers the waiting tool call when each one ends.
 */
export interface IClaudeTerminalRunService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** Runs waiting for the user, oldest first. */
	readonly pending: readonly ClaudeTerminalRunView[];
	/** The waiting run for a running tool call, matched by session and command. */
	find(runtimeSessionId: string, command: string): ClaudeTerminalRunView | undefined;
	/** Shows and focuses the run's terminal. */
	open(requestId: string): Promise<void>;
	/** Stops the command and tells Claude the user cancelled. */
	cancel(requestId: string): void;
}
