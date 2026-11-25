/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/claudeAgentView.css';
import { $, append, clearNode, EventType, addDisposableListener } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Action, IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableMap, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/path.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
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
import { ClaudeConversation, ClaudeItem, IClaudePermissionItem, IClaudeTextItem, IClaudeToolItem } from '../../../../platform/claude/common/claudeConversation.js';
import { ClaudeEvent, IClaudeRuntimeService, IClaudeSendRequest } from '../../../../platform/claude/common/claudeRuntime.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';

export const CLAUDE_AGENT_VIEW_CONTAINER_ID = 'workbench.view.claudeAgent';
export const CLAUDE_AGENT_VIEW_ID = 'workbench.view.claudeAgent.view';
export const CLAUDE_AGENT_TITLE = localize2('claude.agent.title', "Agent");

type PermissionMode = NonNullable<IClaudeSendRequest['permissionMode']>;

/** The context window the usage ring is measured against (v5-S12 composer, VC10). */
const CONTEXT_WINDOW_TOKENS = 200000;

function modes(): { readonly id: PermissionMode; readonly label: string; readonly detail: string }[] {
	return [
		{ id: 'default', label: localize('claude.mode.default', "Ask Before Edits"), detail: localize('claude.mode.default.detail', "Claude asks before each edit and command") },
		{ id: 'acceptEdits', label: localize('claude.mode.acceptEdits', "Edit Automatically"), detail: localize('claude.mode.acceptEdits.detail', "Edits apply; commands still ask") },
		{ id: 'plan', label: localize('claude.mode.plan', "Plan First"), detail: localize('claude.mode.plan.detail', "Read-only until you approve a plan") },
	];
}

function models(): { readonly id: string | undefined; readonly label: string; readonly detail: string }[] {
	return [
		{ id: undefined, label: localize('claude.model.default', "Default"), detail: localize('claude.model.default.detail', "The model your Claude Code settings pick") },
		{ id: 'opus', label: 'Opus', detail: localize('claude.model.opus.detail', "Hardest tasks, uses limits faster") },
		{ id: 'sonnet', label: 'Sonnet', detail: localize('claude.model.sonnet.detail', "Everyday coding") },
		{ id: 'haiku', label: 'Haiku', detail: localize('claude.model.haiku.detail', "Fast, light tasks") },
	];
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
	private model: string | undefined;

	private list!: HTMLElement;
	private emptyState: HTMLElement | undefined;
	private notice!: HTMLElement;
	private changesBar!: HTMLElement;
	private input!: HTMLTextAreaElement;
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
		this.input = append(box, $('textarea.claude-input')) as HTMLTextAreaElement;
		this.input.rows = 1;
		this.input.setAttribute('aria-label', localize('claude.composer.label', "Message to Claude"));
		const row = append(box, $('.claude-row'));
		this.modeChip = this.chip(row, 'claude-mode');
		this.modelChip = this.chip(row, 'claude-model');
		this.ring = append(row, $('.claude-ring'));
		this.ring.setAttribute('role', 'img');
		this.sendButton = append(row, $('button.claude-send')) as HTMLButtonElement;
		append(this.sendButton, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowUp)));

		const store = this._register(new DisposableStore());
		store.add(addDisposableListener(this.sendButton, EventType.CLICK, () => this.conversation.working ? this.stop() : this.send()));
		store.add(addDisposableListener(this.modeChip, EventType.CLICK, () => this.showMenu(this.modeChip, modes().map(m => this.menuAction(m.label, m.detail, m.id === this.mode, () => { this.mode = m.id; this.renderComposer(); })))));
		store.add(addDisposableListener(this.modelChip, EventType.CLICK, () => this.showMenu(this.modelChip, models().map(m => this.menuAction(m.label, m.detail, m.id === this.model, () => { this.model = m.id; this.renderComposer(); })))));
		store.add(addDisposableListener(this.input, EventType.INPUT, () => this.renderComposer()));
		store.add(addDisposableListener(this.input, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.send();
			}
		}));
		this.renderAll();
		this.checkCli();
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
		this.watch(this.conversation);
		this.renderAll();
		this.focus();
	}

	/** Sends the composer text, or `prompt` when given (used by the `claude.agent.send` command). */
	send(prompt: string = this.input.value): void {
		const text = prompt.trim();
		const cwd = this.workspaceContext.getWorkspace().folders[0]?.uri.fsPath;
		if (!text || this.conversation.working) {
			return;
		}
		if (!cwd) {
			this.conversation.setNotice(localize('claude.noFolder', "Open a folder first, so Claude knows which project to work in."));
			return;
		}
		const conversation = this.conversation;
		this.input.value = '';
		this.pendingEvents = [];
		conversation.addUser(text);
		this.runtime.send({ cwd, prompt: text, sessionId: conversation.sessionId, model: this.model, permissionMode: this.mode }).then(result => {
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
		this.updateTitle(this.conversation.title ?? localize('claude.title.new', "New Agent"));
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
			case 'user':
				element.className = 'claude-item claude-user';
				append(element, $('.claude-bubble')).textContent = item.text;
				break;
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
		this.updateTitle(this.conversation.title ?? localize('claude.title.new', "New Agent"));
		this.list.scrollTop = this.list.scrollHeight;
	}

	private renderMarkdown(element: HTMLElement, item: IClaudeTextItem): void {
		const rendered = this.markdownRenderer.render(new MarkdownString(item.text));
		element.appendChild(rendered.element);
		this.markdownDisposables.set(item, rendered);
	}

	private renderTool(element: HTMLElement, tool: IClaudeToolItem): void {
		const row = append(element, $('button.claude-tool'));
		row.setAttribute('aria-expanded', String(this.expanded.has(tool)));
		const status = tool.status === 'running' ? Codicon.loading : tool.status === 'failed' ? Codicon.error : Codicon.check;
		append(append(row, $('span.claude-tool-icon')), $('span' + ThemeIcon.asCSSSelector(status) + (tool.status === 'running' ? '.codicon-modifier-spin' : '')));
		append(row, $('span.claude-tool-verb')).textContent = tool.name;
		const target = tool.target.includes('/') && !tool.target.includes(' ') ? basename(tool.target) : tool.target;
		append(row, $('span.claude-tool-target')).textContent = target;
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
		const answer = (allow: boolean) => {
			this.runtime.answerPermission(card.sessionId, card.requestId, allow);
			this.conversation.resolvePermission(card, allow);
		};
		const allow = append(buttons, $('button.claude-button.claude-primary')) as HTMLButtonElement;
		allow.textContent = localize('claude.permission.allow', "Allow Once");
		const deny = append(buttons, $('button.claude-button')) as HTMLButtonElement;
		deny.textContent = localize('claude.permission.deny', "Deny");
		allow.addEventListener('click', () => answer(true));
		deny.addEventListener('click', () => answer(false));
	}

	/** The empty pane of v5-S07: starters only; the Recent list needs session history (later phase). */
	private renderEmpty(): void {
		const empty = this.emptyState = append(this.list, $('.claude-empty'));
		append(empty, $('.claude-section')).textContent = localize('claude.empty.start', "Start With");
		for (const starter of [
			localize('claude.starter.explain', "Explain this repo"),
			localize('claude.starter.bugs', "Find bugs in this project"),
			localize('claude.starter.tests', "Write tests for the open file"),
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
		this.modeChip.textContent = modes().find(m => m.id === this.mode)?.label ?? '';
		this.modelChip.textContent = models().find(m => m.id === this.model)?.label ?? '';
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
