/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { BeginClaudeRequest, ClaudeRunHandle } from '../../../../../platform/claude/common/claude.js';
import { createFileServiceCheckpointStorage } from '../../../../../platform/claude/common/claudeCheckpointFileStorage.js';
import { ClaudeCheckpointStore } from '../../../../../platform/claude/common/claudeCheckpointStore.js';
import { encodeGitIndex } from '../../../../../platform/claude/common/claudeGit.js';
import { FakeClaudeRuntimeService } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { ITextFileService } from '../../../textfile/common/textfiles.js';
import { IOutputService } from '../../../output/common/output.js';
import { ClaudeAgentService } from '../../common/claudeAgentService.js';
import { ClaudeCheckpointService, IClaudeCheckpointService, replaceCheckpointText } from '../../common/claudeCheckpointService.js';
import { agentWorkspaceStubs } from './claudeAgentTestUtils.js';

suite('Claude checkpoint service', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('captures dirty file buffers and skips clean ones', async () => {
		const textFiles = {
			files: {
				models: [
					dirty(URI.file('C:/repo/open.ts'), 'unsaved'),
					clean(URI.file('C:/repo/saved.ts')),
				],
			},
		} as unknown as ITextFileService;
		const service = disposables.add(new ClaudeCheckpointService('C:/klawly-user', {} as IFileService, textFiles, {} as IDialogService));
		const buffers = await service.captureDirtyBuffers();
		assert.deepStrictEqual(buffers, [{ path: URI.file('C:/repo/open.ts').fsPath, text: 'unsaved' }]);
	});

	test('a restored open file is one editor undo stop', async () => {
		const model = disposables.add(createTextModel('agent edit'));
		replaceCheckpointText(model, 'original');
		assert.strictEqual(model.getValue(), 'original');
		await model.undo();
		assert.strictEqual(model.getValue(), 'agent edit');
	});

	test('skips dirty buffers when checkpoints are disabled', async () => {
		const textFiles = {
			files: {
				models: [dirty(URI.file(join(root(), 'open.ts')), 'unsaved')],
			},
		} as unknown as ITextFileService;
		const service = disposables.add(new ClaudeCheckpointService(root(), {} as IFileService, textFiles, {} as IDialogService, () => false));
		assert.deepStrictEqual(await service.captureDirtyBuffers(), []);
	});

	test('restore confirms in a dialog and reloads the open text model', async () => {
		const base = root();
		const userData = join(base, 'user');
		const workspace = join(base, 'workspace');
		const file = join(workspace, 'open.ts');
		const resource = URI.file(file);
		const fileService = new MemoryFileService();
		const typedFiles = fileService as unknown as IFileService;
		const store = new ClaudeCheckpointStore(userData, createFileServiceCheckpointStorage(typedFiles));
		await fileService.writeFile(resource, VSBuffer.fromString('original'));
		await store.beginTurn({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace }, 30);
		await store.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace, absolutePath: file });
		await fileService.writeFile(resource, VSBuffer.fromString('from-agent'));
		await store.noteAfterWrite('sess', file);
		await fileService.writeFile(resource, VSBuffer.fromString('typed-by-user'));
		const textModel = disposables.add(createTextModel('typed-by-user'));
		const textFiles = {
			files: {
				models: [{
					resource,
					isDirty: () => false,
					isResolved: () => true,
					textEditorModel: textModel,
					revert: async () => {
						textModel.setValue((await fileService.readFile(resource)).value.toString());
					},
					dispose: () => undefined,
				}],
			},
		} as unknown as ITextFileService;
		let detail = '';
		const dialogs = {
			confirm: async (confirmation: { detail?: string }) => {
				detail = confirmation.detail ?? '';
				return { confirmed: true };
			},
		} as unknown as IDialogService;
		const service = disposables.add(new ClaudeCheckpointService(userData, typedFiles, textFiles, dialogs));
		assert.strictEqual(await service.restore('sess', 'turn-1'), true);
		assert.ok(detail.includes('open.ts'));
		assert.strictEqual(textModel.getValue(), 'original');
		assert.strictEqual((await fileService.readFile(resource)).value.toString(), 'original');
	});

	test('a null checkpoint hash means the file did not exist, and an empty file did', async () => {
		const base = root();
		const userData = join(base, 'user-existed');
		const workspace = join(base, 'workspace-existed');
		const emptyFile = join(workspace, 'empty.ts');
		const missingFile = join(workspace, 'missing.ts');
		const fileService = new MemoryFileService();
		const typedFiles = fileService as unknown as IFileService;
		const store = new ClaudeCheckpointStore(userData, createFileServiceCheckpointStorage(typedFiles));
		await fileService.writeFile(URI.file(emptyFile), VSBuffer.fromString(''));
		await store.beginTurn({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace }, 30);
		await store.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace, absolutePath: emptyFile });
		await store.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace, absolutePath: missingFile });
		const service = disposables.add(new ClaudeCheckpointService(userData, typedFiles, { files: { models: [] } } as unknown as ITextFileService, {} as IDialogService));
		const originals = await service.readCheckpointOriginals('sess', 'turn-1');
		const empty = originals.find(file => file.uri.endsWith('empty.ts'));
		const missing = originals.find(file => file.uri.endsWith('missing.ts'));
		assert.ok(empty);
		assert.ok(missing);
		assert.strictEqual(empty!.text, '');
		assert.strictEqual(empty!.existed, true);
		assert.strictEqual(missing!.text, '');
		assert.strictEqual(missing!.existed, false);
	});

	test('other chats report the files they wrote since a turn began', async () => {
		const base = root();
		const userData = join(base, 'user-other');
		const workspace = join(base, 'workspace-other');
		const shared = join(workspace, 'shared.ts');
		const fileService = new MemoryFileService();
		const typedFiles = fileService as unknown as IFileService;
		const store = new ClaudeCheckpointStore(userData, createFileServiceCheckpointStorage(typedFiles));
		await fileService.writeFile(URI.file(shared), VSBuffer.fromString('x'));
		await store.beginTurn({ sessionId: 'mine', turnId: 'turn-1', cwd: workspace }, 30);
		await store.beginTurn({ sessionId: 'other', turnId: 'turn-9', cwd: workspace }, 30);
		await store.snapshotApprovedWrite({ sessionId: 'other', turnId: 'turn-9', cwd: workspace, absolutePath: shared });
		const service = disposables.add(new ClaudeCheckpointService(userData, typedFiles, { files: { models: [] } } as unknown as ITextFileService, {} as IDialogService));
		assert.deepStrictEqual([...await service.readOtherChatPaths('mine', 'turn-1', ['mine', 'other'])], [URI.file(shared).fsPath]);
		assert.deepStrictEqual([...await service.readOtherChatPaths('mine', 'turn-1', ['mine'])], []);
		assert.deepStrictEqual([...await service.readOtherChatPaths('mine', 'missing', ['other'])], []);
		assert.strictEqual(await service.readTurnGitHead('mine', 'missing'), undefined);
	});

	test('helper chats report the turns that wrote files since a turn began', async () => {
		const base = root();
		const userData = join(base, 'user-helper');
		const workspace = join(base, 'workspace-helper');
		const shared = join(workspace, 'shared.ts');
		const fileService = new MemoryFileService();
		const typedFiles = fileService as unknown as IFileService;
		const store = new ClaudeCheckpointStore(userData, createFileServiceCheckpointStorage(typedFiles));
		await fileService.writeFile(URI.file(shared), VSBuffer.fromString('x'));
		await store.beginTurn({ sessionId: 'mine', turnId: 'turn-1', cwd: workspace }, 30);
		await store.beginTurn({ sessionId: 'helper', turnId: 'turn-9', cwd: workspace }, 30);
		await store.snapshotApprovedWrite({ sessionId: 'helper', turnId: 'turn-9', cwd: workspace, absolutePath: shared });
		await store.beginTurn({ sessionId: 'idle', turnId: 'turn-5', cwd: workspace }, 30);
		const service = disposables.add(new ClaudeCheckpointService(userData, typedFiles, { files: { models: [] } } as unknown as ITextFileService, {} as IDialogService));
		assert.deepStrictEqual(await service.readHelperTurnIds('mine', 'turn-1', ['mine', 'helper', 'idle']), [{ sessionId: 'helper', turnIds: ['turn-9'] }]);
		assert.deepStrictEqual(await service.readHelperTurnIds('mine', 'missing', ['helper']), []);
	});

	test('submit sends the turn id and dirty buffers for the checkpoint', async () => {
		const runtime = disposables.add(new FakeClaudeRuntimeService(new Map([
			['plain-answer', [
				'{"type":"session.started","sessionId":"$session"}',
				'{"type":"assistant.completed","sessionId":"$session","text":"ok"}',
				'{"type":"session.completed","sessionId":"$session"}',
			].join('\n')],
		])));
		let request: BeginClaudeRequest | undefined;
		const original = runtime.begin.bind(runtime);
		runtime.begin = async (next: BeginClaudeRequest): Promise<ClaudeRunHandle> => {
			request = next;
			return original(next);
		};
		const checkpoints: IClaudeCheckpointService = {
			_serviceBrand: undefined,
			captureDirtyBuffers: async () => [{ path: 'C:/repo/a.ts', text: 'dirty' }],
			restore: async () => false,
			readCheckpointOriginals: async () => [],
			readTurnsChanges: async () => [],
			readOtherChatPaths: async () => new Set<string>(), readHelperTurnIds: async () => [], readTurnGitHead: async () => undefined,
			restoreTurns: async () => true,
		};
		const [workspace, trust, , files, configuration, storage] = agentWorkspaceStubs();
		const agent = disposables.add(new ClaudeAgentService(runtime, output(), workspace, trust, checkpoints, files, configuration, storage));
		const session = agent.createSession();
		await agent.submit(session.id, 'edit both files', 'C:/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		assert.strictEqual(request?.checkpointSessionId, session.id);
		assert.strictEqual(request?.turnId, 'turn-1');
		assert.deepStrictEqual(request?.dirtyBuffers, [{ path: 'C:/repo/a.ts', text: 'dirty' }]);
	});

	test('restore keeps a staged blob when the agent only changed the working tree', async () => {
		const base = root();
		const userData = join(base, 'user-index');
		const workspace = join(base, 'workspace-index');
		const file = join(workspace, 'note.ts');
		const blob = 'ab'.repeat(20);
		const fileService = new MemoryFileService();
		const typedFiles = fileService as unknown as IFileService;
		const store = new ClaudeCheckpointStore(userData, createFileServiceCheckpointStorage(typedFiles));
		await fileService.writeFile(URI.file(file), VSBuffer.fromString('original'));
		await fileService.writeFile(URI.file(join(workspace, '.git', 'HEAD')), VSBuffer.fromString('ref: refs/heads/main\n'));
		await fileService.writeFile(URI.file(join(workspace, '.git', 'refs', 'heads', 'main')), VSBuffer.fromString(`${'e'.repeat(40)}\n`));
		const indexUri = URI.file(join(workspace, '.git', 'index'));
		await fileService.writeFile(indexUri, VSBuffer.wrap(encodeGitIndex([{ path: 'note.ts', blob }])));
		const indexBefore = (await fileService.readFile(indexUri)).value.buffer.slice();
		await store.beginTurn({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace }, 30);
		await store.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace, absolutePath: file });
		await fileService.writeFile(URI.file(file), VSBuffer.fromString('from-agent'));
		await store.noteAfterWrite('sess', file);
		const recorded = await store.readCheckpoint('sess', 'turn-1');
		assert.strictEqual(recorded?.files[0].indexBlob, blob);
		let confirmed = false;
		const dialogs = {
			confirm: async () => {
				confirmed = true;
				return { confirmed: true };
			},
		} as unknown as IDialogService;
		const service = disposables.add(new ClaudeCheckpointService(userData, typedFiles, { files: { models: [] } } as unknown as ITextFileService, dialogs));
		assert.strictEqual(await service.restore('sess', 'turn-1'), true);
		assert.strictEqual(confirmed, false);
		assert.strictEqual((await fileService.readFile(URI.file(file))).value.toString(), 'original');
		assert.deepStrictEqual((await fileService.readFile(indexUri)).value.buffer, indexBefore);

		await fileService.writeFile(URI.file(file), VSBuffer.fromString('from-agent'));
		await fileService.writeFile(indexUri, VSBuffer.wrap(encodeGitIndex([{ path: 'note.ts', blob: 'cd'.repeat(20) }])));
		const stagedBytes = (await fileService.readFile(indexUri)).value.buffer.slice();
		const declined = {
			confirm: async (confirmation: { detail?: string }) => {
				confirmed = (confirmation.detail ?? '').includes('(staged)');
				return { confirmed: false };
			},
		} as unknown as IDialogService;
		const second = disposables.add(new ClaudeCheckpointService(userData, typedFiles, { files: { models: [] } } as unknown as ITextFileService, declined));
		assert.strictEqual(await second.restore('sess', 'turn-1'), false);
		assert.strictEqual(confirmed, true);
		assert.strictEqual((await fileService.readFile(URI.file(file))).value.toString(), 'from-agent');
		assert.deepStrictEqual((await fileService.readFile(indexUri)).value.buffer, stagedBytes);
	});

	test('restore records an index that can no longer be parsed', async () => {
		const base = root();
		const userData = join(base, 'user-index');
		const main = join(base, 'main-index');
		const work = join(main, 'wt');
		const gitDir = join(main, '.git', 'worktrees', 'wt');
		const file = join(work, 'src', 'a.ts');
		const resource = URI.file(file);
		const fileService = new MemoryFileService();
		const typedFiles = fileService as unknown as IFileService;
		const sha = 'd'.repeat(40);
		const blob = 'ab'.repeat(20);
		await fileService.writeFile(URI.file(join(gitDir, 'HEAD')), VSBuffer.fromString(`${sha}\n`));
		await fileService.writeFile(URI.file(join(work, '.git')), VSBuffer.fromString('gitdir: ../.git/worktrees/wt\n'));
		await fileService.writeFile(URI.file(join(gitDir, 'index')), VSBuffer.wrap(encodeGitIndex([{ path: 'src/a.ts', blob }])));
		await fileService.writeFile(resource, VSBuffer.fromString('before'));
		const checkpoints = new ClaudeCheckpointStore(userData, createFileServiceCheckpointStorage(typedFiles));
		await checkpoints.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: join(work, 'src'), absolutePath: file });
		const saved = await checkpoints.readCheckpoint('sess', 'turn-1');
		assert.strictEqual(saved?.gitHead, sha);
		assert.strictEqual(saved?.files[0].indexBlob, blob);
		await fileService.writeFile(URI.file(join(gitDir, 'index')), VSBuffer.fromString('not an index'));
		const logs: string[] = [];
		const service = disposables.add(new ClaudeCheckpointService(userData, typedFiles, { files: { models: [] } } as unknown as ITextFileService, { confirm: async () => ({ confirmed: true }) } as unknown as IDialogService, () => true, message => logs.push(message)));
		await service.restore('sess', 'turn-1');
		assert.strictEqual(service.gitIndexReadError(), 'Git index could not be parsed.');
		assert.ok(logs.includes('Git index could not be parsed.'));
		await fileService.writeFile(URI.file(join(gitDir, 'index')), VSBuffer.wrap(encodeGitIndex([{ path: 'src/a.ts', blob }])));
		await service.restore('sess', 'turn-1');
		assert.strictEqual(service.gitIndexReadError(), undefined);
	});
});

