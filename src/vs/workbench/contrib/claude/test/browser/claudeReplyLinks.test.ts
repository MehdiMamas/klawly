/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ExtUri, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { TestClipboardService } from '../../../../../platform/clipboard/test/common/testClipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IResourceEditorInput, ITextEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../../../services/claude/common/claudeAgentState.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { TestPathService, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ClaudeTimelineRenderer } from '../../browser/chat/claudeTimelineRenderer.js';
import { CLAUDE_PLAN_EDITOR_ID } from '../../browser/plan/claudePlanCommands.js';
import { silentTendService } from './claudeGitHubTestUtils.js';
import { IClaudeTendPullRequestService } from '../../browser/chat/claudeTendPullRequest.js';

const REPLY = [
	'Read `SPEC.md`, then `src/words.js:3` and the `src/` folder. `missing.ts` is not there yet. Run `npm test`.',
	'See [the words](src/words.js#L2), [the spec](./SPEC.md) and [the docs](https://example.com/docs).',
	'```\nSPEC.md\n```',
].join('\n\n');

suite('Claude reply links', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('code chips and links that name workspace files open them; other chips, code blocks and missing paths stay plain', async () => {
		const opened: string[] = [];
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IClaudeTendPullRequestService, silentTendService());
		const folder = instantiationService.get(IWorkspaceContextService).getWorkspace().folders[0].uri;
		const relative = (resource: URI) => resource.path.slice(folder.path.length + 1);
		const existing = new Map([['SPEC.md', false], ['src/words.js', false], ['src', true]]);
		instantiationService.stub(IClipboardService, new TestClipboardService());
		instantiationService.stub(INotificationService, new TestNotificationService());
		instantiationService.stub(IFileService, 'stat', async (resource: URI) => {
			const isDirectory = existing.get(relative(resource));
			if (isDirectory === undefined) {
				throw new Error('missing');
			}
			return { resource, isDirectory };
		});
		instantiationService.stub(IEditorService, 'openEditor', async (input: IResourceEditorInput) => {
			const selection = (input.options as ITextEditorOptions | undefined)?.selection;
			opened.push(`open ${relative(input.resource)}${selection ? `:${selection.startLineNumber}` : ''}`);
			return undefined;
		});
		instantiationService.stub(ICommandService, { executeCommand: async (id: string, resource: URI) => { opened.push(`${id} ${relative(resource)}`); return undefined; } });
		instantiationService.stub(IOpenerService, { open: async (target: URI | string) => { opened.push(`web ${target.toString()}`); return true; } });
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
		let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text: 'What is here?' });
		state = reduceAgentState(state, { type: 'assistant.completed', sessionId: 's', text: REPLY });
		renderer.render(state);
		await new Promise(resolve => setTimeout(resolve, 0));

		const links = [...root.querySelectorAll<HTMLElement>('.claude-file-link')];
		const anchors = [...root.querySelectorAll<HTMLElement>('a[data-href]')];
		for (const link of [...links, ...anchors]) {
			link.click();
		}
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual({
			links: links.map(link => `${link.tagName.toLowerCase()} ${link.textContent} ${link.getAttribute('role')} ${link.tabIndex}`),
			anchors: anchors.map(anchor => anchor.textContent),
			opened: opened.sort(),
		}, {
			links: ['code SPEC.md link 0', 'code src/words.js:3 link 0', 'code src/ link 0'],
			anchors: ['the words', 'the spec', 'the docs'],
			opened: [
				'open SPEC.md',
				'open SPEC.md',
				'open src/words.js:2',
				'open src/words.js:3',
				'revealInExplorer src',
				'web https://example.com/docs',
			],
		});
	});

	test('shell code blocks and inline commands run in the terminal only on a click, in the session folder; other code has no Run button (issue 733)', async () => {
		const ran: string[] = [];
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IClaudeTendPullRequestService, silentTendService());
		instantiationService.stub(IClipboardService, new TestClipboardService());
		instantiationService.stub(INotificationService, new TestNotificationService());
		instantiationService.stub(IFileService, 'stat', async () => { throw new Error('missing'); });
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
			rerunCommand: (command, cwd) => { ran.push(`${cwd}: ${command}`); },
			openCommandLog: () => undefined,
			workingDirectory: () => '/repo',
		}));
		const reply = [
			'Stop the server with `kill 8284`, then run `npm run lint && npm test`. `totals()` is unchanged.',
			'```bash\nnpm install\nnpm test\n```',
			'```console\n$ git status\nOn branch main\n```',
			'```typescript\nconst total = totals();\n```',
		].join('\n\n');
		let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text: 'How do I test it?' });
		state = reduceAgentState(state, { type: 'assistant.completed', sessionId: 's', text: reply });
		renderer.render(state);
		await new Promise(resolve => setTimeout(resolve, 0));

		const label = (button: Element) => button.getAttribute('aria-label');
		const inline = [...root.querySelectorAll<HTMLElement>('.claude-inline-command')];
		const blocks = [...root.querySelectorAll<HTMLElement>('.claude-codeblock-header')].map(header => [...header.querySelectorAll('button')].map(label)[0]);
		const ranBeforeClick = ran.length;
		const buttons = [...root.querySelectorAll<HTMLElement>('button')].filter(button => button.querySelector('.codicon-terminal'));
		for (const button of buttons) {
			button.click();
		}
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual({
			inline: inline.map(holder => `${holder.querySelector('code')?.textContent} | ${label(holder.querySelector('.claude-inline-run')!)}`),
			blocks,
			ranBeforeClick,
			ran,
		}, {
			inline: ['kill 8284 | Run kill 8284 in Terminal', 'npm run lint && npm test | Run npm run lint && npm test in Terminal'],
			blocks: ['Run in Terminal', 'Run in Terminal', 'Insert at cursor'],
			ranBeforeClick: 0,
			ran: ['/repo: kill 8284', '/repo: npm run lint && npm test', '/repo: npm install\nnpm test', '/repo: git status'],
		});
	});

	test('a session working in a git worktree links the worktree files, and the main checkout only for files the worktree lacks (issue 321)', async () => {
		const opened: string[] = [];
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IClaudeTendPullRequestService, silentTendService());
		const folder = instantiationService.get(IWorkspaceContextService).getWorkspace().folders[0].uri;
		const relative = (resource: URI) => resource.path.slice(folder.path.length + 1);
		const existing = new Set(['SPEC.md', 'README.md', 'src/words.js', '.worktrees/wt/.git', '.worktrees/wt/SPEC.md', '.worktrees/wt/src/words.js', '.worktrees/wt/src/stats.js']);
		instantiationService.stub(IClipboardService, new TestClipboardService());
		instantiationService.stub(INotificationService, new TestNotificationService());
		instantiationService.stub(IFileService, 'stat', async (resource: URI) => {
			if (!existing.has(relative(resource))) {
				throw new Error('missing');
			}
			return { resource, isDirectory: false };
		});
		instantiationService.stub(IEditorService, 'openEditor', async (input: IResourceEditorInput) => {
			const selection = (input.options as ITextEditorOptions | undefined)?.selection;
			opened.push(`${relative(input.resource)}${selection ? `:${selection.startLineNumber}` : ''}`);
			return undefined;
		});
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
		const stats = joinPath(folder, '.worktrees', 'wt', 'src', 'stats.js').fsPath;
		let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text: 'Work in the worktree' });
		state = reduceAgentState(state, { type: 'tool.started', sessionId: 's', call: { id: 'e1', name: 'Write', category: 'write', input: {}, display: { label: 'Write', file: stats } } });
		state = reduceAgentState(state, { type: 'tool.completed', sessionId: 's', callId: 'e1', result: { ok: true } });
		state = reduceAgentState(state, { type: 'assistant.completed', sessionId: 's', text: 'Changed `SPEC.md`, `src/words.js:3` and `README.md`; see src/stats.js:2.' });
		renderer.render(state);
		for (let tick = 0; tick < 10; tick++) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}

		for (const link of root.querySelectorAll<HTMLElement>('.claude-msg-assistant .claude-file-link')) {
			link.click();
		}
		for (let tick = 0; tick < 10; tick++) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}

		assert.deepStrictEqual(opened.sort(), [
			'.worktrees/wt/SPEC.md',
			'.worktrees/wt/src/stats.js:2',
			'.worktrees/wt/src/words.js:3',
			'README.md',
		]);
	});

	test('a file the session only read in a git worktree links the worktree, while a read in another checkout or a submodule does not take the workspace paths over (issue 321)', async () => {
		const opened: string[] = [];
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IClaudeTendPullRequestService, silentTendService());
		const folder = instantiationService.get(IWorkspaceContextService).getWorkspace().folders[0].uri;
		const relative = (resource: URI) => resource.path.slice(folder.path.length + 1);
		// A linked worktree's `.git` is a file that points into `.git/worktrees`; a submodule's points
		// into `.git/modules`; another clone's is a folder.
		const existing = new Map([
			['src/words.js', false], ['README.md', false],
			['.worktrees/wt/.git', false], ['.worktrees/wt/src/words.js', false], ['.worktrees/wt/src/stats.js', false],
			['other/.git', true], ['other/src/words.js', false], ['other/README.md', false], ['other/lib/only.js', false],
			['vendor/lib/.git', false], ['vendor/lib/src/words.js', false], ['vendor/lib/README.md', false],
		]);
		const gitFiles = new Map([
			['.worktrees/wt/.git', 'gitdir: C:\\repo\\.git\\worktrees\\wt\n'],
			['vendor/lib/.git', 'gitdir: ../../.git/modules/vendor/lib\n'],
		]);
		instantiationService.stub(IClipboardService, new TestClipboardService());
		instantiationService.stub(INotificationService, new TestNotificationService());
		instantiationService.stub(IFileService, 'stat', async (resource: URI) => {
			const isDirectory = existing.get(relative(resource));
			if (isDirectory === undefined) {
				throw new Error('missing');
			}
			return { resource, isDirectory };
		});
		instantiationService.stub(IFileService, 'readFile', async (resource: URI) => {
			const text = gitFiles.get(relative(resource));
			if (text === undefined) {
				throw new Error('missing');
			}
			return { resource, value: VSBuffer.fromString(text) };
		});
		instantiationService.stub(IEditorService, 'openEditor', async (input: IResourceEditorInput) => {
			opened.push(relative(input.resource));
			return undefined;
		});
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
		let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text: 'Work in the worktree' });
		for (const [id, file] of [['r1', joinPath(folder, 'other', 'src', 'words.js')], ['r2', joinPath(folder, '.worktrees', 'wt', 'src', 'words.js')], ['r3', joinPath(folder, 'vendor', 'lib', 'src', 'words.js')]] as const) {
			state = reduceAgentState(state, { type: 'tool.started', sessionId: 's', call: { id, name: 'Read', category: 'read', input: {}, display: { label: 'Read', file: file.fsPath } } });
			state = reduceAgentState(state, { type: 'tool.completed', sessionId: 's', callId: id, result: { ok: true } });
		}
		state = reduceAgentState(state, { type: 'assistant.completed', sessionId: 's', text: 'Edit `src/words.js` and `README.md`; only the worktree has `src/stats.js`, only the other checkout `lib/only.js`.' });
		renderer.render(state);
		for (let tick = 0; tick < 10; tick++) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}

		for (const link of root.querySelectorAll<HTMLElement>('.claude-msg-assistant .claude-file-link')) {
			link.click();
		}
		for (let tick = 0; tick < 10; tick++) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}

		assert.deepStrictEqual(opened.sort(), [
			'.worktrees/wt/src/stats.js',
			'.worktrees/wt/src/words.js',
			'README.md',
			'other/lib/only.js',
		]);
	});

	test('paths in Klawly\'s plan folder link and open in the plan editor; other home paths and folders outside the workspace stay plain (issues 321, 322)', async () => {
		const opened: string[] = [];
		const infos: string[] = [];
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IClaudeTendPullRequestService, silentTendService());
		const existing = new Map([['/home/me/.klawly-dev/plans', true], ['/home/me/.klawly-dev/plans/fix-a1b2.plan.md', false], ['/home/me/.klawly-dev/plans/notes.md', false], ['/home/me/.claude/settings.json', false], ['/home/me/other.md', false]]);
		instantiationService.stub(IPathService, new TestPathService(URI.file('/home/me')));
		instantiationService.stub(IProductService, { ...instantiationService.get(IProductService), dataFolderName: '.klawly-dev' });
		instantiationService.stub(IClipboardService, new TestClipboardService());
		instantiationService.stub(INotificationService, new class extends TestNotificationService {
			override info(message: string) {
				infos.push(message);
				return super.info(message);
			}
		});
		instantiationService.stub(IFileService, 'stat', async (resource: URI) => {
			const isDirectory = existing.get(resource.path);
			if (isDirectory === undefined) {
				throw new Error('missing');
			}
			return { resource, isDirectory };
		});
		instantiationService.stub(ICommandService, { executeCommand: async (id: string, resource: URI) => { opened.push(`${resource.path} ${id}`); return undefined; } });
		instantiationService.stub(IEditorService, 'openEditor', async (input: IResourceEditorInput) => {
			opened.push(`${input.resource.path} ${input.options?.override}`);
			return undefined;
		});
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
		let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text: 'Plan it' });
		state = reduceAgentState(state, { type: 'assistant.completed', sessionId: 's', text: 'Wrote `~/.klawly-dev/plans/fix-a1b2.plan.md` and `/home/me/.klawly-dev/plans/notes.md:3` in `~/.klawly-dev/plans/`; see [the plan](~/.klawly-dev/plans/fix-a1b2.plan.md) and [the folder](~/.klawly-dev/plans/). `~/.claude/settings.json` and `/home/me/other.md` are not plans.' });
		renderer.render(state);
		for (let tick = 0; tick < 10; tick++) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}

		const links = [...root.querySelectorAll<HTMLElement>('.claude-msg-assistant .claude-file-link'), ...root.querySelectorAll<HTMLElement>('.claude-msg-assistant a[data-href]')];
		for (const link of links) {
			link.click();
		}
		for (let tick = 0; tick < 10; tick++) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}

		assert.deepStrictEqual({ links: links.map(link => link.textContent), opened: opened.sort(), infos }, {
			links: ['~/.klawly-dev/plans/fix-a1b2.plan.md', '/home/me/.klawly-dev/plans/notes.md:3', 'the plan', 'the folder'],
			opened: [
				`/home/me/.klawly-dev/plans/fix-a1b2.plan.md ${CLAUDE_PLAN_EDITOR_ID}`,
				`/home/me/.klawly-dev/plans/fix-a1b2.plan.md ${CLAUDE_PLAN_EDITOR_ID}`,
				`/home/me/.klawly-dev/plans/notes.md ${CLAUDE_PLAN_EDITOR_ID}`,
			],
			infos: ['~/.klawly-dev/plans is a folder outside the open workspace.'],
		});
	});

	test('a plan path that differs from the plan folder only in drive-letter case links where the file system ignores case (Windows)', async () => {
		const opened: string[] = [];
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IClaudeTendPullRequestService, silentTendService());
		// Claude is handed the plan folder as an fsPath (`c:\`), while the home folder is `C:\`.
		instantiationService.stub(IPathService, new TestPathService(URI.file('C:/Users/me')));
		instantiationService.stub(IProductService, { ...instantiationService.get(IProductService), dataFolderName: '.klawly-dev' });
		instantiationService.stub(IUriIdentityService, new class extends mock<IUriIdentityService>() {
			override readonly extUri = new ExtUri(() => true);
		});
		instantiationService.stub(IClipboardService, new TestClipboardService());
		instantiationService.stub(INotificationService, new TestNotificationService());
		instantiationService.stub(IFileService, 'stat', async (resource: URI) => {
			if (resource.path.toLowerCase() !== '/c:/users/me/.klawly-dev/plans/fix-a1b2.plan.md') {
				throw new Error('missing');
			}
			return { resource, isDirectory: false };
		});
		instantiationService.stub(IEditorService, 'openEditor', async (input: IResourceEditorInput) => {
			opened.push(`${input.resource.path} ${input.options?.override}`);
			return undefined;
		});
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
		let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text: 'Plan it' });
		state = reduceAgentState(state, { type: 'assistant.completed', sessionId: 's', text: 'Wrote `c:/Users/me/.klawly-dev/plans/fix-a1b2.plan.md`.' });
		renderer.render(state);
		for (let tick = 0; tick < 10; tick++) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}

		for (const link of root.querySelectorAll<HTMLElement>('.claude-msg-assistant .claude-file-link')) {
			link.click();
		}
		for (let tick = 0; tick < 10; tick++) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}

		assert.deepStrictEqual(opened, [`/c:/Users/me/.klawly-dev/plans/fix-a1b2.plan.md ${CLAUDE_PLAN_EDITOR_ID}`]);
	});
});
