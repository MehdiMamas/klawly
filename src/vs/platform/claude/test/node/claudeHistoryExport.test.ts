/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { compactClaudeTranscript, exportClaudeHistory, previewClaudeHistory, readImportedClaudeHistory } from '../../node/claudeHistoryExport.js';

suite('Claude history export (issue 448)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let layer: string;
	let userData: string;
	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'klawly-history-'));
		layer = join(root, 'layer');
		userData = join(root, 'userData');
	});
	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const line = (ts: number, event: object) => JSON.stringify({ v: 1, ts, event }) + '\n';

	async function repo(name: string, remote: string): Promise<string> {
		const dir = join(root, name);
		await fs.mkdir(join(dir, '.git'), { recursive: true });
		await fs.writeFile(join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${remote}\n`);
		return dir;
	}

	async function session(id: string, updatedAt: number, projectFolder: string | undefined, events: string): Promise<{ id: string; updatedAt: number; projectFolder?: string }> {
		await fs.mkdir(join(userData, 'agent-sessions', id), { recursive: true });
		await fs.writeFile(join(userData, 'agent-sessions', id, 'events.jsonl'), events);
		return { id, updatedAt, projectFolder };
	}

	async function index(sessions: object[]): Promise<void> {
		await fs.mkdir(join(userData, 'agent-sessions'), { recursive: true });
		await fs.writeFile(join(userData, 'agent-sessions', 'index.json'), JSON.stringify({ schemaVersion: 1, sessions }));
	}

	const talk = (q: string, a: string) => line(1, { type: 'turn.submitted', text: q }) + line(2, { type: 'assistant.delta', text: 'partial' }) + line(3, { type: 'tool.started', text: 'ls' }) + line(4, { type: 'assistant.completed', text: a });

	const FAKE_KEY = ['sk', '-ant-', 'api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'].join('');
	const transcriptFolder = (identitySlug: string) => join(layer, 'history', 'transcripts', identitySlug);

	test('only what was said and answered is kept', () => {
		assert.deepStrictEqual(
			compactClaudeTranscript(talk('hi', 'hello') + 'not json\n'),
			[{ role: 'user', ts: 1, text: 'hi' }, { role: 'assistant', ts: 4, text: 'hello' }]
		);
	});

	test('two local paths of one repo land in one project folder; no identity, no export; no prompt file is written', async () => {
		const first = await repo('app', 'git@github.com:Owner/App.git');
		const second = await repo('app-copy', 'https://github.com/owner/app');
		const plain = join(root, 'plain');
		await fs.mkdir(plain);
		await index([await session('s1', 10, first, talk('q1', 'a1')), await session('s2', 20, second, talk('q2', 'a2')), await session('s3', 30, plain, talk('q3', 'a3'))]);
		const result = await exportClaudeHistory({ layer, userDataPath: userData });
		assert.deepStrictEqual(
			{ result, files: (await fs.readdir(transcriptFolder('github.com__owner__app'))).sort(), folders: await fs.readdir(join(layer, 'history')), again: (await exportClaudeHistory({ layer, userDataPath: userData })).written },
			{ result: { written: 2, heldBack: 0 }, files: ['s1.jsonl', 's2.jsonl'], folders: ['transcripts'], again: 0 }
		);
	});

	test('keep-last-N: only the newest sessions stay, and a pruned one is removed while another machine\'s file is left', async () => {
		const dir = await repo('app', 'https://github.com/Owner/App');
		const folder = transcriptFolder('github.com__owner__app');
		await fs.mkdir(folder, { recursive: true });
		await fs.writeFile(join(folder, 'other-machine.jsonl'), 'theirs\n');
		await index([await session('old', 1, dir, talk('q', 'a')), await session('mid', 2, dir, talk('q', 'a')), await session('new', 3, dir, talk('q', 'a'))]);
		await exportClaudeHistory({ layer, userDataPath: userData, maxSessions: 2 });
		assert.deepStrictEqual((await fs.readdir(folder)).sort(), ['mid.jsonl', 'new.jsonl', 'other-machine.jsonl']);
		await fs.writeFile(join(folder, 'old.jsonl'), 'stale\n');
		await exportClaudeHistory({ layer, userDataPath: userData, maxSessions: 2 });
		assert.deepStrictEqual((await fs.readdir(folder)).sort(), ['mid.jsonl', 'new.jsonl', 'other-machine.jsonl']);
	});

	test('size cap: a long transcript keeps the newest whole lines that fit', async () => {
		const dir = await repo('app', 'https://github.com/Owner/App');
		let events = '';
		for (let i = 0; i < 10; i++) {
			events += line(i, { type: 'turn.submitted', text: `question ${i}` });
		}
		await index([await session('s', 1, dir, events)]);
		await exportClaudeHistory({ layer, userDataPath: userData, maxBytes: 100 });
		const kept = (await fs.readFile(join(transcriptFolder('github.com__owner__app'), 's.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l).text);
		assert.deepStrictEqual({ last: kept[kept.length - 1], fewer: kept.length < 10 }, { last: 'question 9', fewer: true });
	});

	test('size cap is per project in total: older sessions that no longer fit are dropped', async () => {
		const dir = await repo('app', 'https://github.com/Owner/App');
		const big = talk('q'.repeat(300), 'a'.repeat(300));
		await index([await session('older', 1, dir, big), await session('newer', 2, dir, big)]);
		await exportClaudeHistory({ layer, userDataPath: userData, maxBytes: 700 });
		assert.deepStrictEqual(await fs.readdir(transcriptFolder('github.com__owner__app')), ['newer.jsonl']);
	});

	test('the exclude list keeps a project out, without regard to case, and removes its earlier copy', async () => {
		const kept = await repo('app', 'https://github.com/Owner/App');
		const secret = await repo('private', 'https://github.com/Owner/Private');
		const folder = transcriptFolder('github.com__owner__private');
		await fs.mkdir(folder, { recursive: true });
		await fs.writeFile(join(folder, 'p1.jsonl'), 'earlier copy\n');
		await index([await session('a1', 1, kept, talk('q', 'a')), await session('p1', 2, secret, talk('q', 'a'))]);
		const options = { layer, userDataPath: userData, excludedProjects: ['GitHub.com/owner/PRIVATE'] };
		await exportClaudeHistory(options);
		const preview = await previewClaudeHistory(options);
		assert.deepStrictEqual(
			{ private: await fs.readdir(folder), app: await fs.readdir(transcriptFolder('github.com__owner__app')), preview: preview.projects.map(p => [p.identity, p.excluded, p.sessions]).sort() },
			{ private: [], app: ['a1.jsonl'], preview: [['github.com/owner/app', false, 1], ['github.com/owner/private', true, 0]] }
		);
	});

	test('secret scan: a transcript with a key is not written and a stale copy is removed; the others still go', async () => {
		const dir = await repo('app', 'https://github.com/Owner/App');
		const folder = transcriptFolder('github.com__owner__app');
		await fs.mkdir(folder, { recursive: true });
		await fs.writeFile(join(folder, 'leaky.jsonl'), 'stale copy\n');
		await index([await session('leaky', 2, dir, talk(`my key is ${FAKE_KEY}`, 'ok')), await session('clean', 1, dir, talk('hello', 'hi'))]);
		const result = await exportClaudeHistory({ layer, userDataPath: userData });
		const text = (await Promise.all((await fs.readdir(folder)).map(f => fs.readFile(join(folder, f), 'utf8')))).join('');
		assert.deepStrictEqual({ result, files: await fs.readdir(folder), leaked: text.includes(FAKE_KEY) }, { result: { written: 1, heldBack: 1 }, files: ['clean.jsonl'], leaked: false });
	});

	test('preview: sizes, session counts, held-back sessions and the first thing asked, without writing anything', async () => {
		const dir = await repo('app', 'https://github.com/Owner/App');
		await index([await session('a', 1, dir, talk('How do I   fix the build?', 'x')), await session('b', 2, dir, talk(`key ${FAKE_KEY}`, 'y'))]);
		const preview = await previewClaudeHistory({ layer, userDataPath: userData });
		assert.deepStrictEqual(
			{ preview: { ...preview, projects: preview.projects.map(p => ({ ...p, bytes: p.bytes > 0 })) }, written: await fs.readdir(layer).catch(() => []) },
			{ preview: { projects: [{ identity: 'github.com/owner/app', excluded: false, sessions: 1, bytes: true, heldBack: 1, samples: ['How do I fix the build?'] }], totalBytes: preview.projects[0].bytes }, written: [] }
		);
	});

	test('a missing or broken index exports nothing', async () => {
		assert.strictEqual((await exportClaudeHistory({ layer, userDataPath: userData })).written, 0);
		await fs.mkdir(join(userData, 'agent-sessions'), { recursive: true });
		await fs.writeFile(join(userData, 'agent-sessions', 'index.json'), '{broken');
		assert.strictEqual((await exportClaudeHistory({ layer, userDataPath: userData })).written, 0);
	});

	test('the export records the machine in its own manifest, and without a machine writes none', async () => {
		const dir = await repo('app', 'https://github.com/owner/app');
		await index([await session('s1', 10, dir, talk('q1', 'a1'))]);
		await exportClaudeHistory({ layer, userDataPath: userData });
		assert.deepStrictEqual(await fs.readdir(join(layer, 'history')), ['transcripts']);
		await exportClaudeHistory({ layer, userDataPath: userData, machine: 'Alex Laptop' });
		const manifest = JSON.parse(await fs.readFile(join(layer, 'history', 'machines', 'alex-laptop.json'), 'utf8'));
		assert.deepStrictEqual(manifest, { machine: 'Alex Laptop', transcripts: ['github.com__owner__app/s1'] });
	});

	test('import: lists other machines\' sessions with their machine, skips this machine, held-back and missing files', async () => {
		const dir = await repo('app', 'https://github.com/owner/app');
		await index([await session('mine', 10, dir, talk('mine q', 'a')), await session('leak', 20, dir, talk(FAKE_KEY, 'a'))]);
		await exportClaudeHistory({ layer, userDataPath: userData, machine: 'Laptop' });
		// Another machine's export arrives through the sync: its manifest and its transcript.
		const folder = transcriptFolder('github.com__owner__app');
		await fs.writeFile(join(folder, 'remote.jsonl'), JSON.stringify({ role: 'user', ts: 1, text: 'Fix the\n  build please' }) + '\n');
		await fs.writeFile(join(layer, 'history', 'machines', 'desktop.json'), JSON.stringify({ machine: 'Desktop', transcripts: ['github.com__owner__app/remote', 'github.com__owner__app/gone', '../evil/x'] }));
		await fs.writeFile(join(layer, 'history', 'machines', 'broken.json'), '{nope');
		const imported = await readImportedClaudeHistory(layer, 'Laptop');
		assert.deepStrictEqual(imported.map(({ machine, identitySlug, id, firstPrompt }) => ({ machine, identitySlug, id, firstPrompt })), [{ machine: 'Desktop', identitySlug: 'github.com__owner__app', id: 'remote', firstPrompt: 'Fix the build please' }]);
		assert.deepStrictEqual((await readImportedClaudeHistory(layer, 'Desktop')).map(s => [s.machine, s.id]), [['Laptop', 'mine']]);
	});

	test('import: no history folder lists nothing', async () => {
		assert.deepStrictEqual(await readImportedClaudeHistory(layer, 'Laptop'), []);
	});
});
