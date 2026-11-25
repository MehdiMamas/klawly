/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IURLService } from '../../../../../platform/url/common/url.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustRequestService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudeContextService } from '../../../../services/claude/common/claudeContextService.js';
import { CLAUDE_CHAT_HANDOFF_KEY, serializeClaudeChatHandoff } from '../../common/claudeChatHandoff.js';
import { ClaudeAgentEntryPoints } from '../../electron-browser/claudeAgentEntryPoints.js';

suite('Klawly agent entry points (issue 519)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a new-chat link fills the composer and never sends; an open link resumes the chat; other links are not handled', async () => {
		const calls: string[] = [];
		let disabled = false;
		const agent = {
			createSession: () => { calls.push('create'); return { id: 's1' }; },
			setMode: (_id: string, mode: string) => calls.push(`mode ${mode}`),
			setDraft: (_id: string, text: string) => calls.push(`draft ${text}`),
			submit: async () => { calls.push('submit'); },
			resume: async (id: string) => { calls.push(`resume ${id}`); },
			selectSession: (id: string) => calls.push(`select ${id}`),
		} as unknown as IClaudeAgentService;
		const entry = store.add(new ClaudeAgentEntryPoints(
			agent,
			{} as IClaudeContextService,
			{ openView: async () => undefined } as unknown as IViewsService,
			{ getContextKeyValue: () => disabled } as unknown as IContextKeyService,
			{ getWorkspace: () => ({ folders: [] }) } as unknown as IWorkspaceContextService,
			{} as IWorkspaceTrustRequestService,
			{ info: (message: string) => calls.push(`info ${message}`), warn: () => undefined } as unknown as INotificationService,
			{ focus: async () => undefined } as unknown as IHostService,
			{ urlProtocol: 'klawly' } as IProductService,
			new NullLogService(),
			{ registerHandler: () => ({ dispose: () => undefined }) } as unknown as IURLService,
			store.add(new InMemoryStorageService()),
			{} as IDialogService,
			{} as IFileService,
		));
		const handled = [
			await entry.handleURL(URI.parse('klawly://agent/new?prompt=Fix%20the%20login%20test&mode=plan')),
			await entry.handleURL(URI.parse('klawly://agent/open?session=abc-1')),
			await entry.handleURL(URI.parse('https://example.com/agent/new?prompt=x')),
			await entry.handleURL(URI.parse('klawly://extension/install')),
		];
		disabled = true;
		const whileOff = await entry.handleURL(URI.parse('klawly://agent/new?prompt=x'));
		assert.deepStrictEqual({ handled, whileOff, calls }, {
			handled: [true, true, false, false],
			whileOff: true,
			calls: ['create', 'mode plan', 'draft Fix the login test', 'resume abc-1', 'select abc-1', 'info That link opens a Klawly chat, but the agent is turned off in this window.'],
		});
	});

	test('an Agents window session opens in the Agent pane, says where its earlier turns are when it is new, and other sessions are left to the chat view (issue 618)', async () => {
		const calls: string[] = [];
		let disabled = false;
		const agent = {
			openClaudeCodeSession: async (id: string) => { calls.push(`open ${id}`); return { sessionId: 'tab', adopted: id === 'cc-new' }; },
		} as unknown as IClaudeAgentService;
		const entry = store.add(new ClaudeAgentEntryPoints(
			agent,
			{} as IClaudeContextService,
			{ openView: async (id: string) => { calls.push(`view ${id}`); return undefined; } } as unknown as IViewsService,
			{ getContextKeyValue: () => disabled } as unknown as IContextKeyService,
			{} as IWorkspaceContextService,
			{} as IWorkspaceTrustRequestService,
			{ info: () => calls.push('notice') } as unknown as INotificationService,
			{} as IHostService,
			{ urlProtocol: 'klawly' } as IProductService,
			new NullLogService(),
			{ registerHandler: () => ({ dispose: () => undefined }) } as unknown as IURLService,
			store.add(new InMemoryStorageService()),
			{} as IDialogService,
			{} as IFileService,
		));
		const handled = [
			await entry.openAgentsWindowSession(URI.parse('agent-host-claude:/cc-saved')),
			await entry.openAgentsWindowSession(URI.parse('agent-host-claude:/cc-new')),
			await entry.openAgentsWindowSession(URI.parse('agent-host-other:/cc-saved')),
			await entry.openAgentsWindowSession(URI.parse('remote-box-claude:/cc-saved')),
		];
		disabled = true;
		const whileOff = await entry.openAgentsWindowSession(URI.parse('agent-host-claude:/cc-saved'));
		assert.deepStrictEqual({ handled, whileOff, calls }, {
			handled: [true, true, false, false],
			whileOff: false,
			calls: ['open cc-saved', 'view claude.agentView', 'open cc-new', 'view claude.agentView', 'notice'],
		});
	});
	/** An entry point over fakes that record what it does; the window has `windowFolder` open. */
	function entryFor(windowFolder: string, options: { confirmed?: boolean; folderExists?: boolean; storage?: InMemoryStorageService } = {}) {
		const calls: string[] = [];
		const storage = options.storage ?? store.add(new InMemoryStorageService());
		const agent = {
			createSession: () => { calls.push('create'); return { id: 's1' }; },
			setMode: (_id: string, mode: string) => calls.push(`mode ${mode}`),
			setDraft: (_id: string, text: string) => calls.push(`draft ${text}`),
			setExecutionTarget: (_id: string, target: { kind: string }) => calls.push(`target ${target.kind}`),
			getSessions: () => [{ id: 's1', mode: 'agent' }],
			submit: async (_id: string, text: string, cwd: string) => { calls.push(`submit ${text} in ${cwd}`); },
			openClaudeCodeSession: async (id: string, title: string) => { calls.push(`continue ${id} as ${title}`); return { sessionId: 'tab', adopted: true }; },
		} as unknown as IClaudeAgentService;
		const entry = store.add(new ClaudeAgentEntryPoints(
			agent,
			{ preview: async () => ({}) } as unknown as IClaudeContextService,
			{ openView: async () => undefined } as unknown as IViewsService,
			{ getContextKeyValue: () => false } as unknown as IContextKeyService,
			{ getWorkspace: () => ({ folders: [{ uri: URI.file(windowFolder) }] }) } as unknown as IWorkspaceContextService,
			{ requestWorkspaceTrust: async () => true } as unknown as IWorkspaceTrustRequestService,
			{ info: (message: string) => calls.push(`info ${message}`), warn: (message: string) => calls.push(`warn ${message}`) } as unknown as INotificationService,
			{ focus: async () => undefined, openWindow: async (toOpen: { folderUri: URI }[]) => { calls.push(`open window ${toOpen.map(item => item.folderUri.fsPath).join(',')}`); } } as unknown as IHostService,
			{ urlProtocol: 'klawly' } as IProductService,
			new NullLogService(),
			{ registerHandler: () => ({ dispose: () => undefined }) } as unknown as IURLService,
			storage,
			{ confirm: async () => ({ confirmed: options.confirmed ?? true }) } as unknown as IDialogService,
			{ stat: async () => { if (options.folderExists === false) { throw new Error('missing'); } return { isDirectory: true }; } } as unknown as IFileService,
		));
		return { entry, calls, storage };
	}

	test('klawly chat --worktree sets the worktree target before the prompt is sent; without it the chat stays local (issue 861)', async () => {
		const withFlag = entryFor(URI.file('/work/app').fsPath);
		await withFlag.entry.chat({ _: ['Fix', 'it'], worktree: true });
		const without = entryFor(URI.file('/work/app').fsPath);
		await without.entry.chat({ _: ['Fix it'] });
		const noFolder = entryFor(URI.file('/work/app').fsPath);
		await noFolder.entry.chat({ _: [], worktree: true });
		const cwd = URI.file('/work/app').fsPath;
		assert.deepStrictEqual({ withFlag: withFlag.calls, without: without.calls, noFolder: noFolder.calls }, {
			withFlag: ['create', 'mode agent', 'target worktree', `submit Fix it in ${cwd}`],
			without: ['create', 'mode agent', `submit Fix it in ${cwd}`],
			noFolder: ['create', 'mode agent', 'target worktree'],
		});
	});

	test('a link naming another folder asks first, then opens that folder and leaves the prompt for it, never sending (issue 861)', async () => {
		const other = URI.file('/work/other').fsPath;
		const target = other.startsWith('\\') ? 'C:' + other : other; // a link only names an absolute path: give the Windows one a drive
		const link = `klawly://agent/new?prompt=Fix%20it&mode=plan&folder=${encodeURIComponent(target)}`;
		const accepted = entryFor(URI.file('/work/app').fsPath);
		await accepted.entry.handleURL(URI.parse(link));
		const stored = JSON.parse(accepted.storage.get(CLAUDE_CHAT_HANDOFF_KEY, StorageScope.APPLICATION)!);
		const declined = entryFor(URI.file('/work/app').fsPath, { confirmed: false });
		await declined.entry.handleURL(URI.parse(link));
		const missing = entryFor(URI.file('/work/app').fsPath, { folderExists: false });
		await missing.entry.handleURL(URI.parse(link));
		const same = entryFor(target);
		await same.entry.handleURL(URI.parse(link));
		assert.deepStrictEqual({
			accepted: accepted.calls,
			storedPrompt: [stored.prompt, stored.mode, stored.folder],
			declined: [declined.calls, declined.storage.get(CLAUDE_CHAT_HANDOFF_KEY, StorageScope.APPLICATION)],
			missing: [missing.calls.map(call => call.slice(0, 39)), missing.storage.get(CLAUDE_CHAT_HANDOFF_KEY, StorageScope.APPLICATION)],
			same: same.calls,
		}, {
			accepted: [`open window ${URI.file(target).fsPath}`],
			storedPrompt: ['Fix it', 'plan', target],
			declined: [[], undefined],
			missing: [['warn That link names a folder that does'], undefined],
			same: ['create', 'mode plan', 'draft Fix it'],
		});
	});

	test('an import link asks, then continues the Claude Code session in the folder\'s window with the handoff text in the composer, never sent (issue 1186)', async () => {
		const id = '0f8e2a4c-1b3d-4e5f-9a7b-6c5d4e3f2a1b';
		const other = URI.file('/work/other').fsPath;
		const target = other.startsWith('\\') ? 'C:' + other : other; // a link only names an absolute path: give the Windows one a drive
		const link = `klawly://agent/import?session=${id}&folder=${encodeURIComponent(target)}&handoff=Pick%20up%20the%20tests`;
		const elsewhere = entryFor(URI.file('/work/app').fsPath);
		await elsewhere.entry.handleURL(URI.parse(link));
		const stored = JSON.parse(elsewhere.storage.get(CLAUDE_CHAT_HANDOFF_KEY, StorageScope.APPLICATION)!);
		const here = entryFor(target);
		await here.entry.handleURL(URI.parse(link));
		const declined = entryFor(target, { confirmed: false });
		await declined.entry.handleURL(URI.parse(link));
		const missing = entryFor(target, { folderExists: false });
		await missing.entry.handleURL(URI.parse(link));
		const badId = entryFor(target);
		const badIdHandled = await badId.entry.handleURL(URI.parse(`klawly://agent/import?session=not-a-uuid&folder=${encodeURIComponent(target)}`));
		const notice = 'info This chat continues a Claude Code session from the terminal. Its earlier turns are shown there, and Claude remembers them here.';
		assert.deepStrictEqual({
			elsewhere: elsewhere.calls,
			stored: [stored.resume, stored.prompt, stored.folder],
			here: here.calls,
			declined: [declined.calls, declined.storage.get(CLAUDE_CHAT_HANDOFF_KEY, StorageScope.APPLICATION)],
			missing: missing.calls.map(call => call.slice(0, 39)),
			badId: [badIdHandled, badId.calls],
		}, {
			elsewhere: [`open window ${URI.file(target).fsPath}`],
			stored: [id, 'Pick up the tests', target],
			here: [`continue ${id} as From the Terminal`, 'draft Pick up the tests', notice],
			declined: [[], undefined],
			missing: ['warn That link names a folder that does'],
			badId: [false, []],
		});
	});

	test('the window opened for an import takes it once and continues the session there (issue 1186)', () => {
		const id = '0f8e2a4c-1b3d-4e5f-9a7b-6c5d4e3f2a1b';
		const folder = URI.file('/work/app').fsPath;
		const storage = store.add(new InMemoryStorageService());
		storage.store(CLAUDE_CHAT_HANDOFF_KEY, serializeClaudeChatHandoff({ folder, prompt: '', resume: id, createdAt: Date.now() }), StorageScope.APPLICATION, 1);
		const mine = entryFor(folder, { storage });
		return new Promise<void>(resolve => setTimeout(resolve, 20)).then(() => {
			assert.deepStrictEqual([mine.calls.slice(0, 1), storage.get(CLAUDE_CHAT_HANDOFF_KEY, StorageScope.APPLICATION)], [[`continue ${id} as From the Terminal`], undefined]);
		});
	});

	test('klawly chat --resume continues the session in this window\'s folder with the text as a draft, and refuses an id that is not a session id (issue 1186)', async () => {
		const id = '0f8e2a4c-1b3d-4e5f-9a7b-6c5d4e3f2a1b';
		const resumed = entryFor(URI.file('/work/app').fsPath);
		await resumed.entry.chat({ _: ['Carry', 'on'], resume: id.toUpperCase() });
		const bad = entryFor(URI.file('/work/app').fsPath);
		await bad.entry.chat({ _: [], resume: '../../etc' });
		assert.deepStrictEqual({ resumed: resumed.calls.slice(0, 2), bad: bad.calls.map(call => call.split(':')[0]) }, {
			resumed: [`continue ${id} as From the Terminal`, 'draft Carry on'],
			bad: ['warn That is not a Claude Code session id'],
		});
	});

	test('a window for the folder takes the waiting prompt once into a new chat composer, and other windows and stale prompts leave it alone (issue 861)', () => {
		const folder = URI.file('/work/app').fsPath;
		const fresh = serializeClaudeChatHandoff({ folder, prompt: 'Fix it', mode: 'ask', createdAt: Date.now() });
		const stale = serializeClaudeChatHandoff({ folder, prompt: 'Old', createdAt: Date.now() - 10 * 60 * 1000 });
		const seed = (raw: string) => {
			const storage = store.add(new InMemoryStorageService());
			storage.store(CLAUDE_CHAT_HANDOFF_KEY, raw, StorageScope.APPLICATION, 1);
			return storage;
		};
		const mine = entryFor(folder, { storage: seed(fresh) });
		const elsewhere = entryFor(URI.file('/work/other').fsPath, { storage: seed(fresh) });
		const old = entryFor(folder, { storage: seed(stale) });
		return new Promise<void>(resolve => setTimeout(resolve, 20)).then(() => {
			assert.deepStrictEqual({
				mine: [mine.calls, mine.storage.get(CLAUDE_CHAT_HANDOFF_KEY, StorageScope.APPLICATION)],
				elsewhere: [elsewhere.calls, elsewhere.storage.get(CLAUDE_CHAT_HANDOFF_KEY, StorageScope.APPLICATION) !== undefined],
				old: old.calls,
			}, {
				mine: [['create', 'mode ask', 'draft Fix it'], undefined],
				elsewhere: [[], true],
				old: [],
			});
		});
	});
});
