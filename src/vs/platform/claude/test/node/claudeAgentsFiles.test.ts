/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeAgentsFilesSettings } from '../../common/claudeAgentsFiles.js';
import { NormalizedClaudeEvent } from '../../common/claudeProtocol.js';
import { AGENTS_MD_MAX_CHARS, claudeMdImports, resolveClaudeAgentsFiles, withClaudeInstructionSources } from '../../node/claudeAgentsFiles.js';

const ON: ClaudeAgentsFilesSettings = { instructions: true, skills: true };

suite('Claude AGENTS.md and .agents/skills (issue 499)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'klawly-agents-files-'));
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	/** Writes the files under a new workspace folder and returns it. */
	function tree(name: string, files: Record<string, string>): string {
		const cwd = join(root, name);
		mkdirSync(cwd, { recursive: true });
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(dirname(join(cwd, path)), { recursive: true });
			writeFileSync(join(cwd, path), text);
		}
		return cwd;
	}

	function resolveIn(cwd: string, settings = ON) {
		return resolveClaudeAgentsFiles({ cwd, settings, pluginRoot: join(root, 'plugins'), homeDirectory: join(root, 'home') });
	}

	test('a workspace with only AGENTS.md and .agents/skills sends both', async () => {
		const cwd = tree('repo', {
			'AGENTS.md': '# Repo\n\nUse tabs.\n',
			'pkg/AGENTS.md': 'Package rules',
			'pkg/deep/AGENTS.md': 'Deeper rules',
			'node_modules/dep/AGENTS.md': 'Not ours',
			'.hidden/AGENTS.md': 'Not ours either',
			'.agents/skills/foo/SKILL.md': '---\nname: foo\ndescription: Does foo\n---\nFoo.',
		});
		const result = await resolveIn(cwd);
		assert.deepStrictEqual({
			sources: result.sources,
			systemPrompt: result.systemPrompt,
			manifest: result.plugin && JSON.parse(readFileSync(join(result.plugin, '.claude-plugin', 'plugin.json'), 'utf8')).name,
			skill: result.plugin && readFileSync(join(result.plugin, 'skills', 'foo', 'SKILL.md'), 'utf8'),
		}, {
			sources: [
				{ kind: 'agentsMd', path: 'AGENTS.md' },
				{ kind: 'agentsMd', path: 'pkg/AGENTS.md', nested: true },
				{ kind: 'agentsMd', path: 'pkg/deep/AGENTS.md', nested: true },
				{ kind: 'agentsSkills', path: '.agents/skills' },
			],
			systemPrompt: [
				`Contents of ${join(cwd, 'AGENTS.md')} (project instructions from AGENTS.md, followed like CLAUDE.md):`,
				'',
				'# Repo',
				'',
				'Use tabs.',
				'',
				'These folders have their own AGENTS.md with instructions for the files under them. Before you work on files in one of these folders, read the AGENTS.md closest to those files: it adds to the ones above it and wins where they disagree.',
				'- pkg/AGENTS.md',
				'- pkg/deep/AGENTS.md',
			].join('\n'),
			manifest: 'agents',
			skill: '---\nname: foo\ndescription: Does foo\n---\nFoo.',
		});
	});

	test('an AGENTS.md a loaded CLAUDE.md imports is not sent twice', async () => {
		const cases: Record<string, Record<string, string>> = {
			claudeMd: { 'CLAUDE.md': '@AGENTS.md\n' },
			dotClaude: { '.claude/CLAUDE.md': 'Read @../AGENTS.md first.' },
			local: { 'CLAUDE.local.md': '@./AGENTS.md' },
			rule: { '.claude/rules/agents.md': '@../../AGENTS.md' },
			chained: { 'CLAUDE.md': 'See @docs/guide.md', 'docs/guide.md': '@../AGENTS.md' },
			codeSpan: { 'CLAUDE.md': 'Write `@AGENTS.md` to import it.' },
			fenced: { 'CLAUDE.md': '```\n@AGENTS.md\n```\n' },
			nestedImported: { 'CLAUDE.md': '@AGENTS.md', 'pkg/CLAUDE.md': '@AGENTS.md', 'lib/AGENTS.md': 'Library rules' },
		};
		const sent: Record<string, string[]> = {};
		for (const [name, files] of Object.entries(cases)) {
			const cwd = tree(name, { 'AGENTS.md': 'Root rules', 'pkg/AGENTS.md': 'Package rules', ...files });
			sent[name] = (await resolveIn(cwd)).sources.map(source => source.path);
		}
		assert.deepStrictEqual(sent, {
			claudeMd: ['pkg/AGENTS.md'],
			dotClaude: ['pkg/AGENTS.md'],
			local: ['pkg/AGENTS.md'],
			rule: ['pkg/AGENTS.md'],
			chained: ['pkg/AGENTS.md'],
			codeSpan: ['AGENTS.md', 'pkg/AGENTS.md'],
			fenced: ['AGENTS.md', 'pkg/AGENTS.md'],
			nestedImported: ['lib/AGENTS.md'],
		});
	});

	test('the settings turn each part off, and a long AGENTS.md is cut', async () => {
		const cwd = tree('repo', { 'AGENTS.md': 'x'.repeat(AGENTS_MD_MAX_CHARS + 10), '.agents/skills/foo/SKILL.md': 'Foo.' });
		const off = await resolveIn(cwd, { instructions: false, skills: false });
		const instructionsOnly = await resolveIn(cwd, { instructions: true, skills: false });
		const skillsOnly = await resolveIn(cwd, { instructions: false, skills: true });
		assert.deepStrictEqual({
			off,
			instructionsOnly: { sources: instructionsOnly.sources, plugin: instructionsOnly.plugin, cut: instructionsOnly.systemPrompt?.endsWith(`${'x'.repeat(10)}\n\n[AGENTS.md is cut here. Read ${join(cwd, 'AGENTS.md')} for the rest.]`) && !instructionsOnly.systemPrompt.includes('x'.repeat(AGENTS_MD_MAX_CHARS + 1)) },
			skillsOnly: { sources: skillsOnly.sources, systemPrompt: skillsOnly.systemPrompt, plugin: !!skillsOnly.plugin },
		}, {
			off: { systemPrompt: undefined, plugin: undefined, sources: [] },
			instructionsOnly: { sources: [{ kind: 'agentsMd', path: 'AGENTS.md' }], plugin: undefined, cut: true },
			skillsOnly: { sources: [{ kind: 'agentsSkills', path: '.agents/skills' }], systemPrompt: undefined, plugin: true },
		});
	});

	test('a workspace without the files, or with an empty skills folder, sends nothing', async () => {
		const cwd = tree('repo', { 'README.md': 'Hi', '.agents/skills/empty/notes.txt': 'No SKILL.md here' });
		assert.deepStrictEqual(await resolveIn(cwd), { systemPrompt: undefined, plugin: undefined, sources: [] });
	});

	test('CLAUDE.md imports are read like Claude Code reads them', () => {
		assert.deepStrictEqual(claudeMdImports([
			'@AGENTS.md',
			'See @docs/guide.md and @~/rules.md.',
			'Mail me@example.com, or write `@not-an-import.md`.',
			'```',
			'@fenced.md',
			'```',
			'~~~md',
			'@also-fenced.md',
			'~~~',
			'\t@/abs/path.md',
		].join('\r\n')), ['AGENTS.md', 'docs/guide.md', '~/rules.md.', '/abs/path.md']);
	});

	test('the main conversation\'s session.started carries the sources', () => {
		const sources = [{ kind: 'agentsMd' as const, path: 'AGENTS.md' }];
		const started: NormalizedClaudeEvent = { type: 'session.started', sessionId: 's1', model: 'opus' };
		assert.deepStrictEqual([
			withClaudeInstructionSources(started, sources),
			withClaudeInstructionSources(started, []),
			withClaudeInstructionSources({ ...started, parentRunId: 'r1' }, sources),
		], [
			{ type: 'session.started', sessionId: 's1', model: 'opus', instructions: sources },
			{ type: 'session.started', sessionId: 's1', model: 'opus' },
			{ type: 'session.started', sessionId: 's1', model: 'opus', parentRunId: 'r1' },
		]);
	});
});
