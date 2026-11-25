/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NormalizedClaudeEvent } from '../../../../../platform/claude/common/claudeProtocol.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { TestClipboardService } from '../../../../../platform/clipboard/test/common/testClipboardService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { AgentViewState, EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../../../services/claude/common/claudeAgentState.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ClaudeTimelineRenderer } from '../../browser/chat/claudeTimelineRenderer.js';
import { silentTendService } from './claudeGitHubTestUtils.js';
import { IClaudeTendPullRequestService } from '../../browser/chat/claudeTendPullRequest.js';

const ASSISTANT = [
	'Plain words.',
	'<img src="x" onerror="alert(1)"> <script>alert(2)</script> <iframe src="https://example.com"></iframe>',
	'<style>body { display: none }</style> <form action="https://example.com"><input name="q"></form>',
	'<a href="javascript:alert(3)">raw link</a> <div onclick="alert(4)">raw div</div>',
	'[Run](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22rm%20-rf%20~%22%7D)',
	'[Script](javascript:alert(5)) [Data](data:text/html;base64,PHNjcmlwdD5hbGVydCg2KTwvc2NyaXB0Pg==) <javascript:alert(7)>',
	'See src/app.ts:3 and ../../etc/passwd.ts:1 and /etc/shadow.ts:1.',
	'```html\n<script>alert(8)</script> src/inside-code.ts:9\n```',
].join('\n\n');

const MCP_ERROR = '<img src=x onerror=alert(9)> [Open](command:workbench.action.files.save) <a href="javascript:alert(10)">x</a>';

function unsafeState(): AgentViewState {
	const events: NormalizedClaudeEvent[] = [
		{ type: 'assistant.completed', sessionId: 's', text: ASSISTANT },
		{
			type: 'tool.started', sessionId: 's', call: {
				id: 'mcp-1',
				name: 'mcp__evil__<img src=x onerror=alert(11)>',
				category: 'mcp',
				input: { query: '<script>alert(12)</script>' },
				display: { label: '<b onmouseover="alert(13)">label</b>', query: '<svg onload=alert(14)>' },
			},
		},
		{ type: 'tool.completed', sessionId: 's', callId: 'mcp-1', result: { ok: false, error: MCP_ERROR } },
		{
			type: 'permission.requested', sessionId: 's', request: {
				id: 'perm-1',
				toolName: 'mcp__evil__<script>alert(15)</script>',
				category: 'mcp',
				input: { html: '<img src=x onerror=alert(16)>' },
			},
		},
	];
	let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text: '<img src=x onerror=alert(17)> from the user' });
	for (const event of events) {
		state = reduceAgentState(state, event);
	}
	return state;
}

/** Every element and attribute that could run code or navigate somewhere unsafe. */
function unsafeNodes(root: HTMLElement): string[] {
	const found: string[] = [];
	for (const element of root.querySelectorAll('*')) {
		const tag = element.tagName.toLowerCase();
		if (['script', 'img', 'iframe', 'style', 'form', 'input', 'object', 'embed', 'svg', 'link', 'meta', 'base'].includes(tag)) {
			found.push(tag);
		}
		for (const attribute of element.getAttributeNames()) {
			const value = element.getAttribute(attribute) ?? '';
			if (attribute.startsWith('on')) {
				found.push(`${tag}[${attribute}]`);
			}
			if (['href', 'src', 'data-href', 'action', 'formaction', 'xlink:href'].includes(attribute) && /^\s*(?:javascript|command|data|vbscript):/i.test(value)) {
				found.push(`${tag}[${attribute}=${value}]`);
			}
		}
	}
	return found;
}

suite('Claude Markdown and MCP sanitization', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('raw HTML, command: links and javascript: links in assistant, tool and MCP text stay inert', () => {
		const opened: unknown[] = [];
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IClaudeTendPullRequestService, silentTendService());
		instantiationService.stub(IClipboardService, new TestClipboardService());
		instantiationService.stub(INotificationService, new TestNotificationService());
		instantiationService.stub(IEditorService, 'openEditor', async (input: unknown) => { opened.push(input); return undefined; });
		const root = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(root);
		store.add({ dispose: () => root.remove() });
		const renderer = store.add(instantiationService.createInstance(ClaudeTimelineRenderer, root, {
			retry: () => undefined,
			build: async () => undefined,
			respondPermission: async () => undefined,
			openSubagent: () => undefined,
			stopSubagent: () => undefined,
			copyCommand: () => undefined,
			openInTerminal: () => undefined,
			rerunCommand: () => undefined,
			openCommandLog: () => undefined,
		}));
		const state = unsafeState();
		renderer.render(state);
		// Open every collapsed tool card so its body is rendered too.
		const collapsed = [...root.querySelectorAll('button.claude-tool-row')].filter(button => button.getAttribute('aria-expanded') === 'false');
		for (const button of collapsed) {
			assert.ok(button instanceof HTMLButtonElement);
			button.click();
		}

		assert.deepStrictEqual(unsafeNodes(root), []);
		const text = root.textContent ?? '';
		assert.ok(text.includes('Plain words.'), text);
		// Tool and MCP strings are shown as text (the error may be clipped), never parsed as HTML or Markdown.
		assert.ok(text.includes('<img src=x onerror=alert(9)> [Open](command:workbench.action.files.save)'), text);
		assert.ok(text.includes('mcp__evil__<script>alert(15)</script>'), text);
		// Only the safe relative reference becomes a file link; code and traversal stay plain.
		assert.deepStrictEqual([...root.querySelectorAll('.claude-file-link')].map(link => link.textContent), ['src/app.ts:3']);
		const traversal = [...root.querySelectorAll('[role="link"]')].find(node => node.textContent?.includes('passwd'));
		assert.strictEqual(traversal, undefined);
		assert.deepStrictEqual(opened, []);
	});
});
