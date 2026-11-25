/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ClaudeRuntimeState } from '../../../../platform/claude/common/claude.js';
import { ClaudeAccountDetails } from '../../../../platform/claude/common/claudeAccount.js';
import { CLAUDE_DEFAULT_ACCOUNT_ID, ClaudeAccountEntry } from '../../../../platform/claude/common/claudeAccounts.js';
import { IKlawlyServiceAccount, IKlawlyServiceAccountAction } from '../../../services/claude/common/klawlyAccount.js';
import { claudePlanLabel } from './claudeSettingsPages.js';
import { CLAUDE_ENABLE_AGENT_COMMAND_ID, CLAUDE_INSTALL_RUNTIME_COMMAND_ID, CLAUDE_LOG_OUT_COMMAND_ID, CLAUDE_OPEN_SETTINGS_COMMAND_ID, CLAUDE_SIGN_IN_COMMAND_ID, CLAUDE_SWITCH_ACCOUNT_COMMAND_ID } from './claudeViews.js';

/** Whether Switch Account and Log Out can act on this sign-in (issue 536). */
export interface ClaudeAccountActions {
	/** False when the sign-in comes from somewhere Claude Code's log out does not reach. */
	readonly enabled: boolean;
	/** Why the actions are off. Present only when `enabled` is false. */
	readonly reason?: string;
}

/**
 * Switch Account and Log Out for a signed-in runtime. Undefined while Claude
 * Code is missing or signed out: Sign In is the action then. An API key, a
 * cloud provider or an organization's gateway is set outside Claude Code's
 * login, so `claude auth logout` would not change who is signed in.
 */
export function claudeAccountActions(state: ClaudeRuntimeState | undefined): ClaudeAccountActions | undefined {
	if (!state?.installed || !state.authenticated) {
		return undefined;
	}
	switch (state.authMode) {
		case 'api-key':
			return { enabled: false, reason: localize('claudeAccountActionsApiKey', "Claude Code signs in with an API key here. Change or remove the key where it is set.") };
		case 'bedrock':
			return { enabled: false, reason: localize('claudeAccountActionsBedrock', "Claude Code signs in through Amazon Bedrock with your AWS credentials. Change them where they are set.") };
		case 'vertex':
			return { enabled: false, reason: localize('claudeAccountActionsVertex', "Claude Code signs in through Google Vertex AI with your Google Cloud credentials. Change them where they are set.") };
		case 'enterprise':
			return { enabled: false, reason: localize('claudeAccountActionsManaged', "Your organization manages this sign-in.") };
		default:
			return { enabled: true };
	}
}

/**
 * The account to show: what the runtime's last session or `auth status`
 * reported, and nothing while signed out, so a log out never leaves the old
 * email on screen.
 */
export function claudeShownAccount(state: ClaudeRuntimeState | undefined, account: ClaudeAccountDetails | undefined): ClaudeAccountDetails | undefined {
	return state?.authenticated ? account : undefined;
}

/** What Log Out and Switch Account need from the workbench. Tests pass fakes. */
export interface ClaudeLogOutHost {
	/** Sessions with a turn running now. */
	runningSessions(): readonly string[];
	/** Asks before running agents are stopped. Resolves true to go ahead. */
	confirm(kind: 'logOut' | 'switchAccount', running: number): Promise<boolean>;
	stop(sessionId: string): Promise<void>;
	/** `claude auth logout`, then a fresh probe. */
	logout(): Promise<ClaudeRuntimeState>;
}

/**
 * Logs Claude Code out (issue 536). Running agents would keep going on the old
 * sign-in, so they stop first, after a confirm. Resolves with the probed
 * state, or undefined when the user kept their agents running.
 */
export async function runClaudeLogOut(host: ClaudeLogOutHost, kind: 'logOut' | 'switchAccount'): Promise<ClaudeRuntimeState | undefined> {
	const running = host.runningSessions();
	if (running.length > 0 && !await host.confirm(kind, running.length)) {
		return undefined;
	}
	await Promise.all(running.map(sessionId => host.stop(sessionId)));
	return host.logout();
}

/** The confirm shown when agents are running. */
export function claudeLogOutConfirmation(kind: 'logOut' | 'switchAccount', running: number): { readonly message: string; readonly detail: string; readonly primaryButton: string } {
	const detail = running === 1
		? localize('claudeLogOutRunningOne', "1 agent is running. It stops, and Claude Code signs out on this computer, in the terminal too.")
		: localize('claudeLogOutRunningMany', "{0} agents are running. They stop, and Claude Code signs out on this computer, in the terminal too.", running);
	return kind === 'logOut'
		? { message: localize('claudeLogOutConfirm', "Log out of Claude?"), detail, primaryButton: localize({ key: 'claudeLogOutButton', comment: ['&& denotes a mnemonic'] }, "&&Log Out") }
		: { message: localize('claudeSwitchAccountConfirm', "Switch Claude account?"), detail, primaryButton: localize({ key: 'claudeSwitchAccountButton', comment: ['&& denotes a mnemonic'] }, "&&Switch Account") };
}

