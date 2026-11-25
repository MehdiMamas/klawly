/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NormalizedClaudeEvent, ToolCall } from '../../../../../platform/claude/common/claudeProtocol.js';
import { AgentReducerEvent } from '../../../../services/claude/common/claudeAgentState.js';
import { claudeChatOutlineFromEvents, ClaudeChatOutlineNode, flattenClaudeChatOutline } from '../../common/claudeChatOutline.js';

suite('Claude chat outline (issue 433)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('prompts are the top level; the plan, to-dos, edits and subagents sit under them in order', () => {
		const outline = claudeChatOutlineFromEvents([
			{ type: 'turn.submitted', turnId: 't1', text: 'Fix the login bug\nand add a test' },
			tool('e1', 'Edit', 'write', 'src/auth/login.ts'), done('e1'),
			tool('todo', 'TodoWrite', 'other'), done('todo'),
			tool('r1', 'Read', 'read', 'src/auth/session.ts'), done('r1'),
			subagent('run-a', undefined, 'Find every caller'),
			subagent('run-b', 'run-a', 'Read the tests'),
			tool('e2', 'Edit', 'write', 'src/auth/login.ts'), done('e2'),
			tool('w1', 'Write', 'write', 'src/auth/login.test.ts'), done('w1'),
			{ type: 'session.completed', sessionId: 's' },
			{ type: 'turn.submitted', turnId: 't2', text: 'Plan the logout', sent: { compiled: 'Plan the logout', mode: 'plan' } },
			{ type: 'assistant.completed', sessionId: 's', text: '# Logout\n\n1. Add `/logout`\n2. Clear the cookie' },
			{ type: 'session.completed', sessionId: 's' },
			{ type: 'turn.submitted', turnId: 't3', text: '   ' },
		]);
		assert.deepStrictEqual(flattenClaudeChatOutline(outline).map(({ node, depth }) => `${'  '.repeat(depth)}${describe(node)}`), [
			'prompt Fix the login bug and add a test (Turn 1) -> t1',
			'  edit login.ts (src/auth/login.ts) -> t1#e1',
			'  todos To-dos Updated -> t1#todo',
			'  subagent Find every caller (Subagent (Explore)) -> t1#run-a',
			'    subagent Read the tests (Subagent (Explore)) -> t1#run-b',
			'  edit login.test.ts (src/auth/login.test.ts) -> t1#w1',
			'prompt Plan the logout (Turn 2) -> t2',
			'  plan Plan (Logout) -> t2',
			'prompt Turn 3 (Turn 3) -> t3',
		]);
		assert.deepStrictEqual(flattenClaudeChatOutline(outline).map(({ node }) => node.order), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
	});

	test('a long prompt is cut to one short line', () => {
		const [node] = claudeChatOutlineFromEvents([{ type: 'turn.submitted', turnId: 't1', text: 'x'.repeat(200) }]);
		assert.strictEqual(node.label, `${'x'.repeat(79)}…`);
	});
});

function describe(node: ClaudeChatOutlineNode): string {
	const description = node.description ? ` (${node.description})` : '';
	const target = node.targetId ? `#${node.targetId}` : '';
	return `${node.kind} ${node.label}${description} -> ${node.turnId}${target}`;
}

function tool(id: string, name: string, category: ToolCall['category'], file?: string): AgentReducerEvent {
	const call: ToolCall = { id, name, category, input: {}, display: { label: name, file } };
	return { type: 'tool.started', sessionId: 's', call };
}

function done(id: string): NormalizedClaudeEvent {
	return { type: 'tool.completed', sessionId: 's', callId: id, result: { ok: true } };
}

function subagent(id: string, parent: string | undefined, description: string): NormalizedClaudeEvent {
	return {
		type: 'subagent.started',
		sessionId: 's',
		parentRunId: parent,
		run: { id, parentRunId: parent, agentType: 'Explore', description, background: false, state: 'running', startedAt: 1, toolCallCount: 0 },
	};
}
