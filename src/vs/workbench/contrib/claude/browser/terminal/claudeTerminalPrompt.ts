/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/claude.css';
import { $, addDisposableListener, append, clearNode, DisposableResizeObserver, EventType, getTotalHeight, getWindow } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { CLAUDE_INLINE_EDIT_MODEL_SETTING, readClaudeModelId } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight, KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { INLINE_EDIT_KLAWLY_KEY, INLINE_EDIT_DEFAULT_KEY } from '../../../../services/claude/common/claudeInlineEdit.js';
import { ITerminalContribution, ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { ITerminalContributionContext, registerTerminalContribution } from '../../../terminal/browser/terminalExtensions.js';
import { TerminalContextKeys } from '../../../terminal/common/terminalContextKey.js';
import { CLAUDE_AGENT_ENABLED, CLAUDE_KLAWLY_KEYMAP, CLAUDE_DEFAULT_KEY_LABEL_WEIGHT, CLAUDE_DEFAULT_KEY_LABEL_WHEN } from '../../common/claudeContextKeys.js';
import { buildTerminalCommandPrompt, buildTerminalQuestionPrompt, ClaudeTerminalContext, parseTerminalCommand, terminalOutputLift, terminalShellFamily } from '../../common/claudeTerminalPrompt.js';
import { KLAWLY_CATEGORY } from '../../common/claudeViews.js';

/** Also listed in the terminal's commands-to-skip-shell, so the key reaches the workbench. */
export const CLAUDE_TERMINAL_PROMPT_COMMAND_ID = 'klawly.terminalPrompt.start';

/** What the card needs from a terminal: where it is, what it runs, and a way to type into it. */
export type ClaudeTerminalTarget = Pick<ITerminalInstance, 'shellType' | 'os' | 'getCwdResource' | 'sendText' | 'focus'>;

/**
 * The terminal's Ctrl+K card, docked at the bottom of the terminal. Claude
 * writes one command and the card types it at the prompt without running it.
 * A quick question is answered in the card instead.
 */
export class ClaudeTerminalPromptWidget extends Disposable {
	private _mode: 'prompt' | 'running' | 'answer' = 'prompt';
	private _question = false;
	private _requestId: string | undefined;
	private readonly _root: HTMLElement;
	private readonly _field: HTMLTextAreaElement;
	private readonly _toolbar: HTMLElement;
	private readonly _toggle: HTMLButtonElement;
	private readonly _submit: HTMLButtonElement;
	private readonly _submitIcon: HTMLElement;
	private readonly _status: HTMLElement;
	private readonly _reply: HTMLElement;

	constructor(
		container: HTMLElement,
		private readonly _target: ClaudeTerminalTarget,
		private readonly _onClose: () => void,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
	) {
		super();
		this._root = append(container, $('div.claude-inline.claude-terminal-prompt'));
		this._root.setAttribute('role', 'dialog');
		this._root.setAttribute('aria-label', localize('claudeTerminalDialog', "Ask Claude for a command"));
		this._register({ dispose: () => this._root.remove() });

		const input = append(this._root, $('div.claude-inline-input'));
		this._field = append(input, $<HTMLTextAreaElement>('textarea.field'));
		this._field.rows = 1;
		const close = append(input, $<HTMLButtonElement>('button.claude-inline-icon'));
		close.type = 'button';
		close.setAttribute('aria-label', localize('claudeTerminalClose', "Close (Escape)"));
		append(close, $(ThemeIcon.asCSSSelector(Codicon.close)));
		this._register(addDisposableListener(close, EventType.CLICK, event => {
			event.preventDefault();
			this.close();
		}));

		this._reply = append(this._root, $('div.claude-terminal-reply'));
		this._reply.setAttribute('aria-live', 'polite');
		this._reply.hidden = true;

		this._toolbar = append(this._root, $('div.claude-inline-toolbar'));
		this._status = append(this._toolbar, $('span.claude-activity.is-shimmer'));
		append(this._status, $('span.text'));
		this._status.hidden = true;
		append(this._toolbar, $('span.spacer'));
		this._toggle = append(this._toolbar, $<HTMLButtonElement>('button.claude-inline-text.claude-terminal-toggle'));
		this._toggle.type = 'button';
		this._toggle.textContent = localize('claudeTerminalQuestion', "Quick Question");
		this._register(addDisposableListener(this._toggle, EventType.CLICK, event => {
			event.preventDefault();
			this.setQuestion(!this._question);
			this._field.focus();
		}));
		this._submit = append(this._toolbar, $<HTMLButtonElement>('button.claude-inline-submit'));
		this._submit.type = 'button';
		this._submitIcon = append(this._submit, $('span'));
		this._register(addDisposableListener(this._submit, EventType.CLICK, event => {
			event.preventDefault();
			if (this._mode === 'running') {
				this.stop();
				return;
			}
			void this.submit();
		}));
		this._register(addDisposableListener(this._field, EventType.KEY_DOWN, event => this.onKey(event)));
		this._register(addDisposableListener(this._field, EventType.INPUT, () => {
			if (this._mode === 'answer') {
				this.showPrompt();
			}
		}));
		this.setQuestion(false);
		this.paintSubmit();
	}

	get domNode(): HTMLElement {
		return this._root;
	}

	focus(): void {
		this._field.focus();
	}

	override dispose(): void {
		this.stop();
		super.dispose();
	}

	/** Sends the instruction. A command is typed at the prompt, never run; an answer stays in the card. */
	async submit(): Promise<void> {
		const text = this._field.value.trim();
		if (!text || this._mode === 'running') {
			return;
		}
		const question = this._question;
		const context = await this.context();
		const cwd = context.cwd ?? this._workspace.getWorkspace().folders[0]?.uri.fsPath;
		if (!cwd || !this._runtime.completeInline) {
			this.showReply(localize('claudeTerminalUnavailable', "Claude is not available here. Open a folder or check the Claude Code runtime."), true);
			return;
		}
		const id = generateUuid();
		this._requestId = id;
		this._mode = 'running';
		this._field.readOnly = true;
		this._root.setAttribute('aria-busy', 'true');
		this._reply.hidden = true;
		this._toggle.hidden = true;
		this._status.hidden = false;
		this._status.firstElementChild!.textContent = question ? localize('claudeTerminalThinking', "Thinking...") : localize('claudeTerminalWriting', "Writing command...");
		this.paintSubmit();
		let raw: string | undefined;
		try {
			raw = await this._runtime.completeInline({
				id,
				prompt: question ? buildTerminalQuestionPrompt(text, context) : buildTerminalCommandPrompt(text, context),
				cwd,
				model: this.model(),
			});
		} catch {
			raw = undefined;
		}
		if (this._requestId !== id) {
			// Stopped or closed while Claude was writing.
			return;
		}
		this._requestId = undefined;
		if (question) {
			const answer = raw?.trim();
			this.showReply(answer || localize('claudeTerminalNoAnswer', "Claude did not answer. Try again."), !answer);
			return;
		}
		const command = raw ? parseTerminalCommand(raw, terminalShellFamily(context.shell, context.os)) : undefined;
		if (!command) {
			this.showReply(localize('claudeTerminalNoCommand', "Claude did not return a command. Try rephrasing."), true);
			return;
		}
		// Never executed: `shouldExecute` is false and the parsed text has no line breaks.
		await this._target.sendText(command, false, true);
		this._onClose();
	}

	private async context(): Promise<ClaudeTerminalContext> {
		let cwd: string | undefined;
		try {
			cwd = (await this._target.getCwdResource())?.fsPath;
		} catch {
			cwd = undefined;
		}
		return { shell: this._target.shellType, os: this._target.os, cwd };
	}

	/** The inline-edit model when one is set, otherwise the agent session's model. */
	private model(): string | undefined {
		return readClaudeModelId(this._configuration.getValue(CLAUDE_INLINE_EDIT_MODEL_SETTING)) ?? this._agent.getCurrentSession()?.modelId;
	}

	private setQuestion(question: boolean): void {
		this._question = question;
		this._toggle.setAttribute('aria-pressed', String(question));
		this._toggle.classList.toggle('is-on', question);
		const placeholder = question ? localize('claudeTerminalQuestionPlaceholder', "Ask about the terminal") : localize('claudeTerminalCommandPlaceholder', "Describe a command");
		this._field.placeholder = placeholder;
		this._field.setAttribute('aria-label', placeholder);
		if (this._mode === 'answer') {
			this.showPrompt();
		}
	}

	private showPrompt(): void {
		this._mode = 'prompt';
		this._reply.hidden = true;
		this.paintSubmit();
	}

	/** Shows an answer or an error under the field, with inline code set apart. */
	private showReply(text: string, error: boolean): void {
		this._mode = 'answer';
		this._field.readOnly = false;
		this._root.removeAttribute('aria-busy');
		this._status.hidden = true;
		this._toggle.hidden = false;
		clearNode(this._reply);
		this._reply.classList.toggle('is-error', error);
		text.split('`').forEach((part, index) => {
			if (part) {
				append(this._reply, $(index % 2 ? 'code' : 'span')).textContent = part;
			}
		});
		this._reply.hidden = false;
		this.paintSubmit();
		this._field.focus();
	}

	private paintSubmit(): void {
		const running = this._mode === 'running';
		this._submit.classList.toggle('is-stop', running);
		this._submit.setAttribute('aria-label', running ? localize('claudeTerminalStop', "Stop") : localize('claudeTerminalSubmit', "Submit"));
		this._submitIcon.className = ThemeIcon.asClassName(running ? Codicon.debugStop : Codicon.arrowUp);
	}

	private stop(): void {
		const id = this._requestId;
		if (!id) {
			return;
		}
		this._requestId = undefined;
		void this._runtime.cancelInline?.(id);
		this._field.readOnly = false;
		this._root.removeAttribute('aria-busy');
		this._status.hidden = true;
		this._toggle.hidden = false;
		this.showPrompt();
	}

	private close(): void {
		if (this._mode === 'running') {
			this.stop();
			return;
		}
		this._onClose();
	}

	private onKey(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			this.close();
			return;
		}
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			void this.submit();
		}
	}
}

