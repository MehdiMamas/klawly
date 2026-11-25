/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/claudeAgentView.css';
import { $, append, clearNode, EventType, addDisposableListener } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/path.js';
import { localize, localize2 } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ClaudeEvent, IClaudeRuntimeService } from '../../../../platform/claude/common/claudeRuntime.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';

export const CLAUDE_AGENT_VIEW_CONTAINER_ID = 'workbench.view.claudeAgent';
export const CLAUDE_AGENT_VIEW_ID = 'workbench.view.claudeAgent.view';
export const CLAUDE_AGENT_TITLE = localize2('claude.agent.title', "Agent");

/** The tool input field that names what a tool acts on, so a row reads as "Edit total.ts" (v5-S12, D17). */
function toolTarget(input: Record<string, unknown>): string {
	const value = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? '';
	const text = typeof value === 'string' ? value : '';
	return text.includes('/') && !text.includes(' ') ? basename(text) : text.split('\n')[0];
}

/**
 * P1's minimal Agent pane (v5-S07 empty pane, v5-S12 working): messages and a composer that runs a real turn
 * through the runtime. shortcut: no model or mode menus, queue, attachments or markdown yet, they arrive in P2.
 */
export class ClaudeAgentViewPane extends ViewPane {

	private messages!: HTMLElement;
	private input!: HTMLTextAreaElement;
	private sendButton!: HTMLButtonElement;
	private stopButton!: HTMLButtonElement;
	private notice!: HTMLElement;
	private emptyState: HTMLElement | undefined;
	private assistantBubble: HTMLElement | undefined;
	private sessionId: string | undefined;
	private working = false;

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.runtime.onDidEvent(event => this.onEvent(event)));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('.claude-agent'));
		this.messages = append(root, $('.claude-messages'));
		this.notice = append(root, $('.claude-notice'));
		const composer = append(root, $('.claude-composer'));
		this.input = append(composer, $('textarea.claude-input')) as HTMLTextAreaElement;
		this.input.rows = 3;
		this.input.placeholder = localize('claude.composer.placeholder', "Ask Claude to change this project");
		this.input.setAttribute('aria-label', localize('claude.composer.label', "Message to Claude"));
		const row = append(composer, $('.claude-composer-row'));
		this.stopButton = append(row, $('button.claude-button.claude-stop')) as HTMLButtonElement;
		this.stopButton.textContent = localize('claude.stop', "Stop");
		this.sendButton = append(row, $('button.claude-button.claude-send')) as HTMLButtonElement;
		this.sendButton.textContent = localize('claude.send', "Send");

		const store = this._register(new DisposableStore());
		store.add(addDisposableListener(this.sendButton, EventType.CLICK, () => this.send()));
		store.add(addDisposableListener(this.stopButton, EventType.CLICK, () => this.stop()));
		store.add(addDisposableListener(this.input, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.send();
			}
		}));
		this.renderEmpty();
		this.updateControls();
		this.checkCli();
	}

	override focus(): void {
		super.focus();
		this.input?.focus();
	}

	/** Starts a fresh conversation; the previous session stays resumable in the CLI. */
	newAgent(): void {
		this.sessionId = undefined;
		this.working = false;
		this.assistantBubble = undefined;
		this.notice.textContent = '';
		this.renderEmpty();
		this.updateControls();
		this.focus();
	}

	/** Sends the composer text, or `prompt` when given (used by the `claude.agent.send` command). */
	send(prompt: string = this.input.value): void {
		const text = prompt.trim();
		const cwd = this.workspaceContext.getWorkspace().folders[0]?.uri.fsPath;
		if (!text || this.working) {
			return;
		}
		if (!cwd) {
			this.notice.textContent = localize('claude.noFolder', "Open a folder first, so Claude knows which project to work in.");
			return;
		}
		this.notice.textContent = '';
		this.input.value = '';
		this.clearEmpty();
		this.addMessage('user', text);
		this.assistantBubble = undefined;
		this.working = true;
		this.updateControls();
		this.runtime.send({ cwd, prompt: text, sessionId: this.sessionId }).then(result => {
			this.sessionId = result.sessionId;
		}, error => {
			this.working = false;
			this.notice.textContent = error instanceof Error ? error.message : String(error);
			this.updateControls();
		});
	}

	stop(): void {
		if (this.sessionId && this.working) {
			this.runtime.stop(this.sessionId);
		}
	}

	private async checkCli(): Promise<void> {
		const status = await this.runtime.checkCli();
		if (!status.found) {
			this.notice.textContent = status.error ?? localize('claude.missing', "Claude Code is not installed.");
		}
	}

	private onEvent(event: ClaudeEvent): void {
		if (!this.sessionId || event.sessionId !== this.sessionId) {
			return;
		}
		switch (event.type) {
			case 'text':
				if (!this.assistantBubble) {
					this.assistantBubble = this.addMessage('assistant', '');
				}
				this.assistantBubble.textContent += event.text;
				break;
			case 'toolUse': {
				this.assistantBubble = undefined;
				const tool = append(this.messages, $('.claude-tool'));
				append(tool, $('span.claude-tool-name')).textContent = event.name;
				append(tool, $('span.claude-tool-target')).textContent = toolTarget(event.input);
				break;
			}
			case 'permission':
				this.assistantBubble = undefined;
				this.addPermission(event);
				break;
			case 'result':
				this.working = false;
				if (event.isError) {
					this.notice.textContent = event.text;
				}
				this.updateControls();
				break;
			case 'error':
				this.working = false;
				this.notice.textContent = event.message;
				this.updateControls();
				break;
			case 'ended':
				this.working = false;
				this.updateControls();
				break;
		}
		this.messages.scrollTop = this.messages.scrollHeight;
	}

	private addPermission(event: Extract<ClaudeEvent, { type: 'permission' }>): void {
		const card = append(this.messages, $('.claude-permission'));
		append(card, $('.claude-permission-title')).textContent = localize('claude.permission.title', "Claude wants to use {0}", event.toolName);
		append(card, $('.claude-permission-detail')).textContent = toolTarget(event.input);
		const buttons = append(card, $('.claude-composer-row'));
		const answer = (allow: boolean) => {
			this.runtime.answerPermission(event.sessionId, event.requestId, allow);
			clearNode(buttons);
			append(card, $('.claude-permission-detail')).textContent = allow ? localize('claude.permission.allowed', "Allowed") : localize('claude.permission.denied', "Denied");
		};
		const deny = append(buttons, $('button.claude-button')) as HTMLButtonElement;
		deny.textContent = localize('claude.permission.deny', "Deny");
		const allow = append(buttons, $('button.claude-button.claude-send')) as HTMLButtonElement;
		allow.textContent = localize('claude.permission.allow', "Allow");
		deny.addEventListener('click', () => answer(false));
		allow.addEventListener('click', () => answer(true));
	}

	private addMessage(role: 'user' | 'assistant', text: string): HTMLElement {
		const bubble = append(this.messages, $(`.claude-message.claude-${role}`));
		bubble.textContent = text;
		return bubble;
	}

	private renderEmpty(): void {
		clearNode(this.messages);
		const empty = this.emptyState = append(this.messages, $('.claude-empty'));
		append(empty, $('.claude-empty-title')).textContent = localize('claude.empty.title', "What should Claude work on?");
	}

	private clearEmpty(): void {
		this.emptyState?.remove();
		this.emptyState = undefined;
	}

	private updateControls(): void {
		this.sendButton.disabled = this.working;
		this.stopButton.style.display = this.working ? '' : 'none';
	}
}
