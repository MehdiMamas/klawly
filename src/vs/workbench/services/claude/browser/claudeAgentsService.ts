/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { ClaudeAgents } from '../../../../platform/claude/common/claudeAgents.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claudeRuntime.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IWorkbenchLayoutService, Parts } from '../../layout/browser/layoutService.js';

/** The two layouts of the title bar switch (v5-S25): the editor with the pane on the side, or the agents list and chat. */
export type ClaudeLayout = 'editor' | 'agents';

export const IClaudeAgentsService = createDecorator<IClaudeAgentsService>('claudeAgentsService');
export type IClaudeAgentsService = ClaudeAgentsService;

const LAYOUT_KEY = 'claude.agents.layout';
const SAVED_KEY = 'claude.agents.layout.saved';

/** The part state the Agents layout replaces, kept so the Editor layout restores it. */
interface ISavedParts {
	readonly sideBar: boolean;
	readonly panel: boolean;
	readonly auxiliaryBar: boolean;
	readonly auxiliaryBarWidth: number;
}

/**
 * Every open agent of the window and the layout they are shown in. The Agent pane shows the selected agent; the list,
 * the Needs you view and the title bar read all of them.
 */
export class ClaudeAgentsService extends ClaudeAgents {

	declare readonly _serviceBrand: undefined;

	private _layout: ClaudeLayout;
	private _listVisible: boolean;
	private _needsYouOpen = false;
	private readonly _onDidChangeLayout = this._register(new Emitter<void>());
	readonly onDidChangeLayout: Event<void> = this._onDidChangeLayout.event;

	constructor(
		@IClaudeRuntimeService runtime: IClaudeRuntimeService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storage: IStorageService,
	) {
		super(runtime, () => workspace.getWorkspace().folders[0]?.uri.fsPath);
		this._layout = this.storage.get(LAYOUT_KEY, StorageScope.WORKSPACE) === 'agents' ? 'agents' : 'editor';
		this._listVisible = this._layout === 'agents';
		if (this._layout === 'agents') {
			// the parts are laid out once the workbench is ready; the saved parts stay as they were stored
			this.layoutService.whenRestored.then(() => this.applyAgentsParts());
		}
	}

	get layout(): ClaudeLayout {
		return this._layout;
	}

	/** The list left of the chat; hidden in the Editor layout until Toggle Agents Sidebar shows it. */
	get listVisible(): boolean {
		return this._listVisible;
	}

	/** True while the "Needs you" list replaces the agents list. */
	get needsYouOpen(): boolean {
		return this._needsYouOpen;
	}

	get folderName(): string {
		return this.workspace.getWorkspace().folders[0]?.name ?? '';
	}

	setNeedsYouOpen(open: boolean): void {
		this._needsYouOpen = open;
		this._onDidChangeLayout.fire();
	}

	toggleList(): void {
		this._listVisible = !this._listVisible;
		this._onDidChangeLayout.fire();
	}

	toggleLayout(): void {
		this.setLayout(this._layout === 'agents' ? 'editor' : 'agents');
	}

	/** Agents: side bar and panel hidden, the auxiliary bar about 60% wide. Editor: what was there before comes back. */
	setLayout(layout: ClaudeLayout): void {
		if (layout === this._layout) {
			return;
		}
		if (layout === 'agents') {
			const saved: ISavedParts = {
				sideBar: this.layoutService.isVisible(Parts.SIDEBAR_PART),
				panel: this.layoutService.isVisible(Parts.PANEL_PART),
				auxiliaryBar: this.layoutService.isVisible(Parts.AUXILIARYBAR_PART),
				auxiliaryBarWidth: this.layoutService.getSize(Parts.AUXILIARYBAR_PART).width,
			};
			this.storage.store(SAVED_KEY, JSON.stringify(saved), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			this.applyAgentsParts();
		} else {
			this.restoreParts();
		}
		this._layout = layout;
		this._listVisible = layout === 'agents';
		this.storage.store(LAYOUT_KEY, layout, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._onDidChangeLayout.fire();
	}

	private applyAgentsParts(): void {
		this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
		this.layoutService.setPartHidden(true, Parts.PANEL_PART);
		this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		const size = this.layoutService.getSize(Parts.AUXILIARYBAR_PART);
		this.layoutService.setSize(Parts.AUXILIARYBAR_PART, { width: Math.round(mainWindow.innerWidth * 0.7), height: size.height });
	}

	private restoreParts(): void {
		let saved: ISavedParts | undefined;
		try {
			saved = JSON.parse(this.storage.get(SAVED_KEY, StorageScope.WORKSPACE) ?? '');
		} catch {
			saved = undefined;
		}
		const parts = saved ?? { sideBar: true, panel: false, auxiliaryBar: true, auxiliaryBarWidth: 0 };
		this.layoutService.setPartHidden(!parts.sideBar, Parts.SIDEBAR_PART);
		this.layoutService.setPartHidden(!parts.panel, Parts.PANEL_PART);
		this.layoutService.setPartHidden(!parts.auxiliaryBar, Parts.AUXILIARYBAR_PART);
		if (parts.auxiliaryBarWidth) {
			this.layoutService.setSize(Parts.AUXILIARYBAR_PART, { width: parts.auxiliaryBarWidth, height: this.layoutService.getSize(Parts.AUXILIARYBAR_PART).height });
		}
	}
}

registerSingleton(IClaudeAgentsService, ClaudeAgentsService, InstantiationType.Delayed);
