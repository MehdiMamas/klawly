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
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { ClaudeRegistrySession, claudeRegistryManagers, claudeRegistryReportFile, claudeRegistryWorkersOf, parseClaudeRegistrySession } from '../common/claudeSessionRegistry.js';
import { KLAWLY_CATEGORY } from '../common/claudeViews.js';

/** The Command Palette entry that lists a terminal manager's workers and opens their latest reports (issue 1186). */
export const CLAUDE_TERMINAL_WORKERS_COMMAND_ID = 'klawly.agent.showTerminalWorkers';

const MAX_REGISTRY_ENTRIES = 300;

interface RegistryEntry {
	readonly session: ClaudeRegistrySession;
	/** The registry folder the entry was found in; a manager's reports are written next to its entries. */
	readonly dir: URI;
}

/** Every session in `~/.claude/session-manager/*`, read only. A missing folder or an unreadable entry is skipped. */
async function readRegistry(files: IFileService, root: URI): Promise<RegistryEntry[]> {
	const folder = await files.resolve(root).catch(() => undefined);
	const found: RegistryEntry[] = [];
	for (const child of (folder?.children ?? []).filter(entry => entry.isDirectory).slice(0, MAX_REGISTRY_ENTRIES)) {
		const entries = await files.resolve(child.resource).catch(() => undefined);
		for (const entry of (entries?.children ?? []).filter(e => e.isFile && e.name.endsWith('.json'))) {
			try {
				const file = await files.readFile(entry.resource, { length: 64 * 1024 + 1 });
				const session = parseClaudeRegistrySession(file.value.toString());
				if (session) {
					found.push({ session, dir: child.resource });
				}
			} catch {
				// Not a session entry: skip it.
			}
		}
	}
	return found;
}

interface ManagerPick extends IQuickPickItem {
	readonly managerId: string;
}

interface WorkerPick extends IQuickPickItem {
	readonly session: ClaudeRegistrySession;
}

/** Show Terminal Session Workers (issue 1186): a terminal manager's workers, their state, and the latest report each wrote. */
export function registerClaudeTerminalWorkersCommand(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_TERMINAL_WORKERS_COMMAND_ID,
				title: localize2('klawlyShowTerminalWorkers', "Show Terminal Session Workers..."),
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
			const opener = accessor.get(IOpenerService);
			const found = await readRegistry(files, joinPath(await paths.userHome({ preferLocal: true }), '.claude', 'session-manager'));
			const sessions = found.map(entry => entry.session);
			const managers = claudeRegistryManagers(sessions);
			if (!managers.length) {
				notifications.info(localize('klawlyTerminalWorkersNone', "No Claude Code manager with workers was found."));
				return;
			}
			const manager = await quickInput.pick<ManagerPick>(managers.slice(0, 30).map(({ manager, workers }) => ({
				label: manager.name,
				description: localize('klawlyTerminalWorkersCount', "{0} workers", workers),
				detail: manager.task ? `${manager.folder} - ${manager.task}` : manager.folder,
				managerId: manager.sessionId,
			})), { placeHolder: localize('klawlyTerminalWorkersPickManager', "Pick a terminal manager") });
			if (!manager) {
				return;
			}
			const dir = found.find(entry => entry.session.sessionId === manager.managerId)?.dir;
			const worker = await quickInput.pick<WorkerPick>(claudeRegistryWorkersOf(sessions, manager.managerId).map(session => ({
				label: session.name,
				description: session.state,
				detail: session.task,
				session,
			})), { placeHolder: localize('klawlyTerminalWorkersPickWorker', "Pick a worker to open its latest report"), matchOnDetail: true });
			if (!worker || !dir) {
				return;
			}
			const report = joinPath(dir, claudeRegistryReportFile(manager.managerId, worker.session.name));
			if (await files.exists(report).catch(() => false)) {
				await opener.open(report);
			} else {
				notifications.info(localize('klawlyTerminalWorkersNoReport', "{0} has not written a report yet.", worker.session.name));
			}
		}
	});
}
