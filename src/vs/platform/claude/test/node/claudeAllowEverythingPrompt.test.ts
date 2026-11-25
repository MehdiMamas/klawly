/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_PLAN_DEPENDS_INSTRUCTIONS } from '../../common/claudePlanDependsPrompt.js';
import { CLAUDE_ADHD_REPLY_INSTRUCTIONS } from '../../common/claudeReplyStyle.js';
import { claudeAutonomyInstructions, CLAUDE_ALLOW_EVERYTHING_INSTRUCTIONS, CLAUDE_ALLOW_EVERYTHING_READ_ONLY_INSTRUCTIONS, claudeSessionAskReason, ClaudeSessionPermissions } from '../../common/claudeSessionPermissions.js';
import { ClaudeAgentRunner, ClaudePermissionBridge } from '../../node/claudeAgentRunner.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery, ClaudeQueryStart } from '../../node/claudeQuery.js';

const ALLOW_EVERYTHING: ClaudeSessionPermissions = { allowAllCommands: false, allowEverything: true };
const ALLOW_ALL_COMMANDS: ClaudeSessionPermissions = { allowAllCommands: true, allowEverything: false };
const NONE: ClaudeSessionPermissions = { allowAllCommands: false, allowEverything: false };

/**
 * Issue 741: under Allow Everything the user may not be watching, so Claude's system prompt
 * tells it to run its own checks and finish routine follow-ups instead of handing them back.
 */
