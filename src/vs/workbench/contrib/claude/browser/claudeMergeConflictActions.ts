/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { extUriBiasedIgnorePathCase, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IClaudeActionService } from '../../../../platform/claude/common/claudeActions.js';
import { ContextAttachment } from '../../../../platform/claude/common/claudeContext.js';
import { MERGE_CONFLICT_COMMIT_LIMIT, MERGE_CONFLICT_FILE_LIMIT, MERGE_INCOMING_REFS, MergeConflictFile, MergeConflictSide, mergeConflictChunks } from '../../../../platform/claude/common/claudeMergeConflicts.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ISCMRepository, ISCMResourceGroup, ISCMService } from '../../scm/common/scm.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { CLAUDE_AGENT_VIEW_ID, KLAWLY_CATEGORY } from '../common/claudeViews.js';

export const CLAUDE_RESOLVE_CONFLICTS_COMMAND_ID = 'claude.resolveConflicts';

/** The git extension's group for conflicted files (`Merge Changes`). */
const GIT_MERGE_GROUP_ID = 'merge';
/** `MergeEditorInput.ID`, compared by string so this file does not load the merge editor. */
const MERGE_EDITOR_INPUT_ID = 'mergeEditor.Input';

/**
 * Resolve with Claude (issue 501): on the Merge Changes group in Source Control
 * and in the merge editor title. It attaches the merge base and both sides of
 * each conflicted file, read through the git extension's `git:` file system,
 * and the latest commits of both sides from the SCM history provider, then sends
 * one turn. Claude's edits land as normal Klawly changes (Keep or Undo per
 * hunk); nothing is staged. A `/resolve` command or skill takes over the prompt
 * when the user has one.
 */
export function registerClaudeMergeConflictActions(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_RESOLVE_CONFLICTS_COMMAND_ID,
				title: localize2('claudeResolveConflicts', "Resolve with Claude"),
				category: KLAWLY_CATEGORY,
				icon: Codicon.sparkle,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				menu: [{
					id: MenuId.SCMResourceGroupContext,
					group: 'inline',
					order: 0,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, ContextKeyExpr.equals('scmProvider', 'git'), ContextKeyExpr.equals('scmResourceGroup', GIT_MERGE_GROUP_ID)),
				}, {
					id: MenuId.EditorTitle,
					group: 'navigation',
					order: 0,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, ContextKeyExpr.equals('isMergeEditor', true)),
				}],
			});
		}
		async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
			const scm = accessor.get(ISCMService);
			const files = accessor.get(IFileService);
			const editors = accessor.get(IEditorService);
			const notifications = accessor.get(INotificationService);
			const views = accessor.get(IViewsService);
			const actions = accessor.get(IClaudeActionService);
			const active = editors.activeEditor?.typeId === MERGE_EDITOR_INPUT_ID ? editors.activeEditor.resource : undefined;
			const targets = conflictTargets(scm, args.find(isResourceGroup), args.find(URI.isUri) ?? active);
			if (targets.length === 0) {
				notifications.info(localize('claudeResolveConflictsNone', "There are no merge conflicts to resolve."));
				return;
			}
			const attachments: ContextAttachment[] = [];
			for (const { repository, uris } of targets) {
				const chunks = mergeConflictChunks({
					ours: await readSide(repository, ['HEAD']),
					theirs: await readSide(repository, MERGE_INCOMING_REFS),
					files: await Promise.all(uris.slice(0, MERGE_CONFLICT_FILE_LIMIT).map(uri => readConflictFile(files, repository, uri))),
				});
				for (const chunk of chunks) {
					attachments.push({ kind: 'pasted-text', id: chunk.id, text: chunk.text, lineCount: chunk.text.split('\n').length });
				}
			}
			await views.openView(CLAUDE_AGENT_VIEW_ID, true);
			await actions.run({ id: 'resolveConflicts', source: 'button', attachments });
		}
	});
}

interface ConflictTarget {
	readonly repository: ISCMRepository;
	readonly uris: readonly URI[];
}

/**
 * The conflicted files to send: the clicked group, else the one file open in
 * the merge editor, else every git repository's Merge Changes group.
 */
function conflictTargets(scm: ISCMService, group: ISCMResourceGroup | undefined, file: URI | undefined): ConflictTarget[] {
	const targets: ConflictTarget[] = [];
	for (const repository of scm.repositories) {
		const merge = repository.provider.groups.find(candidate => candidate.id === GIT_MERGE_GROUP_ID);
		if (!merge || repository.provider.providerId !== 'git' || (group && merge !== group)) {
			continue;
		}
		const uris = merge.resources
			.map(resource => resource.sourceUri)
			.filter(uri => !file || extUriBiasedIgnorePathCase.isEqual(uri, file));
		if (uris.length > 0) {
			targets.push({ repository, uris });
		}
	}
	return targets;
}

/** One side's branch and latest commits; the first ref that has commits wins. */
async function readSide(repository: ISCMRepository, refs: readonly string[]): Promise<MergeConflictSide> {
	const history = repository.provider.historyProvider.get();
	for (const ref of refs) {
		const items = await history?.provideHistoryItems({ historyItemRefs: [ref], limit: MERGE_CONFLICT_COMMIT_LIMIT }, CancellationToken.None).catch(() => undefined);
		if (items && items.length > 0) {
			const branch = ref === 'HEAD'
				? history?.historyItemRef.get()?.name
				: items[0].references?.find(reference => reference.id.startsWith('refs/heads/') || reference.id.startsWith('refs/remotes/'))?.name;
			return { ref, ...(branch ? { branch } : {}), commits: items.map(item => ({ id: item.id, subject: item.subject })) };
		}
	}
	return { ref: refs[0], commits: [] };
}

/** The working file and index stages 1 to 3, read through the git extension. */
async function readConflictFile(files: IFileService, repository: ISCMRepository, uri: URI): Promise<MergeConflictFile> {
	const root = repository.provider.rootUri;
	const path = (root && relativePath(root, uri)) || uri.fsPath;
	const [working, base, ours, theirs] = await Promise.all([
		readText(files, uri),
		readText(files, gitStageUri(uri, 1)),
		readText(files, gitStageUri(uri, 2)),
		readText(files, gitStageUri(uri, 3)),
	]);
	return { path, working, base, ours, theirs };
}

/** The git extension's URI for an index stage, as its `toMergeUris` builds it. */
function gitStageUri(uri: URI, stage: 1 | 2 | 3): URI {
	return uri.with({ scheme: 'git', query: JSON.stringify({ path: uri.fsPath, ref: `:${stage}` }) });
}

async function readText(files: IFileService, uri: URI): Promise<string | undefined> {
	try {
		return (await files.readFile(uri)).value.toString();
	} catch {
		return undefined;
	}
}

function isResourceGroup(value: unknown): value is ISCMResourceGroup {
	return !!value && typeof value === 'object' && 'resources' in value && 'provider' in value && 'id' in value;
}
