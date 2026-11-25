/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { AgentMode } from '../../../../../platform/claude/common/claudeContext.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudePermissionService } from '../../../../services/claude/common/claudePermissionService.js';
import { IClaudeReviewService } from '../../../../services/claude/common/claudeReview.js';
import { claudeAutoKeepExplanation } from '../../common/claudeKeepAll.js';
import { CLAUDE_OPEN_SETTINGS_COMMAND_ID } from '../../common/claudeViews.js';
import { IClaudeMakerService } from '../claudeMakerService.js';
import { ClaudeModeMenuModel } from './claudeModeMenu.js';
import '../media/claudePermissions.css';

/**
 * The badges next to the mode pill that show Allow All Commands and Allow
 * Everything for the current session (Phase 27). One click turns Allow All
 * Commands off. Allow Everything comes from the permission level in Settings
 * (issue 453), so its badge opens Settings instead. It uses the warning colour
 * and a warning icon, so it does not rely on colour alone. An Auto-Keep pill
 * shows when the chat keeps Claude's edits as they land; one click turns it off
 * for the chat (issue 706).
 */
export class ClaudeSessionSwitchBadges extends Disposable {
	private readonly _badges = this._register(new DisposableStore());

	constructor(
		private readonly _container: HTMLElement,
		private readonly _report: (error: unknown) => void,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudePermissionService private readonly _permissions: IClaudePermissionService,
		@IWorkspaceTrustManagementService private readonly _trust: IWorkspaceTrustManagementService,
		@IHoverService private readonly _hover: IHoverService,
		@ICommandService private readonly _commands: ICommandService,
		@IClaudeReviewService private readonly _review: IClaudeReviewService,
		@IClaudeMakerService private readonly _maker: IClaudeMakerService,
	) {
		super();
		this._container.setAttribute('role', 'group');
		this._container.setAttribute('aria-label', localize('claudeSessionSwitches', "Session approvals"));
		this._register(this._agent.onDidChangeSession(() => this.render()));
		this._register(this._review.onDidChangeAutoKeep(() => this.render()));
		this._register(this._trust.onDidChangeTrust(() => this.render()));
		this._register(this._maker.onDidChange(() => this.render()));
		this.render();
	}

	/** The mode menu's model for the current session. */
	modeMenuModel(sessionId: string, mode: AgentMode, selectMode: (mode: AgentMode) => void): ClaudeModeMenuModel {
		return {
			mode,
			level: this._permissions.getPermissionLevel(),
			trusted: this._trust.isWorkspaceTrusted(),
			unaskedBlocked: this._agent.isUnaskedBlocked?.() === true,
			selectMode,
			openPermissionSettings: () => this.openPermissionSettings(),
		};
	}

	private openPermissionSettings(): void {
		this._commands.executeCommand(CLAUDE_OPEN_SETTINGS_COMMAND_ID, 'agents').catch(this._report);
	}

