/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { CLAUDE_MAKER_ACTIVE_SETTING } from '../../../../platform/claude/common/claudeMakerPrompt.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IKlawlyAccountService } from '../../../services/claude/common/klawlyAccount.js';
import { IWorkbenchGitHubService } from '../../../services/github/common/githubService.js';
import { CLAUDE_MAKER_REPOSITORY, ClaudeMakerRole, ClaudeMakerVerdict, claudeEffectiveMakerRole, claudeMakerNeedsRecheck, claudeMakerVerdict, parseClaudeMakerVerdict } from '../common/claudeMakerRole.js';

export const IClaudeMakerService = createDecorator<IClaudeMakerService>('claudeMakerService');

/**
 * Issue 1184: whether the signed-in GitHub account is Klawly's maker, and the preview toggle that
 * shows the maker the normal-user experience. The role unlocks behaviour only; nothing secret rides on it.
 */
export interface IClaudeMakerService {
	readonly _serviceBrand: undefined;
	/** The verified role of the signed-in account. Signed out is a normal user. */
	readonly role: ClaudeMakerRole;
	/** Whether the maker is looking at the app as a normal user would. */
	readonly previewAsUser: boolean;
	/** Maker mode is on: the account is the maker and is not previewing. */
	readonly active: boolean;
	readonly onDidChange: Event<void>;
	setPreviewAsUser(preview: boolean): void;
}

// Registered here, next to the only writer, so every window that loads the service (the IDE and the Agents window) knows the key before it publishes (#1515).
// Not `included: false`: the settings writer refuses excluded keys as unregistered (#1523).
/** The configuration node for the maker key; exported so a test can register it again after another suite empties the registry (#1548). */
export const claudeMakerConfigurationNode: IConfigurationNode = {
	id: 'claude.maker',
	order: 100,
	type: 'object',
	properties: {
		[CLAUDE_MAKER_ACTIVE_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('claudeMakerActive', "Whether Maker mode is on for the signed-in account. Klawly sets this itself after it checks your access to the Klawly repository; editing it by hand changes nothing."),
		},
	},
};
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration(claudeMakerConfigurationNode);

const VERDICT_KEY = 'klawly.maker.verdict';
const PREVIEW_KEY = 'klawly.maker.previewAsUser';

class ClaudeMakerService extends Disposable implements IClaudeMakerService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _verdict: ClaudeMakerVerdict | undefined;
	private _previewAsUser: boolean;
	private _checking = false;

	constructor(
		@IKlawlyAccountService private readonly _account: IKlawlyAccountService,
		@IAuthenticationService private readonly _authentication: IAuthenticationService,
		@IWorkbenchGitHubService private readonly _github: IWorkbenchGitHubService,
		@IStorageService private readonly _storage: IStorageService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this._verdict = parseClaudeMakerVerdict(this._storage.get(VERDICT_KEY, StorageScope.APPLICATION));
		this._previewAsUser = this._storage.getBoolean(PREVIEW_KEY, StorageScope.APPLICATION, false);
		this._register(this._account.onDidChangeAccount(() => this.refresh()));
		this.refresh();
	}

	private get signedInUserId(): number | undefined {
		const id = Number(this._account.account?.id);
		return Number.isSafeInteger(id) && id > 0 ? id : undefined;
	}

	get role(): ClaudeMakerRole {
		return claudeEffectiveMakerRole(this._verdict, this.signedInUserId);
	}

	get previewAsUser(): boolean {
		return this._previewAsUser;
	}

	get active(): boolean {
		return this.role === 'maker' && !this._previewAsUser;
	}

	setPreviewAsUser(preview: boolean): void {
		if (preview === this._previewAsUser) {
			return;
		}
		this._previewAsUser = preview;
		this._storage.store(PREVIEW_KEY, preview, StorageScope.APPLICATION, StorageTarget.USER);
		this.publish();
	}

	private refresh(): void {
		this.publish();
		if (claudeMakerNeedsRecheck(this._verdict, this.signedInUserId, Date.now())) {
			this.check().catch(error => this._log.warn('Maker role check failed', error));
		}
	}

	private publish(): void {
		this._configuration.updateValue(CLAUDE_MAKER_ACTIVE_SETTING, this.active).catch(error => this._log.warn('Maker mode could not be mirrored', error));
		this._onDidChange.fire();
	}

	/** Verifies the role with the account's own token: `GET /user`, then the repository's permissions. */
	private async check(): Promise<void> {
		if (this._checking) {
			return;
		}
		this._checking = true;
		try {
			const sessions = await this._authentication.getSessions('github', [], { silent: true }, true);
			const session = sessions.find(candidate => candidate.scopes.includes('repo')) ?? sessions[0];
			if (!session) {
				return;
			}
			const client = this._github.acquireBootstrapClient({ apiBaseUri: 'https://api.github.com', token: session.accessToken, accountId: session.account.id });
			try {
				const signal = new AbortController().signal;
				const user = await client.object.get<unknown>('/user', signal);
				const repo = await client.object.get<unknown>(`/repos/${CLAUDE_MAKER_REPOSITORY}`, signal).then(response => response.data, () => undefined);
				const verdict = claudeMakerVerdict(user.data, repo, Date.now());
				if (verdict) {
					this._verdict = verdict;
					this._storage.store(VERDICT_KEY, JSON.stringify(verdict), StorageScope.APPLICATION, StorageTarget.MACHINE);
					this.publish();
				}
			} finally {
				client.dispose();
			}
		} finally {
			this._checking = false;
		}
	}
}

registerSingleton(IClaudeMakerService, ClaudeMakerService, InstantiationType.Eager);
