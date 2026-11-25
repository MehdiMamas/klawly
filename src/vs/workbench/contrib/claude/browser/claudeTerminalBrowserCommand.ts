/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fromNow } from '../../../../base/common/date.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IURLService } from '../../../../platform/url/common/url.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { claudeRegistryImportLink } from '../common/claudeSessionRegistry.js';
import { claudeProjectFolderName, claudeTranscriptAsSession, claudeTranscriptList, claudeTranscriptTitle } from '../common/claudeTerminalTranscripts.js';
import { KLAWLY_CATEGORY } from '../common/claudeViews.js';

/** The Command Palette entry behind the "From the terminal" browser: this folder's Claude Code sessions. */
export const CLAUDE_TERMINAL_BROWSER_COMMAND_ID = 'klawly.agent.browseTerminalSessions';

const TITLE_READ_BYTES = 64 * 1024;

interface TranscriptPick extends IQuickPickItem {
	readonly link: string;
}

/** From the terminal (issue 1186): list the open folder's terminal sessions, newest first, and continue one in a chat. */
export function registerClaudeTerminalBrowserCommand(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_TERMINAL_BROWSER_COMMAND_ID,
				title: localize2('klawlyBrowseTerminalSessions', "Continue a Session From the Terminal..."),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const files = accessor.get(IFileService);
			const paths = accessor.get(IPathService);
			const quickInput = accessor.get(IQuickInputService);
			const notifications = accessor.get(INotificationService);
			const urls = accessor.get(IURLService);
			const folder = accessor.get(IWorkspaceContextService).getWorkspace().folders[0]?.uri;
			if (!folder) {
				notifications.info(localize('klawlyBrowseTerminalNoFolder', "Open a folder first: terminal sessions are listed per folder."));
				return;
			}
			const dir = joinPath(await paths.userHome({ preferLocal: true }), '.claude', 'projects', claudeProjectFolderName(folder.fsPath));
			const stat = await files.resolve(dir, { resolveMetadata: true }).catch(() => undefined);
			const newest = claudeTranscriptList((stat?.children ?? []).filter(child => child.isFile).map(child => ({ name: child.name, mtime: child.mtime ?? 0 })));
			if (!newest.length) {
				notifications.info(localize('klawlyBrowseTerminalNone', "No Claude Code terminal sessions were found for this folder."));
				return;
			}
			const picks: TranscriptPick[] = [];
			for (const entry of newest) {
				const head = await files.readFile(joinPath(dir, `${entry.sessionId}.jsonl`), { length: TITLE_READ_BYTES }).then(file => file.value.toString(), () => '');
				const session = claudeTranscriptAsSession(entry.sessionId, claudeTranscriptTitle(head), folder.fsPath, entry.mtime);
				picks.push({
					label: session.name,
					description: entry.mtime ? fromNow(entry.mtime, true) : undefined,
					detail: entry.sessionId,
					link: claudeRegistryImportLink(session),
				});
			}
			const picked = await quickInput.pick(picks, {
				placeHolder: localize('klawlyBrowseTerminalPick', "Pick a terminal session to continue in Klawly"),
				matchOnDetail: true,
			});
			if (picked) {
				// The link handler asks before it opens the session.
				await urls.open(URI.parse(picked.link));
			}
		}
	});
}
