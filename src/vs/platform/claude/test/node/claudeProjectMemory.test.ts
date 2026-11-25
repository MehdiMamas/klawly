/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { parseGitConfigRemote, readGitRemote, resolveClaudeProjectIdentity, resolveClaudeProjectMemory, setClaudeProjectIdentity } from '../../node/claudeProjectMemory.js';

suite('Claude project memory (issue 448)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'klawly-memory-'));
	});
	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function repo(name: string, remote: string): Promise<string> {
		const dir = join(root, name);
		await fs.mkdir(join(dir, '.git'), { recursive: true });
		await fs.mkdir(join(dir, 'src'), { recursive: true });
		await fs.writeFile(join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://example.com/x/y.git\n[remote "origin"]\n\turl = ${remote}\n`);
		return dir;
	}

	test('parseGitConfigRemote prefers origin and falls back to the first remote', () => {
		assert.deepStrictEqual(
			[
				parseGitConfigRemote('[remote "upstream"]\n\turl = a/b\n[remote "origin"]\n\turl = git@github.com:O/R.git\n'),
				parseGitConfigRemote('[remote "fork"]\n\turl = https://h/o/r\n'),
				parseGitConfigRemote('[core]\n\tbare = false\n'),
			],
			['git@github.com:O/R.git', 'https://h/o/r', undefined]
		);
	});

	test('the identity comes from the remote, also from a subfolder and a linked worktree', async () => {
		const dir = await repo('app', 'git@github.com:Owner/App.git');
		const layer = join(root, 'layer');
		const linked = join(root, 'linked');
		await fs.mkdir(join(dir, '.git', 'worktrees', 'w'), { recursive: true });
		await fs.writeFile(join(dir, '.git', 'worktrees', 'w', 'commondir'), '../..\n');
		await fs.mkdir(linked);
		await fs.writeFile(join(linked, '.git'), `gitdir: ${join(dir, '.git', 'worktrees', 'w')}\n`);
		assert.deepStrictEqual(
			[
				await readGitRemote(join(dir, 'src')),
				await resolveClaudeProjectIdentity(layer, join(dir, 'src')),
				await resolveClaudeProjectIdentity(layer, linked),
			],
			['git@github.com:Owner/App.git', 'github.com/owner/app', 'github.com/owner/app']
		);
	});

	test('a folder with no remote takes the alias of the closest named folder; a bad table is ignored', async () => {
		const layer = join(root, 'layer');
		const plain = join(root, 'plain');
		await fs.mkdir(join(plain, 'deep'), { recursive: true });
		assert.strictEqual(await resolveClaudeProjectIdentity(layer, plain), undefined);
		await setClaudeProjectIdentity(layer, root, 'outer');
		await setClaudeProjectIdentity(layer, plain, 'My Notes');
		assert.deepStrictEqual(
			[await resolveClaudeProjectIdentity(layer, join(plain, 'deep')), await resolveClaudeProjectIdentity(layer, root)],
			['alias/my-notes', 'alias/outer']
		);
		await setClaudeProjectIdentity(layer, plain, '');
		assert.strictEqual(await resolveClaudeProjectIdentity(layer, join(plain, 'deep')), 'alias/outer');
		await fs.writeFile(join(layer, 'project-identities.json'), '{not json');
		assert.strictEqual(await resolveClaudeProjectIdentity(layer, plain), undefined);
	});

	test('the prompt carries the notes of the project and names the folder to write in', async () => {
		const dir = await repo('app', 'https://github.com/Owner/App');
		const layer = join(root, 'layer');
		const none = await resolveClaudeProjectMemory(layer, join(dir, 'src'));
		assert.ok(none?.prompt.includes('(no notes yet)'));
		await fs.mkdir(none!.directory, { recursive: true });
		await fs.writeFile(join(none!.directory, 'b.md'), 'Use tabs.\n');
		await fs.writeFile(join(none!.directory, 'a.md'), 'Run the tests first.\n');
		await fs.writeFile(join(none!.directory, 'skip.txt'), 'ignored');
		const memory = await resolveClaudeProjectMemory(layer, dir);
		assert.deepStrictEqual(
			{ identity: memory?.identity, folder: memory?.directory, order: [memory!.prompt.indexOf('### a.md'), memory!.prompt.indexOf('### b.md')].every((v, i, all) => v > 0 && (i === 0 || v > all[i - 1])), hasText: memory!.prompt.includes('Run the tests first.') && !memory!.prompt.includes('ignored'), writes: memory!.prompt.includes(memory!.directory) },
			{ identity: 'github.com/owner/app', folder: join(layer, 'memory', 'github.com__owner__app'), order: true, hasText: true, writes: true }
		);
	});

	test('a project with no identity gets no memory', async () => {
		const plain = join(root, 'plain');
		await fs.mkdir(plain);
		assert.strictEqual(await resolveClaudeProjectMemory(join(root, 'layer'), plain), undefined);
	});
});
