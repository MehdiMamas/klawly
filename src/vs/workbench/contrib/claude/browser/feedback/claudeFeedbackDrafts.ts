/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ClaudeFeedbackDraft, ClaudeFeedbackUnsent, isEmptyClaudeFeedbackDraft, parseClaudeFeedbackDraft, serializeClaudeFeedbackDraft } from '../../common/claudeFeedback.js';

const DRAFT_KEY = 'klawly.feedback.draft';
const UNSENT_KEY = 'klawly.feedback.unsent';

/**
 * The Send Feedback reports kept on this machine: the draft of the form (issue 739) and the
 * reports whose background send failed (issue 735). Stored for the application, so a draft
 * started in one window opens in the next one and survives a restart.
 */
export class ClaudeFeedbackDrafts {

	constructor(private readonly _storage: IStorageService) { }

	get draft(): ClaudeFeedbackDraft | undefined {
		return parseClaudeFeedbackDraft(this.read(DRAFT_KEY));
	}

	/** Keeps `draft`, or forgets the saved one when it is undefined or has nothing written. */
	saveDraft(draft: ClaudeFeedbackDraft | undefined): void {
		if (!draft || isEmptyClaudeFeedbackDraft(draft)) {
			this._storage.remove(DRAFT_KEY, StorageScope.APPLICATION);
		} else {
			this._storage.store(DRAFT_KEY, JSON.stringify(serializeClaudeFeedbackDraft(draft)), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
	}

	get unsent(): readonly ClaudeFeedbackUnsent[] {
		const value = this.read(UNSENT_KEY);
		if (!Array.isArray(value)) {
			return [];
		}
		const unsent: ClaudeFeedbackUnsent[] = [];
		for (const entry of value as unknown[]) {
			const { id, draft, error, attachment } = (entry ?? {}) as Record<string, unknown>;
			const parsed = parseClaudeFeedbackDraft(draft);
			if (typeof id === 'string' && typeof error === 'string' && parsed) {
				unsent.push({ id, draft: parsed, error, attachment: typeof attachment === 'string' ? attachment : undefined });
			}
		}
		return unsent;
	}

	/** Adds or replaces the unsent report with `entry.id`. */
	saveUnsent(entry: ClaudeFeedbackUnsent): void {
		const unsent = this.unsent.filter(other => other.id !== entry.id);
		this.writeUnsent([...unsent, entry]);
	}

	removeUnsent(id: string): void {
		this.writeUnsent(this.unsent.filter(entry => entry.id !== id));
	}

	private writeUnsent(unsent: readonly ClaudeFeedbackUnsent[]): void {
		if (unsent.length === 0) {
			this._storage.remove(UNSENT_KEY, StorageScope.APPLICATION);
			return;
		}
		const value = unsent.map(entry => ({ id: entry.id, draft: serializeClaudeFeedbackDraft(entry.draft), error: entry.error, attachment: entry.attachment }));
		this._storage.store(UNSENT_KEY, JSON.stringify(value), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private read(key: string): unknown {
		try {
			return JSON.parse(this._storage.get(key, StorageScope.APPLICATION) ?? 'null');
		} catch {
			return undefined;
		}
	}
}
