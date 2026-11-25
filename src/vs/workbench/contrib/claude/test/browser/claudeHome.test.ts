/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeRuntimeState, IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { ClaudeAccountOverview } from '../../../../../platform/claude/common/claudeAccount.js';
import { NormalizedClaudeEvent } from '../../../../../platform/claude/common/claudeProtocol.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IOpenWindowOptions, isFolderToOpen, IWindowOpenable } from '../../../../../platform/window/common/window.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { IRecent, IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';
import { EditorGroupWatermark } from '../../../../browser/parts/editor/editorGroupWatermark.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ClaudeEditorWatermark, middleTruncatePath, registerClaudeEditorWatermark } from '../../browser/home/claudeHome.js';

suite('Klawly Home and watermark', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let instantiation: TestInstantiationService;
	let state: ClaudeRuntimeState;
	let overview: ClaudeAccountOverview;
	let recents: IRecent[];
	let missing: string[];
	let ran: unknown[][];
	let opened: [string, boolean][];
	let runtimeChanges: Emitter<ClaudeRuntimeState>;

	setup(() => {
		state = { installed: true, authenticated: true, version: '2.1.281', authMode: 'claude-account' };
		overview = { live: true, account: { email: 'someone@example.invalid', plan: 'max' } };
		recents = [];
		missing = [];
		ran = [];
		opened = [];
		instantiation = workbenchInstantiationService(undefined, store);
		runtimeChanges = store.add(new Emitter<ClaudeRuntimeState>());
		const runtimeEvents = store.add(new Emitter<NormalizedClaudeEvent>());
		instantiation.stub(IClaudeRuntimeService, {
			onDidChangeRuntimeState: runtimeChanges.event,
			onDidEmitEvent: runtimeEvents.event,
			getRuntimeState: async () => state,
			getAccountOverview: async () => overview,
		} as unknown as IClaudeRuntimeService);
		instantiation.stub(IWorkspacesService, {
			onDidChangeRecentlyOpened: Event.None,
			getRecentlyOpened: async () => ({ workspaces: recents, files: [] }),
		} as unknown as IWorkspacesService);
		instantiation.stub(IFileService, { exists: async (resource: URI) => !missing.includes(resource.path) } as unknown as IFileService);
		instantiation.stub(IHostService, {
			openWindow: async (toOpen: IWindowOpenable[], options?: IOpenWindowOptions) => {
				const target = toOpen[0];
				opened.push([isFolderToOpen(target) ? target.folderUri.path : '', !!options?.forceNewWindow]);
			},
		} as unknown as IHostService);
		instantiation.stub(ICommandService, { executeCommand: async (...args: unknown[]) => { ran.push(args); return undefined; } } as unknown as ICommandService);
		instantiation.stub(IProductService, { nameShort: 'Klawly' } as IProductService);
		// Only some commands have keys, as in a real keymap, labeled the way this platform labels them.
		// allow-any-unicode-next-line
		const keys: Record<string, string> = isMacintosh ? { 'workbench.action.quickOpen': '⌘P', 'claude.focusAgent': '⌃⌥A', 'workbench.action.showCommands': '⇧⌘P' } : { 'workbench.action.quickOpen': 'Ctrl+P', 'claude.focusAgent': 'Ctrl+Alt+A', 'workbench.action.showCommands': 'Ctrl+Shift+P' };
		instantiation.stub(IKeybindingService, {
			onDidUpdateKeybindings: Event.None,
			lookupKeybinding: (id: string) => keys[id] ? { getLabel: () => keys[id] } : undefined,
		} as unknown as IKeybindingService);
		for (const id of ['claude.newSession', 'claude.focusAgent', 'workbench.action.quickOpen', 'workbench.action.showCommands']) {
			if (!CommandsRegistry.getCommand(id)) {
				store.add(CommandsRegistry.registerCommand(id, () => undefined));
			}
		}
	});

	async function settle(): Promise<void> {
		await new Promise(resolve => setTimeout(resolve, 0));
		await new Promise(resolve => setTimeout(resolve, 0));
	}

	function render(workbenchState: WorkbenchState) {
		const container = document.createElement('div');
		document.body.appendChild(container);
		store.add({ dispose: () => container.remove() });
		store.add(instantiation.createInstance(ClaudeEditorWatermark, container, workbenchState));
		const texts = (selector: string) => [...container.querySelectorAll(selector)].map(element => element.textContent ?? '');
		const click = (selector: string) => container.querySelector<HTMLElement>(selector)!.click();
		return { container, texts, click };
	}

	function folder(path: string): IRecent {
		return { folderUri: URI.file(path), label: path };
	}

	test('an empty window opens on Home: the account, four starts and the five most recent projects', async () => {
		recents = ['/work/alpha', '/work/beta', '/src/gamma', '/src/delta', '/src/epsilon', '/src/zeta'].map(folder);
		const { texts, click, container } = render(WorkbenchState.EMPTY);
		await settle();
		click('[data-command="git.clone"]');
		click('.claude-home-account .claude-home-link');
		click('.claude-home-recent-head .claude-home-link');
		const second = container.querySelectorAll<HTMLElement>('.claude-home-recent-item')[1];
		second.dispatchEvent(new MouseEvent('click', { ctrlKey: true }));
		assert.deepStrictEqual({
			name: texts('.claude-home-name'),
			mark: !!container.querySelector('img.claude-home-mark')?.getAttribute('src')?.endsWith('klawly-mark.svg'),
			account: texts('.claude-home-account > *'),
			starts: texts('.claude-home-start .label'),
			recentHead: texts('.claude-home-recent-head > *'),
			recent: [...container.querySelectorAll('.claude-home-recent-item')].map(item => [item.querySelector('.name')!.textContent, item.querySelector('.path')!.textContent]),
			hint: texts('.claude-home-hint'),
			ran,
			opened,
		}, {
			name: ['Klawly'],
			mark: true,
			account: ['Max Plan', '', 'Settings'],
			starts: ['Open Project', 'Clone Repository', 'New Agent', 'Agents Window'],
			recentHead: ['Recent Projects', 'Show All'],
			recent: [['alpha', '/work'], ['beta', '/work'], ['gamma', '/src'], ['delta', '/src'], ['epsilon', '/src']],
			hint: [],
			ran: [['git.clone'], ['claude.openSettings'], ['workbench.action.openRecent']],
			opened: [['/work/beta', true]],
		});
	});

	test('recent projects with one name differ by their path, and a folder that is gone is hidden (issue 995)', async () => {
		recents = ['/a/very/long/parent/folder/that/runs/deep/one/ws/demo', '/a/very/long/parent/folder/that/runs/deep/two/ws/demo', '/gone/demo'].map(folder);
		missing = ['/gone/demo'];
		const { container } = render(WorkbenchState.EMPTY);
		await settle();
		const rows = [...container.querySelectorAll('.claude-home-recent-item')];
		assert.deepStrictEqual(rows.map(row => [row.querySelector('.path')!.textContent, row.getAttribute('aria-label')]), [
			['/\u2026/folder/that/runs/deep/one/ws', 'Open demo in /a/very/long/parent/folder/that/runs/deep/one/ws/demo'],
			['/\u2026/folder/that/runs/deep/two/ws', 'Open demo in /a/very/long/parent/folder/that/runs/deep/two/ws/demo'],
		]);
	});

	test('middleTruncatePath keeps the root and the nearest folders, on either separator', () => {
		assert.deepStrictEqual([
			middleTruncatePath('/work', 36),
			middleTruncatePath('C:\\Users\\me\\Projects\\some\\deeply\\nested\\place', 20),
		], ['/work', 'C:\\\u2026\\nested\\place']);
	});

	test('Home asks for a sign-in until there is one, and has no recent list on a first run', async () => {
		state = { installed: true, authenticated: false };
		const { texts, click } = render(WorkbenchState.EMPTY);
		await settle();
		const before = { account: texts('.claude-home-account .plan'), hint: texts('.claude-home-hint > span'), recent: texts('.claude-home-recent > *') };
		click('.claude-home-hint');
		state = { installed: true, authenticated: true, authMode: 'claude-account' };
		runtimeChanges.fire(state);
		await settle();
		assert.deepStrictEqual({ before, ran, after: { account: texts('.claude-home-account .plan'), hint: texts('.claude-home-hint') } }, {
			before: { account: ['Signed out'], hint: ['Sign in to Claude Code to run agents.', 'Sign In'], recent: [] },
			ran: [['claude.signIn']],
			after: { account: ['Max Plan'], hint: [] },
		});
	});

	test('without Claude Code, Home offers Install and Check Again, and follows an install made elsewhere (issue 91)', async () => {
		state = { installed: false, authenticated: false };
		const { texts, click } = render(WorkbenchState.EMPTY);
		await settle();
		const before = { account: texts('.claude-home-account .plan'), slot: texts('.claude-home-hint-slot > *') };
		click('.claude-home-hint');
		click('.claude-home-hint-slot > .claude-home-link');
		state = { installed: true, authenticated: false };
		runtimeChanges.fire(state);
		await settle();
		assert.deepStrictEqual({ before, ran, after: { account: texts('.claude-home-account .plan'), slot: texts('.claude-home-hint-slot > *') } }, {
			before: { account: ['Not installed'], slot: ['Klawly runs your agents with Claude Code. Install it to start.Install', 'Check Again'] },
			ran: [['claude.installRuntime'], ['claude.redetectRuntime']],
			after: { account: ['Signed out'], slot: ['Sign in to Claude Code to run agents.Sign In'] },
		});
	});

	test('a project window shows the mark over shortcuts that run on click, through the editor group watermark', () => {
		instantiation.stub(IConfigurationService, new TestConfigurationService({ workbench: { tips: { enabled: true } } }));
		instantiation.stub(IWorkspaceContextService, {
			getWorkbenchState: () => WorkbenchState.FOLDER,
			onDidChangeWorkbenchState: Event.None,
		} as unknown as IWorkspaceContextService);
		const create = () => {
			const container = document.createElement('div');
			store.add(instantiation.createInstance(EditorGroupWatermark, container));
			return container;
		};
		const registration = registerClaudeEditorWatermark();
		const klawly = create();
		registration.dispose();
		instantiation.stub(IKeybindingService, { onDidUpdateKeybindings: Event.None, lookupKeybinding: () => undefined } as unknown as IKeybindingService);
		const stock = create();
		klawly.querySelector<HTMLElement>('[data-command="claude.focusAgent"]')!.click();
		assert.deepStrictEqual({
			contributed: !!klawly.querySelector('.editor-group-watermark.contributed .claude-watermark-mark'),
			shortcuts: [...klawly.querySelectorAll('.claude-watermark-shortcut')].map(row => [row.querySelector('.label')!.textContent, [...row.querySelectorAll('kbd')].map(key => key.textContent).join(' ')]),
			ran,
			stock: [stock.querySelector('.editor-group-watermark')!.classList.contains('contributed'), !!stock.querySelector('.claude-watermark')],
		}, {
			contributed: true,
			// allow-any-unicode-next-line
			shortcuts: isMacintosh ? [['New Agent', ''], ['Focus Agent', '⌃ ⌥ A'], ['Go to File', '⌘ P'], ['Show All Commands', '⇧ ⌘ P']] : [['New Agent', ''], ['Focus Agent', 'Ctrl Alt A'], ['Go to File', 'Ctrl P'], ['Show All Commands', 'Ctrl Shift P']],
			ran: [['claude.focusAgent']],
			stock: [false, false],
		});
	});
});
