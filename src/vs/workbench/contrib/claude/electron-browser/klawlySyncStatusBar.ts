/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IKlawlySyncService, KLAWLY_SYNC_ENABLED_SETTING, KlawlySyncMemoryOverview } from '../../../../platform/claude/common/klawlySyncService.js';
import { KlawlySyncStatus, KlawlySyncStatusAction, KlawlySyncStatusLine, klawlySyncStatusLine } from '../../../../platform/claude/common/klawlySyncModel.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { KLAWLY_CATEGORY } from '../common/claudeViews.js';

export const KLAWLY_SYNC_ENTRY_ID = 'klawly.sync.status';
export const KLAWLY_SYNC_SHOW_COMMAND_ID = 'klawly.sync.showStatus';
export const KLAWLY_SYNC_RETRY_COMMAND_ID = 'klawly.sync.retry';
export const KLAWLY_SYNC_SIGN_IN_COMMAND_ID = 'klawly.sync.signIn';
export const KLAWLY_SYNC_RESUME_COMMAND_ID = 'klawly.sync.resume';
export const KLAWLY_SYNC_DETAILS_COMMAND_ID = 'klawly.sync.showDetails';
export const KLAWLY_SYNC_MEMORY_COMMAND_ID = 'klawly.sync.showMemory';

/** `github.com__owner__app` read back as `github.com/owner/app`; `alias__notes` as `alias/notes`. */
export function klawlySyncMemoryProjectLabel(slug: string): string {
	return slug.replace(/__/g, '/');
}

/**
 * The rows of the synced memory view (DL-21: a labeled group gets its own header row, DL-12: nothing
 * to show says why instead of showing an empty list). Each project is a group of its notes; the
 * computers come last, and the one the view is open on carries the "This computer" badge.
 */
export function klawlySyncMemoryItems(overview: KlawlySyncMemoryOverview): (IQuickPickItem & { path?: string } | IQuickPickSeparator)[] {
	const items: (IQuickPickItem & { path?: string } | IQuickPickSeparator)[] = [];
	for (const project of overview.projects) {
		items.push({ type: 'separator', label: klawlySyncMemoryProjectLabel(project.slug) });
		for (const note of project.notes) {
			items.push({ label: note.name, description: localize('klawlySyncMemoryBytes', "{0} KB", Math.max(1, Math.round(note.bytes / 1024))), path: note.path });
		}
		if (project.transcripts) {
			items.push({ label: project.transcripts === 1 ? localize('klawlySyncMemoryTranscriptOne', "1 synced session") : localize('klawlySyncMemoryTranscripts', "{0} synced sessions", project.transcripts), pickable: false });
		}
		if (!project.notes.length && !project.transcripts) {
			items.push({ label: localize('klawlySyncMemoryNoNotes', "No notes yet"), pickable: false });
		}
	}
	if (overview.machines.length) {
		items.push({ type: 'separator', label: localize('klawlySyncMemoryComputers', "Computers") });
		for (const machine of overview.machines) {
			items.push({
				label: machine.name,
				description: machine.sessions === 1 ? localize('klawlySyncMemorySessionOne', "1 session") : localize('klawlySyncMemorySessions', "{0} sessions", machine.sessions),
				detail: machine.current ? localize('klawlySyncMemoryThisComputer', "This computer") : undefined,
				pickable: false,
			});
		}
	}
	return items;
}

/** The command each status action runs. */
const ACTION_COMMANDS: Readonly<Record<KlawlySyncStatusAction, string | undefined>> = {
	signIn: KLAWLY_SYNC_SIGN_IN_COMMAND_ID,
	retry: KLAWLY_SYNC_RETRY_COMMAND_ID,
	showDetails: KLAWLY_SYNC_DETAILS_COMMAND_ID,
	resume: KLAWLY_SYNC_RESUME_COMMAND_ID,
};

function actionLabel(action: KlawlySyncStatusAction): string {
	switch (action) {
		case 'signIn': return localize('klawlySyncActionSignIn', "Sign In");
		case 'retry': return localize('klawlySyncActionRetry', "Retry Sync");
		case 'showDetails': return localize('klawlySyncActionDetails', "Show Details");
		case 'resume': return localize('klawlySyncActionResume', "Resume Sync");
	}
}

