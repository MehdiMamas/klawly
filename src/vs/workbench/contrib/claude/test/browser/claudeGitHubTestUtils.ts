/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { ClaudeGitHubReference } from '../../../../../platform/claude/common/claudeProtocol.js';
import { IClaudeGitHubDetailsService } from '../../browser/chat/claudeGitHubDetails.js';
import { IClaudeTendPullRequestService } from '../../browser/chat/claudeTendPullRequest.js';
import { ClaudeGitHubDetailsState } from '../../common/claudeGitHubCards.js';

/** GitHub details double whose answers a test sets per session and URL. Records what it was asked to do. */
export class TestClaudeGitHubDetailsService implements IClaudeGitHubDetailsService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidChange = new Emitter<{ readonly sessionId: string; readonly url: string }>();
	readonly onDidChange = this._onDidChange.event;
	private readonly _states = new Map<string, ClaudeGitHubDetailsState>();
	readonly calls: string[] = [];

	get(sessionId: string, reference: ClaudeGitHubReference): ClaudeGitHubDetailsState {
		return this._states.get(`${sessionId} ${reference.url}`) ?? { status: 'loading' };
	}

	set(sessionId: string, url: string, state: ClaudeGitHubDetailsState): void {
		this._states.set(`${sessionId} ${url}`, state);
		this._onDidChange.fire({ sessionId, url });
	}

	async signIn(): Promise<void> { this.calls.push('signIn'); }
	async open(reference: ClaudeGitHubReference): Promise<void> { this.calls.push(`open ${reference.url}`); }

	dispose(): void {
		this._onDidChange.dispose();
	}
}

/** A GitHub details service that never answers, for tests that don't look at cards or pills. */
export function silentGitHubDetailsService(): IClaudeGitHubDetailsService {
	return {
		_serviceBrand: undefined,
		onDidChange: Event.None,
		get: () => ({ status: 'unavailable' }),
		signIn: async () => undefined,
		open: async () => undefined,
	};
}

/** A Tend This PR service that is never tending and never ended, for tests that render a timeline but don't look at the tend notice. */
export function silentTendService(): IClaudeTendPullRequestService {
	return {
		_serviceBrand: undefined,
		onDidChange: Event.None,
		isTending: () => false,
		tending: () => [],
		lastEnd: () => undefined,
		start: async () => undefined,
		stop: () => undefined,
	};
}
