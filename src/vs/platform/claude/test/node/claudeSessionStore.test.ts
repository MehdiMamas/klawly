/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { compilePrompt, renderChatReferenceBlock } from '../../common/claudePrompt.js';
import { chatReferenceSummary } from '../../common/claudeChatReference.js';
import { NodeCheckpointStorage } from '../../node/claudeCheckpointNodeStorage.js';
import { ClaudeCheckpointStore } from '../../common/claudeCheckpointStore.js';
import { AGENT_DATABASE_SCHEMA_VERSION } from '../../common/claudeStorage.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../files/common/files.js';
import { createFileServiceSessionStorage } from '../../common/claudeSessionFileStorage.js';
import { agentDatabaseMigrations, JsonlSessionStore, migrateAgentDatabase, SessionStorage } from '../../common/claudeSessionStore.js';
import { NodeSessionStorage } from '../../node/claudeSessionNodeStorage.js';
import { DEFAULT_PERMISSION_POLICY } from '../../common/claudePermissions.js';
import { evaluateToolPolicy } from '../../common/claudeToolPolicy.js';

const folders: string[] = [];

suite('Jsonl session store', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => {
		for (const folder of folders.splice(0)) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	test('appends events, drops a truncated tail, and migrates the index', async () => {
		const userData = directory();
		const store = new JsonlSessionStore(userData, new NodeSessionStorage());
		await store.append('sess-1', { type: 'turn.submitted', turnId: 'turn-1', text: 'Fix login' });
		await store.append('sess-1', { type: 'tool.started', parentRunId: 'run-1', call: { id: 'read-1' } });
		const eventsPath = store.eventsPath('sess-1');
		const storage = new NodeSessionStorage();
		await storage.append(eventsPath, '{"v":1,"ts":1,"event":');
		const lines = await store.read('sess-1');
		assert.strictEqual(lines.length, 2);
		assert.strictEqual((lines[1].event as { parentRunId: string }).parentRunId, 'run-1');

		await storage.write(store.indexPath(), JSON.stringify({
			schemaVersion: 1,
			sessions: [{ id: 'sess-1', workspaceId: 'ws', title: 'Old', updatedAt: 5, mode: 'agent' }],
			preferences: {},
		}));
		const index = await store.readIndex();
		assert.strictEqual(index.schemaVersion, AGENT_DATABASE_SCHEMA_VERSION);
		assert.strictEqual(index.sessions[0].status, 'idle');
		assert.strictEqual(index.sessions[0].createdAt, 5);
		assert.strictEqual(index.sessions[0].title, 'Old');

		await store.writeIndex(index);
		const names = readdirSync(join(userData, 'agent-sessions'));
		assert.ok(names.includes('index.json'));
		assert.ok(names.every(name => !name.includes('.tmp-')));
		const future = migrateAgentDatabase({ schemaVersion: 9, sessions: [{ id: 's', title: 'Later', workspaceId: 'w', updatedAt: 1, mode: 'agent' }], preferences: {} });
		assert.strictEqual(future.sessions.length, 1);
		assert.strictEqual(future.sessions[0].title, 'Later');
	});

	test('a failed rename leaves the previous index in place', async () => {
		const storage = new MemorySessionStorage();
		const store = new JsonlSessionStore('/data', storage);
		await store.writeIndex({ schemaVersion: 2, sessions: [{ id: 'sess-1', workspaceId: 'ws', title: 'Kept', updatedAt: 1, mode: 'ask' }], preferences: {} });
		storage.failRename = true;
		await assert.rejects(store.writeIndex({ schemaVersion: 2, sessions: [], preferences: {} }));
		const index = await store.readIndex();
		assert.strictEqual(index.sessions[0].title, 'Kept');
	});

	test('reopening keeps the checkpoint and does not require a new Claude session to read it', async () => {
		const userData = directory();
		const workspace = directory();
		const file = join(workspace, 'auth.ts');
		writeFileSync(file, 'before');
		const checkpoints = new ClaudeCheckpointStore(userData, new NodeCheckpointStorage());
		await checkpoints.beginTurn({ sessionId: 'sess-1', turnId: 'turn-1', cwd: workspace }, 30);
		await checkpoints.snapshotApprovedWrite({ sessionId: 'sess-1', turnId: 'turn-1', cwd: workspace, absolutePath: file });
		const sessions = new JsonlSessionStore(userData, new NodeSessionStorage());
		await sessions.writeSession({
			id: 'sess-1',
			claudeSessionId: 'claude-1',
			workspaceId: 'ws',
			title: 'Fix login',
			mode: 'agent',
			createdAt: 1,
			updatedAt: 2,
			status: 'complete',
			turns: [{ id: 'turn-1', createdAt: 1, userText: 'Fix login' }],
			checkpointIds: ['turn-1'],
		});
		await sessions.writeReviews('sess-1', '{"accepted":true}');

		const again = new ClaudeCheckpointStore(userData, new NodeCheckpointStorage());
		const checkpoint = await again.readCheckpoint('sess-1', 'turn-1');
		assert.ok(checkpoint);
		assert.strictEqual(checkpoint.turnId, 'turn-1');
		const reopened = new JsonlSessionStore(userData, new NodeSessionStorage());
		const session = await reopened.readSession('sess-1');
		assert.strictEqual(session?.claudeSessionId, 'claude-1');
		assert.deepStrictEqual(session?.checkpointIds, ['turn-1']);
		assert.strictEqual(await reopened.readReviews('sess-1'), '{"accepted":true}');
		assert.ok(checkpoint.files.some(entry => entry.uri.includes('auth.ts')));
	});

	test('a chat reference file is the only extra path a Read may use', async () => {
		const summary = chatReferenceSummary({
			title: 'Fix login redirect',
			firstUser: 'The login loop sends people back to /login',
			finalAssistant: 'The redirect now stops on the home page.',
			changedFiles: ['src/auth.ts'],
			openTodos: [],
		}, 400);
		const block = renderChatReferenceBlock({
			title: 'Fix login redirect',
			sessionId: 'sess-1',
			turnStart: 1,
			turnEnd: 2,
			asOfTurn: 2,
			path: '/data/agent-sessions/sess-1/reference-2.md',
			summary,
			fullTranscript: `# Fix login redirect\n\nsk-ant-secretvalue should not appear inline`,
			scope: 'summary',
			deleted: false,
			otherWorkspace: false,
		});
		assert.ok(block);
		assert.ok(block.text.startsWith('<chat_reference '));
		assert.ok(block.text.includes('as_of_turn="2"'));
		assert.ok(block.text.includes('src/auth.ts'));
		assert.strictEqual(renderChatReferenceBlock({ ...blockInput(), deleted: true }), undefined);
		const prompt = compilePrompt({
			userText: 'Use the other chat',
			mode: 'agent',
			workspaceRoot: '/ws',
			attachments: [{
				kind: 'chat',
				sessionId: 'sess-1',
				reference: {
					title: 'Fix login redirect',
					sessionId: 'sess-1',
					turnStart: 1,
					turnEnd: 2,
					asOfTurn: 2,
					path: '/data/agent-sessions/sess-1/reference-2.md',
					summary,
					scope: 'summary',
					deleted: false,
					otherWorkspace: true,
					workspaceName: 'shop',
				},
			}],
			diagnostics: [],
			instructionFiles: [],
		});
		assert.ok(prompt.includes('<chat_reference '));
		assert.ok(prompt.includes('workspace="shop"'));
		const reference = '/data/agent-sessions/sess-1/reference-2.md';
		const allowed = await evaluateToolPolicy('Read', { file_path: reference }, {
			cwd: '/ws',
			workspaceFolders: ['/ws'],
			additionalDirectories: [reference],
			trusted: true,
			policy: DEFAULT_PERMISSION_POLICY,
		});
		const sibling = await evaluateToolPolicy('Read', { file_path: '/data/agent-sessions/sess-1/events.jsonl' }, {
			cwd: '/ws',
			workspaceFolders: ['/ws'],
			additionalDirectories: [reference],
			trusted: true,
			policy: DEFAULT_PERMISSION_POLICY,
		});
		assert.strictEqual(allowed.behavior, 'allow');
		assert.notStrictEqual(sibling.behavior, 'allow');
	});

	test('append rewrites a truncated tail before the next event', async () => {
		const storage = new MemorySessionStorage();
		const store = new JsonlSessionStore('/data', storage);
		await store.append('sess-1', { type: 'turn.submitted', turnId: 'turn-1', text: 'one' });
		await storage.append(store.eventsPath('sess-1'), '{"v":1,"ts":1,"event":');
		const reopened = new JsonlSessionStore('/data', storage);
		await reopened.append('sess-1', { type: 'assistant.completed', text: 'two' });
		const lines = await reopened.read('sess-1');
		assert.strictEqual(lines.length, 2);
		assert.strictEqual((lines[1].event as { text: string }).text, 'two');
	});

	test('repeated appends repair the log once', async () => {
		const storage = new MemorySessionStorage();
		const store = new JsonlSessionStore('/data', storage);
		await store.append('sess-1', { type: 'turn.submitted', turnId: 'turn-1', text: 'one' });
		await store.append('sess-1', { type: 'assistant.delta', text: 'a' });
		await store.append('sess-1', { type: 'assistant.completed', text: 'ab' });
		assert.strictEqual(storage.eventReads, 1);
		const lines = await store.read('sess-1');
		assert.strictEqual(lines.length, 3);
	});

	test('delete waits for the in-flight append and drops a later one', async () => {
		const storage = new MemorySessionStorage();
		const store = new JsonlSessionStore('/data', storage);
		storage.holdAppend = true;
		let started!: () => void;
		const startedPromise = new Promise<void>(resolve => { started = resolve; });
		storage.onAppendHeld = started;
		const pending = store.append('sess-1', { type: 'turn.submitted', turnId: 'turn-1', text: 'one' });
		await startedPromise;
		const deleting = store.deleteSession('sess-1');
		storage.releaseAppend();
		await pending;
		await deleting;
		await store.append('sess-1', { type: 'assistant.completed', text: 'two' });
		assert.strictEqual(storage.files.get(store.eventsPath('sess-1')), undefined);
	});

	test('an unreadable index is kept, and migrations preserve unknown fields', async () => {
		const storage = new MemorySessionStorage();
		const store = new JsonlSessionStore('/data', storage);
		await store.writeIndex({ schemaVersion: 2, sessions: [{ id: 'sess-1', workspaceId: 'ws', title: 'Kept', updatedAt: 2, mode: 'agent' }], preferences: {}, customFlag: 'yes' });
		await store.writeIndex({ schemaVersion: 2, sessions: [{ id: 'sess-1', workspaceId: 'ws', title: 'Newer', updatedAt: 3, mode: 'agent' }], preferences: {}, customFlag: 'yes' });
		storage.files.set(store.indexPath(), '{');
		const fromBackup = await store.readIndex();
		assert.strictEqual(fromBackup.sessions[0].title, 'Kept');
		assert.strictEqual(fromBackup.customFlag, 'yes');
		assert.strictEqual(storage.files.get(store.indexPath()), '{');

		storage.files.delete(store.indexBackupPath());
		await storage.write(store.sessionFile('sess-1'), JSON.stringify({
			id: 'sess-1', workspaceId: 'ws', title: 'From file', mode: 'agent', createdAt: 1, updatedAt: 4, status: 'complete', turns: [], checkpointIds: [],
		}));
		const rebuilt = await store.readIndex();
		assert.strictEqual(rebuilt.sessions[0].title, 'From file');
		assert.strictEqual(storage.files.get(store.indexPath()), '{');

		const migrated = migrateAgentDatabase({ schemaVersion: 1, sessions: [{ id: 's', title: 'Old', workspaceId: 'w', updatedAt: 5, mode: 'ask' }], preferences: {}, customFlag: 'keep' });
		assert.strictEqual(migrated.customFlag, 'keep');
		assert.strictEqual(migrated.schemaVersion, 2);
		assert.strictEqual(migrated.sessions[0].status, 'idle');
		const future = migrateAgentDatabase({ schemaVersion: 9, sessions: [{ id: 's', title: 'Later', workspaceId: 'w', updatedAt: 1, mode: 'agent' }], preferences: {}, customFlag: 'later' });
		assert.strictEqual(future.schemaVersion, 9);
		assert.strictEqual(future.customFlag, 'later');
		assert.deepStrictEqual(agentDatabaseMigrations.map(step => [step.from, step.to]), [[1, 2]]);
	});

	test('a corrupt index does not replace a backup that parses', async () => {
		const storage = new MemorySessionStorage();
		const store = new JsonlSessionStore('/data', storage);
		await store.writeIndex({ schemaVersion: 2, sessions: [{ id: 'sess-1', workspaceId: 'ws', title: 'Kept', updatedAt: 1, mode: 'agent' }], preferences: {} });
		await store.writeIndex({ schemaVersion: 2, sessions: [{ id: 'sess-1', workspaceId: 'ws', title: 'Newer', updatedAt: 2, mode: 'agent' }], preferences: {} });
		const backup = storage.files.get(store.indexBackupPath());
		assert.ok(backup?.includes('Kept'));
		storage.files.set(store.indexPath(), '{');
		await store.writeIndex({ schemaVersion: 2, sessions: [{ id: 'sess-1', workspaceId: 'ws', title: 'After', updatedAt: 3, mode: 'agent' }], preferences: {} });
		assert.strictEqual(storage.files.get(store.indexBackupPath()), backup);
		assert.ok(backup?.includes('"title":"Kept"'));
		assert.ok(storage.files.get(store.indexPath())?.includes('After'));
	});

	test('an unreadable index with nothing to recover is kept as corrupt and reads empty', async () => {
		const storage = new MemorySessionStorage();
		const store = new JsonlSessionStore('/data', storage);
		storage.files.set(store.indexPath(), '{');
		const index = await store.readIndex();
		assert.deepStrictEqual(index.sessions, []);
		assert.strictEqual(storage.files.get(store.indexPath()), undefined);
		assert.strictEqual(storage.files.get(`${store.indexPath()}.corrupt`), '{');
		await store.upsertIndex({ id: 'sess-2', workspaceId: 'ws', title: 'Next', updatedAt: 1, mode: 'agent' });
		const again = await store.readIndex();
		assert.strictEqual(again.sessions.length, 1);
		assert.strictEqual(again.sessions[0].title, 'Next');
	});

	test('delete during an in-flight metadata write drops later session writes', async () => {
		const storage = new MemorySessionStorage();
		const store = new JsonlSessionStore('/data', storage);
		const record = { id: 'sess-1', workspaceId: 'ws', title: 'Live', updatedAt: 2, mode: 'agent' as const };
		await store.upsertIndex(record);
		storage.holdWrites = true;
		let held!: () => void;
		const started = new Promise<void>(resolve => { held = resolve; });
		storage.onWriteHeld = held;
		const persisting = (async () => {
			await store.writeSession({
				id: 'sess-1', workspaceId: 'ws', title: 'Live', mode: 'agent', createdAt: 1, updatedAt: 2, status: 'complete', turns: [], checkpointIds: [],
			});
			await store.upsertIndex({ ...record, title: 'Resurrect', updatedAt: 3 });
		})();
		await started;
		const deleting = store.deleteSession('sess-1');
		storage.releaseWrite();
		await persisting;
		await deleting;
		assert.ok(!(await store.readIndex()).sessions.some(session => session.id === 'sess-1'));
		await store.upsertIndex({ ...record, title: 'Again', updatedAt: 4 });
		await store.writeReviews('sess-1', '{"accepted":true}');
		await store.writeReference('sess-1', { asOfTurn: 1, turnStart: 1, scope: 'summary' }, '# gone');
		await store.copyForkArtifacts('other', 'sess-1', ['turn-1']);
		assert.ok(!(await store.readIndex()).sessions.some(session => session.id === 'sess-1'));
		assert.strictEqual(storage.files.get(store.reviewsFile('sess-1')), undefined);
		assert.ok(![...storage.files.keys()].some(key => key.includes(`${store.sessionFile('sess-1')}`) || key.includes('reference-')));
	});

	test('comparisons are kept beside the index and survive a reopen', async () => {
		const storage = new MemorySessionStorage();
		await new JsonlSessionStore('/data', storage).writeComparisons('{"version":1,"comparisons":[]}');
		const reopened = new JsonlSessionStore('/data', storage);
		assert.deepStrictEqual([reopened.comparisonsPath().replace(/\\/g, '/'), await reopened.readComparisons()], ['/data/agent-sessions/comparisons.json', '{"version":1,"comparisons":[]}']);
	});

	test('file-service append does not read the whole log', async () => {
		let reads = 0;
		let appends = 0;
		const files = {
			readFile: async () => {
				reads++;
				return { value: VSBuffer.fromString('') };
			},
			writeFile: async (_resource: URI, _content: VSBuffer, options?: { append?: boolean }) => {
				if (options?.append) {
					appends++;
				}
			},
			exists: async () => false,
			move: async () => undefined,
			createFolder: async () => undefined,
			del: async () => undefined,
			resolve: async () => ({ children: [] }),
		};
		const storage = createFileServiceSessionStorage(files as unknown as IFileService);
		await storage.append(URI.file('/tmp/events.jsonl').fsPath, '{"v":1}\n');
		assert.strictEqual(reads, 0);
		assert.strictEqual(appends, 1);
	});
});

