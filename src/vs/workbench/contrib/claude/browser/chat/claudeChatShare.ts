/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { CLAUDE_SHARE_LINKS_SETTING, claudeShareContent, parseClaudeGistId } from '../../../../../platform/claude/common/claudeShare.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { redactSecrets } from '../../../../services/claude/common/claudeAgentLog.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { CLAUDE_AGENT_ENABLED } from '../../common/claudeContextKeys.js';
import { KLAWLY_CATEGORY } from '../../common/claudeViews.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'claude',
	order: 102,
	title: localize('claudeConfigurationTitle', "AI / Claude"),
	type: 'object',
	properties: {
		[CLAUDE_SHARE_LINKS_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('claudeShareLinks', "Adds Share Link to the chat's More menu: it publishes the chat's transcript, with secrets removed, as a secret GitHub gist through your GitHub CLI (gh) sign-in and copies the link. Anyone with the link can read it. Klawly has no server; nothing is published without this setting and a confirmation."),
		},
	},
});

export const IClaudeChatShareService = createDecorator<IClaudeChatShareService>('claudeChatShareService');

/** Copy Chat as Markdown and Export Transcript: the chat's More menu and the Command Palette (issue 767). */
export const CLAUDE_COPY_CHAT_MARKDOWN_COMMAND_ID = 'claude.copyChatMarkdown';
export const CLAUDE_EXPORT_TRANSCRIPT_COMMAND_ID = 'claude.exportTranscript';
/** Share Link: the chat's More menu says "Share Link…", the palette "Share Chat Link…" (issue 767). */
export const CLAUDE_SHARE_CHAT_LINK_COMMAND_ID = 'claude.shareChatLink';
/** Open Shared Chat: paste a gist link to read a shared chat, or fork it into a new chat (issue 684). */
export const CLAUDE_OPEN_SHARED_CHAT_COMMAND_ID = 'claude.openSharedChat';

/** Copy Chat as Markdown and Share Link (issue 490), for the chat's More menu and the History row menu. */
export interface IClaudeChatShareService {
	readonly _serviceBrand: undefined;
	/** Whether Share Link is turned on. */
	readonly linksEnabled: boolean;
	/** Saves the chat's redacted transcript as Markdown where the user picks; rejects when the write fails. */
	exportTranscript(sessionId: string): Promise<void>;
	/** Copies the chat's redacted transcript as Markdown. */
	copyMarkdown(sessionId: string): Promise<void>;
	/** Publishes the chat as a secret gist after a confirmation, and copies the link. */
	shareLink(sessionId: string): Promise<void>;
	/** Asks for a gist link, reads the shared chat with the GitHub CLI, then offers to read it or fork it into a new chat. */
	openShared(): Promise<void>;
}

