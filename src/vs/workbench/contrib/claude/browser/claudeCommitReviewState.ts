/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { joinPath } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CLAUDE_COMMIT_REVIEW_MARKER_OWNER, claudeFindingMarkerSeverity, claudeShortSha } from '../../../../platform/claude/common/claudeCommitReview.js';
import { compareClaudeReviewFindings, ClaudeReviewFinding } from '../../../../platform/claude/common/claudeReviewLoop.js';
import { ClaudePersistedFindingStatus, claudeReviewProgress, parseClaudePersistedReview, reconcileClaudeFindings, serializeClaudePersistedReview } from '../../../../platform/claude/common/claudeReviewPersist.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkerData, IMarkerService } from '../../../../platform/markers/common/markers.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/** A finding of the last commit review, on the file it names. */
export interface ClaudeCommitFinding {
	readonly id: string;
	readonly finding: ClaudeReviewFinding;
	readonly uri: URI;
}

/** The last commit review that finished, and the findings of it still open. Fixing one in a chat keeps it until a later commit changes its lines or it is dismissed. */
export interface ClaudeCommitReviewResult {
	/** The commit the review covers everything up to (issue 927). */
	readonly sha: string;
	/** The folder the commit was reviewed in; a fix runs there. */
	readonly root: URI;
	/** The open findings. */
	readonly findings: readonly ClaudeCommitFinding[];
	/** How many findings the review has had, in any state; 0 is a clean review. */
	readonly total: number;
	/** Findings a later commit addressed, out of those not dismissed (the "3/5 addressed" line). */
	readonly progress: { readonly addressed: number; readonly total: number };
}

/** Where the last review is kept between windows (issue 927). */
const STORAGE_KEY = 'claude.commitReview.last';
const STORAGE_ROOT_KEY = 'claude.commitReview.lastRoot';

/** One finding as the state keeps it: its id stays the same while it is carried forward. */
interface ClaudeCommitReviewItem {
	readonly id: string;
	readonly finding: ClaudeReviewFinding;
	readonly status: ClaudePersistedFindingStatus;
}

export const IClaudeCommitReviewState = createDecorator<IClaudeCommitReviewState>('claudeCommitReviewState');

/**
 * What review after commit (issues 502 and 876) knows right now. The review
 * itself runs in the `ClaudeCommitReview` contribution; this is where its
 * answer lives, so the Problems panel, the inline threads and the status bar
 * item always show the same findings and a dismissed one goes from all three.
 */
export interface IClaudeCommitReviewState {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** Fires when the user asks for the failed review to run again (issue 1046). */
	readonly onDidRequestRetry: Event<void>;
	/** The commit being reviewed now, short, or undefined. */
	readonly reviewing: string | undefined;
	/** The commit whose review failed (issue 928), short, until the next review starts; undefined otherwise. */
	readonly failed: string | undefined;
	/** Why that review failed, in a few words, when it is known. */
	readonly failedReason: string | undefined;
	/** The last finished review; its findings shrink as they are dismissed or addressed. */
	readonly result: ClaudeCommitReviewResult | undefined;
	/** The commit the stored review covers everything up to, so the next one reviews only what came after; undefined for none. */
	readonly reviewedSha: string | undefined;
	/** Findings worst first, then by file and line. */
	readonly findings: readonly ClaudeCommitFinding[];
	begin(sha: string): void;
	/** A review ended without findings to show (failed or cancelled): the last result stays. */
	end(): void;
	/** A review failed: the status bar item shows the error until the next review. */
	fail(sha: string, reason?: string): void;
	/** Asks for the failed review to run again. */
	retry(): void;
	/** Hides the failed or clean outcome from the status bar (issue 1046); findings stay until dismissed. */
	hideOutcome(): void;
	/**
	 * Records a review up to `sha`; `root` resolves relative paths. With `diff`, the
	 * review covered only that diff since {@link reviewedSha}: the stored findings are
	 * carried over it (issue 927). Without it, the findings replace the stored review.
	 */
	finish(root: URI, sha: string, findings: readonly ClaudeReviewFinding[], diff?: string): void;
	dismiss(ids: readonly string[]): void;
	dismissAll(): void;
	/** Review Everything Again: forgets the stored review and asks for a full review of the last commit. */
	reviewAll(): void;
}

export class ClaudeCommitReviewState extends Disposable implements IClaudeCommitReviewState {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidRequestRetry = this._register(new Emitter<void>());
	readonly onDidRequestRetry = this._onDidRequestRetry.event;
	private _reviewing: string | undefined;
	private _sha: string | undefined;
	private _root: URI | undefined;
	private _items: readonly ClaudeCommitReviewItem[] = [];
	/** A clean outcome the person hid: no result shows, but the review still counts as covered. */
	private _hidden = false;
	private _failed: string | undefined;
	private _failedReason: string | undefined;

	constructor(
		@IMarkerService private readonly _markers: IMarkerService,
		@IStorageService private readonly _storage: IStorageService,
	) {
		super();
		this.restore();
	}

	get reviewing(): string | undefined {
		return this._reviewing;
	}

	get failed(): string | undefined {
		return this._failed;
	}

	get failedReason(): string | undefined {
		return this._failedReason;
	}

