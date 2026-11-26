/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/claudeAgentView.css';
import { $, append, clearNode, EventType, addDisposableListener } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { AnchorAlignment } from '../../../../base/browser/ui/contextview/contextview.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import { disposableTimeout, IntervalTimer } from '../../../../base/common/async.js';
import { fromNow } from '../../../../base/common/date.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableMap, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname, extname } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { URI } from '../../../../base/common/uri.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { claudeAllowRule, ClaudeConversation, claudeDiffLines, ClaudeItem, claudeQuestion, claudeToolSummary, IClaudePermissionItem, IClaudeTextItem, IClaudeToolItem } from '../../../../platform/claude/common/claudeConversation.js';
import { ClaudeEvent, IClaudeCliStatus, IClaudeGitStatus, IClaudeRuntimeService, IClaudeSendRequest, IClaudeSessionInfo } from '../../../../platform/claude/common/claudeRuntime.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

export const CLAUDE_AGENT_VIEW_CONTAINER_ID = 'workbench.view.claudeAgent';
export const CLAUDE_AGENT_VIEW_ID = 'workbench.view.claudeAgent.view';
export const CLAUDE_AGENT_TITLE = localize2('claude.agent.title', "Agent");

type PermissionMode = NonNullable<IClaudeSendRequest['permissionMode']>;

/** The context window the usage ring is measured against (v5-S12 composer, VC10). */
const CONTEXT_WINDOW_TOKENS = 200000;

/** The modes of the menu in v5-S10, with the dot colour the chip shows. */
function modes(): { readonly id: PermissionMode; readonly label: string; readonly detail: string; readonly dot: string }[] {
	return [
		{ id: 'default', label: localize('claude.mode.default', "Ask before edits"), detail: localize('claude.mode.default.detail', "Asks before each edit"), dot: 'var(--vscode-descriptionForeground)' },
		{ id: 'acceptEdits', label: localize('claude.mode.acceptEdits', "Edit automatically"), detail: localize('claude.mode.acceptEdits.detail', "Commands still ask"), dot: 'var(--vscode-button-background)' },
		{ id: 'plan', label: localize('claude.mode.plan', "Plan first"), detail: localize('claude.mode.plan.detail', "Read-only until approved"), dot: 'var(--vscode-charts-blue)' },
		{ id: 'bypassPermissions', label: localize('claude.mode.bypass', "Bypass permissions"), detail: localize('claude.mode.bypass.detail', "Nothing asks; sandbox only"), dot: 'var(--vscode-errorForeground)' },
	];
}

/**
 * The model menu of v5-S11. The `claude` command has no command that lists models, so these are its documented aliases
 * (`--model opus|sonnet|haiku`, which the CLI resolves to the newest version) under the names the frame shows; the
 * `availableModels` setting of Claude Code narrows the list when the person has set it.
 */
function models(): { readonly id: string; readonly label: string; readonly detail: string }[] {
	return [
		{ id: 'opus', label: 'Opus 4.5', detail: localize('claude.model.opus.detail', "Hardest tasks") },
		{ id: 'sonnet', label: 'Sonnet 4.5', detail: localize('claude.model.sonnet.detail', "Everyday coding") },
		{ id: 'haiku', label: 'Haiku 4.5', detail: localize('claude.model.haiku.detail', "Fast and light") },
	];
}

/** The command the Claude Code documentation gives for installing it (https://code.claude.com/docs/en/setup). */
const INSTALL_COMMAND = isWindows ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';

/** What the first-run checks found (v5-S01 to S06). */
interface ISetup {
	readonly kind: 'checking' | 'ready' | 'missing' | 'installing' | 'tooOld' | 'probeFailed' | 'signedOut';
	readonly cli?: IClaudeCliStatus;
	readonly error?: string;
	/** When the same result was found, newest last (E02: Detect Again shows the time of each check). */
	readonly checks: readonly number[];
}

