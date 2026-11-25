/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeAutomationScope } from './claudeAutomation.js';

export const CLAUDE_AUTOMATION_CLI_USAGE = 'Usage: klawly automations run --scope <user|workspace> --id <automation id> [--folder <workspace folder>]';

export interface ClaudeAutomationCliArgs {
	readonly scope: ClaudeAutomationScope;
	readonly id: string;
	readonly folder?: string;
}

/**
 * Reads the arguments after `klawly`: `automations run --scope s --id i [--folder f]`, the line
 * the system scheduler starts (issue 463). A string is an error message for the terminal.
 */
export function parseClaudeAutomationCliArgs(args: readonly string[]): ClaudeAutomationCliArgs | string {
	if (args[0] !== 'automations' || args[1] !== 'run') {
		return CLAUDE_AUTOMATION_CLI_USAGE;
	}
	const values = new Map<string, string>();
	for (let i = 2; i < args.length; i += 2) {
		const name = args[i];
		const value = args[i + 1];
		if (!['--scope', '--id', '--folder'].includes(name) || value === undefined || values.has(name)) {
			return CLAUDE_AUTOMATION_CLI_USAGE;
		}
		values.set(name, value);
	}
	const scope = values.get('--scope');
	const id = values.get('--id');
	if ((scope !== 'user' && scope !== 'workspace') || !id) {
		return CLAUDE_AUTOMATION_CLI_USAGE;
	}
	const folder = values.get('--folder');
	if (scope === 'workspace' && !folder) {
		return CLAUDE_AUTOMATION_CLI_USAGE;
	}
	return { scope, id, folder };
}