/** Opens and closes the card on one terminal. */
class ClaudeTerminalPromptContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'klawly.terminalPrompt';

	static get(instance: ITerminalInstance): ClaudeTerminalPromptContribution | null {
		return instance.getContribution<ClaudeTerminalPromptContribution>(ClaudeTerminalPromptContribution.ID);
	}

	private readonly _widget = this._register(new MutableDisposable<ClaudeTerminalPromptWidget>());
	private readonly _lift = this._register(new MutableDisposable());

	constructor(
		private readonly _ctx: ITerminalContributionContext,
		@IInstantiationService private readonly _instantiation: IInstantiationService,
	) {
		super();
	}

	open(): void {
		if (!this._widget.value) {
			const container = this._ctx.instance.domElement;
			this._widget.value = this._instantiation.createInstance(ClaudeTerminalPromptWidget, container, this._ctx.instance, () => this.close());
			this._lift.value = this.liftOutput(container, this._widget.value.domNode);
		}
		this._widget.value.focus();
	}

	close(): void {
		this._lift.clear();
		this._widget.clear();
		this._ctx.instance.focus();
	}

	/** Keeps the cursor's line above the card while it is open, so the output ends where the card starts. */
	private liftOutput(container: HTMLElement, card: HTMLElement): IDisposable {
		const store = new DisposableStore();
		const xterm = this._ctx.instance.xterm;
		const output = xterm?.raw.element;
		if (!xterm || !output) {
			return store;
		}
		const update = () => {
			const font = xterm.getFont();
			const cellHeight = (font.charHeight ?? 0) * font.lineHeight;
			const lift = cellHeight ? terminalOutputLift(xterm.raw.buffer.active.cursorY, xterm.raw.rows, cellHeight, getTotalHeight(card)) : 0;
			output.style.bottom = lift ? `${lift}px` : '';
		};
		store.add(xterm.raw.onCursorMove(update));
		store.add(xterm.raw.onResize(update));
		const observer = store.add(new DisposableResizeObserver('claudeTerminalPrompt', update, getWindow(container)));
		store.add(observer.observe(card));
		store.add(observer.observe(container));
		store.add(toDisposable(() => { output.style.bottom = ''; }));
		update();
		return store;
	}
}