/** The kind of Claude sign-in a row names: the plan when Claude Code reports one, else how it signs in. */
function claudeAccountKind(state: ClaudeRuntimeState, account: ClaudeAccountDetails | undefined): string {
	if (account?.plan) {
		return claudePlanLabel(account.plan);
	}
	switch (state.authMode) {
		case 'api-key': return localize('klawlyClaudeKindApiKey', "API Key");
		case 'bedrock': return localize('klawlyClaudeKindBedrock', "Amazon Bedrock");
		case 'vertex': return localize('klawlyClaudeKindVertex', "Google Vertex AI");
		case 'enterprise': return localize('klawlyClaudeKindEnterprise', "Enterprise");
		default: return localize('klawlyClaudeKindSignedIn', "Signed In");
	}
}

/**
 * The Claude row under the GitHub profile (issue 446, DL-69): "Claude: <kind>" with the
 * actions Claude's own sign-in offers (issue 536). Signing out of GitHub never touches it.
 */
export function klawlyClaudeServiceAccount(state: ClaudeRuntimeState | undefined, account: ClaudeAccountDetails | undefined, agentEnabled: boolean): IKlawlyServiceAccount {
	const row = (kind: string, signedIn: boolean, actions: IKlawlyServiceAccountAction[]): IKlawlyServiceAccount => ({ id: 'claude', label: localize('klawlyClaudeRow', "Claude: {0}", kind), signedIn, actions });
	if (!agentEnabled) {
		return row(localize('klawlyClaudeKindOff', "Off"), false, [{ commandId: CLAUDE_ENABLE_AGENT_COMMAND_ID, label: localize('klawlyClaudeTurnOn', "Turn On Claude Agent") }]);
	}
	if (!state) {
		return row(localize('klawlyClaudeKindChecking', "Checking..."), false, []);
	}
	if (!state.installed) {
		return row(localize('klawlyClaudeKindNotInstalled', "Not Installed"), false, [{ commandId: CLAUDE_INSTALL_RUNTIME_COMMAND_ID, label: localize('klawlyClaudeInstall', "Install Claude Code") }]);
	}
	if (!state.authenticated) {
		return row(localize('klawlyClaudeKindSignedOut', "Signed Out"), false, [{ commandId: CLAUDE_SIGN_IN_COMMAND_ID, label: localize('klawlyClaudeLogIn', "Log In") }]);
	}
	const kind = claudeAccountKind(state, claudeShownAccount(state, account));
	return claudeAccountActions(state)?.enabled
		? row(kind, true, [
			{ commandId: CLAUDE_SWITCH_ACCOUNT_COMMAND_ID, label: localize('klawlyClaudeSwitch', "Switch Account...") },
			{ commandId: CLAUDE_LOG_OUT_COMMAND_ID, label: localize('klawlyClaudeLogOut', "Log Out") },
		])
		// An API key, a cloud provider or an organization signs in outside Claude Code's login; Plan & Usage says where.
		: row(kind, true, [{ commandId: CLAUDE_OPEN_SETTINGS_COMMAND_ID, label: localize('klawlyClaudePlan', "Plan & Usage"), args: ['plan'] }]);
}

/** One row of Switch Claude Account (issue 450, DL-86). */
export interface ClaudeAccountPick {
	readonly kind: 'account' | 'add';
	/** The account id. Absent on Add Account. */
	readonly id?: string;
	readonly label: string;
	readonly description?: string;
	readonly detail?: string;
	readonly active?: boolean;
	/** The account has no working sign-in in its folder: picking it signs in again. */
	readonly signInAgain?: boolean;
}

/**
 * The rows of Switch Claude Account: every account with its plan, the one in
 * use marked, then Add Account. An account whose folder is signed out, or
 * signed in as someone else, says so and signs in again when picked.
 */
export function claudeAccountPicks(accounts: readonly ClaudeAccountEntry[]): ClaudeAccountPick[] {
	const picks = accounts.map((account): ClaudeAccountPick => {
		const label = account.email ?? (account.id === CLAUDE_DEFAULT_ACCOUNT_ID
			? localize('claudeAccountDefault', "Claude Code Sign-In")
			: localize('claudeAccountUnnamed', "Claude Account"));
		const parts = [account.plan ? claudePlanLabel(account.plan) : undefined, account.organization, account.active ? localize('claudeAccountInUse', "In Use") : undefined].filter((part): part is string => !!part);
		const signInAgain = !account.signedIn || account.mismatch === true;
		const detail = !account.signedIn
			? localize('claudeAccountSignedOut', "Signed out. Select to sign in again.")
			: account.mismatch
				? localize('claudeAccountMismatch', "Signed in as another account. Select to sign in again.")
				: undefined;
		return { kind: 'account', id: account.id, label, description: parts.length ? parts.join(' · ') : undefined, detail, active: account.active, signInAgain: signInAgain || undefined };
	});
	return [...picks, { kind: 'add', label: localize('claudeAccountAdd', "Add Account...") }];
}

/** The confirm shown before an account signs out. The default one is Claude Code's own sign-in, in the terminal too. */
export function claudeSignOutConfirmation(pick: ClaudeAccountPick): { readonly message: string; readonly detail: string; readonly primaryButton: string } {
	return {
		message: localize('claudeSignOutConfirm', "Sign out of {0}?", pick.label),
		detail: pick.id === CLAUDE_DEFAULT_ACCOUNT_ID
			? localize('claudeSignOutDefaultDetail', "This is Claude Code's own sign-in, so Claude Code signs out on this computer, in the terminal too.")
			: localize('claudeSignOutAddedDetail', "Klawly removes this account. Your chats, memory and Claude Code setup stay."),
		primaryButton: localize({ key: 'claudeSignOutButton', comment: ['&& denotes a mnemonic'] }, "&&Sign Out"),
	};
}
