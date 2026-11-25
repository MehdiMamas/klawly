/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/claude.css';
import './media/claudeSplit.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { addSplitGroup, initialSplitPlan, moveSplitFile, moveSplitHunk, parseSplitDiff, removeSplitGroup, renameSplitBranch, renameSplitGroup, SplitHunk, SplitPlan, splitGroupHunks, splitPlanProblems, SplitPlanProblem } from '../../../../platform/claude/common/claudeSplitPlan.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

const HUNK_MIME = 'application/x-klawly-split-hunk';
const FILE_MIME = 'application/x-klawly-split-file';

/**
 * The group editor for Split into Pull Requests (issue 970, DL-106). It holds
 * the uncommitted diff cut into groups; the plan lives here, so the tab keeps
 * the user's edits while it is open.
 */
export class ClaudeSplitInput extends EditorInput {

	static readonly ID = 'workbench.input.claudeSplit';

	private _plan: SplitPlan;

	constructor(patch: string, private readonly _continue: (plan: SplitPlan) => Promise<void>, private readonly _create?: (plan: SplitPlan, stacked: boolean) => Promise<void>) {
		super();
		this._plan = initialSplitPlan(parseSplitDiff(patch));
	}

	override get typeId(): string {
		return ClaudeSplitInput.ID;
	}

	override get editorId(): string | undefined {
		return ClaudeSplitEditor.ID;
	}

	override get resource(): URI {
		return URI.from({ scheme: 'klawly-split', path: '/plan' });
	}

	get plan(): SplitPlan {
		return this._plan;
	}

	set plan(plan: SplitPlan) {
		this._plan = plan;
	}

	continueWithClaude(): Promise<void> {
		return this._continue(this._plan);
	}

	/** Issue 971: Klawly makes the branches and worktrees itself; absent when the repository is not local. */
	get canCreateBranches(): boolean {
		return !!this._create;
	}

	/** Stacked branches start from each other instead of from HEAD (issue 972). */
	stacked = false;

	createBranches(): Promise<void> {
		return this._create ? this._create(this._plan, this.stacked) : Promise.resolve();
	}

	override getName(): string {
		return localize('claudeSplitName', "Split into Pull Requests");
	}

	override getTitle(): string {
		return this.getName();
	}

	override getIcon(): ThemeIcon {
		return Codicon.gitPullRequestCreate;
	}

	override matches(other: EditorInput | unknown): boolean {
		return other === this;
	}
}

/** Opens the group editor, or shows the tab that is open already. */
export async function openClaudeSplit(editors: IEditorService, patch: string, onContinue: (plan: SplitPlan) => Promise<void>, onCreate?: (plan: SplitPlan, stacked: boolean) => Promise<void>): Promise<void> {
	await editors.openEditor(new ClaudeSplitInput(patch, onContinue, onCreate), { pinned: true });
}

export class ClaudeSplitEditor extends EditorPane {

	static readonly ID = 'workbench.editor.claudeSplit';

