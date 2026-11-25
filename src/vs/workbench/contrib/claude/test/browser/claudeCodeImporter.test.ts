/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { TestPathService } from '../../../../test/browser/workbenchTestServices.js';
import { ClaudeCodeImporter } from '../../browser/settings/claudeCodeImporter.js';

/** Import from Claude Code (issue 807): copies from `~/.claude` into the user layer and never touches the source. */
suite('Claude Code importer', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const home = URI.file('/home/me');
	let files: FileService;

	async function write(path: string, text: string): Promise<void> {
		await files.writeFile(URI.file(`/home/me/${path}`), VSBuffer.fromString(text));
	}

	async function read(path: string): Promise<string | undefined> {
		return files.readFile(URI.file(`/home/me/${path}`)).then(file => file.value.toString(), () => undefined);
	}

	function importer(dataFolderName = '.klawly-dev'): ClaudeCodeImporter {
		return new ClaudeCodeImporter(files, new TestPathService(home), { dataFolderName } as IProductService);
	}

	setup(async () => {
		files = store.add(new FileService(new NullLogService()));
		store.add(files.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		await write('.claude/CLAUDE.md', 'be brief');
		await write('.claude/rules/tone.md', 'tone');
		await write('.claude/rules/web/react.md', 'react');
		await write('.claude/rules/notes.txt', 'ignored');
		await write('.claude/agents/reviewer.md', 'reviewer');
		await write('.claude/commands/ship.md', 'ship');
		await write('.claude/skills/pdf/SKILL.md', 'pdf skill');
		await write('.claude/skills/pdf/scripts/run.sh', 'echo');
	});

	test('scan lists what ~/.claude holds and marks what the user layer has', async () => {
		await write('.klawly-dev/claude/rules/tone.md', 'mine');
		const entries = await importer().scan();
		assert.deepStrictEqual(entries.map(entry => `${entry.kind}:${entry.name}:${entry.exists}`), [
			'memory:CLAUDE.md:false',
			'rules:tone:true',
			'rules:web/react:false',
			'subagents:reviewer:false',
			'commands:ship:false',
			'skills:pdf:false',
		]);
	});

	test('copy writes into the dev user layer, keeps the source and never overwrites', async () => {
		await write('.klawly-dev/claude/rules/tone.md', 'mine');
		const entries = await importer().scan();
		const result = await importer().copy(entries);
		assert.deepStrictEqual({
			copied: result.copied.map(entry => entry.name),
			skipped: result.skipped.map(entry => entry.name),
			memory: await read('.klawly-dev/claude/CLAUDE.md'),
			tone: await read('.klawly-dev/claude/rules/tone.md'),
			react: await read('.klawly-dev/claude/rules/web/react.md'),
			agent: await read('.klawly-dev/claude/agents/reviewer.md'),
			skill: await read('.klawly-dev/claude/skills/pdf/SKILL.md'),
			skillScript: await read('.klawly-dev/claude/skills/pdf/scripts/run.sh'),
			notText: await read('.klawly-dev/claude/rules/notes.txt'),
			noKlawlyFolder: await read('.klawly/claude/CLAUDE.md'),
			sourceTone: await read('.claude/rules/tone.md'),
			sourceMemory: await read('.claude/CLAUDE.md'),
			sourceSkill: await read('.claude/skills/pdf/SKILL.md'),
		}, {
			copied: ['CLAUDE.md', 'web/react', 'reviewer', 'ship', 'pdf'],
			skipped: ['tone'],
			memory: 'be brief',
			tone: 'mine',
			react: 'react',
			agent: 'reviewer',
			skill: 'pdf skill',
			skillScript: 'echo',
			notText: undefined,
			noKlawlyFolder: undefined,
			sourceTone: 'tone',
			sourceMemory: 'be brief',
			sourceSkill: 'pdf skill',
		});
	});

	test('a path that climbs out of the user layer is skipped', async () => {
		const result = await importer('.klawly').copy([{ kind: 'rules', path: ['rules', '..', '..', 'escape.md'], name: 'x', exists: false }]);
		assert.deepStrictEqual({ copied: result.copied.length, skipped: result.skipped.length, escaped: await read('escape.md') }, { copied: 0, skipped: 1, escaped: undefined });
	});
});
