/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudePermissionPreset } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { AgentMode } from '../../../../../platform/claude/common/claudeContext.js';
import { PermissionOutcome, PermissionRequest } from '../../../../../platform/claude/common/claudeProtocol.js';
import { ClaudeSessionPermissions, NO_SESSION_PERMISSIONS, withClaudePermissionLevel } from '../../../../../platform/claude/common/claudeSessionPermissions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextViewDelegate, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { ClaudeAgentSessionChange, IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { AgentViewState, EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../../../services/claude/common/claudeAgentState.js';
import { ClaudePermissionCardChoice, IClaudePermissionService } from '../../../../services/claude/common/claudePermissionService.js';
import { IClaudeReviewService } from '../../../../services/claude/common/claudeReview.js';
import { IClaudeMakerService } from '../../browser/claudeMakerService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ClaudeModeMenu } from '../../browser/chat/claudeModeMenu.js';
import { ClaudeSessionSwitchBadges } from '../../browser/chat/claudeSessionSwitches.js';
import { ClaudeTimelineCallbacks, ClaudeTimelineRenderer } from '../../browser/chat/claudeTimelineRenderer.js';
import { moveClaudeTestFocus } from './claudeFocusTestUtils.js';
import { silentTendService } from './claudeGitHubTestUtils.js';
import { IClaudeTendPullRequestService } from '../../browser/chat/claudeTendPullRequest.js';

const ROOT = isWindows ? 'C:\\testWorkspace' : '/testWorkspace';
const SUB = isWindows ? `${ROOT}\\src\\app` : `${ROOT}/src/app`;

const COMMAND: PermissionRequest = {
	id: 'perm-cmd', toolName: 'Bash', input: { command: 'npm test' }, category: 'shell', command: 'npm test', cwd: SUB,
	risk: 'mutating', why: 'Claude wants to run a command.', reason: 'Run the tests', canRemember: true,
	mode: 'agent', canAllowAllCommands: true, workspaceTrusted: true,
};

function stateWith(requests: readonly PermissionRequest[], outcomes: readonly PermissionOutcome[] = [], turns = 1): AgentViewState {
	let state = EMPTY_AGENT_VIEW_STATE;
	for (let index = 1; index <= turns; index++) {
		state = reduceAgentState(state, { type: 'turn.submitted', turnId: `turn-${index}`, text: 'Go', sent: { compiled: 'Go', mode: 'ask' } });
		if (index < turns) {
			for (const outcome of outcomes) {
				state = reduceAgentState(state, { type: 'permission.resolved', sessionId: 's', outcome: { ...outcome, requestId: `${outcome.requestId}-old` } });
			}
			state = reduceAgentState(state, { type: 'session.completed', sessionId: 's' });
		}
	}
	for (const request of requests) {
		state = reduceAgentState(state, { type: 'permission.requested', sessionId: 's', request });
	}
	for (const outcome of outcomes) {
		state = reduceAgentState(state, { type: 'permission.resolved', sessionId: 's', outcome });
	}
	return state;
}

function key(target: Element, init: KeyboardEventInit): KeyboardEvent {
	const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(event);
	return event;
}

/**
 * Phase 27 gate, pane level: the permission card's buttons and keys, the
 * blocked-by-mode record, the quiet auto-approval line, the session switch
 * badges and the mode menu.
 */