function blockInput() {
	return {
		title: 'Fix login redirect',
		sessionId: 'sess-1',
		turnStart: 1,
		turnEnd: 2,
		asOfTurn: 2,
		path: '/data/reference-2.md',
		summary: 'summary',
		scope: 'summary' as const,
		deleted: false,
		otherWorkspace: false,
	};
}

function directory(): string {
	const folder = mkdtempSync(join(tmpdir(), 'klawly-sessions-'));
	folders.push(folder);
	return folder;
}

class MemorySessionStorage implements SessionStorage {
	readonly files = new Map<string, string>();
	failRename = false;
	holdAppend = false;
	holdWrites = false;
	eventReads = 0;
	onAppendHeld: (() => void) | undefined;
	onWriteHeld: (() => void) | undefined;
	private _releaseAppend: (() => void) | undefined;
	private _releaseWrite: (() => void) | undefined;

	releaseAppend(): void {
		this._releaseAppend?.();
	}

	releaseWrite(): void {
		this._releaseWrite?.();
	}

	read(path: string): Promise<string | undefined> {
		if (path.includes('events.jsonl')) {
			this.eventReads++;
		}
		return Promise.resolve(this.files.get(path));
	}

	async write(path: string, text: string): Promise<void> {
		if (this.holdWrites && path.includes('session.json')) {
			this.holdWrites = false;
			this.onWriteHeld?.();
			await new Promise<void>(resolve => { this._releaseWrite = resolve; });
		}
		this.files.set(path, text);
	}

