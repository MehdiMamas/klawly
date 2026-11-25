/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, Dimension, EventType, getActiveElement, isHTMLElement } from '../../../../../base/browser/dom.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { DisposableStore, IReference, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename } from '../../../../../base/common/resources.js';
import { ScrollbarVisibility } from '../../../../../base/common/scrollable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../../nls.js';
import { compileSubmission } from '../../../../../platform/claude/common/claudePrompt.js';
import { buildPlanFilePrompt, newPlanTodoLine, parsePlanDocument, PlanDocument, setPlanTodoDone } from '../../../../../platform/claude/common/claudePlanDocument.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { DEFAULT_EDITOR_ASSOCIATION, EditorInputCapabilities, IEditorOpenContext, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { CLAUDE_BACKGROUND_PROMPT_COMMAND_ID } from '../../../../services/claude/common/claudeBackgroundAgent.js';
import { ClaudeAgentSession, IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudeContextService } from '../../../../services/claude/common/claudeContextService.js';
import { IClaudePlanLinks, PlanLink } from '../../../../services/claude/common/claudePlanLinks.js';
import { redactSecrets } from '../../../../services/claude/common/claudeAgentLog.js';
import { inlineMarkdownRuns } from '../../common/claudeTimelineModel.js';
import { CLAUDE_AGENT_VIEW_ID } from '../../common/claudeViews.js';
import { claudeSteerKeyLabel } from '../chat/claudeKbd.js';
import { ClaudePopoverMenu } from '../widgets/claudePopoverMenu.js';
import { ClaudeBuildButton, ClaudeBuildTarget } from './claudeBuildButton.js';
import { CLAUDE_PLAN_EDITOR_ID, CLAUDE_SAVE_PLAN_TO_WORKSPACE_COMMAND_ID } from './claudePlanCommands.js';
import { IClaudePlanParallelBuilds } from './claudePlanParallel.js';

/** A plan file opened in the plan editor. The file stays the source of truth; the input holds only its URI. */
export class ClaudePlanInput extends EditorInput {

	static readonly ID = 'workbench.input.klawlyPlan';

	constructor(private readonly _resource: URI) {
		super();
	}

	override get typeId(): string {
		return ClaudePlanInput.ID;
	}

	override get editorId(): string | undefined {
		return ClaudePlanEditor.ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	/** The plan page has its own header, so the group shows no breadcrumbs row over it. */
	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.HideBreadcrumbs;
	}

	/** The tab is the file name, `.plan.md` included, like any other file's tab. */
	override getName(): string {
		return basename(this._resource);
	}

	override getIcon(): ThemeIcon {
		return Codicon.checklist;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof ClaudePlanInput && other.resource.toString() === this._resource.toString();
	}
}

/**
 * The plan editor: a plan file as a page to work from. It shows the title, the
 * prose, the to-dos as rows to tick off, and the chats that wrote or built the
 * plan. Ticking or adding a to-do edits the file; Build sends its open to-dos
 * to an agent. Open as Text shows the Markdown.
 */
export class ClaudePlanEditor extends EditorPane {

	static readonly ID = CLAUDE_PLAN_EDITOR_ID;

