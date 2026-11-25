/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ClaudeAgentIdentity, ClaudeFilePets, ClaudeFileTouchState, claudeFilePets, claudeFileTouchAgentDone, claudeFileTouchEnd, claudeFileTouchReviewed, claudeFileTouchStart, EMPTY_CLAUDE_FILE_TOUCH_STATE } from '../../../../platform/claude/common/claudeAgentFileTouch.js';
import { NormalizedClaudeEvent, ToolCall } from '../../../../platform/claude/common/claudeProtocol.js';
import { IClaudeAgentService } from './claudeAgentService.js';

export const IClaudeFileTouchService = createDecorator<IClaudeFileTouchService>('claudeFileTouchService');

/**
 * Which agents are editing which files right now, and who changed a file last (issue 1176).
 * It follows the agent's tool events, so every chat and every subagent shows up.
 */
export interface IClaudeFileTouchService {
	readonly _serviceBrand: undefined;
	/** Fires with the paths whose pets changed. */
	readonly onDidChange: Event<readonly string[]>;
	readonly state: ClaudeFileTouchState;
	/** The pets of one file, by the path the agent edited (a worktree path counts as its main file). */
	petsOf(path: string): ClaudeFilePets;
	/** The user reviewed the file: its changed-by mark goes. */
	markReviewed(path: string): void;
}

/** One agent: a chat's main thread, or a subagent run inside it. */
interface TrackedAgent {
	readonly identity: ClaudeAgentIdentity;
}

export class ClaudeFileTouchService extends Disposable implements IClaudeFileTouchService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<readonly string[]>());
	readonly onDidChange = this._onDidChange.event;

	private _state: ClaudeFileTouchState = EMPTY_CLAUDE_FILE_TOUCH_STATE;
	/** Edit calls in flight, by runtime session and call id, kept for the matching completion. */
	private readonly _calls = new Map<string, { readonly agent: TrackedAgent; readonly call: ToolCall }>();
	/** Subagent runs by run id, so their edits carry the run's description. */
	private readonly _runs = new Map<string, string>();

	constructor(@IClaudeAgentService agentService: IClaudeAgentService) {
		super();
		this._register(agentService.onDidReceiveEvent(event => this.onEvent(event)));
	}

	get state(): ClaudeFileTouchState {
		return this._state;
	}

	petsOf(path: string): ClaudeFilePets {
		return claudeFilePets(this._state, path);
	}

	markReviewed(path: string): void {
		const next = claudeFileTouchReviewed(this._state, path);
		this.apply(next, [path]);
	}

	private agentOf(event: NormalizedClaudeEvent): TrackedAgent {
		if (event.parentRunId) {
			return { identity: { agentId: `${event.sessionId}:${event.parentRunId}`, name: this._runs.get(event.parentRunId) ?? localize('claudeFileTouchSubagent', "Subagent") } };
		}
		return { identity: { agentId: event.sessionId, name: localize('claudeFileTouchClaude', "Claude") } };
	}

	private onEvent(event: NormalizedClaudeEvent): void {
		switch (event.type) {
			case 'subagent.started':
				this._runs.set(event.run.id, event.run.description);
				return;
			case 'tool.started': {
				const agent = this.agentOf(event);
				const next = claudeFileTouchStart(this._state, agent.identity, event.call.name, event.call.input, Date.now());
				if (next !== this._state) {
					this._calls.set(`${event.sessionId}:${event.call.id}`, { agent, call: event.call });
					this.apply(next);
				}
				return;
			}
			case 'tool.completed': {
				const key = `${event.sessionId}:${event.callId}`;
				const entry = this._calls.get(key);
				if (entry) {
					this._calls.delete(key);
					this.apply(claudeFileTouchEnd(this._state, entry.agent.identity, entry.call.name, entry.call.input, event.result.ok));
				}
				return;
			}
			case 'subagent.finished':
				this._runs.delete(event.runId);
				this.agentDone(`${event.sessionId}:${event.runId}`);
				return;
			case 'session.completed':
			case 'session.failed':
				this.agentDone(event.sessionId);
				return;
		}
	}

	/** An agent that stopped no longer edits anything, whatever its calls reported. */
	private agentDone(agentId: string): void {
		for (const [key, entry] of this._calls) {
			if (entry.agent.identity.agentId === agentId) {
				this._calls.delete(key);
			}
		}
		this.apply(claudeFileTouchAgentDone(this._state, agentId));
	}

	private apply(next: ClaudeFileTouchState, paths?: readonly string[]): void {
		if (next === this._state) {
			return;
		}
		const previous = this._state;
		this._state = next;
		const changed = paths ?? changedPaths(previous, next);
		if (changed.length > 0) {
			this._onDidChange.fire(changed);
		}
	}
}

/** The paths whose active touches or changed-by mark differ between two states. */
function changedPaths(before: ClaudeFileTouchState, after: ClaudeFileTouchState): string[] {
	const paths = new Set<string>();
	for (const map of [before.active, after.active]) {
		for (const path of map.keys()) {
			if (before.active.get(path)?.size !== after.active.get(path)?.size) {
				paths.add(path);
			}
		}
	}
	for (const map of [before.changed, after.changed]) {
		for (const path of map.keys()) {
			if (before.changed.get(path) !== after.changed.get(path)) {
				paths.add(path);
			}
		}
	}
	return [...paths];
}