export function registerClaudeTerminalPrompt(): void {
	registerTerminalContribution(ClaudeTerminalPromptContribution.ID, ClaudeTerminalPromptContribution);

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_TERMINAL_PROMPT_COMMAND_ID,
				title: localize2('claudeTerminalPrompt', "Ask Claude for a Terminal Command"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				keybinding: {
					primary: INLINE_EDIT_DEFAULT_KEY,
					weight: KeybindingWeight.WorkbenchContrib + 2,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, TerminalContextKeys.focus),
				},
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const terminals = accessor.get(ITerminalService);
			const instance = terminals.activeInstance ?? await terminals.createTerminal();
			await terminals.revealTerminal(instance);
			ClaudeTerminalPromptContribution.get(instance)?.open();
		}
	});

	KeybindingsRegistry.registerKeybindingRule({
		id: CLAUDE_TERMINAL_PROMPT_COMMAND_ID,
		// Above the terminal's own Cmd+K (Clear) so the Klawly Keys preset wins there too.
		weight: KeybindingWeight.WorkbenchContrib + 2,
		when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, TerminalContextKeys.focus, CLAUDE_KLAWLY_KEYMAP),
		primary: INLINE_EDIT_KLAWLY_KEY,
	});

	// With the preset off, labels outside the terminal show Ctrl/Cmd+Alt+K, not Ctrl/Cmd+K.
	// Below Inline Edit's rule of the same kind, so there the key runs Inline Edit.
	KeybindingsRegistry.registerKeybindingRule({
		id: CLAUDE_TERMINAL_PROMPT_COMMAND_ID,
		weight: CLAUDE_DEFAULT_KEY_LABEL_WEIGHT - 1,
		when: CLAUDE_DEFAULT_KEY_LABEL_WHEN,
		primary: INLINE_EDIT_DEFAULT_KEY,
	});
}
