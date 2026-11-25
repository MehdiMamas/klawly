/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { SessionStorage } from '../../../../../platform/claude/common/claudeSessionStore.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IClaudeCheckpointService } from '../../common/claudeCheckpointService.js';

export interface AgentWorkspaceStubs {
	trusted?: boolean;
	folders?: readonly string[];
	files?: IFileService;
	configuration?: IConfigurationService;
	/** Storage for what the user last picked; a fresh map by default. */
	storage?: IStorageService;
	/** A trust state the test can change; it wins over `trusted`. */
	trust?: TestTrustState;
}

/** Workspace trust that a test can revoke and restore, firing `onDidChangeTrust`. */
export class TestTrustState extends Disposable {
	private readonly _onDidChangeTrust = this._register(new Emitter<boolean>());
	readonly onDidChangeTrust = this._onDidChangeTrust.event;

	constructor(public trusted = true) {
		super();
	}

	set(trusted: boolean): void {
		this.trusted = trusted;
		this._onDidChangeTrust.fire(trusted);
	}
}

/** Storage held in a map, for the last picks `ClaudeAgentService` remembers. */
export class TestPickStorage {
	readonly values = new Map<string, string>();

	get(key: string, scope: StorageScope, fallbackValue?: string): string | undefined {
		return this.values.get(`${scope}:${key}`) ?? fallbackValue;
	}

	store(key: string, value: string, scope: StorageScope): void {
		this.values.set(`${scope}:${key}`, value);
	}
}

/** The workspace services, a no-op checkpoint service, a file service, a configuration service and the storage `ClaudeAgentService` reads. */
export function agentWorkspaceStubs(options: AgentWorkspaceStubs = {}): [IWorkspaceContextService, IWorkspaceTrustManagementService, IClaudeCheckpointService, IFileService, IConfigurationService, IStorageService] {
	const folders = (options.folders ?? ['/work/project']).map(path => ({ uri: URI.file(path) }));
	class Workspace { getWorkspace() { return { folders }; } }
	class Trust {
		readonly onDidChangeTrust = options.trust?.onDidChangeTrust ?? Event.None;
		isWorkspaceTrusted() { return options.trust ? options.trust.trusted : options.trusted ?? true; }
	}
	class Files { }
	const checkpoints: IClaudeCheckpointService = {
		_serviceBrand: undefined,
		captureDirtyBuffers: async () => [],
		restore: async () => false,
		readCheckpointOriginals: async () => [],
		readTurnsChanges: async () => [], readOtherChatPaths: async () => new Set<string>(), readHelperTurnIds: async () => [], readTurnGitHead: async () => undefined,
		restoreTurns: async () => true,
	};
	return [new Workspace() as unknown as IWorkspaceContextService, new Trust() as unknown as IWorkspaceTrustManagementService, checkpoints, options.files ?? new Files() as unknown as IFileService, options.configuration ?? new TestConfigurationService(), options.storage ?? new TestPickStorage() as unknown as IStorageService];
}

/** Session storage held in a map, for tests that write and reopen durable history. */
export class MemorySessionStorage implements SessionStorage {
	readonly files = new Map<string, string>();
	sessionWrites = 0;

	read(path: string): Promise<string | undefined> {
		return Promise.resolve(this.files.get(path));
	}

	write(path: string, text: string): Promise<void> {
		if (path.includes('session.json')) {
			this.sessionWrites++;
		}
		this.files.set(path, text);
		return Promise.resolve();
	}

	append(path: string, text: string): Promise<void> {
		this.files.set(path, (this.files.get(path) ?? '') + text);
		return Promise.resolve();
	}

	rename(from: string, to: string): Promise<void> {
		const text = this.files.get(from);
		if (text === undefined) {
			return Promise.reject(new Error('missing'));
		}
		this.files.set(to, text);
		this.files.delete(from);
		return Promise.resolve();
	}

	mkdir(): Promise<void> {
		return Promise.resolve();
	}

	remove(path: string): Promise<void> {
		for (const key of [...this.files.keys()]) {
			if (key === path || key.startsWith(`${path}/`) || key.startsWith(`${path}\\`)) {
				this.files.delete(key);
			}
		}
		return Promise.resolve();
	}

	list(dir: string): Promise<readonly string[]> {
		const names = new Set<string>();
		for (const key of this.files.keys()) {
			if (!key.startsWith(dir)) {
				continue;
			}
			const rest = key.slice(dir.length).replace(/^[/\\]/, '');
			if (rest) {
				names.add(rest.split(/[/\\]/)[0]);
			}
		}
		return Promise.resolve([...names]);
	}
}
