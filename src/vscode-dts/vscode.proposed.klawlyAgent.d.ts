/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// https://github.com/MehdiMamas/klawly-ide/issues/860

	/**
	 * Start Klawly agents from an extension. The call stays inside the window: there is no
	 * network listener. The first call of each extension asks the user to allow or deny it;
	 * the answer is stored and can be revoked in Klawly Settings.
	 */
	export namespace klawly {

		/**
		 * Starts a new Klawly agent with the given prompt in the first local workspace folder.
		 * The agent runs in the user's default permission mode.
		 *
		 * @param prompt The first message of the agent.
		 * @returns The id of the new agent session. Rejects when the user denies the extension,
		 * no local folder is open, or the agent cannot start.
		 */
		export function startAgent(prompt: string): Thenable<string>;
	}
}
