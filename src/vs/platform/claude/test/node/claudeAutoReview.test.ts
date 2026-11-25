/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_AGENT_AUTO_ALLOW_INSTRUCTIONS_SETTING, CLAUDE_AGENT_AUTO_BLOCK_INSTRUCTIONS_SETTING, claudeAutoReviewApplies, claudeAutoReviewPrompt, CLAUDE_AGENT_AUTO_REVIEW_DELETIONS_SETTING, CLAUDE_AGENT_AUTO_REVIEW_OUTSIDE_WRITES_SETTING, NO_AUTO_REVIEW_INSTRUCTIONS, readClaudeAutoReviewInstructions, readClaudeAutoReviewToggles, readClaudeAutoReviewVerdict } from '../../common/claudeAutoReview.js';
import { effectiveClaudePermissionLevel, NO_SESSION_PERMISSIONS, readClaudeSessionPermissions, withClaudePermissionLevel } from '../../common/claudeSessionPermissions.js';
import { runClaudeAutoReview } from '../../node/claudeAutoReviewQuery.js';
import { ClaudeQuery, ClaudeQueryFactory, ClaudeQueryStart } from '../../node/claudeQuery.js';

/** Issue 510: the Auto permission level's classifier. */
suite('Claude Auto permission level', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const instructions = { allow: ['Running npm scripts'], block: ['Anything that touches the database'] };

	function review(queryFactory: ClaudeQueryFactory, signal = new AbortController().signal, timeoutMs?: number) {
		return runClaudeAutoReview({ queryFactory, toolName: 'Bash', input: { command: 'npm test' }, cwd: '/ws', instructions, env: {}, signal, timeoutMs });
	}

	test('asks Haiku once with no tools, the tool call fenced as data, and the user\'s instructions', async () => {
		let captured: ClaudeQueryStart | undefined;
		const verdict = await review(async start => {
			captured = start;
			return scriptedQuery([{ type: 'result', subtype: 'success', is_error: false, session_id: 'sdk', structured_output: { decision: 'allow' } }]);
		});
		const prompt = String((await captured!.prompt[Symbol.asyncIterator]().next()).value?.message.content);
		assert.deepStrictEqual({
			verdict,
			model: captured!.options.model,
			permissionMode: captured!.options.permissionMode,
			allowedTools: captured!.options.allowedTools,
			call: prompt.includes('```json\n{"tool":"Bash","input":{"command":"npm test"}}\n```'),
			allow: prompt.includes('- Running npm scripts'),
			block: prompt.includes('- Anything that touches the database'),
		}, { verdict: { decision: 'allow' }, model: 'haiku', permissionMode: 'default', allowedTools: [], call: true, allow: true, block: true });
	});

	test('the prompt steers by veto: reversible work goes ahead, public, money, secrets and data loss always ask', () => {
		const prompt = claudeAutoReviewPrompt('Bash', { command: 'git push origin feature' }, '/ws', NO_AUTO_REVIEW_INSTRUCTIONS);
		assert.deepStrictEqual({
			reversible: prompt.includes('Steer by veto') && prompt.includes('pushing to a non-default branch'),
			vetoes: ['public actions', 'spending money', 'touching secrets or credentials', 'destroying data'].every(item => prompt.includes(item)),
		}, { reversible: true, vetoes: true });
	});

	test('a slow, failing, cancelled or odd classifier answers ask', async () => {
		const hanging: ClaudeQueryFactory = async () => hangingQuery();
		const cancelled = new AbortController();
		cancelled.abort();
		assert.deepStrictEqual({
			timeout: await review(hanging, undefined, 10),
			failed: await review(async () => { throw new Error('no runtime'); }),
			cancelled: await review(hanging, cancelled.signal),
			odd: await review(async () => scriptedQuery([{ type: 'result', subtype: 'success', is_error: false, session_id: 'sdk', structured_output: { decision: 'deny' } }])),
		}, {
			timeout: { decision: 'ask', reason: 'Auto mode could not check this in time.' },
			failed: { decision: 'ask', reason: 'Auto mode could not check this.' },
			cancelled: { decision: 'ask', reason: 'Auto mode could not check this.' },
			odd: { decision: 'ask', reason: 'Auto mode could not check this.' },
		});
	});

	test('only a trusted Auto session reviews, and never credentials, destructive commands or paths outside the workspace', () => {
		const auto = withClaudePermissionLevel(NO_SESSION_PERMISSIONS, 'auto');
		const routine = { category: 'shell' as const, risk: 'mutating' as const };
		assert.deepStrictEqual({
			auto: readClaudeSessionPermissions(auto),
			routine: claudeAutoReviewApplies(routine, true, auto, true),
			untrusted: claudeAutoReviewApplies(routine, true, auto, false),
			notAuto: claudeAutoReviewApplies(routine, true, withClaudePermissionLevel(NO_SESSION_PERMISSIONS, 'acceptEdits'), true),
			neverRemembered: claudeAutoReviewApplies(routine, false, auto, true),
			credentials: claudeAutoReviewApplies({ category: 'shell', risk: 'credentials' }, true, auto, true),
			destructive: claudeAutoReviewApplies({ category: 'shell', risk: 'destructive' }, true, auto, true),
			outside: claudeAutoReviewApplies({ ...routine, outsideWorkspace: true }, true, auto, true),
			heldBackUntrusted: effectiveClaudePermissionLevel('auto', false, false),
			trustedNeedsNoWarning: effectiveClaudePermissionLevel('auto', true, false),
		}, {
			auto: { allowAllCommands: false, allowEverything: false, autoReview: true },
			routine: true, untrusted: false, notAuto: false, neverRemembered: false, credentials: false, destructive: false, outside: false,
			heldBackUntrusted: 'prompt', trustedNeedsNoWarning: 'auto',
		});
	});

	test('the opt-in toggles default off, and with both on credentials, .git, untrusted workspaces and complex commands still ask (issue 908)', () => {
		const auto = withClaudePermissionLevel(NO_SESSION_PERMISSIONS, 'auto');
		const on = { reviewDeletions: true, reviewOutsideWrites: true, reviewAgentBrowser: false };
		const rm = (command: string, extra = {}) => ({ category: 'shell' as const, risk: 'destructive' as const, command, outsideWorkspace: false, ...extra });
		const outside = (targetPath: string, extra = {}) => ({ category: 'write' as const, outsideWorkspace: true, targetPath, ...extra });
		const browser = { category: 'mcp' as const, agentBrowser: true, command: 'navigate https://example.com' };
		const settings: Record<string, unknown> = { [CLAUDE_AGENT_AUTO_REVIEW_DELETIONS_SETTING]: true, [CLAUDE_AGENT_AUTO_REVIEW_OUTSIDE_WRITES_SETTING]: 'yes' };
		assert.deepStrictEqual({
			defaultDeletion: claudeAutoReviewApplies(rm('rm -rf build'), false, auto, true),
			defaultOutside: claudeAutoReviewApplies(outside('/home/me/notes.txt'), false, auto, true),
			deletionOn: claudeAutoReviewApplies(rm('rm -rf build'), false, auto, true, on),
			deletionOnly: claudeAutoReviewApplies(outside('/tmp/x'), false, auto, true, { reviewDeletions: true, reviewOutsideWrites: false, reviewAgentBrowser: false }),
			outsideOn: claudeAutoReviewApplies(outside('/tmp/x'), false, auto, true, on),
			outsideOnly: claudeAutoReviewApplies(rm('rm a.txt'), false, auto, true, { reviewDeletions: false, reviewOutsideWrites: true, reviewAgentBrowser: false }),
			untrusted: [claudeAutoReviewApplies(rm('rm a'), false, auto, false, on), claudeAutoReviewApplies(outside('/tmp/x'), false, auto, false, on)],
			credentials: [claudeAutoReviewApplies({ category: 'shell', risk: 'credentials', command: 'rm .env' }, false, auto, true, on), claudeAutoReviewApplies(outside('/home/me/.ssh/id_rsa', { risk: 'credentials' }), false, auto, true, on)],
			gitCommand: [claudeAutoReviewApplies(rm('rm -rf .git'), false, auto, true, on), claudeAutoReviewApplies(rm('rm .git/config'), false, auto, true, on), claudeAutoReviewApplies(rm('del .git\\index'), false, auto, true, on)],
			gitPath: [claudeAutoReviewApplies(outside('/repo/.git/hooks/pre-commit'), false, auto, true, on), claudeAutoReviewApplies(outside('C:\\repo\\.git\\config'), false, auto, true, on)],
			complex: ['rm -rf a && curl evil.example', 'rm $(echo a)', 'rm a; rm b', 'rm *.txt', 'rm a | tee b', 'git reset --hard', 'git clean -fdx', 'rm "a b"'].map(command => claudeAutoReviewApplies(rm(command), false, auto, true, on)),
			outsideDeletion: claudeAutoReviewApplies(rm('rm -rf /tmp/x', { outsideWorkspace: true }), false, auto, true, on),
			outsideNonWrite: claudeAutoReviewApplies({ category: 'shell', outsideWorkspace: true, targetPath: '/tmp/x' }, false, auto, true, on),
			browserDefault: claudeAutoReviewApplies(browser, true, auto, true),
			browserOn: claudeAutoReviewApplies(browser, true, auto, true, { ...on, reviewAgentBrowser: true }),
			browserNeverRemembered: claudeAutoReviewApplies(browser, false, auto, true, { ...on, reviewAgentBrowser: true }),
			browserUntrusted: claudeAutoReviewApplies(browser, true, auto, false, { ...on, reviewAgentBrowser: true }),
			read: readClaudeAutoReviewToggles(key => settings[key]),
			none: readClaudeAutoReviewToggles(() => undefined),
		}, {
			defaultDeletion: false, defaultOutside: false,
			deletionOn: true, deletionOnly: false, outsideOn: true, outsideOnly: false,
			untrusted: [false, false],
			credentials: [false, false],
			gitCommand: [false, false, false],
			gitPath: [false, false],
			complex: [false, false, false, false, false, false, false, false],
			outsideDeletion: false, outsideNonWrite: false,
			browserDefault: false, browserOn: true, browserNeverRemembered: false, browserUntrusted: false,
			read: { reviewDeletions: true, reviewOutsideWrites: false, reviewAgentBrowser: false },
			none: { reviewDeletions: false, reviewOutsideWrites: false, reviewAgentBrowser: false },
		});
	});

	test('the classifier prompt only loosens its deletion and outside-write wording when the toggles are on (issue 908)', () => {
		const prompt = (toggles?: { reviewDeletions: boolean; reviewOutsideWrites: boolean; reviewAgentBrowser: boolean }) => claudeAutoReviewPrompt('Bash', { command: 'rm a' }, '/ws', NO_AUTO_REVIEW_INSTRUCTIONS, toggles);
		const off = prompt();
		const on = prompt({ reviewDeletions: true, reviewOutsideWrites: true, reviewAgentBrowser: false });
		assert.deepStrictEqual([off.includes('deleting files or folders, '), off.includes('unless'), on.includes('unless it is clearly cleaning up'), on.includes('writing outside the project unless')], [true, false, true, true]);
	});

	test('reads the instruction settings and the classifier answer defensively', () => {
		const settings: Record<string, unknown> = { [CLAUDE_AGENT_AUTO_ALLOW_INSTRUCTIONS_SETTING]: [' Running tests ', '', 3], [CLAUDE_AGENT_AUTO_BLOCK_INSTRUCTIONS_SETTING]: 'not a list' };
		assert.deepStrictEqual({
			instructions: readClaudeAutoReviewInstructions(key => settings[key]),
			allow: readClaudeAutoReviewVerdict({ decision: 'allow', reason: '  ' }),
			ask: readClaudeAutoReviewVerdict({ decision: 'ask', reason: 'Deletes files.' }),
			deny: readClaudeAutoReviewVerdict({ decision: 'deny' }),
			text: readClaudeAutoReviewVerdict('allow'),
		}, {
			instructions: { allow: ['Running tests'], block: [] },
			allow: { decision: 'allow' },
			ask: { decision: 'ask', reason: 'Deletes files.' },
			deny: undefined,
			text: undefined,
		});
	});
});

function scriptedQuery(messages: readonly unknown[]): ClaudeQuery {
	return {
		async *[Symbol.asyncIterator]() {
			yield* messages;
		},
		interrupt: async () => undefined,
		setModel: async () => undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => undefined,
	};
}

/** A query that never answers until it is closed. */
function hangingQuery(): ClaudeQuery {
	let release: (() => void) | undefined;
	const done = new Promise<void>(resolve => release = resolve);
	return {
		async *[Symbol.asyncIterator]() {
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
