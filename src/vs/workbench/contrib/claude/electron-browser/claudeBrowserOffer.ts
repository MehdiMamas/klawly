/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { getAgentBrowserViewCreationDefaults } from '../../../../platform/browserView/common/browserView.js';
import { findClaudeBrowserLocalUrl } from '../../../../platform/claude/common/claudeBrowserTool.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';

/**
 * Offers "Open in Agent Browser" when a localhost address shows up in terminal
 * output (issue 466). Each address is offered once per window.
 */
export class ClaudeBrowserOfferContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeBrowserOffer';

	private readonly _watching = this._register(new DisposableMap<number, IDisposable>());
	private readonly _offered = new Set<string>();

	constructor(
		@ITerminalService terminals: ITerminalService,
		@INotificationService private readonly _notifications: INotificationService,
		@IBrowserViewWorkbenchService private readonly _browserViews: IBrowserViewWorkbenchService,
	) {
		super();
		for (const instance of terminals.instances) {
			this.watch(instance);
		}
		this._register(terminals.onDidCreateInstance(instance => this.watch(instance)));
		this._register(terminals.onDidDisposeInstance(instance => this._watching.deleteAndDispose(instance.instanceId)));
	}

	private watch(instance: ITerminalInstance): void {
		this._watching.set(instance.instanceId, instance.onLineData(line => this.offer(line)));
	}

	private offer(line: string): void {
		const url = findClaudeBrowserLocalUrl(line);
		if (!url || this._offered.has(url)) {
			return;
		}
		this._offered.add(url);
		this._notifications.prompt(
			Severity.Info,
			localize('claude.browser.offer', "{0} is running. Open it in the Agent Browser?", url),
			[{
				label: localize('claude.browser.offerOpen', "Open in Agent Browser"),
				run: () => this._browserViews.createBrowserView({ ...getAgentBrowserViewCreationDefaults('terminal-offer'), initialUrl: url }, {}),
			}],
			{ neverShowAgain: { id: 'claude.browser.offer' } },
		);
	}
}
