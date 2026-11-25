/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { CLAUDE_BACKGROUND_PROMPT_COMMAND_ID } from '../../../../services/claude/common/claudeBackgroundAgent.js';
import { appendClaudeKbd } from '../chat/claudeKbd.js';
import { ClaudePopoverItem, ClaudePopoverMenu } from '../widgets/claudePopoverMenu.js';

/**
 * Where Build runs a plan: in this window's agent, in a background agent on
 * its own Git worktree, or (plan files, issue 495) one background agent per
 * to-do that does not wait on another.
 */
export type ClaudeBuildTarget = 'here' | 'background' | 'parallel';

const BUILD_TARGET_KEY = 'klawly.plan.buildTarget';

export interface ClaudeBuildButtonOptions {
	/** Runs the build. The button stays disabled until the promise settles. */
	readonly run: (target: ClaudeBuildTarget) => Promise<void>;
	/** The key chip on the main button, such as "Ctrl+Enter". */
	readonly keybinding?: string;
	/** Keep the key in the tooltip and the menu but draw no chip, where the header is too tight for one. */
	readonly hideKeybinding?: boolean;
	/** List Build in Parallel too, for a plan file whose to-dos can run as separate agents (issue 495). */
	readonly parallel?: boolean;
}

/** Whether background agents are available in this window. */
export function claudeCanBuildInBackground(): boolean {
	return !!CommandsRegistry.getCommand(CLAUDE_BACKGROUND_PROMPT_COMMAND_ID);
}

/**
 * Build as a split button: the main part runs the default target, the chevron
 * lists Build Here and Build in Background Worktree. Picking a row runs it and
 * makes it the default, for every plan in every window.
 */
export class ClaudeBuildButton extends Disposable {
	readonly element: HTMLElement;
	readonly main: HTMLButtonElement;
	readonly more: HTMLButtonElement | undefined;
	private readonly _label: HTMLElement;
	private readonly _menu: ClaudePopoverMenu;
	private _busy = false;
	private _enabled = true;

	constructor(
		parent: HTMLElement,
		private readonly _options: ClaudeBuildButtonOptions,
		@IContextViewService contextView: IContextViewService,
		@IHoverService hoverService: IHoverService,
		@IStorageService private readonly _storage: IStorageService,
	) {
		super();
		this._menu = this._register(new ClaudePopoverMenu(contextView, hoverService));
		this.element = append(parent, $('.claude-split.claude-build-split'));
		this.main = append(this.element, $<HTMLButtonElement>('button.main.claude-build'));
		this.main.type = 'button';
		this._label = append(this.main, $('span.label'));
		if (_options.keybinding) {
			if (!_options.hideKeybinding) {
				appendClaudeKbd(this.main, _options.keybinding).classList.add('is-quiet');
			}
			this.main.setAttribute('aria-keyshortcuts', _options.keybinding);
		}
		this._register(addDisposableListener(this.main, EventType.CLICK, () => this.run()));
		if (claudeCanBuildInBackground()) {
			this.more = append(this.element, $<HTMLButtonElement>('button.more'));
			this.more.type = 'button';
			this.more.setAttribute('aria-haspopup', 'menu');
			this.more.setAttribute('aria-label', localize('claudeBuildMore', "More Build Options"));
			this.more.title = localize('claudeBuildMore', "More Build Options");
			append(this.more, $(ThemeIcon.asCSSSelector(Codicon.chevronDown)));
			this._register(addDisposableListener(this.more, EventType.CLICK, () => this.toggleMenu()));
		}
		this.paint();
	}

	get target(): ClaudeBuildTarget {
		const stored = this.more ? this._storage.get(BUILD_TARGET_KEY, StorageScope.PROFILE) : undefined;
		return stored === 'background' || (stored === 'parallel' && this._options.parallel) ? stored : 'here';
	}

	setEnabled(enabled: boolean): void {
		this._enabled = enabled;
		this.paint();
	}

	/** Runs `target`, or the default target. Does nothing while a build is starting. */
	async run(target = this.target): Promise<void> {
		if (this._busy || !this._enabled) {
			return;
		}
		this._busy = true;
		this.paint();
		try {
			await this._options.run(target);
		} finally {
			this._busy = false;
			if (!this._store.isDisposed) {
				this.paint();
			}
		}
	}

	private toggleMenu(): void {
		if (this._menu.isOpen) {
			this._menu.close();
			return;
		}
		const current = this.target;
		const item = (target: ClaudeBuildTarget, label: string, icon: ThemeIcon, hover: string): ClaudePopoverItem => ({
			id: target,
			label,
			icon,
			hover,
			role: 'menuitemradio',
			checked: current === target,
			detail: current === target ? localize('claudeBuildDefault', "Default") : undefined,
			keybinding: current === target ? this._options.keybinding : undefined,
			run: () => {
				this._storage.store(BUILD_TARGET_KEY, target, StorageScope.PROFILE, StorageTarget.USER);
				this.paint();
				void this.run(target);
			},
		});
		this._menu.show({
			anchor: this.element,
			label: localize('claudeBuildMenu', "Build Options"),
			className: 'claude-build-menu',
			position: AnchorPosition.BELOW,
			alignment: AnchorAlignment.RIGHT,
			entries: [
				item('here', localize('claudeBuildHere', "Build Here"), Codicon.play, localize('claudeBuildHereHover', "Claude builds the plan in this window and you review each change as it lands.")),
				item('background', localize('claudeBuildBackground', "Build in Background Worktree"), Codicon.gitBranch, localize('claudeBuildBackgroundHover', "A background agent builds the plan on its own Git branch and worktree. Review and apply its changes when it is done.")),
				...this._options.parallel ? [item('parallel', localize('claudeBuildParallel', "Build in Parallel"), Codicon.splitHorizontal, localize('claudeBuildParallelHover', "Each to-do that doesn't wait on another gets its own background agent and worktree, all at once. A to-do waits on the ones its Depends line names."))] : [],
			],
		});
	}

	private paint(): void {
		const target = this.target;
		this._label.textContent = target === 'background' ? localize('claudeBuildInBackground', "Build in Background") : target === 'parallel' ? localize('claudeBuildParallel', "Build in Parallel") : localize('claudeBuild', "Build");
		const title = target === 'background' ? localize('claudeBuildBackground', "Build in Background Worktree") : target === 'parallel' ? localize('claudeBuildParallel', "Build in Parallel") : localize('claudeBuildHere', "Build Here");
		this.main.title = this._options.keybinding ? localize('claudeBuildTitleKey', "{0} ({1})", title, this._options.keybinding) : title;
		this.main.disabled = this._busy || !this._enabled;
		if (this.more) {
			this.more.disabled = this._busy || !this._enabled;
		}
		this.element.classList.toggle('is-busy', this._busy);
	}
}
