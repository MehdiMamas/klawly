/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';

/**
 * Issue 996. With no folder open a message cannot be sent, so the composer says why in place and
 * offers Open Project... next to the input (DL-14: a choice that cannot run says why, in place).
 * The strip never touches the input: what the user typed stays until they send it or throw it
 * away (DL-78).
 */
export class ClaudeNoFolderStrip {
	readonly element: HTMLElement;

	constructor(container: HTMLElement, openProject: () => void) {
		this.element = append(container, $('.claude-goal-strip.claude-no-folder-strip'));
		this.element.hidden = true;
		const row = append(this.element, $('.claude-goal-strip-row'));
		const icon = append(row, $(ThemeIcon.asCSSSelector(Codicon.folder)));
		icon.classList.add('state');
		append(row, $('span.label')).textContent = localize('claudeNoFolderLabel', "No Project Open");
		append(row, $('span.detail')).textContent = localize('claudeNoFolderDetail', "Open a folder to send this message. Your text stays here.");
		const actions = append(row, $('span.claude-cost-actions'));
		const button = append(actions, $<HTMLButtonElement>('button.claude-goal-strip-btn'));
		button.type = 'button';
		button.textContent = localize('claudeNoFolderOpen', "Open Project...");
		button.addEventListener('click', openProject);
	}

	/** Shows the strip while no folder is open. */
	paint(hasFolder: boolean): void {
		this.element.hidden = hasFolder;
	}
}
