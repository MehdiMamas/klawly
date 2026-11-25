/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { CLAUDE_AGENT_ENABLED_SETTING, CLAUDE_REVIEW_AUTO_KEEP_SETTING, readClaudeAgentEnabled, readClaudeAutoKeep } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { ResourceContextKey } from '../../../../common/contextkeys.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../../common/editor.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudeReviewService, ReviewConflictError, ReviewScope } from '../../../../services/claude/common/claudeReview.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { CLAUDE_AGENT_ENABLED, CLAUDE_REVIEW_PENDING_FILES } from '../../common/claudeContextKeys.js';
import { claudePendingStatusText, claudeScopeActionLabel, claudeUndoAllFileList } from '../../common/claudeKeepAll.js';
import { CLAUDE_OPEN_REVIEW_EDITOR_COMMAND_ID, KLAWLY_CATEGORY } from '../../common/claudeViews.js';

export const CLAUDE_KEEP_EDITOR_FILE_COMMAND_ID = 'klawly.review.keepEditorFile';
export const CLAUDE_PENDING_CHANGES_MENU_COMMAND_ID = 'klawly.review.pendingMenu';
export const CLAUDE_TOGGLE_AUTO_KEEP_COMMAND_ID = 'klawly.review.toggleAutoKeep';
export const CLAUDE_PENDING_STATUS_ENTRY_ID = 'claude.review.pending';

/** The active editor's file has agent changes waiting: Keep File and Keep All join its title bar. */
export const CLAUDE_EDITOR_FILE_PENDING = ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, ContextKeyExpr.in(ResourceContextKey.Resource.key, CLAUDE_REVIEW_PENDING_FILES.key));

/**
 * Asks first, listing the files, then undoes every pending change in `scope`.
 * Returns whether the user went ahead.
 */
export async function claudeUndoAllPending(review: IClaudeReviewService, dialogs: IDialogService, notifications: INotificationService, labels: ILabelService, scope: ReviewScope): Promise<boolean> {
	const summary = review.pendingSummary(scope);
	if (summary.hunks === 0) {
		return false;
	}
	const { confirmed } = await dialogs.confirm({
		type: 'warning',
		message: localize('claudeUndoAllConfirm', "Undo the changes Claude made that you have not kept?"),
		detail: claudeUndoAllFileList(summary.uris.map(uri => labels.getUriLabel(uri, { relative: true }))),
		primaryButton: claudeScopeActionLabel('undo', summary),
	});
	if (!confirmed) {
		return false;
	}
	try {
		await review.undoAllPending(scope);
	} catch (error) {
		notifications.warn(error instanceof ReviewConflictError
			? localize('claudeUndoAllConflict', "Some files were edited after Claude changed them, so their changes still wait for review. Open the review to resolve them.")
			: toErrorMessage(error));
	}
	return true;
}

/**
 * Turns Auto-Keep on or off for one chat. With the setting off, turning it on
 * sets it to "This Chat" first, so the chat's toggle takes effect.
 */
export async function claudeToggleAutoKeep(review: IClaudeReviewService, configuration: IConfigurationService, sessionId: string): Promise<boolean> {
	const on = !review.isAutoKeep(sessionId);
	if (on && readClaudeAutoKeep(configuration.getValue(CLAUDE_REVIEW_AUTO_KEEP_SETTING)) === 'off') {
		await configuration.updateValue(CLAUDE_REVIEW_AUTO_KEEP_SETTING, 'thisChat', ConfigurationTarget.USER);
	}
	review.setAutoKeep(sessionId, on);
	return on;
}

/** The chat to open a review of: the current one when it has changes waiting, else the first that does. */
function reviewChat(review: IClaudeReviewService, agent: IClaudeAgentService): string | undefined {
	const current = agent.getCurrentSession()?.id;
	const { sessionIds } = review.pendingSummary({ kind: 'all' });
	return current && sessionIds.includes(current) ? current : sessionIds[0];
}

