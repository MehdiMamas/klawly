/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ClaudePermissionPreset } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { isAllowEverythingLevel } from '../../../../../platform/claude/common/claudeSessionPermissions.js';
import { AgentMode } from '../../../../../platform/claude/common/claudeContext.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { claudePermissionLevel } from '../../common/claudePermissionLevels.js';
import { ClaudePopoverEntry, ClaudePopoverMenu } from '../widgets/claudePopoverMenu.js';
import { claudeShiftTabGlyphLabel } from './claudeKbd.js';
import { claudeModes } from './claudeModes.js';
import '../media/claudePermissions.css';

/** What the mode menu shows and what its rows do. */
export interface ClaudeModeMenuModel {
	readonly mode: AgentMode;
	/** `claude.agent.defaultPermissionMode`: the permission level of every session (issue 453). */
	readonly level: ClaudePermissionPreset;
	/** False in an untrusted workspace, where the Allow Everything levels are held back. */
	readonly trusted: boolean;
	/** True when the organization turned off Claude Code's bypass permissions mode, so Allow Everything asks (issue 694). */
	readonly unaskedBlocked?: boolean;
	selectMode(mode: AgentMode): void;
	/** Opens Settings at the permission level. */
	openPermissionSettings(): void;
}

/**
 * The composer's mode menu (Phases 27 and 33): Agent, Plan and Ask, each with
 * one line on what it may do; then the permission level every session runs at,
 * with a link to change it in Settings (issue 453). Arrow keys move, Enter or
 * Space picks, Escape closes and focus goes back to the pill.
 *
 * The levels are Klawly's own permission settings. Claude Code runs in its
 * default permission mode and asks Klawly before each tool call, except at
 * Allow Everything in Agent mode, which is Claude Code's bypass permissions
 * mode (issue 694): that row says so and wears the error tone (DL-85).
 */
export class ClaudeModeMenu extends Disposable {
	private readonly _menu: ClaudePopoverMenu;

	constructor(
		@IContextViewService contextView: IContextViewService,
		@IHoverService hoverService: IHoverService,
	) {
		super();
		this._menu = this._register(new ClaudePopoverMenu(contextView, hoverService));
	}

	get isOpen(): boolean {
		return this._menu.isOpen;
	}

	show(anchor: HTMLElement, model: ClaudeModeMenuModel): void {
		const entries: ClaudePopoverEntry[] = claudeModes().map(descriptor => ({
			id: descriptor.mode,
			label: descriptor.label,
			description: descriptor.description,
			icon: descriptor.icon,
			role: 'menuitemradio',
			checked: descriptor.mode === model.mode,
			dataset: { mode: descriptor.mode },
			run: () => model.selectMode(descriptor.mode),
		}));
		entries.push({ kind: 'separator' });
		entries.push({ kind: 'header', label: localize('claudeModeMenuPermissions', "Permissions in Every Session") });
		const level = claudePermissionLevel(model.level);
		const heldBack = isAllowEverythingLevel(model.level) && !model.trusted;
		const blocked = model.level === 'allowEverything' && model.trusted && model.unaskedBlocked === true;
		const bypass = model.level === 'allowEverything' && model.trusted && !blocked;
		entries.push({
			id: 'permission-level',
			label: bypass ? localize('claudeModeMenuLevelBypass', "{0} · Bypass", level.label) : level.label,
			description: heldBack
				? localize('claudeModeMenuLevelUntrusted', "Asks before edits until you trust this workspace")
				: blocked
					? localize('claudeModeMenuLevelBlocked', "Your organization turned off bypass permissions, so this asks before edits")
					: bypass && model.mode !== 'agent'
						? localize('claudeModeMenuLevelBypassAgentOnly', "Bypass runs in Agent only; this mode keeps its limits")
						: level.description,
			detail: localize('claudeModeMenuChangeInSettings', "Change in Settings"),
			icon: level.icon,
			// DL-09: Accept Edits and auto wear the purple mode role, as in Claude Code. DL-85: bypass wears the error tone.
			className: bypass ? 'is-everything is-bypass' : isAllowEverythingLevel(model.level) ? 'is-everything' : model.level === 'acceptEdits' ? 'is-accept-edits' : undefined,
			dataset: { level: model.level },
			run: () => model.openPermissionSettings(),
		});
		this.showMenu(anchor, entries, model);
	}

	private showMenu(anchor: HTMLElement, entries: ClaudePopoverEntry[], model: ClaudeModeMenuModel): void {
		this._menu.show({
			anchor,
			entries,
			label: localize('claudeModeMenu', "Mode"),
			className: 'claude-mode-menu',
			position: AnchorPosition.ABOVE,
			activeId: model.mode,
			footer: { label: localize('claudeModeMenuCycle', "Switch modes"), keybinding: claudeShiftTabGlyphLabel() },
		});
	}

	close(): void {
		this._menu.close();
	}
}
