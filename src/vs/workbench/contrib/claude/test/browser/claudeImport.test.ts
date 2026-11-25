/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { applyEdits, setProperty } from '../../../../../base/common/jsonEdit.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { OS } from '../../../../../base/common/platform.js';
import { extUriBiasedIgnorePathCase } from '../../../../../base/common/resources.js';
import { env } from '../../../../../base/common/process.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfirmation, IConfirmationResult, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IExtensionGalleryService, IExtensionInfo, IGalleryExtension, ILocalExtension, InstallExtensionInfo, InstallExtensionResult, InstallOperation } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import { INotificationHandle, IPromptChoice, Severity } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IProgressService } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IJSONEditingService, IJSONValue } from '../../../../services/configuration/common/jsonEditing.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchExtensionManagementService } from '../../../../services/extensionManagement/common/extensionManagement.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IUserDataProfile, IUserDataProfilesService } from '../../../../../platform/userDataProfile/common/userDataProfile.js';
import { IUserDataProfileManagementService, IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IWorkbenchThemeService } from '../../../../services/themes/common/workbenchThemeService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ClaudeImportService } from '../../browser/claudeImport.js';
import { ClaudeImportEditorId, claudeImportFileKind, ClaudeImportItem, ClaudeImportMode } from '../../common/claudeImport.js';
import { accessedUnder, ClaudeImportFixture, createClaudeImportFixture, FORBIDDEN_FIXTURE_FILES } from '../common/claudeImportFixtures.js';

class RecordingNotifications extends TestNotificationService {
	readonly messages: string[] = [];
	readonly choices: IPromptChoice[] = [];

	override info(message: string): INotificationHandle {
		this.messages.push(`info: ${message}`);
		return super.info(message);
	}

	override error(error: string | Error): INotificationHandle {
		this.messages.push(`error: ${error}`);
		return super.error(error);
	}

	override prompt(severity: Severity, message: string, choices: IPromptChoice[]): INotificationHandle {
		this.messages.push(`${severity === Severity.Warning ? 'warning' : 'info'}: ${message}`);
		this.choices.push(...choices);
		return super.prompt(severity, message, choices);
	}
}

/** Extensions the fake gallery has. Everything else is "not found". */
const GALLERY = ['esbenp.prettier-vscode', 'ms-python.python', 'golang.go'];

