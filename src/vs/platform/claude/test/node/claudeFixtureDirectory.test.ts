/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { fileUriFromPath } from '../../common/claudeCheckpoints.js';
import { ClaudeCheckpointStore } from '../../common/claudeCheckpointStore.js';
import { NodeCheckpointStorage } from '../../node/claudeCheckpointNodeStorage.js';
import { CLAUDE_FAKE_FIXTURE_DIR_ENV, claudeFakeFixtures } from '../../node/claudeFixtureDirectory.js';

suite('Claude fake fixture folder', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const base = new Map([['plain-answer', 'built-in'], ['test-session', 'test']]);
	let dir: string;
	let userData: string;

	setup(() => {
		dir = mkdtempSync(join(tmpdir(), 'klawly-fixtures-'));
		userData = join(dir, 'user-data');
		mkdirSync(userData);
		writeFileSync(join(dir, 'finished.jsonl'), 'from disk');
	});

	teardown(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('a dev build with the folder set replays the script named in next.txt for a plain send', () => {
		const { fixtures, stepDelayMs } = claudeFakeFixtures(base, false, userData, { [CLAUDE_FAKE_FIXTURE_DIR_ENV]: dir });
		const read = () => [fixtures.get('plain-answer'), fixtures.get('test-session'), fixtures.has('plain-answer')];
		const missing = read();
		writeFileSync(join(dir, 'next.txt'), 'finished\n');
		const picked = read();
		writeFileSync(join(dir, 'next.txt'), 'nope');
		assert.deepStrictEqual({ missing, picked, unknown: read(), stepDelayMs }, {
			missing: ['built-in', 'test', true],
			picked: ['from disk', 'test', true],
			unknown: ['built-in', 'test', true],
			stepDelayMs: 120,
		});
	});

	test('a built app or an unset folder keeps the built-in scripts', () => {
		writeFileSync(join(dir, 'next.txt'), 'finished');
		const built = claudeFakeFixtures(base, true, userData, { [CLAUDE_FAKE_FIXTURE_DIR_ENV]: dir });
		const unset = claudeFakeFixtures(base, false, userData, {});
		assert.deepStrictEqual([built, unset].map(f => [f.fixtures === base, f.stepDelayMs, f.models, f.fileWrites]), [[true, undefined, undefined, undefined], [true, undefined, undefined, undefined]]);
	});

	test('models.json replaces the fake models; a missing, broken or empty list keeps them', () => {
		const models = () => claudeFakeFixtures(base, false, userData, { [CLAUDE_FAKE_FIXTURE_DIR_ENV]: dir }).models?.map(model => model.id);
		const missing = models();
		writeFileSync(join(dir, 'models.json'), '{ not json');
		const broken = models();
		writeFileSync(join(dir, 'models.json'), JSON.stringify([{ id: 'nameless' }]));
		const empty = models();
		writeFileSync(join(dir, 'models.json'), JSON.stringify([{ id: 'default', displayName: 'Default', source: 'runtime', resolvedModel: 'claude-opus-5-5' }, { id: 'opus', displayName: 'Opus 5.5', source: 'alias' }]));
		assert.deepStrictEqual({ missing, broken, empty, listed: models() }, { missing: undefined, broken: undefined, empty: undefined, listed: ['default', 'opus'] });
	});

	test('a Tab completion answers with completion.txt, read at request time; a missing or empty file answers nothing', () => {
		const { inlineCompletion } = claudeFakeFixtures(base, false, userData, { [CLAUDE_FAKE_FIXTURE_DIR_ENV]: dir });
		const request = { id: 'c1', prompt: 'complete', cwd: dir };
		const missing = inlineCompletion?.(request);
		writeFileSync(join(dir, 'completion.txt'), '');
		const empty = inlineCompletion?.(request);
		writeFileSync(join(dir, 'completion.txt'), 'this.items.delete(sku);\n');
		assert.deepStrictEqual({ missing, empty, written: inlineCompletion?.(request) }, { missing: undefined, empty: undefined, written: 'this.items.delete(sku);' });
	});

	test('runtime.json overrides installed and authenticated at every state request; other fields and bad files are ignored (issue 797)', () => {
		const { runtimeState } = claudeFakeFixtures(base, false, userData, { [CLAUDE_FAKE_FIXTURE_DIR_ENV]: dir });
		const missing = runtimeState?.();
		writeFileSync(join(dir, 'runtime.json'), '{ not json');
		const broken = runtimeState?.();
		writeFileSync(join(dir, 'runtime.json'), JSON.stringify({ installed: 'no', version: '9.9.9' }));
		const unknown = runtimeState?.();
		writeFileSync(join(dir, 'runtime.json'), JSON.stringify({ installed: false, authenticated: false, version: '9.9.9' }));
		assert.deepStrictEqual({ missing, broken, unknown, written: runtimeState?.() }, { missing: undefined, broken: undefined, unknown: undefined, written: { installed: false, authenticated: false } });
	});

	test('a scripted write snapshots the file into the turn checkpoint, then writes it to disk', async () => {
		const { fileWrites } = claudeFakeFixtures(base, false, userData, { [CLAUDE_FAKE_FIXTURE_DIR_ENV]: dir });
		const edited = join(dir, 'ws', 'a.ts');
		const created = join(dir, 'ws', 'new', 'b.ts');
		mkdirSync(join(dir, 'ws'));
		writeFileSync(edited, 'before');
		const turn = { checkpointSessionId: 'pane-1', turnId: 'turn-1', cwd: join(dir, 'ws') };
		for (const [path, after] of [[edited, 'after'], [created, 'new file']] as const) {
			await fileWrites!.beforeWrite(turn, fileUriFromPath(path));
			await fileWrites!.afterWrite(turn, fileUriFromPath(path), after);
		}
		const checkpoint = await new ClaudeCheckpointStore(userData, new NodeCheckpointStorage()).readCheckpoint('pane-1', 'turn-1');
		assert.deepStrictEqual({
			files: checkpoint?.files.map(file => [file.uri, file.existed, file.capturedAs, typeof file.afterHash]),
			disk: [readFileSync(edited, 'utf8'), existsSync(created) && readFileSync(created, 'utf8')],
		}, {
			files: [[fileUriFromPath(edited), true, 'write', 'string'], [fileUriFromPath(created), false, 'write', 'string']],
			disk: ['after', 'new file'],
		});
	});
});
