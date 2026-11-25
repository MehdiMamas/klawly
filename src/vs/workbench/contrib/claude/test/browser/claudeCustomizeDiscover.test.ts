/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudePluginCatalog, ClaudePluginCatalogRequest, ClaudePluginCommand, ClaudePluginCommandResult, ClaudePluginContents, ClaudePluginDetails, ClaudePluginKind, IClaudePluginService } from '../../../../../platform/claude/common/claudePlugins.js';
import { IConfirmation, IDialogService, IPrompt } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ClaudeCustomizeDiscover } from '../../browser/settings/claudeCustomizeDiscover.js';

const GUARD: ClaudePluginContents = {
	skills: [],
	subagents: ['reviewer'],
	commands: ['check'],
	hooks: [{ event: 'PreToolUse', matcher: 'Bash', command: 'node ${CLAUDE_PLUGIN_ROOT}/check.js' }],
	mcpServers: [{ name: 'audit', command: 'npx', args: ['-y', 'audit-server'] }, { name: 'docs', url: 'https://docs.example.com/mcp' }],
	allowedTools: ['Bash(git status:*)', 'Read'],
	complete: true,
};

const CATALOG: ClaudePluginCatalog = {
	marketplaces: [
		{ name: 'claude-plugins-official', source: 'anthropics/claude-plugins-official', added: false, builtIn: true, pluginCount: 1 },
		{ name: 'team', source: 'example-org/team', added: true, builtIn: false, pluginCount: 2 },
		{ name: 'shared', source: 'example-org/shared', added: false, builtIn: false, declaredIn: 'project', pluginCount: 1 },
	],
	plugins: [
		{ id: 'guard@claude-plugins-official', name: 'guard', marketplace: 'claude-plugins-official', description: 'Checks shell commands', source: './plugins/guard', contents: GUARD, updateAvailable: false },
		{ id: 'notes@team', name: 'notes', marketplace: 'team', description: 'Release notes', source: 'example-org/notes', installed: { scope: 'user', version: '1.0.0' }, updateAvailable: true },
		{ id: 'remote@team', name: 'remote', marketplace: 'team', description: 'Hosted elsewhere', source: 'https://example.com/remote.git', updateAvailable: false },
		{ id: 'lint@shared', name: 'lint', marketplace: 'shared', description: 'Lints', source: 'example-org/lint', kinds: ['skills'], kindsPartial: true, updateAvailable: false },
	],
};

