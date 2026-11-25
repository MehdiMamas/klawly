/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { hostname } from 'os';
import { Emitter } from '../../../base/common/event.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../environment/common/environment.js';
import { ICommonEncryptionService } from '../../encryption/common/encryptionService.js';
import { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { claudeUserLayerDirectory } from '../common/claudeUserLayer.js';
import { KlawlySyncGitHubStore } from '../common/klawlySyncGitHubStore.js';
import { parseKlawlySyncPreferences, serializeKlawlySyncPreferences } from '../common/klawlySyncModel.js';
import { IKlawlySyncCredentialStore, KlawlySyncCredentials, KlawlySyncHistoryHost, KlawlySyncRuntime } from '../common/klawlySyncRuntime.js';
import { KLAWLY_SYNC_ENABLED_SETTING, KLAWLY_SYNC_HISTORY_EXCLUDED_SETTING, KLAWLY_SYNC_HISTORY_KEEP_SETTING, KLAWLY_SYNC_HISTORY_MAX_KB_SETTING, KLAWLY_SYNC_HISTORY_SETTING, KLAWLY_SYNC_MEMORY_SETTING } from '../common/klawlySyncService.js';
import { KlawlySyncResource } from '../common/klawlySyncStore.js';
import { exportClaudeHistory, previewClaudeHistory, readImportedClaudeHistory } from './claudeHistoryExport.js';
import { listKlawlySyncMemory } from './klawlySyncMemoryList.js';
import { KlawlySyncFileLocal } from './klawlySyncFileLocal.js';
import { KlawlySyncNodeHttp } from './klawlySyncNodeHttp.js';

/** The folder under `~/.klawly/claude` that holds each kind. The kinds that are single files use their own folder. */
const RESOURCE_FOLDERS: Record<KlawlySyncResource, string> = {
	rules: 'rules',
	settings: 'settings',
	mcp: 'mcp',
	skills: 'skills',
	agents: 'agents',
	commands: 'commands',
	outputStyles: 'output-styles',
	app: 'app',
	memory: 'memory',
	history: 'history',
};

/**
 * Keeps small secrets in files that only this machine can read back. The OS encrypts them through
 * the main process; when it cannot, nothing is written and the values live in memory for this run.
 */
class EncryptedFile {

	constructor(
		private readonly _file: string,
		private readonly _encryption: ICommonEncryptionService,
	) { }

	async read(): Promise<string | undefined> {
		try {
			const text = await fs.readFile(this._file, 'utf8');
			return await this._encryption.decrypt(text);
		} catch {
			return undefined;
		}
	}

	async write(value: string): Promise<void> {
		if (!await this._encryption.isEncryptionAvailable()) {
			return;
		}
		await fs.mkdir(join(this._file, '..'), { recursive: true });
		await fs.writeFile(this._file, await this._encryption.encrypt(value), { mode: 0o600 });
	}

	async remove(): Promise<void> {
		await fs.rm(this._file, { force: true });
	}
}

/**
 * The Klawly Sync runtime as the shared process runs it: real timers, real files under
 * `~/.klawly/claude`, GitHub over HTTPS, and the token encrypted by the OS. The workbench reaches
 * it through the `klawlySync` channel. Nothing is created while `klawly.sync.enabled` is off.
 */
export class KlawlySyncRuntimeService extends KlawlySyncRuntime {

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@INativeEnvironmentService environmentService: INativeEnvironmentService,
		@IProductService productService: IProductService,
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		const encryption = ProxyChannel.toService<ICommonEncryptionService>(mainProcessService.getChannel('encryption'));
		const layer = claudeUserLayerDirectory(environmentService.userHome.fsPath, productService.dataFolderName);
		const syncDir = join(layer, '.sync');

		const enabledChanged = new Emitter<void>();
		const listener = configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(KLAWLY_SYNC_ENABLED_SETTING) || e.affectsConfiguration(KLAWLY_SYNC_MEMORY_SETTING) || e.affectsConfiguration(KLAWLY_SYNC_HISTORY_SETTING) || e.affectsConfiguration(KLAWLY_SYNC_HISTORY_EXCLUDED_SETTING) || e.affectsConfiguration(KLAWLY_SYNC_HISTORY_KEEP_SETTING) || e.affectsConfiguration(KLAWLY_SYNC_HISTORY_MAX_KB_SETTING)) {
				enabledChanged.fire();
			}
		});

		const secretsFile = new EncryptedFile(join(syncDir, 'secrets.enc'), encryption);
		const secrets = new Map<string, string>();
		let secretsLoaded: Promise<void> | undefined;
		let secretsWrite: Promise<void> = Promise.resolve();
		const loadSecrets = () => secretsLoaded ??= secretsFile.read().then(text => {
			try {
				for (const [name, value] of Object.entries(JSON.parse(text ?? '{}') as Record<string, unknown>)) {
					if (typeof value === 'string') {
						secrets.set(name, value);
					}
				}
			} catch {
				// unreadable: start with none, the next pass restores them from the store's placeholders
			}
		});

		const tokenFile = new EncryptedFile(join(syncDir, 'token.enc'), encryption);
		const credentials: IKlawlySyncCredentialStore = {
			load: async () => {
				try {
					const value = JSON.parse(await tokenFile.read() ?? 'null') as Partial<KlawlySyncCredentials> | null;
					return value && typeof value.token === 'string' && typeof value.login === 'string' ? { token: value.token, login: value.login } : undefined;
				} catch {
					return undefined;
				}
			},
			save: value => tokenFile.write(JSON.stringify(value)),
			clear: () => tokenFile.remove(),
		};

		const approvalFile = join(syncDir, 'history-approved');
		const exportOptions = () => {
			const keep = configurationService.getValue<number>(KLAWLY_SYNC_HISTORY_KEEP_SETTING);
			const kilobytes = configurationService.getValue<number>(KLAWLY_SYNC_HISTORY_MAX_KB_SETTING);
			const excluded = configurationService.getValue<string[]>(KLAWLY_SYNC_HISTORY_EXCLUDED_SETTING);
			return {
				layer,
				userDataPath: environmentService.userDataPath,
				machine: hostname(),
				maxSessions: typeof keep === 'number' && keep >= 0 ? Math.floor(keep) : undefined,
				maxBytes: typeof kilobytes === 'number' && kilobytes >= 0 ? Math.floor(kilobytes * 1024) : undefined,
				excludedProjects: Array.isArray(excluded) ? excluded.filter((name): name is string => typeof name === 'string') : [],
			};
		};
		const history: KlawlySyncHistoryHost = {
			isApproved: () => fs.access(approvalFile).then(() => true, () => false),
			approve: async () => {
				await fs.mkdir(syncDir, { recursive: true });
				await fs.writeFile(approvalFile, new Date().toISOString(), 'utf8');
			},
			revoke: () => fs.rm(approvalFile, { force: true }),
			preview: () => previewClaudeHistory(exportOptions()),
			prepare: async () => { await exportClaudeHistory(exportOptions()); },
			clearLocal: async () => {
				await fs.rm(join(layer, RESOURCE_FOLDERS.history), { recursive: true, force: true });
				await fs.rm(join(syncDir, 'base', 'history.json'), { force: true });
			},
		};

		super({
			isEnabled: () => configurationService.getValue<boolean>(KLAWLY_SYNC_ENABLED_SETTING) === true,
			isMemoryEnabled: () => configurationService.getValue<boolean>(KLAWLY_SYNC_MEMORY_SETTING) === true,
			isHistoryEnabled: () => configurationService.getValue<boolean>(KLAWLY_SYNC_HISTORY_SETTING) === true,
			listMemory: () => listKlawlySyncMemory(layer, hostname()),
			listImportedSessions: async () => (await readImportedClaudeHistory(layer, hostname())).map(session => ({ machine: session.machine, id: `${session.machine}/${session.identitySlug}/${session.id}`, title: session.firstPrompt, updatedAt: session.updatedAt })),
			history,
			onDidChangeEnabled: enabledChanged.event,
			http: new KlawlySyncNodeHttp(),
			timers: {
				setTimeout: (callback, ms) => { const handle = setTimeout(callback, ms); return toDisposable(() => clearTimeout(handle)); },
				setInterval: (callback, ms) => { const handle = setInterval(callback, ms); return toDisposable(() => clearInterval(handle)); },
			},
			credentials,
			local: new KlawlySyncFileLocal({
				resourceDir: resource => join(layer, RESOURCE_FOLDERS[resource]),
				syncDir,
				getSecret: name => secrets.get(name),
				setSecret: (name, value) => {
					secrets.set(name, value);
					secretsWrite = secretsWrite.then(() => secretsFile.write(JSON.stringify(Object.fromEntries(secrets)))).catch(error => logService.warn('[KlawlySync] could not save secrets', error));
				},
			}),
			createStore: (http, signedIn) => new KlawlySyncGitHubStore(http, signedIn.token, signedIn.login),
			readPreferences: async () => {
				// The secrets are read once, before the first pass needs them synchronously.
				await loadSecrets();
				return parseKlawlySyncPreferences(await fs.readFile(join(syncDir, 'preferences.json'), 'utf8').catch(() => undefined));
			},
			writePreferences: async preferences => {
				await fs.mkdir(syncDir, { recursive: true });
				await fs.writeFile(join(syncDir, 'preferences.json'), serializeKlawlySyncPreferences(preferences), 'utf8');
			},
			machine: hostname(),
			sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
			random: () => Math.random(),
			now: () => Date.now(),
		});
		this._register(listener);
		this._register(enabledChanged);
	}
}
