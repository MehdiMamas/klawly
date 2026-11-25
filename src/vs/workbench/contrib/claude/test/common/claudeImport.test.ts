/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { applyEdits, setProperty } from '../../../../../base/common/jsonEdit.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	claudeImportExtensionCandidates, claudeImportExtensionFromManifest, claudeImportExtensionsFromIndex, claudeImportFileKind, claudeImportFolderAllowed, claudeImportLocations,
	claudeImportItems, ClaudeImportPlan, claudeImportPreview, ClaudeImportReader, claudeSelectImport, parseClaudeImportBackup, claudeImportReport, claudeImportSkipReasonLabel, claudeKeybindingIdentity, planClaudeExtensionsImport, planClaudeKeybindingsImport, planClaudeSettingsImport, planClaudeSnippetsImport,
	claudeImportMcpEntry, claudeImportProfileLocations, claudeImportProfilesFromStorage, claudeImportRulesBody, claudeImportThemeExtensions, claudeMcpImportText, claudeMcpUndoText, claudeRulesAppendix, claudeRulesRemove, ClaudeThemeEnvironment, planClaudeMcpImport, planClaudeRulesImport, planClaudeThemesImport,
} from '../../common/claudeImport.js';
import { accessedUnder, createClaudeImportFixture, FORBIDDEN_FIXTURE_FILES, SECRET_MCP_JSON, writeClaudeImportExtras } from './claudeImportFixtures.js';

