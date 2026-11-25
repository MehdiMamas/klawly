/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IURLService } from '../../../../platform/url/common/url.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { ClaudeRegistrySession, claudeRegistryImportLink, claudeRegistryImportList, parseClaudeRegistrySession } from '../common/claudeSessionRegistry.js';
import { KLAWLY_CATEGORY } from '../common/claudeViews.js';

/** The Command Palette entry behind `/klawly all`: the terminal sessions Claude Code's session manager knows. */
export const CLAUDE_IMPORT_TERMINAL_SESSION_COMMAND_ID = 'klawly.agent.importTerminalSession';

const MAX_REGISTRY_ENTRIES = 300;

/** The sessions in `~/.claude/session-manager`, read only. A missing folder or an unreadable entry is skipped. */
async function readRegistry(files: IFileService, home: URI): Promise<ClaudeRegistrySession[]> {
	const root = joinPath(home, '.claude', 'session-manager');
	const folder = await files.resolve(root).catch(() => undefined);
	const sessions: ClaudeRegistrySession[] = [];
	for (const child of (folder?.children ?? []).filter(entry => entry.isDirectory).slice(0, MAX_REGISTRY_ENTRIES)) {
		try {
			const file = await files.readFile(joinPath(child.resource, `${child.name}.json`), { length: 64 * 1024 + 1 });
			const session = parseClaudeRegistrySession(file.value.toString());
			if (session) {
				sessions.push(session);
			}
		} catch {
			// Not a session entry (agents-cache, departments, ...): skip it.
		}
	}
	return sessions;
}

interface SessionPick extends IQuickPickItem {
	readonly session: ClaudeRegistrySession;
}

/** Import Terminal Session (issue 1186, `/klawly all`): pick a terminal session and continue it as a Klawly chat. */
export function registerClaudeTerminalSessionsCommand(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_IMPORT_TERMINAL_SESSION_COMMAND_ID,
				title: localize2('klawlyImportTerminalSession', "Import Terminal Session..."),
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
			const list = claudeRegistryImportList(await readRegistry(files, paths.userHome({ preferLocal: true })), true);
			if (!list.length) {
				notifications.info(localize('klawlyImportTerminalNone', "No Claude Code terminal sessions were found. Sessions appear here when Claude Code's session manager is installed."));
				return;
			}
			const picks: SessionPick[] = list.map(session => ({
				label: session.name,
				description: session.state,
				detail: session.task ? `${session.folder} - ${session.task}` : session.folder,
				session,
			}));
			const picked = await quickInput.pick(picks, {
				placeHolder: localize('klawlyImportTerminalPick', "Pick a terminal session to continue in Klawly"),
				matchOnDetail: true,
			});
			if (picked) {
				// The link handler asks before it opens the session.
				await urls.open(URI.parse(claudeRegistryImportLink(picked.session)));
			}
		}
	});
}
