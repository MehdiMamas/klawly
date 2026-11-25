/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CLAUDE_DEPARTMENT_TOOL_ID, claudeDepartmentMessage } from '../../../../../platform/claude/common/claudeDepartment.js';
import { ToolCardModel } from '../../../../services/claude/common/claudeToolCards.js';
import { claudeDepartmentCardOf, claudeDepartmentSenderOf } from '../../common/claudeDepartmentCard.js';

function toolCard(overrides: Partial<ToolCardModel>): ToolCardModel {
	return {
		id: 't1', name: CLAUDE_DEPARTMENT_TOOL_ID, category: 'other', kind: 'mcp', label: '', verb: '', target: '',
		lines: [], droppedLines: 0, streamedChars: 0, state: 'running', mcpInput: { project: 'relay', brief: 'Fix the feed' },
		...overrides,
	} as ToolCardModel;
}

suite('claudeDepartmentCard', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the card follows the tool call', () => {
		assert.deepStrictEqual([
			claudeDepartmentCardOf(toolCard({})),
			claudeDepartmentCardOf(toolCard({ state: 'success', lines: ['Handed to the relay chat.'] })),
			claudeDepartmentCardOf(toolCard({ state: 'success', lines: ['More than one project fits (a, b).'] })),
			claudeDepartmentCardOf(toolCard({ state: 'success', lines: ['Klawly could not hand the request over: no such folder'] })),
			claudeDepartmentCardOf(toolCard({ state: 'failed', error: 'boom' })),
			claudeDepartmentCardOf(toolCard({ name: 'Bash' })),
		], [
			{ project: 'relay', brief: 'Fix the feed', state: 'handing' },
			{ project: 'relay', brief: 'Fix the feed', state: 'delivered' },
			{ project: 'relay', brief: 'Fix the feed', state: 'pick' },
			{ project: 'relay', brief: 'Fix the feed', state: 'failed', error: 'no such folder' },
			{ project: 'relay', brief: 'Fix the feed', state: 'failed', error: 'boom' },
			undefined,
		]);
	});

	test('the receiving chat finds its sender', () => {
		const message = claudeDepartmentMessage('klawly', { project: 'relay', brief: 'Fix the feed', userWords: 'fix it' });
		assert.deepStrictEqual([
			claudeDepartmentSenderOf(message)?.from,
			claudeDepartmentSenderOf(message)?.body.startsWith('The user said'),
			claudeDepartmentSenderOf('hello'),
		], ['klawly', true, undefined]);
	});
});
