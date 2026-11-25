/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeCheckpointStore } from '../../common/claudeCheckpointStore.js';
import { claudeRemoteUri, parseClaudeRemoteUri } from '../../common/claudeRemoteFiles.js';
import { NodeCheckpointStorage } from '../../node/claudeCheckpointNodeStorage.js';
import { ClaudeTargetHost } from '../../node/claudeExecutionTarget.js';
import { buildClaudeRemoteFileCommand, ClaudeRemoteCommand, ClaudeRemoteFiles, ClaudeRemoteResult, parseClaudeRemoteStat } from '../../node/claudeRemoteFiles.js';

const HOST: ClaudeTargetHost = {
	env: { PATH: '/usr/bin', SSH_AUTH_SOCK: '/tmp/agent.sock', ANTHROPIC_API_KEY: 'sk-secret' },
	nodePath: '/opt/klawly/klawly',
	devContainerCliPath: '/opt/klawly/devcontainer.js',
};

function answers(...list: ClaudeRemoteResult[]): { run: (command: ClaudeRemoteCommand) => Promise<ClaudeRemoteResult>; ran: ClaudeRemoteCommand[] } {
	const ran: ClaudeRemoteCommand[] = [];
	return {
		ran,
		run: async command => {
			ran.push(command);
			return list.shift() ?? { code: 1, stdout: new Uint8Array(), stderr: 'unexpected command' };
		},
	};
}

function ok(text = ''): ClaudeRemoteResult {
	return { code: 0, stdout: VSBuffer.fromString(text).buffer, stderr: '' };
}

async function failure(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return 'no error';
}