function clock(ms: number): string {
	return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** The two-letter type badge a file chip shows (v5-S12 `TS`). */
function fileTypeLabel(path: string): string {
	return (extname(path).slice(1) || 'txt').slice(0, 2).toUpperCase();
}

/**
 * The Agent pane (v5-S07 empty, v5-S12 working, v5-S13 permission, v5-S42 narrow). It renders a
 * {@link ClaudeConversation}, which holds all state, and sends what the person types to the runtime.
 */
export class ClaudeAgentViewPane extends ViewPane {

	private conversation = new ClaudeConversation();
	private readonly conversationListener = this._register(new MutableDisposable<DisposableStore>());
	private readonly markdownDisposables = this._register(new DisposableMap<ClaudeItem>());
	private readonly rendered = new Map<ClaudeItem, HTMLElement>();
	private readonly expanded = new WeakSet<IClaudeToolItem>();
	private pendingEvents: ClaudeEvent[] | undefined;
	private mode: PermissionMode = 'default';
	/** The last mode the CLI reported; the chip follows the CLI when it changes (e.g. a plan was approved). */
	private reportedMode: string | undefined;
	private model: string = 'sonnet';
	private attachments: string[] = [];
	private recent: IClaudeSessionInfo[] = [];
	private showAllRecent = false;
	private running = new Set<string>();
	private queue: string[] = [];
	private setup: ISetup = { kind: 'checking', checks: [] };
	private setupDismissed = false;
	private gitState: IClaudeGitStatus['state'] = 'ok';
	private readonly resumeTimer = this._register(new MutableDisposable());
	private stopHover: { dispose(): void } | undefined;
	private readonly ticker = this._register(new IntervalTimer());

	private list!: HTMLElement;
	private emptyState: HTMLElement | undefined;
	private notice!: HTMLElement;
	private changesBar!: HTMLElement;
	private input!: HTMLTextAreaElement;
	private plusButton!: HTMLButtonElement;
	private attachmentsRow!: HTMLElement;
	private modeChip!: HTMLButtonElement;
	private modelChip!: HTMLButtonElement;
	private ring!: HTMLElement;
	private ringHover: { dispose(): void } | undefined;
	private sendButton!: HTMLButtonElement;
	private sendIcon!: HTMLElement;
	private queued!: HTMLElement;

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IClaudeRuntimeService private readonly runtime: IClaudeRuntimeService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IMarkdownRendererService private readonly markdownRenderer: IMarkdownRendererService,
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkspaceTrustManagementService private readonly trust: IWorkspaceTrustManagementService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.runtime.onDidEvent(event => this.onRuntimeEvent(event)));
		this._register(this.trust.onDidChangeTrust(() => this.renderAll()));
		this.watch(this.conversation);
	}

	private watch(conversation: ClaudeConversation): void {
		this.reportedMode = undefined;
		const store = new DisposableStore();
		store.add(conversation);
		store.add(conversation.onDidChange(item => {
			if (item) {
				this.renderItem(item);
			} else {
				if (conversation.mode !== this.reportedMode) {
					this.reportedMode = conversation.mode;
					const reported = modes().find(m => m.id === conversation.mode);
					if (reported) {
						this.mode = reported.id;
						this.renderComposer();
					}
				}
				this.renderAll();
				if (!conversation.working && !conversation.edge && this.queue.length) {
					this.sendQueued();
				}
			}
		}));
		this.conversationListener.value = store;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('.claude-agent'));
		root.tabIndex = -1; // a click anywhere in the pane keeps focus inside it, so Enter and Esc reach the pane
		this.list = append(root, $('.claude-list'));
		this.notice = append(root, $('.claude-notice'));
		this.notice.setAttribute('role', 'status');
		const composer = append(root, $('.claude-composer'));
		this.changesBar = append(composer, $('.claude-changes'));
		this.queued = append(composer, $('.claude-queued'));
		const box = append(composer, $('.claude-box'));
		this.attachmentsRow = append(box, $('.claude-ctx'));
		this.input = append(box, $('textarea.claude-input')) as HTMLTextAreaElement;
		this.input.rows = 1;
		this.input.setAttribute('aria-label', localize('claude.composer.label', "Message to Claude"));
		const row = append(box, $('.claude-row'));
		this.plusButton = append(row, $('button.claude-ib')) as HTMLButtonElement;
		this.plusButton.setAttribute('aria-haspopup', 'menu');
		this.plusButton.setAttribute('aria-label', localize('claude.plus', "Add Context"));
		append(this.plusButton, $('span' + ThemeIcon.asCSSSelector(Codicon.add)));
		this.modeChip = this.chip(row, 'claude-mode');
		this.modelChip = this.chip(row, 'claude-model');
		this.ring = append(row, $('.claude-ring'));
		this.ring.setAttribute('role', 'img');
		this.sendButton = append(row, $('button.claude-send')) as HTMLButtonElement;
		this.sendIcon = append(this.sendButton, $('span'));

		const store = this._register(new DisposableStore());
		store.add(addDisposableListener(this.sendButton, EventType.CLICK, () => this.conversation.working ? this.stop() : this.send()));
		store.add(addDisposableListener(this.plusButton, EventType.CLICK, () => this.showPlusMenu()));
		store.add(addDisposableListener(this.modeChip, EventType.CLICK, () => this.showMenu(this.modeChip, modes().map(m => this.menuAction(`${m.label} — ${m.detail}`, m.id === this.mode, () => { this.mode = m.id; this.renderComposer(); })))));
		store.add(addDisposableListener(this.modelChip, EventType.CLICK, () => this.showModelMenu()));
		// Enter allows and Esc denies while a permission card waits (v5-S13); the composer keeps Enter while it holds text
		store.add(addDisposableListener(root, EventType.KEY_DOWN, (e: KeyboardEvent) => this.onRootKey(e), true));
		store.add(addDisposableListener(this.input, EventType.INPUT, () => { this.renderComposer(); this.list.scrollTop = this.list.scrollHeight; }));
		store.add(addDisposableListener(this.input, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.send();
			}
		}));
		this.renderAll();
		this.detect();
		this.refreshRecent();
	}

	private chip(parent: HTMLElement, className: string): HTMLButtonElement {
		const chip = append(parent, $(`button.claude-chip.${className}`)) as HTMLButtonElement;
		chip.setAttribute('aria-haspopup', 'menu');
		return chip;
	}

	/** An entry of the mode and model menus: the label, its explanation, and a check on the current one. */
	private menuAction(label: string, checked: boolean, run: () => void): IAction {
		const action = new Action(`claude.menu.${label}`, label, undefined, true, async () => run());
		action.checked = checked;
		return action;
	}

	private showMenu(anchor: HTMLElement, actions: IAction[]): void {
		// anchored to the composer box, so the menu starts at the pane's left edge and stays inside the pane width
		const box = anchor.closest('.claude-box') ?? anchor;
		this.contextMenuService.showContextMenu({ getAnchor: () => box as HTMLElement, getActions: () => actions, anchorAlignment: AnchorAlignment.LEFT });
	}

	private get cwd(): string | undefined {
		return this.workspaceContext.getWorkspace().folders[0]?.uri.fsPath;
	}

	private relative(path: string): string {
		const cwd = this.cwd;
		return cwd && path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path;
	}

	private async showModelMenu(): Promise<void> {
		const cwd = this.cwd;
		const available = cwd ? (await this.runtime.readSettings(cwd)).settings.availableModels : undefined;
		const listed = models().filter(m => !Array.isArray(available) || available.some(a => typeof a === 'string' && a.toLowerCase().includes(m.id)));
		const actions: IAction[] = listed.map(m => this.menuAction(`${m.label} — ${m.detail}`, m.id === this.model, () => { this.model = m.id; this.renderComposer(); }));
		if (this.conversation.items.length) {
			actions.push(new Separator(), new Action('claude.model.cost', localize('claude.model.cost', "Switching re-reads the chat: next turn costs ~6×"), undefined, false));
		}
		actions.push(new Separator(), new Action('claude.model.manage', localize('claude.model.manage', "Manage models"), undefined, true, async () => { await this.commandService.executeCommand('workbench.action.openSettings', 'claude model'); }));
		this.showMenu(this.modelChip, actions);
	}

	/** The "+" menu of v5-S08: open files can be attached; the other context kinds arrive with their own phases. */
	private showPlusMenu(): void {
		const files = new Set<string>();
		for (const editor of this.editorService.editors) {
			const resource = editor.resource;
			if (resource?.scheme === 'file' && this.cwd && resource.fsPath.startsWith(this.cwd + '/')) {
				files.add(this.relative(resource.fsPath));
			}
		}
		const actions: IAction[] = [...files].slice(0, 5).map(file => {
			const action = new Action(`claude.attach.${file}`, `${basename(file)}  ${dirname(file) === '.' ? '' : dirname(file)}`.trim(), undefined, true, async () => {
				if (!this.attachments.includes(file)) {
					this.attachments.push(file);
				}
				this.renderComposer();
			});
			return action;
		});
		if (!actions.length) {
			actions.push(new Action('claude.plus.none', localize('claude.plus.none', "Open a file in the editor to attach it"), undefined, false));
		}
		this.showMenu(this.plusButton, actions);
	}

	/** Enter allows and Esc denies a waiting card; with no card, Esc stops a running turn. Works anywhere inside the pane. */
	private onRootKey(e: KeyboardEvent): void {
		const card = this.conversation.items.find((item): item is IClaudePermissionItem => item.kind === 'permission' && item.state === 'pending');
		if (e.isComposing) {
			return;
		}
		if (e.key === 'Escape' && (card || this.conversation.working)) {
			e.preventDefault();
			e.stopPropagation();
			if (card) {
				this.answerPermission(card, false);
			} else {
				this.stop();
			}
		} else if (card && e.key === 'Enter' && !e.shiftKey && (e.target as HTMLElement).tagName !== 'BUTTON' && !this.input.value.trim() && !claudeQuestion(card.input)) {
			e.preventDefault();
			e.stopPropagation();
			this.answerPermission(card, true);
		}
	}

	private answerPermission(card: IClaudePermissionItem, allow: boolean, always = false, updatedInput?: Record<string, unknown>, denyMessage?: string): void {
		const cwd = this.cwd;
		if (always && cwd) {
			const { rule } = claudeAllowRule(card.toolName, card.input);
			this.runtime.addAllowRule(cwd, rule).catch(error => this.conversation.setNotice(localize('claude.allowRule.failed', "Could not save the rule: {0}", error instanceof Error ? error.message : String(error))));
		}
		this.runtime.answerPermission(card.sessionId, card.requestId, allow, denyMessage, updatedInput);
		this.conversation.resolvePermission(card, allow);
	}

	override focus(): void {
		super.focus();
		this.input?.focus();
	}

	/** Starts a fresh conversation; the previous session stays resumable in the CLI. */
	newAgent(): void {
		this.rendered.clear();
		this.markdownDisposables.clearAndDisposeAll();
		this.pendingEvents = undefined;
		this.conversation = new ClaudeConversation();
		this.attachments = [];
		this.showAllRecent = false;
		this.watch(this.conversation);
		this.renderAll();
		this.focus();
		this.refreshRecent();
	}

	/** Reads the sessions the CLI already stored for this folder, for the Recent list of v5-S07. */
	private async refreshRecent(): Promise<void> {
		const cwd = this.cwd;
		if (!cwd) {
			return;
		}
		this.recent = await this.runtime.listSessions(cwd);
		this.running = new Set(await this.runtime.getBusySessions());
		if (this.conversation.items.length === 0) {
			this.renderAll();
		}
	}

	/** Continues a stored session: its messages are shown and the next prompt resumes it. */
	private async openSession(session: IClaudeSessionInfo): Promise<void> {
		const cwd = this.cwd;
		if (!cwd) {
			return;
		}
		const messages = await this.runtime.readTranscript(cwd, session.id);
		this.pendingEvents = undefined;
		this.conversation = new ClaudeConversation();
		this.watch(this.conversation);
		this.conversation.restore(session.id, messages);
		this.focus();
	}

	/** Sends the composer text, or `prompt` when given (used by the `claude.agent.send` command). */
	send(prompt: string = this.input.value): void {
		const text = prompt.trim();
		const cwd = this.cwd;
		if (!text) {
			return;
		}
		if (this.conversation.working || this.conversation.edge?.kind === 'limited' || this.conversation.edge?.kind === 'offline') {
			// the turn is running, or the chat waits for the limit reset or the network: keep the text as the next prompt
			this.queue.push(text);
			this.input.value = '';
			this.renderComposer();
			return;
		}
		if (!cwd) {
			this.conversation.setNotice(localize('claude.noFolder', "Open a folder first, so Claude knows which project to work in."));
			return;
		}
		const conversation = this.conversation;
		const files = this.attachments;
		this.attachments = [];
		this.input.value = '';
		this.pendingEvents = [];
		conversation.addUser(text, files);
		const mentions = files.length ? '\n\n' + files.map(file => `@${file}`).join(' ') : '';
		this.runtime.send({ cwd, prompt: text + mentions, sessionId: conversation.sessionId, model: this.model, permissionMode: this.trust.isWorkspaceTrusted() ? this.mode : 'plan' }).then(result => {
			conversation.sessionId = result.sessionId;
			const early = this.pendingEvents ?? [];
			this.pendingEvents = undefined;
			early.forEach(event => conversation.handle(event));
		}, error => {
			this.pendingEvents = undefined;
			conversation.setWorking(false);
			conversation.setNotice(error instanceof Error ? error.message : String(error));
		});
	}

	/** Stops the running turn at once. Queued prompts go back into the composer, so nothing is lost or sent. */
	stop(): void {
		if (this.conversation.sessionId && this.conversation.working) {
			this.runtime.stop(this.conversation.sessionId);
			if (this.queue.length) {
				this.input.value = [...this.queue, this.input.value].filter(Boolean).join('\n');
				this.queue = [];
			}
			this.conversation.stop();
		}
	}

	/** Sends the next queued prompt once the turn has ended. */
	private sendQueued(): void {
		const next = this.queue.shift();
		if (next && !this.conversation.working) {
			this.send(next);
		}
	}

	/** Runs the three first-run checks together: the command, its version, and the sign-in (Detect Again, E02). */
	async detect(): Promise<void> {
		const previous = this.setup;
		this.setup = { ...previous, kind: 'checking' };
		const cli = await this.runtime.checkCli();
		let kind: ISetup['kind'] = 'ready';
		let error = cli.error;
		if (!cli.found) {
			kind = cli.reason === 'tooOld' ? 'tooOld' : cli.reason === 'runFailed' ? 'probeFailed' : 'missing';
		} else {
			const auth = await this.runtime.checkSignIn();
			kind = auth.state === 'signedIn' ? 'ready' : auth.state === 'signedOut' ? 'signedOut' : 'probeFailed';
			error = auth.error;
		}
		const checks = kind === previous.kind || (previous.kind === 'checking' && previous.checks.length) ? [...previous.checks, Date.now()] : [Date.now()];
		this.setup = { kind, cli, error, checks };
		const cwd = this.cwd;
		this.gitState = cwd ? (await this.runtime.checkGit(cwd)).state : 'ok';
		if (this.conversation.items.length === 0) {
			this.renderAll();
		}
	}

	/** Opens the integrated terminal and types a command, so the person sees what runs (install, update, sign in). */
	private async runInTerminal(command: string): Promise<void> {
		await this.commandService.executeCommand('workbench.action.terminal.new');
		await this.commandService.executeCommand('workbench.action.terminal.sendSequence', { text: command + '\n' });
	}

	/** Install Claude Code: the documented installer, run in the terminal. */
	async install(): Promise<void> {
		this.setup = { ...this.setup, kind: 'installing' };
		this.renderAll();
		await this.runInTerminal(INSTALL_COMMAND);
	}

	/** Continues after a limit, an offline stop or a crash: the first queued prompt, or a plain "continue". */
	private resume(): void {
		this.resumeTimer.clear();
		this.conversation.edge = undefined;
		this.send(this.queue.shift() ?? localize('claude.resume.prompt', "Continue where you stopped."));
	}

	private onRuntimeEvent(event: ClaudeEvent): void {
		if (this.pendingEvents && !this.conversation.sessionId) {
			this.pendingEvents.push(event);
			return;
		}
		this.conversation.handle(event);
	}

	// --- Rendering

	private renderAll(): void {
		clearNode(this.list);
		this.rendered.clear();
		this.markdownDisposables.clearAndDisposeAll();
		const empty = this.conversation.items.length === 0;
		if (!this.trust.isWorkspaceTrusted() && this.cwd && (!empty || this.setupDismissed || this.setup.kind !== 'ready')) {
			this.renderRestricted();
		}
		if (empty) {
			this.renderEmpty();
		} else {
			this.conversation.items.forEach(item => this.renderItem(item));
			this.renderEdge();
		}
		this.notice.textContent = this.conversation.notice ?? '';
		this.notice.classList.toggle('visible', !!this.conversation.notice);
		this.updateTitle(this.conversation.title ?? localize('claude.title.new', "New agent"));
		this.renderChanges();
		this.renderComposer();
		this.list.scrollTop = this.list.scrollHeight;
	}

	/** Renders or updates one item in place; later items keep their elements. */
	private renderItem(item: ClaudeItem): void {
		this.emptyState?.remove();
		this.emptyState = undefined;
		let element = this.rendered.get(item);
		if (!element) {
			element = append(this.list, $('.claude-item'));
			this.rendered.set(item, element);
		}
		clearNode(element);
		const disposables = new DisposableStore();
		this.markdownDisposables.set(item, disposables);
		switch (item.kind) {
			case 'user': {
				element.className = 'claude-item claude-user';
				const bubble = append(element, $('.claude-bubble'));
				append(bubble, $('span')).textContent = item.text;
				if (item.files?.length) {
					const files = append(bubble, $('.claude-ctx'));
					item.files.forEach(file => this.fileChip(files, file, '.claude-ctxc'));
				}
				break;
			}
			case 'assistant':
				element.className = 'claude-item claude-assistant';
				this.renderMarkdown(element, item, disposables);
				break;
			case 'tool':
				element.className = 'claude-item claude-tool-item';
				this.renderTool(element, item, disposables);
				break;
			case 'permission':
				element.className = 'claude-item claude-permission';
				this.renderPermission(element, item, disposables);
				break;
			case 'stopped':
				element.className = 'claude-item claude-stopped';
				element.textContent = localize('claude.stopped', "Stopped");
				break;
		}
		// the text before this item is complete now: show it whole, not cut at a word
		const index = this.conversation.items.indexOf(item);
		const before = index > 0 ? this.conversation.items[index - 1] : undefined;
		if (before?.kind === 'assistant' && this.rendered.has(before)) {
			const previous = this.rendered.get(before)!;
			clearNode(previous);
			const store = new DisposableStore();
			this.markdownDisposables.set(before, store);
			this.renderMarkdown(previous, before, store);
		}
		this.notice.textContent = this.conversation.notice ?? '';
		this.notice.classList.toggle('visible', !!this.conversation.notice);
		this.renderChanges();
		this.renderComposer();
		this.updateTitle(this.conversation.title ?? localize('claude.title.new', "New agent"));
		this.list.scrollTop = this.list.scrollHeight;
	}

	private renderMarkdown(element: HTMLElement, item: IClaudeTextItem, disposables: DisposableStore): void {
		// while the text streams, the last unfinished word is held back so a word never shows cut in half
		const streaming = this.conversation.working && this.conversation.items[this.conversation.items.length - 1] === item;
		element.classList.toggle('claude-streaming', streaming);
		const text = streaming ? item.text.replace(/\S+$/, '') : item.text;
		const rendered = disposables.add(this.markdownRenderer.render(new MarkdownString(text)));
		element.appendChild(rendered.element);
	}

	/** Shows `text` in full as a hover on `element` when it is cut off. */
	private hover(element: HTMLElement, text: string, disposables: DisposableStore): void {
		disposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), element, text));
	}

	/** A file chip: type badge and name (v5-S12 `TS total.ts`). */
	private fileChip(parent: HTMLElement, path: string, selector: string): HTMLElement {
		const chip = append(parent, $('span' + selector));
		append(chip, $('span.claude-fti')).textContent = fileTypeLabel(path);
		append(chip, $('span')).textContent = basename(path);
		return chip;
	}

	private renderTool(element: HTMLElement, tool: IClaudeToolItem, disposables: DisposableStore): void {
		const row = append(element, $('button.claude-tool'));
		row.setAttribute('aria-expanded', String(this.expanded.has(tool)));
		const status = tool.status === 'running' ? Codicon.loading : tool.status === 'failed' ? Codicon.error : Codicon.check;
		append(append(row, $('span.claude-tool-icon')), $('span' + ThemeIcon.asCSSSelector(status) + (tool.status === 'running' ? '.codicon-modifier-spin' : '')));
		append(row, $('span.claude-tool-verb')).textContent = tool.name;
		const target = append(row, $('span.claude-tool-target'));
		if (typeof tool.input.file_path === 'string') {
			this.fileChip(target, tool.input.file_path, '.claude-fchip');
			const dir = dirname(this.relative(tool.input.file_path));
			if (dir !== '.') {
				append(target, $('span.claude-dir')).textContent = dir;
			}
		} else {
			target.textContent = tool.target;
			this.hover(target, tool.input.command === undefined ? tool.target : String(tool.input.command), disposables);
		}
		const summary = claudeToolSummary(tool);
		const result = append(row, $('span.claude-tool-result'));
		if (summary?.text) {
			result.textContent = summary.text;
		}
		if (summary?.added !== undefined) {
			append(result, $('span.claude-added')).textContent = `+${summary.added}`;
			append(result, $('span.claude-removed')).textContent = `−${summary.removed}`;
		}
		if (tool.status === 'running') {
			const pill = append(result, $('span.claude-pill'));
			pill.dataset.start = String(tool.startedAt);
			pill.textContent = this.elapsed(tool.startedAt);
			this.ticker.cancelAndSet(() => this.tick(), 1000);
		}
		row.classList.toggle(`claude-${tool.status}`, true);
		row.addEventListener('click', () => {
			if (this.expanded.has(tool)) {
				this.expanded.delete(tool);
			} else {
				this.expanded.add(tool);
			}
			this.renderItem(tool);
		});
		if (this.expanded.has(tool)) {
			const diff = claudeDiffLines(tool.name, tool.input);
			if (diff.length && typeof tool.input.file_path === 'string') {
				const box = append(element, $('.claude-output.claude-diff'));
				append(box, $('.claude-diff-path')).textContent = this.relative(tool.input.file_path);
				for (const line of diff) {
					const row = append(box, $(line.sign === '+' ? '.claude-diff-add' : line.sign === '-' ? '.claude-diff-del' : '.claude-diff-ctx'));
					row.textContent = `${line.sign} ${line.text}`;
				}
			} else {
				append(element, $('pre.claude-output')).textContent = tool.output ?? tool.target;
			}
		}
	}

	private elapsed(start: number): string {
		const seconds = Math.max(0, Math.round((Date.now() - start) / 1000));
		return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
	}

	/** Updates the running-time pills; stops by itself when none is left. */
	private tick(): void {
		// eslint-disable-next-line no-restricted-syntax -- pills are re-created on each render; the selector is local to this view
		const pills = this.list.querySelectorAll<HTMLElement>('.claude-pill');
		pills.forEach(pill => pill.textContent = this.elapsed(Number(pill.dataset.start)));
		if (!pills.length) {
			this.ticker.cancel();
		}
	}

	private renderPermission(element: HTMLElement, card: IClaudePermissionItem, disposables: DisposableStore): void {
		if (card.state !== 'pending') {
			// an answered card folds into its tool row, which shows the result
			element.className = 'claude-item claude-answered';
			return;
		}
		element.setAttribute('role', 'group');
		if (card.toolName === 'ExitPlanMode' && typeof card.input.plan === 'string') {
			this.renderPlanCard(element, card, card.input.plan, disposables);
			return;
		}
		const question = claudeQuestion(card.input);
		const title = append(element, $('.claude-permission-title'));
		append(title, $('span' + ThemeIcon.asCSSSelector(question ? Codicon.question : Codicon.shield)));
		const isBash = card.toolName === 'Bash';
		const label = question ? question.question
			: isBash ? localize('claude.permission.run', "Run Command?")
				: localize('claude.permission.use', "Allow {0}?", card.toolName);
		append(title, $('span.claude-permission-text' + (question ? '.claude-wrap' : ''))).textContent = label;
		element.setAttribute('aria-label', label);
		const detail = isBash && typeof card.input.command === 'string' ? card.input.command : card.target ? this.relative(card.target) : '';
		if (!question && detail) {
			const code = append(element, $('code.claude-permission-command'));
			code.textContent = detail;
			this.hover(code, detail, disposables);
		}
		const buttons = append(element, $('.claude-permission-buttons'));
		const add = (text: string, className: string, onClick: () => void) => {
			const button = append(buttons, $('button.claude-button' + className)) as HTMLButtonElement;
			button.tabIndex = 0;
			button.textContent = text;
			button.addEventListener('click', onClick);
		};
		if (question) {
			for (const option of question.options) {
				add(option.label, '.claude-option', () => this.answerPermission(card, true, false, { ...card.input, answers: { [question.question]: option.label } }));
				if (option.description) {
					const button = buttons.lastElementChild as HTMLElement;
					append(button, $('span.claude-option-detail')).textContent = option.description;
				}
			}
			add(localize('claude.permission.skip', "Skip"), '.claude-ghost', () => this.answerPermission(card, false));
			append(buttons, $('span.claude-kbd')).textContent = localize('claude.question.keys', "Esc");
			return;
		}
		add(localize('claude.permission.allow', "Allow once"), '.claude-primary', () => this.answerPermission(card, true));
		add(localize('claude.permission.always', "Always allow {0}", claudeAllowRule(card.toolName, card.input).label), '', () => this.answerPermission(card, true, true));
		add(localize('claude.permission.deny', "Deny"), '.claude-ghost', () => this.answerPermission(card, false));
		append(buttons, $('span.claude-kbd')).textContent = localize('claude.permission.keys', "Enter · Esc");
	}

	/** The ExitPlanMode request: the plan as markdown, then Build, Keep Planning and Open Plan (v5 plan card). */
	private renderPlanCard(element: HTMLElement, card: IClaudePermissionItem, plan: string, disposables: DisposableStore): void {
		const label = localize('claude.plan.title', "Plan");
		element.setAttribute('aria-label', label);
		const title = append(element, $('.claude-permission-title'));
		append(title, $('span' + ThemeIcon.asCSSSelector(Codicon.checklist)));
		append(title, $('span.claude-permission-text')).textContent = label;
		const body = append(element, $('.claude-plan'));
		body.appendChild(disposables.add(this.markdownRenderer.render(new MarkdownString(plan))).element);
		const buttons = append(element, $('.claude-permission-buttons'));
		const add = (text: string, className: string, onClick: () => void) => {
			const button = append(buttons, $('button.claude-button' + className)) as HTMLButtonElement;
			button.tabIndex = 0;
			button.textContent = text;
			button.addEventListener('click', onClick);
		};
		add(localize('claude.plan.build', "Build"), '.claude-primary', () => this.answerPermission(card, true));
		add(localize('claude.plan.keep', "Keep Planning"), '', () => this.answerPermission(card, false, false, undefined, 'The user wants to keep planning. Ask what to change, then revise the plan.'));
		const file = card.input.planFilePath;
		if (typeof file === 'string') {
			add(localize('claude.plan.open', "Open Plan"), '.claude-ghost', () => this.openerService.open(URI.file(file)));
		}
		append(buttons, $('span.claude-kbd')).textContent = localize('claude.permission.keys', "Enter · Esc");
	}

	/** One card in the style of the permission card: icon and title, text, optional rows, then buttons. */
	private card(parent: HTMLElement, icon: ThemeIcon, title: string, text: string | undefined, buttons: readonly { label: string; kind?: 'primary' | 'ghost'; run: () => void }[], fill?: (card: HTMLElement) => void): HTMLElement {
		const card = append(parent, $('.claude-permission.claude-card'));
		card.setAttribute('role', 'group');
		card.setAttribute('aria-label', title);
		const head = append(card, $('.claude-permission-title'));
		append(head, $('span' + ThemeIcon.asCSSSelector(icon)));
		append(head, $('span.claude-permission-text.claude-wrap')).textContent = title;
		if (text) {
			append(card, $('.claude-card-text')).textContent = text;
		}
		fill?.(card);
		if (buttons.length) {
			const row = append(card, $('.claude-permission-buttons'));
			for (const button of buttons) {
				const element = append(row, $('button.claude-button' + (button.kind ? `.claude-${button.kind}` : ''))) as HTMLButtonElement;
				element.textContent = button.label;
				element.addEventListener('click', button.run);
			}
		}
		return card;
	}

	private openLogs(): Promise<void> {
		return this.commandService.executeCommand('workbench.action.showLogs');
	}

	/** The first-run card of v5-S01 to S05, or nothing once everything is ready. Returns `true` while it holds the pane back. */
	private renderSetup(parent: HTMLElement): boolean {
		const setup = this.setup;
		const detect = () => this.detect();
		const dismiss = { label: localize('claude.setup.without', "Continue Without AI"), kind: 'ghost' as const, run: () => { this.setupDismissed = true; this.renderAll(); } };
		const checked = (): string => {
			const first = clock(setup.checks[0]);
			return setup.checks.length > 1 ? localize('claude.setup.checked.again', "Last checked {0} · Detect Again ran {1}, same result", first, clock(setup.checks[setup.checks.length - 1])) : localize('claude.setup.checked', "Last checked {0}", first);
		};
		if (setup.kind === 'checking') {
			return false;
		}
		if (setup.kind === 'ready') {
			const cwd = this.cwd;
			if (!cwd || this.trust.isWorkspaceTrusted() || this.setupDismissed) {
				return false;
			}
			this.card(parent, Codicon.sparkle, localize('claude.first.title', "Klawly Runs on Your Claude Code"), undefined, [
				{ label: localize('claude.first.trust', "Trust Folder and Start"), kind: 'primary', run: () => this.trust.setWorkspaceTrust(true) },
				{ label: localize('claude.first.restricted', "Start Without Trusting"), run: () => { this.setupDismissed = true; this.renderAll(); } },
			], card => {
				for (const line of [
					localize('claude.first.cli', "Claude Code {0} · found on PATH", setup.cli?.version ?? ''),
					localize('claude.first.signedIn', "Signed in · used for every chat"),
					localize('claude.first.folder', "{0} · Claude may read and edit files here", basename(cwd)),
				]) {
					append(card, $('.claude-card-text')).textContent = line;
				}
			});
			return true;
		}
		if (this.setupDismissed) {
			return false;
		}
		switch (setup.kind) {
			case 'missing':
				this.card(parent, Codicon.warning, localize('claude.missing.title', "Claude Code Is Not Installed"), localize('claude.missing.text', "Klawly needs the Claude Code CLI. Install it once; your Claude plan pays for the chats."), [
					{ label: localize('claude.missing.install', "Install Claude Code"), kind: 'primary', run: () => this.install() },
					{ label: localize('claude.setup.detect', "Detect Again"), run: detect },
					dismiss,
				], card => {
					append(card, $('code.claude-permission-command')).textContent = INSTALL_COMMAND;
					append(card, $('.claude-card-text')).textContent = checked();
				});
				break;
			case 'installing':
				this.card(parent, Codicon.cloudDownload, localize('claude.installing.title', "Installing Claude Code"), localize('claude.installing.text', "The installer runs in the terminal. When it finishes, run Detect Again: next come the version check and the sign-in check."), [
					{ label: localize('claude.setup.detect', "Detect Again"), kind: 'primary', run: detect },
					{ label: localize('claude.installing.cancel', "Cancel"), run: () => { this.setup = { ...setup, kind: 'missing' }; this.renderAll(); } },
				]);
				break;
			case 'tooOld':
				this.card(parent, Codicon.warning, localize('claude.old.title', "Claude Code {0} Is Too Old", setup.cli?.version ?? ''), localize('claude.old.text', "Klawly needs 2.0 or newer for checkpoints and questions. Updating keeps your sign-in and settings."), [
					{ label: localize('claude.old.update', "Update Claude Code"), kind: 'primary', run: () => this.runInTerminal('claude update') },
					{ label: localize('claude.setup.detect', "Detect Again"), run: detect },
				], card => append(card, $('.claude-card-text')).textContent = checked());
				break;
			case 'probeFailed':
				this.card(parent, Codicon.warning, localize('claude.probe.title', "Couldn't Check Your Claude Sign-In"), setup.error ?? localize('claude.probe.text', "The check gave no answer. This is usually a slow network or proxy, not your account."), [
					{ label: localize('claude.probe.retry', "Retry"), kind: 'primary', run: detect },
					{ label: localize('claude.probe.logs', "Open Logs"), run: () => this.openLogs() },
					dismiss,
				], card => append(card, $('.claude-card-text')).textContent = checked());
				break;
			case 'signedOut':
				this.card(parent, Codicon.account, localize('claude.signin.title', "Sign In to Claude Code"), localize('claude.signin.text', "Klawly uses your Claude plan. Sign-in runs in the terminal; the CLI keeps your credentials and Klawly never reads them."), [
					{ label: localize('claude.signin.button', "Sign In"), kind: 'primary', run: () => this.runInTerminal('claude auth login') },
					{ label: localize('claude.setup.detect', "Detect Again"), run: detect },
					dismiss,
				], card => append(card, $('.claude-card-text')).textContent = checked());
				break;
		}
		return true;
	}

	/** v5-S38 and S39: Git cases that need a word or a button before the person can go on. */
	private renderGit(parent: HTMLElement): void {
		const cwd = this.cwd;
		if (!cwd || (this.gitState !== 'notRepo' && this.gitState !== 'unsafe')) {
			return;
		}
		const recheck = async () => { this.gitState = (await this.runtime.checkGit(cwd)).state; this.renderAll(); };
		const fail = (error: unknown) => this.conversation.setNotice(error instanceof Error ? error.message : String(error));
		if (this.gitState === 'unsafe') {
			this.card(parent, Codicon.repo, localize('claude.git.unsafe.title', "Git Won't Open This Folder"), localize('claude.git.unsafe.text', "The folder belongs to another user, so Git treats it as unsafe. Trusting it runs: git config --global --add safe.directory {0}", cwd), [
				{ label: localize('claude.git.unsafe.trust', "Trust Folder for Git"), kind: 'primary', run: () => this.runtime.trustGitFolder(cwd).then(recheck, fail) },
				{ label: localize('claude.git.terminal', "Open Terminal"), run: () => { this.commandService.executeCommand('workbench.action.terminal.new'); } },
			]);
		} else {
			this.card(parent, Codicon.repo, localize('claude.git.none.title', "This Folder Is Not a Git Repository"), localize('claude.git.none.text', "Checkpoints still work. Review against main, branches and PRs need Git."), [
				{ label: localize('claude.git.init', "Initialize Git"), kind: 'primary', run: () => this.runtime.initGit(cwd).then(recheck, fail) },
				{ label: localize('claude.git.notNow', "Not Now"), kind: 'ghost', run: () => { this.gitState = 'ok'; this.renderAll(); } },
			]);
		}
	}

	/** v5-S06: a folder that is not trusted runs Claude in plan mode, which reads but never edits or runs. */
	private renderRestricted(): void {
		const banner = append(this.list, $('.claude-restricted'));
		append(banner, $('span.claude-restricted-text')).textContent = localize('claude.restricted', "Restricted: Claude can read, not edit or run.");
		const trust = append(banner, $('button.claude-button.claude-ghost')) as HTMLButtonElement;
		trust.textContent = localize('claude.restricted.trust', "Trust");
		trust.addEventListener('click', () => this.trust.setWorkspaceTrust(true));
	}

	/** v5-S35, S36 and S37: the card under the last message when the chat is limited, offline or crashed. */
	private renderEdge(): void {
		const edge = this.conversation.edge;
		if (!edge) {
			return;
		}
		const holder = append(this.list, $('.claude-item'));
		const resumeAt = (at: number) => {
			this.resumeTimer.value = disposableTimeout(() => this.resume(), Math.max(0, at - Date.now()));
			this.renderAll();
		};
		switch (edge.kind) {
			case 'limited': {
				const at = edge.resetsAt;
				const left = at ? Math.max(1, Math.round((at - Date.now()) / 60000)) : 0;
				const inText = left >= 60 ? localize('claude.limit.hours', "{0} h {1} min", Math.floor(left / 60), left % 60) : localize('claude.limit.minutes', "{0} min", left);
				this.card(holder, Codicon.clock, localize('claude.limit.title', "Usage Limit Reached"), at
					? localize('claude.limit.text', "Your usage limit resets at {0}, in {1}. Prompts you type now wait until then.", clock(at), inText)
					: localize('claude.limit.unknown', "Your usage limit was reached. Try again later; prompts you type now wait."), [
					...(at ? [this.resumeTimer.value
						? { label: localize('claude.limit.waiting', "Resuming at {0}", clock(at)), run: () => { this.resumeTimer.clear(); this.renderAll(); } }
						: { label: localize('claude.limit.resume', "Resume at Reset"), kind: 'primary' as const, run: () => resumeAt(at) }] : []),
					{ label: localize('claude.limit.switch', "Switch Account"), run: () => this.runInTerminal('claude auth login') },
				]);
				break;
			}
			case 'offline':
				this.card(holder, Codicon.debugDisconnect, localize('claude.offline.title', "Offline"), localize('claude.offline.text', "Claude can't reach the network. Your prompt is kept; follow-ups you type are queued."), [
					{ label: localize('claude.offline.retry', "Retry Now"), kind: 'primary', run: () => this.resume() },
				]);
				break;
			case 'crashed': {
				const changes = this.conversation.changes;
				this.card(holder, Codicon.error, localize('claude.crash.title', "Claude Code Stopped Unexpectedly"), changes.length
					? localize('claude.crash.files', "Exit code {0} at {1}. Files touched before it stopped:", edge.exitCode, clock(edge.at))
					: localize('claude.crash.none', "Exit code {0} at {1}. No files were changed.", edge.exitCode, clock(edge.at)), [
					{ label: localize('claude.crash.resume', "Resume Chat"), kind: 'primary', run: () => this.resume() },
					{ label: localize('claude.probe.logs', "Open Logs"), run: () => this.openLogs() },
				], card => {
					for (const change of changes) {
						const line = append(card, $('.claude-card-text.claude-card-file'));
						append(line, $('span')).textContent = this.relative(change.path);
						append(line, $('span.claude-added')).textContent = `+${change.added}`;
						append(line, $('span.claude-removed')).textContent = `−${change.removed}`;
					}
				});
				break;
			}
		}
		this.list.scrollTop = this.list.scrollHeight;
	}

	/** The empty pane of v5-S07: Recent sessions of this folder, then starters. */
	private renderEmpty(): void {
		const empty = this.emptyState = append(this.list, $('.claude-empty'));
		const blocked = this.renderSetup(empty);
		this.renderGit(empty);
		if (blocked) {
			return;
		}
		const open = new Set([this.conversation.sessionId]);
		const recent = this.recent.filter(session => !open.has(session.id));
		if (recent.length) {
			append(empty, $('.claude-section')).textContent = localize('claude.empty.recent', "Recent");
			for (const session of recent.slice(0, this.showAllRecent ? undefined : 3)) {
				const row = append(empty, $('button.claude-recent'));
				append(row, $('span.claude-recent-title')).textContent = session.title;
				const age = fromNow(session.modified, true);
				const files = session.files === 1 ? localize('claude.recent.file', "1 file") : localize('claude.recent.files', "{0} files", session.files);
				append(row, $('span.claude-recent-detail')).textContent = this.running.has(session.id) ? localize('claude.recent.running', "Running · {0}", age)
					: session.files ? localize('claude.recent.done', "{0} · {1}", files, age) : localize('claude.recent.idle', "Done · {0}", age);
				row.addEventListener('click', () => this.openSession(session));
			}
			if (recent.length > 3 && !this.showAllRecent) {
				const all = append(empty, $('button.claude-link')) as HTMLButtonElement;
				all.textContent = localize('claude.empty.all', "All agents");
				all.addEventListener('click', () => { this.showAllRecent = true; this.renderAll(); });
			}
		}
		append(empty, $('.claude-section')).textContent = localize('claude.empty.start', "Start with");
		const file = this.editorService.activeEditor?.resource;
		const relative = file?.scheme === 'file' && this.cwd && file.fsPath.startsWith(this.cwd + '/') ? this.relative(file.fsPath) : undefined;
		const folder = relative && dirname(relative) !== '.' ? dirname(relative) : undefined;
		for (const starter of [
			localize('claude.starter.explain', "Explain this repo"),
			folder ? localize('claude.starter.bugs.in', "Find bugs in {0}", folder) : localize('claude.starter.bugs', "Find bugs in this project"),
			relative ? localize('claude.starter.tests.for', "Write tests for {0}", basename(relative)) : localize('claude.starter.tests', "Write tests for the open file"),
		]) {
			const button = append(empty, $('button.claude-button.claude-large.claude-starter')) as HTMLButtonElement;
			button.textContent = starter;
			button.addEventListener('click', () => this.send(starter));
		}
	}

	/** The changes bar attached above the composer (v5-S19, VC09); Keep and Undo run in a later phase. */
	private renderChanges(): void {
		clearNode(this.changesBar);
		const changes = this.conversation.changes;
		this.changesBar.classList.toggle('visible', changes.length > 0);
		if (!changes.length) {
			return;
		}
		const added = changes.reduce((sum, c) => sum + c.added, 0);
		const removed = changes.reduce((sum, c) => sum + c.removed, 0);
		append(this.changesBar, $('span.claude-changes-count')).textContent = changes.length === 1 ? localize('claude.changes.file', "1 file") : localize('claude.changes.files', "{0} files", changes.length);
		append(this.changesBar, $('span.claude-added')).textContent = `+${added}`;
		append(this.changesBar, $('span.claude-removed')).textContent = `−${removed}`;
		append(this.changesBar, $('span.claude-spacer'));
		for (const [label, primary] of [[localize('claude.changes.review', "Review"), false], [localize('claude.changes.undo', "Undo All"), false], [localize('claude.changes.keep', "Keep All"), true]] as const) {
			const button = append(this.changesBar, $('button.claude-button' + (primary ? '.claude-primary' : '.claude-ghost'))) as HTMLButtonElement;
			button.textContent = label;
			button.addEventListener('click', () => this.conversation.setNotice(localize('claude.changes.later', "Reviewing, keeping and undoing changes arrives in a later phase.")));
		}
	}

	private renderComposer(): void {
		const working = this.conversation.working;
		const edge = this.conversation.edge;
		this.input.placeholder = edge?.kind === 'limited' && edge.resetsAt ? localize('claude.composer.queue.reset', "Queue for {0}", clock(edge.resetsAt))
			: working || edge?.kind === 'offline'
			? localize('claude.composer.queue', "Queue a follow-up")
			: localize('claude.composer.placeholder', "Plan, build or ask · @ for context, / for commands");
		clearNode(this.attachmentsRow);
		this.attachmentsRow.classList.toggle('visible', this.attachments.length > 0);
		for (const file of this.attachments) {
			const chip = this.fileChip(this.attachmentsRow, file, '.claude-ctxc');
			const remove = append(chip, $('button.claude-remove')) as HTMLButtonElement;
			remove.setAttribute('aria-label', localize('claude.attachment.remove', "Remove {0}", basename(file)));
			append(remove, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
			remove.addEventListener('click', () => { this.attachments = this.attachments.filter(f => f !== file); this.renderComposer(); });
		}
		const mode = modes().find(m => m.id === this.mode)!;
		clearNode(this.modeChip);
		append(this.modeChip, $('span.claude-dot')).style.background = mode.dot;
		append(this.modeChip, $('span')).textContent = mode.label;
		const model = models().find(m => m.id === this.model);
		clearNode(this.modelChip);
		append(append(this.modelChip, $('span.claude-mdl')), $('span.claude-md2')).textContent = (model?.label ?? this.model)[0].toUpperCase();
		append(this.modelChip, $('span')).textContent = model?.label ?? this.model;
		for (const chip of [this.modeChip, this.modelChip]) {
			append(chip, $('span.claude-chevron' + ThemeIcon.asCSSSelector(Codicon.chevronDown)));
		}
		const percent = Math.min(100, Math.round(this.conversation.contextTokens / CONTEXT_WINDOW_TOKENS * 100));
		this.ring.style.setProperty('--claude-context', `${percent}%`);
		const label = localize('claude.context.used', "Context {0}% used", percent);
		this.ring.setAttribute('aria-label', label);
		this.ringHover?.dispose();
		this.ringHover = this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), this.ring, label);
		this.sendButton.classList.toggle('claude-stop', working);
		this.sendButton.disabled = !working && !this.input.value.trim();
		this.sendIcon.className = ThemeIcon.asClassName(working ? Codicon.stopCircle : Codicon.arrowUp);
		const sendLabel = working ? localize('claude.stop', "Stop") : localize('claude.send', "Send");
		this.sendButton.setAttribute('aria-label', sendLabel);
		this.stopHover?.dispose();
		this.stopHover = this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), this.sendButton, working ? localize('claude.stop.hover', "Stop (Esc)") : sendLabel);
		this.queued.textContent = this.queue.length ? localize('claude.queued', "Queued: {0}", this.queue[this.queue.length - 1]) : '';
		this.queued.classList.toggle('visible', this.queue.length > 0);
	}

	override dispose(): void {
		this.ringHover?.dispose();
		this.stopHover?.dispose();
		super.dispose();
	}
}
