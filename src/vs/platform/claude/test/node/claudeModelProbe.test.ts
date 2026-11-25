/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeNodeRuntimeService } from '../../node/claudeNodeRuntimeService.js';
import { probeClaudeModels } from '../../node/claudeModelProbe.js';
import { ClaudeQuery, ClaudeQueryCommand, ClaudeQueryFactory, ClaudeQueryModel, ClaudeQueryStart } from '../../node/claudeQuery.js';
import { claudeCliSettings } from '../../node/claudeCliArgs.js';

const MODELS: readonly ClaudeQueryModel[] = [
	{ id: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5-5[1m]' },
	{ id: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'high'] },
];

suite('Claude model probe', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function runtime(queryFactory: ClaudeQueryFactory, installed = true): ClaudeNodeRuntimeService {
		return store.add(new ClaudeNodeRuntimeService({
			runtimePath: process.execPath,
			homeDirectory: tmpdir(),
			execFile: async (_file, args) => {
				if (!installed) {
					throw Object.assign(new Error('not found'), { code: 'ENOENT' });
				}
				if (args[0] === '--version') {
					return { stdout: '2.1.293 (Claude Code)\n', stderr: '' };
				}
				return { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' };
			},
			queryFactory,
		}));
	}

	test('before any session, the models come from a query that sends no prompt and closes', async () => {
		const seen: string[] = [];
		const service = runtime(async start => {
			seen.push(`open ${start.options.permissionMode} tools=${start.options.allowedTools?.length}`);
			let sent = false;
			void start.prompt[Symbol.asyncIterator]().next().then(next => {
				sent = !next.done;
				seen.push(next.done ? 'prompt ended' : 'prompt sent');
			});
			return listingQuery(async () => {
				seen.push(`listed, prompt sent: ${sent}`);
				return MODELS;
			}, () => seen.push('closed'));
		});

		const first = await service.listModels();
		const second = await service.listModels();
		await Promise.resolve();

		assert.deepStrictEqual({
			seen,
			first: first.map(model => [model.id, model.displayName, model.resolvedModel]),
			second: second.map(model => model.id),
		}, {
			seen: ['open default tools=0', 'listed, prompt sent: false', 'closed', 'prompt ended'],
			first: [['default', 'Default (recommended)', 'claude-opus-5-5[1m]'], ['opus', 'Opus', 'claude-opus-5-5']],
			second: ['default', 'opus'],
		});
	});

	test('a failed probe lists nothing, and the next call asks again', async () => {
		let calls = 0;
		const service = runtime(async () => {
			calls++;
			if (calls === 1) {
				throw new Error('Claude Code is still starting.');
			}
			return listingQuery(async () => MODELS);
		});

		const first = await service.listModels();
		const second = await service.listModels();

		assert.deepStrictEqual({ calls, first: first.length, second: second.map(model => model.id) }, { calls: 2, first: 0, second: ['default', 'opus'] });
	});

	test('before any session, the slash menu gets its commands and skills from a query that runs no turn (issue 968)', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'klawly-skills-'));
		store.add({ dispose: () => rmSync(cwd, { recursive: true, force: true }) });
		mkdirSync(join(cwd, '.claude', 'skills', 'deploy'), { recursive: true });
		writeFileSync(join(cwd, '.claude', 'skills', 'deploy', 'SKILL.md'), '# deploy');
		const commands: ClaudeQueryCommand[] = [
			{ name: 'compact', description: 'Compact', builtin: true },
			{ name: 'deploy', description: 'Deploy it' },
		];
		let calls = 0;
		let sent = false;
		const service = runtime(async start => {
			calls++;
			void start.prompt[Symbol.asyncIterator]().next().then(next => {
				sent = !next.done;
			});
			return { ...listingQuery(async () => []), supportedCommands: async () => commands, supportedAgents: async () => [{ name: 'planner', description: 'Plans' }] };
		});

		const first = await service.listCommands(cwd);
		const second = await service.listCommands(cwd);
		await Promise.resolve();

		assert.deepStrictEqual({ calls, sent, first, second: second.commands.length }, {
			calls: 1,
			sent: false,
			first: {
				commands: [
					{ name: 'compact', description: 'Compact', argumentHint: undefined, aliases: undefined, source: 'builtin' },
					{ name: 'deploy', description: 'Deploy it', argumentHint: undefined, aliases: undefined, source: 'skill' },
				],
				agents: [{ name: 'planner', description: 'Plans' }],
			},
			second: 2,
		});
	});

	test('a command probe that fails lists nothing and the next call asks again; without Claude Code no probe runs', async () => {
		let calls = 0;
		const service = runtime(async () => {
			calls++;
			if (calls === 1) {
				throw new Error('Claude Code is still starting.');
			}
			return { ...listingQuery(async () => []), supportedCommands: async () => [{ name: 'compact', description: 'Compact', builtin: true }] };
		});
		const first = await service.listCommands(tmpdir());
		const second = await service.listCommands(tmpdir());
		let missingCalls = 0;
		const missing = await runtime(async () => {
			missingCalls++;
			return listingQuery(async () => []);
		}, false).listCommands(tmpdir());

		assert.deepStrictEqual({ calls, first: first.commands.length, second: second.commands.map(command => command.name), missing, missingCalls }, {
			calls: 2,
			first: 0,
			second: ['compact'],
			missing: { commands: [], agents: [] },
			missingCalls: 0,
		});
	});

	test('without Claude Code installed, no probe runs', async () => {
		let calls = 0;
		const service = runtime(async () => {
			calls++;
			return listingQuery(async () => MODELS);
		}, false);

		const models = await service.listModels();

		assert.deepStrictEqual({ calls, models }, { calls: 0, models: [] });
	});

	test('older models are the asked-for ids Claude Code names and the lineup does not already run; they follow the lineup', async () => {
		let asked: readonly string[] = [];
		let calls = 0;
		const service = runtime(async start => {
			calls++;
			asked = start.options.modelPicker ?? [];
			return listingQuery(async () => [
				...MODELS,
				{ id: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
				{ id: 'claude-opus-4-6', displayName: 'Opus 4.6', resolvedModel: 'claude-opus-4-6', supportedEffortLevels: ['low', 'high'] },
				{ id: 'claude-opus-4-9', displayName: 'claude-opus-4-9', resolvedModel: 'claude-opus-4-9' },
				{ id: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5', resolvedModel: 'claude-sonnet-4-5' },
				{ id: 'claude-haiku-4-5', displayName: 'Haiku 4.5', resolvedModel: 'claude-haiku-4-5' },
			]);
		});

		const first = await service.listModels();
		await service.listModels();

		assert.deepStrictEqual({
			calls,
			asked: [asked.length, asked.includes('claude-opus-4-6'), asked.includes('claude-sonnet-5'), asked.includes('opus')],
			models: first.map(model => [model.id, !!model.older]),
		}, {
			calls: 1,
			asked: [80, true, true, false],
			models: [['default', false], ['opus', false], ['haiku', false], ['claude-opus-4-6', true], ['claude-sonnet-4-5', true]],
		});
	});

	test('the asked-for ids reach Claude Code as model picker rows, beside the flag settings', () => {
		const options = (modelPicker?: readonly string[]): ClaudeQueryStart['options'] => ({
			cwd: tmpdir(),
			permissionMode: 'default',
			env: {},
			abortController: new AbortController(),
			flagSettings: { fastMode: true },
			modelPicker,
			canUseTool: async () => ({ behavior: 'deny', message: '' }),
			screenTool: async () => undefined,
		});
		assert.deepStrictEqual([claudeCliSettings(options()), claudeCliSettings(options(['claude-opus-4-6']))], [
			{ fastMode: true },
			{ fastMode: true, modelPicker: { options: [{ model: 'claude-opus-4-6' }] } },
		]);
	});

	test('a probe that never answers gives up and closes', async () => {
		let closed = false;
		await assert.rejects(probeClaudeModels({
			queryFactory: async () => listingQuery(() => new Promise(() => { /* never answers */ }), () => closed = true),
			cwd: tmpdir(),
			env: {},
			timeoutMs: 5,
		}), /did not list its models in time/);
		assert.strictEqual(closed, true);
	});
});

function listingQuery(supportedModels: () => Promise<readonly ClaudeQueryModel[]>, onClose?: () => void): ClaudeQuery {
	return {
		async *[Symbol.asyncIterator]() { /* the probe never reads messages */ },
		interrupt: async () => { },
		setModel: async () => { },
		supportedModels,
		supportedCommands: async () => [],
		stopTask: async () => { },
		close: () => onClose?.(),
	};
}
