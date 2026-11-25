/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/claudeAgentView.css';
import { $, append, clearNode, EventType, addDisposableListener } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { fromNow } from '../../../../base/common/date.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableMap, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname, extname } from '../../../../base/common/path.js';
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
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { claudeAllowRule, ClaudeConversation, ClaudeItem, claudeToolSummary, IClaudePermissionItem, IClaudeTextItem, IClaudeToolItem } from '../../../../platform/claude/common/claudeConversation.js';
import { ClaudeEvent, IClaudeRuntimeService, IClaudeSendRequest, IClaudeSessionInfo } from '../../../../platform/claude/common/claudeRuntime.js';
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
		{ id: 'default', label: localize('claude.mode.default', "Ask before edits"), detail: localize('claude.mode.default.detail', "Claude asks before each edit and command"), dot: 'var(--vscode-descriptionForeground)' },
		{ id: 'acceptEdits', label: localize('claude.mode.acceptEdits', "Edit automatically"), detail: localize('claude.mode.acceptEdits.detail', "Edits apply; commands still ask"), dot: 'var(--vscode-button-background)' },
		{ id: 'plan', label: localize('claude.mode.plan', "Plan first"), detail: localize('claude.mode.plan.detail', "Read-only until you approve a plan"), dot: 'var(--vscode-charts-blue)' },
		{ id: 'bypassPermissions', label: localize('claude.mode.bypass', "Bypass permissions"), detail: localize('claude.mode.bypass.detail', "Nothing asks. Use in a sandbox only"), dot: 'var(--vscode-errorForeground)' },
	];
}

/**
 * The model menu of v5-S11. The `claude` command has no command that lists models, so these are its documented aliases
 * (`--model opus|sonnet|haiku`, which the CLI resolves to the newest version) under the names the frame shows; the
 * `availableModels` setting of Claude Code narrows the list when the person has set it.
 */
