/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { ClaudeGistRequest } from '../../../../../platform/claude/common/claudeShare.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { TestClipboardService } from '../../../../../platform/clipboard/test/common/testClipboardService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IConfirmation, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { ClaudeChatShareService } from '../../browser/chat/claudeChatShare.js';

suite('Claude chat sharing service (issue 490)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('copies the redacted chat, publishes a link only when turned on and confirmed, and copies the link', async () => {
		const gists: ClaudeGistRequest[] = [];
		const confirms: IConfirmation[] = [];
		let confirm = false;
		const configuration = new TestConfigurationService({ claude: { share: { links: false } } });
		const clipboard = new TestClipboardService();
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IClaudeAgentService, {
			exportSession: async () => '# Fix\n\nkey sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ',
			getSessions: () => [{ id: 's1', title: 'Fix' }],
			getHistory: () => [],
		} as unknown as IClaudeAgentService);
		instantiation.stub(IClaudeRuntimeService, { createSecretGist: async (request: ClaudeGistRequest) => { gists.push(request); return { kind: 'created', url: 'https://gist.github.com/someone/abc' }; } } as unknown as IClaudeRuntimeService);
		instantiation.stub(IClipboardService, clipboard);
		instantiation.stub(IConfigurationService, configuration);
		instantiation.stub(IDialogService, { confirm: async (confirmation: IConfirmation) => { confirms.push(confirmation); return { confirmed: confirm }; } } as unknown as IDialogService);
		instantiation.stub(INotificationService, { status: () => ({ dispose() { } }), prompt: () => undefined, warn: () => undefined, error: () => undefined } as unknown as INotificationService);
		instantiation.stub(IOpenerService, { open: async () => true } as unknown as IOpenerService);
		instantiation.stub(IEditorService, {} as unknown as IEditorService);
		instantiation.stub(IQuickInputService, {} as unknown as IQuickInputService);
		const share = instantiation.createInstance(ClaudeChatShareService);

		await share.copyMarkdown('s1');
		const copied = await clipboard.readText();
		await share.shareLink('s1');
		const whileOff = { gists: gists.length, confirms: confirms.length, links: share.linksEnabled };
		await configuration.setUserConfiguration('claude', { share: { links: true } });
		await share.shareLink('s1');
		const cancelled = gists.length;
		confirm = true;
		await share.shareLink('s1');
		assert.deepStrictEqual({
			copied: { leaked: copied.includes('sk-ant-api03'), title: copied.startsWith('# Fix') },
			whileOff,
			cancelled,
			asked: confirms.map(confirmation => [confirmation.message, String(confirmation.detail).includes('removed 1 secrets')]),
			published: gists.map(gist => [gist.filename, gist.content.includes('sk-ant-api03')]),
			link: await clipboard.readText(),
		}, {
			copied: { leaked: false, title: true },
			whileOff: { gists: 0, confirms: 0, links: false },
			cancelled: 0,
			asked: [['Publish "Fix" as a secret gist?', true], ['Publish "Fix" as a secret gist?', true]],
			published: [['Fix', false]],
			link: 'https://gist.github.com/someone/abc',
		});
	});

	test('opens a shared chat from a pasted gist link: secrets removed, read as Markdown or forked into a new chat', async () => {
		const opened: { contents?: string; languageId?: string }[] = [];
		const created: { draft?: string }[] = [];
		const selected: string[] = [];
		const actions: string[][] = [];
		const errors: string[] = [];
		let answer: string | undefined = 'https://gist.github.com/someone/0123456789abcdef0123456789abcdef';
		let reply: { kind: 'read'; content: string } | { kind: 'failed'; problem: 'failed'; message: string } = { kind: 'read', content: '# Fix\n\nkey sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ' };
		const choices: { run: () => void }[] = [];
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IClaudeAgentService, {
			createSession: (options: { draft?: string }) => { created.push(options); return { id: 'new' }; },
			selectSession: (id: string) => { selected.push(id); },
		} as unknown as IClaudeAgentService);
		instantiation.stub(IClaudeRuntimeService, { readSharedGist: async () => reply } as unknown as IClaudeRuntimeService);
		instantiation.stub(IClipboardService, new TestClipboardService());
		instantiation.stub(IConfigurationService, new TestConfigurationService());
		instantiation.stub(IDialogService, {} as unknown as IDialogService);
		instantiation.stub(INotificationService, {
			status: () => ({ dispose() { } }),
			prompt: (_severity: unknown, _message: string, buttons: { label: string; run: () => void }[]) => { actions.push(buttons.map(button => button.label)); choices.push(...buttons); },
			warn: () => undefined,
			error: (message: string) => { errors.push(message); },
		} as unknown as INotificationService);
		instantiation.stub(IOpenerService, { open: async () => true } as unknown as IOpenerService);
		instantiation.stub(IEditorService, { openEditor: async (input: { contents?: string; languageId?: string }) => { opened.push(input); return undefined; } } as unknown as IEditorService);
		instantiation.stub(IQuickInputService, { input: async () => answer } as unknown as IQuickInputService);
		const share = instantiation.createInstance(ClaudeChatShareService);

		await share.openShared();
		choices[0].run();
		choices[1].run();
		answer = undefined;
		await share.openShared();
		answer = 'https://gist.github.com/someone/0123456789abcdef0123456789abcdef';
		reply = { kind: 'failed', problem: 'failed', message: 'HTTP 404: Not Found' };
		await share.openShared();
		assert.deepStrictEqual({
			actions,
			opened: opened.map(input => [input.languageId, input.contents?.includes('sk-ant-api03'), input.contents?.startsWith('# Fix')]),
			forked: created.map(options => [options.draft?.includes('sk-ant-api03'), options.draft?.includes('# Fix')]),
			selected,
			errors,
		}, {
			actions: [['Read', 'Fork into New Chat']],
			opened: [['markdown', false, true]],
			forked: [[false, true]],
			selected: ['new'],
			errors: [`Couldn't open the shared chat: HTTP 404: Not Found`],
		});
	});
});