suite('Claude Allow Everything instructions (issue 741)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const folders: string[] = [];

	teardown(() => {
		for (const folder of folders.splice(0)) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	/** Opens a session and returns the runner, the system prompt of every query it opened (oldest first) and the log. */
	async function open(sessionId: string, sessionPermissions: ClaudeSessionPermissions | undefined, workspaceTrusted: boolean, adhd = false) {
		const cwd = mkdtempSync(join(tmpdir(), 'klawly-allow-everything-'));
		folders.push(cwd);
		const registry = store.add(new ClaudeProcessRegistry());
		const prompts: (string | undefined)[] = [];
		const logs: string[] = [];
		const releases: Array<() => void> = [];
		let latest: ClaudeQueryStart['options'] | undefined;
		const bridge: ClaudePermissionBridge = { request: async () => ({ behavior: 'deny', message: 'test' }) };
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			homeDirectory: cwd,
			log: line => logs.push(line),
			queryFactory: async start => {
				prompts.push(start.options.systemPrompt);
				latest = start.options;
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(releases);
			},
		}));
		const done = (async () => {
			for await (const _event of runner.start({ sessionId, prompt: 'hi', cwd, mode: 'agent', workspaceTrusted, permissionBridge: bridge, sessionPermissions, replyStyle: adhd ? 'adhd' : undefined, workRules: false })) {
				// Drain the events until the session is disposed.
			}
		})();
		store.add({ dispose: () => { releases.forEach(release => release()); void done; } });
		await waitFor(() => prompts.length === 1 && !!registry.get(sessionId));
		return { runner, prompts, logs, latest: () => latest! };
	}

	test('the instructions are in the system prompt only under Allow Everything in a trusted workspace, before the reply style', async () => {
		assert.deepStrictEqual({
			allowEverything: (await open('s-on', ALLOW_EVERYTHING, true)).prompts,
			untrusted: (await open('s-untrusted', ALLOW_EVERYTHING, false)).prompts,
			allowAllCommands: (await open('s-commands', ALLOW_ALL_COMMANDS, true)).prompts,
			off: (await open('s-off', undefined, true)).prompts,
			adhd: (await open('s-adhd', ALLOW_EVERYTHING, true, true)).prompts,
		}, {
			allowEverything: [CLAUDE_ALLOW_EVERYTHING_INSTRUCTIONS],
			untrusted: [undefined],
			allowAllCommands: [undefined],
			off: [undefined],
			adhd: [`${CLAUDE_ALLOW_EVERYTHING_INSTRUCTIONS}\n\n${CLAUDE_ADHD_REPLY_INSTRUCTIONS}`],
		});
	});

	test('the text follows the chat mode and defers to the own rules of the user (issue 1168)', () => {
		const text = (mode: 'agent' | 'ask' | 'plan') => claudeAutonomyInstructions(ALLOW_EVERYTHING, true, mode);
		assert.deepStrictEqual({
			agent: text('agent'),
			ask: text('ask'),
			plan: text('plan'),
			askSaysNoAsking: CLAUDE_ALLOW_EVERYTHING_READ_ONLY_INSTRUCTIONS.includes('without asking'),
			bothDefer: [CLAUDE_ALLOW_EVERYTHING_INSTRUCTIONS, CLAUDE_ALLOW_EVERYTHING_READ_ONLY_INSTRUCTIONS].map(t => t.includes('CLAUDE.md rules take precedence')),
			agentNeverPushes: CLAUDE_ALLOW_EVERYTHING_INSTRUCTIONS.includes('unless the user asked'),
		}, {
			agent: CLAUDE_ALLOW_EVERYTHING_INSTRUCTIONS,
			ask: CLAUDE_ALLOW_EVERYTHING_READ_ONLY_INSTRUCTIONS,
			plan: CLAUDE_ALLOW_EVERYTHING_READ_ONLY_INSTRUCTIONS,
			askSaysNoAsking: false,
			bothDefer: [true, true],
			agentNeverPushes: false,
		});
	});

	test('turning Allow Everything on or off between turns restarts the query with the new prompt; an unchanged level keeps it', async () => {
		const h = await open('s-toggle', NONE, true);
		await h.runner.send('s-toggle', 'same level', undefined, true, { sessionPermissions: NONE });
		await h.runner.send('s-toggle', 'go on your own', undefined, true, { sessionPermissions: ALLOW_EVERYTHING });
		await waitFor(() => h.prompts.length === 2);
		await h.runner.send('s-toggle', 'ask me again', undefined, true, { sessionPermissions: NONE });
		await waitFor(() => h.prompts.length === 3);
		assert.deepStrictEqual({ prompts: h.prompts, resume: h.latest().resume }, { prompts: [undefined, CLAUDE_ALLOW_EVERYTHING_INSTRUCTIONS, undefined], resume: 'sdk-session' });
	});

	test('a mode switch mid-chat restarts the query with the new mode prompt, so the mode text lives in the system prompt and not in a one-off message (issue 1173)', async () => {
		const h = await open('s-mode', NONE, true);
		await h.runner.send('s-mode', 'plan it', 'plan', true, { sessionPermissions: NONE });
		await waitFor(() => h.prompts.length === 2);
		await h.runner.send('s-mode', 'now do it', 'agent', true, { sessionPermissions: NONE });
		await waitFor(() => h.prompts.length === 3);
		assert.deepStrictEqual(h.prompts, [undefined, CLAUDE_PLAN_DEPENDS_INSTRUCTIONS, undefined]);
	});

	test('a request that still asks logs why the session switches did not cover it', async () => {
		const h = await open('s-log', ALLOW_ALL_COMMANDS, true);
		await h.latest().canUseTool('Write', { file_path: join(tmpdir(), 'klawly-outside-741.ts'), content: 'x' }, { signal: new AbortController().signal, toolUseID: 'w1' });
		assert.deepStrictEqual({
			logged: h.logs.filter(line => line.startsWith('permission asks:')),
			reasons: [
				claudeSessionAskReason({ category: 'shell', risk: 'mutating' }, ALLOW_EVERYTHING, false),
				claudeSessionAskReason({ category: 'shell', risk: 'mutating' }, undefined, true),
				claudeSessionAskReason({ category: 'shell', risk: 'mutating' }, { ...NONE, autoReview: true }, true),
				claudeSessionAskReason({ category: 'read', risk: 'credentials' }, ALLOW_EVERYTHING, true),
				claudeSessionAskReason({ category: 'shell', risk: 'destructive' }, ALLOW_ALL_COMMANDS, true),
			],
		}, {
			logged: ['permission asks: tool=Write because Allow All Commands covers only commands'],
			reasons: [
				'workspace not trusted',
				'no session switch is on',
				'Auto left it to the user',
				'it touches credentials',
				'Allow All Commands leaves destructive commands asking',
			],
		});
	});

	test('the instructions ask Claude to run checks itself and not to hand routine steps back', () => {
		assert.deepStrictEqual(['Run the checks', 'yourself', 'Never ask the user to run them', 'say so if you want me to'].filter(phrase => !CLAUDE_ALLOW_EVERYTHING_INSTRUCTIONS.includes(phrase)), []);
	});
});

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 500 && !condition(); attempt++) {
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.ok(condition(), 'timed out');
}

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