	private _root!: HTMLElement;
	private _board!: HTMLElement;
	private _problems!: HTMLElement;
	private _continue!: HTMLButtonElement;
	private _create!: HTMLButtonElement;
	private _stack!: HTMLElement;
	private _stackBox!: HTMLInputElement;
	private _split: ClaudeSplitInput | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(ClaudeSplitEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._root = append(parent, $('.claude-split'));
		const header = append(this._root, $('.claude-split-header'));
		append(header, $('h2.claude-split-title')).textContent = localize('claudeSplitHeading', "Split into Pull Requests");
		append(header, $('p.claude-split-hint')).textContent = localize('claudeSplitHint', "Drag a change into the group it belongs to. Each group becomes one branch and one draft pull request. Nothing is created until you continue.");
		this._board = append(this._root, $('.claude-split-board'));
		const footer = append(this._root, $('.claude-split-footer'));
		this._problems = append(footer, $('.claude-split-problems'));
		this._problems.setAttribute('role', 'status');
		this._problems.setAttribute('aria-live', 'polite');
		const add = append(footer, $('button.claude-split-button')) as HTMLButtonElement;
		add.textContent = localize('claudeSplitAddGroup', "Add Group");
		this._register(addDisposableListener(add, EventType.CLICK, () => this.update(addSplitGroup(this.plan))));
		this._continue = append(footer, $('button.claude-split-button.primary')) as HTMLButtonElement;
		this._continue.textContent = localize('claudeSplitContinue', "Continue with Claude");
		this._register(addDisposableListener(this._continue, EventType.CLICK, () => void this._split?.continueWithClaude()));
		// DL-65, DL-106: when Klawly can make the branches itself (issue 971) that is the primary action; it asks first and pushes nothing.
		// DL-108: stacking is a choice made next to the button it changes.
		this._stack = append(footer, $('label.claude-split-stack'));
		this._stackBox = append(this._stack, $('input')) as HTMLInputElement;
		this._stackBox.type = 'checkbox';
		append(this._stack, $('span')).textContent = localize('claudeSplitStack', "Stack the branches");
		this._stack.title = localize('claudeSplitStackHint', "Each branch starts from the one before it, so each pull request shows only its own group.");
		this._register(addDisposableListener(this._stackBox, EventType.CHANGE, () => { if (this._split) { this._split.stacked = this._stackBox.checked; } }));
		this._create = append(footer, $('button.claude-split-button.primary')) as HTMLButtonElement;
		this._create.textContent = localize('claudeSplitCreate', "Create Branches");
		this._create.title = localize('claudeSplitCreateTitle', "Make one branch and worktree per group under .worktrees and commit its changes there. Nothing is pushed.");
		this._register(addDisposableListener(this._create, EventType.CLICK, () => void this._split?.createBranches()));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (input instanceof ClaudeSplitInput) {
			this._split = input;
			this._stackBox.checked = input.stacked;
			this.render();
		}
	}

	override clearInput(): void {
		super.clearInput();
		this._split = undefined;
		clearNode(this._board);
	}

	override layout(_dimension: Dimension): void { }

	override focus(): void {
		super.focus();
		this._continue?.focus();
	}

	private get plan(): SplitPlan {
		return this._split!.plan;
	}

	private update(plan: SplitPlan): void {
		if (this._split) {
			this._split.plan = plan;
			this.render();
		}
	}

	private render(): void {
		if (!this._split) {
			return;
		}
		const plan = this.plan;
		clearNode(this._board);
		for (const group of plan.groups) {
			const column = append(this._board, $('.claude-split-group'));
			column.setAttribute('role', 'group');
			const title = append(column, $('input.claude-split-title-input')) as HTMLInputElement;
			title.value = group.title;
			title.setAttribute('aria-label', localize('claudeSplitGroupTitle', "Pull request title"));
			this._register(addDisposableListener(title, EventType.CHANGE, () => this.update(renameSplitGroup(this.plan, group.id, title.value))));
			const branch = append(column, $('input.claude-split-branch-input')) as HTMLInputElement;
			branch.value = group.branch;
			branch.setAttribute('aria-label', localize('claudeSplitGroupBranch', "Branch name"));
			this._register(addDisposableListener(branch, EventType.CHANGE, () => this.update(renameSplitBranch(this.plan, group.id, branch.value))));
			const remove = append(column, $('button.claude-split-remove')) as HTMLButtonElement;
			remove.textContent = localize('claudeSplitRemoveGroup', "Remove Group");
			remove.disabled = plan.groups.length <= 1;
			this._register(addDisposableListener(remove, EventType.CLICK, () => this.update(removeSplitGroup(this.plan, group.id))));
			const list = append(column, $('.claude-split-hunks'));
			this.dropTarget(list, group.id);
			for (const hunk of splitGroupHunks(plan, group)) {
				this.renderHunk(list, hunk);
			}
			if (group.hunkIds.length === 0) {
				append(list, $('.claude-split-empty')).textContent = localize('claudeSplitEmpty', "Drop changes here");
			}
		}
		this.renderProblems(splitPlanProblems(plan));
	}

