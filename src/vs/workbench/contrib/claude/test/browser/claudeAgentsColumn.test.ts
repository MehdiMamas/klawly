/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { getWindow } from '../../../../../base/browser/dom.js';
import { IAction } from '../../../../../base/common/actions.js';
import { Emitter } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeAutomationEntry } from '../../../../../platform/claude/common/claudeAutomation.js';
import { BackgroundAgentTask } from '../../../../../platform/claude/common/claudeBackground.js';
import { ClaudeCloudSessionRecord } from '../../../../../platform/claude/common/claudeCloud.js';
import { NormalizedClaudeEvent } from '../../../../../platform/claude/common/claudeProtocol.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IKlawlySyncService, KlawlySyncImportedSession } from '../../../../../platform/claude/common/klawlySyncService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { ClaudeAgentSession, IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { AgentViewState, EMPTY_AGENT_VIEW_STATE, reduceAgentState, TurnViewModel } from '../../../../services/claude/common/claudeAgentState.js';
import { IClaudeAutomationService } from '../../../../services/claude/common/claudeAutomationService.js';
import { IClaudeBackgroundAgentService } from '../../../../services/claude/common/claudeBackgroundAgent.js';
import { IClaudeDelegationService } from '../../../../services/claude/common/claudeDelegation.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ClaudeAgentsColumn } from '../../browser/chat/claudeAgentsColumn.js';
import { IClaudeProjectIndex } from '../../browser/claudeProjects.js';
import { ClaudeGoalView, IClaudeGoalLoopService } from '../../common/claudeGoalLoopService.js';
import { IClaudeGitHubDetailsService } from '../../browser/chat/claudeGitHubDetails.js';
import { IClaudeCloudSessionsService } from '../../browser/claudeCloudSessions.js';
import { IClaudeSetupService } from '../../browser/claudeSetup.js';
import { CLAUDE_NEW_SESSION_COMMAND_ID, CLAUDE_OPEN_SETTINGS_COMMAND_ID, CLAUDE_SHOW_STATUS_COMMAND_ID } from '../../common/claudeViews.js';
import { TestClaudeGitHubDetailsService } from './claudeGitHubTestUtils.js';
import { TestClaudeSetupService } from './claudeSetupTestUtils.js';

const HOUR = 60 * 60 * 1000;

function turn(status: TurnViewModel['status'], extra: Partial<TurnViewModel> = {}): TurnViewModel {
	return { id: `t-${status}`, user: { text: 'prompt' }, assistantText: '', status, cards: [], changedFiles: [], permissions: [], segmentOpen: false, segmentStart: 0, steered: [], ...extra };
}

function session(id: string, updatedAt: number, extra: Partial<ClaudeAgentSession> = {}): ClaudeAgentSession {
	return { id, title: id, mode: 'agent', draft: '', attachments: [], additionalDirectories: [], slashCommands: [], skills: [], commands: [], agents: [], updatedAt, ...extra } as ClaudeAgentSession;
}

suite('Claude agents column (ide-03)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiationService: TestInstantiationService;
	let viewState: Emitter<{ sessionId: string }>;
	let turns: Map<string, TurnViewModel[]>;
	let sessions: ClaudeAgentSession[];
	let tasks: BackgroundAgentTask[];
	/** The automation that started each task, by task id. */
	let automationOf: Map<string, ClaudeAutomationEntry>;
	let automationChanges: Emitter<void>;
	let goals: Map<string, ClaudeGoalView>;
	let goalChanges: Emitter<string>;
	let calls: string[];
	let menus: IAction[][];
	let setupService: TestClaudeSetupService;
	let gitHub: TestClaudeGitHubDetailsService;
	let pullRequests: Map<string, AgentViewState['pullRequest']>;
	let current: string;
	let cloudSessions: ClaudeCloudSessionRecord[];
	let cloudChanges: Emitter<void>;
	let imported: KlawlySyncImportedSession[];
	let syncChanges: Emitter<void>;

	setup(() => {
		const startOfToday = new Date();
		startOfToday.setHours(0, 0, 0, 0);
		const now = Date.now();
		viewState = store.add(new Emitter<{ sessionId: string }>());
		calls = [];
		menus = [];
		current = 'fix-login';
		sessions = [
			session('fix-login', now - 1000),
			session('add-tests', now - 2000),
			session('nightly-refactor', now - 3000),
			session('old-spike', startOfToday.getTime() - HOUR),
		];
		turns = new Map([
			['fix-login', [turn('running', { cards: [{ kind: 'edit', verb: 'Editing', state: 'running', target: 'src/login.ts', file: '/repo/src/login.ts' } as TurnViewModel['cards'][number]] })]],
			['add-tests', [turn('complete', { changedFiles: ['a.test.ts'] })]],
			['nightly-refactor', [turn('complete')]],
			['old-spike', [turn('failed')]],
		]);
		pullRequests = new Map();
		tasks = [{ id: 'automation-nightly-1a2b3c4d', sessionId: 'nightly-refactor', status: 'complete', filesChanged: 3, added: 40, removed: 12 } as BackgroundAgentTask];
		instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IClaudeAgentService, {
			onDidChangeSession: (() => ({ dispose() { } })),
			onDidChangeViewState: viewState.event,
			onDidChangePending: (() => ({ dispose() { } })),
			getSessions: () => sessions,
			getHistory: () => sessions,
			getCurrentSession: () => sessions.find(candidate => candidate.id === current),
			getViewState: (id: string) => ({ turns: turns.get(id) ?? [], subagents: [], pullRequest: pullRequests.get(id) }),
			selectSession: (id: string) => { calls.push(`select ${id}`); current = id; },
			resume: async (id: string) => { calls.push(`resume ${id}`); },
			stop: async (id: string) => { calls.push(`stop ${id}`); },
		} as unknown as IClaudeAgentService);
		instantiationService.stub(IClaudeBackgroundAgentService, { onDidChangeTasks: (() => ({ dispose() { } })), getTasks: () => tasks } as unknown as IClaudeBackgroundAgentService);
		instantiationService.stub(IClaudeDelegationService, { getRolledUpCost: () => undefined } as unknown as IClaudeDelegationService);
		setupService = store.add(new TestClaudeSetupService({ installed: true, authenticated: true, version: '2.1.281', authMode: 'claude-account' }));
		instantiationService.stub(IClaudeSetupService, setupService);
		gitHub = store.add(new TestClaudeGitHubDetailsService());
		instantiationService.stub(IClaudeGitHubDetailsService, gitHub);
		goals = new Map();
		goalChanges = store.add(new Emitter<string>());
		instantiationService.stub(IClaudeProjectIndex, { onDidChange: new Emitter<void>().event, projectOf: () => undefined, refresh: () => { } } as unknown as IClaudeProjectIndex);
		instantiationService.stub(IClaudeGoalLoopService, { onDidChange: goalChanges.event, getGoal: (id: string) => goals.get(id), getEnded: () => undefined, getLoop: () => undefined } as unknown as IClaudeGoalLoopService);
		automationOf = new Map();
		automationChanges = store.add(new Emitter<void>());
		instantiationService.stub(IClaudeAutomationService, { onDidChange: automationChanges.event, automationOfTask: (taskId: string) => automationOf.get(taskId) } as unknown as IClaudeAutomationService);
		imported = [];
		syncChanges = store.add(new Emitter<void>());
		instantiationService.stub(IKlawlySyncService, { onDidChangeStatus: syncChanges.event, listImportedSessions: async () => imported } as unknown as IKlawlySyncService);
		cloudSessions = [];
		cloudChanges = store.add(new Emitter<void>());
		instantiationService.stub(IClaudeCloudSessionsService, {
			onDidChange: cloudChanges.event,
			getSessions: () => cloudSessions,
			remove: (id: string) => { calls.push(`forget ${id}`); cloudSessions = cloudSessions.filter(record => record.id !== id); cloudChanges.fire(); },
		} as unknown as IClaudeCloudSessionsService);
		instantiationService.stub(IOpenerService, { open: async (target: unknown) => { calls.push(`open ${target}`); return true; } } as unknown as IOpenerService);
		instantiationService.stub(ICommandService, { executeCommand: async (id: string, ...args: unknown[]) => { calls.push([id, ...args].join(' ')); return undefined; } } as unknown as ICommandService);
		instantiationService.stub(IContextMenuService, {
			showContextMenu: (delegate: IContextMenuDelegate) => { menus.push(delegate.getActions() as IAction[]); },
			onDidShowContextMenu: (() => ({ dispose() { } })),
			onDidHideContextMenu: (() => ({ dispose() { } })),
		} as unknown as IContextMenuService);
	});

	function openColumn(): ClaudeAgentsColumn {
		const host = document.createElement('div');
		document.body.appendChild(host);
		store.add(toDisposable(() => host.remove()));
		const column = store.add(instantiationService.createInstance(ClaudeAgentsColumn, host, () => calls.push('opened')));
		column.setVisible(true);
		column.layout(600);
		return column;
	}

	function rows(column: ClaudeAgentsColumn): string[][] {
		return [...column.element.querySelectorAll('.claude-agents-section')].map(section => [
			section.querySelector('.claude-agents-section-title')!.textContent!,
			...[...section.querySelectorAll<HTMLElement>('.claude-agents-row')].map(row => [
				row.querySelector('.claude-agents-title')?.textContent,
				row.querySelector('.claude-agents-subtitle')?.textContent ?? '',
				row.dataset.state,
				row.classList.contains('is-selected') ? 'selected' : '',
				row.querySelector('.claude-agents-age') ? 'age' : '',
				[...row.parentElement!.querySelectorAll('.claude-agents-action')].map(action => action.getAttribute('aria-label')).join('+'),
			].filter(Boolean).join(' | ')),
		]);
	}

	test('lists local and background agents by day, says what each is doing, and shows the runtime in the footer', () => {
		const column = openColumn();
		assert.deepStrictEqual({
			head: [...column.element.querySelectorAll('.claude-agents-head-row .claude-agents-title')].map(row => row.textContent),
			search: column.element.querySelector('input')?.placeholder,
			rows: rows(column),
			footer: [column.element.querySelector('.claude-agents-name')?.textContent, column.element.querySelector('.claude-agents-plan')?.textContent],
		}, {
			head: ['New Agent', 'Customize'],
			search: 'Search agents...',
			rows: [
				['Today',
					'fix-login | Editing login.ts | running | selected | Stop+More Actions',
					'add-tests | Edited 1 file | done | age | Rename+More Actions',
					'nightly-refactor | +40 −12 · 3 files | done | age | Rename+More Actions'],
				['Yesterday',
					'old-spike | Failed | failed | age | Rename+More Actions'],
			],
			footer: ['Claude Code 2.1.281', 'Claude account'],
		});
	});

	test('search, the filter menu and a collapsed day narrow the list; the runtime line follows sign-in', () => {
		const column = openColumn();
		const input = column.element.querySelector('input')!;
		input.value = 'TESTS';
		input.dispatchEvent(new Event('input'));
		const searched = rows(column);
		input.value = '';
		input.dispatchEvent(new Event('input'));
		column.element.querySelector<HTMLButtonElement>('.claude-agents-filter')!.click();
		const filterLabels = menus[0].map(action => `${action.label}${action.checked ? ' ✓' : ''}`);
		menus[0].find(action => action.label === 'Background Agents')!.run();
		const background = rows(column);
		menus.length = 0;
		column.element.querySelector<HTMLButtonElement>('.claude-agents-filter')!.click();
		menus[0].find(action => action.label === 'All Agents')!.run();
		column.element.querySelector<HTMLButtonElement>('.claude-agents-section-title')!.click();
		const collapsed = rows(column);
		setupService.set({ installed: true, authenticated: false });
		assert.deepStrictEqual({ searched, filterLabels, background, collapsed, plan: column.element.querySelector('.claude-agents-plan')?.textContent }, {
			searched: [['Today', 'add-tests | Edited 1 file | done | age | Rename+More Actions']],
			filterLabels: ['All Agents ✓', 'Local Agents', 'Background Agents', 'Cloud Agents'],
			background: [['Today', 'nightly-refactor | +40 −12 · 3 files | done | age | Rename+More Actions']],
			collapsed: [['Today'], ['Yesterday', 'old-spike | Failed | failed | age | Rename+More Actions']],
			plan: 'Not signed in',
		});
	});

	test('setFilter narrows the list like the filter menu, so More > Background Agents can open it filtered (issue 334)', () => {
		const column = openColumn();
		column.setFilter('background');
		const background = { rows: rows(column), active: column.element.querySelector('.claude-agents-filter')!.classList.contains('is-active') };
		column.element.querySelector<HTMLButtonElement>('.claude-agents-filter')!.click();
		assert.deepStrictEqual({ background, checked: menus[0].filter(action => action.checked).map(action => action.label) }, {
			background: { rows: [['Today', 'nightly-refactor | +40 −12 · 3 files | done | age | Rename+More Actions']], active: true },
			checked: ['Background Agents'],
		});
	});

	test('issue 532: cloud sessions Klawly recorded list with the cloud icon, open on claude.ai, and only the Cloud filter keeps them', () => {
		const now = Date.now();
		cloudSessions = [
			{ id: 'session_abc', sessionId: 'session_abc', title: 'also update the docs', startedAt: now - 1500, updatedAt: now - 1500 },
			{ id: 'start-a1b2c3d4', title: 'Fix the flaky test', startedAt: now - 2500, updatedAt: now - 2500 },
		];
		const column = openColumn();
		column.setFilter('cloud');
		const cloud = rows(column);
		const icons = [...column.element.querySelectorAll('.claude-agents-row.is-cloud .claude-agents-state')].map(icon => icon.classList.contains('codicon-cloud'));
		column.element.querySelector<HTMLButtonElement>('.claude-agents-row.is-cloud')!.click();
		column.element.querySelector<HTMLButtonElement>('.claude-agents-row.is-cloud')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
		const menu = menus.at(-1)!.map(action => `${action.label}${action.enabled ? '' : ' (disabled)'}`);
		menus.at(-1)!.find(action => action.label === 'Bring Back Here...')!.run();
		column.element.querySelectorAll<HTMLButtonElement>('.claude-agents-row.is-cloud')[1].parentElement!.querySelector<HTMLElement>('.claude-agents-action')!.click();
		column.setFilter('local');
		assert.deepStrictEqual({ cloud, icons, menu, calls, local: rows(column).flat().some(row => row.includes('docs')) }, {
			cloud: [['Today',
				'also update the docs | Cloud session session_abc | idle | age | Remove from List+More Actions',
				'Fix the flaky test | Cloud session, started in a terminal | idle | age | Remove from List+More Actions']],
			icons: [true, true],
			menu: ['Open on claude.ai', 'Bring Back Here...', 'Send Message...', 'Remove from List'],
			calls: ['open https://claude.ai/code/session_abc', 'klawly.cloud.bringBack session_abc', 'forget start-a1b2c3d4'],
			local: false,
		});
	});

	test('issue 426: the runs an automation started sit under its name and trigger icon, after the days', async () => {
		const column = openColumn();
		automationOf.set('automation-nightly-1a2b3c4d', { key: 'workspace:nightly', scope: 'workspace', id: 'nightly', name: 'Nightly refactor', trigger: { type: 'schedule', cron: '0 2 * * *' } } as ClaudeAutomationEntry);
		automationChanges.fire();
		await new Promise<void>(resolve => getWindow(column.element).requestAnimationFrame(() => setTimeout(resolve, 0)));
		const titles = column.element.querySelectorAll('.claude-agents-section-title');
		assert.deepStrictEqual({ rows: rows(column), icons: [...titles].map(title => !!title.querySelector('.claude-agents-section-icon.codicon-watch')) }, {
			rows: [
				['Today',
					'fix-login | Editing login.ts | running | selected | Stop+More Actions',
					'add-tests | Edited 1 file | done | age | Rename+More Actions'],
				['Yesterday',
					'old-spike | Failed | failed | age | Rename+More Actions'],
				['Nightly refactor',
					'nightly-refactor | +40 −12 · 3 files | done | age | Rename+More Actions'],
			],
			icons: [false, false, true],
		});
	});

	test('a row opens its session, Stop stops a live one, rows follow the turn as it streams, and the head rows run their commands', async () => {
		const column = openColumn();
		const row = (id: string) => column.element.querySelector<HTMLButtonElement>(`.claude-agents-row[data-session-id="${id}"]`)!;
		row('add-tests').click();
		row('fix-login').parentElement!.querySelector<HTMLButtonElement>('.claude-agents-action')!.click();
		turns.set('fix-login', [turn('running', { permissions: [{ state: 'pending' } as TurnViewModel['permissions'][number]] })]);
		viewState.fire({ sessionId: 'fix-login' });
		viewState.fire({ sessionId: 'fix-login' });
		await new Promise<void>(resolve => getWindow(column.element).requestAnimationFrame(() => setTimeout(resolve, 0)));
		const heads = [...column.element.querySelectorAll<HTMLButtonElement>('.claude-agents-head-row')];
		heads.forEach(head => head.click());
		column.element.querySelector<HTMLButtonElement>('.claude-agents-account')!.click();
		assert.deepStrictEqual({ calls, waiting: rows(column)[0][1], selected: row('add-tests').getAttribute('aria-current') }, {
			calls: ['select add-tests', 'resume add-tests', 'opened', 'stop fix-login', CLAUDE_NEW_SESSION_COMMAND_ID, `${CLAUDE_OPEN_SETTINGS_COMMAND_ID} customize`, CLAUDE_SHOW_STATUS_COMMAND_ID],
			waiting: 'fix-login | Waiting for your approval | waiting | Stop+More Actions',
			selected: 'true',
		});
	});

	test('a row shows the pull request its session created, colored by its state once GitHub answers (issue 430)', async () => {
		// The reducer decides which pull request a session owns: one it only mentioned never gets a badge.
		const detected = (sessionId: string, number: number, createdBySession: boolean): NormalizedClaudeEvent => ({
			type: 'github.referenceDetected',
			sessionId,
			reference: { url: `https://github.com/acme/app/pull/${number}`, owner: 'acme', repo: 'app', number, kind: 'pullRequest', createdBySession },
		});
		pullRequests.set('add-tests', reduceAgentState(EMPTY_AGENT_VIEW_STATE, detected('add-tests', 12, true)).pullRequest);
		pullRequests.set('nightly-refactor', reduceAgentState(EMPTY_AGENT_VIEW_STATE, detected('nightly-refactor', 13, false)).pullRequest);
		const column = openColumn();
		const badges = () => [...column.element.querySelectorAll<HTMLElement>('.claude-agents-row')].flatMap(row => {
			const badge = row.querySelector<HTMLElement>('.claude-pr-pill');
			return badge ? [`${row.dataset.sessionId} ${badge.textContent} ${badge.dataset.state || 'unknown'} | ${row.getAttribute('aria-label')}`] : [];
		});
		const before = badges();
		gitHub.set('add-tests', 'https://github.com/acme/app/pull/12', { status: 'loaded', details: { kind: 'pullRequest', title: 'Add tests', body: '', state: 'merged', draft: false, author: 'octo', headRef: 'tests', baseRef: 'main' } });
		await new Promise<void>(resolve => getWindow(column.element).requestAnimationFrame(() => setTimeout(resolve, 0)));
		assert.deepStrictEqual({ before, after: badges() }, {
			before: ['add-tests #12 unknown | add-tests, Edited 1 file, done, Pull request #12 in acme/app, opened in this chat'],
			after: ['add-tests #12 merged | add-tests, Edited 1 file, done, Pull request #12 in acme/app, Merged, opened in this chat'],
		});
	});

	test('a row shows the goal its chat runs as a pill that follows the goal (issue 687)', async () => {
		const column = openColumn();
		const pills = () => [...column.element.querySelectorAll<HTMLElement>('.claude-agents-row')].flatMap(row => {
			const pill = row.querySelector<HTMLElement>('.claude-goal-pill');
			return pill ? [`${row.dataset.sessionId} ${pill.textContent} | ${row.getAttribute('aria-label')}`] : [];
		});
		const before = pills();
		goals.set('add-tests', { goal: { kind: 'goal', outcome: 'tests pass' }, status: 'running', turn: 3, maxTurns: 10, spentUsd: 0 });
		goalChanges.fire('add-tests');
		await new Promise<void>(resolve => getWindow(column.element).requestAnimationFrame(() => setTimeout(resolve, 0)));
		assert.deepStrictEqual({ before, after: pills() }, {
			before: [],
			after: ['add-tests Goal 3/10 | add-tests, Edited 1 file, done, Goal 3/10'],
		});
	});

	test('issue 448: sessions another computer synced list with that computer\'s badge, not under Local Agents', async () => {
		imported = [{ machine: 'Desktop', id: 'Desktop/proj/abc', title: 'port the parser', updatedAt: Date.now() - 500 }];
		const column = openColumn();
		await Promise.resolve();
		await new Promise<void>(resolve => getWindow(column.element).requestAnimationFrame(() => setTimeout(resolve, 0)));
		const synced = () => [...column.element.querySelectorAll<HTMLElement>('.claude-agents-row.is-imported')].map(row => [row.querySelector('.claude-agents-title')?.textContent, row.querySelector('.claude-agents-machine-name')?.textContent]);
		assert.deepStrictEqual(synced(), [['port the parser', 'Desktop']]);
		imported = [];
		syncChanges.fire();
		await Promise.resolve();
		await new Promise<void>(resolve => getWindow(column.element).requestAnimationFrame(() => setTimeout(resolve, 0)));
		assert.deepStrictEqual(synced(), []);
	});

	function todayIds(column: ClaudeAgentsColumn): string[] {
		return [...column.element.querySelectorAll<HTMLElement>('.claude-agents-section')[0].querySelectorAll<HTMLElement>('.claude-agents-row')].map(row => row.dataset.sessionId!);
	}

	function altArrow(column: ClaudeAgentsColumn, id: string, key: 'ArrowUp' | 'ArrowDown'): void {
		column.element.querySelector<HTMLElement>(`.claude-agents-row[data-session-id="${id}"]`)!.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true }));
	}

	test('issue 977: Alt+Down and Alt+Up move a row one place, and the order is remembered for the workspace', () => {
		const column = openColumn();
		const start = todayIds(column);
		altArrow(column, start[0], 'ArrowDown');
		const down = todayIds(column);
		altArrow(column, start[0], 'ArrowUp');
		altArrow(column, start[0], 'ArrowUp');
		const saved = JSON.parse(instantiationService.get(IStorageService).get('claude.agentsOrder', StorageScope.WORKSPACE)!);
		const reopened = todayIds(openColumn());
		assert.deepStrictEqual({ down, up: todayIds(column), saved, reopened, focused: document.activeElement === column.element.querySelector(`.claude-agents-row[data-session-id="${start[0]}"]`) }, {
			down: [start[1], start[0], ...start.slice(2)],
			up: [start[0], ...start.slice(1)],
			saved: start,
			reopened: start,
			focused: true,
		});
	});

	test('issue 977: dropping a row on another row of its group moves it there; a drop from outside the list does nothing', () => {
		const column = openColumn();
		const start = todayIds(column);
		const row = (id: string) => column.element.querySelector<HTMLElement>(`.claude-agents-row[data-session-id="${id}"]`)!;
		const transfer = new DataTransfer();
		row(start[2]).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
		const target = row(start[0]).parentElement!;
		target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: -1 }));
		const marked = target.classList.contains('drop-before');
		target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: -1 }));
		const dropped = todayIds(column);
		const foreign = new DataTransfer();
		row(dropped[1]).parentElement!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: foreign, clientY: -1 }));
		assert.deepStrictEqual({ marked, dropped, afterForeignDrop: todayIds(column) }, {
			marked: true,
			dropped: [start[2], start[0], start[1]],
			afterForeignDrop: [start[2], start[0], start[1]],
		});
	});
});
