/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAction, toAction } from '../../../../../base/common/actions.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { CLAUDE_AGENTS_WINDOW_ENABLED_SETTING } from '../../../../../platform/claude/common/claudeAgentHost.js';
import { agentsWindowSessionResource } from '../../../../../platform/claude/common/claudeAgentsWindowSessions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ClaudeAgentSession, IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { CLAUDE_AGENTS_WINDOW } from '../../common/claudeContextKeys.js';
import { CLAUDE_OPEN_IN_AGENT_PANE_COMMAND_ID } from '../../common/claudeViews.js';
import { IClaudeChatShareService } from './claudeChatShare.js';

/** Upstream's command that opens one session in the Agents window (`OpenChatSessionInAgentsWindowAction`). */
const OPEN_SESSION_IN_AGENTS_WINDOW_COMMAND_ID = 'workbench.action.chat.openSessionInAgentsWindow';

/**
 * The actions one saved session offers wherever it is listed: the history popover
 * and the agents column share them.
 */
export class ClaudeSessionActions {

	constructor(
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@IFileDialogService private readonly _fileDialogs: IFileDialogService,
		@INotificationService private readonly _notifications: INotificationService,
		@IClaudeChatShareService private readonly _share: IClaudeChatShareService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@ICommandService private readonly _commands: ICommandService,
		@IContextKeyService private readonly _contextKeys: IContextKeyService,
	) { }

	/** Context menu rows. `forked` runs after a fork opened its new session. */
	actions(session: ClaudeAgentSession, forked: () => void): IAction[] {
		return [
			toAction({ id: 'claude.history.open', label: localize('claudeHistoryOpen', "Open"), run: () => { void this._agent.resume(session.id); } }),
			// One session in both windows (issue 618): a chat Claude Code has answered opens there too.
			...(session.claudeSessionId && this._configuration.getValue<boolean>(CLAUDE_AGENTS_WINDOW_ENABLED_SETTING) === true ? [toAction({ id: 'claude.history.openInAgentsWindow', label: localize('claudeHistoryOpenInAgentsWindow', "Open in Agents Window"), run: () => { void this.openInAgentsWindow(session); } })] : []),
			// The way back from the Agents window (#1509): it shows the current session in the IDE window's Agent pane.
			...(session.claudeSessionId && CLAUDE_AGENTS_WINDOW.getValue(this._contextKeys) === true ? [toAction({ id: 'claude.history.openInAgentPane', label: localize('claudeHistoryOpenInAgentPane', "Open in Agent Pane"), run: () => this.openInAgentPane(session) })] : []),
			toAction({ id: 'claude.history.rename', label: localize('claudeHistoryRename', "Rename"), run: () => { void this.rename(session); } }),
			toAction({ id: 'claude.history.pin', label: session.pinned ? localize('claudeHistoryUnpin', "Unpin") : localize('claudeHistoryPin', "Pin"), run: () => this._agent.setPinned(session.id, !session.pinned) }),
			toAction({ id: 'claude.history.archive', label: session.archived ? localize('claudeHistoryUnarchive', "Unarchive") : localize('claudeHistoryArchive', "Archive"), run: () => this._agent.setArchived(session.id, !session.archived) }),
			toAction({ id: 'claude.history.fork', label: localize('claudeHistoryFork', "Fork from turn"), run: () => { void this.fork(session, forked); } }),
			toAction({ id: 'claude.history.exportMd', label: localize('claudeHistoryExportMd', "Export transcript"), run: () => { void this.exportSession(session, 'markdown'); } }),
			toAction({ id: 'claude.history.exportJson', label: localize('claudeHistoryExportJson', "Export JSON"), run: () => { void this.exportSession(session, 'json'); } }),
			toAction({ id: 'claude.history.copyMarkdown', label: localize('claudeHistoryCopyMarkdown', "Copy as Markdown"), run: () => { void this._share.copyMarkdown(session.id); } }),
			...(this._share.linksEnabled ? [toAction({ id: 'claude.history.shareLink', label: localize('claudeHistoryShareLink', "Share Link..."), run: () => { void this._share.shareLink(session.id); } })] : []),
			toAction({ id: 'claude.history.reference', label: localize('claudeHistoryReference', "Reference in new chat"), run: () => { void this._agent.referenceInNewSession(session.id); } }),
			toAction({ id: 'claude.history.reveal', label: localize('claudeHistoryReveal', "Reveal worktree"), run: () => { void this.reveal(session); } }),
			toAction({ id: 'claude.history.delete', label: localize('claudeHistoryDelete', "Delete"), run: () => { void this._agent.deleteSession(session.id); } }),
		];
	}

	async rename(session: ClaudeAgentSession): Promise<void> {
		const title = await this._quickInput.input({
			prompt: localize('claudeRenamePrompt', "Rename session"),
			value: session.title,
		});
		if (title) {
			await this._agent.renameSession(session.id, title);
		}
	}

	private async fork(session: ClaudeAgentSession, forked: () => void): Promise<void> {
		await this._agent.resume(session.id);
		const turns = this._agent.getViewState(session.id).turns;
		const pick = await this._quickInput.pick(
			turns.map(turn => ({ id: turn.id, label: turn.user.text || turn.id })),
			{ placeHolder: localize('claudeForkPlace', "Fork from turn") },
		);
		if (pick) {
			await this._agent.forkSession(session.id, pick.id);
			forked();
		}
	}

	private async exportSession(session: ClaudeAgentSession, format: 'markdown' | 'json'): Promise<void> {
		const uri = await this._fileDialogs.showSaveDialog({
			defaultUri: URI.file(`${session.title.replace(/[^\w.-]+/g, '_')}.${format === 'json' ? 'json' : 'md'}`),
		});
		if (!uri) {
			return;
		}
		await this._agent.writeExportedTranscript(session.id, format, uri);
	}

	private async openInAgentsWindow(session: ClaudeAgentSession): Promise<void> {
		if (!session.claudeSessionId) {
			return;
		}
		// Two windows sending to one Claude Code session at once would fork its transcript.
		if (this._agent.getViewState(session.id).turns.at(-1)?.status === 'running') {
			this._notifications.info(localize('claudeAgentsWindowWhileRunning', "Wait for this chat's turn to finish, or stop it, then open it in the Agents window."));
			return;
		}
		try {
			await this._commands.executeCommand(OPEN_SESSION_IN_AGENTS_WINDOW_COMMAND_ID, agentsWindowSessionResource(session.claudeSessionId));
		} catch (error) {
			this._notifications.info(error instanceof Error ? error.message : String(error));
		}
	}

	private async openInAgentPane(session: ClaudeAgentSession): Promise<void> {
		// The command acts on the current session, so make this one current first.
		await this._agent.resume(session.id);
		await this._commands.executeCommand(CLAUDE_OPEN_IN_AGENT_PANE_COMMAND_ID);
	}

	private async reveal(session: ClaudeAgentSession): Promise<void> {
		try {
			await this._agent.revealWorktree(session.id);
		} catch (error) {
			this._notifications.info(error instanceof Error ? error.message : String(error));
		}
	}
}