function root(): string {
	return isWindows ? 'C:/klawly-checkpoint-test' : '/klawly-checkpoint-test';
}

/** Enough of a file service for the checkpoint store and a restore. */
class MemoryFileService {
	private readonly _files = new Map<string, Uint8Array>();

	private id(resource: URI): string {
		return resource.fsPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	}

	async exists(resource: URI): Promise<boolean> {
		const key = this.id(resource);
		if (this._files.has(key)) {
			return true;
		}
		const prefix = `${key}/`;
		for (const candidate of this._files.keys()) {
			if (candidate.startsWith(prefix)) {
				return true;
			}
		}
		return false;
	}

	async readFile(resource: URI): Promise<{ value: VSBuffer }> {
		const bytes = this._files.get(this.id(resource));
		if (!bytes) {
			throw new Error('missing');
		}
		return { value: VSBuffer.wrap(bytes) };
	}

	async writeFile(resource: URI, content: VSBuffer): Promise<void> {
		this._files.set(this.id(resource), Uint8Array.from(content.buffer));
	}

	async createFolder(resource: URI): Promise<void> {
		const key = this.id(resource);
		if (!this._files.has(`${key}/.dir`)) {
			this._files.set(`${key}/.dir`, new Uint8Array());
		}
	}

	async move(from: URI, to: URI): Promise<void> {
		const bytes = this._files.get(this.id(from));
		if (!bytes) {
			throw new Error('missing');
		}
		this._files.set(this.id(to), bytes);
		this._files.delete(this.id(from));
	}

