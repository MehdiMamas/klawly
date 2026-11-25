/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { addClaudeCloudSessionRecord, ClaudeCloudCapability, ClaudeCloudSessionRecord, claudeCloudUnavailableReason, readClaudeCloudSessionRecords } from '../../../../platform/claude/common/claudeCloud.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IClaudeSetupService } from './claudeSetup.js';

/** The workspace's cloud sessions, newest first. */
const CLOUD_SESSIONS_STORAGE_KEY = 'klawly.cloud.sessions';

/**
 * The Claude Code cloud sessions started or messaged from this workspace
 * (issue 532), so the Agents column can list them next to local agents, and
 * whether Run in can start one at all.
 */
export interface IClaudeCloudSessionsService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** Newest first. */
	getSessions(): readonly ClaudeCloudSessionRecord[];
	/** Remembers a start (no session ID: it ran in a terminal) or a send that Claude Code accepted. */
	record(entry: { readonly sessionId?: string; readonly title: string }): void;
	/** Forgets a session in Klawly's list; the session itself keeps running on claude.ai. */
	remove(id: string): void;
	/** Why Klawly cannot start a cloud session with this Claude Code and sign-in, or undefined when it can. */
	unavailableReason(): Promise<string | undefined>;
}

export const IClaudeCloudSessionsService = createDecorator<IClaudeCloudSessionsService>('claudeCloudSessionsService');

class ClaudeCloudSessionsService extends Disposable implements IClaudeCloudSessionsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@IStorageService private readonly _storage: IStorageService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IClaudeSetupService private readonly _setup: IClaudeSetupService,
	) {
		super();
	}

	getSessions(): readonly ClaudeCloudSessionRecord[] {
		try {
			return readClaudeCloudSessionRecords(JSON.parse(this._storage.get(CLOUD_SESSIONS_STORAGE_KEY, StorageScope.WORKSPACE, '[]')));
		} catch {
			return [];
		}
	}

	record(entry: { readonly sessionId?: string; readonly title: string }): void {
		this.store(addClaudeCloudSessionRecord(this.getSessions(), entry, Date.now(), generateUuid().slice(0, 8)));
	}

	remove(id: string): void {
		this.store(this.getSessions().filter(record => record.id !== id));
	}

	async unavailableReason(): Promise<string | undefined> {
		let capability: ClaudeCloudCapability | undefined;
		try {
			capability = await this._runtime.getCloudCapability?.();
		} catch (error) {
			capability = { cloud: false, teleport: false, error: error instanceof Error ? error.message : String(error) };
		}
		return claudeCloudUnavailableReason(capability, this._setup.runtime?.authMode);
	}

	private store(records: readonly ClaudeCloudSessionRecord[]): void {
		this._storage.store(CLOUD_SESSIONS_STORAGE_KEY, JSON.stringify(records), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._onDidChange.fire();
	}
}

registerSingleton(IClaudeCloudSessionsService, ClaudeCloudSessionsService, InstantiationType.Delayed);
