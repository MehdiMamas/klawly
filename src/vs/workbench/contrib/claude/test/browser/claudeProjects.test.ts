/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseProjectFile } from '../../../../../platform/claude/common/claudeProject.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudeContextService } from '../../../../services/claude/common/claudeContextService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { TestPathService } from '../../../../test/browser/workbenchTestServices.js';
import { Event } from '../../../../../base/common/event.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IClaudeMultitaskService } from '../../../../services/claude/common/claudeMultitask.js';
import { ClaudeProjectIndex, ClaudeProjects } from '../../browser/claudeProjects.js';

suite('Claude projects (issue 496)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const folder = URI.file('/home/me/.klawly-test/projects');
	let files: FileService;
	let calls: string[];
	let sessions: { id: string }[];

	function projects(): ClaudeProjects {
		files = store.add(new FileService(new NullLogService()));
		store.add(files.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IFileService, files);
		instantiation.stub(IPathService, new TestPathService(URI.file('/home/me')));
		instantiation.stub(IProductService, { dataFolderName: '.klawly-test' } as IProductService);
		instantiation.stub(IViewsService, { openView: async (id: string) => { calls.push(`open ${id}`); return undefined; } } as unknown as IViewsService);
		instantiation.stub(IClaudeContextService, { preview: async (text: string, mode: string) => `[${mode}] ${text.split('\n')[0]}` } as unknown as IClaudeContextService);
		instantiation.stub(IClaudeAgentService, {
			createSession: () => { sessions.push({ id: `s${sessions.length + 1}` }); calls.push(`create s${sessions.length}`); return sessions[sessions.length - 1]; },
			getSessions: () => sessions,
			setMode: (id: string, mode: string) => { calls.push(`mode ${id} ${mode}`); },
			renameSession: async (id: string, title: string) => { calls.push(`rename ${id} ${title}`); },
			selectSession: (id: string) => { calls.push(`select ${id}`); },
			addAdditionalDirectory: (id: string, directory: string) => { calls.push(`folder ${id} ${URI.file(directory).path}`); },
			resume: async (id: string) => { calls.push(`resume ${id}`); if (id !== 'old') { throw new Error('gone'); } },
			submit: async (id: string, _text: string, cwd: string, options: { compiled: string; label: string }) => { calls.push(`submit ${id} ${cwd} ${options.label} | ${options.compiled}`); },
		} as unknown as IClaudeAgentService);
		return instantiation.createInstance(ClaudeProjects, () => Date.UTC(2026, 9, 13, 15));
	}

	setup(() => {
		calls = [];
		sessions = [];
	});

	test('New Project writes the project file and starts its coordinator chat in Plan mode', async () => {
		const service = projects();
		await files.writeFile(URI.joinPath(folder, 'add-dark-mode.json'), VSBuffer.fromString('not a project'));
		const created = await service.create('  Add dark mode  ', '/repo');
		const written = parseProjectFile((await files.readFile(created.resource)).value.toString());
		assert.deepStrictEqual({
			path: created.resource.path,
			written,
			calls,
			listed: (await service.list()).map(entry => entry.project.name),
			readme: (await files.readFile(URI.joinPath(folder, 'add-dark-mode-2.context', 'README.md'))).value.toString().split('\n')[0],
		}, {
			path: '/home/me/.klawly-test/projects/add-dark-mode-2.json',
			written: { version: 1, name: 'Add dark mode', goal: 'Add dark mode', folder: '/repo', createdAt: '2026-10-13T15:00:00.000Z', sessionId: 's1' },
			calls: [
				'create s1',
				'mode s1 plan',
				'folder s1 /home/me/.klawly-test/projects/add-dark-mode-2.context',
				'rename s1 Add dark mode',
				'select s1',
				'open claude.agentView',
				'submit s1 /repo Plan the project: Add dark mode | [plan] You coordinate a Klawly project. Its goal: Add dark mode',
			],
			listed: ['Add dark mode'],
			readme: '# Shared context: Add dark mode',
		});
	});

	test('Open Project selects an open chat, resumes a saved one, and says when it is gone', async () => {
		const service = projects();
		sessions.push({ id: 'open' });
		const entry = (sessionId?: string) => ({ resource: URI.joinPath(folder, 'p.json'), project: { version: 1 as const, name: 'P', goal: 'P', folder: '/repo', createdAt: '', ...(sessionId ? { sessionId } : {}) } });
		const results = [await service.open(entry('open')), await service.open(entry('old')), await service.open(entry('lost')), await service.open(entry())];
		assert.deepStrictEqual({ results, calls }, {
			results: [true, true, false, false],
			calls: [
				'folder open /home/me/.klawly-test/projects/p.context', 'select open', 'open claude.agentView',
				'resume old', 'folder old /home/me/.klawly-test/projects/p.context', 'select old', 'open claude.agentView',
				'resume lost',
			],
		});
	});

	test('issue 899: the project index names the project of its coordinator and of the agents it started', async () => {
		const service = projects();
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IClaudeMultitaskService, {
			onDidChange: Event.None,
			getGroups: (coordinator: string) => coordinator === 's1' ? [{ runs: [{ runSessionId: 'agent-a' }, { runSessionId: 'agent-b' }] }] : [],
		} as unknown as IClaudeMultitaskService);
		instantiation.stub(IInstantiationService, instantiation);
		const created = await service.create('Add dark mode', '/repo');
		const index = store.add(new ClaudeProjectIndex(Object.assign(instantiation, { createInstance: () => service }) as unknown as IInstantiationService, instantiation.get(IClaudeMultitaskService)));
		await index.refresh();
		assert.deepStrictEqual(['s1', 'agent-a', 'agent-b', 'other'].map(id => index.projectOf(id)), [
			{ key: 'add-dark-mode.json', name: 'Add dark mode' },
			{ key: 'add-dark-mode.json', name: 'Add dark mode' },
			{ key: 'add-dark-mode.json', name: 'Add dark mode' },
			undefined,
		]);
		assert.strictEqual(created.resource.path, '/home/me/.klawly-test/projects/add-dark-mode.json');
	});
});
