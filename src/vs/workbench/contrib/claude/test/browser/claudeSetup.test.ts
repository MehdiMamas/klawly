/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeRuntimeState, IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { NormalizedClaudeEvent } from '../../../../../platform/claude/common/claudeProtocol.js';
import { CLAUDE_AGENT_ENABLED_SETTING } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { ConfigurationTarget, IConfigurationChangeEvent } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { AgentReducerEvent, EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../../../services/claude/common/claudeAgentState.js';
import { IStatusbarEntry, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ClaudeTimelineRenderer } from '../../browser/chat/claudeTimelineRenderer.js';
import { ClaudeSetupCardActions, renderClaudeSetupCard } from '../../browser/claudeSetupCard.js';
import { CLAUDE_STATUS_ENTRY_ID, ClaudeStatusBarContribution } from '../../browser/claudeStatus.js';
import { ClaudeImportOffer, ClaudeInstallProgress, claudeSetupPhase } from '../../common/claudeRuntimeStatus.js';
import { CLAUDE_SHOW_STATUS_COMMAND_ID } from '../../common/claudeViews.js';
import { registerClaudeChatDefaults } from '../../browser/claudeChatDefaults.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ThemeSettings } from '../../../../services/themes/common/workbenchThemeService.js';
import { USE_MODAL_EDITOR_SETTING } from '../../../../services/editor/common/editorService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { TestClaudeSetupService } from './claudeSetupTestUtils.js';
import { silentTendService } from './claudeGitHubTestUtils.js';
import { IClaudeTendPullRequestService } from '../../browser/chat/claudeTendPullRequest.js';

const missing: ClaudeRuntimeState = { installed: false, authenticated: false, error: 'Claude Code is not installed.' };
const signedOut: ClaudeRuntimeState = { installed: true, authenticated: false, version: '2.1.0', binaryPath: '/usr/local/bin/claude' };
const ready: ClaudeRuntimeState = { installed: true, authenticated: true, version: '2.1.0' };

suite('Claude setup card and status', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function card(runtime: ClaudeRuntimeState, waiting = false, importOffer?: ClaudeImportOffer, githubOffer = false, install?: ClaudeInstallProgress): { root: HTMLElement; first: HTMLButtonElement | undefined; calls: string[] } {
		const calls: string[] = [];
		const actions: ClaudeSetupCardActions = {
			install: () => calls.push('install'),
			installProgress: () => install,
			retryInstall: () => calls.push('retryInstall'),
			showInstaller: () => calls.push('showInstaller'),
			cancelInstall: () => calls.push('cancelInstall'),
			redetect: () => calls.push('redetect'),
			chooseLocation: () => calls.push('chooseLocation'),
			signIn: () => calls.push('signIn'),
			cancelSignIn: () => calls.push('cancelSignIn'),
			continueWithoutAI: () => calls.push('continueWithoutAI'),
			importSettings: () => calls.push('importSettings'),
			signInWithGitHub: githubOffer ? () => calls.push('signInWithGitHub') : undefined,
		};
		const root = document.createElement('div');
		const disposables = store.add(new DisposableStore());
		const first = renderClaudeSetupCard(root, claudeSetupPhase(runtime, waiting), runtime, actions, disposables, undefined, importOffer, install);
		return { root, first, calls };
	}

	function describe(root: HTMLElement) {
		const region = root.querySelector('[role="region"]');
		const labelledBy = region?.getAttribute('aria-labelledby');
		return {
			heading: labelledBy ? root.querySelector(`#${labelledBy}`)?.textContent : undefined,
			lede: root.querySelector('.claude-setup-lede')?.textContent ?? undefined,
			steps: [...root.querySelectorAll('li.claude-step')].map(step => step.textContent),
			stepsLabel: root.querySelector('ol.claude-steps')?.getAttribute('aria-label') ?? undefined,
			iconsHidden: [...root.querySelectorAll('.codicon')].every(icon => icon.getAttribute('aria-hidden') === 'true'),
			buttons: [...root.querySelectorAll('button')].map(button => `${button.type}:${button.textContent}`),
			status: root.querySelector('[role="status"]')?.textContent ?? undefined,
		};
	}

	test('runtime missing: labelled region, states in words, every action is a button', () => {
		const { root, first, calls } = card(missing);
		assert.deepStrictEqual(describe(root), {
			heading: 'Set up Claude to use the agent',
			lede: 'The agent runs on Claude Code, installed on this computer.',
			steps: [
				'Problem: Claude Code not foundInstall it, or point Klawly to an existing install. Installed it already? Choose its location, or restart Klawly.Claude Code is not installed.',
				'To do: Sign inUses the official Claude sign-in. It opens in a terminal and your browser; come back here when done.',
			],
			stepsLabel: 'Setup steps',
			iconsHidden: true,
			buttons: ['button:Install Claude Code', 'button:Detect Again', 'button:Choose Claude Code Location...', 'button:Continue without AI'],
			status: undefined,
		});
		assert.strictEqual(first?.textContent, 'Install Claude Code');
		for (const button of root.querySelectorAll('button')) {
			button.click();
		}
		assert.deepStrictEqual(calls, ['install', 'redetect', 'chooseLocation', 'continueWithoutAI']);
	});

	test('a running install shows a live line, its terminal and a way out; a stall or failure leads with Retry (issue 783)', () => {
		const startedAt = Date.now() - 72_000;
		const states: ClaudeInstallProgress[] = [
			{ state: 'running', startedAt },
			{ state: 'running', startedAt, downloadedBytes: 84 * 1024 * 1024 },
			{ state: 'stalled', startedAt, downloadedBytes: 84 * 1024 * 1024 },
			{ state: 'failed', startedAt, exitCode: 1 },
		];
		const result = states.map(install => {
			const { root, first, calls } = card(missing, false, undefined, false, install);
			for (const button of root.querySelectorAll('button')) {
				button.click();
			}
			return {
				step: describe(root).steps[0],
				spinning: !!root.querySelector('li.claude-step.is-busy > .codicon-loading.codicon-modifier-spin'),
				first: first?.textContent,
				calls,
			};
		});
		assert.deepStrictEqual(result, [{
			step: 'In progress: Installing Claude CodeThe installer downloads a few hundred MB and shows no progress of its own, so this can take several minutes on a slow connection. Klawly picks up Claude Code as soon as it is installed.Starting the download · 1:12',
			spinning: true,
			first: 'Show Installer',
			calls: ['showInstaller', 'cancelInstall'],
		}, {
			step: 'In progress: Installing Claude CodeThe installer downloads a few hundred MB and shows no progress of its own, so this can take several minutes on a slow connection. Klawly picks up Claude Code as soon as it is installed.Downloaded 84 MB · 1:12',
			spinning: true,
			first: 'Show Installer',
			calls: ['showInstaller', 'cancelInstall'],
		}, {
			step: 'Problem: The install is not making progressNothing has changed for 3 minutes. A slow or dropped connection is the usual cause. The installer keeps running; retry to start it again.Downloaded 84 MB · 1:12',
			spinning: false,
			first: 'Retry Install',
			calls: ['retryInstall', 'showInstaller', 'cancelInstall', 'chooseLocation', 'continueWithoutAI'],
		}, {
			step: 'Problem: Claude Code was not installedThe installer stopped with exit code 1. Its output stays in the Install Claude Code terminal. Check your internet connection, then retry.',
			spinning: false,
			first: 'Retry Install',
			calls: ['retryInstall', 'showInstaller', 'redetect', 'chooseLocation', 'continueWithoutAI'],
		}]);
	});

	test('signed out shows the found version and path; waiting announces itself', () => {
		const signed = card(signedOut);
		const described = describe(signed.root);
		assert.deepStrictEqual([described.heading, described.lede, described.steps[0], described.buttons], [
			'Sign in to Claude',
			'Your Claude account powers the agent and sets its usage limits.',
			'Done: Claude Code 2.1.0 found/usr/local/bin/claude',
			['button:Sign in to Claude', 'button:Detect Again', 'button:Continue without AI'],
		]);

		const waiting = card(signedOut, true);
		const waited = describe(waiting.root);
		assert.deepStrictEqual([waited.heading, waited.buttons, waited.iconsHidden, !!waited.status], [
			'Finish signing in to Claude',
			['button:Check Again', 'button:Cancel'],
			true,
			true,
		]);
		for (const button of waiting.root.querySelectorAll('button')) {
			button.click();
		}
		assert.deepStrictEqual(waiting.calls, ['redetect', 'cancelSignIn']);
	});

	test('setup card offers the optional import only when an editor was found and no import ran yet', () => {
		const offered = card(missing, false, { editors: ['VS Code', 'Cursor'], done: false });
		const imported = card(signedOut, false, { editors: ['VS Code'], done: true });
		const described = describe(offered.root);
		offered.root.querySelector<HTMLButtonElement>('button.claude-setup-link:last-of-type')?.click();
		assert.deepStrictEqual({
			lastStep: described.steps.at(-1),
			buttons: described.buttons,
			calls: offered.calls,
			importedStep: describe(imported.root).steps.at(-1),
			importedButtons: describe(imported.root).buttons,
		}, {
			lastStep: 'To do: Import from VS Code or Cursor (optional)Bring over your settings, keybindings, snippets and extensions. You see a preview before anything changes.',
			buttons: ['button:Install Claude Code', 'button:Detect Again', 'button:Choose Claude Code Location...', 'button:Import settings from VS Code or Cursor...', 'button:Continue without AI'],
			calls: ['importSettings'],
			importedStep: 'Done: Settings imported',
			importedButtons: ['button:Sign in to Claude', 'button:Detect Again', 'button:Continue without AI'],
		});
	});

	test('setup card offers the optional Sign in with GitHub while no GitHub account is the profile (issue 446)', () => {
		const offered = card(signedOut, false, undefined, true);
		offered.root.querySelector<HTMLButtonElement>('button.claude-setup-github')?.click();
		assert.deepStrictEqual({ buttons: describe(offered.root).buttons, calls: offered.calls, signedIn: describe(card(signedOut).root).buttons }, {
			buttons: ['button:Sign in to Claude', 'button:Detect Again', 'button:Sign in with GitHub (optional)', 'button:Continue without AI'],
			calls: ['signInWithGitHub'],
			signedIn: ['button:Sign in to Claude', 'button:Detect Again', 'button:Continue without AI'],
		});
	});

	test('status bar item has an accessible name, follows the state and hides when the agent is off', () => {
		const added: { id: string; entry: IStatusbarEntry; disposed: boolean }[] = [];
		const statusbar = {
			addEntry: (entry: IStatusbarEntry, id: string) => {
				const record = { id, entry, disposed: false };
				added.push(record);
				return { update: (next: IStatusbarEntry) => { record.entry = next; }, dispose: () => { record.disposed = true; } };
			},
		} as unknown as IStatusbarService;
		const agent = {
			onDidChangeViewState: Event.None,
			onDidChangeSession: Event.None,
			getSessions: () => [],
			getCurrentSession: () => undefined,
			getViewState: () => EMPTY_AGENT_VIEW_STATE,
		} as unknown as IClaudeAgentService;
		const configuration = new TestConfigurationService({ [CLAUDE_AGENT_ENABLED_SETTING]: true });
		const setup = store.add(new TestClaudeSetupService(undefined));
		const events = store.add(new Emitter<NormalizedClaudeEvent>());
		const runtime = { onDidEmitEvent: events.event, onDidChangeRuntimeState: Event.None } as unknown as IClaudeRuntimeService;
		const contribution = store.add(new ClaudeStatusBarContribution(statusbar, setup, agent, configuration, runtime, { hasFocus: false, onDidChangeFocus: Event.None } as Partial<IHostService> as IHostService));
		assert.ok(contribution);
		assert.strictEqual(added.length, 0, 'nothing is shown before the runtime answers');

		setup.set(ready);
		assert.deepStrictEqual(added.map(record => ({ id: record.id, text: record.entry.text, role: record.entry.role, command: record.entry.command, aria: record.entry.ariaLabel })), [{
			id: CLAUDE_STATUS_ENTRY_ID,
			text: '$(sparkle) Claude: Ready',
			role: 'button',
			command: CLAUDE_SHOW_STATUS_COMMAND_ID,
			aria: 'Claude: Ready. Claude Code is installed and signed in. Opens the Claude status menu.',
		}]);

		events.fire({ type: 'session.usageLimits', sessionId: 's1', windows: [{ kind: 'week', percent: 40 }, { kind: 'session', percent: 17.6 }] });
		assert.deepStrictEqual([added[0].entry.text, added[0].entry.tooltip, typeof added[0].entry.command === 'object' && added[0].entry.command.id], [
			'$(sparkle) Claude: Ready · 18%',
			'Claude Code is installed and signed in.\nSession usage: 18%.',
			CLAUDE_SHOW_STATUS_COMMAND_ID,
		]);

		setup.set(missing);
		assert.deepStrictEqual([added[0].entry.text, added[0].entry.kind], ['$(circle-slash) Claude: Runtime missing', 'error']);

		configuration.setUserConfiguration(CLAUDE_AGENT_ENABLED_SETTING, false);
		const change: IConfigurationChangeEvent = {
			source: ConfigurationTarget.USER,
			affectedKeys: new Set([CLAUDE_AGENT_ENABLED_SETTING]),
			change: { keys: [CLAUDE_AGENT_ENABLED_SETTING], overrides: [] },
			affectsConfiguration: key => key === CLAUDE_AGENT_ENABLED_SETTING,
		};
		configuration.onDidChangeConfigurationEmitter.fire(change);
		assert.strictEqual(added[0].disposed, true);
		configuration.onDidChangeConfigurationEmitter.dispose();
	});

	test('Copilot setup starts hidden, the Klawly themes, window layout, flat frame, quiet editor, editor font and visible view actions are the defaults, breadcrumbs show the last symbol and nothing opens at startup while product.json keeps defaultChatAgent', () => {
		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		const keys = [ChatAIDisabledSettingId, ThemeSettings.COLOR_THEME, ThemeSettings.PREFERRED_DARK_THEME, ThemeSettings.PREFERRED_LIGHT_THEME, 'workbench.startupEditor', 'workbench.activityBar.location', 'window.commandCenter', 'workbench.experimental.modernUI', 'workbench.layoutControl.type', 'window.title', 'editor.minimap.enabled', 'editor.guides.indentation', 'editor.renderWhitespace', 'editor.bracketPairColorization.enabled', 'editor.lightbulb.enabled', 'editor.roundedSelection', 'editor.fontFamily', 'editor.fontSize', 'editor.lineHeight', 'editor.fontLigatures', 'terminal.integrated.fontSize', 'workbench.view.alwaysShowHeaderActions', 'breadcrumbs.symbolPath', 'workbench.activityBar.autoHide'];
		const read = () => keys.map(key => registry.getConfigurationDefaultsOverrides().get(key)?.value);
		const before = read();
		const registration = registerClaudeChatDefaults();
		const during = read();
		registration.dispose();
		const unset = keys.map(() => undefined);
		assert.deepStrictEqual([before, during, read()], [
			unset,
			[true, 'Klawly Dark', 'Klawly Dark', 'Klawly Light', 'none', 'top', false, false, 'toggles', '${dirty}${rootName}${separator}${profileName}', false, false, 'none', false, 'off', false, '"Cascadia Code", Consolas, "SF Mono", Menlo, "Courier New", monospace', 13, 19, true, 13, true, 'last', true],
			unset,
		]);
	});

	test('a new terminal starts without the first-run hint and keeps command decorations out of the gutter', () => {
		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		const keys = ['terminal.integrated.initialHint', 'terminal.integrated.shellIntegration.decorationsEnabled'];
		const registration = registerClaudeChatDefaults();
		const during = keys.map(key => registry.getConfigurationDefaultsOverrides().get(key)?.value);
		registration.dispose();
		assert.deepStrictEqual(during, [false, 'overviewRuler']);
	});

	test('Settings and Keyboard Shortcuts open as editor tabs: modal editors are off by default (issue 169)', () => {
		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		const read = () => registry.getConfigurationDefaultsOverrides().get(USE_MODAL_EDITOR_SETTING)?.value;
		const before = read();
		const registration = registerClaudeChatDefaults();
		const during = read();
		registration.dispose();
		assert.deepStrictEqual([before, during, read()], [undefined, 'off', undefined]);
	});

	test('a tool card expands from the keyboard and keeps focus on its toggle', () => {
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IClaudeTendPullRequestService, silentTendService());
		const root = document.createElement('div');
		document.body.appendChild(root);
		store.add({ dispose: () => root.remove() });
		const renderer = store.add(instantiationService.createInstance(ClaudeTimelineRenderer, root, {
			retry: () => undefined,
			build: async () => undefined,
			respondPermission: async () => undefined,
			openSubagent: () => undefined,
			stopSubagent: () => undefined,
			copyCommand: () => undefined,
			openInTerminal: () => undefined,
			rerunCommand: () => undefined,
			openCommandLog: () => undefined,
		}));
		const events: AgentReducerEvent[] = [
			{ type: 'turn.submitted', turnId: 't1', text: 'Find login' },
			{ type: 'tool.started', sessionId: 's', call: { id: 'grep-1', name: 'Grep', category: 'search', input: { pattern: 'login' }, display: { label: 'Grep', query: 'login' } } },
			{ type: 'tool.completed', sessionId: 's', callId: 'grep-1', result: { ok: true, output: 'src/a.ts\nsrc/b.ts' } },
			{ type: 'session.completed', sessionId: 's' },
		];
		renderer.render(events.reduce(reduceAgentState, EMPTY_AGENT_VIEW_STATE));
		const toggle = () => root.querySelector('button.claude-tool-row') as HTMLButtonElement;

		const before = toggle();
		assert.deepStrictEqual([before.tagName, before.type, before.getAttribute('aria-expanded'), before.querySelector('.claude-sr-only')?.textContent], ['BUTTON', 'button', 'false', ' done']);
		// A native button: Enter and Space activate it with a click, so the keyboard path is the click path.
		before.focus();
		before.click();
		const opened = toggle();
		const controls = opened.getAttribute('aria-controls');
		assert.deepStrictEqual([opened.getAttribute('aria-expanded'), document.activeElement === opened, !!controls && !!root.querySelector(`#${controls}`)], ['true', true, true]);

		opened.click();
		assert.deepStrictEqual([toggle().getAttribute('aria-expanded'), document.activeElement === toggle()], ['false', true]);
	});
});
