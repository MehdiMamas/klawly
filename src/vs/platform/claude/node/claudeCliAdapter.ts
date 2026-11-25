/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { NormalizedClaudeEvent } from '../common/claudeProtocol.js';
import { ClaudeAgentRunRequest, ClaudeAgentRunner, ClaudeCapabilities } from './claudeAgentRunner.js';

export interface InternalRunRequest extends ClaudeAgentRunRequest { }

/**
 * The runtime's front for one agent run. Klawly drives the user's own Claude
 * Code program (see `claudeCliQuery.ts`); this class only forwards to the runner.
 */
export class ClaudeCliAdapter {
	constructor(private readonly _runner: ClaudeAgentRunner) { }

	start(request: InternalRunRequest): AsyncIterable<NormalizedClaudeEvent> {
		return this._runner.start(request);
	}

	cancel(sessionId: string): Promise<void> {
		return this._runner.interrupt(sessionId);
	}

	capabilities(): Promise<ClaudeCapabilities> {
		return this._runner.capabilities();
	}
}