suite('Claude Customize Discover', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let instantiation: TestInstantiationService;
	let commands: ClaudePluginCommand[];
	let results: ClaudePluginCommandResult[];
	let prompts: string[];
	let notes: string[];
	let changed: number;
	let resolved: string[];
	let choice: number;
	let chats: string[];
	let trials: string[];
	let iconRequests: string[];
	let opened: number;
	let trusted: boolean;
	let catalog: ClaudePluginCatalog;

	setup(() => {
		instantiation = workbenchInstantiationService(undefined, store);
		commands = [];
		results = [];
		prompts = [];
		notes = [];
		changed = 0;
		resolved = [];
		choice = 0;
		chats = [];
		trials = [];
		iconRequests = [];
		opened = 0;
		trusted = true;
		catalog = CATALOG;
		// The chats hear about each install, update and remove; whether one shows a notice is the agent service's call.
		instantiation.stub(IClaudeAgentService, {
			notePluginChange: (plugin: string, removed: boolean) => chats.push(removed ? `${plugin} removed` : plugin),
			createSession: (options?: { readonly plugins?: readonly string[] }) => trials.push(...options?.plugins ?? ['none']),
		} as unknown as IClaudeAgentService);
		instantiation.stub(IClaudePluginService, {
			getCatalog: async () => catalog,
			getDetails: async (id: string): Promise<ClaudePluginDetails | undefined> => {
				const plugin = CATALOG.plugins.find(entry => entry.id === id);
				return plugin && { plugin, contents: plugin.contents ?? { ...GUARD, hooks: [], mcpServers: [], complete: false }, readme: '# Guard\n\nChecks **every** command.' };
			},
			// notes@team reads; remote@team is not on GitHub, so it stays unknown; lint@shared's cached
			// kinds missed its hooks (issue 535).
			resolveKinds: async (ids: readonly string[], request: ClaudePluginCatalogRequest): Promise<Record<string, readonly ClaudePluginKind[]>> => {
				resolved.push(`${ids.join(',')} in ${request.cwd}`);
				return { 'notes@team': ['hooks'], 'lint@shared': ['skills', 'hooks'] };
			},
			// Klawly can get guard's files; remote@team is a plain Git URL it cannot fetch.
			getPluginIcons: async (ids: readonly string[]): Promise<Record<string, string>> => {
				iconRequests.push(ids.join(','));
				return ids.includes('notes@team') ? { 'notes@team': 'data:image/png;base64,iVBORw0KGgo=' } : {};
			},
			prepareTerminalPlugin: async () => '/data/bundled-plugins/klawly',
			preparePluginTrial: async (id: string) => id === 'guard@claude-plugins-official' ? '/cache/claude-plugin-trials/claude-plugins-official/guard' : undefined,
			run: async (command: ClaudePluginCommand) => {
				commands.push(command);
				return results.shift() ?? { outcome: 'done', message: '' };
			},
		} as unknown as IClaudePluginService);
		instantiation.stub(IDialogService, {
			prompt: async (prompt: IPrompt<string | undefined>) => {
				prompts.push(`${prompt.message}\n${prompt.detail}\n${prompt.buttons?.map(button => button.label).join('|')}`);
				return { result: Promise.resolve(prompt.buttons?.[choice].run({ checkboxChecked: false })) };
			},
			confirm: async (confirmation: IConfirmation) => {
				prompts.push(`${confirmation.message}\n${confirmation.detail}`);
				return { confirmed: true };
			},
		} as unknown as IDialogService);
		instantiation.stub(INotificationService, { info: (message: string) => notes.push(message), error: (message: string) => notes.push(`error: ${message}`) } as unknown as INotificationService);
		instantiation.stub(IWorkspaceContextService, { getWorkspace: () => ({ folders: [{ uri: URI.file('/work'), name: 'work' }] }) } as unknown as IWorkspaceContextService);
		instantiation.stub(IWorkspaceTrustManagementService, { isWorkspaceTrusted: () => trusted } as unknown as IWorkspaceTrustManagementService);
	});

	async function settle(): Promise<void> {
		for (let i = 0; i < 4; i++) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}
	}

	async function open() {
		const discover = store.add(instantiation.createInstance(ClaudeCustomizeDiscover, { layout: () => undefined, changed: () => { changed++; }, openChat: () => { opened++; } }));
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		store.add({ dispose: () => parent.remove() });
		discover.render(parent, new Map());
		await settle();
		const texts = (selector: string) => [...parent.querySelectorAll(selector)].map(element => element.textContent);
		const click = (selector: string) => parent.querySelector<HTMLElement>(selector)!.click();
		return { parent, texts, click };
	}

	test('Discover lists every plugin with its state, reads unknown kinds for a kind filter, and lists the marketplaces', async () => {
		const { texts, click } = await open();
		const all = texts('[data-plugin] .name');
		const actions = texts('[data-plugin] button.claude-btn');
		const marketplaces = texts('[data-marketplace] .name');
		const badges = texts('[data-marketplace] .claude-badge');
		click('[data-kind="hooks"].claude-customize-chip');
		const reading = texts('.claude-discover-hint');
		await settle();
		assert.deepStrictEqual({ all, actions, marketplaces, badges, reading, resolved, hooks: texts('[data-plugin] .name'), hint: texts('.claude-discover-hint') }, {
			all: ['guard', 'notes', 'remote', 'lint'],
			actions: ['Install', 'Update', 'Install', 'Install'],
			marketplaces: ['claude-plugins-official', 'team', 'shared'],
			badges: ['Built In', 'Team'],
			reading: ['Reading what 3 more plugins add...'],
			resolved: [`notes@team,remote@team,lint@shared in ${URI.file('/work').fsPath}`],
			hooks: ['guard', 'notes', 'lint'],
			hint: ['1 plugin could not be read before install, so this filter leaves it out.'],
		});
	});

	test('a plugin shows its own icon from the shared process, else a monogram on a tint its name picks, and its display name (issue 534)', async () => {
		catalog = {
			...CATALOG,
			plugins: CATALOG.plugins.map(plugin => plugin.id === 'notes@team' ? { ...plugin, displayName: 'Release Notes', iconUrl: 'https://github.com/example-org.png?size=64' }
				: plugin.id === 'remote@team' ? { ...plugin, iconUrl: 'https://example.com/favicon.ico' } : plugin),
		};
		const { parent, texts, click } = await open();
		const icons = [...parent.querySelectorAll<HTMLElement>('[data-plugin] .claude-plugin-icon')].map(icon => icon.querySelector('img')?.getAttribute('src') ?? `${icon.textContent} tint ${icon.dataset.tint}`);
		const list = { names: texts('[data-plugin] .name'), icons, asked: [...iconRequests] };
		click('[data-plugin="notes@team"] .claude-discover-open');
		await settle();
		assert.deepStrictEqual({ list, title: texts('.claude-discover-title'), head: parent.querySelector('.claude-discover-head img')?.getAttribute('src'), asked: iconRequests }, {
			list: {
				names: ['guard', 'Release Notes', 'remote', 'lint'],
				icons: ['G tint 3', 'data:image/png;base64,iVBORw0KGgo=', 'R tint 4', 'L tint 1'],
				asked: ['notes@team,remote@team'],
			},
			title: ['Release Notes'],
			head: 'data:image/png;base64,iVBORw0KGgo=',
			asked: ['notes@team,remote@team'],
		});
	});

	test('a team marketplace shows a Team badge, and a required plugin cannot be removed (issue 523)', async () => {
		catalog = {
			marketplaces: [
				{ name: 'policy', source: 'example-org/policy', added: true, builtIn: false, declaredIn: 'managed', pluginCount: 1 },
				{ name: 'shared', source: 'example-org/shared', added: true, builtIn: false, declaredIn: 'project', pluginCount: 2 },
				{ name: 'mine', source: './market', added: true, builtIn: false, declaredIn: 'local', pluginCount: 1 },
			],
			plugins: [
				{ id: 'audit@policy', name: 'audit', marketplace: 'policy', description: 'Audits', source: 'example-org/audit', installed: { scope: 'managed' }, updateAvailable: false, policy: 'required' },
				{ id: 'lint@shared', name: 'lint', marketplace: 'shared', description: 'Lints', source: 'example-org/lint', installed: { scope: 'project' }, updateAvailable: false, policy: 'defaultOn' },
				{ id: 'docs@shared', name: 'docs', marketplace: 'shared', description: 'Docs', source: 'example-org/docs', updateAvailable: false, policy: 'required' },
				{ id: 'tool@mine', name: 'tool', marketplace: 'mine', description: 'Tool', source: './tool', installed: { scope: 'local' }, updateAvailable: false },
			],
		};
		const { parent, texts } = await open();
		const row = (id: string) => [...parent.querySelectorAll(`[data-plugin="${id}"] .claude-badge, [data-plugin="${id}"] button:not(.claude-discover-open)`)].map(element => element.getAttribute('aria-label') ?? element.textContent);
		assert.deepStrictEqual({
			plugins: ['audit@policy', 'lint@shared', 'docs@shared', 'tool@mine'].map(row),
			marketplaces: texts('[data-marketplace] .claude-badge'),
			removeMarketplace: [...parent.querySelectorAll<HTMLElement>('[data-marketplace] button')].map(button => `${button.closest<HTMLElement>('[data-marketplace]')!.dataset.marketplace} ${button.getAttribute('aria-label')}`),
		}, {
			plugins: [['Required', 'Installed'], ['Default On', 'Installed', 'Remove Plugin'], ['Required', 'Install'], ['Installed', 'Remove Plugin']],
			marketplaces: ['Team', 'Team', 'Project'],
			removeMarketplace: ['shared Remove Marketplace', 'mine Remove Marketplace'],
		});
	});

	test('details list every hook and MCP server command, and Install shows them before it runs claude plugin', async () => {
		const { parent, texts, click } = await open();
		click('[data-plugin="guard@claude-plugins-official"] .claude-discover-open');
		await settle();
		const rows = texts('.claude-discover-contents .claude-settings-row-description');
		const readme = parent.querySelector('.claude-discover-readme strong')?.textContent;
		// The marketplace answers that it runs a command at install; Klawly asks, then runs again with its hash.
		results.push({ outcome: 'confirm', message: '', shownCommand: { command: 'npm ci', sha256: 'a'.repeat(64) } });
		click('.claude-discover-actions .claude-btn.is-primary');
		await settle();
		assert.deepStrictEqual({ rows, readme, prompts, commands, notes, changed, chats }, {
			rows: ['reviewer', 'check', 'node ${CLAUDE_PLUGIN_ROOT}/check.js', 'npx -y audit-server', 'https://docs.example.com/mcp', 'Bash(git status:*), Read'],
			readme: 'every',
			prompts: [
				'Install guard?\nChecks shell commands\n\nHook: PreToolUse (Bash): node ${CLAUDE_PLUGIN_ROOT}/check.js\nMCP Server audit: npx -y audit-server\nMCP Server docs: https://docs.example.com/mcp\n\nA plugin runs with your permissions. Install plugins only from sources you trust.\nInstall for You|Install in This Project|Install for You in This Project',
				'The marketplace runs this command to install the plugin\nnpm ci',
			],
			commands: [
				{ action: 'install', plugin: 'guard', scope: 'user', marketplaceSource: 'anthropics/claude-plugins-official', cwd: undefined },
				{ action: 'install', plugin: 'guard', scope: 'user', marketplaceSource: 'anthropics/claude-plugins-official', cwd: undefined, acceptCommand: 'a'.repeat(64) },
			],
			notes: ['guard is installed. Sessions you start from now on load it; restart a running session to use it there.'],
			changed: 1,
			chats: ['guard'],
		});
	});

	test('Try in a New Session names what the plugin runs, then opens a new chat that loads it, and is disabled in Restricted Mode', async () => {
		const { parent, texts, click } = await open();
		click('[data-plugin="guard@claude-plugins-official"] .claude-discover-open');
		await settle();
		const guardActions = texts('.claude-discover-actions button');
		click('.claude-discover-try');
		await settle();
		click('[data-focus-key="discover.back"]');
		click('[data-plugin="remote@team"] .claude-discover-open');
		await settle();
		click('.claude-discover-try');
		await settle();
		click('[data-focus-key="discover.back"]');
		click('[data-plugin="notes@team"] .claude-discover-open');
		await settle();
		const installedActions = texts('.claude-discover-actions button');
		click('[data-focus-key="discover.back"]');
		trusted = false;
		click('[data-plugin="guard@claude-plugins-official"] .claude-discover-open');
		await settle();
		const restrictedActions = [...parent.querySelectorAll<HTMLButtonElement>('.claude-discover-actions button')].map(button => `${button.textContent}${button.disabled ? ' (disabled)' : ''}`);
		assert.deepStrictEqual({ guardActions, prompt: prompts[0], trials, opened, notes, commands, installedActions, restrictedActions }, {
			guardActions: ['Try in a New Session', 'Install'],
			prompt: 'Try guard in a new session?\nChecks shell commands\n\nHook: PreToolUse (Bash): node ${CLAUDE_PLUGIN_ROOT}/check.js\nMCP Server audit: npx -y audit-server\nMCP Server docs: https://docs.example.com/mcp\n\nA plugin runs with your permissions. Install plugins only from sources you trust.',
			trials: ['/cache/claude-plugin-trials/claude-plugins-official/guard'],
			opened: 1,
			notes: ['error: Klawly could not get the files of remote, so it cannot try it. Install it to use it.'],
			commands: [],
			installedActions: ['Update', 'Remove Plugin'],
			restrictedActions: ['Try in a New Session (disabled)', 'Install'],
		});
	});

	test('a plugin from a marketplace the project declares adds it at that scope, then installs for you in this project', async () => {
		const { click } = await open();
		choice = 2;
		const cwd = URI.file('/work').fsPath;
		results.push({ outcome: 'done', message: '' }, { outcome: 'confirm', message: '', shownCommand: { command: 'node helper.js', sha256: 'b'.repeat(64), archiveUrl: 'https://example.com/lint.tgz' } });
		click('[data-plugin="lint@shared"] button.claude-btn.is-primary');
		await settle();
		await settle();
		assert.deepStrictEqual({ commands, confirm: prompts[1], notes, changed, chats }, {
			commands: [
				{ action: 'addMarketplace', source: 'example-org/shared', scope: 'project', cwd },
				{ action: 'install', plugin: 'lint@shared', scope: 'local', cwd },
				{ action: 'install', plugin: 'lint@shared', scope: 'local', cwd, acceptCommand: 'b'.repeat(64) },
			],
			confirm: 'The marketplace runs this command to install the plugin\nnode helper.js\n\nIt runs from https://example.com/lint.tgz.',
			notes: ['Claude Code now has the shared marketplace.', 'lint is installed. Sessions you start from now on load it; restart a running session to use it there.'],
			changed: 2,
			chats: ['lint'],
		});
	});

	test('Remove tells the chats the plugin is gone, and a failed command tells them nothing', async () => {
		const { click } = await open();
		results.push({ outcome: 'failed', message: 'network down' });
		click('[data-plugin="notes@team"] button.claude-btn');
		await settle();
		click('[data-plugin="notes@team"] .claude-icon-btn');
		await settle();
		assert.deepStrictEqual({ commands: commands.map(command => command.action), chats }, {
			commands: ['update', 'uninstall'],
			chats: ['notes removed'],
		});
	});
});
