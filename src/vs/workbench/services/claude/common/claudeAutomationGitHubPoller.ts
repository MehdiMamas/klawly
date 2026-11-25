/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeAutomationEntry } from '../../../../platform/claude/common/claudeAutomation.js';
import { ClaudeAutomationGitHubTrigger, ClaudeGitHubApiResponse, ClaudeGitHubEvent, claudeGitHubEndpoints, matchesPullRequestFilters, ClaudeGitHubWatchState, claudeGitHubWatchUpdate, IClaudeGitHubApiService, isClaudeAutomationGitHubTrigger } from '../../../../platform/claude/common/claudeAutomationGitHub.js';

/** Most events a watch keeps while its automation is busy; the oldest go first. */
const MAX_PENDING_EVENTS = 50;

interface Watch {
	/** The trigger the watch was made for: an edited trigger starts a new baseline. */
	readonly signature: string;
	state: ClaudeGitHubWatchState;
	readonly etags: Map<string, string>;
	/** Events not yet given to a run. */
	pending: ClaudeGitHubEvent[];
}

/** One GitHub automation after a poll: what waits to start it, or why GitHub could not be read. */
export interface ClaudeAutomationGitHubPoll {
	readonly automation: ClaudeAutomationEntry;
	readonly pending: readonly ClaudeGitHubEvent[];
	readonly error?: string;
}

/**
 * Polls the GitHub triggers of automations (issue 518) through
 * {@link IClaudeGitHubApiService}, with an ETag per endpoint, and keeps what
 * each watch has seen. Events wait in the watch until the caller starts a run
 * with them ({@link consume}), so a trigger that fires while the automation is
 * still running is not lost. Timers and the runner election belong to the
 * caller.
 */
export class ClaudeAutomationGitHubPoller {
	private readonly _watches = new Map<string, Watch>();

	constructor(
		private readonly _api: IClaudeGitHubApiService,
		private readonly _now: () => number,
	) { }

	/** Polls every enabled GitHub automation in `automations` once and forgets the watches of the others. */
	async poll(automations: readonly ClaudeAutomationEntry[]): Promise<ClaudeAutomationGitHubPoll[]> {
		const watched = automations.filter((automation): automation is ClaudeAutomationEntry & { readonly trigger: ClaudeAutomationGitHubTrigger } => automation.enabled && isClaudeAutomationGitHubTrigger(automation.trigger));
		const keys = new Set(watched.map(automation => automation.key));
		for (const key of [...this._watches.keys()]) {
			if (!keys.has(key)) {
				this._watches.delete(key);
			}
		}
		const results: ClaudeAutomationGitHubPoll[] = [];
		for (const automation of watched) {
			const signature = JSON.stringify(automation.trigger);
			let watch = this._watches.get(automation.key);
			if (watch?.signature !== signature) {
				watch = { signature, state: { since: this._now() }, etags: new Map(), pending: [] };
				this._watches.set(automation.key, watch);
			}
			const error = await this.pollOne(automation.trigger, watch);
			results.push({ automation, pending: watch.pending, error });
		}
		return results;
	}

	/** Drops the first `count` pending events of an automation: a run now carries them. */
	consume(key: string, count: number): void {
		const watch = this._watches.get(key);
		if (watch) {
			watch.pending = watch.pending.slice(count);
		}
	}

	private async pollOne(trigger: ClaudeAutomationGitHubTrigger, watch: Watch): Promise<string | undefined> {
		// In order: a comment event reads the pull requests the same pass listed.
		for (const [name, endpoint] of Object.entries(claudeGitHubEndpoints(trigger))) {
			let response: ClaudeGitHubApiResponse;
			try {
				response = await this._api.get(endpoint, watch.etags.get(name));
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
			if (response.status === 304) {
				continue;
			}
			if (response.status !== 200) {
				return response.error ?? `HTTP ${response.status}`;
			}
			if (response.etag) {
				watch.etags.set(name, response.etag);
			}
			const update = claudeGitHubWatchUpdate(trigger, watch.state, name, response.body);
			watch.state = update.state;
			const events = await this.withoutIgnoredPaths(trigger, update.events);
			watch.pending = [...watch.pending, ...events].slice(-MAX_PENDING_EVENTS);
		}
		return undefined;
	}

	/** Drops the pull requests whose changed files are all in the trigger's `ignorePaths` (issue 924). A file list GitHub does not give keeps the event. */
	private async withoutIgnoredPaths(trigger: ClaudeAutomationGitHubTrigger, events: readonly ClaudeGitHubEvent[]): Promise<ClaudeGitHubEvent[]> {
		if (trigger.type !== 'githubPullRequest' || !trigger.ignorePaths?.length) {
			return [...events];
		}
		const kept: ClaudeGitHubEvent[] = [];
		for (const event of events) {
			if (event.kind !== 'pullRequest') {
				kept.push(event);
				continue;
			}
			let files: string[] | undefined;
			try {
				const response = await this._api.get(`repos/${trigger.repo}/pulls/${event.number}/files?per_page=100`);
				if (response.status === 200 && Array.isArray(response.body)) {
					files = response.body.map(item => (item && typeof item === 'object' ? (item as { readonly filename?: unknown }).filename : undefined)).filter((name): name is string => typeof name === 'string');
				}
			} catch {
				// Keep the event: a missed review is worse than an extra one.
			}
			if (matchesPullRequestFilters(trigger, event, files)) {
				kept.push(event);
			}
		}
		return kept;
	}
}
