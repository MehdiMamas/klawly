/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NormalizedClaudeEvent } from '../../common/claudeProtocol.js';
import { ClaudeFlagSettingsPatch, ClaudeSessionSettings } from '../../common/claudeSessionSettings.js';
import { ClaudeAgentRunner, ClaudePermissionBridge } from '../../node/claudeAgentRunner.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery, ClaudeQueryStart } from '../../node/claudeQuery.js';
import { ClaudeGitSettings, DEFAULT_CLAUDE_GIT_SETTINGS } from '../../common/claudeGitSettings.js';

/**
 * Phase 33: effort, fast mode, Ultracode and thinking reach `query()` when a
 * session opens and `applyFlagSettings` while it runs, without a restart and
 * without ever leaving Claude Code's default permission mode.
 */
suite('Claude session settings in the runner (Phase 33)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const folders: string[] = [];

	teardown(() => {
		for (const folder of folders.splice(0)) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	interface Opened {
		readonly runner: ClaudeAgentRunner;
		readonly registry: ClaudeProcessRegistry;
		readonly options: ClaudeQueryStart['options'];
		readonly patches: ClaudeFlagSettingsPatch[];
		readonly events: NormalizedClaudeEvent[];
		readonly opens: () => number;
	}

	async function open(sessionId: string, sessionSettings: ClaudeSessionSettings | undefined, live = true, gitSettings?: ClaudeGitSettings): Promise<Opened> {
		const cwd = mkdtempSync(join(tmpdir(), 'klawly-settings-'));
		folders.push(cwd);
		const registry = store.add(new ClaudeProcessRegistry());
		const releases: Array<() => void> = [];
		const patches: ClaudeFlagSettingsPatch[] = [];
		const events: NormalizedClaudeEvent[] = [];
		let options: ClaudeQueryStart['options'] | undefined;
		let opens = 0;
		const bridge: ClaudePermissionBridge = { request: async () => ({ behavior: 'deny', message: 'test' }) };
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				opens++;
				options = start.options;
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(releases, live ? patches : undefined);
			},
		}));
		const done = (async () => {
			for await (const event of runner.start({ sessionId, prompt: 'hi', cwd, mode: 'agent', workspaceTrusted: true, permissionBridge: bridge, sessionSettings, gitSettings })) {
				events.push(event);
			}
		})();
		store.add({ dispose: () => { releases.forEach(release => release()); void done; } });
		for (let attempt = 0; attempt < 500 && !(options && registry.get(sessionId)); attempt++) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		assert.ok(options && registry.get(sessionId), 'the query did not open');
		return { runner, registry, options, patches, events, opens: () => opens };
	}

	test('a session opens with its effort and flag settings, still in default permission mode', async () => {
		const plain = await open('s-plain', undefined);
		const tuned = await open('s-tuned', { effort: 'max', fastMode: true, thinking: false });
		const ultra = await open('s-ultra', { effort: 'low', ultracode: true });
		assert.deepStrictEqual([plain.options, tuned.options, ultra.options].map(options => [options.effort, options.flagSettings, options.permissionMode]), [
			[undefined, undefined, 'default'],
			['max', { fastMode: true, alwaysThinkingEnabled: false }, 'default'],
			[undefined, { ultracode: true }, 'default'],
		]);
	});

	test('git settings join the flag settings a session opens with; defaults add nothing', async () => {
		const defaults = await open('s-git-default', undefined, true, DEFAULT_CLAUDE_GIT_SETTINGS);
		const quiet = await open('s-git-quiet', { fastMode: true }, true, { commitAttribution: false, prAttribution: false, workflowInstructions: false, worktreeBase: 'head' });
		assert.deepStrictEqual([defaults.options.flagSettings, quiet.options.flagSettings, quiet.options.permissionMode], [
			undefined,
			{ fastMode: true, attribution: { commit: '', pr: '' }, includeGitInstructions: false, worktree: { baseRef: 'head' } },
			'default',
		]);
	});

	test('a live session changes through applyFlagSettings, without a restart; Ultracode off restores the effort', async () => {
		const sessionId = 's-live';
		const { runner, patches, events, opens } = await open(sessionId, { effort: 'high' });
		await runner.setSessionSettings(sessionId, { effort: 'high', ultracode: true, fastMode: true });
		await runner.setSessionSettings(sessionId, { effort: 'high', ultracode: true, fastMode: true });
		await runner.setSessionSettings(sessionId, { effort: 'medium' });
		await runner.setSessionSettings(sessionId, {});
		const changes = events.filter(event => event.type === 'session.settingsChanged').map(event => event.type === 'session.settingsChanged' ? event.settings : undefined);
		assert.deepStrictEqual({ patches, changes, opens: opens() }, {
			patches: [
				{ ultracode: true, fastMode: true },
				{ ultracode: null, effortLevel: 'medium', fastMode: null },
				{ effortLevel: null },
			],
			changes: [
				{ effort: 'high', ultracode: true, fastMode: true },
				{ effort: 'high', ultracode: true, fastMode: true },
				{ effort: 'medium' },
				{},
			],
			opens: 1,
		});
	});

	test('a query that cannot change settings refuses, and the session keeps what it runs with', async () => {
		const sessionId = 's-old';
		const { runner, events } = await open(sessionId, { effort: 'low' }, false);
		await assert.rejects(() => runner.setSessionSettings(sessionId, { effort: 'high' }), /cannot change its settings/);
		assert.deepStrictEqual(events.filter(event => event.type === 'session.settingsChanged'), []);
	});
});

function idleQuery(releases: Array<() => void>, patches: ClaudeFlagSettingsPatch[] | undefined): ClaudeQuery {
	let release: (() => void) | undefined;
	const done = new Promise<void>(resolve => {
		release = resolve;
		releases.push(resolve);
	});
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: 'system', subtype: 'init', slash_commands: [], skills: [], session_id: 'sdk-session' };
			await done;
		},
		interrupt: async () => release?.(),
		setModel: async () => undefined,
		applyFlagSettings: patches ? async patch => { patches.push(patch); } : undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => release?.(),
	};
}
