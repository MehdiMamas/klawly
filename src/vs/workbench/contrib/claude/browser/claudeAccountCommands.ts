/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { redactSecrets } from '../../../services/claude/common/claudeAgentLog.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { CLAUDE_DEFAULT_ACCOUNT_ID, ClaudeAccountEntry } from '../../../../platform/claude/common/claudeAccounts.js';
import { claudeAccountActions, ClaudeAccountPick, claudeAccountPicks, claudeLogOutConfirmation, ClaudeLogOutHost, claudeSignOutConfirmation, runClaudeLogOut } from '../common/claudeAccountActions.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { CLAUDE_LOG_OUT_COMMAND_ID, CLAUDE_OPEN_SETTINGS_COMMAND_ID, CLAUDE_SWITCH_ACCOUNT_COMMAND_ID, KLAWLY_CATEGORY } from '../common/claudeViews.js';
import { IClaudeSetupService } from './claudeSetup.js';

/**
 * Logs out through Claude Code itself (issue 536). Resolves true once Claude
 * Code reports it is signed out. Says why and does nothing when this sign-in
 * is an API key, a cloud provider or an organization's.
 */
async function logOut(accessor: ServicesAccessor, kind: 'logOut' | 'switchAccount'): Promise<boolean> {
	const setup = accessor.get(IClaudeSetupService);
	const runtime = accessor.get(IClaudeRuntimeService);
	const agent = accessor.get(IClaudeAgentService);
	const dialogs = accessor.get(IDialogService);
	const notifications = accessor.get(INotificationService);
	if (setup.runtime?.installed && !setup.runtime.authenticated) {
		if (kind === 'logOut') {
			notifications.notify({ severity: Severity.Info, message: localize('claudeLogOutAlready', "Claude Code is not signed in."), source: KLAWLY_CATEGORY.value });
		}
		return true;
	}
	const actions = claudeAccountActions(setup.runtime);
	if (actions && !actions.enabled) {
		notifications.notify({ severity: Severity.Info, message: actions.reason ?? '', source: KLAWLY_CATEGORY.value });
		return false;
	}
	const host: ClaudeLogOutHost = {
		runningSessions: () => agent.getSessions().filter(session => agent.getViewState(session.id).turns.some(turn => turn.status === 'running')).map(session => session.id),
		confirm: async (confirmKind, running) => (await dialogs.confirm({ type: 'warning', ...claudeLogOutConfirmation(confirmKind, running) })).confirmed,
		stop: sessionId => agent.stop(sessionId),
		logout: () => runtime.logout ? runtime.logout() : Promise.reject(new Error(localize('claudeLogOutUnsupported', "This Claude runtime cannot log out."))),
	};
	try {
		const state = await runClaudeLogOut(host, kind);
		if (!state) {
			return false;
		}
		if (state.authenticated) {
			// `auth logout` returned but the probe still finds a sign-in Klawly cannot undo, such as an API key in the environment.
			notifications.notify({ severity: Severity.Warning, message: localize('claudeLogOutStillSignedIn', "Claude Code logged out of its Claude account but is still signed in another way, such as an API key."), source: KLAWLY_CATEGORY.value });
			return false;
		}
		return true;
	} catch (error) {
		notifications.error(redactSecrets(error instanceof Error ? error.message : String(error)));
		return false;
	}
}

interface AccountQuickPickItem extends IQuickPickItem {
	readonly pick: ClaudeAccountPick;
}

/**
 * Switch Claude Account (issue 450, DL-86): every signed-in account, Add
 * Account, and Sign Out on each row. A switch applies to every window: running
 * agents finish their turn on the account they started with, and their next
 * turn resumes the same chat under the new one. Without multi-account support
 * in the runtime it logs out and signs in again, as before.
 */