export class ClaudeChatShareService implements IClaudeChatShareService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IClipboardService private readonly _clipboard: IClipboardService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IDialogService private readonly _dialogs: IDialogService,
		@IFileDialogService private readonly _fileDialogs: IFileDialogService,
		@INotificationService private readonly _notifications: INotificationService,
		@IEditorService private readonly _editors: IEditorService,
		@IOpenerService private readonly _opener: IOpenerService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
	) { }

	get linksEnabled(): boolean {
		return this._configuration.getValue<boolean>(CLAUDE_SHARE_LINKS_SETTING) === true;
	}

	async exportTranscript(sessionId: string): Promise<void> {
		const title = this._agent.getSessions().find(session => session.id === sessionId)?.title ?? '';
		const folder = this._workspace.getWorkspace().folders[0]?.uri ?? await this._fileDialogs.defaultFilePath();
		const target = await this._fileDialogs.showSaveDialog({
			title: localize('claudeExportTranscriptTitle', "Export Transcript"),
			defaultUri: joinPath(folder, `${title.replace(/[^\w.-]+/g, '_') || 'transcript'}.md`),
			filters: [{ name: localize('claudeTranscriptMarkdown', "Markdown"), extensions: ['md'] }],
		});
		if (target) {
			await this._agent.writeExportedTranscript(sessionId, 'markdown', target);
		}
	}

	async copyMarkdown(sessionId: string): Promise<void> {
		try {
			// The export already masks secrets in tool output; the secret guard runs on top, as for a link.
			const { content } = claudeShareContent(await this._agent.exportSession(sessionId, 'markdown'));
			await this._clipboard.writeText(content);
			this._notifications.status(localize('claudeShareCopied', "Copied the chat as Markdown."), { hideAfter: 3000 });
		} catch (error) {
			this._notifications.error(localize('claudeShareCopyFailed', "Couldn't copy the chat: {0}", error instanceof Error ? error.message : String(error)));
		}
	}

	async openShared(): Promise<void> {
		if (!this._runtime.readSharedGist) {
			return;
		}
		const link = await this._quickInput.input({
			title: localize('claudeOpenSharedTitle', "Open Shared Chat"),
			prompt: localize('claudeOpenSharedPrompt', "Paste the gist link of a chat shared from Klawly."),
			placeHolder: 'https://gist.github.com/…',
			validateInput: async value => value.trim() && !parseClaudeGistId(value) ? localize('claudeOpenSharedInvalid', "That is not a gist link.") : undefined,
		});
		if (!link?.trim()) {
			return;
		}
		const result = await this._runtime.readSharedGist(link);
		if (result.kind !== 'read') {
			this._notifications.error(result.problem === 'ghMissing'
				? localize('claudeOpenSharedGhMissing', "Open Shared Chat reads through the GitHub CLI. Install gh, run \"gh auth login\", then try again.")
				: localize('claudeOpenSharedFailed', "Couldn't open the shared chat: {0}", result.message));
			return;
		}
		// A shared chat is somebody else's text: the secret guard runs on it too, and it is only ever opened as plain Markdown.
		const { content } = claudeShareContent(result.content);
		const read = () => this._editors.openEditor({ resource: undefined, contents: content, languageId: 'markdown', options: { pinned: true } });
		const fork = () => {
			const session = this._agent.createSession({ draft: localize('claudeOpenSharedDraft', "Here is a chat that was shared with me. Read it, then continue from where it stopped.\n\n{0}", content) });
			this._agent.selectSession(session.id);
		};
		this._notifications.prompt(Severity.Info, localize('claudeOpenSharedDone', "Opened the shared chat. It is read-only text: nothing in it runs."), [
			{ label: localize('claudeOpenSharedRead', "Read"), run: read },
			{ label: localize('claudeOpenSharedFork', "Fork into New Chat"), run: fork },
		]);
	}

	async shareLink(sessionId: string): Promise<void> {
		if (!this.linksEnabled || !this._runtime.createSecretGist) {
			return;
		}
		const title = this._agent.getSessions().find(session => session.id === sessionId)?.title
			?? this._agent.getHistory().find(session => session.id === sessionId)?.title
			?? localize('claudeShareDefaultTitle', "Klawly chat");
		let shared: { readonly content: string; readonly removed: number };
		try {
			shared = claudeShareContent(await this._agent.exportSession(sessionId, 'markdown'));
		} catch (error) {
			this._notifications.error(localize('claudeShareExportFailed', "Couldn't read the chat: {0}", error instanceof Error ? error.message : String(error)));
			return;
		}
		const { confirmed } = await this._dialogs.confirm({
			type: 'warning',
			message: localize('claudeShareConfirm', "Publish \"{0}\" as a secret gist?", title),
			detail: [
				localize('claudeShareConfirmDetail', "The transcript goes to GitHub through your GitHub CLI sign-in. A secret gist is not listed, but anyone with the link can read it, and you can delete it on GitHub."),
				shared.removed > 0
					? localize('claudeShareRemoved', "The secret guard removed {0} secrets from it.", shared.removed)
					: localize('claudeShareNoneRemoved', "The secret guard found no secrets in it. Check the chat for anything private before you share it."),
			].join('\n\n'),
			primaryButton: localize({ key: 'claudeSharePublish', comment: ['&& denotes a mnemonic'] }, "&&Publish"),
		});
		if (!confirmed) {
			return;
		}
		const result = await this._runtime.createSecretGist({ filename: title, description: localize('claudeShareDescription', "Klawly chat: {0}", title), content: shared.content });
		if (result.kind === 'created') {
			await this._clipboard.writeText(result.url);
			this._notifications.prompt(Severity.Info, localize('claudeShareCreated', "Copied the link to the secret gist."), [{
				label: localize('claudeShareOpen', "Open Gist"),
				run: () => this._opener.open(URI.parse(result.url), { openExternal: true }),
			}]);
			return;
		}
		switch (result.problem) {
			case 'ghMissing':
				this._notifications.prompt(Severity.Warning, localize('claudeShareGhMissing', "Share Link publishes through the GitHub CLI. Install gh, run \"gh auth login\", then try again."), [{
					label: localize('claudeShareGetGh', "Get the GitHub CLI"),
					run: () => this._opener.open(URI.parse('https://cli.github.com'), { openExternal: true }),
				}]);
				return;
			case 'signedOut':
				this._notifications.warn(localize('claudeShareSignedOut', "The GitHub CLI isn't signed in, or can't create gists. Run \"gh auth login\" with the gist scope, then try again."));
				return;
			default:
				this._notifications.error(localize('claudeShareFailed', "Couldn't publish the chat: {0}", result.message));
		}
	}
}


