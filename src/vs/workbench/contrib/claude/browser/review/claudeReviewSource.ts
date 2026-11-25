/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { joinPath, relativePath } from '../../../../../base/common/resources.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { derived, observableSignalFromEvent, observableValue, ValueWithChangeEventFromObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { CLAUDE_REVIEW_CONFIG_FILE_SETTING, readClaudeReviewConfigFile, readClaudeReviewConfigLayers, resolveClaudeReviewConfigForFile } from '../../../../../platform/claude/common/claudeReviewConfig.js';
import { RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { claudeSnapshotUri, IClaudeReviewService, ReviewFileState, TurnReview } from '../../../../services/claude/common/claudeReview.js';
import { IMultiDiffSourceResolver, IMultiDiffSourceResolverService, IResolvedMultiDiffSource, MultiDiffEditorItem } from '../../../multiDiffEditor/browser/multiDiffSourceResolverService.js';

/** The multi-diff source of the review editor: `klawly-review:/<sessionId>`, plus `?turn=<turnId>` for one turn. */
export const KLAWLY_REVIEW_SCHEME = 'klawly-review';

/** True inside the review editor, so its file toolbars show Keep and Undo. */
export const CLAUDE_REVIEW_EDITOR = new RawContextKey<boolean>('klawlyReviewEditor', false);

/** The review state of one file in the review editor: pending, accepted, conflicted or mixed. */
export const CLAUDE_REVIEW_FILE_STATE = new RawContextKey<string>('klawlyReviewFileState', '');

/** The snapshot fragment that keeps the review editor's models apart from the single-file diff's. */
const REVIEW_SNAPSHOT_FRAGMENT = 'review';

export interface ClaudeReviewTarget {
	readonly sessionId: string;
	/** One turn, or every turn of the session when undefined. */
	readonly turnId?: string;
}

export function claudeReviewSourceUri(target: ClaudeReviewTarget): URI {
	return URI.from({
		scheme: KLAWLY_REVIEW_SCHEME,
		path: `/${target.sessionId}`,
		query: target.turnId ? `turn=${encodeURIComponent(target.turnId)}` : '',
	});
}

export function parseClaudeReviewSourceUri(resource: URI): ClaudeReviewTarget | undefined {
	if (resource.scheme !== KLAWLY_REVIEW_SCHEME) {
		return undefined;
	}
	const sessionId = resource.path.replace(/^\//, '');
	if (!sessionId) {
		return undefined;
	}
	const turn = new URLSearchParams(resource.query).get('turn');
	return turn ? { sessionId, turnId: turn } : { sessionId };
}

/** A changed file as the review editor shows it. Across turns, its changes add up. */
export interface ClaudeReviewEntry {
	readonly uri: URI;
	readonly name: string;
	readonly directory: string;
	/** The turns that changed the file and were not undone, oldest first. */
	readonly turnIds: readonly string[];
	/** The text before the first of those turns. Undefined for a file Claude created. */
	readonly original: URI | undefined;
	readonly added: number;
	readonly removed: number;
	readonly state: Exclude<ReviewFileState, 'rejected'>;
}

/**
 * The files to show for the reviews, oldest turn first. A file every turn undid
 * is left out; its diff is empty. The left side is the snapshot from before the
 * first turn that changed the file, so All Changes shows the whole change.
 */
export function claudeReviewEntries(reviews: readonly TurnReview[]): ClaudeReviewEntry[] {
	const byUri = new Map<string, { first: TurnReview; isNew: boolean; name: string; directory: string; uri: URI; turnIds: string[]; added: number; removed: number; states: ReviewFileState[] }>();
	for (const review of reviews) {
		for (const file of review.files) {
			const key = file.uri.toString();
			let entry = byUri.get(key);
			if (!entry) {
				entry = { first: review, isNew: file.isNew, name: file.name, directory: file.directory, uri: file.uri, turnIds: [], added: 0, removed: 0, states: [] };
				byUri.set(key, entry);
			}
			if (file.state === 'rejected') {
				continue;
			}
			entry.turnIds.push(review.turnId);
			entry.added += file.added;
			entry.removed += file.removed;
			entry.states.push(file.state);
		}
	}
	const entries: ClaudeReviewEntry[] = [];
	for (const entry of byUri.values()) {
		if (entry.turnIds.length === 0) {
			continue;
		}
		entries.push({
			uri: entry.uri,
			name: entry.name,
			directory: entry.directory,
			turnIds: entry.turnIds,
			original: entry.isNew ? undefined : claudeSnapshotUri(entry.uri, entry.first.sessionId, entry.first.turnId).with({ fragment: REVIEW_SNAPSHOT_FRAGMENT }),
			added: entry.added,
			removed: entry.removed,
			state: combinedState(entry.states),
		});
	}
	return entries;
}

function combinedState(states: readonly ReviewFileState[]): ClaudeReviewEntry['state'] {
	if (states.includes('conflicted')) {
		return 'conflicted';
	}
	if (states.every(state => state === 'accepted')) {
		return 'accepted';
	}
	if (states.every(state => state === 'pending')) {
		return 'pending';
	}
	return 'mixed';
}

/** The loaded reviews of a session, or of one turn, oldest turn first. */
export function claudeSessionReviews(review: IClaudeReviewService, agent: IClaudeAgentService, target: ClaudeReviewTarget): TurnReview[] {
	const order = new Map(agent.getViewState(target.sessionId).turns.map((turn, index) => [turn.id, index]));
	const rank = (turnId: string) => order.get(turnId) ?? Number.MAX_SAFE_INTEGER;
	return review.reviewsFor(target.sessionId)
		.filter(candidate => !target.turnId || candidate.turnId === target.turnId)
		.sort((a, b) => rank(a.turnId) - rank(b.turnId));
}

/**
 * The files `.claude/review.json` ignores (issue 1038): the same cascade review after
 * commit uses, so the Review editor and a commit review agree. Returns the URIs as
 * strings; a file outside the workspace is never ignored.
 */
export async function claudeReviewIgnoredUris(entries: readonly ClaudeReviewEntry[], workspace: IWorkspaceContextService, files: IFileService, configuration: IConfigurationService): Promise<Set<string>> {
	const ignored = new Set<string>();
	const configFile = readClaudeReviewConfigFile(configuration.getValue(CLAUDE_REVIEW_CONFIG_FILE_SETTING));
	const byFolder = new Map<string, { root: URI; paths: Map<string, string> }>();
	for (const entry of entries) {
		const folder = workspace.getWorkspaceFolder(entry.uri);
		const path = folder && relativePath(folder.uri, entry.uri);
		if (folder && path) {
			const group = byFolder.get(folder.uri.toString()) ?? { root: folder.uri, paths: new Map() };
			group.paths.set(entry.uri.toString(), path);
			byFolder.set(folder.uri.toString(), group);
		}
	}
	for (const { root, paths } of byFolder.values()) {
		const layers = await readClaudeReviewConfigLayers([...paths.values()], configFile, async path => {
			try {
				return (await files.readFile(joinPath(root, ...path.split('/')))).value.toString();
			} catch {
				return undefined;
			}
		});
		for (const [uri, path] of paths) {
			if (resolveClaudeReviewConfigForFile(layers, path).ignored) {
				ignored.add(uri);
			}
		}
	}
	return ignored;
}

/** Loads the reviews of every turn that changed files, so All Changes is complete. */
export async function loadClaudeSessionReviews(review: IClaudeReviewService, agent: IClaudeAgentService, target: ClaudeReviewTarget): Promise<void> {
	const turns = agent.getViewState(target.sessionId).turns.filter(turn => turn.changedFiles.length > 0 && (!target.turnId || turn.id === target.turnId));
	await Promise.all(turns.map(turn => review.ensureTurn(target.sessionId, turn.id).catch(() => undefined)));
}

/**
 * Resolves `klawly-review:` sources for the multi-diff widget. The file list is
 * live: keeping or undoing a file updates it, and an unchanged file keeps its
 * item so its diff is not rebuilt.
 */
export class ClaudeReviewSourceResolver extends Disposable implements IMultiDiffSourceResolver, IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.klawlyReviewSource';

	constructor(
		@IMultiDiffSourceResolverService resolvers: IMultiDiffSourceResolverService,
		@IClaudeReviewService private readonly _review: IClaudeReviewService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IFileService private readonly _files: IFileService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
	) {
		super();
		this._register(resolvers.registerResolver(this));
	}

	canHandleUri(uri: URI): boolean {
		return uri.scheme === KLAWLY_REVIEW_SCHEME;
	}

	async resolveDiffSource(uri: URI): Promise<IResolvedMultiDiffSource> {
		const target = parseClaudeReviewSourceUri(uri);
		if (!target) {
			throw new Error(`Not a review source: ${uri.toString()}`);
		}
		await loadClaudeSessionReviews(this._review, this._agent, target);
		const changed = observableSignalFromEvent(this, Event.filter(this._review.onDidChangeReview, event => event.sessionId === target.sessionId));
		const ignored = observableValue<ReadonlySet<string>>(this, new Set());
		const refreshIgnored = async () => {
			const next = await claudeReviewIgnoredUris(claudeReviewEntries(claudeSessionReviews(this._review, this._agent, target)), this._workspace, this._files, this._configuration);
			const before = ignored.get();
			if (next.size !== before.size || [...next].some(uri => !before.has(uri))) {
				ignored.set(next, undefined);
			}
		};
		this._register(this._review.onDidChangeReview(event => event.sessionId === target.sessionId && refreshIgnored()));
		await refreshIgnored();
		let cache = new Map<string, MultiDiffEditorItem>();
		const items = derived(this, reader => {
			changed.read(reader);
			const hidden = ignored.read(reader);
			const next = new Map<string, MultiDiffEditorItem>();
			for (const entry of claudeReviewEntries(claudeSessionReviews(this._review, this._agent, target)).filter(candidate => !hidden.has(candidate.uri.toString()))) {
				const key = `${entry.uri.toString()}\n${entry.original?.toString() ?? ''}\n${entry.state}`;
				next.set(key, cache.get(key) ?? new MultiDiffEditorItem(entry.original, entry.uri, entry.uri, undefined, { [CLAUDE_REVIEW_FILE_STATE.key]: entry.state }));
			}
			cache = next;
			return [...next.values()];
		});
		return {
			resources: new ValueWithChangeEventFromObservable(items),
			contextKeys: { [CLAUDE_REVIEW_EDITOR.key]: true },
		};
	}
}