/** The actions that can run now (DL-12). Exported for tests. */
export function klawlySyncRunnableActions(line: KlawlySyncStatusLine): readonly KlawlySyncStatusAction[] {
	return line.actions.filter(action => ACTION_COMMANDS[action] !== undefined);
}

/**
 * The status bar item of Klawly Sync (issue 1121): the status line in plain words as its tooltip.
 * Hidden while signed out. Clicking it lists what can be done about the line. Exported for tests.
 */
export function klawlySyncEntry(status: KlawlySyncStatus, now: number): IStatusbarEntry | undefined {
	if (!status.signedIn) {
		return undefined;
	}
	const line = klawlySyncStatusLine(status, now);
	const icon = status.error ? '$(sync-ignored)' : status.running ? '$(sync~spin)' : status.paused ? '$(debug-pause)' : '$(sync)';
	return {
		name: localize('klawlySyncEntryName', "Klawly Sync"),
		text: icon,
		ariaLabel: line.text,
		tooltip: line.text,
		command: KLAWLY_SYNC_SHOW_COMMAND_ID,
		kind: status.error ? 'error' : undefined,
	};
}

/** Shows {@link klawlySyncEntry} on the right of the status bar while Sync is on. */
export class KlawlySyncStatusBar extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.klawlySyncStatusBar';

	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly _statusbar: IStatusbarService,
		@IKlawlySyncService private readonly _sync: IKlawlySyncService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
	) {
		super();
		this._register(this._sync.onDidChangeStatus(status => this.update(status)));
		this._register(this._configuration.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(KLAWLY_SYNC_ENABLED_SETTING)) {
				this._sync.getStatus().then(status => this.update(status), () => this._entry.clear());
			}
		}));
		this._sync.getStatus().then(status => this.update(status), () => { /* the shared process is not up yet */ });
	}

	private update(status: KlawlySyncStatus): void {
		const entry = this._configuration.getValue<boolean>(KLAWLY_SYNC_ENABLED_SETTING) === true ? klawlySyncEntry(status, Date.now()) : undefined;
		if (!entry) {
			this._entry.clear();
		} else if (this._entry.value) {
			this._entry.value.update(entry);
		} else {
			this._entry.value = this._statusbar.addEntry(entry, KLAWLY_SYNC_ENTRY_ID, StatusbarAlignment.RIGHT, 98);
		}
	}
}

export const KLAWLY_SYNC_PREVIEW_HISTORY_COMMAND_ID = 'klawly.sync.previewHistory';
export const KLAWLY_SYNC_DELETE_HISTORY_COMMAND_ID = 'klawly.sync.deleteHistory';