	private _header!: HTMLElement;
	private _progress!: HTMLElement;
	private _column!: HTMLElement;
	private _scrollable!: DomScrollableElement;
	private _build!: ClaudeBuildButton;
	private _menu!: ClaudePopoverMenu;
	private _more!: HTMLButtonElement;
	private readonly _model = this._register(new MutableDisposable<IReference<IResolvedTextEditorModel>>());
	private readonly _inputStore = this._register(new DisposableStore());
	private readonly _renderStore = this._register(new DisposableStore());
	private _adding = false;
	/** The rendered check buttons by to-do index, and the new to-do input while adding. */
	private readonly _checks: HTMLButtonElement[] = [];
	private _newInput: HTMLInputElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ITextModelService private readonly _textModels: ITextModelService,
		@ITextFileService private readonly _textFiles: ITextFileService,
		@IMarkdownRendererService private readonly _markdown: IMarkdownRendererService,
		@IInstantiationService private readonly _instantiation: IInstantiationService,
		@IClaudePlanLinks private readonly _links: IClaudePlanLinks,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeContextService private readonly _context: IClaudeContextService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IEditorService private readonly _editors: IEditorService,
		@IViewsService private readonly _views: IViewsService,
		@INotificationService private readonly _notifications: INotificationService,
		@ICommandService private readonly _commands: ICommandService,
		@IContextViewService private readonly _contextView: IContextViewService,
		@IHoverService private readonly _hover: IHoverService,
		@IClipboardService private readonly _clipboard: IClipboardService,
		@ILabelService private readonly _labels: ILabelService,
		@IClaudePlanParallelBuilds private readonly _parallel: IClaudePlanParallelBuilds,
	) {
		super(ClaudePlanEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		const root = append(parent, $('.claude-root.claude-plan-editor'));
		this._header = append(root, $('.claude-plan-editor-header'));
		this._progress = append(this._header, $('.claude-plan-progress'));
		append(this._header, $('span.spacer'));
		this._build = this._register(this._instantiation.createInstance(ClaudeBuildButton, this._header, {
			run: target => this.build(target),
			keybinding: claudeSteerKeyLabel(),
			hideKeybinding: true,
			parallel: true,
		}));
		// DL-06: the plan surfaces' Build is the small 20px size; it stays the orange primary action (DL-09).
		this._build.element.classList.add('is-plan');
		this._menu = this._register(new ClaudePopoverMenu(this._contextView, this._hover));
		this._more = append(this._header, $<HTMLButtonElement>('button.claude-icon-btn.claude-plan-more'));
		this._more.type = 'button';
		this._more.setAttribute('aria-haspopup', 'menu');
		this._more.setAttribute('aria-label', localize('claudePlanMore', "More Plan Actions"));
		this._more.title = localize('claudePlanMore', "More Plan Actions");
		append(this._more, $(ThemeIcon.asCSSSelector(Codicon.ellipsis)));
		this._register(addDisposableListener(this._more, EventType.CLICK, () => this.toggleMenu()));

		const body = $('.claude-plan-editor-body');
		this._column = append(body, $('.claude-plan-page'));
		this._scrollable = this._register(new DomScrollableElement(body, {
			horizontal: ScrollbarVisibility.Hidden,
			vertical: ScrollbarVisibility.Auto,
		}));
		append(root, this._scrollable.getDomNode());
		this._register(this._links.onDidChange(plan => {
			if (plan.toString() === this.input?.resource?.toString()) {
				this.render();
			}
		}));
		this._register(this._parallel.onDidChange(() => {
			if (this.input?.resource) {
				this.render();
			}
		}));
	}

	override async setInput(input: ClaudePlanInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this._inputStore.clear();
		this._model.clear();
		this._adding = false;
		const reference = await this._textModels.createModelReference(input.resource);
		if (token.isCancellationRequested || this.input !== input) {
			reference.dispose();
			return;
		}
		this._model.value = reference;
		const model = reference.object.textEditorModel;
		this._inputStore.add(model.onDidChangeContent(() => this.render()));
		this.render();
	}

	override clearInput(): void {
		this._inputStore.clear();
		this._model.clear();
		this._renderStore.clear();
		this._checks.length = 0;
		this._newInput = undefined;
		clearNode(this._column);
		clearNode(this._progress);
		super.clearInput();
	}

	override focus(): void {
		super.focus();
		this._build.main.focus();
	}

	override layout(dimension: Dimension): void {
		const headerHeight = this._header.offsetHeight;
		this._scrollable.getDomNode().style.height = `${Math.max(0, dimension.height - headerHeight)}px`;
		this._scrollable.scanDomNode();
	}

	/** The parsed plan as the editor shows it, for tests and the Build command. */
	get document(): PlanDocument | undefined {
		const model = this.textModel;
		return model ? parsePlanDocument(model.getValue()) : undefined;
	}

	/** Build with the default target, as the main Build button does. */
	runBuild(): Promise<void> {
		return this._build.run();
	}

	private get textModel(): ITextModel | undefined {
		return this._model.value?.object.textEditorModel ?? undefined;
	}

	private render(): void {
		const resource = this.input?.resource;
		const model = this.textModel;
		if (!resource || !model) {
			return;
		}
		// The rows are rebuilt on every change, so focus moves back to the row it was on.
		const active = getActiveElement();
		const focusedTodo = isHTMLElement(active) && active.dataset.todo !== undefined ? active.dataset.todo : undefined;
		this._renderStore.clear();
		this._checks.length = 0;
		this._newInput = undefined;
		clearNode(this._column);
		const document = parsePlanDocument(model.getValue());
		this.renderProgress(document);
		append(this._column, $('h1.claude-plan-title')).textContent = document.title ?? this.input?.getName() ?? '';
		this.appendMarkdown(document.before);
		this.renderTodos(model, document);
		this.appendMarkdown(document.after);
		this.renderLinks(resource);
		this._build.setEnabled(document.todos.some(todo => !todo.done));
		if (focusedTodo !== undefined) {
			this._checks[Number(focusedTodo)]?.focus();
		}
		this._scrollable.scanDomNode();
	}

	/** How far the build got, in the header: "2 of 4 done" over a thin bar. More Plan Actions reveals or copies where the file is. */
	private renderProgress(document: PlanDocument): void {
		clearNode(this._progress);
		const total = document.todos.length;
		const done = document.todos.filter(todo => todo.done).length;
		append(this._progress, $(ThemeIcon.asCSSSelector(done > 0 && done === total ? Codicon.passFilled : Codicon.checklist)));
		append(this._progress, $('span.label')).textContent = total === 0
			? localize('claudePlanProgressNone', "No to-dos")
			: localize('claudePlanProgress', "{0} of {1} done", done, total);
		const bar = append(this._progress, $('span.bar'));
		bar.setAttribute('role', 'progressbar');
		bar.setAttribute('aria-label', localize('claudePlanProgressLabel', "To-dos done"));
		bar.setAttribute('aria-valuemin', '0');
		bar.setAttribute('aria-valuemax', String(total));
		bar.setAttribute('aria-valuenow', String(done));
		append(bar, $('span.fill')).style.width = total === 0 ? '0' : `${Math.round(done / total * 100)}%`;
	}

	private appendMarkdown(source: string): void {
		if (!source) {
			return;
		}
		const prose = append(this._column, $('.claude-plan-prose'));
		const rendered = this._renderStore.add(this._markdown.render(new MarkdownString(source, { isTrusted: false, supportThemeIcons: false })));
		prose.appendChild(rendered.element);
	}

	private renderTodos(model: ITextModel, document: PlanDocument): void {
		const section = append(this._column, $('section.claude-plan-section.claude-plan-todo-section'));
		const head = append(section, $('.claude-plan-section-head'));
		const label = append(head, $('h2.label'));
		label.textContent = document.todos.length === 1
			? localize('claudePlanOneTodo', "1 To-do")
			: localize('claudePlanTodos', "{0} To-dos", document.todos.length);
		append(head, $('span.spacer'));
		const add = append(head, $<HTMLButtonElement>('button.claude-btn.is-ghost.is-small.claude-plan-add'));
		add.type = 'button';
		append(add, $(ThemeIcon.asCSSSelector(Codicon.add)));
		append(add, $('span')).textContent = localize('claudePlanNewTodo', "New");
		add.title = localize('claudePlanNewTodoTitle', "Add a To-do");
		this._renderStore.add(addDisposableListener(add, EventType.CLICK, () => {
			this._adding = true;
			this.render();
		}));

		const list = append(section, $<HTMLUListElement>('ul.claude-plan-todo-list'));
		list.setAttribute('aria-label', localize('claudePlanTodoList', "To-dos"));
		const parallel = this._parallel.getStates(model.uri);
		document.todos.forEach((todo, index) => {
			const state = todo.done ? undefined : parallel.get(todo.text);
			const row = append(list, $('li.claude-plan-todo' + (todo.done ? '.is-done' : state === 'building' ? '.is-building' : state === 'failed' ? '.is-failed' : '')));
			const check = append(row, $<HTMLButtonElement>('button.claude-plan-check'));
			check.type = 'button';
			check.dataset.todo = String(index);
			this._checks[index] = check;
			check.setAttribute('role', 'checkbox');
			check.setAttribute('aria-checked', todo.done ? 'true' : 'false');
			check.setAttribute('aria-label', todo.text);
			check.title = todo.done ? localize('claudePlanMarkOpen', "Mark as Not Done") : localize('claudePlanMarkDone', "Mark as Done");
			// Issue 495: a to-do a background agent builds shows that in its check until the agent completes (DL-60).
			if (state === 'building') {
				check.title = localize('claudePlanBuilding', "A background agent is building this to-do");
			} else if (state === 'failed') {
				check.title = localize('claudePlanBuildFailed', "Its background agent didn't finish. Open it from the chat's parallel tasks.");
			}
			append(check, $(ThemeIcon.asCSSSelector(todo.done ? Codicon.passFilled : state === 'building' ? ThemeIcon.modify(Codicon.loading, 'spin') : state === 'failed' ? Codicon.error : Codicon.circleLargeOutline)));
			this._renderStore.add(addDisposableListener(check, EventType.CLICK, () => {
				void this.edit(model, todo.line, setPlanTodoDone(model.getLineContent(todo.line), !todo.done), 'replace');
			}));
			const text = append(row, $('.text'));
			this.appendInline(append(text, $('span.title')), todo.text);
			if (todo.detail) {
				this.appendInline(append(text, $('span.detail')), todo.detail);
			}
			if (todo.depends?.length) {
				append(text, $('span.detail.claude-plan-depends')).textContent = todo.depends.length === 1
					? localize('claudePlanDependsOne', "Waits for to-do {0}", todo.depends[0])
					: localize('claudePlanDependsMany', "Waits for to-dos {0}", todo.depends.join(', '));
			}
			// Issue 898: a to-do built by a background agent links to that agent's chat (DL-60).
			if (this._parallel.canOpen(model.uri, todo.text)) {
				const open = append(row, $<HTMLButtonElement>('button.claude-btn.is-ghost.is-small.claude-plan-agent'));
				open.type = 'button';
				append(open, $(ThemeIcon.asCSSSelector(Codicon.commentDiscussion)));
				open.title = localize('claudePlanOpenAgent', "Open the Agent Building This To-do");
				open.setAttribute('aria-label', localize('claudePlanOpenAgentLabel', "Open the agent building {0}", todo.text));
				this._renderStore.add(addDisposableListener(open, EventType.CLICK, () => this._parallel.open(model.uri, todo.text)));
			}
		});
		if (document.todos.length === 0 && !this._adding) {
			append(section, $('.claude-plan-empty')).textContent = localize('claudePlanNoTodos', "This plan has no to-dos yet.");
		}
		if (this._adding) {
			this.renderNewTodo(section, model, document);
		}
	}

	private renderNewTodo(section: HTMLElement, model: ITextModel, document: PlanDocument): void {
		const row = append(section, $('.claude-plan-todo.is-new'));
		append(row, $('span.claude-plan-check-placeholder' + ThemeIcon.asCSSSelector(Codicon.circleLargeOutline)));
		const input = append(row, $<HTMLInputElement>('input.claude-field.claude-plan-new-input'));
		this._newInput = input;
		input.type = 'text';
		input.placeholder = localize('claudePlanNewTodoPlaceholder', "Describe the to-do, then press Enter");
		input.setAttribute('aria-label', localize('claudePlanNewTodoLabel', "New to-do"));
		this._renderStore.add(addDisposableListener(input, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' && input.value.trim()) {
				event.preventDefault();
				const text = newPlanTodoLine(document, input.value);
				// Stay in add mode, so several to-dos can be typed in a row.
				void this.edit(model, document.insertLine, text, 'insert').then(() => this.focusNewTodo());
			} else if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this._adding = false;
				this.render();
			}
		}));
		input.focus();
	}

	private focusNewTodo(): void {
		this._newInput?.focus();
	}

	/**
	 * Replaces line `line`, or inserts `text` as a new line before it. Saves the
	 * file afterwards unless it already had unsaved changes, so ticking a to-do
	 * never saves edits the user made elsewhere.
	 */
	private async edit(model: ITextModel, line: number, text: string, kind: 'replace' | 'insert'): Promise<void> {
		const resource = model.uri;
		const wasDirty = this._textFiles.isDirty(resource);
		let edit: { range: Range; text: string };
		if (kind === 'replace') {
			edit = { range: new Range(line, 1, line, model.getLineMaxColumn(line)), text };
		} else if (line <= 1) {
			edit = { range: new Range(1, 1, 1, 1), text: model.getValueLength() > 0 ? `${text}\n` : text };
		} else {
			// After the end of the line above, so a list keeps no blank line and prose gets one.
			const above = Math.min(line - 1, model.getLineCount());
			const separator = this.document?.todos.length ? '\n' : '\n\n';
			edit = { range: new Range(above, model.getLineMaxColumn(above), above, model.getLineMaxColumn(above)), text: separator + text };
		}
		model.pushStackElement();
		model.pushEditOperations([], [edit], () => null);
		model.pushStackElement();
		if (!wasDirty) {
			try {
				await this._textFiles.save(resource);
			} catch (error) {
				this._notifications.error(redactSecrets(error instanceof Error ? error.message : String(error)));
			}
		}
	}

	private renderLinks(resource: URI): void {
		const links = this._links.links(resource);
		if (links.length === 0) {
			return;
		}
		const section = append(this._column, $('section.claude-plan-section.claude-plan-links'));
		const head = append(section, $('.claude-plan-section-head'));
		append(head, $('h2.label')).textContent = links.length === 1
			? localize('claudePlanOneChat', "Referenced by 1 Chat")
			: localize('claudePlanChats', "Referenced by {0} Chats", links.length);
		const list = append(section, $('ul.claude-plan-link-list'));
		const open = new Map(this._agent.getSessions().map(session => [session.id, session]));
		for (const link of links) {
			const session = open.get(link.sessionId);
			const row = append(append(list, $('li')), $<HTMLButtonElement>('button.claude-plan-link'));
			row.type = 'button';
			append(row, $(ThemeIcon.asCSSSelector(link.role === 'author' ? Codicon.commentDiscussion : Codicon.play)));
			append(row, $('span.title')).textContent = session?.title ?? link.title;
			append(row, $('span.role')).textContent = describeRole(link);
			if (!session) {
				row.disabled = true;
				row.title = localize('claudePlanChatClosed', "This chat is closed.");
				continue;
			}
			row.title = localize('claudePlanOpenChat', "Open this chat");
			this._renderStore.add(addDisposableListener(row, EventType.CLICK, () => {
				this._agent.selectSession(session.id);
				void this._views.openView(CLAUDE_AGENT_VIEW_ID, true);
			}));
		}
	}

	private appendInline(parent: HTMLElement, source: string): void {
		for (const run of inlineMarkdownRuns(source)) {
			if (run.kind === 'code') {
				append(parent, $('code')).textContent = run.text;
			} else if (run.kind === 'strong') {
				append(parent, $('strong')).textContent = run.text;
			} else {
				parent.append(run.text);
			}
		}
	}

	private toggleMenu(): void {
		if (this._menu.isOpen) {
			this._menu.close();
			return;
		}
		const resource = this.input?.resource;
		if (!resource) {
			return;
		}
		// A plan in Klawly's plan folder for this user (the default, issue 322) is not in the
		// Explorer; Save Plan to Workspace moves it into the workspace's `.claude/plans`.
		const inWorkspace = this._workspace.isInsideWorkspace(resource);
		this._menu.show({
			anchor: this._more,
			label: localize('claudePlanMore', "More Plan Actions"),
			className: 'claude-plan-menu',
			position: AnchorPosition.BELOW,
			alignment: AnchorAlignment.RIGHT,
			entries: [
				{
					id: 'text',
					label: localize('claudePlanOpenAsText', "Open as Text"),
					icon: Codicon.goToFile,
					run: () => void this._editors.openEditor({ resource, options: { override: DEFAULT_EDITOR_ASSOCIATION.id, pinned: true } }, this.group),
				},
				inWorkspace ? {
					id: 'reveal',
					label: localize('claudePlanReveal', "Reveal in Explorer"),
					icon: Codicon.folderOpened,
					run: () => void this._commands.executeCommand('revealInExplorer', resource),
				} : {
					id: 'saveToWorkspace',
					label: localize('claudePlanSaveToWorkspace', "Save Plan to Workspace"),
					icon: Codicon.save,
					run: () => void this._commands.executeCommand(CLAUDE_SAVE_PLAN_TO_WORKSPACE_COMMAND_ID, resource),
				},
				{
					id: 'copy',
					label: localize('claudePlanCopyPath', "Copy Path"),
					icon: Codicon.copy,
					run: () => void this._clipboard.writeText(resource.scheme === Schemas.file ? resource.fsPath : resource.toString()),
				},
			],
		});
	}

	/**
	 * Build: saves the file, then sends its open to-dos. Here, the author chat
	 * builds it when it is open and idle, else the current chat when idle, else
	 * a new chat. In the background, a background agent builds it on a worktree.
	 */
	private async build(target: ClaudeBuildTarget): Promise<void> {
		const model = this._model.value?.object;
		const resource = this.input?.resource;
		if (!model || !resource) {
			return;
		}
		try {
			if (this._textFiles.isDirty(resource)) {
				await this._textFiles.save(resource);
			}
			const document = parsePlanDocument(model.textEditorModel.getValue());
			if (!document.todos.some(todo => !todo.done)) {
				this._notifications.info(localize('claudePlanAllDone', "Every to-do in this plan is done."));
				return;
			}
			// Outside the workspace (Klawly's plan folder) Claude gets the full path, never a `~` one it would have to expand.
			const path = this._workspace.isInsideWorkspace(resource) ? this._labels.getUriLabel(resource, { relative: true }) : resource.fsPath;
			const prompt = buildPlanFilePrompt(document, path);
			if (target === 'background') {
				await this._commands.executeCommand(CLAUDE_BACKGROUND_PROMPT_COMMAND_ID, prompt);
				return;
			}
			const cwd = this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.fsPath;
			if (!cwd) {
				throw new Error(localize('claudeNeedsFolder', "Open a local folder before messaging the agent."));
			}
			const session = this.buildSession(resource);
			if (target === 'parallel') {
				// The chat shows the parallel runs above its composer and gets their combined result.
				this._parallel.start(resource, document, path, session.id, cwd);
				this._agent.selectSession(session.id);
				this._links.link(resource, { sessionId: session.id, title: session.title, role: 'build' });
				void this._views.openView(CLAUDE_AGENT_VIEW_ID, false);
				return;
			}
			this._agent.selectSession(session.id);
			this._agent.setMode(session.id, 'agent');
			this._links.link(resource, { sessionId: session.id, title: session.title, role: 'build' });
			void this._views.openView(CLAUDE_AGENT_VIEW_ID, false);
			const envelope = await this._context.resolve(prompt, 'agent', [], session.id);
			await this._agent.submit(session.id, prompt, cwd, {
				compiled: compileSubmission(envelope),
				label: localize('claudeBuildLabel', "Build: {0}", document.title ?? this.input?.getName() ?? ''),
				keepDraft: true,
			});
		} catch (error) {
			this._notifications.error(redactSecrets(error instanceof Error ? error.message : String(error)));
		}
	}

	private buildSession(resource: URI): ClaudeAgentSession {
		const idle = (session: ClaudeAgentSession | undefined) => !!session && this._agent.getViewState(session.id).turns.at(-1)?.status !== 'running';
		const author = this._links.author(resource);
		const authorSession = author && this._agent.getSessions().find(session => session.id === author.sessionId);
		if (idle(authorSession)) {
			return authorSession!;
		}
		const current = this._agent.getCurrentSession();
		if (idle(current)) {
			return current!;
		}
		return this._agent.createSession();
	}
}

function describeRole(link: PlanLink): string {
	return link.role === 'author' ? localize('claudePlanAuthor', "Wrote the plan") : localize('claudePlanBuilder', "Built the plan");
}
