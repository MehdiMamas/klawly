/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_DELEGATE_PLUGIN, CLAUDE_DELEGATE_TOOL_ID, CLAUDE_MESSAGE_HELPER_TOOL_ID, claudeDelegateToolText } from '../../common/claudeDelegate.js';
import { NON_MUTATING_TOOLS } from '../../common/claudeModePolicy.js';
import { ClaudeAgentRunner, ClaudePermissionBridge } from '../../node/claudeAgentRunner.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery, ClaudeQueryStart } from '../../node/claudeQuery.js';
import { runClaudeDelegateTool, runClaudeMessageHelperTool } from '../../node/claudeTerminalTool.js';

/**
 * Delegation (issue 693): the `klawly-delegate` plugin ships with Klawly and is
 * registered for every session, and the delegate tool answers with what the
 * delegated chat said.
 */
suite('Claude delegation mod', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const folders: string[] = [];

	teardown(() => {
		for (const folder of folders.splice(0)) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	function temp(prefix: string): string {
		const folder = mkdtempSync(join(tmpdir(), prefix));
		folders.push(folder);
		return folder;
	}

	async function open(sessionId: string, workspaceTrusted: boolean, home: string, delegate: boolean): Promise<ClaudeQueryStart['options']> {
		const cwd = temp('klawly-delegate-cwd-');
		const registry = store.add(new ClaudeProcessRegistry());
		const opened: ClaudeQueryStart['options'][] = [];
		const releases: Array<() => void> = [];
		const bridge: ClaudePermissionBridge = { request: async () => ({ behavior: 'deny', message: 'test' }) };
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			homeDirectory: home,
			dataFolderName: '.klawly-test',
			productVersion: '1.141.0-alpha.10',
			delegateRequest: delegate ? async () => ({ kind: 'stopped' }) : undefined,
			queryFactory: async start => {
				opened.push(start.options);
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(releases);
			},
		}));
		const done = (async () => {
			for await (const _event of runner.start({ sessionId, prompt: 'hi', cwd, mode: 'agent', workspaceTrusted, permissionBridge: bridge })) {
				// drain
			}
		})();
		store.add({ dispose: () => { releases.forEach(release => release()); void done; } });
		await waitFor(() => opened.length === 1);
		return opened[0];
	}

	test('every session loads the bundled plugin, trusted or not, versioned with Klawly', async () => {
		const home = temp('klawly-delegate-home-');
		const trusted = await open('session-1', true, home, true);
		const untrusted = await open('session-2', false, home, false);
		const folder = join(home, '.klawly-test', 'bundled-plugins', CLAUDE_DELEGATE_PLUGIN, '1.141.0-alpha.10');
		const manifest = JSON.parse(readFileSync(join(folder, '.claude-plugin', 'plugin.json'), 'utf8'));
		const skill = readFileSync(join(folder, 'skills', 'delegate', 'SKILL.md'), 'utf8');
		assert.deepStrictEqual({
			trusted: trusted.plugins,
			untrusted: untrusted.plugins,
			manifest: [manifest.name, manifest.version],
			skillNamesTool: skill.includes(CLAUDE_DELEGATE_TOOL_ID),
			delegateTool: [!!trusted.delegateTool, !!untrusted.delegateTool],
		}, {
			trusted: [folder],
			untrusted: [folder],
			manifest: [CLAUDE_DELEGATE_PLUGIN, '1.141.0-alpha.10'],
			skillNamesTool: true,
			delegateTool: [true, false],
		});
	});

	test('the tool answers with the delegated chat\'s result, a stop or a failure', async () => {
		const answers = [
			await runClaudeDelegateTool({ delegate: async () => ({ kind: 'done', text: 'Renamed 3 helpers.', model: 'Haiku 4.5', costUsd: 0.01 }) }, { task: ' Rename the helpers ' }, {}),
			await runClaudeDelegateTool({ delegate: async () => ({ kind: 'stopped' }) }, { task: 'x' }, {}),
			await runClaudeDelegateTool({ delegate: async () => { throw new Error('no window'); } }, { task: 'x' }, {}),
			await runClaudeDelegateTool({ delegate: async () => ({ kind: 'stopped' }) }, { task: '  ' }, {}),
		];
		assert.deepStrictEqual(answers.map(answer => [answer.isError, answer.content[0].text]), [
			[false, claudeDelegateToolText({ kind: 'done', text: 'Renamed 3 helpers.', model: 'Haiku 4.5' }).text],
			[true, claudeDelegateToolText({ kind: 'stopped' }).text],
			[true, 'Klawly could not run the delegated chat: no window'],
			[true, 'Give the task to delegate.'],
		]);
		assert.ok(NON_MUTATING_TOOLS.has(CLAUDE_DELEGATE_TOOL_ID));
	});

	test('the message-helper tool sends the message to the window and tells Claude it is with the helper (issue 1380)', async () => {
		const sent: unknown[] = [];
		const host = { delegate: async (args: unknown) => { sent.push(args); return { kind: 'messaged' as const, helper: 'Rename the helpers' }; } };
		const results = [
			await runClaudeMessageHelperTool(host, { helper: ' Rename the helpers ', text: ' Also rename the tests. ' }, {}),
			await runClaudeMessageHelperTool(host, { helper: 'x', text: '  ' }, {}),
			await runClaudeMessageHelperTool({ delegate: async () => ({ kind: 'failed', message: 'No helper of this chat matches "x".' }) }, { helper: 'x', text: 'hi' }, {}),
		].map(r => [r.isError ?? false, r.content[0].text]);
		assert.deepStrictEqual({ results, sent, allowed: NON_MUTATING_TOOLS.has(CLAUDE_MESSAGE_HELPER_TOOL_ID) }, {
			results: [
				[false, 'The message is with Rename the helpers. Its reply arrives in this chat as its report.'],
				[true, 'Give the helper and the message.'],
				[true, 'Klawly could not run the delegated chat: No helper of this chat matches "x".'],
			],
			sent: [{ task: '', messageHelper: { helper: 'Rename the helpers', text: 'Also rename the tests.' } }],
			allowed: true,
		});
	});
});

function idleQuery(releases: Array<() => void>): ClaudeQuery {
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
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => release?.(),
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > 5000) {
			assert.fail('condition was not met');
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}