registerSingleton(IClaudeChatShareService, ClaudeChatShareService, InstantiationType.Delayed);

/** The current chat when it has a turn to share; otherwise says so and returns nothing. */
function sharedChat(accessor: ServicesAccessor): string | undefined {
	const agent = accessor.get(IClaudeAgentService);
	const session = agent.getCurrentSession();
	if (!session || agent.getViewState(session.id).turns.length === 0) {
		accessor.get(INotificationService).info(localize('claudeShareNoChat', "Open a chat with at least one message first."));
		return undefined;
	}
	return session.id;
}

/**
 * The chat's More menu jobs as Command Palette commands on the current chat (issue 767), so
 * "export chat", "save chat", "copy chat" and "share" find them.
 */
export function registerClaudeChatShareCommands(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_COPY_CHAT_MARKDOWN_COMMAND_ID,
				title: { ...localize2('claudeCopyChatMarkdownCommand', "Copy Chat as Markdown"), original: 'Copy Chat as Markdown (Copy Transcript)' },
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const sessionId = sharedChat(accessor);
			if (sessionId) {
				await accessor.get(IClaudeChatShareService).copyMarkdown(sessionId);
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_EXPORT_TRANSCRIPT_COMMAND_ID,
				title: { ...localize2('claudeExportTranscriptCommand', "Export Transcript..."), original: 'Export Transcript... (Export Chat, Save Chat, Download Chat)' },
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const sessionId = sharedChat(accessor);
			if (!sessionId) {
				return;
			}
			const notifications = accessor.get(INotificationService);
			try {
				await accessor.get(IClaudeChatShareService).exportTranscript(sessionId);
			} catch (error) {
				notifications.error(redactSecrets(error instanceof Error ? error.message : String(error)));
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_SHARE_CHAT_LINK_COMMAND_ID,
				title: { ...localize2('claudeShareChatLinkCommand', "Share Chat Link..."), original: 'Share Chat Link... (Share Chat, Publish Chat, Gist)' },
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const share = accessor.get(IClaudeChatShareService);
			// Publishing stays opt-in (issue 490): with the setting off, the palette points to it instead of publishing.
			if (!share.linksEnabled) {
				const commands = accessor.get(ICommandService);
				accessor.get(INotificationService).prompt(Severity.Info, localize('claudeShareLinksOff', "Share Link is off. It publishes the chat as a secret GitHub gist; turn it on in Settings first."), [{
					label: localize('claudeShareLinksOpenSetting', "Open Setting"),
					run: () => commands.executeCommand('workbench.action.openSettings', CLAUDE_SHARE_LINKS_SETTING),
				}]);
				return;
			}
			const sessionId = sharedChat(accessor);
			if (sessionId) {
				await share.shareLink(sessionId);
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_OPEN_SHARED_CHAT_COMMAND_ID,
				title: { ...localize2('claudeOpenSharedChatCommand', "Open Shared Chat..."), original: 'Open Shared Chat... (Open Gist, Fork Chat)' },
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IClaudeChatShareService).openShared();
		}
	});
}
