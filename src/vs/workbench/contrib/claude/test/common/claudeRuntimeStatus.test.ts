/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeRuntimeState } from '../../../../../platform/claude/common/claude.js';
import { AgentViewState, EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../../../services/claude/common/claudeAgentState.js';
import { claudeAgentActivity, claudeFailureOffersStatus, claudeInstallerCommand, claudeInstallStatusLine, claudeSetupBlocksComposer, claudeSetupPhase, claudeSetupSteps, ClaudeStatusKind, claudeStatusKind, claudeStatusMenu, claudeStatusPresentation } from '../../common/claudeRuntimeStatus.js';
import { claudeUsageRowParts } from '../../common/claudeUsageRow.js';

const missing: ClaudeRuntimeState = { installed: false, authenticated: false, error: 'Claude Code is not installed.' };
const signedOut: ClaudeRuntimeState = { installed: true, authenticated: false, version: '2.1.0', binaryPath: '/usr/local/bin/claude' };
const ready: ClaudeRuntimeState = { installed: true, authenticated: true, version: '2.1.0', authMode: 'claude-account', binaryPath: '/usr/local/bin/claude' };
const idle = { running: false, pendingPermission: false };

suite('Claude runtime status', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('setup phase follows the probed state only', () => {
		assert.deepStrictEqual([
			claudeSetupPhase(undefined, false),
			claudeSetupPhase(missing, false),
			claudeSetupPhase(signedOut, false),
			claudeSetupPhase(signedOut, true),
			claudeSetupPhase(ready, true),
			claudeSetupPhase(missing, true),
		], ['checking', 'missing', 'signed-out', 'waiting-sign-in', 'ready', 'missing']);
		assert.deepStrictEqual((['checking', 'missing', 'signed-out', 'waiting-sign-in', 'ready'] as const).map(claudeSetupBlocksComposer), [false, true, true, true, false]);
	});

	test('setup steps show the version, path and runtime messages it reported', () => {
		assert.deepStrictEqual(claudeSetupSteps(missing, 'missing').map(step => [step.id, step.state, step.title, step.note]), [
			['runtime', 'error', 'Claude Code not found', 'Claude Code is not installed.'],
			['sign-in', 'todo', 'Sign in', undefined],
		]);
		assert.deepStrictEqual(claudeSetupSteps({ ...signedOut, error: 'Claude auth status is unavailable.' }, 'signed-out').map(step => [step.id, step.state, step.title, step.detail?.startsWith('/usr') ? step.detail : undefined, step.note]), [
			['runtime', 'done', 'Claude Code 2.1.0 found', '/usr/local/bin/claude', undefined],
			['sign-in', 'todo', 'Sign in', undefined, 'Claude auth status is unavailable.'],
		]);
	});

	test('the optional import step appears only when an editor was found', () => {
		const steps = (offer?: Parameters<typeof claudeSetupSteps>[2]) => claudeSetupSteps(signedOut, 'signed-out', offer).map(step => `${step.id}:${step.state}:${step.title}`);
		assert.deepStrictEqual({
			none: steps(),
			empty: steps({ editors: [], done: false }),
			one: steps({ editors: ['Cursor'], done: false }).at(-1),
			both: steps({ editors: ['VS Code', 'Cursor'], done: false }).at(-1),
			done: steps({ editors: ['VS Code'], done: true }).at(-1),
		}, {
			none: ['runtime:done:Claude Code 2.1.0 found', 'sign-in:todo:Sign in'],
			empty: ['runtime:done:Claude Code 2.1.0 found', 'sign-in:todo:Sign in'],
			one: 'import:todo:Import from Cursor (optional)',
			both: 'import:todo:Import from VS Code or Cursor (optional)',
			done: 'import:done:Settings imported',
		});
	});

	test('status kind: runtime and sign-in first, then approval, work, limit', () => {
		const cases: [ClaudeRuntimeState | undefined, Parameters<typeof claudeStatusKind>[1], ClaudeStatusKind | undefined][] = [
			[undefined, idle, undefined],
			[undefined, { running: true, pendingPermission: false }, 'working'],
			[missing, { running: true, pendingPermission: true }, 'runtime-missing'],
			[signedOut, idle, 'sign-in'],
			[ready, { running: true, pendingPermission: true }, 'needs-approval'],
			[ready, { running: true, pendingPermission: false }, 'working'],
			[ready, { ...idle, lastFailureKind: 'usage-limit' }, 'limit-reached'],
			[ready, { ...idle, lastFailureKind: 'auth' }, 'sign-in'],
			[ready, { ...idle, lastFailureKind: 'network' }, 'ready'],
			[ready, idle, 'ready'],
		];
		assert.deepStrictEqual(cases.map(([runtime, activity]) => claudeStatusKind(runtime, activity)), cases.map(([, , expected]) => expected));
	});

	test('each status has a codicon, a label and an accessible name', () => {
		const kinds: ClaudeStatusKind[] = ['ready', 'working', 'needs-approval', 'sign-in', 'limit-reached', 'runtime-missing'];
		assert.deepStrictEqual(kinds.map(kind => {
			const presentation = claudeStatusPresentation(kind);
			return [presentation.icon, presentation.label, presentation.kind, presentation.ariaLabel.startsWith(presentation.label)];
		}), [
			['sparkle', 'Claude: Ready', 'standard', true],
			['loading~spin', 'Claude: Working', 'standard', true],
			['shield', 'Claude: Needs approval', 'warning', true],
			['sign-in', 'Claude: Sign in', 'warning', true],
			['error', 'Claude: Limit reached', 'error', true],
			['circle-slash', 'Claude: Runtime missing', 'error', true],
		]);
	});

	test('status menu shows reported values only and never a quota, plus the plan windows Claude Code reported', () => {
		const signedIn = claudeStatusMenu(ready, 'ready', 'Sonnet');
		assert.deepStrictEqual(signedIn.info, [
			{ label: 'Claude Code 2.1.0', detail: '/usr/local/bin/claude' },
			{ label: 'Signed in with a Claude account' },
			{ label: 'Model: Sonnet' },
		]);
		assert.deepStrictEqual(signedIn.actions.map(action => [action.id, action.label]), [['open-agent', 'Open Agent'], ['settings', 'Claude Settings'], ['redetect', 'Re-detect Runtime'], ['switch-account', 'Switch Account...'], ['log-out', 'Log Out'], ['logs', 'Open Logs']]);
		// Issue 536: an API key or cloud sign-in is not Claude Code's login to leave; a signed-out runtime offers Sign In.
		assert.deepStrictEqual([
			claudeStatusMenu({ ...ready, authMode: 'api-key' }, 'ready', undefined).actions.map(action => action.id),
			claudeStatusMenu({ ...ready, authMode: 'bedrock' }, 'ready', undefined).actions.map(action => action.id),
			claudeStatusMenu(signedOut, 'sign-in', undefined).actions.map(action => action.id),
		], [
			['open-agent', 'settings', 'redetect', 'logs'],
			['open-agent', 'settings', 'redetect', 'logs'],
			['open-agent', 'settings', 'redetect', 'sign-in', 'logs'],
		]);

		const unknownAccount = claudeStatusMenu({ ...ready, authMode: 'unknown' }, 'limit-reached', undefined);
		assert.deepStrictEqual(unknownAccount.info.map(row => row.label), ['Claude Code 2.1.0', 'Signed in', 'Model: Claude Code default', 'Usage: Claude reported that the usage limit was reached']);
		assert.strictEqual(unknownAccount.info.some(row => /\d+\s*%|tokens|remaining/i.test(row.label)), false);

		const now = Date.now();
		const usage = claudeUsageRowParts([{ kind: 'session', percent: 42, resetsAt: now + 2 * 60 * 60 * 1000 }, { kind: 'week', percent: 61 }], now);
		assert.deepStrictEqual(claudeStatusMenu(ready, 'ready', 'Sonnet', usage).info.slice(3), [{ label: 'Plan usage: Session 42%, Week 61%', detail: 'Session resets in 2 hrs' }]);
		assert.deepStrictEqual(claudeStatusMenu(signedOut, 'sign-in', undefined, usage).info.map(row => row.label).filter(label => label.startsWith('Plan usage')), []);

		const absent = claudeStatusMenu(missing, 'runtime-missing', undefined);
		assert.deepStrictEqual(absent.actions.map(action => action.id), ['open-agent', 'settings', 'redetect', 'install', 'logs']);
		assert.deepStrictEqual(absent.info[0], { label: 'Claude Code not found', detail: 'Claude Code is not installed.' });
	});

	test('installer runs the official per-user script as an argument array', () => {
		assert.deepStrictEqual(claudeInstallerCommand(OperatingSystem.Windows), {
			executable: 'powershell.exe',
			args: ['-NoProfile', '-Command', 'irm https://claude.ai/install.ps1 | iex'],
			display: 'irm https://claude.ai/install.ps1 | iex',
		});
		assert.deepStrictEqual(claudeInstallerCommand(OperatingSystem.Macintosh).args, ['-c', 'curl -fsSL https://claude.ai/install.sh | bash']);
		assert.strictEqual(claudeInstallerCommand(OperatingSystem.Linux).executable, '/bin/bash');
	});

	test('the fake runtime\'s stand-in installer downloads nothing and fails after a wait (issue 797)', () => {
		assert.deepStrictEqual([claudeInstallerCommand(OperatingSystem.Windows, true).args, claudeInstallerCommand(OperatingSystem.Macintosh, true).args], [
			['-NoProfile', '-Command', 'Write-Output \'Klawly test installer: this downloads nothing and fails on purpose.\'; Start-Sleep -Seconds 40; exit 1'],
			['-c', 'echo \'Klawly test installer: this downloads nothing and fails on purpose.\'; sleep 40; exit 1'],
		]);
	});

	test('the install status line says what the installer does and for how long (issue 783)', () => {
		const startedAt = 1_000_000;
		assert.deepStrictEqual([
			claudeInstallStatusLine({ state: 'running', startedAt }, startedAt + 42_000),
			claudeInstallStatusLine({ state: 'running', startedAt, downloadedBytes: 84.4 * 1024 * 1024 }, startedAt + 725_000),
			claudeInstallStatusLine({ state: 'stalled', startedAt, downloadedBytes: 0 }, startedAt + 3_723_000),
			claudeInstallStatusLine({ state: 'running', startedAt, downloadedBytes: 269_231_264, settingUp: true }, startedAt + 61_000),
		], [
			'Starting the download · 0:42',
			'Downloaded 84 MB · 12:05',
			'Downloaded 0 MB · 1:02:03',
			'Setting up Claude Code · 1:01',
		]);
	});

	test('agent activity covers every session and the current session failure', () => {
		let running: AgentViewState = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 't1', text: 'Go' });
		running = reduceAgentState(running, {
			type: 'permission.requested',
			sessionId: 's',
			request: { id: 'p1', toolName: 'Bash', input: {}, category: 'shell', command: 'npm test', canRemember: true },
		});
		let failed: AgentViewState = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 't2', text: 'Go' });
		failed = reduceAgentState(failed, { type: 'turn.failed', message: '429', kind: 'usage-limit' });
		assert.deepStrictEqual(claudeAgentActivity([running, failed], failed), { running: true, pendingPermission: true, lastFailureKind: 'usage-limit' });
		assert.deepStrictEqual(claudeAgentActivity([failed], running), { running: false, pendingPermission: false, lastFailureKind: undefined });
	});

	test('a pending MCP form or sign-in needs the user like a permission', () => {
		const form: AgentViewState = reduceAgentState(reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 't1', text: 'Go' }), {
			type: 'elicitation.requested',
			sessionId: 's',
			request: { id: 'e1', server: 'deploy', mode: 'form', message: 'Release details', schema: { type: 'object', properties: { name: { type: 'string' } } }, expiresAt: 1 },
		});
		const answered = reduceAgentState(form, { type: 'elicitation.resolved', sessionId: 's', outcome: { id: 'e1', server: 'deploy', mode: 'form', action: 'accept', source: 'user' } });
		assert.deepStrictEqual([form, answered].map(state => claudeStatusKind(ready, claudeAgentActivity([state], state))), ['needs-approval', 'working']);
	});

	test('Open Claude Status is offered only for failures the status menu can explain', () => {
		const kinds = ['auth', 'usage-limit', 'network', 'runtime-missing', 'runtime-version', 'permission-denied', 'tool-failure', 'process-crash', 'workspace-conflict', 'turn-limit', 'unknown', undefined] as const;
		assert.deepStrictEqual(kinds.filter(claudeFailureOffersStatus), ['auth', 'usage-limit', 'network', 'runtime-missing', 'runtime-version']);
	});
});
