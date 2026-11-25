/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeFailingCheck, ClaudeTendSnapshotResult, IClaudeCheckInvestigator } from '../../../../../platform/claude/common/claudeCheckInvestigation.js';
import { PendingInput } from '../../../../../platform/claude/common/claudeContext.js';
import { ClaudeGitHubReference } from '../../../../../platform/claude/common/claudeProtocol.js';
import { ClaudeTendSnapshot } from '../../../../../platform/claude/common/claudeTendPullRequest.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkspace, IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IStatusbarEntry, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { CLAUDE_STOP_TENDING_PR_COMMAND_ID, CLAUDE_TEND_POLL_SETTING, CLAUDE_TEND_TURNS_SETTING, CLAUDE_TENDING_PR, ClaudeTendPullRequestService, ClaudeTendStatusBar, IClaudeTendScheduler, tendStatusEntry } from '../../browser/chat/claudeTendPullRequest.js';

const reference: ClaudeGitHubReference = { url: 'https://github.com/acme/app/pull/7', owner: 'acme', repo: 'app', number: 7, kind: 'pullRequest', createdBySession: false };
const failing: ClaudeFailingCheck = { name: 'test', url: 'https://github.com/acme/app/actions/runs/1/job/2', runId: '1', jobId: '2' };

function snapshot(extra: Partial<ClaudeTendSnapshot> = {}): ClaudeTendSnapshot {
	return { state: 'open', draft: false, headSha: 'a1', branch: 'fix/cache', failing: [], pending: 0, passing: 3, comments: [], reviewDecision: '', ...extra };
}