suite('Claude permission card (Phase 27)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiationService: TestInstantiationService;
	let root: HTMLElement;
	let answers: { requestId: string; choice: ClaudePermissionCardChoice }[];
	let retried: string[];
	let respond: (requestId: string, choice: ClaudePermissionCardChoice) => Promise<void>;
	let commands: unknown[][];

	setup(() => {
		instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IClaudeTendPullRequestService, silentTendService());
		commands = [];
		instantiationService.stub(ICommandService, { executeCommand: async (...args: unknown[]) => { commands.push(args); } } as unknown as ICommandService);
		root = document.createElement('div');
		root.classList.add('claude-pane');
		document.body.appendChild(root);
		store.add({ dispose: () => root.remove() });
		answers = [];
		retried = [];
		respond = async (requestId, choice) => { answers.push({ requestId, choice }); };
	});

	function render(state: AgentViewState): ClaudeTimelineRenderer {
		const callbacks: ClaudeTimelineCallbacks = {
			retry: () => undefined,
			build: async () => undefined,
			respondPermission: (requestId, choice) => respond(requestId, choice),
			switchToAgentAndRetry: async turnId => { retried.push(turnId); },
			openSubagent: () => undefined,
			stopSubagent: () => undefined,
			copyCommand: () => undefined,
			openInTerminal: () => undefined,
			rerunCommand: () => undefined,
			openCommandLog: () => undefined,
		};
		const timeline = store.add(instantiationService.createInstance(ClaudeTimelineRenderer, root, callbacks));
		timeline.render(state);
		return timeline;
	}

	function card(): HTMLElement {
		const element = root.querySelector<HTMLElement>('.claude-permission');
		assert.ok(element);
		return element;
	}

	function buttons(): HTMLButtonElement[] {
		return [...card().querySelectorAll<HTMLButtonElement>('button')];
	}

	function labelled(label: string): HTMLButtonElement {
		const found = buttons().find(button => button.querySelector('.label')?.textContent === label);
		assert.ok(found, label);
		return found;
	}

	test('a command card shows the command, a short reason, the relative folder, and the buttons in order', () => {
		render(stateWith([COMMAND]));
		assert.deepStrictEqual({
			title: card().querySelector('.claude-permission-title')?.textContent,
			tool: card().querySelector('.claude-permission-tool'),
			command: card().querySelector('.claude-permission-cmd')?.textContent,
			why: card().querySelector('.claude-permission-why')?.textContent,
			meta: [...card().querySelectorAll('dl.claude-permission-meta dt, dl.claude-permission-meta dd')].map(cell => cell.textContent),
			buttons: buttons().map(button => [button.querySelector('.label')?.textContent, button.querySelector('.claude-kbd')?.textContent ?? '', button.disabled]),
			focused: document.activeElement === labelled('Allow Once'),
			variants: [...card().querySelectorAll<HTMLButtonElement>('.claude-permission-actions button.claude-btn')].map(button => ['is-primary', 'is-secondary', 'is-ghost', 'is-danger'].filter(variant => button.classList.contains(variant)).join(' ')),
		}, {
			title: 'Run this command?',
			tool: null,
			command: 'npm test',
			why: 'Commands ask in Agent mode.',
			meta: ['Directory', 'src/app', 'Reason', 'Run the tests'],
			buttons: [
				['Allow Once', '\u21B5', false],
				['Allow for Session', '', false],
				['Allow All Commands', 'AltA', false],
				['Deny', 'esc', false],
				['Change your permission level in Settings', '', false],
			],
			focused: true,
			variants: ['is-primary', 'is-secondary', 'is-secondary', 'is-ghost'],
		});
	});

	test('Enter allows once, Alt+A allows all commands, Escape denies, and each button sends its choice', async () => {
		const state = stateWith([COMMAND]);
		const pressed: ClaudePermissionCardChoice[] = [];
		const keys: KeyboardEventInit[] = [{ key: 'Enter' }, { key: 'a', code: 'KeyA', altKey: true }, { key: 'Escape' }];
		for (const init of keys) {
			root.textContent = '';
			const timeline = render(state);
			labelled('Allow Once').focus();
			const event = key(card(), init);
			assert.strictEqual(event.defaultPrevented, true, JSON.stringify(init));
			// The card is locked while the answer is on its way.
			assert.ok(buttons().filter(button => button.dataset.choice !== undefined).every(button => button.disabled));
			timeline.dispose();
		}
		pressed.push(...answers.map(answer => answer.choice));
		for (const label of ['Allow Once', 'Allow for Session', 'Allow All Commands', 'Deny']) {
			root.textContent = '';
			const timeline = render(state);
			labelled(label).click();
			timeline.dispose();
		}
		assert.deepStrictEqual([pressed, answers.slice(3).map(answer => answer.choice)], [
			['allow-once', 'allow-all-commands', 'deny'],
			['allow-once', 'allow-session', 'allow-all-commands', 'deny'],
		]);
	});

	test('Enter on another button presses that button, and Ctrl+Enter never approves a risky card', async () => {
		render(stateWith([COMMAND]));
		const session = labelled('Allow for Session');
		session.focus();
		assert.strictEqual(key(session, { key: 'Enter' }).defaultPrevented, false);
		root.textContent = '';
		render(stateWith([{ ...COMMAND, id: 'perm-rm', command: 'rm -rf dist', risk: 'destructive', canRemember: false }]));
		assert.strictEqual(document.activeElement, labelled('Deny'));
		assert.strictEqual(key(card(), { key: 'Enter', ctrlKey: true }).defaultPrevented, false);
		assert.deepStrictEqual(answers, []);
		// The destructive card still offers Allow All Commands, and its hover says destructive commands keep asking.
		assert.ok(labelled('Allow All Commands'));
	});

	test('every card points to the permission level in Settings; untrusted and credential cards offer no switch (issue 453)', () => {
		render(stateWith([{ ...COMMAND, canAllowAllCommands: false, workspaceTrusted: false, canRemember: false }]));
		const untrusted = {
			labels: buttons().map(button => button.querySelector('.label')?.textContent),
			hint: card().querySelector('.claude-permission-hint')?.textContent,
			why: card().querySelector('.claude-permission-why')?.textContent,
		};
		labelled('Change your permission level in Settings').click();

		root.textContent = '';
		render(stateWith([{ ...COMMAND, id: 'perm-env', toolName: 'Read', category: 'read', command: undefined, targetPath: `${ROOT}/.env`, risk: 'credentials', canAllowAllCommands: false, canRemember: false, why: 'This file holds credentials. The IDE never approves it automatically.' }]));
		assert.deepStrictEqual({
			untrusted,
			credentials: [buttons().map(button => button.querySelector('.label')?.textContent), card().querySelector('.claude-permission-tool')?.textContent, card().classList.contains('is-danger')],
			commands,
			answers,
		}, {
			untrusted: {
				labels: ['Allow Once', 'Deny', 'Change your permission level in Settings'],
				hint: 'Tired of approving?',
				why: 'This workspace is not trusted, so every change asks once.',
			},
			credentials: [['Allow Once', 'Deny', 'Change your permission level in Settings'], 'Read', true],
			commands: [['claude.openSettings', 'agents']],
			answers: [],
		});
	});

	test('a failed answer is reported and unlocks the card', async () => {
		respond = async () => { throw new Error('That request was already answered or has ended.'); };
		render(stateWith([COMMAND]));
		labelled('Allow Once').click();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.ok(buttons().every(button => !button.disabled));
	});

	test('a write the mode blocked offers Switch to Agent and Retry on the newest turn only', () => {
		const blocked: PermissionOutcome = { requestId: 'w1', toolName: 'Write', decision: 'deny', source: 'policy', subject: `${ROOT}/a.ts`, message: 'Ask mode never changes files. Switch to Agent to allow changes.', blockedByMode: 'ask' };
		const policy: PermissionOutcome = { requestId: 'p1', toolName: 'Bash', decision: 'deny', source: 'policy', subject: 'rm -rf dist', message: 'Destructive commands are turned off.' };
		render(stateWith([], [blocked, policy], 2));
		const banners = [...root.querySelectorAll('.claude-banner.is-info')];
		assert.deepStrictEqual(banners.map(banner => [banner.querySelector('.title')?.textContent, !!banner.querySelector('button.claude-switch-retry')]), [
			['Write blocked: Ask mode does not change this file', false],
			['Bash blocked', false],
			['Write blocked: Ask mode does not change this file', true],
			['Bash blocked', false],
		]);
		root.querySelector<HTMLButtonElement>('button.claude-switch-retry')!.click();
		assert.deepStrictEqual(retried, ['turn-2']);
	});

	test('calls an approval or a switch let through make one quiet line per turn, not a row each', () => {
		const outcomes: PermissionOutcome[] = [
			{ requestId: 'g1', toolName: 'Bash', decision: 'allow', scope: 'session', source: 'grant', subject: 'npm test' },
			{ requestId: 'g2', toolName: 'Bash', decision: 'allow', scope: 'session', source: 'allow-all-commands', subject: 'npm run build' },
			{ requestId: 'g3', toolName: 'Write', decision: 'allow', scope: 'session', source: 'allow-everything', subject: '/etc/x' },
			{ requestId: 'u1', toolName: 'Bash', decision: 'allow', scope: 'once', source: 'user', subject: 'npm ci' },
		];
		render(stateWith([], outcomes));
		const auto = root.querySelectorAll('details.claude-permission-auto');
		assert.deepStrictEqual({
			lines: auto.length,
			summary: auto[0]?.querySelector('summary')?.textContent,
			open: (auto[0] as HTMLDetailsElement | undefined)?.open,
			items: [...root.querySelectorAll('details.claude-permission-auto li')].map(item => item.textContent),
			records: [...root.querySelectorAll('.claude-permission-record')].map(record => record.textContent),
		}, {
			lines: 1,
			summary: '3 calls ran without asking',
			open: false,
			items: ['npm testallowed by earlier approval', 'npm run buildallowed by Allow All Commands', '/etc/xallowed by Allow Everything'],
			records: ['npm ciallowed once'],
		});
	});
});

