/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_PERMISSION_LEVELS, readClaudePermissionPolicy } from '../../common/claudeConfiguration.js';
import { AgentMode } from '../../common/claudeContext.js';
import { DEFAULT_PERMISSION_POLICY } from '../../common/claudePermissions.js';
import { claudeRunsUnasked, ClaudeSessionPermissions, effectiveClaudePermissionLevel, NO_SESSION_PERMISSIONS, readClaudeSessionPermissions, withClaudePermissionLevel } from '../../common/claudeSessionPermissions.js';
import { CLAUDE_DUPLICATE_SESSION_MANAGER_TOOLS } from '../../common/claudeNoModelTools.js';
import { claudeUnaskedDisabledBy } from '../../common/claudeUnaskedPolicy.js';
import { ClaudeAutoReviewRequest, ClaudeAutoReviewToggles, ClaudeAutoReviewVerdict } from '../../common/claudeAutoReview.js';
import { ClaudeAgentRunner, ClaudePermissionBridge } from '../../node/claudeAgentRunner.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery, ClaudeQueryOptions, ClaudeQueryPermissionMode, ClaudeQueryStart } from '../../node/claudeQuery.js';
import { buildClaudeCliArguments, claudePermissionModeFlag } from '../../node/claudeCliArgs.js';