async function switchAccount(accessor: ServicesAccessor): Promise<void> {
	const setup = accessor.get(IClaudeSetupService);
	const runtime = accessor.get(IClaudeRuntimeService);
	const commands = accessor.get(ICommandService);
	const dialogs = accessor.get(IDialogService);
	const notifications = accessor.get(INotificationService);
	const quickInput = accessor.get(IQuickInputService);
	if (!runtime.listAccounts || !runtime.switchAccount || !runtime.signOutAccount) {
		if (await logOut(accessor, 'switchAccount')) {
			// Plan & Usage shows the new account and plan once the sign-in ends and Claude Code is probed again.
			await commands.executeCommand(CLAUDE_OPEN_SETTINGS_COMMAND_ID, 'plan');
			await setup.signIn();
		}
		return;
	}
	const actions = claudeAccountActions(setup.runtime);
	if (actions && !actions.enabled) {
		notifications.notify({ severity: Severity.Info, message: actions.reason ?? '', source: KLAWLY_CATEGORY.value });
		return;
	}
	const report = (error: unknown) => notifications.error(redactSecrets(error instanceof Error ? error.message : String(error)));
	const signOut = async (pick: ClaudeAccountPick) => {
		if (!pick.id || !(await dialogs.confirm({ type: 'warning', ...claudeSignOutConfirmation(pick) })).confirmed) {
			return;
		}
		try {
			await runtime.signOutAccount!(pick.id);
		} catch (error) {
			report(error);
		}
	};
	let accounts: readonly ClaudeAccountEntry[];
	try {
		accounts = await runtime.listAccounts();
	} catch (error) {
		report(error);
		return;
	}
	const signOutButton = { iconClass: ThemeIcon.asClassName(Codicon.signOut), tooltip: localize('claudeAccountSignOut', "Sign Out") };
	const items = claudeAccountPicks(accounts).map((pick): AccountQuickPickItem => ({
		pick,
		label: pick.kind === 'add' ? `$(add) ${pick.label}` : pick.active ? `$(check) ${pick.label}` : pick.label,
		description: pick.description,
		detail: pick.detail,
		buttons: pick.kind === 'account' && (pick.signInAgain !== true || pick.id !== CLAUDE_DEFAULT_ACCOUNT_ID) ? [signOutButton] : undefined,
	}));
	const chosen = await quickInput.pick(items, {
		title: localize('claudeSwitchAccountTitle', "Switch Claude Account"),
		placeHolder: localize('claudeSwitchAccountPlaceholder', "New turns in every window use the account you pick"),
		activeItem: items.find(item => item.pick.active),
		onDidTriggerItemButton: context => {
			context.removeItem();
			void signOut(context.item.pick);
		},
	});
	const pick = chosen?.pick;
	if (!pick) {
		return;
	}
	try {
		if (pick.kind === 'add') {
			await setup.addAccount();
		} else if (pick.signInAgain) {
			// A signed-out added account signs in anew; the default one is Claude Code's own sign-in.
			if (pick.id === CLAUDE_DEFAULT_ACCOUNT_ID) {
				await runtime.switchAccount(CLAUDE_DEFAULT_ACCOUNT_ID);
				await setup.signIn();
			} else {
				await runtime.signOutAccount(pick.id!);
				await setup.addAccount();
			}
		} else if (!pick.active) {
			await runtime.switchAccount(pick.id!);
			notifications.notify({ severity: Severity.Info, message: localize('claudeAccountSwitched', "Klawly now uses {0}. Running agents finish their turn first.", pick.label), source: KLAWLY_CATEGORY.value });
		}
	} catch (error) {
		report(error);
	}
}

/** Palette entries for Log Out and Switch Account. The status menu and Klawly Settings run them too. */
export function registerClaudeAccountCommands(): void {
	const category = KLAWLY_CATEGORY;

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: CLAUDE_LOG_OUT_COMMAND_ID, title: localize2('claudeLogOut', "Log Out of Claude"), category, f1: true, precondition: CLAUDE_AGENT_ENABLED });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await logOut(accessor, 'logOut');
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: CLAUDE_SWITCH_ACCOUNT_COMMAND_ID, title: { ...localize2('claudeSwitchAccount', "Switch Claude Account..."), original: 'Switch Claude Account... (Accounts, Account, Change Account)' }, category, f1: true, precondition: CLAUDE_AGENT_ENABLED });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await switchAccount(accessor);
		}
	});
}
