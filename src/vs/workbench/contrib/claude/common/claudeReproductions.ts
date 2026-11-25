/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** A Debug-mode reproduction that waits for the user in this window (issue 484). */
export interface ClaudeReproductionView {
	readonly requestId: string;
	/** The runtime's session id, as on the tool call's events. */
	readonly runtimeSessionId: string;
	/** Claude's steps to reproduce. */
	readonly steps?: string;
	/** True once the user pressed Start Capturing. */
	readonly capturing: boolean;
}

export const IClaudeReproductionService = createDecorator<IClaudeReproductionService>('claudeReproductionService');

/**
 * Holds the reproductions Claude asked for in Debug mode and answers each
 * waiting tool call once: with the captured log lines, or a cancel.
 */
export interface IClaudeReproductionService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** The newest reproduction waiting in a runtime session. */
	find(runtimeSessionId: string): ClaudeReproductionView | undefined;
	/** Start Capturing: the log sink keeps what the instrumentation posts from now on. */
	start(requestId: string): void;
	/** I Reproduced It: the captured lines go back to Claude. */
	finish(requestId: string): void;
	/** Cancel: Claude hears the user cancelled. */
	cancel(requestId: string): void;
}
