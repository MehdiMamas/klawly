/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { dirname } from '../../../../base/common/path.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { createFileServiceSessionStorage } from '../../../../platform/claude/common/claudeSessionFileStorage.js';
import { JsonlSessionStore } from '../../../../platform/claude/common/claudeSessionStore.js';
import { INativeWorkbenchEnvironmentService } from '../../../services/environment/electron-browser/environmentService.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { deserializeReviews, serializeReviews } from '../../../services/claude/common/claudeReviewPersist.js';
import { IClaudeReviewService } from '../../../services/claude/common/claudeReview.js';
import { IClaudeComparisonService } from '../../../services/claude/common/claudeComparison.js';

/**
 * Connects the agent pane to `<userData>/agent-sessions`. Opening a saved
 * session restores its transcript and review hunks. It does not resume tools.
 */
export class ClaudeDurableHistoryContribution extends Disposable {
	static readonly ID = 'workbench.contrib.claudeDurableHistory';

	private _hydrating = false;

	constructor(
		@IClaudeAgentService agent: IClaudeAgentService,
		@INativeWorkbenchEnvironmentService environmentService: INativeWorkbenchEnvironmentService,
		@IFileService files: IFileService,
		@INativeHostService nativeHost: INativeHostService,
		@IClaudeReviewService review: IClaudeReviewService,
		@IClaudeComparisonService comparisons: IClaudeComparisonService,
		@ILogService log: ILogService,
	) {
		super();
		const store = new JsonlSessionStore(environmentService.userDataPath, createFileServiceSessionStorage(files));
		agent.attachDurableHistory(store, path => nativeHost.showItemInFolder(path));
		// Another window appends to the same events.jsonl (issue 1509): re-read the session when it changes.
		const sessionsRoot = URI.file(dirname(store.indexPath()));
		this._register(files.watch(sessionsRoot, { recursive: true, excludes: [] }));
		this._register(files.onDidFilesChange(event => {
			for (const resource of event.rawAdded.concat(event.rawUpdated)) {
				if (resource.path.endsWith('/events.jsonl') && resource.path.startsWith(sessionsRoot.path + '/')) {
					const sessionId = dirname(resource.path).split('/').pop();
					if (sessionId) {
						void agent.syncExternalHistory(sessionId).catch(error => {
							log.error(`Claude history sync failed: ${error instanceof Error ? error.message : String(error)}`);
						});
					}
				}
			}
		}));
		this._register(agent.onDidLoadSession(event => {
			void this.restoreReviews(store, review, event.sessionId);
		}));
		this._register(review.onDidChangeReview(event => {
			if (this._hydrating || !event.sessionId) {
				return;
			}
			void store.writeReviews(event.sessionId, serializeReviews(review.reviewsFor(event.sessionId)));
		}));
		// Compare Models (issue 424): comparisons are kept beside the sessions.
		void comparisons.attachDurableHistory(store).catch(error => {
			log.error(`Claude comparisons failed to load: ${error instanceof Error ? error.message : String(error)}`);
		});
		void agent.loadDurableHistory().catch(error => {
			const message = error instanceof Error ? error.message : String(error);
			log.error(`Claude history failed to load: ${message}`);
		});
	}

	private async restoreReviews(store: JsonlSessionStore, review: IClaudeReviewService, sessionId: string): Promise<void> {
		const json = await store.readReviews(sessionId);
		if (!json) {
			return;
		}
		this._hydrating = true;
		try {
			for (const saved of deserializeReviews(json)) {
				review.importSaved(saved);
			}
		} finally {
			this._hydrating = false;
		}
	}
}