	private renderHunk(list: HTMLElement, hunk: SplitHunk): void {
		const card = append(list, $('.claude-split-hunk'));
		card.draggable = true;
		card.tabIndex = 0;
		const label = hunk.header ? `${hunk.file} ${hunk.header.replace(/@@(.*)$/, '@@').trim()}` : hunk.file;
		append(card, $('.claude-split-hunk-file')).textContent = hunk.file;
		append(card, $('.claude-split-hunk-range')).textContent = hunk.header ? hunk.header.replace(/ @@.*$/, ' @@') : localize('claudeSplitWholeFile', "Whole file");
		append(card, $('.claude-split-hunk-count')).textContent = localize('claudeSplitCount', "+{0} -{1}", hunk.added, hunk.removed);
		card.setAttribute('aria-label', localize('claudeSplitHunkLabel', "{0}: +{1} -{2}", label, hunk.added, hunk.removed));
		this._register(addDisposableListener(card, EventType.DRAG_START, event => {
			event.dataTransfer?.setData(event.shiftKey ? FILE_MIME : HUNK_MIME, event.shiftKey ? hunk.file : hunk.id);
			card.classList.add('dragging');
		}));
		this._register(addDisposableListener(card, EventType.DRAG_END, () => card.classList.remove('dragging')));
		// Keyboard: Alt+Left and Alt+Right move the change to the group before or after (DL-101).
		this._register(addDisposableListener(card, EventType.KEY_DOWN, event => {
			if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) {
				return;
			}
			const groups = this.plan.groups;
			const at = groups.findIndex(group => group.hunkIds.includes(hunk.id));
			const target = groups[at + (event.key === 'ArrowLeft' ? -1 : 1)];
			if (target) {
				event.preventDefault();
				this.update(moveSplitHunk(this.plan, hunk.id, target.id));
			}
		}));
	}

	private dropTarget(list: HTMLElement, groupId: string): void {
		this._register(addDisposableListener(list, EventType.DRAG_OVER, event => {
			event.preventDefault();
			list.classList.add('drop');
		}));
		this._register(addDisposableListener(list, EventType.DRAG_LEAVE, () => list.classList.remove('drop')));
		this._register(addDisposableListener(list, EventType.DROP, event => {
			event.preventDefault();
			list.classList.remove('drop');
			const hunkId = event.dataTransfer?.getData(HUNK_MIME);
			const file = event.dataTransfer?.getData(FILE_MIME);
			if (hunkId) {
				this.update(moveSplitHunk(this.plan, hunkId, groupId));
			} else if (file) {
				this.update(moveSplitFile(this.plan, file, groupId));
			}
		}));
	}

	private renderProblems(problems: readonly SplitPlanProblem[]): void {
		const titleOf = (groupId: string) => this.plan.groups.find(group => group.id === groupId)?.title ?? groupId;
		const lines = problems.map(problem => {
			switch (problem.kind) {
				case 'empty-group': return localize('claudeSplitProblemEmpty', "\"{0}\" has no changes. Drop some in or remove the group.", titleOf(problem.groupId));
				case 'bad-branch': return problem.reason === 'empty'
					? localize('claudeSplitProblemBranchEmpty', "\"{0}\" needs a branch name.", titleOf(problem.groupId))
					: localize('claudeSplitProblemBranchInvalid', "\"{0}\" has a branch name git cannot use.", titleOf(problem.groupId));
				case 'duplicate-branch': return localize('claudeSplitProblemDuplicate', "\"{0}\" shares its branch name with another group.", titleOf(problem.groupId));
				case 'branch-exists': return localize('claudeSplitProblemExists', "The branch of \"{0}\" already exists.", titleOf(problem.groupId));
				case 'unassigned': return localize('claudeSplitProblemUnassigned', "A change is in no group.");
				case 'no-groups': return localize('claudeSplitProblemNoGroups', "Add a group first.");
			}
		});
		this._problems.textContent = lines.join(' ');
		this._continue.disabled = problems.length > 0;
		this._create.disabled = problems.length > 0;
		const create = !!this._split?.canCreateBranches;
		this._create.style.display = create ? '' : 'none';
		this._stack.style.display = create ? '' : 'none';
		this._continue.classList.toggle('primary', !create);
	}
}
