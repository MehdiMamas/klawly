/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { AgentViewState, describePermissionPrompt, permissionsForTimeline, TurnStatus } from '../../../services/claude/common/claudeAgentState.js';

/** One sentence for a screen reader. `urgent` sentences are read as alerts. */
export interface ClaudeAnnouncement {
	readonly text: string;
	readonly urgent: boolean;
}

/** What one flush hands to the screen reader: at most one polite and one urgent message. */
export interface ClaudeAnnouncementBatch {
	readonly polite?: string;
	readonly urgent?: string;
}

/**
 * Turns agent view-state changes into short sentences (spec 49): a turn started,
 * a tool needs approval, a turn finished with a summary. It never reads the
 * streamed assistant text, so tokens are never announced.
 *
 * `observe` diffs against the last state of the same session. The first state of
 * a session, and a state that adds several turns at once (history loaded), are
 * remembered without announcing anything.
 */
export class ClaudeAnnouncementTracker {
	private _sessionId: string | undefined;
	private readonly _status = new Map<string, TurnStatus>();
	private readonly _askedPermissions = new Set<string>();

	observe(sessionId: string, state: AgentViewState): ClaudeAnnouncement[] {
		const newTurns = state.turns.filter(turn => !this._status.has(turn.id));
		const seed = sessionId !== this._sessionId || newTurns.length > 1;
		if (sessionId !== this._sessionId) {
			this._sessionId = sessionId;
			this._status.clear();
			this._askedPermissions.clear();
		}
		const out: ClaudeAnnouncement[] = [];
		for (const turn of state.turns) {
			const previous = this._status.get(turn.id);
			this._status.set(turn.id, turn.status);
			const pending = permissionsForTimeline(turn, state.subagents, undefined).filter(entry => entry.state === 'pending');
			for (const entry of pending) {
				if (!this._askedPermissions.has(entry.id)) {
					this._askedPermissions.add(entry.id);
					if (!seed) {
						out.push({ text: localize('claudeAnnounceApproval', "Approval needed: {0}", describePermissionPrompt(entry)), urgent: true });
					}
				}
			}
			if (seed || previous === turn.status) {
				continue;
			}
			if (turn.status === 'running') {
				out.push({ text: localize('claudeAnnounceStarted', "Agent started working."), urgent: false });
				continue;
			}
			if (previous === undefined && turn !== state.turns.at(-1)) {
				continue;
			}
			switch (turn.status) {
				case 'complete': {
					const files = turn.changedFiles.length;
					const text = turn.plan
						? localize('claudeAnnouncePlan', "Agent finished. A plan is ready to review.")
						: files === 1
							? localize('claudeAnnounceDoneOneFile', "Agent finished. 1 file changed.")
							: files > 1
								? localize('claudeAnnounceDoneFiles', "Agent finished. {0} files changed.", files)
								: localize('claudeAnnounceDone', "Agent finished.");
					out.push({ text, urgent: false });
					break;
				}
				case 'failed':
					// The failure banner is an alert with the details; this only marks the end.
					out.push({ text: localize('claudeAnnounceFailed', "Agent turn failed."), urgent: false });
					break;
				case 'stopped':
					out.push({ text: localize('claudeAnnounceStopped', "Agent stopped. Partial output is kept."), urgent: false });
					break;
			}
		}
		return out;
	}
}

/**
 * Collects sentences between flushes and joins them, so a burst of changes is
 * read as one message instead of interrupting itself. Repeated sentences in one
 * batch are read once.
 */
export class ClaudeAnnouncementBatcher {
	private _polite: string[] = [];
	private _urgent: string[] = [];

	get hasPending(): boolean {
		return this._polite.length > 0 || this._urgent.length > 0;
	}

	get hasUrgent(): boolean {
		return this._urgent.length > 0;
	}

	add(announcements: readonly ClaudeAnnouncement[]): void {
		for (const announcement of announcements) {
			const list = announcement.urgent ? this._urgent : this._polite;
			if (!list.includes(announcement.text)) {
				list.push(announcement.text);
			}
		}
	}

	flush(): ClaudeAnnouncementBatch {
		const batch: ClaudeAnnouncementBatch = {
			polite: this._polite.length > 0 ? this._polite.join(' ') : undefined,
			urgent: this._urgent.length > 0 ? this._urgent.join(' ') : undefined,
		};
		this._polite = [];
		this._urgent = [];
		return batch;
	}
}
