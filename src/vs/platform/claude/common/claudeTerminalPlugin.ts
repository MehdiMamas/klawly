/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The `/klawly` Claude Code plugin (issue 1186). It ships with Klawly as a
 * one-plugin marketplace on disk; the user adds it with one click (and removes
 * it the same way), after which `/klawly` in a terminal Claude Code session
 * opens that session in Klawly through a `klawly://agent/import` link.
 */

/** The plugin and its marketplace share this name, so the plugin id is `klawly@klawly`. */
export const CLAUDE_TERMINAL_PLUGIN = 'klawly';

/** The plugin id Claude Code lists once the marketplace is added and the plugin installed. */
export const CLAUDE_TERMINAL_PLUGIN_ID = `${CLAUDE_TERMINAL_PLUGIN}@${CLAUDE_TERMINAL_PLUGIN}`;

/** The command that adds the plugin; the consent dialog shows it. */
export const CLAUDE_ADD_TERMINAL_PLUGIN_COMMAND_ID = 'claude.terminalPlugin.add';

/** The command that removes the plugin and its marketplace. */
export const CLAUDE_REMOVE_TERMINAL_PLUGIN_COMMAND_ID = 'claude.terminalPlugin.remove';

/**
 * The files of the marketplace folder, by path relative to it. The slash
 * command is a prompt: it has Claude build the link from the session id and
 * the working folder and open it, so nothing runs without Claude's own tool
 * permission prompt.
 */
export function claudeTerminalPluginFiles(version: string): Readonly<Record<string, string>> {
	const marketplace = {
		name: CLAUDE_TERMINAL_PLUGIN,
		owner: { name: 'Klawly' },
		plugins: [{
			name: CLAUDE_TERMINAL_PLUGIN,
			source: `./${CLAUDE_TERMINAL_PLUGIN}`,
			description: 'Ships with Klawly: /klawly opens this terminal session in Klawly.',
			version,
		}],
	};
	const manifest = {
		name: CLAUDE_TERMINAL_PLUGIN,
		version,
		description: 'Ships with Klawly: /klawly opens this terminal session in Klawly.',
		author: { name: 'Klawly' },
	};
	const command = [
		'---',
		'description: Open this session in Klawly, with the same conversation',
		'allowed-tools: Bash',
		'---',
		'',
		'Open this Claude Code session in Klawly.',
		'',
		'1. Find this session\'s id (the `session_id`) and the absolute path of the working folder.',
		'2. Optionally write a short handoff note to a `.json` file in the system temp folder, shaped as',
		'   `{"version":1,"summary":"...","branch":"...","goals":[],"open":[],"waitingOnUser":[],"decisions":[]}`.',
		'3. Build the link `klawly://agent/import?session=<id>&folder=<URL-encoded folder>` and, when you wrote a note,',
		'   add `&handoff=<URL-encoded absolute path of the .json file>`.',
		'4. Open the link with the system opener (`start` on Windows, `open` on macOS, `xdg-open` on Linux).',
		'5. Tell the user Klawly will ask before it opens the session, and stop.',
		'',
	].join('\n');
	return {
		'.claude-plugin/marketplace.json': JSON.stringify(marketplace, undefined, '\t'),
		[`${CLAUDE_TERMINAL_PLUGIN}/.claude-plugin/plugin.json`]: JSON.stringify(manifest, undefined, '\t'),
		[`${CLAUDE_TERMINAL_PLUGIN}/commands/klawly.md`]: command,
	};
}
