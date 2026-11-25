/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { claudeSessionIdFromAgentsWindow } from '../../../../platform/claude/common/claudeAgentsWindowSessions.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IOpenURLOptions, IURLHandler, IURLService } from '../../../../platform/url/common/url.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustRequestService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { AgentMode } from '../../../../platform/claude/common/claudeContext.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { IClaudeContextService } from '../../../services/claude/common/claudeContextService.js';
import { readClaudeAgentLink, readClaudeCodeSessionId, readClaudeLinkMode } from '../common/claudeAgentLinks.js';
import { CLAUDE_CHAT_HANDOFF_KEY, claudeChatHandoffIsFor, parseClaudeChatHandoff, serializeClaudeChatHandoff } from '../common/claudeChatHandoff.js';
import { ClaudeTerminalHandoff, claudeHandoffCardKey, formatClaudeTerminalHandoff, parseClaudeTerminalHandoff, readClaudeTerminalHandoffPath, CLAUDE_TERMINAL_HANDOFF_MAX_BYTES } from '../common/claudeTerminalHandoff.js';
import { CLAUDE_AGENT_DISABLED } from '../common/claudeContextKeys.js';
import { CLAUDE_AGENT_VIEW_ID } from '../common/claudeViews.js';

/** What the main process forwards for `klawly chat` (upstream's `chat` subcommand). */
interface ChatCommandLineArgs {
	readonly _?: readonly string[];
	readonly mode?: string;
	readonly worktree?: boolean;
	readonly resume?: string;
}

/**
 * Klawly from the terminal and links (issue 519).
 * - `klawly chat [-m agent|plan|ask] "prompt"` (upstream's `chat` subcommand, which the
 *   main process forwards to the window): after workspace trust, a new Klawly chat in
 *   that mode with the prompt sent, as typed at the terminal.
 * - `--worktree` (`-w`) runs that chat in a new git worktree: the target is set before the prompt is
 *   sent, so the worktree is made by the same path as New Worktree in Run in (issue 861).
 * - `klawly://agent/new?prompt=...&mode=plan` puts the prompt in a new chat's
 *   composer and never sends it. With `&folder=<path>` the user is asked first, then the folder opens in
 *   its window and the prompt waits in a new chat's composer there (issue 861).
 *   `klawly://agent/open?session=<id>` opens a saved chat.
 * - `klawly://agent/import?session=<Claude Code session id>&folder=<path>&handoff=<text>` asks, then opens
 *   that folder's window and a chat that continues the terminal session; `klawly chat --resume <id> [text]`
 *   does the same for the folder of the window it lands in, after workspace trust (issue 1186). The
 *   handoff text waits in the composer, never sent. Klawly only passes the id on: Claude Code reads its
 *   own transcript, and nothing here reads or writes Claude Code's files.
 * Headless runs stay Claude Code's own: `claude -p`.
 *
 * One session in both windows (issue 618): the Agents window's Open in Agent Pane opens this window
 * with `vscode:openChatSession` and the session's resource. For a Claude Code session the Agent
 * pane opens the chat that continues it (upstream's chat view skips those resources).
 */
export class ClaudeAgentEntryPoints extends Disposable implements IWorkbenchContribution, IURLHandler {
	static readonly ID = 'workbench.contrib.claudeAgentEntryPoints';