	async del(resource: URI): Promise<void> {
		this._files.delete(this.id(resource));
	}

	async stat(resource: URI): Promise<{ mtime: number; size: number }> {
		const bytes = this._files.get(this.id(resource));
		if (!bytes) {
			throw new Error('missing');
		}
		return { mtime: 1, size: bytes.byteLength };
	}

	async resolve(resource: URI): Promise<{ children: { name: string }[] }> {
		const prefix = `${this.id(resource)}/`;
		const names = new Set<string>();
		for (const candidate of this._files.keys()) {
			if (!candidate.startsWith(prefix)) {
				continue;
			}
			const name = candidate.slice(prefix.length).split('/')[0];
			if (name && name !== '.dir') {
				names.add(name);
			}
		}
		return { children: [...names].map(name => ({ name })) };
	}
}

function dirty(resource: URI, text: string) {
	return {
		resource,
		isDirty: () => true,
		isResolved: () => true,
		textEditorModel: { getValue: () => text },
	};
}

function clean(resource: URI) {
	return {
		resource,
		isDirty: () => false,
		isResolved: () => true,
		textEditorModel: { getValue: () => 'saved' },
	};
}

function output(): IOutputService {
	return {
		getChannel: () => ({
			append: () => undefined,
		}),
	} as unknown as IOutputService;
}

async function until(predicate: () => boolean): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > 5000) {
			assert.fail('condition was not met');
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}