suite('Claude import from VS Code and Cursor', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('user and extension folders per OS', () => {
		const home = URI.file('/home/me');
		const paths = (os: OperatingSystem, env: Record<string, string>) => {
			const vscode = claudeImportLocations('vscode', os, home, env);
			const cursor = claudeImportLocations('cursor', os, home, env);
			return [vscode.userFolder.path, vscode.extensionsFolder.path, cursor.userFolder.path, cursor.extensionsFolder.path];
		};
		assert.deepStrictEqual({
			windows: paths(OperatingSystem.Windows, { appdata: 'D:\\Roaming' }),
			windowsNoEnv: paths(OperatingSystem.Windows, {}),
			mac: paths(OperatingSystem.Macintosh, {}),
			linux: paths(OperatingSystem.Linux, {}),
			linuxXdg: paths(OperatingSystem.Linux, { XDG_CONFIG_HOME: '/data/config' }),
			linuxRelativeXdg: paths(OperatingSystem.Linux, { XDG_CONFIG_HOME: 'config' }),
		}, {
			windows: ['/D:/Roaming/Code/User', '/home/me/.vscode/extensions', '/D:/Roaming/Cursor/User', '/home/me/.cursor/extensions'],
			windowsNoEnv: ['/home/me/AppData/Roaming/Code/User', '/home/me/.vscode/extensions', '/home/me/AppData/Roaming/Cursor/User', '/home/me/.cursor/extensions'],
			mac: ['/home/me/Library/Application Support/Code/User', '/home/me/.vscode/extensions', '/home/me/Library/Application Support/Cursor/User', '/home/me/.cursor/extensions'],
			linux: ['/home/me/.config/Code/User', '/home/me/.vscode/extensions', '/home/me/.config/Cursor/User', '/home/me/.cursor/extensions'],
			linuxXdg: ['/data/config/Code/User', '/home/me/.vscode/extensions', '/data/config/Cursor/User', '/home/me/.cursor/extensions'],
			linuxRelativeXdg: ['/home/me/.config/Code/User', '/home/me/.vscode/extensions', '/home/me/.config/Cursor/User', '/home/me/.cursor/extensions'],
		});
	});

	test('allowlist: only settings, keybindings, snippet files and extension manifests', () => {
		const locations = claudeImportLocations('vscode', OperatingSystem.Linux, URI.file('/home/me'), {});
		const user = (path: string) => joinPath(locations.userFolder, ...path.split('/'));
		const extensions = (path: string) => joinPath(locations.extensionsFolder, ...path.split('/'));
		const kinds = (resources: URI[]) => resources.map(resource => claudeImportFileKind(resource, locations) ?? 'denied');
		assert.deepStrictEqual({
			allowed: kinds([
				user('settings.json'),
				user('keybindings.json'),
				user('snippets/python.json'),
				user('snippets/all.code-snippets'),
				extensions('extensions.json'),
				extensions('esbenp.prettier-vscode-10.1.0/package.json'),
				joinPath(locations.userFolder, '..', 'User', 'settings.json'),
			]),
			denied: kinds([
				...FORBIDDEN_FIXTURE_FILES.filter(path => path !== 'globalStorage/storage.json').map(user),
				user('snippets/notes.txt'),
				user('snippets/.hidden.json'),
				user('snippets/nested/inner.json'),
				joinPath(locations.userFolder, 'snippets', '..', 'state.vscdb'),
				user('sync/settings/lastSyncsettings.json'),
				user('profiles/abc/settings.json'),
				extensions('.obsolete'),
				extensions('.hidden-1.0.0/package.json'),
				extensions('golang.go-0.41.0/README.md'),
				extensions('golang.go-0.41.0/node_modules/dep/package.json'),
				extensions('package.json'),
				URI.file('/home/me/.ssh/id_rsa'),
				URI.from({ scheme: 'vscode-userdata', path: locations.userFolder.path + '/settings.json' }),
			]).every(kind => kind === 'denied'),
			profileList: kinds([user('globalStorage/storage.json')]),
			folders: [
				claudeImportFolderAllowed(user('snippets'), locations),
				claudeImportFolderAllowed(locations.extensionsFolder, locations),
				claudeImportFolderAllowed(locations.userFolder, locations),
				claudeImportFolderAllowed(user('globalStorage'), locations),
			],
		}, {
			allowed: ['settings', 'keybindings', 'snippet', 'snippet', 'extensions-index', 'extension-manifest', 'settings'],
			denied: true,
			profileList: ['profiles'],
			folders: [true, true, false, false],
		});
	});

	test('the reader refuses anything outside the allowlist', async () => {
		const store = disposables.add(new DisposableStore());
		const fixture = await createClaudeImportFixture(store, OperatingSystem.Linux, {});
		const reader = new ClaudeImportReader(fixture.vscode, fixture.files);
		const refused: string[] = [];
		for (const path of ['state.vscdb', 'globalStorage/state.vscdb', 'snippets/nested/inner.json']) {
			await reader.readText(joinPath(fixture.vscode.userFolder, ...path.split('/'))).catch(error => refused.push(path + ': ' + (error as Error).message.split(' ')[0]));
		}
		assert.deepStrictEqual({ refused, accessed: accessedUnder(fixture, 'vscode') }, {
			refused: ['state.vscdb: Import', 'globalStorage/state.vscdb: Import', 'snippets/nested/inner.json: Import'],
			accessed: [],
		});
	});

	test('VS Code fixture: collects only allowed files and never touches token or state files', async () => {
		const store = disposables.add(new DisposableStore());
		const fixture = await createClaudeImportFixture(store, OperatingSystem.Linux, {});
		const reader = new ClaudeImportReader(fixture.vscode, fixture.files);
		const source = await reader.collect();
		await reader.readText(source.snippets[0].resource);
		const accessed = accessedUnder(fixture, 'vscode');
		assert.deepStrictEqual({
			snippets: source.snippets.map(file => file.name),
			extensions: source.extensions.map(extension => extension.id),
			settings: source.settings?.includes('editor.fontSize'),
			everyReadAllowed: fixture.provider.accessed.filter(entry => entry.op === 'read').every(entry => claudeImportFileKind(entry.resource, fixture.vscode) !== undefined),
			opened: accessed.filter(entry => !entry.startsWith('stat ')).sort(),
			touchedForbidden: accessed.filter(entry => FORBIDDEN_FIXTURE_FILES.some(path => entry.endsWith(path) || entry.includes('/globalStorage') || entry.includes('/workspaceStorage') || entry.includes('Local Storage'))),
		}, {
			snippets: ['python.json', 'shared.code-snippets'],
			extensions: ['esbenp.prettier-vscode', 'ms-python.python', 'ms-python.vscode-pylance', 'ms-vscode-remote.remote-ssh', 'GitHub.copilot', 'dbaeumer.vscode-eslint', 'someone.unpublished'],
			settings: true,
			everyReadAllowed: true,
			opened: [
				'list extensions/',
				'list user/snippets',
				'read extensions/esbenp.prettier-vscode-10.1.0/package.json',
				'read extensions/extensions.json',
				'read user/keybindings.json',
				'read user/mcp.json',
				'read user/settings.json',
				'read user/snippets/python.json',
			],
			touchedForbidden: [],
		});
	});

	test('Cursor fixture: reads each extension manifest only, skipping hidden folders and nested packages', async () => {
		const store = disposables.add(new DisposableStore());
		const fixture = await createClaudeImportFixture(store, OperatingSystem.Linux, {});
		const source = await new ClaudeImportReader(fixture.cursor, fixture.files).collect();
		const accessed = accessedUnder(fixture, 'cursor');
		assert.deepStrictEqual({
			snippets: source.snippets.length,
			extensions: source.extensions.map(extension => `${extension.id}@${extension.version}`).sort(),
			opened: accessed.filter(entry => !entry.startsWith('stat ')).sort(),
			everyReadAllowed: fixture.provider.accessed.filter(entry => entry.op === 'read').every(entry => claudeImportFileKind(entry.resource, fixture.cursor) !== undefined),
			touchedForbidden: accessed.filter(entry => FORBIDDEN_FIXTURE_FILES.some(path => entry.endsWith(path)) || entry.includes('node_modules') || entry.includes('README') || entry.includes('.obsolete') || entry.includes('.hidden')),
		}, {
			snippets: 0,
			extensions: ['anysphere.cursorpyright@1.0.3', 'golang.go@0.41.0', 'ms-python.python@2024.2.0'],
			opened: [
				'list extensions/',
				'read extensions/anysphere.cursorpyright-1.0.3/package.json',
				'read extensions/extensions.json',
				'read extensions/golang.go-0.41.0/package.json',
				'read extensions/ms-python.python-2024.2.0/package.json',
				'read user/keybindings.json',
				'read user/settings.json',
			],
			everyReadAllowed: true,
			touchedForbidden: [],
		});
	});

	test('settings merge keeps every key Klawly already sets and skips Cursor, AI and protected keys', () => {
		const source = `{
			// comment
			"editor.fontSize": 15,
			"editor.tabSize": 2,
			"cursor.cpp.enablePartialAccepts": true,
			"aipopup.enabled": false,
			"github.copilot.enable": { "*": true },
			"chat.agent.enabled": true,
			"mcp": { "servers": {} },
			"claude.agent.enabled": false,
			"update.mode": "none",
			"telemetry.telemetryLevel": "all",
			"security.workspace.trust.enabled": false,
			"editor.cursorStyle": "block",
			"[python]": { "editor.tabSize": 4, "editor.formatOnSave": true, "github.copilot.enable": false },
			"[markdown]": { "editor.wordWrap": "on" },
		}`;
		const target = '{\n\t// Mine\n\t"editor.tabSize": 4,\n\t"[python]": {\n\t\t"editor.tabSize": 8\n\t}\n}';
		const plan = planClaudeSettingsImport(source, target);
		let merged = target;
		for (const value of plan.add) {
			merged = applyEdits(merged, setProperty(merged, value.path, value.value, { tabSize: 4, insertSpaces: false, eol: '\n' }));
		}
		assert.deepStrictEqual({
			add: plan.add.map(value => value.label),
			kept: plan.kept,
			skipped: plan.skipped.map(skip => `${skip.item}: ${skip.reason}`),
			merged: JSON.parse(merged.replace('// Mine', '')),
			commentKept: merged.includes('// Mine'),
		}, {
			add: ['editor.fontSize', 'editor.cursorStyle', '[python] editor.formatOnSave', '[markdown] editor.wordWrap'],
			kept: ['editor.tabSize', '[python] editor.tabSize'],
			skipped: [
				'cursor.cpp.enablePartialAccepts: cursor',
				'aipopup.enabled: cursor',
				'github.copilot.enable: ai',
				'chat.agent.enabled: ai',
				'mcp: ai',
				'claude.agent.enabled: klawly',
				'update.mode: updates',
				'telemetry.telemetryLevel: telemetry',
				'security.workspace.trust.enabled: workspace-trust',
				'[python] github.copilot.enable: ai',
			],
			merged: {
				'editor.tabSize': 4,
				'[python]': { 'editor.tabSize': 8, 'editor.formatOnSave': true },
				'editor.fontSize': 15,
				'editor.cursorStyle': 'block',
				'[markdown]': { 'editor.wordWrap': 'on' },
			},
			commentKept: true,
		});
	});

	test('settings with errors are never merged', () => {
		assert.deepStrictEqual([
			planClaudeSettingsImport('{ "a": ', '{}').invalid,
			planClaudeSettingsImport('{ "a": 1 }', '{ broken').invalid,
			planClaudeSettingsImport('[1]', '{}').invalid,
			planClaudeSettingsImport('', '').invalid,
		], ['source', 'target', 'source', undefined]);
	});

	test('keybindings: duplicates (key, command, when) are not added again; AI and Cursor commands are skipped', () => {
		const source = `[
			{ "key": "ctrl+shift+k", "command": "editor.action.deleteLines" },
			{ "key": "ctrl+alt+n", "command": "workbench.action.files.newUntitledFile", "when": "editorFocus" },
			{ "key": "ctrl+alt+n", "command": "workbench.action.files.newUntitledFile", "when": "editorFocus" },
			{ "key": "ctrl+alt+n", "command": "workbench.action.files.newUntitledFile", "when": "editorTextFocus" },
			{ "key": "ctrl+i", "command": "github.copilot.generate" },
			{ "key": "ctrl+l", "command": "-workbench.action.chat.open" },
			{ "key": "ctrl+k", "command": "aipopup.action.modal.generate" },
			{ "key": "ctrl+e", "command": "composer.startComposerPrompt" },
			{ "key": "ctrl+up", "command": "cursorUp" },
			{ "key": "ctrl+x", "command": "editor.action.clipboardCutAction", "args": { "a": 1 } },
			{ "command": "no.key" },
		]`;
		const target = '[{ "key": "Shift+Ctrl+K", "command": "editor.action.deleteLines" }, { "key": "ctrl+alt+n", "command": "workbench.action.files.newUntitledFile", "when": "editorFocus && !inDebugMode" }]';
		const fromVSCode = planClaudeKeybindingsImport(source, target, 'vscode');
		const fromCursor = planClaudeKeybindingsImport(source, target, 'cursor');
		assert.deepStrictEqual({
			add: fromVSCode.add.map(entry => `${entry.key} ${entry.command} ${entry.when ?? ''}`.trim()),
			args: fromVSCode.add.at(-1)?.args,
			existing: fromVSCode.existing,
			skippedFromVSCode: fromVSCode.skipped.map(skip => `${skip.item}: ${skip.reason}`),
			skippedFromCursor: fromCursor.skipped.map(skip => skip.reason),
			sameIdentity: claudeKeybindingIdentity({ key: 'Ctrl+Shift+K  ctrl+A', command: 'x', when: 'a && b' }) === claudeKeybindingIdentity({ key: 'shift+ctrl+k ctrl+a', command: 'x', when: 'a&&b' }),
			invalid: [planClaudeKeybindingsImport('{}', '[]', 'vscode').invalid, planClaudeKeybindingsImport('[]', '[', 'vscode').invalid, planClaudeKeybindingsImport('[]', '', 'vscode').invalid],
		}, {
			add: [
				'ctrl+alt+n workbench.action.files.newUntitledFile editorFocus',
				'ctrl+alt+n workbench.action.files.newUntitledFile editorTextFocus',
				'ctrl+k aipopup.action.modal.generate',
				'ctrl+e composer.startComposerPrompt',
				'ctrl+up cursorUp',
				'ctrl+x editor.action.clipboardCutAction',
			],
			args: { a: 1 },
			existing: 2,
			skippedFromVSCode: ['ctrl+i \u2192 github.copilot.generate: ai', 'ctrl+l \u2192 -workbench.action.chat.open: ai'],
			skippedFromCursor: ['ai', 'ai', 'cursor', 'cursor'],
			sameIdentity: true,
			invalid: ['source', 'target', undefined],
		});
	});

	test('settings that start a program or shell are skipped with a reason, look-alikes are imported', () => {
		const source = JSON.stringify({
			'terminal.integrated.profiles.windows': { evil: { path: 'C:\\evil.exe' } },
			'terminal.integrated.defaultProfile.linux': 'evil',
			'terminal.integrated.automationProfile.osx': { path: '/tmp/x' },
			'terminal.integrated.shell.windows': 'C:\\evil.exe',
			'terminal.integrated.shellArgs.linux': ['-c', 'curl x | sh'],
			'terminal.integrated.automationShell.linux': '/tmp/sh',
			'terminal.external.windowsExec': 'evil.exe',
			'git.path': '/tmp/git',
			'typescript.tsdk': '/tmp/ts/lib',
			'php.validate.executablePath': '/tmp/php',
			'python.defaultInterpreterPath': '/tmp/python',
			'eslint.nodePath': '/tmp/node',
			'rust-analyzer.server.path': '/tmp/ra',
			'debug.javascript.defaultRuntimeExecutable': { 'pwa-node': '/tmp/node' },
			'[python]': { 'python.defaultInterpreterPath': '/tmp/python', 'editor.tabSize': 4 },
			'terminal.integrated.shellIntegration.enabled': true,
			'terminal.integrated.fontSize': 13,
			'files.dialog.defaultPath': '/home/me',
			'breadcrumbs.filePath': 'on',
		});
		const plan = planClaudeSettingsImport(source, '{}');
		assert.deepStrictEqual({
			add: plan.add.map(value => value.label),
			skipped: plan.skipped.map(skip => `${skip.item}: ${skip.reason}`),
			label: claudeImportSkipReasonLabel('executable').length > 0,
		}, {
			add: ['[python] editor.tabSize', 'terminal.integrated.shellIntegration.enabled', 'terminal.integrated.fontSize', 'files.dialog.defaultPath', 'breadcrumbs.filePath'],
			skipped: [
				'terminal.integrated.profiles.windows: executable',
				'terminal.integrated.defaultProfile.linux: executable',
				'terminal.integrated.automationProfile.osx: executable',
				'terminal.integrated.shell.windows: executable',
				'terminal.integrated.shellArgs.linux: executable',
				'terminal.integrated.automationShell.linux: executable',
				'terminal.external.windowsExec: executable',
				'git.path: executable',
				'typescript.tsdk: executable',
				'php.validate.executablePath: executable',
				'python.defaultInterpreterPath: executable',
				'eslint.nodePath: executable',
				'rust-analyzer.server.path: executable',
				'debug.javascript.defaultRuntimeExecutable: executable',
				'[python] python.defaultInterpreterPath: executable',
			],
			label: true,
		});
	});

	test('keybindings that type into the terminal are skipped, also inside runCommands; removing one is imported', () => {
		const source = JSON.stringify([
			{ key: 'ctrl+1', command: 'workbench.action.terminal.sendSequence', args: { text: 'rm -rf ~\u000D' } },
			{ key: 'ctrl+2', command: 'runCommands', args: { commands: ['workbench.action.terminal.focus', { command: 'workbench.action.terminal.sendSequence', args: { text: 'curl x | sh\n' } }] } },
			{ key: 'ctrl+3', command: 'runCommands', args: { commands: [{ command: 'runCommands', args: { commands: ['workbench.action.terminal.sendSequence'] } }] } },
			{ key: 'ctrl+4', command: 'runCommands', args: { commands: ['editor.action.formatDocument', { command: 'workbench.action.files.save' }] } },
			{ key: 'ctrl+5', command: '-workbench.action.terminal.sendSequence' },
			{ key: 'ctrl+6', command: 'workbench.action.terminal.focus' },
		]);
		const plan = planClaudeKeybindingsImport(source, '[]', 'vscode');
		assert.deepStrictEqual({
			add: plan.add.map(entry => `${entry.key} ${entry.command}`),
			skipped: plan.skipped.map(skip => `${skip.item}: ${skip.reason}`),
		}, {
			add: ['ctrl+4 runCommands', 'ctrl+5 -workbench.action.terminal.sendSequence', 'ctrl+6 workbench.action.terminal.focus'],
			skipped: [
				'ctrl+1 \u2192 workbench.action.terminal.sendSequence: terminal-input',
				'ctrl+2 \u2192 runCommands: terminal-input',
				'ctrl+3 \u2192 runCommands: terminal-input',
			],
		});
	});

	test('snippet files that exist in Klawly are kept, not overwritten', () => {
		const resource = (name: string) => URI.file(`/x/${name}`);
		const plan = planClaudeSnippetsImport([
			{ name: 'python.json', resource: resource('python.json') },
			{ name: 'shared.code-snippets', resource: resource('shared.code-snippets') },
		], ['Shared.code-snippets', 'go.json']);
		const overwrite = planClaudeSnippetsImport([{ name: 'shared.code-snippets', resource: resource('shared.code-snippets') }], ['Shared.code-snippets'], 'overwrite');
		assert.deepStrictEqual({
			copy: plan.copy.map(file => file.name),
			replace: plan.replace,
			kept: plan.kept,
			overwrite: overwrite.replace.map(file => `${file.name} from ${file.resource.path}`),
		}, {
			copy: ['python.json'],
			replace: [],
			kept: ['shared.code-snippets'],
			overwrite: ['Shared.code-snippets from /x/shared.code-snippets'],
		});
	});

	test('Overwrite replaces only values that differ; the item tree picks single values and unchecked replacements are kept', () => {
		const settings = planClaudeSettingsImport('{ "editor.fontSize": 15, "editor.tabSize": 2, "editor.wordWrap": "on", "[python]": { "editor.tabSize": 4 }, "cursor.x": 1 }', '{ "editor.tabSize": 4, "editor.wordWrap": "on", "[python]": { "editor.tabSize": 8 } }', 'overwrite');
		const plan: ClaudeImportPlan = {
			editor: 'vscode',
			mode: 'overwrite',
			settings,
			keybindings: planClaudeKeybindingsImport('[{ "key": "alt+up", "command": "editor.action.moveLinesUpAction", "when": "editorTextFocus" }]', '[]', 'vscode'),
			extensions: planClaudeExtensionsImport([{ id: 'golang.go' }, { id: 'ms-vscode.cpptools' }], new Set(), new Set(['golang.go'])),
		};
		const items = claudeImportItems(plan);
		const selected = claudeSelectImport(plan, new Set(['settings:editor.tabSize', 'keybindings:0']));
		assert.deepStrictEqual({
			replace: settings.replace.map(value => `${value.label}: ${JSON.stringify(value.current)} -> ${JSON.stringify(value.value)}`),
			kept: settings.kept,
			items: items.map(item => `${item.picked ? '[x]' : '[ ]'} ${item.id} | ${item.label} | ${item.description ?? ''}${item.skipped ? ` | skipped: ${item.skipped}` : ''}`),
			selected: {
				add: selected.settings?.add.map(value => value.label),
				replace: selected.settings?.replace.map(value => value.label),
				kept: selected.settings?.kept,
				keybindings: selected.keybindings?.add.length,
				install: selected.extensions?.install.map(extension => extension.id),
			},
		}, {
			replace: ['editor.tabSize: 4 -> 2', '[python] editor.tabSize: 8 -> 4'],
			kept: ['editor.wordWrap'],
			items: [
				'[x] settings:editor.fontSize | editor.fontSize | 15',
				'[x] settings:editor.tabSize | editor.tabSize | Replaces 4 with 2',
				'[x] settings:[python] editor.tabSize | [python] editor.tabSize | Replaces 8 with 4',
				'[ ] settings:skip:cursor.x | cursor.x |  | skipped: Cursor feature with no Klawly equivalent',
				'[x] keybindings:0 | alt+up → editor.action.moveLinesUpAction | editorTextFocus',
				'[x] extensions:golang.go | golang.go | ',
				'[ ] extensions:skip:ms-vscode.cpptools | ms-vscode.cpptools |  | skipped: Not on Open VSX (Microsoft license)',
			],
			selected: {
				add: [],
				replace: ['editor.tabSize'],
				kept: ['editor.wordWrap', '[python] editor.tabSize'],
				keybindings: 1,
				install: [],
			},
		});
	});

	test('an Undo Import backup is read back only when every field has the right shape', () => {
		const good = { editor: 'vscode', settings: '{}', keybindings: null, snippets: [{ name: 'go.json', previous: null }, { name: 'shared.code-snippets', previous: '{}' }] };
		assert.deepStrictEqual([
			parseClaudeImportBackup(JSON.stringify(good)),
			parseClaudeImportBackup(undefined),
			parseClaudeImportBackup('not json'),
			parseClaudeImportBackup(JSON.stringify({ ...good, editor: 'other' })),
			parseClaudeImportBackup(JSON.stringify({ ...good, settings: 3 })),
			parseClaudeImportBackup(JSON.stringify({ ...good, snippets: [{ name: '../settings.json', previous: null }] })),
			parseClaudeImportBackup(JSON.stringify({ ...good, snippets: [{ name: 'go.json', previous: 1 }] })),
			parseClaudeImportBackup(JSON.stringify({ ...good, extensions: ['esbenp.prettier-vscode'] })),
			parseClaudeImportBackup(JSON.stringify({ ...good, extensions: [] })),
			parseClaudeImportBackup(JSON.stringify({ ...good, extensions: ['bad id'] })),
			parseClaudeImportBackup(JSON.stringify({ ...good, extensions: 'esbenp.prettier-vscode' })),
		], [good, undefined, undefined, undefined, undefined, undefined, undefined, { ...good, extensions: ['esbenp.prettier-vscode'] }, good, undefined, undefined]);
	});

	test('extension IDs come from extensions.json or package.json; skipped ones carry a reason', () => {
		const found = [
			...(claudeImportExtensionsFromIndex('[{ "identifier": { "id": "esbenp.prettier-vscode" }, "version": "10.1.0" }, { "identifier": { "id": "bad id" } }, {}]') ?? []),
			claudeImportExtensionFromManifest('{ "publisher": "golang", "name": "go", "version": "0.41.0" }'),
			claudeImportExtensionFromManifest('{ "publisher": "anysphere", "name": "cursorpyright" }'),
			{ id: 'ms-vscode-remote.remote-ssh' },
			{ id: 'ms-vscode.cpptools' },
			{ id: 'GitHub.copilot-chat' },
			{ id: 'ms-python.vscode-pylance' },
			{ id: 'dbaeumer.vscode-eslint' },
			{ id: 'someone.unpublished' },
		].filter(extension => !!extension);
		const installed = new Set(['dbaeumer.vscode-eslint']);
		const plan = planClaudeExtensionsImport(found, installed, new Set(['esbenp.prettier-vscode', 'golang.go']));
		assert.deepStrictEqual({
			parsedInvalid: [claudeImportExtensionsFromIndex('{}'), claudeImportExtensionFromManifest('{ "name": "x" }')],
			candidates: claudeImportExtensionCandidates(found, installed).map(extension => extension.id),
			install: plan.install.map(extension => extension.id),
			skipped: plan.skipped.map(skip => `${skip.item}: ${skip.reason}`),
			noGallery: planClaudeExtensionsImport(found, installed, 'no-gallery').skipped.filter(skip => skip.reason === 'no-gallery').map(skip => skip.item),
			unreachable: planClaudeExtensionsImport(found, installed, 'gallery-unreachable').install.length,
		}, {
			parsedInvalid: [undefined, undefined],
			candidates: ['esbenp.prettier-vscode', 'golang.go', 'someone.unpublished'],
			install: ['esbenp.prettier-vscode', 'golang.go'],
			skipped: [
				'anysphere.cursorpyright: cursor-extension',
				'ms-vscode-remote.remote-ssh: microsoft-only',
				'ms-vscode.cpptools: microsoft-only',
				'GitHub.copilot-chat: microsoft-only',
				'ms-python.vscode-pylance: microsoft-only',
				'dbaeumer.vscode-eslint: installed',
				'someone.unpublished: not-found',
			],
			noGallery: ['esbenp.prettier-vscode', 'golang.go', 'someone.unpublished'],
			unreachable: 0,
		});
	});

	test('preview and report list what changes and every skipped extension with its reason', () => {
		const plan = {
			editor: 'cursor' as const,
			settings: planClaudeSettingsImport('{ "editor.fontSize": 15, "editor.tabSize": 2, "cursor.x": 1 }', '{ "editor.tabSize": 4 }'),
			keybindings: planClaudeKeybindingsImport('[{ "key": "alt+up", "command": "editor.action.moveLinesUpAction" }]', '[]', 'cursor'),
			snippets: planClaudeSnippetsImport([{ name: 'go.json', resource: URI.file('/s/go.json') }], []),
			extensions: planClaudeExtensionsImport([{ id: 'golang.go' }, { id: 'anysphere.cursorpyright' }, { id: 'ms-vscode.cpptools' }, { id: 'nobody.missing' }], new Set(), new Set(['golang.go'])),
		};
		assert.deepStrictEqual(claudeImportPreview(plan).split('\n'), [
			'Settings: 1 to add, 1 already set in Klawly (kept), 1 skipped.',
			'  Adds: editor.fontSize',
			'  Skips: cursor.x (Cursor feature with no Klawly equivalent)',
			'Keybindings: 1 to add, 0 already in Klawly, 0 skipped.',
			'  Adds: alt+up \u2192 editor.action.moveLinesUpAction',
			'Snippets: 1 files to copy, 0 already in Klawly (kept).',
			'  Copies: go.json',
			'Extensions: 1 to install from the extension gallery, 3 skipped.',
			'  Installs: golang.go',
			'  Skips: anysphere.cursorpyright (Cursor\'s own extension), ms-vscode.cpptools (Not on Open VSX (Microsoft license)), nobody.missing (Not found in the extension gallery)',
			'',
			'Nothing you already set in Klawly is overwritten. A full report is available when the import finishes.',
		]);
		const report = claudeImportReport(plan, { failures: [{ part: 'extensions', item: 'golang.go', message: 'Network down' }] });
		assert.deepStrictEqual(report.split('\n').filter(line => line.startsWith('#') || line.startsWith('- ')), [
			'# Import from Cursor',
			'## Settings',
			'### Added (1)',
			'- `editor.fontSize`',
			'### Already set in Klawly (kept) (1)',
			'- `editor.tabSize`',
			'### Skipped (1)',
			'- `cursor.x`: Cursor feature with no Klawly equivalent',
			'## Keybindings',
			'### Added (1)',
			'- `alt+up \u2192 editor.action.moveLinesUpAction`',
			'## Snippets',
			'### Copied (1)',
			'- `go.json`',
			'## Extensions',
			'### Failed (1)',
			'- `golang.go`: Network down',
			'### Skipped (3)',
			'- `anysphere.cursorpyright`: Cursor\'s own extension',
			'- `ms-vscode.cpptools`: Not on Open VSX (Microsoft license)',
			'- `nobody.missing`: Not found in the extension gallery',
		]);
	});

	suite('themes, rules, MCP servers and profiles (issue 857)', () => {
		const SECRETS = [
			'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'sk-live-9999', 'ghp_envsecret', 'nested-secret-value', 'top-level-secret', 'should be dropped',
			'hunter2', 'AbCdEf0123456789AbCdEf0123456789AbCd', 'query-secret', 'frag-secret', 'header-secret-value', 'custom-secret',
		];

		test('MCP servers: no secret value gets through, including nested env and headers', () => {
			const plan = planClaudeMcpImport([SECRET_MCP_JSON], undefined);
			const written = claudeMcpImportText(undefined, plan.add) ?? '';
			const preview = claudeImportPreview({ editor: 'cursor', mcp: plan });
			assert.deepStrictEqual({
				leaked: SECRETS.filter(secret => JSON.stringify(plan).includes(secret) || written.includes(secret) || preview.includes(secret)),
				names: plan.add.map(server => server.name),
				skipped: plan.skipped.map(skip => `${skip.item}: ${skip.reason}`),
				writtenServers: Object.keys((JSON.parse(written) as { mcpServers: object }).mcpServers),
				placeholders: JSON.stringify(plan.add.map(server => server.entry)).includes('${GITHUB_TOKEN}'),
				leftOutListed: plan.add.every(server => server.leftOut.length > 0) && preview.includes('left out as placeholders'),
			}, {
				leaked: [],
				names: ['github', 'remote'],
				skipped: ['broken: mcp-invalid', 'bad name!: mcp-invalid', 'nocommand: mcp-invalid'],
				writtenServers: ['github', 'remote'],
				placeholders: true,
				leftOutListed: true,
			});
		});

		test('MCP servers: untrusted shapes are rejected, existing servers are kept and undo removes only what was added', () => {
			const target = '{\n\t"mcpServers": {\n\t\t"github": { "type": "http", "url": "https://mine.test" },\n\t\t"other": { "type": "http", "url": "https://other.test" }\n\t}\n}';
			const plan = planClaudeMcpImport([SECRET_MCP_JSON, '{ "servers": { "vs": { "command": "node" } } }', '{ nope', '[]'], target);
			const text = claudeMcpImportText(target, plan.add) ?? '';
			const names = plan.add.map(server => server.name);
			assert.deepStrictEqual({
				kept: plan.kept,
				add: names,
				invalidTarget: planClaudeMcpImport([SECRET_MCP_JSON], '{ not json').invalid,
				servers: Object.keys((JSON.parse(text) as { mcpServers: object }).mcpServers),
				githubUntouched: (JSON.parse(text) as { mcpServers: { github: { url: string } } }).mcpServers.github.url,
				undone: JSON.parse(claudeMcpUndoText(text, names, false) ?? '{}'),
				createdUndo: claudeMcpUndoText(claudeMcpImportText(undefined, plan.add) ?? '', names, true),
				notAnObject: claudeMcpImportText('[1]', plan.add),
				entries: [
					claudeImportMcpEntry({ command: 'x', unknown: { a: 1 }, extra: true })?.entry,
					claudeImportMcpEntry({ type: 'ftp', url: 'ftp://x' }),
					claudeImportMcpEntry({ command: 'x', env: 'not an object' }),
					claudeImportMcpEntry('string'),
					claudeImportMcpEntry({ command: 'x', envFile: '/home/me/.env' })?.leftOut,
				],
			}, {
				kept: ['github'],
				add: ['remote', 'vs'],
				invalidTarget: 'target',
				servers: ['github', 'other', 'remote', 'vs'],
				githubUntouched: 'https://mine.test',
				undone: JSON.parse(target),
				createdUndo: null,
				notAnObject: undefined,
				entries: [{ type: 'stdio', command: 'x' }, undefined, undefined, undefined, ['envFile']],
			});
		});

		test('rules files append a marked section to CLAUDE.md and undo removes exactly it', () => {
			const files = [{ name: '.cursorrules', text: 'Always add tests.' }, { name: 'rules/style.mdc', text: claudeImportRulesBody('---\ndescription: Style\nalwaysApply: true\n---\nPrefer small functions.\n') }];
			const target = 'My own rules';
			const plan = planClaudeRulesImport(files, target);
			const appendix = claudeRulesAppendix('cursor', plan);
			const written = target + appendix;
			const again = planClaudeRulesImport(files, written);
			const createdAppendix = claudeRulesAppendix('cursor', planClaudeRulesImport(files, undefined));
			assert.deepStrictEqual({
				appendixHasBothFiles: appendix.includes('### .cursorrules') && appendix.includes('Prefer small functions.') && !appendix.includes('alwaysApply'),
				again: { add: again.add.length, kept: again.kept.length, appendix: claudeRulesAppendix('cursor', again) },
				undo: claudeRulesRemove(written, appendix, false),
				undoWithLaterText: claudeRulesRemove(`${written}\nLater.`, appendix, false),
				editedSince: claudeRulesRemove(written.replace('Always add tests.', 'Never test.'), appendix, false),
				createdUndo: claudeRulesRemove(createdAppendix, createdAppendix, true),
				previewHasSection: claudeImportPreview({ editor: 'cursor', rules: plan }).includes('Rules: 2 files to append to your CLAUDE.md, 0 already in it.'),
			}, {
				appendixHasBothFiles: true,
				again: { add: 0, kept: 2, appendix: '' },
				undo: target,
				undoWithLaterText: `${target}\nLater.`,
				editedSince: undefined,
				createdUndo: null,
				previewHasSection: true,
			});
		});

		test('themes: installed ones map, missing ones install from the gallery or are skipped with a reason', () => {
			const env = (gallery: ClaudeThemeEnvironment['gallery'], installedExtensions: string[] = []): ClaudeThemeEnvironment => ({
				installed: { color: new Set(['default dark modern']), icon: new Set(['vs-seti']), productIcon: new Set() },
				providers: [
					{ extensionId: 'dracula-theme.theme-dracula', kind: 'color', name: 'Dracula' },
					{ extensionId: 'dracula-theme.theme-dracula', kind: 'icon', name: 'dracula-icons' },
				],
				installedExtensions: new Set(installedExtensions),
				gallery,
			});
			const source = '{ "workbench.colorTheme": "Dracula", "workbench.iconTheme": "dracula-icons", "workbench.productIconTheme": "Mystery" }';
			const reasons = (gallery: ClaudeThemeEnvironment['gallery']) => planClaudeThemesImport(source, '', 'keep', env(gallery)).skipped.map(skip => skip.reason);
			const found = planClaudeThemesImport(source, '', 'keep', env({ has: id => id === 'dracula-theme.theme-dracula' }));
			const installed = planClaudeThemesImport('{ "workbench.colorTheme": "Default Dark Modern" }', '', 'keep', env('no-gallery'));
			assert.deepStrictEqual({
				extensions: claudeImportThemeExtensions(found),
				setCount: found.add.length,
				foundSkipped: found.skipped.map(skip => skip.reason),
				notFound: reasons({ has: () => false }),
				noGallery: reasons('no-gallery'),
				unreachable: reasons('gallery-unreachable'),
				installedNeedsNothing: [installed.add.length, installed.skipped.length, claudeImportThemeExtensions(installed)],
			}, {
				extensions: ['dracula-theme.theme-dracula'],
				setCount: 2,
				foundSkipped: ['theme-not-installed'],
				notFound: ['not-found', 'not-found', 'theme-not-installed'],
				noGallery: ['no-gallery', 'no-gallery', 'theme-not-installed'],
				unreachable: ['gallery-unreachable', 'gallery-unreachable', 'theme-not-installed'],
				installedNeedsNothing: [1, 0, []],
			});
		});

		test('extras: rules, mcp.json and theme manifests are read from allowed places only', async () => {
			const fixture = await createClaudeImportFixture(disposables.add(new DisposableStore()), OperatingSystem.Linux, {});
			const workspace = URI.file('/work/app');
			await writeClaudeImportExtras(fixture, workspace);
			const cursor = await new ClaudeImportReader({ ...fixture.cursor, workspaceFolders: [workspace] }, fixture.files).collect();
			const vscode = await new ClaudeImportReader(fixture.vscode, fixture.files).collect();
			assert.deepStrictEqual({
				cursorRules: cursor.rules.map(file => file.name).sort(),
				cursorMcp: cursor.mcp.length,
				vscodeRules: vscode.rules.map(file => file.name),
				vscodeMcp: vscode.mcp.length,
				vscodeThemes: vscode.themeProviders.map(provider => `${provider.kind}:${provider.name}`).sort(),
				storageOpened: fixture.provider.accessed.filter(entry => entry.resource.path.includes('storage.json')).length,
			}, {
				cursorRules: ['.cursorrules', 'rules/style.mdc'],
				cursorMcp: 2,
				vscodeRules: ['prompts/style.instructions.md'],
				vscodeMcp: 1,
				vscodeThemes: ['color:Dracula', 'icon:dracula-icons'],
				storageOpened: 0,
			});
		});

		test('profiles: only names and folder names come from storage.json, and a profile reads its own folder', async () => {
			const fixture = await createClaudeImportFixture(disposables.add(new DisposableStore()), OperatingSystem.Linux, {});
			await writeClaudeImportExtras(fixture, URI.file('/work/app'));
			const profiles = await new ClaudeImportReader(fixture.vscode, fixture.files).profiles();
			const profile = claudeImportProfileLocations(fixture.vscode, profiles[0]);
			const source = await new ClaudeImportReader(profile, fixture.files).collect();
			assert.deepStrictEqual({
				profiles,
				parse: [claudeImportProfilesFromStorage('{ nope'), claudeImportProfilesFromStorage('{ "userDataProfiles": "x" }'), claudeImportProfilesFromStorage('{ "userDataProfiles": [{ "name": "A", "location": "a/b" }, { "name": "B", "location": "b" }, 7] }')],
				folder: profile.userFolder.path.endsWith('/profiles/ab12cd'),
				name: profile.profileName,
				fontSize: source.settings?.includes('21'),
				mcp: source.mcp.length,
				leaked: JSON.stringify(profiles).includes('machine'),
			}, {
				profiles: [{ name: 'Work', location: 'ab12cd' }],
				parse: [[], [], [{ name: 'B', location: 'b' }]],
				folder: true,
				name: 'Work',
				fontSize: true,
				mcp: 1,
				leaked: false,
			});
		});

		test('backup keeps the CLAUDE.md section and MCP servers the import added, and rejects malformed ones', () => {
			const good = { editor: 'cursor', snippets: [], claudeMd: { appended: '\n<!-- klawly-import:begin Cursor -->\n', created: false }, mcp: { servers: ['github', 'remote'], created: true } };
			const parse = (value: object) => parseClaudeImportBackup(JSON.stringify(value));
			assert.deepStrictEqual({
				good: parse(good)?.mcp,
				badMd: [{ ...good, claudeMd: { appended: 1, created: false } }, { ...good, claudeMd: 'x' }].map(parse),
				badMcp: [{ ...good, mcp: { servers: ['../x'], created: true } }, { ...good, mcp: { servers: 'github', created: true } }, { ...good, mcp: { servers: ['a'] } }].map(parse),
			}, {
				good: { servers: ['github', 'remote'], created: true },
				badMd: [undefined, undefined],
				badMcp: [undefined, undefined, undefined],
			});
		});
	});
});