	get result(): ClaudeCommitReviewResult | undefined {
		const root = this._root;
		if (!this._sha || !root || this._hidden) {
			return undefined;
		}
		return {
			sha: this._sha,
			root,
			findings: this._items.filter(item => item.status === 'open').map(({ id, finding }) => ({ id, finding, uri: isAbsolute(finding.file) ? URI.file(finding.file) : joinPath(root, finding.file) })),
			total: this._items.length,
			progress: claudeReviewProgress(this._items),
		};
	}

	get reviewedSha(): string | undefined {
		return this._sha;
	}

	get findings(): readonly ClaudeCommitFinding[] {
		return [...this.result?.findings ?? []].sort((a, b) => compareClaudeReviewFindings(a.finding, b.finding));
	}

	begin(sha: string): void {
		this._reviewing = claudeShortSha(sha);
		this._failed = undefined;
		this._failedReason = undefined;
		this._onDidChange.fire();
	}

	fail(sha: string, reason?: string): void {
		this._failed = claudeShortSha(sha);
		this._failedReason = reason;
		this._onDidChange.fire();
	}

	retry(): void {
		this._onDidRequestRetry.fire();
	}

	hideOutcome(): void {
		const clean = this.result?.total === 0;
		if (this._failed !== undefined || clean) {
			this._failed = undefined;
			this._failedReason = undefined;
			if (clean) {
				this._hidden = true;
			}
			this.sync();
		}
	}

	end(): void {
		if (this._reviewing !== undefined) {
			this._reviewing = undefined;
			this._onDidChange.fire();
		}
	}

	finish(root: URI, sha: string, findings: readonly ClaudeReviewFinding[], diff?: string): void {
		this._reviewing = undefined;
		this._failed = undefined;
		this._failedReason = undefined;
		this._hidden = false;
		if (diff !== undefined && this._sha) {
			// Carried findings come first, in their order, so each keeps its id.
			const previous = this._items;
			this._items = reconcileClaudeFindings(previous, diff, findings).map((item, index) => ({ id: index < previous.length ? previous[index].id : generateUuid(), ...item }));
		} else {
			this._items = findings.map(finding => ({ id: generateUuid(), finding, status: 'open' }));
		}
		this._sha = sha;
		this._root = root;
		this.save();
		this.sync();
	}

	dismiss(ids: readonly string[]): void {
		if (this._items.some(item => item.status === 'open' && ids.includes(item.id))) {
			this._items = this._items.map(item => item.status === 'open' && ids.includes(item.id) ? { ...item, status: 'dismissed' } : item);
			this.save();
			this.sync();
		}
	}

	dismissAll(): void {
		if (this._items.some(item => item.status === 'open')) {
			this._items = this._items.map(item => item.status === 'open' ? { ...item, status: 'dismissed' } : item);
			this.save();
			this.sync();
		}
	}

	reviewAll(): void {
		this._sha = undefined;
		this._root = undefined;
		this._items = [];
		this._hidden = false;
		this._storage.remove(STORAGE_KEY, StorageScope.WORKSPACE);
		this._storage.remove(STORAGE_ROOT_KEY, StorageScope.WORKSPACE);
		this.sync();
		this._onDidRequestRetry.fire();
	}

	/** Reads the review the last window kept, so its findings and where it stopped come back. */
	private restore(): void {
		const review = parseClaudePersistedReview(this._storage.get(STORAGE_KEY, StorageScope.WORKSPACE));
		const root = this._storage.get(STORAGE_ROOT_KEY, StorageScope.WORKSPACE);
		if (review && root) {
			this._sha = review.reviewedSha;
			this._root = URI.parse(root);
			this._items = review.findings.map(item => ({ id: generateUuid(), ...item }));
			this.sync();
		}
	}

	private save(): void {
		if (this._sha && this._root) {
			this._storage.store(STORAGE_KEY, serializeClaudePersistedReview({ reviewedSha: this._sha, findings: this._items.map(({ finding, status }) => ({ finding, status })) }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			this._storage.store(STORAGE_ROOT_KEY, this._root.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
	}

	/** The Problems panel shows what is left; the last review's markers always go. */
	private sync(): void {
		const short = claudeShortSha(this._sha ?? '');
		this._markers.changeAll(CLAUDE_COMMIT_REVIEW_MARKER_OWNER, this.findings.map(({ finding, uri }) => ({ resource: uri, marker: findingMarker(finding, short) })));
		this._onDidChange.fire();
	}
}

function findingMarker(finding: ClaudeReviewFinding, short: string): IMarkerData {
	return {
		severity: claudeFindingMarkerSeverity(finding.severity),
		message: finding.suggestion ? `${finding.title}\n${finding.body}\n${localize('claudeCommitReviewSuggestion', "Suggested fix: {0}", finding.suggestion)}` : `${finding.title}\n${finding.body}`,
		source: localize('claudeCommitReviewSource', "Claude review {0}", short),
		startLineNumber: Math.max(1, finding.startLine),
		startColumn: 1,
		endLineNumber: Math.max(finding.startLine, finding.endLine),
		endColumn: Number.MAX_SAFE_INTEGER,
	};
}