/** Registers Show Sync Status, Retry Sync, Resume Sync, Sign In to Sync and Show Sync Details. */
export function registerKlawlySyncStatusCommands(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: KLAWLY_SYNC_SHOW_COMMAND_ID, title: localize2('klawlySyncShowStatus', "Show Sync Status"), category: KLAWLY_CATEGORY, f1: true });
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const status = await accessor.get(IKlawlySyncService).getStatus();
			const line = klawlySyncStatusLine(status, Date.now());
			const commands = accessor.get(ICommandService);
			const items: (IQuickPickItem & { command: string; args?: string })[] = klawlySyncRunnableActions(line).map(action => ({ label: actionLabel(action), command: ACTION_COMMANDS[action]! }));
			if (line.link) {
				items.push({ label: localize('klawlySyncActionSettings', "Open Sync Settings"), command: line.link.command, args: line.link.args });
			}
			const picked = await accessor.get(IQuickInputService).pick(items, { placeHolder: line.text });
			if (picked) {
				await commands.executeCommand(picked.command, ...(picked.args ? [picked.args] : []));
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: KLAWLY_SYNC_RETRY_COMMAND_ID, title: localize2('klawlySyncRetry', "Retry Sync"), category: KLAWLY_CATEGORY, f1: true });
		}

		run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(IKlawlySyncService).retry();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: KLAWLY_SYNC_RESUME_COMMAND_ID, title: localize2('klawlySyncResume', "Resume Sync"), category: KLAWLY_CATEGORY, f1: true });
		}

		run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(IKlawlySyncService).setPaused(false);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: KLAWLY_SYNC_SIGN_IN_COMMAND_ID, title: localize2('klawlySyncSignIn', "Sign In to Sync"), category: KLAWLY_CATEGORY, f1: true });
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IKlawlySyncService).signIn();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: KLAWLY_SYNC_DETAILS_COMMAND_ID, title: localize2('klawlySyncShowDetails', "Show Sync Details"), category: KLAWLY_CATEGORY, f1: true });
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const status = await accessor.get(IKlawlySyncService).getStatus();
			const line = klawlySyncStatusLine(status, Date.now());
			await accessor.get(IDialogService).info(line.text, line.details ?? localize('klawlySyncNoDetails', "There is nothing more to show."));
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: KLAWLY_SYNC_MEMORY_COMMAND_ID, title: localize2('klawlySyncShowMemory', "Show Synced Memory"), category: KLAWLY_CATEGORY, f1: true });
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const sync = accessor.get(IKlawlySyncService);
			const dialogs = accessor.get(IDialogService);
			const quickInput = accessor.get(IQuickInputService);
			const editors = accessor.get(IEditorService);
			const items = klawlySyncMemoryItems(await sync.listMemory());
			if (!items.length) {
				await dialogs.info(localize('klawlySyncMemoryEmpty', "Nothing is synced yet"), localize('klawlySyncMemoryEmptyDetail', "Turn on Sync Memory or Sync History in Settings > Sync. Notes and sessions appear here once a project has a git remote or a name."));
				return;
			}
			const picked = await quickInput.pick(items, { placeHolder: localize('klawlySyncMemoryPlaceholder', "Synced memory, by project") });
			const path = (picked as { path?: string } | undefined)?.path;
			if (path) {
				await editors.openEditor({ resource: URI.file(path) });
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: KLAWLY_SYNC_PREVIEW_HISTORY_COMMAND_ID, title: localize2('klawlySyncPreviewHistory', "Preview Session History Sync"), category: KLAWLY_CATEGORY, f1: true });
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const sync = accessor.get(IKlawlySyncService);
			const dialogs = accessor.get(IDialogService);
			const preview = await sync.previewHistory();
			const included = preview.projects.filter(project => !project.excluded && project.sessions > 0);
			const excluded = preview.projects.filter(project => project.excluded).length;
			const held = preview.projects.reduce((sum, project) => sum + project.heldBack, 0);
			const lines = included.map(project => localize('klawlySyncPreviewProject', "{0}: {1} sessions, {2} KB. Starts with: {3}", project.identity, project.sessions, Math.ceil(project.bytes / 1024), project.samples.slice(0, 2).join(' | ') || '-'));
			if (held > 0) {
				lines.push(localize('klawlySyncPreviewHeld', "{0} sessions stay on this machine because they hold a secret.", held));
			}
			if (excluded > 0) {
				lines.push(localize('klawlySyncPreviewExcluded', "{0} projects are on your exclude list and are not sent.", excluded));
			}
			if (included.length === 0) {
				lines.push(localize('klawlySyncPreviewNothing', "There is nothing to send yet."));
			}
			const { confirmed } = await dialogs.confirm({
				message: localize('klawlySyncPreviewMessage', "Session history to sync: {0} KB in total", Math.ceil(preview.totalBytes / 1024)),
				detail: lines.join('\n'),
				primaryButton: localize('klawlySyncPreviewApprove', "&&Sync This History"),
			});
			if (confirmed) {
				await sync.approveHistory();
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: KLAWLY_SYNC_DELETE_HISTORY_COMMAND_ID, title: localize2('klawlySyncDeleteHistory', "Delete Synced History"), category: KLAWLY_CATEGORY, f1: true });
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const dialogs = accessor.get(IDialogService);
			const sync = accessor.get(IKlawlySyncService);
			const { confirmed } = await dialogs.confirm({
				type: 'warning',
				message: localize('klawlySyncDeleteHistoryMessage', "Delete the synced session history?"),
				detail: localize('klawlySyncDeleteHistoryDetail', "This removes the history from your private sync repository and from this machine's synced copy, and stops history sync until you approve a preview again. Your own sessions are not touched."),
				primaryButton: localize('klawlySyncDeleteHistoryButton', "&&Delete"),
			});
			if (!confirmed) {
				return;
			}
			try {
				await sync.deleteSyncedHistory();
			} catch (error) {
				await dialogs.error(localize('klawlySyncDeleteHistoryFailed', "Could not delete the synced history."), error instanceof Error ? error.message : String(error));
			}
		}
	});
}
