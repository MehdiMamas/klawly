/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { localize } from '../../../../nls.js';

/** The OS window title of the Agents window: "Agents - <folder>", or just "Agents" without a folder (issue 1277). */
export function agentsWindowTitle(folderName: string | undefined): string {
	return folderName
		? localize('agentsWindowTitleFolder', "Agents - {0}", folderName)
		: localize('agentsWindowTitle', "Agents");
}