	constructor(
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeContextService private readonly _context: IClaudeContextService,
		@IViewsService private readonly _views: IViewsService,
		@IContextKeyService private readonly _contextKeys: IContextKeyService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IWorkspaceTrustRequestService private readonly _trust: IWorkspaceTrustRequestService,
		@INotificationService private readonly _notifications: INotificationService,
		@IHostService private readonly _host: IHostService,
		@IProductService private readonly _product: IProductService,
		@ILogService private readonly _log: ILogService,
		@IURLService urls: IURLService,
		@IStorageService private readonly _storage: IStorageService,
		@IDialogService private readonly _dialogs: IDialogService,
		@IFileService private readonly _files: IFileService,
	) {
		super();
		const onChat = (_: unknown, ...args: unknown[]) => void this.chat(args[0] as ChatCommandLineArgs | undefined).catch(error => this._log.error('[claude] klawly chat failed', error));
		ipcRenderer.on('vscode:handleChatRequest', onChat);
		this._register({ dispose: () => ipcRenderer.removeListener('vscode:handleChatRequest', onChat) });
		const onOpenSession = (_: unknown, ...args: unknown[]) => {
			if (typeof args[0] === 'string') {
				void this.openAgentsWindowSession(URI.parse(args[0])).catch(error => this._log.error('[claude] opening an Agents window session failed', error));
			}
		};
		ipcRenderer.on('vscode:openChatSession', onOpenSession);
		this._register({ dispose: () => ipcRenderer.removeListener('vscode:openChatSession', onOpenSession) });
		this._register(urls.registerHandler(this));
		// A link's prompt for this window's folder: taken now (this window was just opened for it) or
		// when another window leaves it (this window already had the folder open).
		this._register(this._storage.onDidChangeValue(StorageScope.APPLICATION, CLAUDE_CHAT_HANDOFF_KEY, this._store)(() => void this.takeHandoff().catch(error => this._log.error('[claude] taking a link prompt failed', error))));
		void this.takeHandoff().catch(error => this._log.error('[claude] taking a link prompt failed', error));
	}

