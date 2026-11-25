/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { ClaudeAccountDetails } from '../../../../platform/claude/common/claudeAccount.js';
import { CLAUDE_AGENT_ENABLED_SETTING, readClaudeAgentEnabled } from '../../../../platform/claude/common/claudeConfiguration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { redactSecrets } from '../../../services/claude/common/claudeAgentLog.js';
import { IKlawlyAccountService, KLAWLY_GITHUB_SIGN_IN_COMMAND_ID, KLAWLY_GITHUB_SIGN_OUT_COMMAND_ID, KLAWLY_PROFILE_OPEN_COMMAND_ID } from '../../../services/claude/common/klawlyAccount.js';
import { klawlyClaudeServiceAccount } from '../common/claudeAccountActions.js';
import { CLAUDE_OPEN_SETTINGS_COMMAND_ID, KLAWLY_CATEGORY } from '../common/claudeViews.js';
import { IClaudeSetupService } from './claudeSetup.js';

/** True while a GitHub account is the Klawly profile (issue 446). */
export const KLAWLY_GITHUB_SIGNED_IN = new RawContextKey<boolean>('klawly.githubSignedIn', false, localize('klawlyGitHubSignedInKey', "Whether a GitHub account is signed in to Klawly"));

/** Signs in with GitHub. Errors show as a notification, a cancel says nothing. */
export async function runKlawlyGitHubSignIn(accessor: ServicesAccessor): Promise<boolean> {
	const account = accessor.get(IKlawlyAccountService);
	const notifications = accessor.get(INotificationService);
	try {
		return !!await account.signIn();
	} catch (error) {
		notifications.error(localize('klawlyGitHubSignInFailed', "Could not sign in with GitHub: {0}", redactSecrets(error instanceof Error ? error.message : String(error))));
		return false;
	}
}

/** Sign In with GitHub, Sign Out of GitHub and the profile page, in the palette and the Accounts menu. */
export function registerKlawlyProfileCommands(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: KLAWLY_GITHUB_SIGN_IN_COMMAND_ID, title: localize2('klawlyGitHubSignIn', "Sign In with GitHub"), category: KLAWLY_CATEGORY, f1: true, precondition: KLAWLY_GITHUB_SIGNED_IN.negate() });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await runKlawlyGitHubSignIn(accessor);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: KLAWLY_GITHUB_SIGN_OUT_COMMAND_ID, title: localize2('klawlyGitHubSignOut', "Sign Out of GitHub"), category: KLAWLY_CATEGORY, f1: true, precondition: KLAWLY_GITHUB_SIGNED_IN });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const notifications = accessor.get(INotificationService);
			try {
				// Claude keeps its own sign-in: this only ends the GitHub one.
				await accessor.get(IKlawlyAccountService).signOut();
			} catch (error) {
				notifications.error(localize('klawlyGitHubSignOutFailed', "Could not sign out of GitHub: {0}", redactSecrets(error instanceof Error ? error.message : String(error))));
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: KLAWLY_PROFILE_OPEN_COMMAND_ID, title: localize2('klawlyProfileOpen', "Open Klawly Profile"), category: KLAWLY_CATEGORY, f1: true });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(ICommandService).executeCommand(CLAUDE_OPEN_SETTINGS_COMMAND_ID, 'general');
		}
	});
}

/**
 * Keeps the profile's Claude row (DL-69) in step with Claude Code's install and sign-in, and the
 * signed-in context key in step with GitHub.
 */
export class KlawlyProfileContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.klawlyProfile';

	private readonly _row = this._register(new MutableDisposable());
	private _details: ClaudeAccountDetails | undefined;
	private _detailsFor: string | undefined;

	constructor(
		@IKlawlyAccountService private readonly _profile: IKlawlyAccountService,
		@IClaudeSetupService private readonly _setup: IClaudeSetupService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const signedIn = KLAWLY_GITHUB_SIGNED_IN.bindTo(contextKeyService);
		signedIn.set(!!_profile.account);
		this._register(_profile.onDidChangeAccount(account => signedIn.set(!!account)));
		this._register(_setup.onDidChange(() => this.update()));
		this._register(_configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_AGENT_ENABLED_SETTING)) {
				this.update();
			}
		}));
		this.update();
	}

	private update(): void {
		const state = this._setup.runtime;
		const agentEnabled = readClaudeAgentEnabled(this._configuration.getValue(CLAUDE_AGENT_ENABLED_SETTING));
		this._row.value = this._profile.setServiceAccount(klawlyClaudeServiceAccount(state, this._details, agentEnabled));
		// The plan comes from Claude Code's cached `auth status`; ask again only when the sign-in changed.
		const key = state?.authenticated ? `${state.authMode}:${state.version}` : undefined;
		if (key !== this._detailsFor) {
			this._detailsFor = key;
			this._details = undefined;
			if (key) {
				void this._runtime.getAccountOverview?.().then(overview => {
					if (this._detailsFor === key && !this._store.isDisposed) {
						this._details = overview.account;
						this._row.value = this._profile.setServiceAccount(klawlyClaudeServiceAccount(this._setup.runtime, this._details, agentEnabled));
					}
				}, () => undefined);
			}
		}
	}
}