function cliArgs(options: ClaudeQueryOptions): string[] {
	return buildClaudeCliArguments(options, { bridgeMcpServers: {}, permissionBridge: true });
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../../../..');

/** Option names and CLI flags that let Claude Code act without asking the IDE. */
const BYPASS = /bypassPermissions|dangerously-?skip-?permissions|allowDangerouslySkipPermissions|skipPermissions/i;

/** The sources allowed to name Claude Code's bypass permissions mode (issue 694). */
const BYPASS_SOURCES: readonly string[] = ['src/vs/platform/claude/common/claudeUnaskedPolicy.ts', 'src/vs/platform/claude/node/claudeCliArgs.ts'];

/**
 * Phase 23 gate, "dangerous commands require intended approval", as changed by
 * issue 694: Claude Code's bypass permissions mode is reached only by the confirmed
 * Allow Everything level, in Agent mode, in a trusted workspace. No setting value,
 * preset or flag reaches it alone, and every other turn hands each tool call to the host.
 */
suite('Claude permission bypass is only Allow Everything in Agent mode', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const folders: string[] = [];

	teardown(() => {
		for (const folder of folders.splice(0)) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	async function openQuery(mode: AgentMode, workspaceTrusted: boolean, asked: string[], sessionPermissions?: ClaudeSessionPermissions, autoReview?: (request: ClaudeAutoReviewRequest) => Promise<ClaudeAutoReviewVerdict>, live?: { runner?: ClaudeAgentRunner; readonly modes: ClaudeQueryPermissionMode[] }, autoReviewToggles?: ClaudeAutoReviewToggles): Promise<ClaudeQueryStart['options']> {
		const cwd = mkdtempSync(join(tmpdir(), 'klawly-bypass-'));
		folders.push(cwd);
		const registry = store.add(new ClaudeProcessRegistry());
		let opened: ClaudeQueryStart['options'] | undefined;
		const releases: Array<() => void> = [];
		const bridge: ClaudePermissionBridge = {
			request: async request => {
				asked.push(`${request.toolName} ${String(request.input.command ?? '')}`);
				return { behavior: 'deny', message: 'test' };
			},
		};
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			autoReview,
			autoReviewToggles: autoReviewToggles && (() => autoReviewToggles),
			queryFactory: async start => {
				opened = start.options;
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(releases, live?.modes);
			},
		}));
		if (live) {
			live.runner = runner;
		}
		const done = (async () => {
			for await (const _event of runner.start({ sessionId: `s-${mode}-${workspaceTrusted}`, prompt: 'hi', cwd, mode, workspaceTrusted, permissionBridge: bridge, sessionPermissions })) {
				// Drain the events.
			}
		})();
		store.add({ dispose: () => { releases.forEach(release => release()); void done; } });
		for (let attempt = 0; attempt < 500 && !opened; attempt++) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		assert.ok(opened, 'the query did not open');
		return opened;
	}

	test('every mode and trust state opens the SDK in default permission mode with the IDE callbacks', async () => {
		const seen: unknown[] = [];
		for (const mode of ['agent', 'plan', 'ask'] as const) {
			for (const trusted of [true, false]) {
				const asked: string[] = [];
				const options = await openQuery(mode, trusted, asked);
				const keys = Object.keys(options).filter(key => BYPASS.test(key));
				// A destructive command is screened as ask in every mode (never passed straight to the
				// SDK rules), and canUseTool hands it to the user bridge instead of allowing it.
				const screen = await options.screenTool('Bash', { command: 'rm -rf build' });
				const decision = await options.canUseTool('Bash', { command: 'rm -rf build' }, { signal: new AbortController().signal, toolUseID: `t-${mode}-${trusted}` });
				seen.push({ mode, trusted, permissionMode: options.permissionMode, keys, screen: screen?.decision, decision: decision.behavior, envBypass: Object.keys(options.env).filter(key => BYPASS.test(key)) });
				assert.ok(asked.length <= 1);
			}
		}
		assert.deepStrictEqual(seen, ['agent', 'plan', 'ask'].flatMap(mode => [true, false].map(trusted => ({
			mode, trusted, permissionMode: 'default', keys: [], screen: 'ask', decision: 'deny', envBypass: [],
		}))));
	});

	test('Allow Everything opens Claude Code in bypass permissions mode only in Agent mode in a trusted workspace', async () => {
		const everything = withClaudePermissionLevel(NO_SESSION_PERMISSIONS, 'allowEverything');
		const except = withClaudePermissionLevel(NO_SESSION_PERMISSIONS, 'allowEverythingExceptCredentials');
		const opened = async (mode: AgentMode, trusted: boolean, permissions: ClaudeSessionPermissions) => {
			const options = await openQuery(mode, trusted, [], permissions);
			const args = cliArgs(options);
			return [options.permissionMode, options.allowUnasked, (args.includes('--permission-mode') ? args[args.indexOf('--permission-mode') + 1] : 'default'), args.includes('--allow-dangerously-skip-permissions') || undefined];
		};
		assert.deepStrictEqual({
			agent: await opened('agent', true, everything),
			// Plan and Ask stay read-only and keep the host's cards, but the query may switch back to Agent without a restart.
			plan: await opened('plan', true, everything),
			ask: await opened('ask', true, everything),
			debug: await opened('debug', true, everything),
			untrusted: await opened('agent', false, everything),
			exceptCredentials: await opened('agent', true, except),
			// The stored switches without the confirmed level (a setting value alone) never bypass.
			switchesAlone: await opened('agent', true, { allowAllCommands: true, allowEverything: true, allowCredentials: true }),
		}, {
			agent: ['unasked', true, 'bypassPermissions', true],
			plan: ['default', true, 'default', true],
			ask: ['default', true, 'default', true],
			debug: ['default', true, 'default', true],
			untrusted: ['default', undefined, 'default', undefined],
			exceptCredentials: ['default', undefined, 'default', undefined],
			switchesAlone: ['default', undefined, 'default', undefined],
		});
	});

	test('in bypass permissions mode every tool runs unasked, but leaving plan mode and questions still reach the user', async () => {
		const asked: string[] = [];
		const options = await openQuery('agent', true, asked, withClaudePermissionLevel(NO_SESSION_PERMISSIONS, 'allowEverything'));
		assert.deepStrictEqual({
			destructive: await options.screenTool('Bash', { command: 'rm -rf build' }),
			credentials: await options.screenTool('Bash', { command: 'cat .env' }),
			network: await options.screenTool('WebFetch', { url: 'https://example.com' }),
			exitPlan: await options.screenTool('ExitPlanMode', { plan: 'x' }),
			asked,
		}, {
			destructive: undefined,
			credentials: undefined,
			network: undefined,
			exitPlan: { decision: 'ask' },
			asked: [],
		});
	});

	test('Allow Everything Except Credentials stays a host decision: credentials still reach the user', async () => {
		const asked: string[] = [];
		const options = await openQuery('agent', true, asked, withClaudePermissionLevel(NO_SESSION_PERMISSIONS, 'allowEverythingExceptCredentials'));
		assert.deepStrictEqual([options.permissionMode, Object.keys(options).filter(key => BYPASS.test(key)), options.disallowedTools], ['default', [], CLAUDE_DUPLICATE_SESSION_MANAGER_TOOLS]);
		assert.strictEqual(await options.screenTool('Bash', { command: 'rm -rf build' }), undefined);
		assert.deepStrictEqual(await options.screenTool('Bash', { command: 'cat .env' }), { decision: 'ask' });
		const decision = await options.canUseTool('Bash', { command: 'cat .env' }, { signal: new AbortController().signal, toolUseID: 't-env' });
		assert.deepStrictEqual([decision.behavior, asked], ['deny', ['Bash cat .env']]);
		const untrusted: string[] = [];
		const closed = await openQuery('plan', false, untrusted, withClaudePermissionLevel(NO_SESSION_PERMISSIONS, 'allowEverything'));
		assert.deepStrictEqual(await closed.screenTool('Bash', { command: 'rm -rf build' }), { decision: 'ask' });
	});

	test('turning Allow Everything off and on switches the running query live', async () => {
		const live: { runner?: ClaudeAgentRunner; readonly modes: ClaudeQueryPermissionMode[] } = { modes: [] };
		const options = await openQuery('agent', true, [], withClaudePermissionLevel(NO_SESSION_PERMISSIONS, 'allowEverything'), undefined, live);
		const settled = async (count: number) => {
			for (let attempt = 0; attempt < 200 && live.modes.length < count; attempt++) {
				await new Promise(resolve => setTimeout(resolve, 5));
			}
		};
		live.runner!.setSessionPermissions('s-agent-true', withClaudePermissionLevel(NO_SESSION_PERMISSIONS, 'allowEverythingExceptCredentials'));
		await settled(1);
		const off = await options.screenTool('Bash', { command: 'cat .env' });
		live.runner!.setSessionPermissions('s-agent-true', withClaudePermissionLevel(NO_SESSION_PERMISSIONS, 'allowEverything'));
		await settled(2);
		const on = await options.screenTool('Bash', { command: 'cat .env' });
		assert.deepStrictEqual({ modes: live.modes, off, on }, { modes: ['default', 'unasked'], off: { decision: 'ask' }, on: undefined });
	});

	test('the level, mode and trust map to the SDK mode, and a managed policy or a missing warning falls back to asking', () => {
		const table: Record<string, string[]> = {};
		for (const level of CLAUDE_PERMISSION_LEVELS) {
			table[level] = [];
			for (const mode of ['agent', 'plan', 'ask', 'debug'] as const) {
				for (const [trusted, acknowledged, blocked] of [[true, true, false], [false, true, false], [true, false, false], [true, true, true]]) {
					const permissions = withClaudePermissionLevel(NO_SESSION_PERMISSIONS, effectiveClaudePermissionLevel(level, trusted, acknowledged, blocked));
					if (claudeRunsUnasked(permissions, mode, trusted)) {
						table[level].push(`${mode}${trusted ? '' : ' untrusted'}${acknowledged ? '' : ' unconfirmed'}${blocked ? ' blocked' : ''}`);
					}
				}
			}
		}
		assert.deepStrictEqual(table, { strict: [], prompt: [], acceptEdits: [], auto: [], allowEverythingExceptCredentials: [], allowEverything: ['agent'] });
		// The stored flag survives a round trip only with the full level, and never alone.
		assert.deepStrictEqual([
			readClaudeSessionPermissions(withClaudePermissionLevel(NO_SESSION_PERMISSIONS, 'allowEverything')),
			readClaudeSessionPermissions({ allowAllCommands: false, allowEverything: true, unasked: true }),
			readClaudeSessionPermissions({ unasked: true }),
		], [
			{ allowAllCommands: false, allowEverything: true, allowCredentials: true, unasked: true },
			{ allowAllCommands: false, allowEverything: true },
			{ allowAllCommands: false, allowEverything: false },
		]);
		assert.deepStrictEqual([
			claudeUnaskedDisabledBy({ permissions: { disableBypassPermissionsMode: 'disable' } }),
			claudeUnaskedDisabledBy({ permissions: { disableBypassPermissionsMode: 'enable' } }),
			claudeUnaskedDisabledBy({ permissions: [] }),
			claudeUnaskedDisabledBy(undefined),
		], [true, false, false, false]);
	});

	test('Auto is a host decision, not a bypass: the classifier runs inside canUseTool and never sees credentials or destructive commands', async () => {
		const asked: string[] = [];
		const reviewed: string[] = [];
		const classifier = async (request: ClaudeAutoReviewRequest): Promise<ClaudeAutoReviewVerdict> => {
			const command = String(request.input.command);
			reviewed.push(command);
			if (command === 'npm publish') {
				throw new Error('classifier down');
			}
			return command === 'npm test' ? { decision: 'allow' } : { decision: 'ask', reason: 'This one is not routine.' };
		};
		const auto: ClaudeSessionPermissions = { allowAllCommands: false, allowEverything: false, autoReview: true };
		const options = await openQuery('agent', true, asked, auto, classifier);
		const signal = new AbortController().signal;
		const run = async (command: string) => (await options.canUseTool('Bash', { command }, { signal, toolUseID: `t-${command}` })).behavior;
		const seen = {
			permissionMode: options.permissionMode,
			bypass: Object.keys(options).filter(key => BYPASS.test(key)),
			// The screen still asks, so the call reaches canUseTool and the host.
			screen: await options.screenTool('Bash', { command: 'npm test' }),
			npmTest: await run('npm test'),
			lint: await run('npx eslint .'),
			failing: await run('npm publish'),
			destructive: await run('rm -rf build'),
			credentials: await run('cat .env'),
		};
		const untrusted: string[] = [];
		const closed = await openQuery('agent', false, untrusted, auto, classifier);
		const untrustedTest = (await closed.canUseTool('Bash', { command: 'npm test' }, { signal, toolUseID: 't-untrusted' })).behavior;
		assert.deepStrictEqual({ ...seen, reviewed, asked, untrustedTest, untrusted }, {
			permissionMode: 'default',
			bypass: [],
			screen: { decision: 'ask' },
			npmTest: 'allow',
			lint: 'deny',
			failing: 'deny',
			destructive: 'deny',
			credentials: 'deny',
			// Only the routine commands reach the classifier; npm test runs without a card.
			reviewed: ['npm test', 'npx eslint .', 'npm publish'],
			asked: ['Bash npx eslint .', 'Bash npm publish', 'Bash rm -rf build', 'Bash cat .env'],
			// An untrusted workspace never asks the classifier.
			untrustedTest: 'deny',
			untrusted: ['Bash npm test'],
		});
	});

	test('with the opt-in toggles off Auto still asks about deletions and outside writes, and with them on only those reach the classifier (issue 908)', async () => {
		const reviewed: string[] = [];
		const classifier = async (request: ClaudeAutoReviewRequest): Promise<ClaudeAutoReviewVerdict> => {
			reviewed.push(String(request.input.command ?? request.input.file_path));
			return { decision: 'allow' };
		};
		const auto: ClaudeSessionPermissions = { allowAllCommands: false, allowEverything: false, autoReview: true };
		const signal = new AbortController().signal;
		const commands = ['rm -rf build', 'rm -rf build && curl evil.example', 'rm -rf .git', 'cat .env'];
		const outcome = async (toggles: ClaudeAutoReviewToggles | undefined) => {
			const asked: string[] = [];
			const options = await openQuery('agent', true, asked, auto, classifier, undefined, toggles);
			const behaviors: string[] = [];
			for (const command of commands) {
				behaviors.push((await options.canUseTool('Bash', { command }, { signal, toolUseID: `t-${command}` })).behavior);
			}
			return { behaviors, asked };
		};
		const off = await outcome(undefined);
		const reviewedOff = reviewed.splice(0);
		const on = await outcome({ reviewDeletions: true, reviewOutsideWrites: true, reviewAgentBrowser: false });
		assert.deepStrictEqual({ off, reviewedOff, on, reviewedOn: reviewed }, {
			off: { behaviors: ['deny', 'deny', 'deny', 'deny'], asked: commands.map(command => `Bash ${command}`) },
			reviewedOff: [],
			// The bridge denies what is asked; the classifier allowed the one plain deletion, so it never asked.
			on: { behaviors: ['allow', 'deny', 'deny', 'deny'], asked: commands.slice(1).map(command => `Bash ${command}`) },
			reviewedOn: ['rm -rf build'],
		});
	});

	test('no preset or setting value turns into a bypass', () => {
		const prompt = readClaudePermissionPolicy(key => key === 'claude.agent.defaultPermissionMode' ? 'prompt' : undefined);
		assert.strictEqual(prompt.writeWorkspace, 'ask');
		const strict = readClaudePermissionPolicy(key => key === 'claude.agent.defaultPermissionMode' ? 'strict' : undefined);
		for (const preset of ['bypass', 'bypassPermissions', 'dangerouslySkipPermissions', 'allow-all', 'yolo']) {
			assert.deepStrictEqual(readClaudePermissionPolicy(key => key === 'claude.agent.defaultPermissionMode' ? preset : undefined), strict, preset);
		}
		// The Allow Everything levels are no bypass either: the policy stays prompt and session switches approve what asks (issue 453).
		// Bypass comes only from the confirmed level in Agent mode, never from the policy (issue 694).
		// Auto reads as Accept Edits: its classifier only removes cards the runner would show (issue 510).
		const acceptEdits = readClaudePermissionPolicy(key => key === 'claude.agent.defaultPermissionMode' ? 'acceptEdits' : undefined);
		assert.deepStrictEqual(readClaudePermissionPolicy(key => key === 'claude.agent.defaultPermissionMode' ? 'auto' : undefined), acceptEdits);
		for (const preset of ['allowEverythingExceptCredentials', 'allowEverything']) {
			assert.deepStrictEqual(readClaudePermissionPolicy(key => key === 'claude.agent.defaultPermissionMode' ? preset : undefined), prompt, preset);
		}
		// The default (no value) is strict for a new install (issue 453).
		assert.deepStrictEqual(readClaudePermissionPolicy(() => undefined), strict);
		assert.deepStrictEqual(DEFAULT_PERMISSION_POLICY, prompt);
		assert.deepStrictEqual([DEFAULT_PERMISSION_POLICY.writeOutsideWorkspace, DEFAULT_PERMISSION_POLICY.shellDestructive, DEFAULT_PERMISSION_POLICY.network], ['ask', 'ask', 'ask']);
		const contribution = readFileSync(join(REPO, 'src/vs/workbench/contrib/claude/electron-browser/claude.contribution.ts'), 'utf8');
		assert.match(contribution, /\[CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING\]: \{[^}]*enum: \['strict', 'prompt', 'acceptEdits', 'auto', 'allowEverythingExceptCredentials', 'allowEverything'\][^}]*default: 'strict',/);
	});

	test('only the command line builder and the managed policy reader name the bypass mode', () => {
		const queryOptions: ClaudeQueryOptions = {
			cwd: '/work',
			permissionMode: 'default',
			env: {},
			abortController: new AbortController(),
			canUseTool: async () => ({ behavior: 'deny', message: 'test' }),
			screenTool: async () => undefined,
		};
		const hits: string[] = [];
		for (const folder of ['src/vs/platform/claude', 'src/vs/workbench/services/claude', 'src/vs/workbench/contrib/claude', 'src/vs/workbench/contrib/claudeBackground']) {
			for (const entry of readdirSync(join(REPO, folder), { recursive: true, encoding: 'utf8' })) {
				const path = `${folder}/${entry.replace(/\\/g, '/')}`;
				if (path.endsWith('.ts') && !path.includes('/test/') && BYPASS.test(readFileSync(join(REPO, path), 'utf8'))) {
					hits.push(path);
				}
			}
		}
		assert.deepStrictEqual(hits.sort(), [...BYPASS_SOURCES]);
		const modeFlag = (options: ClaudeQueryOptions) => {
			const args = cliArgs(options);
			return [(args.includes('--permission-mode') ? args[args.indexOf('--permission-mode') + 1] : 'default'), args.includes('--allow-dangerously-skip-permissions') || undefined];
		};
		assert.deepStrictEqual({
			modes: ([undefined, 'default', 'plan', 'unasked'] as const).map(claudePermissionModeFlag),
			plain: modeFlag(queryOptions),
			allowed: modeFlag({ ...queryOptions, allowUnasked: true }),
			unasked: modeFlag({ ...queryOptions, permissionMode: 'unasked' }),
		}, {
			modes: [undefined, undefined, 'plan', 'bypassPermissions'],
			plain: ['default', undefined],
			allowed: ['default', true],
			unasked: ['bypassPermissions', true],
		});
		// Thinking summaries have no documented flag, so asking for them adds nothing to the command line (issue 1654).
		assert.deepStrictEqual(cliArgs({ ...queryOptions, thinkingDisplay: 'summarized' }), cliArgs(queryOptions));
		assert.deepStrictEqual(cliArgs(queryOptions).filter(arg => BYPASS.test(arg)), []);
	});
});

function idleQuery(releases: Array<() => void>, modes?: ClaudeQueryPermissionMode[]): ClaudeQuery {
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
		setPermissionMode: async mode => {
			modes?.push(mode);
		},
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => release?.(),
	};
}