	private render(): void {
		this._badges.clear();
		clearNode(this._container);
		const session = this._agent.getCurrentSession();
		const permissions = session ? this._permissions.getSessionPermissions(session.id) : undefined;
		const autoKeep = !!session && this._review.isAutoKeep(session.id);
		const maker = this._maker.role === 'maker';
		this._container.hidden = !maker && (!session || !permissions || (!permissions.allowAllCommands && !permissions.allowEverything && !autoKeep));
		if (maker) {
			this.makerBadge();
		}
		if (!session || !permissions) {
			return;
		}
		if (autoKeep) {
			this.badge('.is-auto-keep', Codicon.checkAll,
				localize('claudeAutoKeepBadge', "Auto-Keep"),
				localize('claudeAutoKeepBadgeLabel', "Auto-Keep is on for this chat: Claude's edits are kept as they land. Click to turn it off."),
				localize('claudeAutoKeepBadgeHover', "{0} Click to turn it off for this chat.", claudeAutoKeepExplanation()),
				async () => this._review.setAutoKeep(session.id, false));
		}
		if (permissions.allowEverything) {
			const credentials = permissions.allowCredentials === true;
			// Issue 694: the full level is Claude Code's bypass permissions mode, so it says so in the error tone (DL-85).
			const bypass = permissions.unasked === true;
			this.badge(bypass ? '.is-everything.is-bypass' : '.is-everything', Codicon.warning,
				bypass ? localize('claudeAllowEverythingBypassBadge', "Allow Everything · Bypass") : credentials ? localize('claudeAllowEverythingBadge', "Allow Everything") : localize('claudeAllowEverythingExceptBadge', "Allow Everything Except Credentials"),
				bypass
					? localize('claudeAllowEverythingBypassBadgeLabel', "Allow Everything: in Agent mode Claude Code runs in bypass permissions mode, so every tool call runs without asking, credential files included. Click to change the permission level in Settings.")
					: credentials
						? localize('claudeAllowEverythingBadgeLabel', "Allow Everything: every tool call runs without asking, credential files included. Click to change the permission level in Settings.")
						: localize('claudeAllowEverythingExceptBadgeLabel', "Allow Everything Except Credentials: every tool call runs without asking, but credential files still ask. Click to change the permission level in Settings."),
				bypass
					? localize('claudeAllowEverythingBypassBadgeHover', "In Agent mode Claude Code runs in bypass permissions mode: every tool call in every chat runs without asking or checking, credential files included. Ask and Plan keep their limits. Click to change the permission level in Settings.")
					: credentials
						? localize('claudeAllowEverythingBadgeHover', "Every tool call in every chat runs without asking, credential files included. Click to change the permission level in Settings.")
						: localize('claudeAllowEverythingExceptBadgeHover', "Every tool call in every chat runs without asking. Credential files still ask. Click to change the permission level in Settings."),
				async () => this.openPermissionSettings(), false);
		} else if (permissions.allowAllCommands) {
			this.badge('.is-commands', Codicon.terminal,
				localize('claudeAllCommandsBadge', "All commands allowed"),
				localize('claudeAllCommandsBadgeLabel', "All commands are allowed for this session. Click to turn it off."),
				localize('claudeAllCommandsBadgeHover', "Commands in this session run without asking. Destructive commands still ask unless Allow Everything is on. Click to turn it off."),
				() => this._permissions.setAllowAllCommands(session.id, false));
		}
	}

	/** DL-120: the maker's badge; one click switches between Maker mode and the normal-user preview. */
	private makerBadge(): void {
		const preview = this._maker.previewAsUser;
		this.badge(preview ? '.is-maker.is-preview' : '.is-maker', preview ? Codicon.eye : Codicon.tools,
			preview ? localize('claudeMakerPreviewBadge', "Previewing as user") : localize('claudeMakerBadge', "Maker"),
			preview
				? localize('claudeMakerPreviewBadgeLabel', "Maker mode is paused: Klawly behaves as it does for a normal user. Click to turn Maker mode back on.")
				: localize('claudeMakerBadgeLabel', "Maker mode is on. Click to preview Klawly as a normal user."),
			preview
				? localize('claudeMakerPreviewBadgeHover', "You are previewing Klawly as a normal user would see it. Click to turn Maker mode back on.")
				: localize('claudeMakerBadgeHover', "You are signed in as a maker of Klawly, so Claude knows how to work on Klawly itself. Click to preview Klawly as a normal user."),
			async () => this._maker.setPreviewAsUser(!preview), false);
	}

	private badge(className: string, icon: ThemeIcon, label: string, ariaLabel: string, hover: string, turnOff: () => Promise<unknown>, closable = true): void {
		const badge = append(this._container, $<HTMLButtonElement>('button.claude-session-switch' + className));
		badge.type = 'button';
		badge.setAttribute('aria-label', ariaLabel);
		append(badge, $(ThemeIcon.asCSSSelector(icon)));
		append(badge, $('span.label')).textContent = label;
		if (closable) {
			append(badge, $(ThemeIcon.asCSSSelector(Codicon.close)));
		}
		this._badges.add(this._hover.setupDelayedHover(badge, { content: hover }));
		this._badges.add(addDisposableListener(badge, EventType.CLICK, () => {
			turnOff().catch(this._report);
		}));
	}
}
