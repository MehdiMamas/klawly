/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { IProcessEnvironment, OperatingSystem } from '../../../../../base/common/platform.js';
import { extUriBiasedIgnorePathCase, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileType, IStat } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ClaudeImportEditorId, ClaudeImportLocations, claudeImportLocations } from '../../common/claudeImport.js';

/** Every provider call, so a test can prove which files were opened, listed or even looked at. */
export class RecordingFileSystemProvider extends InMemoryFileSystemProvider {
	readonly accessed: { readonly op: 'stat' | 'read' | 'list'; readonly resource: URI }[] = [];

	override async stat(resource: URI): Promise<IStat> {
		this.accessed.push({ op: 'stat', resource });
		return super.stat(resource);
	}

	override async readFile(resource: URI): Promise<Uint8Array> {
		this.accessed.push({ op: 'read', resource });
		return super.readFile(resource);
	}

	override async readdir(resource: URI): Promise<[string, FileType][]> {
		this.accessed.push({ op: 'list', resource });
		return super.readdir(resource);
	}
}

/** Files that hold tokens or state. The import must never touch them. */
export const FORBIDDEN_FIXTURE_FILES = [
	'state.vscdb',
	'globalStorage/state.vscdb',
	'globalStorage/storage.json',
	'globalStorage/github.copilot-chat/token.json',
	'workspaceStorage/0a1b2c/state.vscdb',
	'Local Storage/leveldb/000003.log',
	'History/1a2b/entries.json',
];

export interface ClaudeImportFixture {
	readonly files: FileService;
	readonly provider: RecordingFileSystemProvider;
	readonly userHome: URI;
	readonly vscode: ClaudeImportLocations;
	readonly cursor: ClaudeImportLocations;
	/** The current Klawly profile. */
	readonly profile: { readonly settingsResource: URI; readonly keybindingsResource: URI; readonly snippetsHome: URI };
}

const vscodeSettings = `{
	// Font
	"editor.fontSize": 15,
	"editor.tabSize": 2,
	"workbench.colorTheme": "Default Dark Modern",
	"github.copilot.enable": { "*": true },
	"chat.agent.enabled": true,
	"claude.agent.enabled": false,
	"telemetry.telemetryLevel": "all",
	"security.workspace.trust.enabled": false,
	"[python]": { "editor.tabSize": 4, "editor.formatOnSave": true },
}`;

const vscodeKeybindings = `[
	{ "key": "ctrl+shift+k", "command": "editor.action.deleteLines" },
	{ "key": "ctrl+alt+n", "command": "workbench.action.files.newUntitledFile", "when": "editorFocus" },
	{ "key": "ctrl+i", "command": "github.copilot.generate" },
	{ "key": "ctrl+l", "command": "workbench.action.chat.open" },
	{ "key": "ctrl+alt+n", "command": "workbench.action.files.newUntitledFile", "when": "editorFocus" },
]`;

const vscodeExtensionsIndex = JSON.stringify([
	{ identifier: { id: 'esbenp.prettier-vscode' }, version: '10.1.0', relativeLocation: 'esbenp.prettier-vscode-10.1.0' },
	{ identifier: { id: 'ms-python.python' }, version: '2024.2.0' },
	{ identifier: { id: 'ms-python.vscode-pylance' }, version: '2024.2.1' },
	{ identifier: { id: 'ms-vscode-remote.remote-ssh' }, version: '0.110.0' },
	{ identifier: { id: 'GitHub.copilot' }, version: '1.170.0' },
	{ identifier: { id: 'dbaeumer.vscode-eslint' }, version: '2.4.4' },
	{ identifier: { id: 'someone.unpublished' }, version: '0.0.1' },
]);

const cursorSettings = `{
	"cursor.cpp.enablePartialAccepts": true,
	"cursor.general.enableShadowWorkspace": true,
	"aipopup.enabled": false,
	"editor.fontFamily": "Fira Code",
	"editor.tabSize": 3,
}`;

const cursorKeybindings = `[
	{ "key": "ctrl+k", "command": "aipopup.action.modal.generate" },
	{ "key": "ctrl+k ctrl+e", "command": "composer.startComposerPrompt" },
	{ "key": "alt+up", "command": "editor.action.moveLinesUpAction", "when": "editorTextFocus && !editorReadonly" },
	{ "key": "shift+ctrl+k", "command": "editor.action.deleteLines" },
]`;