function editorFile(editors: IEditorService, resource: unknown): URI | undefined {
	return URI.isUri(resource) ? resource : EditorResourceAccessor.getOriginalUri(editors.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
}

/** Keep File, Toggle Auto-Keep and the status bar menu (issue 706). Keep All and Undo All live with the spec 45 commands. */
export function registerClaudeKeepAllCommands(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_KEEP_EDITOR_FILE_COMMAND_ID,
				title: localize2('claudeKeepEditorFile', "Keep File"),
				category: KLAWLY_CATEGORY,
				icon: Codicon.check,
				f1: true,
				precondition: CLAUDE_EDITOR_FILE_PENDING,
				menu: { id: MenuId.EditorTitle, group: 'navigation', order: -20, when: CLAUDE_EDITOR_FILE_PENDING },
			});
		}
		run(accessor: ServicesAccessor, resource?: unknown): void {
			const review = accessor.get(IClaudeReviewService);
			const uri = editorFile(accessor.get(IEditorService), resource);
			if (!uri) {
				return;
			}
			const turns = new Map<string, { readonly sessionId: string; readonly turnId: string }>();
			for (const ref of review.hunksFor(uri)) {
				turns.set(`${ref.sessionId}/${ref.turnId}`, ref);
			}
			for (const { sessionId, turnId } of turns.values()) {
				review.acceptFile(sessionId, turnId, uri);
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_TOGGLE_AUTO_KEEP_COMMAND_ID,
				title: localize2('claudeToggleAutoKeep', "Toggle Auto-Keep for This Chat"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const review = accessor.get(IClaudeReviewService);
			const configuration = accessor.get(IConfigurationService);
			const notifications = accessor.get(INotificationService);
			const sessionId = accessor.get(IClaudeAgentService).getCurrentSession()?.id;
			if (!sessionId) {
				return;
			}
			const on = await claudeToggleAutoKeep(review, configuration, sessionId);
			notifications.status(on
				? localize('claudeAutoKeepOn', "Auto-Keep is on for this chat. Claude's edits are kept as they land.")
				: localize('claudeAutoKeepOff', "Auto-Keep is off for this chat."), { hideAfter: 3000 });
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_PENDING_CHANGES_MENU_COMMAND_ID,
				title: localize2('claudePendingChangesMenu', "Show Changes to Review"),
				f1: true,
				category: KLAWLY_CATEGORY,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const review = accessor.get(IClaudeReviewService);
			const agent = accessor.get(IClaudeAgentService);
			const quickInput = accessor.get(IQuickInputService);
			const commands = accessor.get(ICommandService);
			const dialogs = accessor.get(IDialogService);
			const notifications = accessor.get(INotificationService);
			const labels = accessor.get(ILabelService);
			const summary = review.pendingSummary({ kind: 'all' });
			if (summary.hunks === 0) {
				return;
			}
			const items: (IQuickPickItem & { readonly id: 'keep' | 'undo' | 'open' })[] = [
				{ id: 'keep', label: localize('claudePendingKeepAll', "Keep All"), description: claudeScopeActionLabel('keep', summary) },
				{ id: 'undo', label: localize('claudePendingUndoAll', "Undo All"), description: claudeScopeActionLabel('undo', summary) },
				{ id: 'open', label: localize('claudePendingOpenReview', "Open Review") },
			];
			const picked = await quickInput.pick(items, { placeHolder: claudePendingStatusText(summary.hunks) });
			switch (picked?.id) {
				case 'keep':
					review.keepAllPending({ kind: 'all' });
					return;
				case 'undo':
					await claudeUndoAllPending(review, dialogs, notifications, labels, { kind: 'all' });
					return;
				case 'open': {
					const sessionId = reviewChat(review, agent);
					if (sessionId) {
						await commands.executeCommand(CLAUDE_OPEN_REVIEW_EDITOR_COMMAND_ID, sessionId);
					}
					return;
				}
			}
		}
	});
}

/** The status bar entry for what waits for review, or undefined when nothing does. Exported for tests. */
export function claudePendingStatusEntry(hunks: number, files: number, chats: number): IStatusbarEntry | undefined {
	if (hunks === 0) {
		return undefined;
	}
	const text = claudePendingStatusText(hunks);
	return {
		name: localize('claudePendingStatusName', "Changes to Review"),
		text: `$(diff-multiple) ${text}`,
		ariaLabel: text,
		tooltip: claudeScopeActionLabel('keep', { hunks, files, chats }),
		role: 'button',
		command: CLAUDE_PENDING_CHANGES_MENU_COMMAND_ID,
	};
}

/**
 * "N changes to review" on the right of the status bar while any chat,
 * background or delegated agent has changes waiting. It opens Keep All,
 * Undo All and Open Review (issue 706).
 */
export class ClaudePendingStatusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudePendingStatus';

	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly _statusbar: IStatusbarService,
		@IClaudeReviewService private readonly _review: IClaudeReviewService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
	) {
		super();
		this._register(this._review.onDidChangeReview(() => this.update()));
		this._register(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_AGENT_ENABLED_SETTING)) {
				this.update();
			}
		}));
		this.update();
	}

	private update(): void {
		const { hunks, files, chats } = this._review.pendingSummary({ kind: 'all' });
		const entry = readClaudeAgentEnabled(this._configuration.getValue(CLAUDE_AGENT_ENABLED_SETTING)) ? claudePendingStatusEntry(hunks, files, chats) : undefined;
		if (!entry) {
			this._entry.clear();
		} else if (this._entry.value) {
			this._entry.value.update(entry);
		} else {
			this._entry.value = this._statusbar.addEntry(entry, CLAUDE_PENDING_STATUS_ENTRY_ID, StatusbarAlignment.RIGHT, 100);
		}
	}
}