	async append(path: string, text: string): Promise<void> {
		if (this.holdAppend) {
			this.onAppendHeld?.();
			await new Promise<void>(resolve => { this._releaseAppend = resolve; });
			this.holdAppend = false;
		}
		this.files.set(path, (this.files.get(path) ?? '') + text);
	}

	rename(from: string, to: string): Promise<void> {
		if (this.failRename) {
			return Promise.reject(new Error('rename failed'));
		}
		const text = this.files.get(from);
		if (text === undefined) {
			return Promise.reject(new Error('missing'));
		}
		this.files.set(to, text);
		this.files.delete(from);
		return Promise.resolve();
	}

	mkdir(): Promise<void> {
		return Promise.resolve();
	}

	remove(path: string): Promise<void> {
		for (const key of [...this.files.keys()]) {
			if (key === path || key.startsWith(`${path}/`) || key.startsWith(`${path}\\`)) {
				this.files.delete(key);
			}
		}
		return Promise.resolve();
	}

	list(dir: string): Promise<readonly string[]> {
		const names = new Set<string>();
		for (const key of this.files.keys()) {
			if (!key.startsWith(dir)) {
				continue;
			}
			const rest = key.slice(dir.length).replace(/^[/\\]/, '');
			if (rest) {
				names.add(rest.split(/[/\\]/)[0]);
			}
		}
		return Promise.resolve([...names]);
	}
}
