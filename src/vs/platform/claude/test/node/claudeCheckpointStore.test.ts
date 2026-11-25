/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { readCheckpointRetentionDays, readCheckpointsEnabled, fileUriFromPath, fsPathFromCheckpointUri, sha256Hex, checkpointObjectsRoot } from '../../common/claudeCheckpoints.js';
import { encodeGitIndex, parseGitIndex } from '../../common/claudeGit.js';
import { restoreCheckpointContents } from '../../common/claudeCheckpointRestore.js';
import { BeginTurnCheckpoint, CheckpointStorage, ClaudeCheckpointStore } from '../../common/claudeCheckpointStore.js';
import { DEFAULT_PERMISSION_POLICY } from '../../common/claudePermissions.js';
import { NodeCheckpointStorage } from '../../node/claudeCheckpointNodeStorage.js';
import { ClaudeAgentRunner } from '../../node/claudeAgentRunner.js';
import { ClaudePermissionHost } from '../../node/claudePermissionHost.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery, ClaudeQueryStart } from '../../node/claudeQuery.js';

suite('Claude checkpoint store', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const folders: string[] = [];

	teardown(() => {
		for (const folder of folders.splice(0)) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	test('a shell command that edits, creates and deletes files is recorded and undone', async () => {
		const userData = directory();
		const workspace = directory();
		writeFileSync(join(workspace, 'edit.txt'), 'edit-original');
		writeFileSync(join(workspace, 'gone.txt'), 'gone-original');
		writeFileSync(join(workspace, 'same.txt'), 'same');
		const checkpoints = openStore(userData);
		await checkpoints.beginTurn({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace }, 30);
		await checkpoints.beginShellWatch({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace });
		writeFileSync(join(workspace, 'edit.txt'), 'edit-by-shell');
		rmSync(join(workspace, 'gone.txt'));
		writeFileSync(join(workspace, 'new.txt'), 'created-by-shell');
		assert.strictEqual(await checkpoints.settleShellWatch('sess'), 3);
		const checkpoint = await checkpoints.readCheckpoint('sess', 'turn-1');
		assert.ok(checkpoint);
		const byName = new Map(checkpoint.files.map(file => [fsPathFromCheckpointUri(file.uri).split(/[\\/]/).pop()!, file]));
		assert.deepStrictEqual([...byName.keys()].sort(), ['edit.txt', 'gone.txt', 'new.txt']);
		assert.strictEqual(byName.get('new.txt')!.existed, false);
		assert.strictEqual(byName.get('gone.txt')!.afterHash, null);
		assert.strictEqual(new TextDecoder().decode(await checkpoints.readBlob(byName.get('edit.txt')!.hash!)), 'edit-original');
		assert.strictEqual(new TextDecoder().decode(await checkpoints.readBlob(byName.get('edit.txt')!.afterHash!)), 'edit-by-shell');
	});

	test('restores a multi-file edit after the store is reopened', async () => {
		const userData = directory();
		const workspace = directory();
		const alpha = join(workspace, 'alpha.ts');
		const beta = join(workspace, 'beta.ts');
		writeFileSync(alpha, 'alpha-original');
		writeFileSync(beta, 'beta-original');
		const first = openStore(userData);
		await first.beginTurn({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace }, 30);
		await first.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace, absolutePath: alpha });
		await first.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace, absolutePath: beta });
		writeFileSync(alpha, 'alpha-edited');
		writeFileSync(beta, 'beta-edited');
		await first.noteAfterWrite('sess', alpha);
		await first.noteAfterWrite('sess', beta);

		const reopened = openStore(userData);
		const checkpoint = await reopened.readCheckpoint('sess', 'turn-1');
		assert.ok(checkpoint);
		assert.strictEqual(checkpoint.files.length, 2);
		const result = await restoreCheckpointContents({
			checkpoint,
			documents: [],
			readBlob: hash => reopened.readBlob(hash),
			readDisk: uri => readOptional(uri),
			writeDisk: (uri, bytes) => writeOptional(uri, bytes),
			confirm: async () => { throw new Error('agent edits are not user conflicts'); },
		});
		assert.strictEqual(result, 'restored');
		assert.strictEqual(readFileSync(alpha, 'utf8'), 'alpha-original');
		assert.strictEqual(readFileSync(beta, 'utf8'), 'beta-original');
	});

	test('noteAfterWrite stores the post-write bytes and garbage collection keeps them', async () => {
		const userData = directory();
		const workspace = directory();
		const file = join(workspace, 'a.ts');
		writeFileSync(file, 'before');
		const checkpoints = openStore(userData);
		await checkpoints.beginTurn({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace }, 30);
		await checkpoints.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace, absolutePath: file });
		writeFileSync(file, 'after-claude');
		await checkpoints.noteAfterWrite('sess', file);
		const checkpoint = await checkpoints.readCheckpoint('sess', 'turn-1');
		const recorded = checkpoint?.files[0];
		assert.ok(recorded?.afterHash);
		assert.strictEqual(Buffer.from(await checkpoints.readBlob(recorded.afterHash)).toString(), 'after-claude');
		await checkpoints.garbageCollect(30);
		assert.strictEqual(Buffer.from(await checkpoints.readBlob(recorded.afterHash)).toString(), 'after-claude');
	});

	test('asks before overwriting a user edit and leaves the file when declined', async () => {
		const userData = directory();
		const workspace = directory();
		const file = join(workspace, 'note.ts');
		writeFileSync(file, 'original');
		const checkpoints = openStore(userData);
		await checkpoints.beginTurn({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace }, 30);
		await checkpoints.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace, absolutePath: file });
		writeFileSync(file, 'from-agent');
		await checkpoints.noteAfterWrite('sess', file);
		writeFileSync(file, 'typed-by-user');
		const checkpoint = await checkpoints.readCheckpoint('sess', 'turn-1');
		assert.ok(checkpoint);
		let labels: string[] = [];
		const declined = await restoreCheckpointContents({
			checkpoint,
			documents: [],
			readBlob: hash => checkpoints.readBlob(hash),
			readDisk: uri => readOptional(uri),
			writeDisk: (uri, bytes) => writeOptional(uri, bytes),
			confirm: async conflicts => {
				labels = conflicts.map(conflict => conflict.label);
				return false;
			},
		});
		assert.strictEqual(declined, 'cancelled');
		assert.deepStrictEqual(labels, ['note.ts']);
		assert.strictEqual(readFileSync(file, 'utf8'), 'typed-by-user');
		const accepted = await restoreCheckpointContents({
			checkpoint,
			documents: [],
			readBlob: hash => checkpoints.readBlob(hash),
			readDisk: uri => readOptional(uri),
			writeDisk: (uri, bytes) => writeOptional(uri, bytes),
			confirm: async () => true,
		});
		assert.strictEqual(accepted, 'restored');
		assert.strictEqual(readFileSync(file, 'utf8'), 'original');
	});

	test('snapshots dirty buffer text and restores it onto an unchanged save', async () => {
		const userData = directory();
		const workspace = directory();
		const file = join(workspace, 'dirty.ts');
		writeFileSync(file, 'saved');
		const checkpoints = openStore(userData);
		const checkpoint = await checkpoints.beginTurn({
			sessionId: 'sess',
			turnId: 'turn-1',
			cwd: workspace,
			dirtyFiles: [{ path: file, text: 'unsaved buffer' }],
		}, 30);
		assert.strictEqual(checkpoint.files[0].capturedAs, 'buffer');
		const result = await restoreCheckpointContents({
			checkpoint,
			documents: [],
			readBlob: hash => checkpoints.readBlob(hash),
			readDisk: uri => readOptional(uri),
			writeDisk: (uri, bytes) => writeOptional(uri, bytes),
			confirm: async () => { throw new Error('the saved file is the pre-turn disk'); },
		});
		assert.strictEqual(result, 'restored');
		assert.strictEqual(readFileSync(file, 'utf8'), 'unsaved buffer');
	});

	test('a dirty open document restores the buffer only and leaves disk unchanged', async () => {
		const userData = directory();
		const workspace = directory();
		const file = join(workspace, 'open.ts');
		writeFileSync(file, 'original');
		const checkpoints = openStore(userData);
		await checkpoints.beginTurn({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace }, 30);
		await checkpoints.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace, absolutePath: file });
		writeFileSync(file, 'edited');
		await checkpoints.noteAfterWrite('sess', file);
		const checkpoint = await checkpoints.readCheckpoint('sess', 'turn-1');
		assert.ok(checkpoint);
		let replaced = '';
		let diskWrites = 0;
		const uri = fileUriFromPath(file);
		await restoreCheckpointContents({
			checkpoint,
			documents: [{
				uri,
				getText: () => 'edited',
				isDirty: () => true,
				replaceText: value => { replaced = value; },
			}],
			readBlob: hash => checkpoints.readBlob(hash),
			readDisk: uriToRead => readOptional(uriToRead),
			writeDisk: async () => { diskWrites++; },
			confirm: async () => true,
		});
		assert.strictEqual(replaced, 'original');
		assert.strictEqual(diskWrites, 0);
		assert.strictEqual(readFileSync(file, 'utf8'), 'edited');
	});

	test('records the git HEAD commit at turn start', async () => {
		const userData = directory();
		const workspace = directory();
		const sha = 'a'.repeat(40);
		mkdirSync(join(workspace, '.git', 'refs', 'heads'), { recursive: true });
		writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
		writeFileSync(join(workspace, '.git', 'refs', 'heads', 'main'), `${sha}\n`);
		const checkpoint = await openStore(userData).beginTurn({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace }, 30);
		assert.strictEqual(checkpoint.gitHead, sha);
	});

	test('restore rewrites the working tree and leaves the index alone', async () => {
		const userData = directory();
		const workspace = directory();
		const file = join(workspace, 'note.ts');
		const blob = 'ab'.repeat(20);
		const stagedLater = 'cd'.repeat(20);
		writeFileSync(file, 'original');
		mkdirSync(join(workspace, '.git', 'refs', 'heads'), { recursive: true });
		writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
		writeFileSync(join(workspace, '.git', 'refs', 'heads', 'main'), `${'e'.repeat(40)}\n`);
		const indexPath = join(workspace, '.git', 'index');
		writeFileSync(indexPath, Buffer.from(encodeGitIndex([{ path: 'note.ts', blob }])));
		const indexBefore = readFileSync(indexPath);
		const checkpoints = openStore(userData);
		await checkpoints.beginTurn({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace }, 30);
		await checkpoints.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace, absolutePath: file });
		writeFileSync(file, 'from-agent');
		await checkpoints.noteAfterWrite('sess', file);
		const checkpoint = await checkpoints.readCheckpoint('sess', 'turn-1');
		assert.ok(checkpoint);
		assert.strictEqual(checkpoint.gitBranch, 'main');
		assert.strictEqual(checkpoint.files[0].indexBlob, blob);
		const uri = checkpoint.files[0].uri;
		const sameIndex = new Map([[uri, parseGitIndex(new Uint8Array(indexBefore))?.get('note.ts') ?? null]]);
		const restored = await restoreCheckpointContents({
			checkpoint,
			documents: [],
			readBlob: hash => checkpoints.readBlob(hash),
			readDisk: path => readOptional(path),
			writeDisk: (path, bytes) => writeOptional(path, bytes),
			indexBlobs: sameIndex,
			confirm: async () => { throw new Error('agent edits are not user conflicts'); },
		});
		assert.strictEqual(restored, 'restored');
		assert.strictEqual(readFileSync(file, 'utf8'), 'original');
		assert.deepStrictEqual(readFileSync(indexPath), indexBefore);

		writeFileSync(file, 'from-agent');
		writeFileSync(indexPath, Buffer.from(encodeGitIndex([{ path: 'note.ts', blob: stagedLater }])));
		const stagedBytes = readFileSync(indexPath);
		let labels: string[] = [];
		const declined = await restoreCheckpointContents({
			checkpoint,
			documents: [],
			readBlob: hash => checkpoints.readBlob(hash),
			readDisk: path => readOptional(path),
			writeDisk: (path, bytes) => writeOptional(path, bytes),
			indexBlobs: new Map([[uri, stagedLater]]),
			confirm: async conflicts => {
				labels = conflicts.map(conflict => conflict.label);
				return false;
			},
		});
		assert.strictEqual(declined, 'cancelled');
		assert.ok(labels.some(label => label.includes('(staged)')));
		assert.strictEqual(readFileSync(file, 'utf8'), 'from-agent');
		assert.deepStrictEqual(readFileSync(indexPath), stagedBytes);

		writeFileSync(indexPath, indexBefore);
		writeFileSync(file, 'typed-by-user');
		labels = [];
		const unstaged = await restoreCheckpointContents({
			checkpoint,
			documents: [],
			readBlob: hash => checkpoints.readBlob(hash),
			readDisk: path => readOptional(path),
			writeDisk: (path, bytes) => writeOptional(path, bytes),
			indexBlobs: sameIndex,
			confirm: async conflicts => {
				labels = conflicts.map(conflict => conflict.label);
				return true;
			},
		});
		assert.strictEqual(unstaged, 'restored');
		assert.deepStrictEqual(labels, ['note.ts']);
		assert.strictEqual(readFileSync(file, 'utf8'), 'original');
		assert.deepStrictEqual(readFileSync(indexPath), indexBefore);
	});

	test('stores one blob for identical bytes and streams a large file', async () => {
		const userData = directory();
		const workspace = directory();
		const body = '0123456789abcdef';
		const left = join(workspace, 'left.bin');
		const right = join(workspace, 'right.bin');
		writeFileSync(left, body);
		writeFileSync(right, body);
		const checkpoints = openStore(userData, 8);
		await checkpoints.beginTurn({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace }, 30);
		await checkpoints.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace, absolutePath: left });
		await checkpoints.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace, absolutePath: right });
		const checkpoint = await checkpoints.readCheckpoint('sess', 'turn-1');
		assert.ok(checkpoint);
		assert.strictEqual(checkpoint.files[0].hash, checkpoint.files[1].hash);
		const blob = await checkpoints.readBlob(checkpoint.files[0].hash!);
		assert.strictEqual(Buffer.from(blob).toString(), body);
	});

	test('deletes expired checkpoints and unreferenced objects', async () => {
		const userData = directory();
		const workspace = directory();
		const file = join(workspace, 'kept.ts');
		writeFileSync(file, 'keep-me');
		const checkpoints = openStore(userData);
		await checkpoints.putBlob(new TextEncoder().encode('orphan'));
		await checkpoints.beginTurn({
			sessionId: 'sess',
			turnId: 'turn-old',
			cwd: workspace,
			dirtyFiles: [{ path: file, text: 'old buffer' }],
		}, 30, 1_000);
		await checkpoints.beginTurn({
			sessionId: 'sess',
			turnId: 'turn-new',
			cwd: workspace,
			dirtyFiles: [{ path: file, text: 'new buffer' }],
		}, 30, 10_000);
		await checkpoints.garbageCollect(0, 5_000);
		assert.strictEqual(await checkpoints.readCheckpoint('sess', 'turn-old'), undefined);
		const kept = await checkpoints.readCheckpoint('sess', 'turn-new');
		assert.ok(kept?.files[0].hash);
		assert.strictEqual(Buffer.from(await checkpoints.readBlob(kept.files[0].hash)).toString(), 'new buffer');
	});

	test('snapshots a file before an approved write is returned', async () => {
		const userData = directory();
		const workspace = directory();
		const file = join(workspace, 'src', 'a.ts');
		mkdirSync(join(workspace, 'src'), { recursive: true });
		writeFileSync(file, 'before-write');
		const checkpoints = openStore(userData);
		const registry = store.add(new ClaudeProcessRegistry());
		let captured: ClaudeQueryStart | undefined;
		let release: (() => void) | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			checkpoints,
			permissionHost: new ClaudePermissionHost({ getPolicy: () => ({ ...DEFAULT_PERMISSION_POLICY, writeWorkspace: 'allow' }) }),
			queryFactory: async start => {
				captured = start;
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(() => release, fn => { release = fn; });
			},
		}));
		const seen: { type: string }[] = [];
		const done = (async () => {
			for await (const event of runner.start({
				sessionId: 'sess',
				prompt: 'edit',
				cwd: workspace,
				mode: 'agent',
				workspaceTrusted: true,
				turnId: 'turn-9',
				checkpointSessionId: 'sess',
			})) {
				seen.push(event);
			}
		})();
		await waitFor(() => seen.some(event => event.type === 'session.started') && release !== undefined);
		const decision = await captured!.options.canUseTool('Write', { file_path: file, content: 'after' }, { signal: new AbortController().signal, toolUseID: 'w1' });
		assert.strictEqual(decision.behavior, 'allow');
		const checkpoint = await checkpoints.readCheckpoint('sess', 'turn-9');
		assert.ok(checkpoint?.files.some(entry => entry.hash));
		const recorded = checkpoint!.files.find(entry => entry.existed);
		assert.ok(recorded?.hash);
		assert.strictEqual(Buffer.from(await checkpoints.readBlob(recorded.hash)).toString(), 'before-write');
		release?.();
		await done;
	});

	test('a clean open document is written to disk and reverted without staying dirty', async () => {
		const userData = directory();
		const workspace = directory();
		const file = join(workspace, 'open.ts');
		writeFileSync(file, 'original');
		const checkpoints = openStore(userData);
		await checkpoints.beginTurn({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace }, 30);
		await checkpoints.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace, absolutePath: file });
		writeFileSync(file, 'edited');
		await checkpoints.noteAfterWrite('sess', file);
		const checkpoint = await checkpoints.readCheckpoint('sess', 'turn-1');
		assert.ok(checkpoint);
		let replaced = false;
		let reverted = 0;
		const uri = fileUriFromPath(file);
		await restoreCheckpointContents({
			checkpoint,
			documents: [{
				uri,
				getText: () => 'edited',
				isDirty: () => false,
				replaceText: () => { replaced = true; },
				revert: () => { reverted++; },
			}],
			readBlob: hash => checkpoints.readBlob(hash),
			readDisk: uriToRead => readOptional(uriToRead),
			writeDisk: (uriToWrite, bytes) => writeOptional(uriToWrite, bytes),
			confirm: async () => true,
		});
		assert.strictEqual(replaced, false);
		assert.strictEqual(reverted, 1);
		assert.strictEqual(readFileSync(file, 'utf8'), 'original');
	});

	test('an unchanged BOM file and an unchanged CRLF file are not user edits', async () => {
		const userData = directory();
		const workspace = directory();
		const bomFile = join(workspace, 'bom.ts');
		const crlfFile = join(workspace, 'crlf.ts');
		const bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('hello')]);
		writeFileSync(bomFile, bom);
		writeFileSync(crlfFile, 'hello\r\n');
		const checkpoints = openStore(userData);
		await checkpoints.beginTurn({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace }, 30);
		await checkpoints.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace, absolutePath: bomFile });
		await checkpoints.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace, absolutePath: crlfFile });
		await checkpoints.noteAfterWrite('sess', bomFile);
		await checkpoints.noteAfterWrite('sess', crlfFile);
		const checkpoint = await checkpoints.readCheckpoint('sess', 'turn-1');
		assert.ok(checkpoint);
		let replaced: string | undefined;
		await restoreCheckpointContents({
			checkpoint,
			documents: [
				{
					uri: fileUriFromPath(bomFile),
					getText: () => 'hello',
					isDirty: () => false,
					replaceText: value => { replaced = value; },
					revert: () => undefined,
				},
				{
					uri: fileUriFromPath(crlfFile),
					getText: () => 'hello\n',
					isDirty: () => true,
					replaceText: value => { replaced = value; },
				},
			],
			readBlob: hash => checkpoints.readBlob(hash),
			readDisk: uriToRead => readOptional(uriToRead),
			writeDisk: (uriToWrite, bytes) => writeOptional(uriToWrite, bytes),
			confirm: async () => { throw new Error('BOM and CRLF normalization is not a user edit'); },
		});
		assert.strictEqual(replaced, 'hello\n');
		assert.strictEqual(replaced.includes('\r'), false);
		assert.strictEqual(replaced.includes('\uFEFF'), false);
		assert.deepStrictEqual(readFileSync(bomFile), bom);
	});

	test('restoring a created file closes the clean model instead of leaving it empty', async () => {
		const userData = directory();
		const workspace = directory();
		const file = join(workspace, 'created.ts');
		const checkpoints = openStore(userData);
		await checkpoints.beginTurn({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace }, 30);
		await checkpoints.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace, absolutePath: file });
		writeFileSync(file, 'created');
		await checkpoints.noteAfterWrite('sess', file);
		const checkpoint = await checkpoints.readCheckpoint('sess', 'turn-1');
		assert.ok(checkpoint);
		let closed = 0;
		let replaced = false;
		await restoreCheckpointContents({
			checkpoint,
			documents: [{
				uri: fileUriFromPath(file),
				getText: () => 'created',
				isDirty: () => false,
				replaceText: () => { replaced = true; },
				close: () => { closed++; },
			}],
			readBlob: hash => checkpoints.readBlob(hash),
			readDisk: uriToRead => readOptional(uriToRead),
			writeDisk: (uriToWrite, bytes) => writeOptional(uriToWrite, bytes),
			confirm: async () => true,
		});
		assert.strictEqual(closed, 1);
		assert.strictEqual(replaced, false);
		assert.strictEqual(existsSync(file), false);
	});

	test('beginTurn keeps an existing checkpoint with the same id', async () => {
		const userData = directory();
		const workspace = directory();
		const file = join(workspace, 'kept.ts');
		writeFileSync(file, 'saved');
		const checkpoints = openStore(userData);
		const first = await checkpoints.beginTurn({
			sessionId: 'sess',
			turnId: 'turn-1',
			cwd: workspace,
			dirtyFiles: [{ path: file, text: 'unsaved' }],
		}, 30);
		const second = await checkpoints.beginTurn({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace }, 30);
		assert.strictEqual(second.files.length, 1);
		assert.strictEqual(second.files[0].hash, first.files[0].hash);
	});

	test('reads a branch tip that exists only in packed-refs', async () => {
		const userData = directory();
		const workspace = directory();
		const sha = 'b'.repeat(40);
		mkdirSync(join(workspace, '.git'), { recursive: true });
		writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
		writeFileSync(join(workspace, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${sha} refs/heads/main\n`);
		const checkpoint = await openStore(userData).beginTurn({ sessionId: 'sess', turnId: 'turn-1', cwd: workspace }, 30);
		assert.strictEqual(checkpoint.gitHead, sha);
	});

	test('a relative write path is refused by the store', async () => {
		const checkpoints = openStore(directory());
		await assert.rejects(
			() => checkpoints.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: directory(), absolutePath: 'src/a.ts' }),
			/absolute/,
		);
	});

	test('garbage collection keeps objects when a checkpoint is unreadable and drops stale temp files', async () => {
		const userData = directory();
		const checkpoints = openStore(userData);
		const hash = await checkpoints.putBlob(new TextEncoder().encode('orphan'));
		const sessionDir = join(userData, 'agent-sessions', 'sess', 'checkpoints');
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, 'turn-bad.json'), '{');
		const root = checkpointObjectsRoot(userData);
		const stale = join(root, '.tmp-stale');
		const fresh = join(root, '.tmp-fresh');
		writeFileSync(stale, 'old');
		writeFileSync(fresh, 'new');
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
		utimesSync(stale, old, old);
		await checkpoints.garbageCollect(30);
		assert.strictEqual(Buffer.from(await checkpoints.readBlob(hash)).toString(), 'orphan');
		assert.strictEqual(existsSync(stale), false);
		assert.strictEqual(existsSync(fresh), true);
	});

	test('a failed write still records afterHash so a later user edit conflicts', async () => {
		const userData = directory();
		const workspace = directory();
		const file = join(workspace, 'a.ts');
		writeFileSync(file, 'before-write');
		const checkpoints = openStore(userData);
		const registry = store.add(new ClaudeProcessRegistry());
		let captured: ClaudeQueryStart | undefined;
		let releaseTool: (() => void) | undefined;
		let releaseEnd: (() => void) | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			checkpoints,
			permissionHost: new ClaudePermissionHost({ getPolicy: () => ({ ...DEFAULT_PERMISSION_POLICY, writeWorkspace: 'allow' }) }),
			queryFactory: async start => {
				captured = start;
				return failingWriteQuery(() => releaseTool, fn => { releaseTool = fn; }, () => releaseEnd, fn => { releaseEnd = fn; });
			},
		}));
		const seen: { type: string }[] = [];
		const done = (async () => {
			for await (const event of runner.start({
				sessionId: 'sess',
				prompt: 'edit',
				cwd: workspace,
				mode: 'agent',
				workspaceTrusted: true,
				turnId: 'turn-9',
				checkpointSessionId: 'sess',
			})) {
				seen.push(event);
			}
		})();
		await waitFor(() => seen.some(event => event.type === 'session.started') && releaseTool !== undefined);
		const decision = await captured!.options.canUseTool('Write', { file_path: file, content: 'after' }, { signal: new AbortController().signal, toolUseID: 'w1' });
		assert.strictEqual(decision.behavior, 'allow');
		releaseTool?.();
		await waitFor(() => seen.some(event => event.type === 'tool.completed'));
		const beforeEdit = await checkpoints.readCheckpoint('sess', 'turn-9');
		const recorded = beforeEdit?.files.find(entry => entry.existed);
		assert.ok(recorded?.afterHash);
		assert.strictEqual(recorded.afterHash, await sha256Hex(readFileSync(file)));
		writeFileSync(file, 'typed-by-user');
		await runner.interrupt('sess');
		const afterInterrupt = await checkpoints.readCheckpoint('sess', 'turn-9');
		assert.strictEqual(afterInterrupt?.files.find(entry => entry.existed)?.afterHash, recorded.afterHash);
		let labels: string[] = [];
		const declined = await restoreCheckpointContents({
			checkpoint: afterInterrupt!,
			documents: [],
			readBlob: hash => checkpoints.readBlob(hash),
			readDisk: uri => readOptional(uri),
			writeDisk: (uri, bytes) => writeOptional(uri, bytes),
			confirm: async conflicts => {
				labels = conflicts.map(conflict => conflict.label);
				return false;
			},
		});
		assert.strictEqual(declined, 'cancelled');
		assert.deepStrictEqual(labels, ['a.ts']);
		releaseEnd?.();
		await done;
	});

	test('a write in flight at interrupt does not conflict on restore', async () => {
		const userData = directory();
		const workspace = directory();
		const file = join(workspace, 'a.ts');
		writeFileSync(file, 'before-write');
		const checkpoints = openStore(userData);
		const registry = store.add(new ClaudeProcessRegistry());
		let captured: ClaudeQueryStart | undefined;
		let release: (() => void) | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			checkpoints,
			permissionHost: new ClaudePermissionHost({ getPolicy: () => ({ ...DEFAULT_PERMISSION_POLICY, writeWorkspace: 'allow' }) }),
			queryFactory: async start => {
				captured = start;
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: 'system', subtype: 'init', slash_commands: [], skills: [], session_id: 'sdk-session' };
						await new Promise<void>(resolve => { release = resolve; });
					},
					interrupt: async () => {
						writeFileSync(file, 'landed-during-interrupt');
						release?.();
					},
					setModel: async () => undefined,
					supportedModels: async () => [],
					supportedCommands: async () => [],
					stopTask: async () => undefined,
					close: () => release?.(),
				};
			},
		}));
		const seen: { type: string }[] = [];
		const done = (async () => {
			for await (const event of runner.start({
				sessionId: 'sess',
				prompt: 'edit',
				cwd: workspace,
				mode: 'agent',
				workspaceTrusted: true,
				turnId: 'turn-inflight',
				checkpointSessionId: 'sess',
			})) {
				seen.push(event);
			}
		})();
		await waitFor(() => seen.some(event => event.type === 'session.started') && release !== undefined && captured !== undefined);
		const decision = await captured!.options.canUseTool('Write', { file_path: file, content: 'after' }, { signal: new AbortController().signal, toolUseID: 'w1' });
		assert.strictEqual(decision.behavior, 'allow');
		assert.strictEqual(readFileSync(file, 'utf8'), 'before-write');
		await runner.interrupt('sess');
		const checkpoint = await checkpoints.readCheckpoint('sess', 'turn-inflight');
		assert.ok(checkpoint);
		let asked = false;
		const outcome = await restoreCheckpointContents({
			checkpoint,
			documents: [],
			readBlob: hash => checkpoints.readBlob(hash),
			readDisk: uri => readOptional(uri),
			writeDisk: (uri, bytes) => writeOptional(uri, bytes),
			confirm: async () => {
				asked = true;
				return false;
			},
		});
		assert.strictEqual(asked, false);
		assert.strictEqual(outcome, 'restored');
		assert.strictEqual(readFileSync(file, 'utf8'), 'before-write');
		await done;
	});

	test('a snapshot failure denies the write on the policy path and the user path', async () => {
		const workspace = directory();
		const file = join(workspace, 'a.ts');
		mkdirSync(workspace, { recursive: true });
		writeFileSync(file, 'before-write');
		const policy = await decideWrite(workspace, file, true);
		assert.strictEqual(policy.behavior, 'deny');
		assert.match(policy.message ?? '', /snapshot/);
		const user = await decideWrite(workspace, file, false);
		assert.strictEqual(user.behavior, 'deny');
		assert.match(user.message ?? '', /snapshot/);
	});

	test('a relative file_path is snapshotted before the write is allowed', async () => {
		const userData = directory();
		const workspace = directory();
		const file = join(workspace, 'src', 'a.ts');
		mkdirSync(join(workspace, 'src'), { recursive: true });
		writeFileSync(file, 'before-write');
		const checkpoints = openStore(userData);
		const registry = store.add(new ClaudeProcessRegistry());
		let captured: ClaudeQueryStart | undefined;
		let release: (() => void) | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			checkpoints,
			permissionHost: new ClaudePermissionHost({ getPolicy: () => ({ ...DEFAULT_PERMISSION_POLICY, writeWorkspace: 'allow' }) }),
			queryFactory: async start => {
				captured = start;
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(() => release, fn => { release = fn; });
			},
		}));
		const seen: { type: string }[] = [];
		const done = (async () => {
			for await (const event of runner.start({
				sessionId: 'sess',
				prompt: 'edit',
				cwd: workspace,
				mode: 'agent',
				workspaceTrusted: true,
				turnId: 'turn-rel',
				checkpointSessionId: 'sess',
			})) {
				seen.push(event);
			}
		})();
		await waitFor(() => seen.some(event => event.type === 'session.started') && release !== undefined);
		const decision = await captured!.options.canUseTool('Write', { file_path: join('src', 'a.ts'), content: 'after' }, { signal: new AbortController().signal, toolUseID: 'w1' });
		assert.strictEqual(decision.behavior, 'allow');
		const checkpoint = await checkpoints.readCheckpoint('sess', 'turn-rel');
		const recorded = checkpoint?.files.find(entry => entry.existed);
		assert.ok(recorded?.hash);
		assert.strictEqual(Buffer.from(await checkpoints.readBlob(recorded.hash)).toString(), 'before-write');
		release?.();
		await done;
	});

	test('two sends without a turn id record two checkpoints', async () => {
		const userData = directory();
		const workspace = directory();
		const checkpoints = openStore(userData);
		const registry = store.add(new ClaudeProcessRegistry());
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			checkpoints,
			queryFactory: async start => {
				await start.prompt[Symbol.asyncIterator]().next();
				return completedQuery();
			},
		}));
		const seen: { type: string }[] = [];
		const done = (async () => {
			for await (const event of runner.start({
				sessionId: 'sess',
				prompt: 'first',
				cwd: workspace,
				mode: 'agent',
				workspaceTrusted: true,
				checkpointSessionId: 'sess',
			})) {
				seen.push(event);
			}
		})();
		await waitFor(() => seen.some(event => event.type === 'session.completed'));
		const second = await runner.send('sess', 'second', 'agent', true, { checkpointSessionId: 'sess' });
		if (second) {
			for await (const event of second) {
				seen.push(event);
			}
		}
		const listed = await checkpoints.listCheckpoints('sess');
		assert.strictEqual(listed.length, 2);
		assert.notStrictEqual(listed[0].id, listed[1].id);
		await done;
	});

	test('a prepareCheckpoint failure closes the turn', async () => {
		const userData = directory();
		const workspace = directory();
		const inner = new NodeCheckpointStorage();
		const checkpoints = new class extends ClaudeCheckpointStore {
			private _calls = 0;
			override beginTurn(input: BeginTurnCheckpoint, retentionDays: number, now?: number) {
				this._calls++;
				if (this._calls > 1) {
					return Promise.reject(new Error('disk full'));
				}
				return super.beginTurn(input, retentionDays, now);
			}
		}(userData, inner);
		const registry = store.add(new ClaudeProcessRegistry());
		let release: (() => void) | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			checkpoints,
			queryFactory: async start => {
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(() => release, fn => { release = fn; });
			},
		}));
		const seen: { type: string }[] = [];
		const done = (async () => {
			for await (const event of runner.start({
				sessionId: 'sess',
				prompt: 'first',
				cwd: workspace,
				mode: 'agent',
				workspaceTrusted: true,
				turnId: 'turn-1',
				checkpointSessionId: 'sess',
			})) {
				seen.push(event);
			}
		})();
		await waitFor(() => seen.some(event => event.type === 'session.started') && release !== undefined);
		await assert.rejects(() => runner.send('sess', 'second', 'agent', true, { turnId: 'turn-2', checkpointSessionId: 'sess' }), /disk full/);
		assert.strictEqual(seen.some(event => event.type === 'session.failed'), false);
		release?.();
		await done;
	});

	test('a failed send during a running turn leaves that turn running', async () => {
		const userData = directory();
		const workspace = directory();
		const file = join(workspace, 'a.ts');
		writeFileSync(file, 'before-write');
		const inner = new NodeCheckpointStorage();
		const checkpoints = new class extends ClaudeCheckpointStore {
			private _calls = 0;
			override beginTurn(input: BeginTurnCheckpoint, retentionDays: number, now?: number) {
				this._calls++;
				if (this._calls > 1) {
					return Promise.reject(new Error('disk full'));
				}
				return super.beginTurn(input, retentionDays, now);
			}
		}(userData, inner);
		const registry = store.add(new ClaudeProcessRegistry());
		let captured: ClaudeQueryStart | undefined;
		let release: (() => void) | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			checkpoints,
			permissionHost: new ClaudePermissionHost({ getPolicy: () => ({ ...DEFAULT_PERMISSION_POLICY, writeWorkspace: 'allow' }) }),
			queryFactory: async start => {
				captured = start;
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(() => release, fn => { release = fn; });
			},
		}));
		const seen: { type: string }[] = [];
		const done = (async () => {
			for await (const event of runner.start({
				sessionId: 'sess',
				prompt: 'first',
				cwd: workspace,
				mode: 'agent',
				workspaceTrusted: true,
				turnId: 'turn-1',
				checkpointSessionId: 'sess',
			})) {
				seen.push(event);
			}
		})();
		await waitFor(() => seen.some(event => event.type === 'session.started') && release !== undefined && captured !== undefined);
		await assert.rejects(() => runner.send('sess', 'second', 'agent', true, { turnId: 'turn-2', checkpointSessionId: 'other-session' }), /disk full/);
		assert.strictEqual(seen.some(event => event.type === 'session.failed'), false);
		const decision = await captured!.options.canUseTool('Write', { file_path: file, content: 'after' }, { signal: new AbortController().signal, toolUseID: 'w1' });
		assert.strictEqual(decision.behavior, 'allow');
		const listed = await checkpoints.listCheckpoints('sess');
		assert.deepStrictEqual(listed.map(entry => entry.id), ['turn-1']);
		assert.deepStrictEqual(await checkpoints.listCheckpoints('other-session'), []);
		release?.();
		await done;
		assert.ok(seen.some(event => event.type === 'session.completed'));
		assert.strictEqual(seen.some(event => event.type === 'session.failed'), false);
	});

	test('disabled checkpoints skip beginTurn and still garbage-collect', async () => {
		const userData = directory();
		const workspace = directory();
		const file = join(workspace, 'old.ts');
		writeFileSync(file, 'old');
		const checkpoints = openStore(userData);
		const orphan = await checkpoints.putBlob(new TextEncoder().encode('orphan'));
		await checkpoints.beginTurn({
			sessionId: 'sess',
			turnId: 'turn-old',
			cwd: workspace,
			dirtyFiles: [{ path: file, text: 'old buffer' }],
		}, 30, 1_000);
		const registry = store.add(new ClaudeProcessRegistry());
		let release: (() => void) | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			checkpoints,
			checkpointsEnabled: () => false,
			retentionDays: () => 0,
			queryFactory: async start => {
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(() => release, fn => { release = fn; });
			},
		}));
		const seen: { type: string }[] = [];
		const done = (async () => {
			for await (const event of runner.start({
				sessionId: 'sess',
				prompt: 'edit',
				cwd: workspace,
				mode: 'agent',
				workspaceTrusted: true,
				checkpointSessionId: 'sess',
			})) {
				seen.push(event);
			}
		})();
		await waitFor(() => seen.some(event => event.type === 'session.started') && release !== undefined);
		assert.strictEqual(await checkpoints.readCheckpoint('sess', 'turn-old'), undefined);
		assert.deepStrictEqual(await checkpoints.listCheckpoints('sess'), []);
		await assert.rejects(() => checkpoints.readBlob(orphan));
		release?.();
		await done;
	});

	test('the index is read once per turn, and a worktree gitdir is followed', async () => {
		const userData = directory();
		const main = directory();
		const work = join(main, 'wt');
		const gitDir = join(main, '.git', 'worktrees', 'wt');
		mkdirSync(join(work, 'src'), { recursive: true });
		mkdirSync(gitDir, { recursive: true });
		const sha = 'c'.repeat(40);
		const blob = 'ab'.repeat(20);
		writeFileSync(join(gitDir, 'HEAD'), `${sha}\n`);
		writeFileSync(join(work, '.git'), 'gitdir: ../.git/worktrees/wt\n');
		writeFileSync(join(gitDir, 'index'), Buffer.from(encodeGitIndex([{ path: 'src/a.ts', blob }])));
		const left = join(work, 'src', 'a.ts');
		const right = join(work, 'src', 'b.ts');
		writeFileSync(left, 'left');
		writeFileSync(right, 'right');
		const inner = new NodeCheckpointStorage();
		let indexReads = 0;
		const storage: CheckpointStorage = {
			exists: path => inner.exists(path),
			readFile: async path => {
				if (path.replace(/\\/g, '/').endsWith('/index')) {
					indexReads++;
				}
				return inner.readFile(path);
			},
			writeFile: (path, bytes) => inner.writeFile(path, bytes),
			rename: (from, to) => inner.rename(from, to),
			mkdir: path => inner.mkdir(path),
			readDir: path => inner.readDir(path),
			remove: path => inner.remove(path),
			stat: path => inner.stat(path),
			hashFile: path => inner.hashFile(path),
		};
		const indexLogs: string[] = [];
		const checkpoints = new ClaudeCheckpointStore(userData, storage, { pid: process.pid, log: message => indexLogs.push(message) });
		const nested = join(work, 'src');
		await checkpoints.beginTurn({ sessionId: 'sess', turnId: 'turn-1', cwd: nested }, 30);
		await checkpoints.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: nested, absolutePath: left });
		await checkpoints.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: nested, absolutePath: left });
		await checkpoints.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-1', cwd: nested, absolutePath: right });
		assert.strictEqual(indexReads, 1);
		const checkpoint = await checkpoints.readCheckpoint('sess', 'turn-1');
		assert.strictEqual(checkpoint?.gitHead, sha);
		assert.strictEqual(checkpoint?.files.find(file => file.uri === fileUriFromPath(left))?.indexBlob, blob);
		assert.strictEqual(checkpoint?.files.find(file => file.uri === fileUriFromPath(right))?.indexBlob, null);
		writeFileSync(join(gitDir, 'index'), Buffer.from('not an index'));
		await checkpoints.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-2', cwd: nested, absolutePath: left });
		assert.strictEqual(checkpoints.lastGitIndexError(), 'Git index could not be parsed.');
		assert.ok(indexLogs.includes('Git index could not be parsed.'));
		writeFileSync(join(gitDir, 'index'), Buffer.from(encodeGitIndex([{ path: 'src/a.ts', blob }])));
		await checkpoints.snapshotApprovedWrite({ sessionId: 'sess', turnId: 'turn-3', cwd: nested, absolutePath: left });
		assert.strictEqual(checkpoints.lastGitIndexError(), undefined);
	});

	test('retention defaults to 30 days and only an explicit false disables checkpoints', () => {
		assert.strictEqual(readCheckpointRetentionDays(undefined), 30);
		assert.strictEqual(readCheckpointRetentionDays(0), 0);
		assert.strictEqual(readCheckpointRetentionDays(-1), 30);
		assert.strictEqual(readCheckpointsEnabled(undefined), true);
		assert.strictEqual(readCheckpointsEnabled(false), false);
	});

	function directory(): string {
		const folder = mkdtempSync(join(tmpdir(), 'klawly-checkpoint-'));
		folders.push(folder);
		return folder;
	}

	function openStore(userData: string, largeFileBytes?: number): ClaudeCheckpointStore {
		return new ClaudeCheckpointStore(userData, new NodeCheckpointStorage(), { pid: process.pid, largeFileBytes });
	}

	async function decideWrite(workspace: string, file: string, policyAllow: boolean): Promise<{ behavior: string; message?: string }> {
		const userData = directory();
		const inner = new NodeCheckpointStorage();
		let writes = 0;
		const storage: CheckpointStorage = {
			exists: path => inner.exists(path),
			readFile: path => inner.readFile(path),
			writeFile: async (path, bytes) => {
				writes++;
				if (writes > 1) {
					throw new Error('disk full');
				}
				await inner.writeFile(path, bytes);
			},
			rename: (from, to) => inner.rename(from, to),
			mkdir: path => inner.mkdir(path),
			readDir: path => inner.readDir(path),
			remove: path => inner.remove(path),
			stat: path => inner.stat(path),
			hashFile: path => inner.hashFile(path),
		};
		const checkpoints = new ClaudeCheckpointStore(userData, storage);
		const registry = store.add(new ClaudeProcessRegistry());
		let captured: ClaudeQueryStart | undefined;
		let release: (() => void) | undefined;
		let asked = false;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			checkpoints,
			// The user path needs a card, so workspace edits ask there as under the prompt preset.
			permissionHost: new ClaudePermissionHost({ getPolicy: () => ({ ...DEFAULT_PERMISSION_POLICY, writeWorkspace: policyAllow ? 'allow' : 'ask' }) }),
			queryFactory: async start => {
				captured = start;
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(() => release, fn => { release = fn; });
			},
		}));
		const seen: { type: string }[] = [];
		const done = (async () => {
			for await (const event of runner.start({
				sessionId: 'sess',
				prompt: 'edit',
				cwd: workspace,
				mode: 'agent',
				workspaceTrusted: true,
				turnId: 'turn-snap',
				checkpointSessionId: 'sess',
				permissionBridge: {
					request: async () => {
						asked = true;
						return { behavior: 'allow' };
					},
				},
			})) {
				seen.push(event);
			}
		})();
		await waitFor(() => seen.some(event => event.type === 'session.started') && release !== undefined);
		const decision = await captured!.options.canUseTool('Write', { file_path: file, content: 'after' }, { signal: new AbortController().signal, toolUseID: 'w1' });
		if (!policyAllow) {
			assert.strictEqual(asked, true);
		}
		release?.();
		await done;
		return decision;
	}
});

function readOptional(uri: string): Promise<Uint8Array | null> {
	try {
		return Promise.resolve(readFileSync(filePath(uri)));
	} catch {
		return Promise.resolve(null);
	}
}

function writeOptional(uri: string, bytes: Uint8Array | null): Promise<void> {
	const path = filePath(uri);
	if (bytes === null) {
		rmSync(path, { force: true });
		return Promise.resolve();
	}
	writeFileSync(path, bytes);
	return Promise.resolve();
}

function filePath(uri: string): string {
	return fsPathFromCheckpointUri(uri);
}

function completedQuery(): ClaudeQuery {
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: 'system', subtype: 'init', slash_commands: [], skills: [], session_id: 'sdk-session' };
			yield { type: 'result', subtype: 'success', result: 'ok' };
		},
		interrupt: async () => undefined,
		setModel: async () => undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => undefined,
	};
}

function failingWriteQuery(getReleaseTool: () => (() => void) | undefined, setReleaseTool: (release: () => void) => void, getReleaseEnd: () => (() => void) | undefined, setReleaseEnd: (release: () => void) => void): ClaudeQuery {
	const ended = new Promise<void>(resolve => setReleaseEnd(resolve));
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: 'system', subtype: 'init', slash_commands: [], skills: [], session_id: 'sdk-session' };
			await new Promise<void>(resolve => setReleaseTool(resolve));
			yield {
				type: 'user',
				message: {
					role: 'user',
					content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'failed', is_error: true }],
				},
			};
			await ended;
		},
		interrupt: async () => getReleaseEnd()?.(),
		setModel: async () => undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => {
			getReleaseTool()?.();
			getReleaseEnd()?.();
		},
	};
}

function idleQuery(getRelease: () => (() => void) | undefined, setRelease: (release: () => void) => void): ClaudeQuery {
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: 'system', subtype: 'init', slash_commands: [], skills: [], session_id: 'sdk-session' };
			await new Promise<void>(resolve => setRelease(resolve));
		},
		interrupt: async () => getRelease()?.(),
		setModel: async () => undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => getRelease()?.(),
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > 5000) {
			assert.fail('condition was not met');
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}
