/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentReducerEvent, EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../../../services/claude/common/claudeAgentState.js';
import { claudeChatFind, claudeFindRegExp } from '../../common/claudeChatFind.js';

suite('Claude chat find (issue 685)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const state = ([
		{ type: 'turn.submitted', turnId: 't1', text: 'Fix the Login bug' },
		{ type: 'assistant.completed', sessionId: 's', text: 'The login handler\ntrims the name.' },
		{ type: 'session.completed', sessionId: 's' },
		{ type: 'turn.submitted', turnId: 't2', text: 'Now add a logout' },
	] as AgentReducerEvent[]).reduce(reduceAgentState, EMPTY_AGENT_VIEW_STATE);

	test('finds the text in prompts and replies, ignoring case, in chat order', () => {
		assert.deepStrictEqual(claudeChatFind(state, ' LOGIN '), [
			{ turnId: 't1', from: 'prompt', snippet: 'Fix the Login bug' },
			{ turnId: 't1', from: 'reply', snippet: 'The login handler trims the name.' },
		]);
	});

	test('finds the text in tool commands, output and file edits (issue 890)', () => {
		const withTools = ([
			{ type: 'turn.submitted', turnId: 't1', text: 'Run it' },
			{ type: 'tool.started', sessionId: 's', call: { id: 'sh', name: 'Bash', category: 'shell', input: { command: 'npm test' }, display: { label: 'Run', command: 'npm test' } } },
			{ type: 'tool.completed', sessionId: 's', callId: 'sh', result: { ok: true, output: 'ok 1 widget\nok 2 Gadget' } },
			{ type: 'tool.started', sessionId: 's', call: { id: 'ed', name: 'Edit', category: 'write', input: {}, display: { label: 'Edit src/gadget.ts', file: 'src/gadget.ts' } } },
		] as AgentReducerEvent[]).reduce(reduceAgentState, EMPTY_AGENT_VIEW_STATE);
		assert.deepStrictEqual(claudeChatFind(withTools, 'gadget'), [
			{ turnId: 't1', from: 'output', targetId: 'sh', snippet: 'ok 2 Gadget' },
			{ turnId: 't1', from: 'edit', targetId: 'ed', snippet: 'src/gadget.ts' },
		]);
		assert.deepStrictEqual(claudeChatFind(withTools, 'npm'), [{ turnId: 't1', from: 'command', targetId: 'sh', snippet: 'npm test' }]);
	});

	test('finds nothing for blank or absent text', () => {
		assert.deepStrictEqual([claudeChatFind(state, '  '), claudeChatFind(state, 'zebra')], [[], []]);
	});

	test('builds the find pattern from the typed text and the toggles (issue 890)', () => {
		const plain = { isRegex: false, matchCase: false, wholeWord: false };
		const matches = (re: RegExp | undefined, text: string) => text.match(re ?? /$^/g)?.length ?? 0;
		assert.deepStrictEqual({
			empty: claudeFindRegExp('', plain),
			invalid: claudeFindRegExp('(', { ...plain, isRegex: true }),
			insensitive: matches(claudeFindRegExp('cart', plain), 'Cart cart CART'),
			matchCase: matches(claudeFindRegExp('cart', { ...plain, matchCase: true }), 'Cart cart CART'),
			wholeWord: matches(claudeFindRegExp('cart', { ...plain, wholeWord: true }), 'cart cartService'),
			regex: matches(claudeFindRegExp('c.rt', { ...plain, isRegex: true }), 'cart cort'),
			literal: matches(claudeFindRegExp('c.rt', plain), 'cart cort'),
		}, { empty: undefined, invalid: undefined, insensitive: 3, matchCase: 1, wholeWord: 1, regex: 2, literal: 0 });
	});
});