function manifest(publisher: string, name: string, version: string): string {
	return JSON.stringify({ publisher, name, version, main: './out/extension.js' });
}

/**
 * User and extension folders for VS Code and Cursor, next to the files that
 * must never be read, plus a Klawly profile that already sets some values.
 */
export async function createClaudeImportFixture(store: DisposableStore, os: OperatingSystem, env: IProcessEnvironment): Promise<ClaudeImportFixture> {
	const files = store.add(new FileService(new NullLogService()));
	const provider = store.add(new RecordingFileSystemProvider());
	store.add(files.registerProvider(Schemas.file, provider));
	const userHome = URI.file('/home/me');
	const vscode = claudeImportLocations('vscode', os, userHome, env);
	const cursor = claudeImportLocations('cursor', os, userHome, env);
	const klawly = joinPath(userHome, 'klawly', 'User');
	const profile = {
		settingsResource: joinPath(klawly, 'settings.json'),
		keybindingsResource: joinPath(klawly, 'keybindings.json'),
		snippetsHome: joinPath(klawly, 'snippets'),
	};

	// On Windows %APPDATA% is a drive path ('/c:/Users/…'). A file URI's dirname stops
	// at the drive, so neither FileService nor the in-memory provider can create the
	// drive folder. The provider only reads the path, and a non-file URI's parent is '/'.
	for (const folder of [vscode.userFolder, cursor.userFolder]) {
		const drive = URI.from({ scheme: 'fixture', path: `/${folder.path.split('/')[1]}` });
		if (!(await provider.stat(drive).then(() => true, () => false))) {
			await provider.mkdir(drive);
		}
	}

	const write = (resource: URI, text: string) => files.writeFile(resource, VSBuffer.fromString(text));
	const writeAll = async (base: URI, entries: Record<string, string>) => {
		for (const [path, text] of Object.entries(entries)) {
			await write(joinPath(base, ...path.split('/')), text);
		}
	};

	await writeAll(vscode.userFolder, {
		'settings.json': vscodeSettings,
		'keybindings.json': vscodeKeybindings,
		'snippets/python.json': '{ "main": { "prefix": "main", "body": ["if __name__ == \\"__main__\\":"] } }',
		'snippets/shared.code-snippets': '{ "from-vscode": { "prefix": "vs", "body": ["vs"] } }',
		'snippets/notes.txt': 'not a snippet file',
		'snippets/nested/inner.json': '{}',
		...Object.fromEntries(FORBIDDEN_FIXTURE_FILES.map(path => [path, 'secret'])),
	});
	await writeAll(vscode.extensionsFolder, {
		'extensions.json': vscodeExtensionsIndex,
		'.obsolete': '{}',
		'esbenp.prettier-vscode-10.1.0/package.json': manifest('esbenp', 'prettier-vscode', '10.1.0'),
	});

	await writeAll(cursor.userFolder, {
		'settings.json': cursorSettings,
		'keybindings.json': cursorKeybindings,
		...Object.fromEntries(FORBIDDEN_FIXTURE_FILES.map(path => [path, 'secret'])),
	});
	await writeAll(cursor.extensionsFolder, {
		'.obsolete': '{}',
		'anysphere.cursorpyright-1.0.3/package.json': manifest('anysphere', 'cursorpyright', '1.0.3'),
		'ms-python.python-2024.2.0/package.json': manifest('ms-python', 'python', '2024.2.0'),
		'golang.go-0.41.0/package.json': manifest('golang', 'go', '0.41.0'),
		'golang.go-0.41.0/README.md': '# Go',
		'golang.go-0.41.0/node_modules/dep/package.json': manifest('dep', 'dep', '1.0.0'),
		'.hidden-1.0.0/package.json': manifest('hidden', 'hidden', '1.0.0'),
	});

	await write(profile.settingsResource, '{\n\t// Mine\n\t"editor.tabSize": 4,\n\t"[python]": {\n\t\t"editor.tabSize": 8\n\t}\n}');
	await write(profile.keybindingsResource, '[\n\t{ "key": "Shift+Ctrl+K", "command": "editor.action.deleteLines" }\n]');
	await write(joinPath(profile.snippetsHome, 'Shared.code-snippets'), '{ "mine": { "prefix": "mine", "body": ["mine"] } }');

	provider.accessed.length = 0;
	return { files, provider, userHome, vscode, cursor, profile };
}

