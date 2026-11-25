/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** What to do when an agent starts editing a file: nothing (Follow is off), open it, or only offer a pill (the user is typing). */
export function claudeFollowAction(enabled: boolean, userTyping: boolean): 'none' | 'open' | 'pill' {
	return !enabled ? 'none' : userTyping ? 'pill' : 'open';
}
