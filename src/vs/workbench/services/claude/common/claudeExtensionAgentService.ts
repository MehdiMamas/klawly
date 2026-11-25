/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IClaudeAgentService } from './claudeAgentService.js';
import { ClaudeExtensionAgentGate, ClaudeExtensionAgentGrant } from './claudeExtensionAgentGrants.js';

export const IClaudeExtensionAgentService = createDecorator<IClaudeExtensionAgentService>('claudeExtensionAgentService');

/** The answer to an extension's request to start an agent. */
export type ClaudeExtensionAgentResult =
	| { readonly kind: 'started'; readonly sessionId: string }
	| { readonly kind: 'denied' }
	| { readonly kind: 'failed'; readonly message: string };

/**
 * Lets an extension start a Klawly agent with a prompt (issue 860). The call stays inside the
 * window: no network listener. The first call of each extension asks the user; the answer is
 * stored and can be revoked in Settings. The agent starts in the user's default permission mode.
 */
export interface IClaudeExtensionAgentService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeGrants: Event<void>;
	/** Every extension that was asked, with its answer. */
	getGrants(): readonly ClaudeExtensionAgentGrant[];
	/** Forgets an answer; that extension is asked again on its next call. */
	revokeGrant(extensionId: string): void;
	startAgent(extensionId: string, extensionName: string, prompt: string): Promise<ClaudeExtensionAgentResult>;
}

export const CLAUDE_EXTENSION_AGENT_GRANTS_KEY = 'claude.extensionAgentGrants';

export class ClaudeExtensionAgentService extends Disposable implements IClaudeExtensionAgentService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeGrants = this._register(new Emitter<void>());
	readonly onDidChangeGrants = this._onDidChangeGrants.event;

	private readonly _names = new Map<string, string>();
	private readonly _gate: ClaudeExtensionAgentGate;

	constructor(
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IDialogService private readonly _dialogs: IDialogService,
		@IStorageService private readonly _storage: IStorageService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
	) {
		super();
		this._gate = new ClaudeExtensionAgentGate({
			read: () => this._storage.get(CLAUDE_EXTENSION_AGENT_GRANTS_KEY, StorageScope.APPLICATION),
			write: value => {
				if (value === undefined) {
					this._storage.remove(CLAUDE_EXTENSION_AGENT_GRANTS_KEY, StorageScope.APPLICATION);
				} else {
					this._storage.store(CLAUDE_EXTENSION_AGENT_GRANTS_KEY, value, StorageScope.APPLICATION, StorageTarget.USER);
				}
				this._onDidChangeGrants.fire();
			},
		}, id => this.ask(id));
	}

	getGrants(): readonly ClaudeExtensionAgentGrant[] {
		return this._gate.list();
	}

	revokeGrant(extensionId: string): void {
		this._gate.revoke(extensionId);
	}

	async startAgent(extensionId: string, extensionName: string, prompt: string): Promise<ClaudeExtensionAgentResult> {
		if (!prompt.trim()) {
			return { kind: 'failed', message: localize('claudeExtensionAgentEmptyPrompt', "The prompt is empty.") };
		}
		this._names.set(extensionId, extensionName);
		if (!await this._gate.isAllowed(extensionId)) {
			return { kind: 'denied' };
		}
		const folder = this._workspace.getWorkspace().folders.find(candidate => candidate.uri.scheme === Schemas.file);
		if (!folder) {
			return { kind: 'failed', message: localize('claudeExtensionAgentNoFolder', "Open a local folder to start an agent.") };
		}
		try {
			// createSession applies the user's default mode and permission level.
			const session = this._agent.createSession();
			this._agent.pinWorkingDirectory(session.id, folder.uri.fsPath);
			await this._agent.submit(session.id, prompt, folder.uri.fsPath);
			return { kind: 'started', sessionId: session.id };
		} catch (error) {
			return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
		}
	}

	private async ask(extensionId: string): Promise<boolean> {
		const name = this._names.get(extensionId) ?? extensionId;
		const { confirmed } = await this._dialogs.confirm({
			type: 'question',
			message: localize('claudeExtensionAgentPromptMessage', "Allow \"{0}\" to start Klawly agents?", name),
			detail: localize('claudeExtensionAgentPromptDetail', "The extension ({0}) can send a prompt to a new Klawly agent. The agent runs in your default permission mode. You can change this later in Settings, under Privacy.", extensionId),
			primaryButton: localize({ key: 'claudeExtensionAgentAllow', comment: ['&& denotes a mnemonic'] }, "&&Allow"),
			cancelButton: localize('claudeExtensionAgentDeny', "Deny"),
		});
		return confirmed;
	}
}