suite('Claude session switch badges and mode menu (Phase 27)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(initial: ClaudeSessionPermissions, trusted = true, level: ClaudePermissionPreset = 'strict', configuration?: IConfigurationService, unaskedBlocked = false) {
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IClaudeTendPullRequestService, silentTendService());
		if (configuration) {
			instantiationService.stub(IConfigurationService, configuration);
		}
		const commands: unknown[][] = [];
		instantiationService.stub(ICommandService, { executeCommand: async (...args: unknown[]) => { commands.push(args); } } as unknown as ICommandService);
		const changes = store.add(new Emitter<ClaudeAgentSessionChange>());
		let permissions = initial;
		const calls: string[] = [];
		const session = { id: 'pane-1', mode: 'agent' as AgentMode };
		instantiationService.stub(IClaudeAgentService, {
			onDidChangeSession: changes.event,
			getCurrentSession: () => session,
			isUnaskedBlocked: () => unaskedBlocked,
		} as unknown as IClaudeAgentService);
		const update = (next: ClaudeSessionPermissions) => {
			permissions = next;
			changes.fire({ reason: 'permissions', session: undefined, sessions: [] });
		};
		instantiationService.stub(IClaudePermissionService, {
			getSessionPermissions: () => permissions,
			getPermissionLevel: () => level,
			setAllowAllCommands: async (_id: string, on: boolean) => { calls.push(`commands ${on}`); update({ ...permissions, allowAllCommands: on }); },
		} as unknown as IClaudePermissionService);
		instantiationService.stub(IWorkspaceTrustManagementService, { isWorkspaceTrusted: () => trusted, onDidChangeTrust: Event.None } as unknown as IWorkspaceTrustManagementService);
		const autoKeepChanges = store.add(new Emitter<{ readonly sessionId: string }>());
		const autoKeep = new Map<string, boolean>();
		instantiationService.stub(IClaudeMakerService, { onDidChange: Event.None, role: 'user', previewAsUser: false, active: false, setPreviewAsUser: () => { } } as unknown as IClaudeMakerService);
		instantiationService.stub(IClaudeReviewService, {
			onDidChangeAutoKeep: autoKeepChanges.event,
			isAutoKeep: (id: string) => autoKeep.get(id) === true,
			setAutoKeep: (id: string, on: boolean | undefined) => { calls.push(`autoKeep ${on}`); autoKeep.set(id, on === true); autoKeepChanges.fire({ sessionId: id }); },
		} as unknown as IClaudeReviewService);
		const pane = document.createElement('div');
		pane.classList.add('claude-pane');
		const toolbar = document.createElement('div');
		const pill = document.createElement('button');
		const container = document.createElement('span');
		toolbar.append(pill, container);
		pane.appendChild(toolbar);
		document.body.appendChild(pane);
		store.add({ dispose: () => pane.remove() });
		const errors: unknown[] = [];
		const badges = store.add(instantiationService.createInstance(ClaudeSessionSwitchBadges, container, (error: unknown) => errors.push(error)));
		const menuHost = document.createElement('div');
		pane.appendChild(menuHost);
		const delegates: IContextViewDelegate[] = [];
		instantiationService.stub(IContextViewService, {
			showContextView: (delegate: IContextViewDelegate, owner?: HTMLElement) => {
				assert.strictEqual(owner, undefined);
				delegates.push(delegate);
				const rendered = delegate.render(menuHost);
				return { close: () => { rendered?.dispose(); menuHost.textContent = ''; delegate.onHide?.(); } };
			},
		} as unknown as IContextViewService);
		const menu = store.add(instantiationService.createInstance(ClaudeModeMenu));
		return { container, badges, menu, menuHost, pill, calls, errors, session, delegates, commands };
	}

	function chips(container: HTMLElement): (string | null | undefined)[][] {
		return [...container.querySelectorAll('button.claude-session-switch')].map(chip => [chip.className.replace('claude-session-switch ', ''), chip.querySelector('.label')?.textContent]);
	}

	test('the Allow Everything badge opens Settings; the Allow All Commands badge turns it off in one click', async () => {
		const { container, calls, commands } = setup({ allowAllCommands: true, allowEverything: true, allowCredentials: true }, true, 'allowEverything');
		// Allow Everything covers every command, so only its badge shows while it is on.
		const everything = chips(container);
		container.querySelector<HTMLButtonElement>('.is-everything')!.click();
		await Promise.resolve();
		const except = setup({ allowAllCommands: false, allowEverything: true }, true, 'allowEverythingExceptCredentials');
		const bypass = setup(withClaudePermissionLevel(NO_SESSION_PERMISSIONS, 'allowEverything'), true, 'allowEverything');
		const commandsOnly = setup({ allowAllCommands: true, allowEverything: false });
		const before = chips(commandsOnly.container);
		commandsOnly.container.querySelector<HTMLButtonElement>('.is-commands')!.click();
		await Promise.resolve();
		assert.deepStrictEqual({
			everything,
			closeIcon: !!container.querySelector('.is-everything .codicon-close'),
			commands,
			except: chips(except.container),
			bypass: chips(bypass.container),
			before,
			after: [commandsOnly.container.hidden, chips(commandsOnly.container), [...calls, ...commandsOnly.calls]],
		}, {
			everything: [['is-everything', 'Allow Everything']],
			closeIcon: false,
			commands: [['claude.openSettings', 'agents']],
			except: [['is-everything', 'Allow Everything Except Credentials']],
			// Issue 694: the confirmed level is Claude Code's bypass permissions mode and says so (DL-85).
			bypass: [['is-everything is-bypass', 'Allow Everything · Bypass']],
			before: [['is-commands', 'All commands allowed']],
			after: [true, [], ['commands false']],
		});
	});

	test('the mode menu shows the permission level for every session and opens Settings to change it (issue 453)', async () => {
		const row = (level: ClaudePermissionPreset, trusted = true, mode: AgentMode = 'agent', unaskedBlocked = false) => {
			const fixture = setup(NO_SESSION_PERMISSIONS, trusted, level, undefined, unaskedBlocked);
			fixture.menu.show(fixture.pill, fixture.badges.modeMenuModel(fixture.session.id, mode, () => undefined));
			const element = fixture.menuHost.querySelector<HTMLButtonElement>('[data-level]')!;
			return { fixture, shown: [element.dataset.level, element.querySelector('.name')?.textContent, element.querySelector('.desc')?.textContent, element.querySelector('.detail')?.textContent, element.classList.contains('is-everything'), element.classList.contains('is-bypass')] };
		};
		const strict = row('strict');
		const header = strict.fixture.menuHost.querySelector('.claude-menu-group')?.textContent;
		strict.fixture.menuHost.querySelector<HTMLButtonElement>('[data-level]')!.click();
		await Promise.resolve();
		assert.deepStrictEqual({
			header,
			rows: [strict.shown, row('acceptEdits').shown, row('allowEverythingExceptCredentials').shown, row('allowEverything').shown, row('allowEverything', false).shown, row('allowEverything', true, 'plan').shown, row('allowEverything', true, 'agent', true).shown],
			commands: strict.fixture.commands,
			open: strict.fixture.menu.isOpen,
		}, {
			header: 'Permissions in Every Session',
			rows: [
				['strict', 'Strict', 'Ask before edits; refuse risky commands and network', 'Change in Settings', false, false],
				['acceptEdits', 'Accept Edits', 'Edit workspace files without asking', 'Change in Settings', false, false],
				['allowEverythingExceptCredentials', 'Allow Everything Except Credentials', 'No prompts except credentials; Klawly still checks each call', 'Change in Settings', true, false],
				['allowEverything', 'Allow Everything · Bypass', 'Like bypass permissions: in Agent, nothing is checked or asked', 'Change in Settings', true, true],
				['allowEverything', 'Allow Everything', 'Asks before edits until you trust this workspace', 'Change in Settings', true, false],
				['allowEverything', 'Allow Everything · Bypass', 'Bypass runs in Agent only; this mode keeps its limits', 'Change in Settings', true, true],
				['allowEverything', 'Allow Everything', 'Your organization turned off bypass permissions, so this asks before edits', 'Change in Settings', true, false],
			],
			commands: [['claude.openSettings', 'agents']],
			open: false,
		});
	});

	test('the mode menu closes when focus or a click goes outside it, and resets the pill', () => {
		const { badges, menu, menuHost, pill, session, delegates } = setup(NO_SESSION_PERMISSIONS);
		const outside = document.createElement('button');
		// The badge strip is hidden with no switch on, so the outside target sits beside the pill.
		pill.after(outside);
		const states: (string | null | boolean)[][] = [];
		menu.show(pill, badges.modeMenuModel(session.id, 'agent', () => undefined));
		menuHost.querySelector<HTMLButtonElement>('[data-mode]')!.focus();
		states.push([menu.isOpen, pill.getAttribute('aria-expanded')]);
		moveClaudeTestFocus(outside);
		states.push([menu.isOpen, pill.getAttribute('aria-expanded')]);
		menu.show(pill, badges.modeMenuModel(session.id, 'agent', () => undefined));
		const click = (target: HTMLElement) => {
			const event = new MouseEvent('click', { bubbles: true });
			target.dispatchEvent(event);
			delegates.at(-1)!.onDOMEvent?.(event, target);
		};
		click(menuHost.querySelector<HTMLElement>('.claude-mode-menu')!);
		states.push([menu.isOpen]);
		click(outside);
		states.push([menu.isOpen, pill.getAttribute('aria-expanded')]);
		assert.deepStrictEqual(states, [[true, 'true'], [false, 'false'], [true], [false, 'false']]);
	});
});
