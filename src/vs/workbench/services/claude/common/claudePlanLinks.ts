/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export const IClaudePlanLinks = createDecorator<IClaudePlanLinks>('claudePlanLinks');

/** `author`: the chat whose answer became the plan file. `build`: a chat that built it. */
export type PlanLinkRole = 'author' | 'build';

export interface PlanLink {
	readonly sessionId: string;
	/** The chat's title when it was linked, for a chat that is closed by now. */
	readonly title: string;
	readonly role: PlanLinkRole;
}

/**
 * Which chats wrote or built each plan file, for the plan editor's "Referenced by"
 * section. Kept per profile, like the user plans folder the plan files are in, so
 * every window sees them; a plan file keeps at most {@link MAX_LINKS} chats.
 */
export interface IClaudePlanLinks {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<URI>;
	links(plan: URI): readonly PlanLink[];
	/** The author chat of a plan file, if it is known. */
	author(plan: URI): PlanLink | undefined;
	/** Links a chat to a plan file. Linking it again with another role adds that role; the newest link comes first. */
	link(plan: URI, link: PlanLink): void;
	/** Moves the chat links of `from` to `to`, for a plan file that moved; they come before links `to` already had. */
	move(from: URI, to: URI): void;
}

const STORAGE_KEY = 'klawly.plan.links';
const MAX_LINKS = 20;
const MAX_PLANS = 200;

export class ClaudePlanLinks extends Disposable implements IClaudePlanLinks {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<URI>());
	readonly onDidChange = this._onDidChange.event;

	private _links: Map<string, PlanLink[]> | undefined;

	constructor(@IStorageService private readonly _storage: IStorageService) {
		super();
		this._register(this._storage.onDidChangeValue(StorageScope.PROFILE, STORAGE_KEY, this._store)(() => {
			this._links = undefined;
		}));
	}

	links(plan: URI): readonly PlanLink[] {
		return this.read().get(plan.toString()) ?? [];
	}

	author(plan: URI): PlanLink | undefined {
		return this.links(plan).find(link => link.role === 'author');
	}

	link(plan: URI, link: PlanLink): void {
		const all = this.read();
		const key = plan.toString();
		const rest = (all.get(key) ?? []).filter(existing => existing.sessionId !== link.sessionId || existing.role !== link.role);
		all.delete(key);
		all.set(key, [link, ...rest].slice(0, MAX_LINKS));
		this.write(plan);
	}

	move(from: URI, to: URI): void {
		const all = this.read();
		const moved = all.get(from.toString());
		if (!moved) {
			return;
		}
		const key = to.toString();
		const rest = (all.get(key) ?? []).filter(existing => !moved.some(link => link.sessionId === existing.sessionId && link.role === existing.role));
		all.delete(from.toString());
		all.delete(key);
		all.set(key, [...moved, ...rest].slice(0, MAX_LINKS));
		this.write(from, to);
	}

	private write(...changed: URI[]): void {
		const all = this.read();
		while (all.size > MAX_PLANS) {
			all.delete(all.keys().next().value!);
		}
		this._storage.store(STORAGE_KEY, JSON.stringify([...all]), StorageScope.PROFILE, StorageTarget.MACHINE);
		for (const plan of changed) {
			this._onDidChange.fire(plan);
		}
	}

	private read(): Map<string, PlanLink[]> {
		if (!this._links) {
			const links = parseLinks(this._storage.get(STORAGE_KEY, StorageScope.PROFILE, '[]'));
			this._links = links;
			// Links were kept per workspace before; fold this workspace's into the profile once.
			const legacy = this._storage.get(STORAGE_KEY, StorageScope.WORKSPACE);
			if (legacy !== undefined) {
				for (const [plan, moved] of parseLinks(legacy)) {
					const kept = links.get(plan) ?? [];
					links.set(plan, [...kept, ...moved.filter(link => !kept.some(existing => existing.sessionId === link.sessionId && existing.role === link.role))].slice(0, MAX_LINKS));
				}
				this._storage.remove(STORAGE_KEY, StorageScope.WORKSPACE);
				this.write();
				this._links = links;
			}
		}
		return this._links;
	}
}

/** The links stored as `[plan, links][]` JSON. A damaged value only loses the "Referenced by" rows. */
function parseLinks(value: string): Map<string, PlanLink[]> {
	const links = new Map<string, PlanLink[]>();
	try {
		const stored: unknown = JSON.parse(value);
		if (Array.isArray(stored)) {
			for (const entry of stored) {
				if (Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1])) {
					links.set(entry[0], entry[1].filter(isPlanLink));
				}
			}
		}
	} catch {
		// Nothing to read.
	}
	return links;
}

function isPlanLink(value: unknown): value is PlanLink {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const link = value as Partial<PlanLink>;
	return typeof link.sessionId === 'string' && typeof link.title === 'string' && (link.role === 'author' || link.role === 'build');
}
