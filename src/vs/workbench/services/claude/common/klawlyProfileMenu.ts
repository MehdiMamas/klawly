/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Action, IAction, SubmenuAction, toAction } from '../../../../base/common/actions.js';
import { localize } from '../../../../nls.js';
import { IKlawlyAccountService, KLAWLY_GITHUB_SIGN_IN_COMMAND_ID, KLAWLY_GITHUB_SIGN_OUT_COMMAND_ID, KLAWLY_PROFILE_OPEN_COMMAND_ID } from './klawlyAccount.js';

/**
 * The top of the Accounts menu (issue 446). DL-69: identity first, service accounts below. The
 * GitHub account is the header with Sign Out (or Sign In with GitHub while signed out), and each
 * service Klawly uses is one smaller row under it, a submenu with that service's own sign-in.
 */
export function klawlyProfileMenuActions(service: Pick<IKlawlyAccountService, 'account' | 'serviceAccounts'>, run: (commandId: string, ...args: unknown[]) => unknown): IAction[] {
	const actions: IAction[] = [];
	const account = service.account;
	if (account) {
		actions.push(toAction({ id: KLAWLY_PROFILE_OPEN_COMMAND_ID, label: localize('klawlyProfileHeader', "@{0} (GitHub)", account.login), run: () => run(KLAWLY_PROFILE_OPEN_COMMAND_ID) }));
		actions.push(toAction({ id: KLAWLY_GITHUB_SIGN_OUT_COMMAND_ID, label: localize('klawlyProfileSignOut', "Sign Out of GitHub"), run: () => run(KLAWLY_GITHUB_SIGN_OUT_COMMAND_ID) }));
	} else {
		actions.push(toAction({ id: KLAWLY_GITHUB_SIGN_IN_COMMAND_ID, label: localize('klawlyProfileSignIn', "Sign In with GitHub"), run: () => run(KLAWLY_GITHUB_SIGN_IN_COMMAND_ID) }));
	}
	for (const row of service.serviceAccounts) {
		const rowActions = row.actions.map(action => toAction({ id: action.commandId, label: action.label, run: () => run(action.commandId, ...(action.args ?? [])) }));
		actions.push(rowActions.length
			? new SubmenuAction(`klawly.profile.${row.id}`, row.label, rowActions)
			: new Action(`klawly.profile.${row.id}`, row.label, undefined, false));
	}
	return actions;
}

/** The Accounts entry's hover: who you are, or how to sign in. */
export function klawlyProfileTitle(service: Pick<IKlawlyAccountService, 'account'>): string {
	return service.account
		? localize('klawlyProfileTitle', "@{0} (GitHub)", service.account.login)
		: localize('klawlyProfileTitleSignedOut', "Sign In with GitHub");
}
