/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ExtUri, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { planFileKey } from '../../../../../platform/claude/common/claudePlanDocument.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { ClaudePlanLinks, IClaudePlanLinks } from '../../../../services/claude/common/claudePlanLinks.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { TestPathService } from '../../../../test/browser/workbenchTestServices.js';
import { TestContextService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { migrateLegacyPlans, planEditorGlobs, registerClaudePlanEditor } from '../../browser/plan/claudePlan.contribution.js';
import { CLAUDE_OPEN_CHAT_PLAN_COMMAND_ID, CLAUDE_SAVE_PLAN_TO_WORKSPACE_COMMAND_ID } from '../../browser/plan/claudePlanCommands.js';

/** Where plan files live (issue 322): `~/<data folder>/plans` by default, the workspace's `.claude/plans` once saved there. */
suite('Claude plan storage', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const repo = URI.file('/repo');
	const userPlans = URI.file('/home/me/.klawly-test/plans');
	const name = `add-expiry-${planFileKey('s1', 't1')}.plan.md`;
	let instantiation: TestInstantiationService;
	let files: FileService;
	let opened: string[];
	let replaced: string[];
	let written: string[];
	let infos: string[];
	let confirm: boolean;

	suiteSetup(() => {
		if (!CommandsRegistry.getCommand(CLAUDE_SAVE_PLAN_TO_WORKSPACE_COMMAND_ID)) {
			registerClaudePlanEditor();
		}
	});

	setup(() => {
		opened = [];
		replaced = [];
		written = [];
		infos = [];
		confirm = true;
		files = store.add(new FileService(new NullLogService()));
		store.add(files.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IFileService, files);
		instantiation.stub(IWorkspaceContextService, new TestContextService(testWorkspace(repo)));
		instantiation.stub(IPathService, new TestPathService(URI.file('/home/me')));
		instantiation.stub(IProductService, { dataFolderName: '.klawly-test' } as IProductService);
		instantiation.stub(IUriIdentityService, store.add(new UriIdentityService(files)));
		instantiation.stub(IClaudePlanLinks, store.add(new ClaudePlanLinks(store.add(new TestStorageService()))));
		instantiation.stub(INotificationService, new class extends TestNotificationService {
			override info(message: string) {
				infos.push(message);
				return super.info(message);
			}
		}());
		instantiation.stub(IDialogService, { confirm: async () => ({ confirmed: confirm }) } as unknown as IDialogService);
		instantiation.stub(ITextFileService, { isDirty: () => false } as unknown as ITextFileService);
		instantiation.stub(IClaudeAgentService, {
			getSessions: () => [{ id: 's1', title: 'Plan expiry' }],
			getViewState: () => ({ turns: [{ id: 't1', plan: { title: 'Add expiry', steps: [] } }] }),
			writePlanFile: async (_sessionId: string, _turnId: string, target: URI) => {
				written.push(target.path);
				await files.writeFile(target, VSBuffer.fromString('# Add expiry\n'));
			},
		} as unknown as IClaudeAgentService);
		instantiation.stub(IEditorService, {
			activeEditor: undefined,
			findEditors: (resource: URI) => opened.includes(resource.path) ? [{ editor: { resource }, groupId: 1 }] : [],
			openEditor: async (editor: { resource: URI }) => { opened.push(editor.resource.path); return undefined; },
			replaceEditors: async (replacements: { replacement: { resource: URI } }[]) => { replaced.push(...replacements.map(entry => entry.replacement.resource.path)); },
		} as unknown as IEditorService);
	});

	async function run(id: string, ...args: unknown[]): Promise<void> {
		await instantiation.invokeFunction(accessor => CommandsRegistry.getCommand(id)!.handler(accessor, ...args));
	}

	async function listPaths(folder: URI): Promise<string[]> {
		return (await files.exists(folder)) ? ((await files.resolve(folder)).children ?? []).map(child => child.resource.path).sort() : [];
	}

	test('Open Plan writes a new plan to the user plan folder, never the workspace, and opens a plan already saved in the workspace from there', async () => {
		await run(CLAUDE_OPEN_CHAT_PLAN_COMMAND_ID, 's1', 't1', '');
		await run(CLAUDE_OPEN_CHAT_PLAN_COMMAND_ID, 's1', 't1', '');
		const saved = joinPath(repo, '.klawly', 'plans', name);
		await files.writeFile(saved, VSBuffer.fromString('# Add expiry, saved\n'));
		await run(CLAUDE_OPEN_CHAT_PLAN_COMMAND_ID, 's1', 't1', '');
		const user = joinPath(userPlans, name).path;
		assert.deepStrictEqual({
			written,
			opened,
			author: instantiation.get(IClaudePlanLinks).author(saved)?.sessionId,
		}, {
			written: [user],
			opened: [user, user, saved.path],
			author: 's1',
		});
	});

	test('Open Plan finds the file of a plan opened while its title still began with "Plan:", and writes no fresh copy', async () => {
		const legacy = joinPath(userPlans, `plan-add-expiry-${planFileKey('s1', 't1')}.plan.md`);
		await files.writeFile(legacy, VSBuffer.fromString('# Plan: Add expiry\n\n- [x] Ticked\n'));
		await run(CLAUDE_OPEN_CHAT_PLAN_COMMAND_ID, 's1', 't1', '');
		assert.deepStrictEqual({ written, opened, plans: await listPaths(userPlans) }, { written: [], opened: [legacy.path], plans: [legacy.path] });
	});

	test('Save Plan to Workspace moves the plan into .claude/plans with its chat links and swaps its editor', async () => {
		await run(CLAUDE_OPEN_CHAT_PLAN_COMMAND_ID, 's1', 't1', '');
		const source = joinPath(userPlans, name);
		const target = joinPath(repo, '.claude', 'plans', name);
		await run(CLAUDE_SAVE_PLAN_TO_WORKSPACE_COMMAND_ID, source);
		// Saving the workspace copy again changes nothing.
		await run(CLAUDE_SAVE_PLAN_TO_WORKSPACE_COMMAND_ID, target);
		assert.deepStrictEqual({
			user: await listPaths(userPlans),
			workspace: await listPaths(joinPath(repo, '.claude', 'plans')),
			content: (await files.readFile(target)).value.toString(),
			links: instantiation.get(IClaudePlanLinks).links(target),
			sourceLinks: instantiation.get(IClaudePlanLinks).links(source),
			replaced,
		}, {
			user: [],
			workspace: [target.path],
			content: '# Add expiry\n',
			links: [{ sessionId: 's1', title: 'Plan expiry', role: 'author' }],
			sourceLinks: [],
			replaced: [target.path],
		});
	});

	test('Save Plan to Workspace copies a plan from outside the user plan folder and never deletes it', async () => {
		const source = URI.file('/home/me/.claude/plans/refactor.md');
		const target = joinPath(repo, '.claude', 'plans', 'refactor.md');
		await files.writeFile(source, VSBuffer.fromString('# Refactor\n'));
		instantiation.get(IClaudePlanLinks).link(source, { sessionId: 's1', title: 'Plan expiry', role: 'author' });
		await run(CLAUDE_SAVE_PLAN_TO_WORKSPACE_COMMAND_ID, source);
		const links = instantiation.get(IClaudePlanLinks);
		assert.deepStrictEqual({
			source: (await files.readFile(source)).value.toString(),
			target: (await files.readFile(target)).value.toString(),
			links: [links.links(source).length, links.links(target).length],
			infos,
		}, {
			source: '# Refactor\n',
			target: '# Refactor\n',
			links: [1, 1],
			infos: ['Saved a copy of refactor.md in the workspace. The original is not in Klawly\'s plans folder, so it stays where it is.'],
		});
	});

	test('Save Plan to Workspace moves a plan whose path differs from the plan folder only in case, where the file system ignores case (Windows drive letters)', async () => {
		instantiation.stub(IUriIdentityService, new class extends mock<IUriIdentityService>() {
			override readonly extUri = new ExtUri(() => true);
		});
		// Claude is handed the plan folder as an fsPath, which lowercases the drive letter of the home folder.
		const source = URI.file('/HOME/me/.klawly-test/plans/lower.plan.md');
		await files.writeFile(source, VSBuffer.fromString('# Lower\n'));
		await run(CLAUDE_SAVE_PLAN_TO_WORKSPACE_COMMAND_ID, source);
		assert.deepStrictEqual({
			source: await files.exists(source),
			workspace: await listPaths(joinPath(repo, '.claude', 'plans')),
			infos,
		}, {
			source: false,
			workspace: [joinPath(repo, '.claude', 'plans', 'lower.plan.md').path],
			infos: [],
		});
	});

	test('the plan editor opens Markdown in the user plan folder of this build, also in a dev build (issue 322)', () => {
		assert.deepStrictEqual([planEditorGlobs('.klawly'), planEditorGlobs('.klawly-dev')], [
			['**/*.plan.md', '**/.claude/plans/*.md', '**/.klawly/plans/*.md'],
			['**/*.plan.md', '**/.claude/plans/*.md', '**/.klawly/plans/*.md', '**/.klawly-dev/plans/*.md'],
		]);
	});

	test('Save Plan to Workspace asks before replacing a workspace plan of the same name, and keeps both when declined', async () => {
		await run(CLAUDE_OPEN_CHAT_PLAN_COMMAND_ID, 's1', 't1', '');
		const source = joinPath(userPlans, name);
		const target = joinPath(repo, '.claude', 'plans', name);
		await files.writeFile(target, VSBuffer.fromString('# Older plan\n'));
		confirm = false;
		await run(CLAUDE_SAVE_PLAN_TO_WORKSPACE_COMMAND_ID, source);
		const declined = [(await files.readFile(target)).value.toString(), await files.exists(source)];
		confirm = true;
		await run(CLAUDE_SAVE_PLAN_TO_WORKSPACE_COMMAND_ID, source);
		assert.deepStrictEqual([declined, [(await files.readFile(target)).value.toString(), await files.exists(source)]], [['# Older plan\n', true], ['# Add expiry\n', false]]);
	});

	test('Open Plan finds a plan saved in the new .claude/plans folder', async () => {
		const saved = joinPath(repo, '.claude', 'plans', name);
		await files.writeFile(saved, VSBuffer.fromString('# Add expiry, saved\n'));
		await run(CLAUDE_OPEN_CHAT_PLAN_COMMAND_ID, 's1', 't1', '');
		assert.deepStrictEqual({ written, opened }, { written: [], opened: [saved.path] });
	});

	test('the legacy .klawly/plans folder moves to .claude/plans with chat links, keeps a plan whose name is taken, and is removed once empty', async () => {
		const links = instantiation.get(IClaudePlanLinks);
		const legacy = joinPath(repo, '.klawly', 'plans');
		const current = joinPath(repo, '.claude', 'plans');
		await files.writeFile(joinPath(legacy, 'a.plan.md'), VSBuffer.fromString('# A\n'));
		await files.writeFile(joinPath(legacy, 'b.md'), VSBuffer.fromString('# B legacy\n'));
		await files.writeFile(joinPath(current, 'b.md'), VSBuffer.fromString('# B current\n'));
		links.link(joinPath(legacy, 'a.plan.md'), { sessionId: 's9', title: 'Chat', role: 'author' });
		const first = await migrateLegacyPlans(files, links, repo);
		const afterFirst = {
			moved: first.map(uri => uri.path),
			legacy: await listPaths(legacy),
			current: await listPaths(current),
			kept: (await files.readFile(joinPath(current, 'b.md'))).value.toString(),
			author: links.author(joinPath(current, 'a.plan.md'))?.sessionId,
		};
		await files.del(joinPath(legacy, 'b.md'));
		const second = await migrateLegacyPlans(files, links, repo);
		assert.deepStrictEqual({ afterFirst, second: second.length, klawlyFolder: await files.exists(joinPath(repo, '.klawly')) }, {
			afterFirst: { moved: [joinPath(current, 'a.plan.md').path], legacy: [joinPath(legacy, 'b.md').path], current: [joinPath(current, 'a.plan.md').path, joinPath(current, 'b.md').path], kept: '# B current\n', author: 's9' },
			second: 0,
			klawlyFolder: false,
		});
	});
});
