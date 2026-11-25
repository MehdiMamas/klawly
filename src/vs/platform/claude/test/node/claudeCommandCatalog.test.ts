/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NormalizedClaudeEvent } from '../../common/claudeProtocol.js';
import { ClaudeAgentRunner, ClaudePermissionBridge } from '../../node/claudeAgentRunner.js';
import { readClaudeCommandCatalog } from '../../node/claudeCommandCatalog.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery, ClaudeQueryAgent, ClaudeQueryCommand } from '../../node/claudeQuery.js';

/**
 * Phase 34: the `/` menu learns where each command comes from, and the runner
 * sends the session its commands and subagents once Claude Code lists them.
 */
suite('Claude command catalog (Phase 34)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const folders: string[] = [];

	teardown(() => {
		for (const folder of folders.splice(0)) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	function folder(): string {
		const path = mkdtempSync(join(tmpdir(), 'klawly-commands-'));
		folders.push(path);
		return path;
	}

	function writeCommand(root: string, ...segments: string[]): void {
		const path = join(root, ...segments);
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, '# command\n');
	}

	test('each command gets its source from Claude Code, its name and the command files on disk', async () => {
		const cwd = folder();
		const config = folder();
		writeCommand(cwd, '.claude', 'commands', 'ship.md');
		writeCommand(cwd, '.claude', 'commands', 'frontend', 'button.md');
		writeCommand(config, 'commands', 'standup.md');
		// A user command that the project overrides is a project command.
		writeCommand(config, 'commands', 'ship.md');
		const commands: ClaudeQueryCommand[] = [
			{ name: 'compact', description: 'Compact', argumentHint: '[instructions]', aliases: [], builtin: true },
			{ name: 'clear', description: 'Clear', aliases: ['reset'], builtin: true },
			{ name: 'explain', description: 'Explain', argumentHint: '' },
			{ name: 'ship', description: 'Ship it', argumentHint: '[branch]' },
			{ name: 'frontend:button', description: 'Button' },
			{ name: 'standup', description: 'Standup' },
			{ name: 'mcp__github__review', description: 'Review a PR' },
			{ name: 'acme:deploy', description: 'Deploy' },
			{ name: 'mystery', description: 'Unknown' },
		];
		const catalog = await readClaudeCommandCatalog(commands, ['explain'], cwd, config);
		assert.deepStrictEqual(catalog, [
			{ name: 'compact', description: 'Compact', argumentHint: '[instructions]', aliases: undefined, source: 'builtin' },
			{ name: 'clear', description: 'Clear', argumentHint: undefined, aliases: ['reset'], source: 'builtin' },
			{ name: 'explain', description: 'Explain', argumentHint: undefined, aliases: undefined, source: 'skill' },
			{ name: 'ship', description: 'Ship it', argumentHint: '[branch]', aliases: undefined, source: 'project' },
			{ name: 'frontend:button', description: 'Button', argumentHint: undefined, aliases: undefined, source: 'project' },
			{ name: 'standup', description: 'Standup', argumentHint: undefined, aliases: undefined, source: 'user' },
			{ name: 'mcp__github__review', description: 'Review a PR', argumentHint: undefined, aliases: undefined, source: 'mcp' },
			{ name: 'acme:deploy', description: 'Deploy', argumentHint: undefined, aliases: undefined, source: 'plugin' },
			{ name: 'mystery', description: 'Unknown', argumentHint: undefined, aliases: undefined, source: 'other' },
		]);
	});

	test('a name that is not a safe file name is never looked up on disk', async () => {
		const looked: string[] = [];
		const catalog = await readClaudeCommandCatalog(
			[{ name: '..:secret', description: '' }, { name: 'a/b', description: '' }, { name: 'ok', description: '' }],
			[], '/work', '/config',
			async path => { looked.push(path); return false; },
		);
		assert.deepStrictEqual({ sources: catalog.map(command => command.source), looked: looked.map(path => path.replace(/\\/g, '/')) }, {
			sources: ['plugin', 'other', 'other'],
			looked: ['/work/.claude/commands/ok.md', '/config/commands/ok.md'],
		});
	});

	async function run(query: (release: Promise<void>) => ClaudeQuery, ready: (events: readonly NormalizedClaudeEvent[]) => boolean = events => events.some(event => event.type === 'session.catalog')): Promise<{ events: NormalizedClaudeEvent[]; cwd: string }> {
		const cwd = folder();
		writeCommand(cwd, '.claude', 'commands', 'ship.md');
		const registry = store.add(new ClaudeProcessRegistry());
		let release: () => void = () => undefined;
		const released = new Promise<void>(resolve => release = resolve);
		const events: NormalizedClaudeEvent[] = [];
		const bridge: ClaudePermissionBridge = { request: async () => ({ behavior: 'deny', message: 'test' }) };
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				await start.prompt[Symbol.asyncIterator]().next();
				return query(released);
			},
		}));
		const done = (async () => {
			for await (const event of runner.start({ sessionId: 's1', prompt: 'hi', cwd, mode: 'agent', workspaceTrusted: true, permissionBridge: bridge })) {
				events.push(event);
			}
		})();
		store.add({ dispose: () => { release(); void done; } });
		for (let attempt = 0; attempt < 400 && !ready(events); attempt++) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		return { events, cwd };
	}

	function listingQuery(released: Promise<void>, commands: readonly ClaudeQueryCommand[], agents?: readonly ClaudeQueryAgent[]): ClaudeQuery {
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: 'system', subtype: 'init', slash_commands: commands.map(command => command.name), skills: ['explain'], session_id: 'sdk-session' };
				await released;
			},
			interrupt: async () => undefined,
			setModel: async () => undefined,
			supportedModels: async () => [],
			supportedCommands: async () => commands,
			supportedAgents: agents ? async () => agents : undefined,
			stopTask: async () => undefined,
			close: () => undefined,
		};
	}

	test('the runner sends the session its catalog after init, with subagents', async () => {
		const { events } = await run(released => listingQuery(released, [
			{ name: 'compact', description: 'Compact', argumentHint: '[instructions]', builtin: true },
			{ name: 'explain', description: 'Explain' },
			{ name: 'ship', description: 'Ship it' },
		], [{ name: 'code-reviewer', description: 'Reviews', model: 'sonnet' }, { name: 'general-purpose', description: 'Anything' }]));
		const types = events.map(event => event.type);
		const catalog = events.find(event => event.type === 'session.catalog');
		assert.deepStrictEqual({
			order: types.indexOf('session.started') < types.indexOf('session.catalog'),
			catalog,
		}, {
			order: true,
			catalog: {
				type: 'session.catalog',
				sessionId: 's1',
				commands: [
					{ name: 'compact', description: 'Compact', argumentHint: '[instructions]', aliases: undefined, source: 'builtin' },
					{ name: 'explain', description: 'Explain', argumentHint: undefined, aliases: undefined, source: 'skill' },
					{ name: 'ship', description: 'Ship it', argumentHint: undefined, aliases: undefined, source: 'project' },
				],
				agents: [{ name: 'code-reviewer', description: 'Reviews', model: 'sonnet' }, { name: 'general-purpose', description: 'Anything' }],
			},
		});
	});

	test('a query that lists no commands and no subagents sends no catalog', async () => {
		const { events } = await run(released => listingQuery(released, []), events => events.some(event => event.type === 'session.started'));
		// The listings settle on later turns of the event loop.
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.deepStrictEqual({
			started: events.some(event => event.type === 'session.started'),
			catalog: events.filter(event => event.type === 'session.catalog').length,
		}, { started: true, catalog: 0 });
	});
});
