/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { listKlawlySyncMemory } from '../../node/klawlySyncMemoryList.js';

suite('Klawly Sync memory list (issue 448)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let layer: string;
	setup(async () => {
		layer = await fs.mkdtemp(join(tmpdir(), 'klawly-memlist-'));
	});
	teardown(async () => {
		await fs.rm(layer, { recursive: true, force: true });
	});

	test('an empty layer lists nothing', async () => {
		assert.deepStrictEqual(await listKlawlySyncMemory(layer, 'PC'), { projects: [], machines: [] });
	});

	test('projects join notes and transcripts; computers come from their manifests and the current one is marked', async () => {
		const app = join(layer, 'memory', 'github.com__o__app');
		await fs.mkdir(app, { recursive: true });
		await fs.writeFile(join(app, 'tabs.md'), 'Use tabs.');
		await fs.writeFile(join(app, 'skip.txt'), 'x');
		await fs.mkdir(join(layer, 'history', 'transcripts', 'github.com__o__app'), { recursive: true });
		await fs.writeFile(join(layer, 'history', 'transcripts', 'github.com__o__app', 's1.jsonl'), '{}\n');
		await fs.mkdir(join(layer, 'history', 'transcripts', 'alias__notes'), { recursive: true });
		await fs.writeFile(join(layer, 'history', 'transcripts', 'alias__notes', 's2.jsonl'), '{}\n');
		const manifests = join(layer, 'history', 'machines');
		await fs.mkdir(manifests, { recursive: true });
		await fs.writeFile(join(manifests, 'my-pc.json'), JSON.stringify({ machine: 'My PC', transcripts: ['github.com__o__app/s1', 'alias__notes/s2'] }));
		await fs.writeFile(join(manifests, 'laptop.json'), JSON.stringify({ machine: 'laptop', transcripts: ['github.com__o__app/s3'] }));
		await fs.writeFile(join(manifests, 'broken.json'), '{nope');
		assert.strictEqual(await fs.stat(join(layer, 'history', 'prompts')).catch(() => undefined), undefined);
		const overview = await listKlawlySyncMemory(layer, 'My PC');
		assert.deepStrictEqual(
			{
				projects: overview.projects.map(p => ({ slug: p.slug, notes: p.notes.map(n => n.name), transcripts: p.transcripts })),
				machines: overview.machines.map(m => ({ name: m.name, sessions: m.sessions, current: m.current })),
			},
			{
				projects: [{ slug: 'alias__notes', notes: [], transcripts: 1 }, { slug: 'github.com__o__app', notes: ['tabs.md'], transcripts: 1 }],
				machines: [{ name: 'laptop', sessions: 1, current: false }, { name: 'My PC', sessions: 2, current: true }],
			}
		);
	});
});