suite('Claude import service', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup(options: { dirty?: boolean; confirm?: boolean; failInstall?: string; userHome?: (home: URI) => URI; mode?: ClaudeImportMode; unpick?: readonly string[] } = {}) {
		const store = disposables.add(new DisposableStore());
		const fixture = await createClaudeImportFixture(store, OS, env);
		const notifications = new RecordingNotifications();
		const previews: string[] = [];
		const pickedParts: string[][] = [];
		const installs: string[] = [];
		const uninstalls: string[] = [];
		const installLocations: (string | undefined)[] = [];
		const reports: string[] = [];
		const switched: string[] = [];
		const jsonEditing: IJSONEditingService = {
			_serviceBrand: undefined,
			write: async (resource: URI, values: IJSONValue[]) => {
				let text = (await fixture.files.exists(resource)) ? (await fixture.files.readFile(resource)).value.toString() : '{}';
				for (const value of values) {
					text = applyEdits(text, setProperty(text, value.path, value.value, { tabSize: 4, insertSpaces: false, eol: '\n' }));
				}
				await fixture.files.writeFile(resource, VSBuffer.fromString(text));
			},
		};
		const quickInput = {
			pick: async (items: (IQuickPickItem & { part?: string; mode?: ClaudeImportMode; importItem?: ClaudeImportItem })[], pickOptions?: { canPickMany?: boolean }) => {
				if (pickOptions?.canPickMany && items.some(item => item.importItem)) {
					// The item tree: keep what is checked, minus what the test unchecks.
					return items.filter(item => item.importItem && item.picked && !options.unpick?.includes(item.importItem.id));
				}
				if (pickOptions?.canPickMany) {
					pickedParts.push(items.map(item => item.part ?? ''));
					return items;
				}
				return items.find(item => item.mode === (options.mode ?? 'keep')) ?? items[0];
			},
		} as unknown as IQuickInputService;
		const dialogs = {
			confirm: async (confirmation: IConfirmation): Promise<IConfirmationResult> => {
				previews.push(typeof confirmation.detail === 'string' ? confirmation.detail : '');
				return { confirmed: options.confirm ?? true };
			},
		} as unknown as IDialogService;
		const progress = { withProgress: <R>(_options: unknown, task: () => Promise<R>) => task() } as unknown as IProgressService;
		const gallery = {
			isEnabled: () => true,
			getExtensions: async (infos: readonly IExtensionInfo[]) => infos
				.filter(info => GALLERY.includes(info.id.toLowerCase()))
				.map(info => ({ identifier: { id: info.id.toLowerCase() } }) as IGalleryExtension),
		} as unknown as IExtensionGalleryService;
		const extensions = {
			getInstalled: async () => ['dbaeumer.vscode-eslint', ...installs].map(id => ({ identifier: { id } }) as ILocalExtension),
			uninstallExtensions: async (infos: { extension: ILocalExtension }[]) => { uninstalls.push(...infos.map(({ extension }) => extension.identifier.id)); },
			installGalleryExtensions: async (infos: InstallExtensionInfo[]): Promise<InstallExtensionResult[]> => infos.map(({ extension, options: installOptions }) => {
				installs.push(extension.identifier.id);
				installLocations.push(installOptions?.profileLocation?.path);
				const error = extension.identifier.id === options.failInstall ? new Error('Network down') : undefined;
				return { identifier: extension.identifier, operation: InstallOperation.Install, profileLocation: URI.file('/profile'), error };
			}),
		} as unknown as IWorkbenchExtensionManagementService;
		const service = store.add(new ClaudeImportService(
			fixture.files,
			{ userHome: () => options.userHome ? options.userHome(fixture.userHome) : fixture.userHome } as unknown as IPathService,
			{ currentProfile: fixture.profile } as unknown as IUserDataProfileService,
			quickInput,
			dialogs,
			notifications,
			progress,
			gallery,
			extensions,
			jsonEditing,
			{ isDirty: (resource: URI) => !!options.dirty && resource.path === fixture.profile.settingsResource.path } as unknown as ITextFileService,
			{ openEditor: async (input: { contents?: string }) => { reports.push(input.contents ?? ''); return undefined; } } as unknown as IEditorService,
			store.add(new InMemoryStorageService()),
			{ profiles: [] } as unknown as IUserDataProfilesService,
			{
				createProfile: async (name: string) => {
					const home = URI.joinPath(fixture.userHome, 'klawly', 'profiles', 'imported');
					return { name, settingsResource: URI.joinPath(home, 'settings.json'), keybindingsResource: URI.joinPath(home, 'keybindings.json'), snippetsHome: URI.joinPath(home, 'snippets'), extensionsResource: URI.joinPath(home, 'extensions.json') } as IUserDataProfile;
				},
				switchProfile: async (profile: IUserDataProfile) => { switched.push(profile.name); },
			} as unknown as IUserDataProfileManagementService,
			{ dataFolderName: '.klawly' } as unknown as IProductService,
			{ getColorThemes: async () => [], getFileIconThemes: async () => [], getProductIconThemes: async () => [] } as unknown as IWorkbenchThemeService,
			{ getWorkspace: () => ({ folders: [] }) } as unknown as IWorkspaceContextService,
		));
		const read = async (resource: URI) => (await fixture.files.exists(resource)) ? (await fixture.files.readFile(resource)).value.toString() : undefined;
		return { fixture, service, notifications, previews, pickedParts, installs, uninstalls, installLocations, reports, switched, read };
	}

	/** Every file the import opened or listed inside one editor's folders. */
	function opened(fixture: ClaudeImportFixture, editor: ClaudeImportEditorId) {
		const accessed = accessedUnder(fixture, editor);
		return {
			opened: accessed.filter(entry => !entry.startsWith('stat ')).sort(),
			everyReadAllowed: fixture.provider.accessed
				.filter(entry => entry.op === 'read' && [fixture[editor].userFolder, fixture[editor].extensionsFolder].some(root => extUriBiasedIgnorePathCase.isEqualOrParent(entry.resource, root)))
				.every(entry => claudeImportFileKind(entry.resource, fixture[editor]) !== undefined),
			touchedForbidden: accessed.filter(entry => !entry.endsWith('globalStorage/storage.json')).filter(entry => FORBIDDEN_FIXTURE_FILES.some(path => entry.endsWith(path))
				|| /globalStorage|workspaceStorage|Local Storage|History|node_modules|README|\.obsolete|\.hidden/.test(entry)),
		};
	}

	test('a scan that fails at once finds nothing, and the next detect scans again', async () => {
		let failures = 1;
		const { service } = await setup({
			userHome: home => {
				if (failures > 0) {
					failures--;
					throw new Error('no home');
				}
				return home;
			},
		});
		const first = await service.detect();
		const second = await service.detect();
		assert.deepStrictEqual({ first, second, detected: service.detected }, { first: [], second: ['vscode', 'cursor'], detected: ['vscode', 'cursor'] });
	});

	test('detects both editors and imports from VS Code without overwriting Klawly values', async () => {
		const { fixture, service, notifications, previews, pickedParts, installs, reports, read } = await setup();
		assert.deepStrictEqual(await service.detect(), ['vscode', 'cursor']);
		await service.run('vscode');

		assert.deepStrictEqual({
			pickedParts,
			settings: JSON.parse((await read(fixture.profile.settingsResource) ?? '').replace('// Mine', '')),
			settingsComment: (await read(fixture.profile.settingsResource))?.includes('// Mine'),
			keybindings: JSON.parse(await read(fixture.profile.keybindingsResource) ?? ''),
			pythonSnippet: (await read(URI.joinPath(fixture.profile.snippetsHome, 'python.json')))?.includes('__main__'),
			sharedSnippetKept: await read(URI.joinPath(fixture.profile.snippetsHome, 'Shared.code-snippets')),
			installs,
			imported: service.imported,
			messages: notifications.messages,
			...opened(fixture, 'vscode'),
		}, {
			pickedParts: [['settings', 'keybindings', 'snippets', 'extensions', 'themes']],
			settings: {
				'editor.tabSize': 4,
				'[python]': { 'editor.tabSize': 8, 'editor.formatOnSave': true },
				'editor.fontSize': 15,
			},
			settingsComment: true,
			keybindings: [
				{ key: 'Shift+Ctrl+K', command: 'editor.action.deleteLines' },
				{ key: 'ctrl+alt+n', command: 'workbench.action.files.newUntitledFile', when: 'editorFocus' },
			],
			pythonSnippet: true,
			sharedSnippetKept: '{ "mine": { "prefix": "mine", "body": ["mine"] } }',
			installs: ['esbenp.prettier-vscode', 'ms-python.python'],
			imported: true,
			messages: ['info: Imported from VS Code: 2 settings, 1 keybindings, 1 snippet files, 2 extensions, 0 themes, 0 rules files, 0 MCP servers. 13 items were skipped.'],
			opened: [
				'list extensions/',
				'list user/snippets',
				'read extensions/esbenp.prettier-vscode-10.1.0/package.json',
				'read extensions/extensions.json',
				'read user/globalStorage/storage.json',
				'read user/keybindings.json',
				'read user/mcp.json',
				'read user/settings.json',
				'read user/snippets/python.json',
			],
			everyReadAllowed: true,
			touchedForbidden: [],
		});
		assert.ok(previews[0].startsWith('Settings: 2 to add, 2 already set in Klawly (kept), 5 skipped.'), previews[0]);

		await notifications.choices[0].run();
		const report = reports[0].split('\n');
		assert.deepStrictEqual(report.slice(report.indexOf('## Extensions')), [
			'## Extensions',
			'',
			'### Installed (2)',
			'',
			'- `esbenp.prettier-vscode`',
			'- `ms-python.python`',
			'',
			'### Skipped (5)',
			'',
			'- `ms-python.vscode-pylance`: Not on Open VSX (Microsoft license)',
			'- `ms-vscode-remote.remote-ssh`: Not on Open VSX (Microsoft license)',
			'- `GitHub.copilot`: Not on Open VSX (Microsoft license)',
			'- `dbaeumer.vscode-eslint`: Already installed',
			'- `someone.unpublished`: Not found in the extension gallery',
			'',
			'## Themes',
			'',
			'### Skipped (1)',
			'',
			'- `workbench.colorTheme (Default Dark Modern)`: Theme not installed in Klawly, and no extension of the other editor provides it',
			'',
		]);
	});

	test('imports from Cursor: skips Cursor and AI keys, anysphere extensions, and reports failed installs', async () => {
		const { fixture, service, notifications, installs, reports, read } = await setup({ failInstall: 'golang.go' });
		await service.run('cursor');
		await notifications.choices[0].run();
		const report = reports[0];
		assert.deepStrictEqual({
			settings: JSON.parse((await read(fixture.profile.settingsResource) ?? '').replace('// Mine', '')),
			keybindings: JSON.parse(await read(fixture.profile.keybindingsResource) ?? ''),
			installs,
			messages: notifications.messages,
			reportLines: report.split('\n').filter(line => line.startsWith('- ')),
			...opened(fixture, 'cursor'),
		}, {
			settings: {
				'editor.tabSize': 4,
				'[python]': { 'editor.tabSize': 8 },
				'editor.fontFamily': 'Fira Code',
			},
			keybindings: [
				{ key: 'Shift+Ctrl+K', command: 'editor.action.deleteLines' },
				{ key: 'alt+up', command: 'editor.action.moveLinesUpAction', when: 'editorTextFocus && !editorReadonly' },
			],
			installs: ['ms-python.python', 'golang.go'],
			messages: ['warning: Imported from Cursor: 1 settings, 1 keybindings, 0 snippet files, 1 extensions, 0 themes, 0 rules files, 0 MCP servers. 1 items failed and 6 were skipped.'],
			reportLines: [
				'- `editor.fontFamily`',
				'- `editor.tabSize`',
				'- `cursor.cpp.enablePartialAccepts`: Cursor feature with no Klawly equivalent',
				'- `cursor.general.enableShadowWorkspace`: Cursor feature with no Klawly equivalent',
				'- `aipopup.enabled`: Cursor feature with no Klawly equivalent',
				'- `alt+up → editor.action.moveLinesUpAction`',
				'- `ctrl+k → aipopup.action.modal.generate`: Cursor feature with no Klawly equivalent',
				'- `ctrl+k ctrl+e → composer.startComposerPrompt`: Cursor feature with no Klawly equivalent',
				'- `ms-python.python`',
				'- `golang.go`: Network down',
				'- `anysphere.cursorpyright`: Cursor\'s own extension',
			],
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

	test('nothing is written when the preview is declined or Klawly settings have unsaved changes', async () => {
		const declined = await setup({ confirm: false });
		const before = await declined.read(declined.fixture.profile.settingsResource);
		await declined.service.run('vscode');
		const unsaved = await setup({ dirty: true });
		await unsaved.service.run('vscode');
		assert.deepStrictEqual({
			declinedSettings: await declined.read(declined.fixture.profile.settingsResource) === before,
			declinedInstalls: declined.installs,
			declinedImported: declined.service.imported,
			unsavedPreview: unsaved.previews[0].split('\n')[0],
			unsavedSettings: await unsaved.read(unsaved.fixture.profile.settingsResource) === before,
		}, {
			declinedSettings: true,
			declinedInstalls: [],
			declinedImported: false,
			unsavedPreview: 'Klawly\'s settings.json has unsaved changes; save it, then import again. It is skipped.',
			unsavedSettings: true,
		});
	});

	test('Overwrite replaces only the checked values, and Undo Import puts every file back', async () => {
		const { fixture, service, notifications, previews, installs, uninstalls, read } = await setup({ mode: 'overwrite', unpick: ['settings:[python] editor.tabSize'] });
		const before = {
			settings: await read(fixture.profile.settingsResource),
			keybindings: await read(fixture.profile.keybindingsResource),
			shared: await read(URI.joinPath(fixture.profile.snippetsHome, 'Shared.code-snippets')),
		};
		await service.run('vscode');
		const imported = {
			settings: JSON.parse((await read(fixture.profile.settingsResource) ?? '').replace('// Mine', '')),
			shared: await read(URI.joinPath(fixture.profile.snippetsHome, 'Shared.code-snippets')),
			python: (await read(URI.joinPath(fixture.profile.snippetsHome, 'python.json'))) !== undefined,
			canUndo: service.canUndo,
			choices: notifications.choices.map(choice => choice.label),
			preview: previews[0].split('\n').filter(line => /^Settings:|^ {2}Replaces:|replace yours/.test(line)),
		};
		const installed = [...installs];
		await notifications.choices[1].run();
		assert.deepStrictEqual({
			imported,
			uninstalled: { installed, uninstalls },
			restored: {
				settings: await read(fixture.profile.settingsResource),
				keybindings: await read(fixture.profile.keybindingsResource),
				shared: await read(URI.joinPath(fixture.profile.snippetsHome, 'Shared.code-snippets')),
			},
			python: await read(URI.joinPath(fixture.profile.snippetsHome, 'python.json')),
			canUndo: service.canUndo,
			lastMessage: notifications.messages.at(-1),
		}, {
			imported: {
				settings: {
					'editor.tabSize': 2,
					'[python]': { 'editor.tabSize': 8, 'editor.formatOnSave': true },
					'editor.fontSize': 15,
				},
				shared: '{ "from-vscode": { "prefix": "vs", "body": ["vs"] } }',
				python: true,
				canUndo: true,
				choices: ['Show Report', 'Undo Import'],
				preview: [
					'Settings: 2 to add, 1 to replace, 1 kept, 5 skipped.',
					'  Replaces: editor.tabSize',
					'  Replaces: Shared.code-snippets',
					'The values you picked replace yours. Your settings.json, keybindings.json and snippet files are backed up first, and Undo Import puts them back.',
				],
			},
			uninstalled: { installed: ['esbenp.prettier-vscode', 'ms-python.python'], uninstalls: ['esbenp.prettier-vscode', 'ms-python.python'] },
			restored: before,
			python: undefined,
			canUndo: false,
			lastMessage: 'info: Undid the import from VS Code, including the extensions it installed.',
		});
	});

	test('New Profile imports into a new profile and leaves the current one alone', async () => {
		const { fixture, service, notifications, installLocations, switched, read } = await setup({ mode: 'profile' });
		const current = await read(fixture.profile.settingsResource);
		await service.run('vscode');
		const home = URI.joinPath(fixture.userHome, 'klawly', 'profiles', 'imported');
		const created = {
			settings: JSON.parse(await read(URI.joinPath(home, 'settings.json')) ?? ''),
			keybindings: JSON.parse(await read(URI.joinPath(home, 'keybindings.json')) ?? '').length,
			shared: await read(URI.joinPath(home, 'snippets', 'shared.code-snippets')),
		};
		await notifications.choices[1].run();
		assert.deepStrictEqual({
			created,
			currentUnchanged: await read(fixture.profile.settingsResource) === current,
			installLocations,
			canUndo: service.canUndo,
			choices: notifications.choices.map(choice => choice.label),
			switched,
		}, {
			created: {
				settings: {
					'editor.fontSize': 15,
					'editor.tabSize': 2,
					'[python]': { 'editor.tabSize': 4, 'editor.formatOnSave': true },
				},
				keybindings: 2,
				shared: '{ "from-vscode": { "prefix": "vs", "body": ["vs"] } }',
			},
			currentUnchanged: true,
			// The new profile has no extensions yet, so only the ones the gallery lacks are skipped.
			installLocations: [URI.joinPath(home, 'extensions.json').path, URI.joinPath(home, 'extensions.json').path],
			canUndo: false,
			choices: ['Show Report', 'Switch to VS Code (Imported)'],
			switched: ['VS Code (Imported)'],
		});
	});

	test('an editor that is not installed is reported, not imported', async () => {
		const { fixture, service, notifications } = await setup();
		await fixture.files.del(fixture.cursor.userFolder, { recursive: true });
		await service.run('cursor');
		assert.deepStrictEqual({ detected: service.detected, messages: notifications.messages }, {
			detected: ['vscode'],
			messages: ['info: Cursor was not found on this computer.'],
		});
	});
});
