/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A saved answer to "may this extension start a Klawly agent?" (issue 860). */
export interface ClaudeExtensionAgentGrant {
	readonly extensionId: string;
	readonly allowed: boolean;
	/** Epoch milliseconds of the answer. */
	readonly decidedAt: number;
}

/** Parses the stored grants; anything malformed is dropped, so a damaged value never blocks the API. */
export function parseClaudeExtensionAgentGrants(raw: string | undefined): readonly ClaudeExtensionAgentGrant[] {
	if (!raw) {
		return [];
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set<string>();
	const grants: ClaudeExtensionAgentGrant[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') {
			continue;
		}
		const { extensionId, allowed, decidedAt } = entry as Record<string, unknown>;
		if (typeof extensionId !== 'string' || !extensionId || typeof allowed !== 'boolean' || seen.has(extensionId.toLowerCase())) {
			continue;
		}
		seen.add(extensionId.toLowerCase());
		grants.push({ extensionId, allowed, decidedAt: typeof decidedAt === 'number' ? decidedAt : 0 });
	}
	return grants;
}

export function serializeClaudeExtensionAgentGrants(grants: readonly ClaudeExtensionAgentGrant[]): string {
	return JSON.stringify(grants);
}

/** Finds the grant of an extension; identifiers compare case-insensitively like extension ids do. */
export function findClaudeExtensionAgentGrant(grants: readonly ClaudeExtensionAgentGrant[], extensionId: string): ClaudeExtensionAgentGrant | undefined {
	const key = extensionId.toLowerCase();
	return grants.find(grant => grant.extensionId.toLowerCase() === key);
}

/** Returns the grants without this extension; its next call asks again. */
export function revokeClaudeExtensionAgentGrant(grants: readonly ClaudeExtensionAgentGrant[], extensionId: string): readonly ClaudeExtensionAgentGrant[] {
	const key = extensionId.toLowerCase();
	return grants.filter(grant => grant.extensionId.toLowerCase() !== key);
}

/** Returns the grants with this extension's answer set, replacing an earlier one. */
export function withClaudeExtensionAgentGrant(grants: readonly ClaudeExtensionAgentGrant[], grant: ClaudeExtensionAgentGrant): readonly ClaudeExtensionAgentGrant[] {
	return [...revokeClaudeExtensionAgentGrant(grants, grant.extensionId), grant];
}

/** Where the gate keeps its grants; the workbench service backs it with application storage. */
export interface IClaudeExtensionAgentGrantStorage {
	read(): string | undefined;
	write(value: string | undefined): void;
}

/**
 * Decides whether an extension may start an agent: a saved answer is reused, otherwise the
 * user is asked once and the answer is saved. Concurrent first calls from one extension share
 * one prompt. A prompt that throws saves nothing and counts as a denial for that call.
 */
export class ClaudeExtensionAgentGate {
	private readonly _pending = new Map<string, Promise<boolean>>();

	constructor(
		private readonly _storage: IClaudeExtensionAgentGrantStorage,
		private readonly _ask: (extensionId: string) => Promise<boolean>,
		private readonly _now: () => number = Date.now,
	) { }

	list(): readonly ClaudeExtensionAgentGrant[] {
		return parseClaudeExtensionAgentGrants(this._storage.read());
	}

	revoke(extensionId: string): void {
		const next = revokeClaudeExtensionAgentGrant(this.list(), extensionId);
		this._storage.write(next.length ? serializeClaudeExtensionAgentGrants(next) : undefined);
	}

	async isAllowed(extensionId: string): Promise<boolean> {
		const saved = findClaudeExtensionAgentGrant(this.list(), extensionId);
		if (saved) {
			return saved.allowed;
		}
		const key = extensionId.toLowerCase();
		let pending = this._pending.get(key);
		if (!pending) {
			pending = this.askAndSave(extensionId).finally(() => this._pending.delete(key));
			this._pending.set(key, pending);
		}
		return pending;
	}

	private async askAndSave(extensionId: string): Promise<boolean> {
		let allowed: boolean;
		try {
			allowed = await this._ask(extensionId);
		} catch {
			return false;
		}
		this._storage.write(serializeClaudeExtensionAgentGrants(withClaudeExtensionAgentGrant(this.list(), { extensionId, allowed, decidedAt: this._now() })));
		return allowed;
	}
}
