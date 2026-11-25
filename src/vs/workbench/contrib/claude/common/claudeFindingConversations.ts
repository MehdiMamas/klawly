/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ClaudeReviewFinding } from '../../../../platform/claude/common/claudeReviewLoop.js';
import { appendFindingReply, buildFindingReplyContext, ClaudeFindingReply, ClaudeFindingThread } from '../../../../platform/claude/common/claudeReviewReply.js';

/** What the conversations need from the Review editor (issue 929). Faked in tests. */
export interface ClaudeFindingConversationHost {
	/** Runs one read-only turn and resolves with Claude's answer; rejects with why it failed. */
	askReadOnly(prompt: string): Promise<string>;
	/** The lines around a finding. */
	codeAround(finding: ClaudeReviewFinding): readonly string[];
	/** The review's summary, if it has one. */
	summary(): string | undefined;
	/** Saves the threads (see `serializeFindingThreads`). */
	save(threads: readonly ClaudeFindingThread[]): void;
	/** Hands the finding to the agent chat (`claudeFindingFeedback`). */
	continueInChat(findingId: string): void;
	/** Counts Mark as Intended as a signal to learn from (issue 923). Missing: the button stays hidden. */
	markIntended?(findingId: string, finding: ClaudeReviewFinding): void;
	/** Says why a reply failed. */
	fail(message: string): void;
}

/** One finding's conversation as the thread UI sees it. */
export interface ClaudeFindingConversationView {
	readonly onDidChange: Event<void>;
	replies(): readonly ClaudeFindingReply[];
	busy(): boolean;
	send(text: string): void;
	/** Missing when the host does not learn from intended findings, so the button stays hidden. */
	markIntended?(): void;
	continueInChat(): void;
}

/**
 * The finding threads of one review: a reply runs a read-only Claude turn built with
 * `buildFindingReplyContext`, the answer joins the thread, and every change is saved.
 */
export class ClaudeFindingConversations extends Disposable {
	private readonly _threads = new Map<string, ClaudeFindingThread>();
	private readonly _busy = new Set<string>();
	private readonly _onDidChange = this._register(new Emitter<string>());

	constructor(private readonly _host: ClaudeFindingConversationHost, saved: readonly ClaudeFindingThread[] = []) {
		super();
		for (const thread of saved) {
			this._threads.set(thread.findingId, thread);
		}
	}

	threads(): readonly ClaudeFindingThread[] {
		return [...this._threads.values()];
	}

	/** The view of one finding's thread. */
	view(findingId: string, finding: ClaudeReviewFinding): ClaudeFindingConversationView {
		return {
			onDidChange: Event.map(Event.filter(this._onDidChange.event, id => id === findingId), () => undefined),
			replies: () => this._threads.get(findingId)?.replies ?? [],
			busy: () => this._busy.has(findingId),
			send: text => void this.send(findingId, finding, text),
			markIntended: this._host.markIntended ? () => this.markIntended(findingId, finding) : undefined,
			continueInChat: () => this._host.continueInChat(findingId),
		};
	}

	/** Adds the person's message, asks Claude and adds the answer. A message while Claude answers is ignored. */
	async send(findingId: string, finding: ClaudeReviewFinding, text: string): Promise<void> {
		const message = text.trim();
		if (!message || this._busy.has(findingId)) {
			return;
		}
		const before = this._threads.get(findingId) ?? { findingId, replies: [] };
		const prompt = buildFindingReplyContext(finding, this._host.codeAround(finding), this._host.summary(), before.replies, message);
		this.set(appendFindingReply(before, { role: 'user', text: message }));
		this._busy.add(findingId);
		this._onDidChange.fire(findingId);
		try {
			const answer = await this._host.askReadOnly(prompt);
			this.set(appendFindingReply(this._threads.get(findingId) ?? before, { role: 'assistant', text: answer }));
		} catch (error) {
			this._host.fail(error instanceof Error ? error.message : String(error));
		} finally {
			this._busy.delete(findingId);
			this._onDidChange.fire(findingId);
		}
	}

	/** Marks the finding as intended once: the thread is saved with it and the host counts the signal. */
	markIntended(findingId: string, finding: ClaudeReviewFinding): void {
		const before = this._threads.get(findingId) ?? { findingId, replies: [] };
		if (before.intended) {
			return;
		}
		this.set({ ...before, intended: true });
		this._host.markIntended?.(findingId, finding);
		this._onDidChange.fire(findingId);
	}

	private set(thread: ClaudeFindingThread): void {
		this._threads.set(thread.findingId, thread);
		this._host.save(this.threads());
	}
}
