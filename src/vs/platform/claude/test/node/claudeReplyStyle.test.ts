/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_ADHD_REPLY_INSTRUCTIONS, ClaudeReplyStyle, readClaudeReplyStyle } from '../../common/claudeReplyStyle.js';
import { ClaudeAgentRunner, ClaudePermissionBridge } from '../../node/claudeAgentRunner.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery, ClaudeQueryStart } from '../../node/claudeQuery.js';

/** Issue 462: ADHD mode adds its instruction to Claude's system prompt only when the setting is on. */
suite('Claude reply style (issue 462)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const folders: string[] = [];

	teardown(() => {
		for (const folder of folders.splice(0)) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	/** Opens a session in a fresh folder and returns the system prompt its query was given. */
	async function systemPromptFor(sessionId: string, replyStyle: ClaudeReplyStyle | undefined, agentsMd?: string): Promise<string | undefined> {
		const root = mkdtempSync(join(tmpdir(), 'klawly-reply-style-'));
		folders.push(root);
		if (agentsMd) {
			writeFileSync(join(root, 'AGENTS.md'), agentsMd);
		}
		const registry = store.add(new ClaudeProcessRegistry());
		const releases: Array<() => void> = [];
		let options: ClaudeQueryStart['options'] | undefined;
		const bridge: ClaudePermissionBridge = { request: async () => ({ behavior: 'deny', message: 'test' }) };
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			homeDirectory: root,
			queryFactory: async start => {
				options = start.options;
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(releases);
			},
		}));
		const done = (async () => {
			for await (const _event of runner.start({ sessionId, prompt: 'hi', cwd: root, mode: 'agent', workspaceTrusted: true, permissionBridge: bridge, replyStyle, workRules: false })) {
				// Drain the events until the session is disposed.
			}
		})();
		store.add({ dispose: () => { releases.forEach(release => release()); void done; } });
		for (let attempt = 0; attempt < 500 && !(options && registry.get(sessionId)); attempt++) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		assert.ok(options, 'the query did not open');
		return options.systemPrompt;
	}

	test('the instruction is in the system prompt only when ADHD mode is on, after AGENTS.md', async () => {
		const withAgents = await systemPromptFor('s-agents-adhd', 'adhd', 'Use tabs.\n');
		assert.deepStrictEqual({
			off: await systemPromptFor('s-off', undefined),
			default: await systemPromptFor('s-default', 'default'),
			adhd: await systemPromptFor('s-adhd', 'adhd'),
			agentsOnly: (await systemPromptFor('s-agents', 'default', 'Use tabs.\n'))?.includes(CLAUDE_ADHD_REPLY_INSTRUCTIONS),
			withAgents: [withAgents?.includes('Use tabs.'), withAgents?.endsWith(`\n\n${CLAUDE_ADHD_REPLY_INSTRUCTIONS}`)],
		}, {
			off: undefined,
			default: undefined,
			adhd: CLAUDE_ADHD_REPLY_INSTRUCTIONS,
			agentsOnly: false,
			withAgents: [true, true],
		});
	});

	test('the instruction asks for a TL;DR first, short bullets, no filler and folded detail', () => {
		assert.deepStrictEqual(['TL;DR', 'first', 'bullets', 'no filler', '<details>', '<summary>'].filter(word => !CLAUDE_ADHD_REPLY_INSTRUCTIONS.includes(word)), []);
	});

	test('only adhd turns it on', () => {
		assert.deepStrictEqual(['adhd', 'default', 'ADHD', true, undefined].map(readClaudeReplyStyle), ['adhd', 'default', 'default', 'default', 'default']);
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
