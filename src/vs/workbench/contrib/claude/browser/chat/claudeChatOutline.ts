/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IconLabel, IIconLabelValueOptions } from '../../../../../base/browser/ui/iconLabel/iconLabel.js';
import { IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../../base/browser/ui/list/listWidget.js';
import { IDataSource, ITreeNode, ITreeRenderer } from '../../../../../base/browser/ui/tree/tree.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { createMatches, FuzzyScore } from '../../../../../base/common/filters.js';
import { escapeIcons } from '../../../../../base/common/iconLabels.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IWorkbenchDataTreeOptions } from '../../../../../platform/list/browser/listService.js';
import { IEditorPane } from '../../../../common/editor.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IBreadcrumbsDataSource, IBreadcrumbsOutlineElement, IOutline, IOutlineComparator, IOutlineCreator, IOutlineListConfig, IOutlineService, IQuickPickDataSource, IQuickPickOutlineElement, OutlineChangeEvent, OutlineTarget } from '../../../../services/outline/browser/outline.js';
import { claudeChatOutline, ClaudeChatOutlineKind, ClaudeChatOutlineNode, flattenClaudeChatOutline } from '../../common/claudeChatOutline.js';
import { ClaudeAgentEditor } from './claudeAgentEditor.js';

/** The icon of an outline entry, shared by the Outline view, breadcrumbs and Go to Turn (issue 433). */
export function claudeChatOutlineIcon(kind: ClaudeChatOutlineKind): ThemeIcon {
	switch (kind) {
		case 'prompt': return Codicon.commentDiscussion;
		case 'plan': return Codicon.checklist;
		case 'todos': return Codicon.tasklist;
		case 'edit': return Codicon.edit;
		case 'subagent': return Codicon.hubot;
	}
}

/** What the outline needs from the chat it outlines: scroll to a turn or a card in it. */
export interface IClaudeChatOutlineTarget {
	revealTurn(turnId: string, targetId?: string): boolean;
}

/** What the outline needs from the agent service: the current chat and its view state. */
export type ClaudeChatOutlineAgent = Pick<IClaudeAgentService, 'getCurrentSession' | 'getViewState' | 'onDidChangeSession' | 'onDidChangeViewState'>;

class ClaudeChatOutlineDelegate implements IListVirtualDelegate<ClaudeChatOutlineNode> {
	getHeight(): number {
		return 22;
	}
	getTemplateId(): string {
		return ClaudeChatOutlineRenderer.templateId;
	}
}

interface IClaudeChatOutlineTemplate {
	readonly iconClass: HTMLElement;
	readonly iconLabel: IconLabel;
}

class ClaudeChatOutlineRenderer implements ITreeRenderer<ClaudeChatOutlineNode, FuzzyScore, IClaudeChatOutlineTemplate> {

	static readonly templateId = 'ClaudeChatOutlineRenderer';
	readonly templateId = ClaudeChatOutlineRenderer.templateId;

	renderTemplate(container: HTMLElement): IClaudeChatOutlineTemplate {
		container.classList.add('claude-chat-outline-element');
		const iconClass = document.createElement('div');
		container.append(iconClass);
		const iconLabel = new IconLabel(container, { supportHighlights: true });
		return { iconClass, iconLabel };
	}

	renderElement(node: ITreeNode<ClaudeChatOutlineNode, FuzzyScore>, _index: number, template: IClaudeChatOutlineTemplate): void {
		const options: IIconLabelValueOptions = {
			matches: createMatches(node.filterData),
			labelEscapeNewLines: true,
		};
		template.iconClass.className = 'element-icon ' + ThemeIcon.asClassNameArray(claudeChatOutlineIcon(node.element.kind)).join(' ');
		template.iconLabel.setLabel(node.element.label, node.element.description, options);
	}

	disposeTemplate(template: IClaudeChatOutlineTemplate): void {
		template.iconLabel.dispose();
	}
}

class ClaudeChatOutlineAccessibility implements IListAccessibilityProvider<ClaudeChatOutlineNode> {
	getAriaLabel(element: ClaudeChatOutlineNode): string {
		return element.description ? localize('claudeOutlineAria', "{0}, {1}", element.label, element.description) : element.label;
	}
	getWidgetAriaLabel(): string {
		return localize('claudeOutline', "Chat Outline");
	}
}

class ClaudeChatOutlineComparator implements IOutlineComparator<ClaudeChatOutlineNode> {
	compareByPosition(a: ClaudeChatOutlineNode, b: ClaudeChatOutlineNode): number {
		return a.order - b.order;
	}
	compareByType(a: ClaudeChatOutlineNode, b: ClaudeChatOutlineNode): number {
		return a.kind.localeCompare(b.kind) || a.order - b.order;
	}
	compareByName(a: ClaudeChatOutlineNode, b: ClaudeChatOutlineNode): number {
		return a.label.localeCompare(b.label);
	}
}

class ClaudeChatOutlineTreeDataSource implements IDataSource<ClaudeChatOutline, ClaudeChatOutlineNode> {
	getChildren(element: ClaudeChatOutline | ClaudeChatOutlineNode): Iterable<ClaudeChatOutlineNode> {
		return element instanceof ClaudeChatOutline ? element.nodes : element.children;
	}
}

class ClaudeChatOutlineQuickPickDataSource implements IQuickPickDataSource<ClaudeChatOutlineNode> {
	constructor(private readonly _outline: ClaudeChatOutline) { }
	getQuickPickElements(): IQuickPickOutlineElement<ClaudeChatOutlineNode>[] {
		// Codicons go inline in the label; the chat's own text is escaped so `$(...)` in it stays literal.
		return flattenClaudeChatOutline(this._outline.nodes).map(({ node }) => ({
			element: node,
			label: `$(${claudeChatOutlineIcon(node.kind).id}) ${escapeIcons(node.label)}`,
			description: node.description,
			ariaLabel: node.label,
		}));
	}
}

class ClaudeChatOutlineBreadcrumbsDataSource implements IBreadcrumbsDataSource<ClaudeChatOutlineNode> {
	getBreadcrumbElements(): readonly IBreadcrumbsOutlineElement<ClaudeChatOutlineNode>[] {
		return [];
	}
}

/**
 * The outline of the chat shown in the Agent editor (issue 433): its prompts,
 * with each turn's plan, to-do updates, edited files and subagents under them.
 * It feeds the Outline view and Go to Symbol in Editor; picking an entry
 * scrolls the chat to it.
 */
export class ClaudeChatOutline implements IOutline<ClaudeChatOutlineNode> {

	readonly outlineKind = 'claudeChat';

	private readonly _disposables = new DisposableStore();
	private readonly _onDidChange = this._disposables.add(new Emitter<OutlineChangeEvent>());
	readonly onDidChange: Event<OutlineChangeEvent> = this._onDidChange.event;

	private _nodes: ClaudeChatOutlineNode[] = [];
	private _signature = '';
	readonly config: IOutlineListConfig<ClaudeChatOutlineNode>;

	constructor(
		private readonly _chat: IClaudeChatOutlineTarget,
		target: OutlineTarget,
		private readonly _agent: ClaudeChatOutlineAgent,
	) {
		this._recompute();
		const refresh = () => {
			if (this._recompute()) {
				this._onDidChange.fire({});
			}
		};
		this._disposables.add(this._agent.onDidChangeSession(refresh));
		// The view state changes on every streamed chunk; the outline only changes when an entry does.
		this._disposables.add(this._agent.onDidChangeViewState(({ sessionId }) => {
			if (sessionId === this._agent.getCurrentSession()?.id) {
				refresh();
			}
		}));

		const options: IWorkbenchDataTreeOptions<ClaudeChatOutlineNode, FuzzyScore> = {
			collapseByDefault: target === OutlineTarget.Breadcrumbs,
			expandOnlyOnTwistieClick: true,
			multipleSelectionSupport: false,
			accessibilityProvider: new ClaudeChatOutlineAccessibility(),
			identityProvider: { getId: element => element.id },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: element => element.label },
		};
		this.config = {
			treeDataSource: new ClaudeChatOutlineTreeDataSource(),
			quickPickDataSource: new ClaudeChatOutlineQuickPickDataSource(this),
			breadcrumbsDataSource: new ClaudeChatOutlineBreadcrumbsDataSource(),
			delegate: new ClaudeChatOutlineDelegate(),
			renderers: [new ClaudeChatOutlineRenderer()],
			comparator: new ClaudeChatOutlineComparator(),
			options,
		};
	}

	private _recompute(): boolean {
		const session = this._agent.getCurrentSession();
		const nodes = session ? claudeChatOutline(this._agent.getViewState(session.id)) : [];
		const signature = flattenClaudeChatOutline(nodes).map(({ node, depth }) => `${depth}\u0000${node.id}\u0000${node.label}\u0000${node.description ?? ''}`).join('\u0001');
		if (signature === this._signature) {
			return false;
		}
		this._nodes = nodes;
		this._signature = signature;
		return true;
	}

	get nodes(): readonly ClaudeChatOutlineNode[] {
		return this._nodes;
	}

	get uri(): URI | undefined {
		return undefined;
	}

	get isEmpty(): boolean {
		return this._nodes.length === 0;
	}

	get activeElement(): ClaudeChatOutlineNode | undefined {
		return undefined;
	}

	reveal(node: ClaudeChatOutlineNode, _options: IEditorOptions, _sideBySide: boolean, _select: boolean): void {
		this._chat.revealTurn(node.turnId, node.targetId);
	}

	preview(node: ClaudeChatOutlineNode): IDisposable {
		this._chat.revealTurn(node.turnId, node.targetId);
		return Disposable.None;
	}

	captureViewState(): IDisposable {
		return Disposable.None;
	}

	dispose(): void {
		this._disposables.dispose();
	}
}

/**
 * Registers {@link ClaudeChatOutline} for the Agent editor so the Outline view,
 * breadcrumbs and Go to Symbol in Editor work for a chat opened as an editor.
 * The Outline view follows the active editor only; the Agent view in the side
 * bar gets the same entries through Go to Turn.
 */
export class ClaudeChatOutlineCreator implements IOutlineCreator<ClaudeAgentEditor, ClaudeChatOutlineNode> {

	static readonly ID = 'workbench.contrib.claudeChatOutlineCreator';

	readonly dispose: () => void;

	constructor(
		@IOutlineService outlineService: IOutlineService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
	) {
		const registration = outlineService.registerOutlineCreator(this);
		this.dispose = () => registration.dispose();
	}

	matches(candidate: IEditorPane): candidate is ClaudeAgentEditor {
		return candidate instanceof ClaudeAgentEditor;
	}

	async createOutline(editor: ClaudeAgentEditor, target: OutlineTarget, _token: CancellationToken): Promise<IOutline<ClaudeChatOutlineNode> | undefined> {
		const widget = editor.widget;
		return widget ? new ClaudeChatOutline(widget, target, this._agent) : undefined;
	}
}
