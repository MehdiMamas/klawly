/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Issue 1186: the first-run "Coming from Claude Code?" step. It is offered once per profile, and only when
 * Claude Code has left its folder (`~/.claude`) on this machine.
 */
export function claudeShouldOfferComingFromTerminal(claudeHomeExists: boolean, alreadyOffered: boolean): boolean {
	return claudeHomeExists && !alreadyOffered;
}
