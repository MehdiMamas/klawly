/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { ClaudeInlineCompletionRequest } from '../../../../../platform/claude/common/claudeAutocomplete.js';
import { CLAUDE_INLINE_EDIT_MODEL_SETTING } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { PosixShellType } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { ClaudeTerminalPromptWidget, ClaudeTerminalTarget } from '../../browser/terminal/claudeTerminalPrompt.js';

/** A terminal that records what is typed into it. */
class RecordingTerminal implements ClaudeTerminalTarget {
	readonly shellType = PosixShellType.Bash;
	readonly os = OperatingSystem.Linux;
	readonly sent: [string, boolean, boolean | undefined][] = [];
	focused = 0;

	async getCwdResource(): Promise<URI | undefined> {
		return URI.file('/work/shop');
	}

	async sendText(text: string, shouldExecute: boolean, bracketedPasteMode?: boolean): Promise<void> {
		this.sent.push([text, shouldExecute, bracketedPasteMode]);
	}

	focus(): void {
		this.focused++;
	}
}

suite('Claude terminal prompt card', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(reply: (request: ClaudeInlineCompletionRequest) => Promise<string | undefined>) {
		const requests: ClaudeInlineCompletionRequest[] = [];
		const cancelled: string[] = [];
		const instantiation = disposables.add(new TestInstantiationService());
		instantiation.stub(IClaudeRuntimeService, {
			completeInline: (request: ClaudeInlineCompletionRequest) => {
				requests.push(request);
				return reply(request);
			},
			cancelInline: async (id: string) => { cancelled.push(id); },
		});
		instantiation.stub(IClaudeAgentService, { getCurrentSession: () => undefined });
		instantiation.stub(IConfigurationService, new TestConfigurationService({ [CLAUDE_INLINE_EDIT_MODEL_SETTING]: 'claude-haiku-4-5' }));
		instantiation.stub(IWorkspaceContextService, new TestContextService());
		const host = mainWindow.document.createElement('div');
		host.style.position = 'relative';
		host.style.width = '800px';
		host.style.height = '300px';
		mainWindow.document.body.appendChild(host);
		disposables.add({ dispose: () => host.remove() });
		const terminal = new RecordingTerminal();
		let closed = 0;
		const widget = disposables.add(instantiation.createInstance(ClaudeTerminalPromptWidget, host, terminal, () => { closed++; }));
		const root = host.querySelector<HTMLElement>('.claude-terminal-prompt')!;
		const field = root.querySelector<HTMLTextAreaElement>('textarea')!;
		const visible = () => [...root.querySelectorAll<HTMLElement>('button, .claude-activity, .claude-terminal-reply')]
			.filter(element => element.getClientRects().length > 0)
			.map(element => element.getAttribute('aria-label') ?? element.textContent);
		return { widget, root, field, terminal, requests, cancelled, visible, closed: () => closed };
	}

	test('a command is typed at the prompt, never run, then the card closes', async () => {
		const { widget, root, field, terminal, requests, visible, closed } = setup(async () => '```bash\r\ngit fetch\r\ngit log --oneline -5\r\n```');
		const before = { label: root.getAttribute('aria-label'), placeholder: field.placeholder, visible: visible() };
		field.value = 'show the last five commits after fetching';
		await widget.submit();

		assert.deepStrictEqual({
			before,
			sent: terminal.sent,
			closed: closed(),
			request: { cwd: requests[0].cwd, model: requests[0].model, lastLine: requests[0].prompt.split('\n').at(-1) },
		}, {
			before: { label: 'Ask Claude for a command', placeholder: 'Describe a command', visible: ['Close (Escape)', 'Quick Question', 'Submit'] },
			sent: [['git fetch && git log --oneline -5', false, true]],
			closed: 1,
			request: { cwd: URI.file('/work/shop').fsPath, model: 'claude-haiku-4-5', lastLine: 'Request: show the last five commits after fetching' },
		});
	});

	test('a quick question is answered in the card and nothing is typed', async () => {
		const { widget, root, field, terminal, requests, visible, closed } = setup(async () => 'Use `git stash list` to see them.');
		root.querySelector<HTMLButtonElement>('.claude-terminal-toggle')!.click();
		field.value = 'where are my stashes?';
		await widget.submit();

		assert.deepStrictEqual({
			pressed: root.querySelector('.claude-terminal-toggle')!.getAttribute('aria-pressed'),
			placeholder: field.placeholder,
			question: requests[0].prompt.split('\n')[0],
			code: [...root.querySelectorAll('.claude-terminal-reply code')].map(code => code.textContent),
			visible: visible(),
			sent: terminal.sent,
			closed: closed(),
		}, {
			pressed: 'true',
			placeholder: 'Ask about the terminal',
			question: 'Answer a question about working in the terminal described below.',
			code: ['git stash list'],
			visible: ['Close (Escape)', 'Use git stash list to see them.', 'Quick Question', 'Submit'],
			sent: [],
			closed: 0,
		});
	});

	test('Stop cancels the request and a late reply is dropped', async () => {
		const reply = new DeferredPromise<string | undefined>();
		const { widget, field, terminal, requests, cancelled, visible, closed } = setup(() => reply.p);
		field.value = 'delete every branch';
		const pending = widget.submit();
		await Promise.resolve();
		await Promise.resolve();
		const running = visible();
		field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		const stopped = visible();
		reply.complete('git branch | xargs git branch -D');
		await pending;

		assert.deepStrictEqual({ running, stopped, cancelled, sent: terminal.sent, closed: closed() }, {
			running: ['Close (Escape)', 'Writing command...', 'Stop'],
			stopped: ['Close (Escape)', 'Quick Question', 'Submit'],
			cancelled: [requests[0].id],
			sent: [],
			closed: 0,
		});
	});

	test('the card sits at the bottom left, in line with the output gutter', () => {
		const { root } = setup(async () => undefined);
		const host = root.parentElement!;

		assert.deepStrictEqual({
			left: root.offsetLeft,
			width: root.offsetWidth,
			bottomGap: host.clientHeight - root.offsetTop - root.offsetHeight,
		}, { left: 20, width: 500, bottomGap: 10 });
	});
});
