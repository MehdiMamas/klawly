/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ClaudeAutomation, ClaudeAutomationRun, claudeAutomationScheduleCheck, ClaudeAutomationScheduleCheck } from '../../../../platform/claude/common/claudeAutomation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/** How long a runner window's claim lasts without a heartbeat. */
export const CLAUDE_AUTOMATION_LEASE_MS = 60 * 1000;

/** How often the runner renews its claim and the other windows look for a free one. Each window adds up to a quarter of it at random. */
export const CLAUDE_AUTOMATION_HEARTBEAT_MS = 20 * 1000;

/** The group of the user's automations. A workspace folder's group is `claudeAutomationWorkspaceGroup(folder)`. */
export const CLAUDE_AUTOMATION_USER_GROUP = 'user';

const LEASE_KEY_PREFIX = 'claude.automations.lease:';
export const CLAUDE_AUTOMATION_STATE_KEY_PREFIX = 'claude.automations.state:';

export function claudeAutomationWorkspaceGroup(folder: string): string {
	return `workspace:${folder}`;
}

interface StoredLease {
	readonly owner: string;
	readonly expires: number;
}

/** Last check and last run of each automation of one group, shared by every window. */
export interface ClaudeAutomationGroupState {
	readonly lastCheck?: number;
	readonly runs?: Readonly<Record<string, ClaudeAutomationRun>>;
}

/**
 * Elects one window to run a group's schedules, so a schedule starts once
 * however many windows are open. The claim is a lease in application storage,
 * which every window of this Klawly shares and sees change. The runner renews
 * it each heartbeat; when the runner closes or stops renewing, another window
 * takes it once it expires (or at once when the runner gave it up).
 *
 * Storage has no compare-and-set, so two windows can claim at the same time.
 * A claim therefore counts only from the next heartbeat, when the stored lease
 * still names this window: by then every window has seen the last write, and
 * at most one of them finds its own name.
 */
export class ClaudeAutomationLease {
	private _claimed = false;
	private _confirmed = false;

	constructor(
		readonly group: string,
		private readonly _owner: string,
		private readonly _storage: IStorageService,
		private readonly _now: () => number,
	) { }

	get key(): string {
		return `${LEASE_KEY_PREFIX}${this.group}`;
	}

	/** Claims a free or expired lease, or renews this window's. True while this window is the runner. */
	heartbeat(): boolean {
		const now = this._now();
		const current = this.read();
		if (current && current.owner !== this._owner && current.expires > now) {
			this._claimed = this._confirmed = false;
			return false;
		}
		this._confirmed = this._claimed && current?.owner === this._owner;
		this._claimed = true;
		this._storage.store(this.key, JSON.stringify({ owner: this._owner, expires: now + CLAUDE_AUTOMATION_LEASE_MS } satisfies StoredLease), StorageScope.APPLICATION, StorageTarget.MACHINE);
		return this._confirmed;
	}

	/** True when this window confirmed its claim and the lease still names it. */
	holds(): boolean {
		const current = this.read();
		return this._confirmed && current?.owner === this._owner && current.expires > this._now();
	}

	/** Gives the lease up, so another window takes over without waiting for it to expire. */
	release(): void {
		if (this.read()?.owner === this._owner) {
			this._storage.remove(this.key, StorageScope.APPLICATION);
		}
		this._claimed = this._confirmed = false;
	}

	private read(): StoredLease | undefined {
		try {
			const value = JSON.parse(this._storage.get(this.key, StorageScope.APPLICATION, 'null'));
			return value && typeof value.owner === 'string' && typeof value.expires === 'number' ? value : undefined;
		} catch {
			return undefined;
		}
	}
}

/**
 * The cross-window part of automations (issue 426): one lease per group (the
 * user's automations, and each workspace folder's), and each group's last
 * check and runs in application storage. Only the window that holds a group's
 * lease checks its schedules, advances its last check and reports what was
 * missed, so each schedule starts once and a missed notice shows once.
 * Timers belong to the caller; the clock and storage are injected.
 */
export class ClaudeAutomationScheduler extends Disposable {
	private readonly _leases = new Map<string, ClaudeAutomationLease>();

	constructor(
		private readonly _owner: string,
		private readonly _storage: IStorageService,
		private readonly _now: () => number,
	) {
		super();
		this._register(toDisposable(() => this.setGroups([])));
	}

	/** The groups this window takes part in. Leases of the groups left out are given up. */
	setGroups(groups: readonly string[]): void {
		for (const [group, lease] of this._leases) {
			if (!groups.includes(group)) {
				lease.release();
				this._leases.delete(group);
			}
		}
		for (const group of groups) {
			if (!this._leases.has(group)) {
				this._leases.set(group, new ClaudeAutomationLease(group, this._owner, this._storage, this._now));
			}
		}
	}

	/** The group whose lease lives in `key`, if this window takes part in it. */
	groupOfLeaseKey(key: string): string | undefined {
		return [...this._leases.values()].find(lease => lease.key === key)?.group;
	}

	/** Renews or claims every lease. Returns the groups this window just became the runner of. */
	heartbeat(groups: readonly string[] = [...this._leases.keys()]): string[] {
		const gained: string[] = [];
		for (const group of groups) {
			const lease = this._leases.get(group);
			if (!lease) {
				continue;
			}
			const held = lease.holds();
			if (lease.heartbeat() && !held) {
				gained.push(group);
			}
		}
		return gained;
	}

	holds(group: string): boolean {
		return this._leases.get(group)?.holds() === true;
	}

	/**
	 * The runner's check of a group: what fell due since its last check, to
	 * run now or, after a long gap, to offer as missed. Advances the last check
	 * even while automations are off, so turning them on never reports the
	 * time they were off as missed. Empty in a window that is not the runner.
	 */
	check<T extends ClaudeAutomation>(group: string, automations: readonly T[], enabled: boolean): ClaudeAutomationScheduleCheck<T> {
		if (!this.holds(group)) {
			return { run: [], missed: [] };
		}
		const now = this._now();
		const state = this.getState(group);
		this.writeState(group, { ...state, lastCheck: now });
		return enabled ? claudeAutomationScheduleCheck(automations, state.lastCheck, now) : { run: [], missed: [] };
	}

	getState(group: string): ClaudeAutomationGroupState {
		try {
			const value = JSON.parse(this._storage.get(`${CLAUDE_AUTOMATION_STATE_KEY_PREFIX}${group}`, StorageScope.APPLICATION, '{}'));
			return value && typeof value === 'object' ? value as ClaudeAutomationGroupState : {};
		} catch {
			return {};
		}
	}

	record(group: string, run: ClaudeAutomationRun): void {
		const state = this.getState(group);
		this.writeState(group, { ...state, runs: { ...state.runs, [run.automationKey]: run } });
	}

	private writeState(group: string, state: ClaudeAutomationGroupState): void {
		this._storage.store(`${CLAUDE_AUTOMATION_STATE_KEY_PREFIX}${group}`, JSON.stringify(state), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}
}
