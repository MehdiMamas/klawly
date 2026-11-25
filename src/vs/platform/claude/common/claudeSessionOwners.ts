/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * N5, one session one owner: a session id is owned by at most one CLI process.
 * A second view that asks for the same id follows the owner instead of starting another process.
 */
export class ClaudeSessionOwners<TOwner> {

	private readonly owners = new Map<string, TOwner>();

	/** Returns the owner that already holds the session, or `undefined` after `create` made the caller the owner. */
	claim(sessionId: string, create: () => TOwner): { owner: TOwner; followed: boolean } {
		const existing = this.owners.get(sessionId);
		if (existing !== undefined) {
			return { owner: existing, followed: true };
		}
		const owner = create();
		this.owners.set(sessionId, owner);
		return { owner, followed: false };
	}

	get(sessionId: string): TOwner | undefined {
		return this.owners.get(sessionId);
	}

	/** Releases the session only if `owner` still holds it, so a late exit of an old process cannot free a newer owner. */
	release(sessionId: string, owner: TOwner): void {
		if (this.owners.get(sessionId) === owner) {
			this.owners.delete(sessionId);
		}
	}

	ids(): string[] {
		return [...this.owners.keys()];
	}
}