suite('Claude Tend This PR service (issue 1016)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(reads: ClaudeTendSnapshotResult[], settings: { turns?: number; noFolder?: boolean } = {}) {
		const log: string[] = [];
		const timers: { callback: () => void; milliseconds: number; cleared: boolean }[] = [];
		const scheduler: IClaudeTendScheduler = {
			set: (callback, milliseconds) => { const timer = { callback, milliseconds, cleared: false }; timers.push(timer); return timer; },
			clear: handle => { if (handle) { (handle as { cleared: boolean }).cleared = true; } },
		};
		let read = 0;
		const investigator = {
			tendSnapshot: async () => reads[Math.min(read++, reads.length - 1)],
			failedLog: async () => ({ ok: true, log: { text: 'boom', omitted: 0 } }),
		} as Partial<IClaudeCheckInvestigator> as IClaudeCheckInvestigator;
		const agent = {
			queue: async (_session: string, _text: string, _cwd: string, behavior: PendingInput['behavior']) => {
				log.push(`queue ${behavior}`);
				return {} as PendingInput;
			},
		} as Partial<IClaudeAgentService> as IClaudeAgentService;
		const workspace = { getWorkspace: () => ({ folders: settings.noFolder ? [] : [{ uri: URI.file('/work/app') }] }) as Partial<IWorkspace> as IWorkspace } as Partial<IWorkspaceContextService> as IWorkspaceContextService;
		const configuration = new TestConfigurationService({ [CLAUDE_TEND_POLL_SETTING]: 60, [CLAUDE_TEND_TURNS_SETTING]: settings.turns ?? 5 });
		const notifications = {
			info: (message: string) => log.push(`info ${message}`),
			warn: (message: string) => log.push(`warn ${message}`),
			error: (message: string) => log.push(`error ${message}`),
			prompt: (_severity: unknown, message: string, choices: readonly { label: string; run: () => void }[]) => { log.push(`info ${message}`); log.push(`actions ${choices.map(choice => choice.label).join(',')}`); choices[0]?.run(); },
		} as unknown as INotificationService;
		const commands = { executeCommand: async (id: string, ...args: unknown[]) => { log.push(`command ${id} ${args.join(',')}`); } } as Partial<ICommandService> as ICommandService;
		const service = store.add(new ClaudeTendPullRequestService(scheduler, investigator, agent, workspace, configuration, notifications, commands, { remember: async () => { } }));
		const changes: string[] = [];
		store.add(service.onDidChange(event => changes.push(event.sessionId)));
		/** Runs the poll the service scheduled last, and lets it finish. */
		const tick = async () => {
			const timer = timers[timers.length - 1];
			assert.ok(timer && !timer.cleared, 'a poll is scheduled');
			timer.callback();
			for (let i = 0; i < 10; i++) {
				await Promise.resolve();
			}
		};
		const count = (prefix: string) => log.filter(line => line.startsWith(prefix)).length;
		return { service, log, timers, changes, tick, count };
	}

	test('queues one turn for a failing check, waits on the poll interval, and stops when everything passes', async () => {
		const h = setup([{ ok: true, snapshot: snapshot({ failing: [failing], passing: 2 }) }, { ok: true, snapshot: snapshot({ headSha: 'a2' }) }]);
		await h.service.start('s1', reference);
		const afterFirst = { tending: h.service.isTending('s1'), queued: h.count('queue'), wait: h.timers[0]?.milliseconds };
		await h.tick();
		assert.deepStrictEqual({ afterFirst, tendingAfter: h.service.isTending('s1'), changes: h.changes, clean: h.count('info Stopped tending #7: every check passed') }, {
			afterFirst: { tending: true, queued: 1, wait: 60000 },
			tendingAfter: false,
			changes: ['s1', 's1'],
			clean: 1,
		});
	});

	test('does not queue the same failing check twice while it is unchanged', async () => {
		const failingRead: ClaudeTendSnapshotResult = { ok: true, snapshot: snapshot({ failing: [failing], passing: 2 }) };
		const h = setup([failingRead, failingRead]);
		await h.service.start('s1', reference);
		await h.tick();
		assert.deepStrictEqual({ queued: h.count('queue'), tending: h.service.isTending('s1'), timers: h.timers.length }, { queued: 1, tending: true, timers: 2 });
	});

	test('a second start for the same chat is ignored and stop clears the pending timer', async () => {
		const h = setup([{ ok: true, snapshot: snapshot({ pending: 1 }) }]);
		await h.service.start('s1', reference);
		await h.service.start('s1', reference);
		const timer = h.timers[0];
		h.service.stop('s1');
		assert.deepStrictEqual({ timers: h.timers.length, cleared: timer.cleared, tending: h.service.isTending('s1'), stopped: h.count('info Stopped tending #7') }, { timers: 1, cleared: true, tending: false, stopped: 1 });
	});

	test('stops after the turn cap and tells the user', async () => {
		const first: ClaudeTendSnapshotResult = { ok: true, snapshot: snapshot({ failing: [failing], passing: 2 }) };
		const second: ClaudeTendSnapshotResult = { ok: true, snapshot: snapshot({ headSha: 'b2', failing: [failing], passing: 2 }) };
		const h = setup([first, second], { turns: 1 });
		await h.service.start('s1', reference);
		await h.tick();
		assert.deepStrictEqual({ tending: h.service.isTending('s1'), queued: h.count('queue'), capped: h.count('info Stopped tending #7 after 1 turns'), settings: h.count('command workbench.action.openSettings claude.tend.maxTurns') }, { tending: false, queued: 1, capped: 1, settings: 1 });
	});

	test('a missing GitHub CLI stops tending with a sign-in warning', async () => {
		const h = setup([{ ok: false, problem: 'ghMissing', message: 'gh not found' }]);
		await h.service.start('s1', reference);
		assert.deepStrictEqual({ tending: h.service.isTending('s1'), warned: h.count('warn Stopped tending #7: the GitHub CLI is missing'), timers: h.timers.length }, { tending: false, warned: 1, timers: 0 });
	});

	test('with no local folder open, start says so up front and never starts (issue 1044)', async () => {
		const h = setup([{ ok: true, snapshot: snapshot({ failing: [failing], passing: 2 }) }], { noFolder: true });
		await h.service.start('s1', reference);
		assert.deepStrictEqual({ tending: h.service.isTending('s1'), log: h.log, timers: h.timers.length }, { tending: false, log: ['error Open a local folder before tending a pull request.'], timers: 0 });
	});

	test('a merged pull request ends tending', async () => {
		const h = setup([{ ok: true, snapshot: snapshot({ state: 'merged' }) }]);
		await h.service.start('s1', reference);
		assert.deepStrictEqual({ tending: h.service.isTending('s1'), merged: h.count('info Stopped tending #7: it was merged') }, { tending: false, merged: 1 });
	});

	test('tending() lists the runs and lastEnd() keeps the end reason until the next start (issue 1042)', async () => {
		const h = setup([{ ok: true, snapshot: snapshot({ pending: 1 }) }]);
		await h.service.start('s1', reference);
		assert.deepStrictEqual(h.service.tending(), [{ sessionId: 's1', number: 7 }]);
		h.service.stop('s1');
		assert.deepStrictEqual({ tending: h.service.tending(), end: h.service.lastEnd('s1') }, { tending: [], end: { reason: 'stopped', number: 7, message: 'Stopped tending #7.' } });
		await h.service.start('s1', reference);
		assert.strictEqual(h.service.lastEnd('s1'), undefined);
		h.service.stop('s1');
	});

	test('the status entry names the pull request and stops it on click (issue 1042)', () => {
		assert.strictEqual(tendStatusEntry([]), undefined);
		const one = tendStatusEntry([{ sessionId: 's1', number: 7 }])!;
		assert.deepStrictEqual({ text: one.text, command: one.command }, { text: '$(sync~spin) Tending #7', command: { id: CLAUDE_STOP_TENDING_PR_COMMAND_ID, title: 'Stop Tending This PR', arguments: ['s1'] } });
		assert.strictEqual(tendStatusEntry([{ sessionId: 's1', number: 7 }, { sessionId: 's2', number: 9 }])!.text, '$(sync~spin) Tending 2 PRs');
	});

	test('the status bar item and the tending context key follow the service (issue 1042)', async () => {
		const h = setup([{ ok: true, snapshot: snapshot({ pending: 1 }) }]);
		const entries: { entry: IStatusbarEntry; disposed: boolean }[] = [];
		const statusbar = {
			addEntry: (entry: IStatusbarEntry) => {
				const added = { entry, disposed: false };
				entries.push(added);
				return { update: (next: IStatusbarEntry) => { added.entry = next; }, dispose: () => { added.disposed = true; } };
			},
		} as Partial<IStatusbarService> as IStatusbarService;
		const contextKeys = new MockContextKeyService();
		store.add(new ClaudeTendStatusBar(h.service, statusbar, contextKeys));
		const key = () => contextKeys.getContextKeyValue(CLAUDE_TENDING_PR.key);
		assert.deepStrictEqual({ key: key(), entries: entries.length }, { key: false, entries: 0 });
		await h.service.start('s1', reference);
		assert.deepStrictEqual({ key: key(), entries: entries.length, text: entries[0].entry.text }, { key: true, entries: 1, text: '$(sync~spin) Tending #7' });
		h.service.stop('s1');
		assert.deepStrictEqual({ key: key(), disposed: entries[0].disposed }, { key: false, disposed: true });
	});
});