/** An `mcp.json` full of values that must never reach Klawly (issue 857). */
export const SECRET_MCP_JSON = `{
	// servers
	"mcpServers": {
		"github": {
			"command": "npx",
			"args": ["-y", "@modelcontextprotocol/server-github", "--token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "--api-key=sk-live-9999"],
			"env": { "GITHUB_TOKEN": "ghp_envsecret000000000000000000000000000", "NESTED": { "deep": "nested-secret-value" } },
			"evil": "should be dropped",
			"apiKey": "top-level-secret"
		},
		"remote": {
			"url": "https://user:hunter2@api.example.com/mcp/AbCdEf0123456789AbCdEf0123456789AbCd?api_key=query-secret&mode=fast#frag-secret",
			"headers": { "Authorization": "Bearer header-secret-value", "X-Custom": "custom-secret" }
		},
		"broken": "not an object",
		"bad name!": { "command": "x" },
		"nocommand": { "type": "stdio" }
	}
}`;

/**
 * What Cursor and VS Code keep besides settings: rules, `mcp.json`, a theme
 * extension and profiles. `workspace` is a project folder with its own rules.
 */
export async function writeClaudeImportExtras(fixture: ClaudeImportFixture, workspace: URI): Promise<void> {
	const write = (resource: URI, text: string) => fixture.files.writeFile(resource, VSBuffer.fromString(text));
	const cursorHome = joinPath(fixture.cursor.extensionsFolder, '..');
	await write(joinPath(fixture.vscode.userFolder, 'mcp.json'), SECRET_MCP_JSON);
	await write(joinPath(fixture.vscode.userFolder, 'prompts', 'style.instructions.md'), 'Use tabs.\n');
	await write(joinPath(fixture.vscode.userFolder, 'prompts', 'chat.prompt.md'), 'Not a rules file.');
	await write(joinPath(fixture.vscode.extensionsFolder, 'dracula-theme.theme-dracula-2.0.0', 'package.json'), JSON.stringify({
		publisher: 'dracula-theme', name: 'theme-dracula', version: '2.0.0',
		contributes: { themes: [{ label: 'Dracula', uiTheme: 'vs-dark', path: './dracula.json' }], iconThemes: [{ id: 'dracula-icons', label: 'Dracula Icons', path: './icons.json' }] },
	}));
	await write(joinPath(fixture.vscode.userFolder, 'profiles', 'ab12cd', 'settings.json'), '{ "editor.fontSize": 21, "workbench.colorTheme": "Dracula" }');
	await write(joinPath(fixture.vscode.userFolder, 'profiles', 'ab12cd', 'mcp.json'), SECRET_MCP_JSON);
	await write(joinPath(fixture.vscode.userFolder, 'globalStorage', 'storage.json'), JSON.stringify({
		telemetry: { machineId: 'machine-secret', sqmId: 'sqm-secret' },
		userDataProfiles: [
			{ name: 'Work', location: 'ab12cd', icon: 'briefcase' },
			{ name: 'Escape', location: '../../etc' },
			{ name: '', location: 'empty' },
		],
	}));
	await write(joinPath(cursorHome, 'mcp.json'), '{ "mcpServers": { "files": { "command": "node", "args": ["server.js"] } } }');
	await write(joinPath(cursorHome, 'rules', 'style.mdc'), '---\ndescription: Style\nalwaysApply: true\n---\nPrefer small functions.\n');
	await write(joinPath(cursorHome, 'rules', 'notes.txt'), 'Not a rules file.');
	await write(joinPath(workspace, '.cursorrules'), 'Always add tests.\n');
	await write(joinPath(workspace, '.cursor', 'mcp.json'), '{ "mcpServers": { "project": { "url": "https://example.com/mcp" } } }');
	fixture.provider.accessed.length = 0;
}

/** Provider calls inside one editor's folders, as `op path-relative-to-root`. */
export function accessedUnder(fixture: ClaudeImportFixture, editor: ClaudeImportEditorId): string[] {
	const locations = fixture[editor];
	const roots = [
		{ name: 'user', uri: locations.userFolder },
		{ name: 'extensions', uri: locations.extensionsFolder },
	];
	const out: string[] = [];
	for (const { op, resource } of fixture.provider.accessed) {
		for (const root of roots) {
			const relative = extUriBiasedIgnorePathCase.isEqualOrParent(resource, root.uri) ? extUriBiasedIgnorePathCase.relativePath(root.uri, resource) : undefined;
			if (relative !== undefined) {
				out.push(`${op} ${root.name}/${relative}`);
			}
		}
	}
	return out;
}
