/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { CLAUDE_AGENT_ENABLED_SETTING, readClaudeAgentEnabled } from '../../../../platform/claude/common/claudeConfiguration.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { IClaudeReviewService } from '../../../services/claude/common/claudeReview.js';
import { claudeCommandState } from '../common/claudeCommandState.js';
import { CLAUDE_AGENT_DISABLED, CLAUDE_AGENT_RUNNING, CLAUDE_HAS_OTHER_SESSIONS, CLAUDE_HAS_PENDING_CHANGES, CLAUDE_HAS_RUNNING_SUBAGENT, CLAUDE_HAS_SUBAGENTS, CLAUDE_HAS_TURNS, CLAUDE_REVIEW_PENDING_FILES } from '../common/claudeContextKeys.js';

/**
 * Mirrors `claude.agent.enabled` into a context key before views are laid out,
 * so the Agent views, commands and keys hide when it is off. Reads one setting.
 */
export class ClaudeAgentEnabledContextContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeAgentEnabledContext';

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();
		const disabled = CLAUDE_AGENT_DISABLED.bindTo(contextKeyService);
		const update = () => disabled.set(!readClaudeAgentEnabled(configurationService.getValue(CLAUDE_AGENT_ENABLED_SETTING)));
		update();
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_AGENT_ENABLED_SETTING)) {
				update();
			}
		}));
	}
}

/** Keeps the context keys behind the spec 45 command preconditions in step with the current agent session. */
export class ClaudeCommandContextContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeCommandContext';

	private readonly _running: IContextKey<boolean>;
	private readonly _hasTurns: IContextKey<boolean>;
	private readonly _hasPendingChanges: IContextKey<boolean>;
	private readonly _pendingFiles: IContextKey<string[]>;
	private readonly _hasSubagents: IContextKey<boolean>;
	private readonly _hasRunningSubagent: IContextKey<boolean>;
	private readonly _hasOtherSessions: IContextKey<boolean>;

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeReviewService private readonly _review: IClaudeReviewService,
	) {
		super();
		this._running = CLAUDE_AGENT_RUNNING.bindTo(contextKeyService);
		this._hasTurns = CLAUDE_HAS_TURNS.bindTo(contextKeyService);
		this._hasPendingChanges = CLAUDE_HAS_PENDING_CHANGES.bindTo(contextKeyService);
		this._pendingFiles = CLAUDE_REVIEW_PENDING_FILES.bindTo(contextKeyService);
		this._hasSubagents = CLAUDE_HAS_SUBAGENTS.bindTo(contextKeyService);
		this._hasRunningSubagent = CLAUDE_HAS_RUNNING_SUBAGENT.bindTo(contextKeyService);
		this._hasOtherSessions = CLAUDE_HAS_OTHER_SESSIONS.bindTo(contextKeyService);
		this._register(this._agent.onDidChangeSession(() => this.update()));
		this._register(this._agent.onDidChangeViewState(change => {
			if (change.sessionId === this._agent.getCurrentSession()?.id) {
				this.update();
			}
		}));
		// Keep All and Undo All cover every chat, so any chat's review counts (issue 706).
		this._register(this._review.onDidChangeReview(() => this.update()));
		this.update();
	}

	private update(): void {
		const session = this._agent.getCurrentSession();
		const view = session ? this._agent.getViewState(session.id) : undefined;
		const state = claudeCommandState(view?.turns ?? [], view?.subagents ?? [], session ? this._review.reviewsFor(session.id) : []);
		this._running.set(state.running);
		this._hasTurns.set(state.hasTurns);
		const pending = this._review.pendingSummary({ kind: 'all' });
		this._hasPendingChanges.set(pending.hunks > 0);
		this._pendingFiles.set(pending.uris.map(uri => uri.toString()));
		this._hasSubagents.set(state.hasSubagents);
		this._hasRunningSubagent.set(state.hasRunningSubagent);
		this._hasOtherSessions.set(this._agent.getSessions().some(candidate => candidate.id !== session?.id));
	}
}