	private get windowFolders(): string[] {
		return this._workspace.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.file).map(folder => folder.uri.fsPath);
	}

	/** Takes the waiting handoff when it is for this window's folder: a new chat with the prompt in the composer, never sent. */
	private async takeHandoff(): Promise<void> {
		const handoff = parseClaudeChatHandoff(this._storage.get(CLAUDE_CHAT_HANDOFF_KEY, StorageScope.APPLICATION), Date.now());
		if (!handoff || !this.enabled || !claudeChatHandoffIsFor(handoff, this.windowFolders)) {
			return;
		}
		this._storage.remove(CLAUDE_CHAT_HANDOFF_KEY, StorageScope.APPLICATION);
		await this._host.focus(mainWindow);
		if (handoff.resume) {
			await this.openImported(handoff.resume, handoff.prompt, handoff.card);
			return;
		}
		this.openDraftChat(handoff.prompt, handoff.mode);
		await this._views.openView(CLAUDE_AGENT_VIEW_ID, true);
	}

	/** The chat that continues Claude Code session `claudeSessionId`, with the handoff text in its composer. */
	private async openImported(claudeSessionId: string, handoff: string, card?: ClaudeTerminalHandoff): Promise<void> {
		const opened = await this._agent.openClaudeCodeSession(claudeSessionId, localize('klawlyImportedTitle', "From the Terminal"));
		if (card) {
			this._storage.store(claudeHandoffCardKey(opened.sessionId), JSON.stringify(card), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else if (handoff) {
			this._agent.setDraft(opened.sessionId, handoff);
		}
		await this._views.openView(CLAUDE_AGENT_VIEW_ID, true);
		if (opened.adopted) {
			this._notifications.info(localize('klawlyImportedNotice', "This chat continues a Claude Code session from the terminal. Its earlier turns are shown there, and Claude remembers them here."));
		}
	}

	/**
	 * Opens Claude Code session `session` as a chat in `folder`'s window: here when this window has the
	 * folder, else the folder opens and the session waits for its window. A link asks first; a missing
	 * folder or a declined question changes nothing.
	 */
	private async importSession(link: { readonly session: string; readonly folder: string; readonly handoff: string }, ask: boolean): Promise<void> {
		const folderUri = URI.file(link.folder);
		const stat = await this._files.stat(folderUri).catch(() => undefined);
		if (!stat?.isDirectory) {
			this._notifications.warn(localize('klawlyLinkNoFolder', "That link names a folder that does not exist on this computer: {0}", link.folder));
			return;
		}
		if (ask) {
			const { confirmed } = await this._dialogs.confirm({
				message: localize('klawlyLinkImport', "A link wants to open {0} and continue Claude Code session {1} there.", link.folder, link.session),
				detail: localize('klawlyLinkImportDetail', "The chat picks up the same conversation, so Claude remembers its earlier turns. Any note from the link is only placed in the message box. It is not sent until you press Enter."),
				primaryButton: localize({ key: 'klawlyLinkImportButton', comment: ['&& denotes a mnemonic'] }, "&&Continue Session"),
			});
			if (!confirmed) {
				return;
			}
		}
		const { note, card } = await this.readHandoffNote(link.handoff);
		if (claudeChatHandoffIsFor({ folder: link.folder, prompt: '', createdAt: 0 }, this.windowFolders)) {
			await this.openImported(link.session, note, card);
			return;
		}
		this._storage.store(CLAUDE_CHAT_HANDOFF_KEY, serializeClaudeChatHandoff({ folder: link.folder, prompt: note, resume: link.session, createdAt: Date.now(), ...(card ? { card } : {}) }), StorageScope.APPLICATION, StorageTarget.MACHINE);
		await this._host.openWindow([{ folderUri }], {});
	}

	/**
	 * The note a link's `handoff` stands for: an absolute `.json` path names a terminal handoff file, read here
	 * (after the user agreed) up to the size cap and shown as text; anything else is the note itself (issue 1186).
	 */
	private async readHandoffNote(handoff: string): Promise<{ readonly note: string; readonly card?: ClaudeTerminalHandoff }> {
		const path = readClaudeTerminalHandoffPath(handoff);
		if (!path) {
			return { note: handoff };
		}
		const parsed = await this._files.readFile(URI.file(path), { limits: { size: CLAUDE_TERMINAL_HANDOFF_MAX_BYTES } })
			.then(file => parseClaudeTerminalHandoff(file.value.toString()), () => undefined);
		if (!parsed) {
			this._notifications.warn(localize('klawlyHandoffUnreadable', "The handoff file could not be read, so the chat opens without it: {0}", path));
			return { note: '' };
		}
		return { note: formatClaudeTerminalHandoff(parsed), card: parsed };
	}

	private openDraftChat(prompt: string, mode: AgentMode | undefined): void {
		const session = this._agent.createSession();
		if (mode) {
			this._agent.setMode(session.id, mode);
		}
		// A link never sends: the prompt waits in the composer for Enter.
		this._agent.setDraft(session.id, prompt);
	}

	/** Asks, then opens the folder in its window and leaves the prompt for it. A declined or missing folder changes nothing. */
	private async handOff(link: { readonly prompt: string; readonly mode?: AgentMode; readonly folder: string }): Promise<void> {
		const folderUri = URI.file(link.folder);
		const stat = await this._files.stat(folderUri).catch(() => undefined);
		if (!stat?.isDirectory) {
			this._notifications.warn(localize('klawlyLinkNoFolder', "That link names a folder that does not exist on this computer: {0}", link.folder));
			return;
		}
		const { confirmed } = await this._dialogs.confirm({
			message: localize('klawlyLinkOpenFolder', "A link wants to open {0} and put a prompt in a new chat there.", link.folder),
			detail: localize('klawlyLinkOpenFolderDetail', "The prompt is only placed in the message box. It is not sent until you press Enter."),
			primaryButton: localize({ key: 'klawlyLinkOpenFolderButton', comment: ['&& denotes a mnemonic'] }, "&&Open Folder"),
		});
		if (!confirmed) {
			return;
		}
		this._storage.store(CLAUDE_CHAT_HANDOFF_KEY, serializeClaudeChatHandoff({ folder: link.folder, prompt: link.prompt, mode: link.mode, createdAt: Date.now() }), StorageScope.APPLICATION, StorageTarget.MACHINE);
		await this._host.openWindow([{ folderUri }], {});
	}

	private get enabled(): boolean {
		return this._contextKeys.getContextKeyValue<boolean>(CLAUDE_AGENT_DISABLED.key) !== true;
	}

	async chat(args: ChatCommandLineArgs | undefined): Promise<void> {
		if (!this.enabled || !Array.isArray(args?._)) {
			return;
		}
		const text = args._.join(' ').trim();
		const resume = args.resume === undefined ? undefined : readClaudeCodeSessionId(args.resume);
		if (args.resume !== undefined && !resume) {
			this._notifications.warn(localize('klawlyChatBadResume', "That is not a Claude Code session id: {0}. Run `claude --resume` in the terminal to see yours.", String(args.resume)));
			return;
		}
		const trusted = await this._trust.requestWorkspaceTrust({ message: localize('klawlyChatTrust', "Klawly's agent runs only in a trusted workspace.") });
		if (!trusted) {
			return;
		}
		if (resume) {
			// Typed at the terminal, so no question: the same path as an import link, for this window's folder.
			const folder = this.windowFolders[0];
			if (folder) {
				await this.importSession({ session: resume, folder, handoff: text }, false);
			} else {
				await this.openImported(resume, text);
				this._notifications.info(localize('klawlyChatResumeNoFolder', "Open the folder the session ran in to continue it: Claude Code finds a session by its folder."));
			}
			return;
		}
		const session = this._agent.createSession();
		this._agent.setMode(session.id, readClaudeLinkMode(args.mode) ?? 'agent');
		if (args.worktree) {
			this._agent.setExecutionTarget(session.id, { kind: 'worktree' });
		}
		await this._views.openView(CLAUDE_AGENT_VIEW_ID, true);
		if (!text) {
			return;
		}
		const cwd = this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.fsPath;
		if (!cwd) {
			this._agent.setDraft(session.id, text);
			this._notifications.info(localize('klawlyChatNoFolder', "Open a folder to send it: the prompt is in the composer."));
			return;
		}
		const mode = this._agent.getSessions().find(candidate => candidate.id === session.id)?.mode ?? 'agent';
		const compiled = await this._context.preview(text, mode, [], session.id);
		await this._agent.submit(session.id, text, cwd, { compiled });
	}

	/**
	 * Opens an Agents window session in the Agent pane. False when the resource is not a Claude
	 * Code session or the agent is off here: upstream's chat view opens it then.
	 */
	async openAgentsWindowSession(resource: URI): Promise<boolean> {
		const claudeSessionId = claudeSessionIdFromAgentsWindow(resource);
		if (!claudeSessionId || !this.enabled) {
			return false;
		}
		const opened = await this._agent.openClaudeCodeSession(claudeSessionId);
		await this._views.openView(CLAUDE_AGENT_VIEW_ID, true);
		if (opened.adopted) {
			this._notifications.info(localize('klawlyAgentsWindowAdopted', "This chat continues a session from the Agents window. Its earlier turns are shown there, and Claude remembers them here."));
		}
		return true;
	}

	async handleURL(uri: URI, _options?: IOpenURLOptions): Promise<boolean> {
		if (uri.scheme !== this._product.urlProtocol) {
			return false;
		}
		const link = readClaudeAgentLink(uri.authority, uri.path, uri.query);
		if (!link) {
			return false;
		}
		if (!this.enabled) {
			this._notifications.info(localize('klawlyLinkAgentOff', "That link opens a Klawly chat, but the agent is turned off in this window."));
			return true;
		}
		await this._host.focus(mainWindow);
		if (link.kind === 'open') {
			try {
				await this._agent.resume(link.session);
				this._agent.selectSession(link.session);
				await this._views.openView(CLAUDE_AGENT_VIEW_ID, true);
			} catch {
				this._notifications.warn(localize('klawlyLinkNoSession', "That chat is not in this window's history."));
			}
			return true;
		}
		if (link.kind === 'import') {
			await this.importSession(link, true);
			return true;
		}
		if (link.folder && !claudeChatHandoffIsFor({ folder: link.folder, prompt: '', createdAt: 0 }, this.windowFolders)) {
			await this.handOff({ prompt: link.prompt, mode: link.mode, folder: link.folder });
			return true;
		}
		this.openDraftChat(link.prompt, link.mode);
		await this._views.openView(CLAUDE_AGENT_VIEW_ID, true);
		return true;
	}
}
