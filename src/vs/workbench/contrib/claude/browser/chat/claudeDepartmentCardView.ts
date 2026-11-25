/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ClaudeDepartmentCardData, ClaudeDepartmentCardState } from '../../common/claudeDepartmentCard.js';

function stateLabel(state: ClaudeDepartmentCardState): string {
	switch (state) {
		case 'handing': return localize('claudeDepartmentHanding', "Handing over");
		case 'delivered': return localize('claudeDepartmentDelivered', "Delivered");
		case 'pick': return localize('claudeDepartmentPick', "Pick a project");
		case 'failed': return localize('claudeDepartmentFailed', "Failed");
	}
}

/**
 * The card the sending chat shows when it hands a request to another project's chat (DL-117):
 * the project, the brief in muted words, and where the hand-off stands. It is a hand-off, not a
 * worker, so there is no Stop and nothing waits for a reply.
 */
export function renderClaudeDepartmentCard(parent: HTMLElement, data: ClaudeDepartmentCardData): void {
	clearNode(parent);
	const card = append(parent, $(`.claude-department-card.is-${data.state}`));
	const head = append(card, $('.head'));
	const icon = data.state === 'failed' ? Codicon.error : data.state === 'handing' ? Codicon.loading : Codicon.arrowRight;
	append(head, $('span.status' + ThemeIcon.asCSSSelector(icon) + (data.state === 'handing' ? '.codicon-modifier-spin' : '')));
	const title = append(head, $('span.title'));
	title.textContent = data.project
		? localize('claudeDepartmentTitle', "Handed to {0}", data.project)
		: localize('claudeDepartmentTitleNoProject', "Handed to another project");
	append(head, $('span.state')).textContent = stateLabel(data.state);
	if (data.brief) {
		append(card, $('.brief')).textContent = data.brief;
	}
	if (data.error) {
		append(card, $('.error')).textContent = data.error;
	}
}