function models(): { readonly id: string; readonly label: string; readonly detail: string }[] {
	return [
		{ id: 'opus', label: 'Opus 4.5', detail: localize('claude.model.opus.detail', "Hardest tasks · uses limits faster") },
		{ id: 'sonnet', label: 'Sonnet 4.5', detail: localize('claude.model.sonnet.detail', "Default for coding") },
		{ id: 'haiku', label: 'Haiku 4.5', detail: localize('claude.model.haiku.detail', "Fast, light tasks") },
	];
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
	private readonly markdownDisposables = this._register(new DisposableMap<IClaudeTextItem>());
	private readonly rendered = new Map<ClaudeItem, HTMLElement>();
	private readonly expanded = new WeakSet<IClaudeToolItem>();
	private pendingEvents: ClaudeEvent[] | undefined;
	private mode: PermissionMode = 'default';
	private model: string = 'sonnet';
	private attachments: string[] = [];
	private recent: IClaudeSessionInfo[] = [];
	private showAllRecent = false;
	private running = new Set<string>();
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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.runtime.onDidEvent(event => this.onRuntimeEvent(event)));
		this.watch(this.conversation);
	}

	private watch(conversation: ClaudeConversation): void {
		const store = new DisposableStore();
		store.add(conversation);
		store.add(conversation.onDidChange(item => item ? this.renderItem(item) : this.renderAll()));
		this.conversationListener.value = store;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('.claude-agent'));
		this.list = append(root, $('.claude-list'));
		this.notice = append(root, $('.claude-notice'));
		this.notice.setAttribute('role', 'status');
		const composer = append(root, $('.claude-composer'));
		this.changesBar = append(composer, $('.claude-changes'));
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
		append(this.sendButton, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowUp)));

		const store = this._register(new DisposableStore());
		store.add(addDisposableListener(this.sendButton, EventType.CLICK, () => this.conversation.working ? this.stop() : this.send()));
		store.add(addDisposableListener(this.plusButton, EventType.CLICK, () => this.showPlusMenu()));
		store.add(addDisposableListener(this.modeChip, EventType.CLICK, () => this.showMenu(this.modeChip, modes().map(m => this.menuAction(`${m.label} — ${m.detail}`, m.detail, m.id === this.mode, () => { this.mode = m.id; this.renderComposer(); })))));
		store.add(addDisposableListener(this.modelChip, EventType.CLICK, () => this.showModelMenu()));
		// Enter allows and Esc denies while a permission card waits (v5-S13); the composer keeps Enter while it holds text
		store.add(addDisposableListener(root, EventType.KEY_DOWN, (e: KeyboardEvent) => this.onRootKey(e), true));
		store.add(addDisposableListener(this.input, EventType.INPUT, () => this.renderComposer()));
		store.add(addDisposableListener(this.input, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.send();
			}
		}));
		this.renderAll();
		this.checkCli();
		this.refreshRecent();
	}

	private chip(parent: HTMLElement, className: string): HTMLButtonElement {
		const chip = append(parent, $(`button.claude-chip.${className}`)) as HTMLButtonElement;
		chip.setAttribute('aria-haspopup', 'menu');
		return chip;
	}

	/** An entry of the mode and model menus: the label, its explanation, and a check on the current one. */
	private menuAction(label: string, detail: string, checked: boolean, run: () => void): IAction {
		const action = new Action(label, `${label}. ${detail}`, undefined, true, async () => run());
		action.checked = checked;
		action.tooltip = detail;
		return action;
	}

	private showMenu(anchor: HTMLElement, actions: IAction[]): void {
		this.contextMenuService.showContextMenu({ getAnchor: () => anchor, getActions: () => actions });
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
		const actions: IAction[] = listed.map(m => this.menuAction(`${m.label} — ${m.detail}`, m.detail, m.id === this.model, () => { this.model = m.id; this.renderComposer(); }));
		if (this.conversation.items.length) {
			actions.push(new Separator(), new Action('claude.model.cost', localize('claude.model.cost', "Switching now re-reads the whole chat: the next turn costs about 6× a normal turn."), undefined, false));
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
		if (actions.length) {
			actions.push(new Separator());
		}
		for (const label of [
			localize('claude.plus.git', "Git changes"),
			localize('claude.plus.terminal', "Terminal output — last 200 lines"),
			localize('claude.plus.problems', "Problems"),
			localize('claude.plus.web', "Web page — paste a URL"),
			localize('claude.plus.image', "Image — paste or drop"),
		]) {
			actions.push(new Action(`claude.plus.${label}`, label, undefined, false));
		}
		this.showMenu(this.plusButton, actions);
	}

	private onRootKey(e: KeyboardEvent): void {
		const card = this.conversation.items.find((item): item is IClaudePermissionItem => item.kind === 'permission' && item.state === 'pending');
		if (!card || (e.target as HTMLElement).tagName === 'BUTTON') {
			return;
		}
		if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !this.input.value.trim())) {
			e.preventDefault();
			e.stopPropagation();
			this.answerPermission(card, e.key === 'Enter');
		}
	}

	private answerPermission(card: IClaudePermissionItem, allow: boolean, always = false): void {
		const cwd = this.cwd;
		if (always && cwd) {
			const { rule } = claudeAllowRule(card.toolName, card.input);
			this.runtime.addAllowRule(cwd, rule).catch(error => this.conversation.setNotice(localize('claude.allowRule.failed', "Could not save the rule: {0}", error instanceof Error ? error.message : String(error))));
		}
		this.runtime.answerPermission(card.sessionId, card.requestId, allow);
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
		this.running = new Set(await this.runtime.getRunningSessions());
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
		if (!text || this.conversation.working) {
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
		this.runtime.send({ cwd, prompt: text + mentions, sessionId: conversation.sessionId, model: this.model, permissionMode: this.mode }).then(result => {
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

	stop(): void {
		if (this.conversation.sessionId && this.conversation.working) {
			this.runtime.stop(this.conversation.sessionId);
		}
	}

	private async checkCli(): Promise<void> {
		const status = await this.runtime.checkCli();
		if (!status.found) {
			this.conversation.setNotice(status.error ?? localize('claude.missing', "Claude Code is not installed."));
		}
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
		if (this.conversation.items.length === 0) {
			this.renderEmpty();
		} else {
			this.conversation.items.forEach(item => this.renderItem(item));
		}
		this.notice.textContent = this.conversation.notice ?? '';
		this.notice.classList.toggle('visible', !!this.conversation.notice);
		this.updateTitle(this.conversation.title ?? localize('claude.title.new', "New agent"));
		this.renderChanges();
		this.renderComposer();
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
				this.renderMarkdown(element, item);
				break;
			case 'tool':
				element.className = 'claude-item claude-tool-item';
				this.renderTool(element, item);
				break;
			case 'permission':
				element.className = 'claude-item claude-permission';
				this.renderPermission(element, item);
				break;
		}
		this.notice.textContent = this.conversation.notice ?? '';
		this.notice.classList.toggle('visible', !!this.conversation.notice);
		this.renderChanges();
		this.renderComposer();
		this.updateTitle(this.conversation.title ?? localize('claude.title.new', "New agent"));
		this.list.scrollTop = this.list.scrollHeight;
	}

	private renderMarkdown(element: HTMLElement, item: IClaudeTextItem): void {
		const rendered = this.markdownRenderer.render(new MarkdownString(item.text));
		element.appendChild(rendered.element);
		this.markdownDisposables.set(item, rendered);
	}

	/** A file chip: type badge and name (v5-S12 `TS total.ts`). */
	private fileChip(parent: HTMLElement, path: string, selector: string): HTMLElement {
		const chip = append(parent, $('span' + selector));
		append(chip, $('span.claude-fti')).textContent = fileTypeLabel(path);
		append(chip, $('span')).textContent = basename(path);
		return chip;
	}

	private renderTool(element: HTMLElement, tool: IClaudeToolItem): void {
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
		if (tool.status === 'running' && tool.name === 'Bash') {
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
			const output = append(element, $('pre.claude-output'));
			output.textContent = tool.output ?? tool.target;
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

	private renderPermission(element: HTMLElement, card: IClaudePermissionItem): void {
		const title = append(element, $('.claude-permission-title'));
		append(title, $('span' + ThemeIcon.asCSSSelector(Codicon.shield)));
		const label = card.toolName === 'Bash'
			? localize('claude.permission.run', "Run {0}?", card.target)
			: localize('claude.permission.use', "Use {0} on {1}?", card.toolName, card.target);
		append(title, $('span.claude-permission-text')).textContent = label;
		if (card.state !== 'pending') {
			append(element, $('.claude-permission-state')).textContent = card.state === 'allowed' ? localize('claude.permission.allowed', "Allowed") : localize('claude.permission.denied', "Denied");
			return;
		}
		const buttons = append(element, $('.claude-permission-buttons'));
		const add = (label: string, className: string, allow: boolean, always = false) => {
			const button = append(buttons, $('button.claude-button' + className)) as HTMLButtonElement;
			button.textContent = label;
			button.addEventListener('click', () => this.answerPermission(card, allow, always));
		};
		add(localize('claude.permission.allow', "Allow once"), '.claude-primary', true);
		add(localize('claude.permission.always', "Always allow {0}", claudeAllowRule(card.toolName, card.input).label), '', true, true);
		add(localize('claude.permission.deny', "Deny"), '.claude-ghost', false);
		append(buttons, $('span.claude-kbd')).textContent = localize('claude.permission.keys', "Enter · Esc");
	}

	/** The empty pane of v5-S07: Recent sessions of this folder, then starters. */
	private renderEmpty(): void {
		const empty = this.emptyState = append(this.list, $('.claude-empty'));
		const open = new Set([this.conversation.sessionId]);
		const recent = this.recent.filter(session => !open.has(session.id));
		if (recent.length) {
			append(empty, $('.claude-section')).textContent = localize('claude.empty.recent', "Recent");
			for (const session of recent.slice(0, this.showAllRecent ? undefined : 3)) {
				const row = append(empty, $('button.claude-recent'));
				append(row, $('span.claude-recent-title')).textContent = session.title;
				const age = fromNow(session.modified, true);
				append(row, $('span.claude-recent-detail')).textContent = this.running.has(session.id) ? localize('claude.recent.running', "Running · {0}", age) : age;
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
		append(this.changesBar, $('span.claude-changes-count')).textContent = localize('claude.changes.files', "{0} files", changes.length);
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
		this.input.placeholder = working
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
		const sendLabel = working ? localize('claude.stop', "Stop") : localize('claude.send', "Send");
		this.sendButton.setAttribute('aria-label', sendLabel);
	}

	override dispose(): void {
		this.ringHover?.dispose();
		super.dispose();
	}
}