suite('claudeRemoteFiles', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const folders: string[] = [];

	teardown(() => {
		for (const folder of folders.splice(0)) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	test('each operation is one ssh line on a quoted path, with no credential in ssh\'s environment', () => {
		const path = '/srv/shop/it\'s a.ts';
		const quoted = `'/srv/shop/it'\\''s a.ts'`;
		const line = (operation: 'stat' | 'read' | 'write' | 'delete') => buildClaudeRemoteFileCommand(HOST, 'me@build-box', operation, path).args.at(-1);
		assert.deepStrictEqual({
			command: buildClaudeRemoteFileCommand(HOST, 'me@build-box', 'read', path),
			stat: line('stat'),
			write: line('write'),
			delete: line('delete'),
		}, {
			command: { command: 'ssh', args: ['-T', '-o', 'BatchMode=yes', '--', 'me@build-box', `[ -e ${quoted} ] || exit 3; cat -- ${quoted}`], env: { PATH: '/usr/bin', SSH_AUTH_SOCK: '/tmp/agent.sock' }, stdin: undefined },
			stat: `[ -e ${quoted} ] || exit 3; stat -c '%F|%s|%Y' -- ${quoted} 2>/dev/null || stat -f '%HT|%z|%m' -- ${quoted}`,
			write: `mkdir -p -- "$(dirname -- ${quoted})" && cat > ${quoted}`,
			delete: `rm -f -- ${quoted}`,
		});
	});

	test('a host that reads as an option or a relative path is refused before ssh starts', () => {
		assert.throws(() => buildClaudeRemoteFileCommand(HOST, '-oProxyCommand=evil', 'read', '/srv/a'));
		assert.throws(() => buildClaudeRemoteFileCommand(HOST, 'build-box', 'read', 'src/a.ts'));
		assert.throws(() => buildClaudeRemoteFileCommand(HOST, 'build-box', 'read', '/srv/a\nrm -rf /'));
	});

	test('reads GNU and BSD stat output; anything else is not a stat', () => {
		assert.deepStrictEqual([
			parseClaudeRemoteStat('regular file|12|1700000000\n'),
			parseClaudeRemoteStat('Directory|4096|1700000001'),
			parseClaudeRemoteStat('stat: cannot stat'),
		], [
			{ type: 'file', size: 12, mtime: 1700000000000 },
			{ type: 'directory', size: 4096, mtime: 1700000001000 },
			undefined,
		]);
	});

	test('exit 3 is a missing file, 255 is an unreachable host, and a write sends the bytes on stdin', async () => {
		const runner = answers(ok('before'), { code: 3, stdout: new Uint8Array(), stderr: '' }, ok('regular file|6|1700000000'), { code: 3, stdout: new Uint8Array(), stderr: '' }, ok(), { code: 255, stdout: new Uint8Array(), stderr: 'ssh: connect to host build-box port 22: Connection refused\n' }, { code: 1, stdout: new Uint8Array(), stderr: 'rm: cannot remove: Permission denied\n' });
		const files = new ClaudeRemoteFiles(HOST, runner.run);
		const read = (await files.readFile('build-box', '/srv/a.ts'))?.toString();
		const missing = await files.readFile('build-box', '/srv/gone.ts');
		const stat = await files.stat('build-box', '/srv/a.ts');
		const statMissing = await files.stat('build-box', '/srv/gone.ts');
		await files.writeFile('build-box', '/srv/new/b.ts', VSBuffer.fromString('after'));
		const unreachable = await failure(files.readFile('build-box', '/srv/a.ts'));
		const denied = await failure(files.delete('build-box', '/srv/a.ts'));
		assert.deepStrictEqual({ read, missing, stat, statMissing, stdin: runner.ran[4].stdin && VSBuffer.wrap(runner.ran[4].stdin).toString(), unreachable, denied }, {
			read: 'before',
			missing: undefined,
			stat: { type: 'file', size: 6, mtime: 1700000000000 },
			statMissing: undefined,
			stdin: 'after',
			unreachable: 'Klawly could not connect to build-box over SSH: ssh: connect to host build-box port 22: Connection refused',
			denied: 'build-box:/srv/a.ts: rm: cannot remove: Permission denied',
		});
	});

	test('a claude-remote uri round-trips host and path, and nothing else parses', () => {
		const uri = claudeRemoteUri('me@build-box', '/srv/shop/a.ts');
		assert.deepStrictEqual({
			parsed: parseClaudeRemoteUri(URI.parse(uri.toString())),
			file: parseClaudeRemoteUri(URI.file('/srv/shop/a.ts')),
		}, {
			parsed: { host: 'me@build-box', path: '/srv/shop/a.ts' },
			file: undefined,
		});
	});

	test('a remote write is recorded with its claude-remote uri, before and after bytes', async () => {
		const userData = mkdtempSync(join(tmpdir(), 'klawly-remote-'));
		folders.push(userData);
		const checkpoints = new ClaudeCheckpointStore(userData, new NodeCheckpointStorage());
		const changed = claudeRemoteUri('build-box', '/srv/a.ts').toString();
		const created = claudeRemoteUri('build-box', '/srv/new.ts').toString();
		await checkpoints.snapshotRemoteWrite({ sessionId: 'sess', turnId: 'turn-1', uri: changed, bytes: VSBuffer.fromString('before').buffer });
		await checkpoints.snapshotRemoteWrite({ sessionId: 'sess', turnId: 'turn-1', uri: created, bytes: null });
		// A second write to the same file in the same turn keeps the first snapshot.
		await checkpoints.snapshotRemoteWrite({ sessionId: 'sess', turnId: 'turn-1', uri: changed, bytes: VSBuffer.fromString('middle').buffer });
		await checkpoints.noteRemoteAfterWrite('sess', changed, VSBuffer.fromString('after').buffer);
		await checkpoints.noteRemoteAfterWrite('sess', created, VSBuffer.fromString('new').buffer);
		const checkpoint = await checkpoints.readCheckpoint('sess', 'turn-1');
		const text = async (hash: string | null | undefined) => hash ? VSBuffer.wrap(await checkpoints.readBlob(hash)).toString() : hash;
		const files = await Promise.all((checkpoint?.files ?? []).map(async file => ({ uri: file.uri, existed: file.existed, before: await text(file.hash), after: await text(file.afterHash) })));
		assert.deepStrictEqual(files, [
			{ uri: changed, existed: true, before: 'before', after: 'after' },
			{ uri: created, existed: false, before: undefined, after: 'new' },
		]);
	});
});
