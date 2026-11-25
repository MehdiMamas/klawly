/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_DEPARTMENT_TOOL_ID } from '../../../../platform/claude/common/claudeDepartment.js';
import { ToolCardModel } from '../../../services/claude/common/claudeToolCards.js';

/** Where a hand-off to another project's chat stands, as the sending chat sees it (issue 1177). */
export type ClaudeDepartmentCardState = 'handing' | 'delivered' | 'pick' | 'failed';

/** What the hand-off card in the sending chat shows. */
export interface ClaudeDepartmentCardData {
	readonly project: string;
	readonly brief: string;
	readonly state: ClaudeDepartmentCardState;
	/** The reason, for a failed hand-off. */
	readonly error?: string;
}

const MORE_THAN_ONE = 'More than one project fits';

/** The hand-off card data for a `klawly_department` tool call, or undefined for any other tool. */
export function claudeDepartmentCardOf(card: ToolCardModel): ClaudeDepartmentCardData | undefined {
	if (card.name !== CLAUDE_DEPARTMENT_TOOL_ID) {
		return undefined;
	}
	const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
	const project = text(card.mcpInput?.project);
	const brief = text(card.mcpInput?.brief);
	if (card.state === 'running') {
		return { project, brief, state: 'handing' };
	}
	if (card.state === 'success') {
		const first = card.lines.find(line => line.trim()) ?? '';
		if (first.startsWith('Klawly could not hand the request over')) {
			return { project, brief, state: 'failed', error: first.replace(/^Klawly could not hand the request over:\s*/, '') };
		}
		return { project, brief, state: first.startsWith(MORE_THAN_ONE) ? 'pick' : 'delivered' };
	}
	return { project, brief, state: 'failed', error: card.error };
}

/** The sender named in a hand-off message's first line ("From X chat."), and the rest of the message. */
export function claudeDepartmentSenderOf(text: string): { readonly from: string; readonly body: string } | undefined {
	const match = /^From (?<from>[^\n]+?) chat\. This is a hand-off from another project's chat, not a worker: nobody waits for a reply\.\n\n(?<body>[\s\S]*)$/.exec(text);
	const from = match?.groups?.from;
	return from ? { from, body: match.groups?.body ?? '' } : undefined;
}
