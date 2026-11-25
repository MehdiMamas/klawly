/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeSettingSourcesFor } from '../../node/claudeAgentRunner.js';
import { ClaudeUserLayerRequest, resolveClaudeUserLayer } from '../../node/claudeUserLayer.js';

/** Every file under a folder with its bytes, so a test can show the folder did not change. */
async function snapshot(folder: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const entry of await fs.readdir(folder, { recursive: true, withFileTypes: true })) {
		if (entry.isFile()) {
			const file = join(entry.parentPath, entry.name);
			result[file.slice(folder.length + 1).replace(/\\/g, '/')] = (await fs.readFile(file)).toString('base64');
		}
	}
	return result;
}

/** What a query takes from `~/.klawly/claude` (issue 455). */
suite('resolveClaudeUserLayer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	let home: string;
	let layer: string;
	let project: string;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'klawly-user-layer-'));
		home = join(root, 'home');
		layer = join(home, '.klawly', 'claude');
		project = join(root, 'project');
		await fs.mkdir(join(layer, 'rules'), { recursive: true });
		await fs.mkdir(join(project, '.claude'), { recursive: true });
		await fs.mkdir(join(home, '.claude', 'skills', 'theirs'), { recursive: true });
		await fs.writeFile(join(home, '.claude', 'CLAUDE.md'), 'Claude Code rules\n');
		await fs.writeFile(join(home, '.claude', 'settings.json'), '{ "model": "haiku" }\n');
		await fs.writeFile(join(home, '.claude', 'skills', 'theirs', 'SKILL.md'), '---\nname: theirs\n---\n');
		await fs.writeFile(join(home, '.claude.json'), '{ "mcpServers": {} }\n');
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	function request(extra: Partial<ClaudeUserLayerRequest> = {}): ClaudeUserLayerRequest {
		return { directory: layer, pluginDirectory: join(root, 'data', 'user-plugin'), cwd: project, trusted: true, remote: false, homeDirectory: home, ...extra };
	}

	test('an empty layer adds nothing', async () => {
		await fs.rm(layer, { recursive: true });
		assert.deepStrictEqual(await resolveClaudeUserLayer(request()), { systemPrompt: undefined, settings: undefined, plugin: undefined, mcpServers: undefined });
	});

	test('rules, imports and rules/*.md go into the prompt in order, each once', async () => {
		await fs.writeFile(join(layer, 'CLAUDE.md'), 'Use tabs.\n@notes/style.md\n@~/shared.md\n');
		await fs.mkdir(join(layer, 'notes'));
		await fs.writeFile(join(layer, 'notes', 'style.md'), 'Short names.\n@../CLAUDE.md\n');
		await fs.writeFile(join(home, 'shared.md'), 'Shared.\n');
		await fs.writeFile(join(layer, 'rules', 'b.md'), 'Rule B.\n');
		await fs.writeFile(join(layer, 'rules', 'a.md'), 'Rule A.\n');
		await fs.writeFile(join(layer, 'rules', 'skip.txt'), 'Not a rule.\n');
		const prompt = (await resolveClaudeUserLayer(request())).systemPrompt ?? '';
		const order = ['Use tabs.', 'Short names.', 'Shared.', 'Rule A.', 'Rule B.'].map(text => prompt.indexOf(text));
		assert.deepStrictEqual({
			ordered: order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])),
			once: prompt.split('Use tabs.').length - 1,
			skipped: prompt.includes('Not a rule.'),
			claudeCode: prompt.includes('Claude Code rules'),
		}, { ordered: true, once: 1, skipped: false, claudeCode: false });
	});

	test('settings rank below the project only in a trusted workspace; servers start only there, and never on a remote target', async () => {
		await fs.writeFile(join(layer, 'settings.json'), '{ "model": "opus", "env": { "A": "1" } }\n');
		await fs.writeFile(join(layer, '.mcp.json'), '{ "mcpServers": { "docs": { "type": "http", "url": "https://docs.example/mcp" } } }\n');
		await fs.writeFile(join(project, '.claude', 'settings.json'), '{ "model": "sonnet" }\n');
		const trusted = await resolveClaudeUserLayer(request());
		const untrusted = await resolveClaudeUserLayer(request({ trusted: false }));
		const remote = await resolveClaudeUserLayer(request({ remote: true }));
		assert.deepStrictEqual({
			trusted: [trusted.settings, trusted.mcpServers],
			untrusted: [untrusted.settings, untrusted.mcpServers],
			remote: [remote.settings, remote.mcpServers, remote.plugin],
		}, {
			trusted: [{ env: { A: '1' } }, { docs: { type: 'http', url: 'https://docs.example/mcp' } }],
			untrusted: [{ model: 'opus', env: { A: '1' } }, undefined],
			remote: [{ env: { A: '1' } }, undefined, undefined],
		});
	});

	test('skills, agents, commands and output styles load in place through links, which follow the layer', async () => {
		await fs.mkdir(join(layer, 'skills', 'mine'), { recursive: true });
		await fs.writeFile(join(layer, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\n');
		await fs.mkdir(join(layer, 'agents'));
		const plugin = (await resolveClaudeUserLayer(request())).plugin!;
		const loaded = {
			manifest: JSON.parse(await fs.readFile(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).name,
			skill: await fs.readFile(join(plugin, 'skills', 'mine', 'SKILL.md'), 'utf8'),
			folders: (await fs.readdir(plugin)).sort(),
		};
		await fs.rm(join(layer, 'agents'), { recursive: true });
		await fs.rm(join(layer, 'skills'), { recursive: true });
		const after = await resolveClaudeUserLayer(request());
		assert.deepStrictEqual({ loaded, after: after.plugin, folders: (await fs.readdir(plugin)).sort() }, {
			loaded: { manifest: 'user', skill: '---\nname: mine\n---\n', folders: ['.claude-plugin', 'agents', 'skills'] },
			after: undefined,
			folders: ['.claude-plugin'],
		});
	});

	test('a session reads ~/.claude only while it is used, and nothing here writes ~/.claude or ~/.claude.json', async () => {
		const before = { folder: await snapshot(join(home, '.claude')), json: await fs.readFile(join(home, '.claude.json'), 'utf8') };
		await fs.writeFile(join(layer, 'CLAUDE.md'), 'Mine.\n');
		await fs.writeFile(join(layer, 'settings.json'), '{ "model": "opus" }\n');
		await fs.mkdir(join(layer, 'skills', 'mine'), { recursive: true });
		await fs.writeFile(join(layer, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\n');
		for (const trusted of [true, false]) {
			for (const remote of [false, true]) {
				await resolveClaudeUserLayer(request({ trusted, remote }));
			}
		}
		assert.deepStrictEqual({
			sources: [claudeSettingSourcesFor(true), claudeSettingSourcesFor(true, false), claudeSettingSourcesFor(false, false)],
			folder: await snapshot(join(home, '.claude')),
			json: await fs.readFile(join(home, '.claude.json'), 'utf8'),
		}, {
			sources: [['user', 'project', 'local'], ['project', 'local'], []],
			...before,
		});
	});
});
