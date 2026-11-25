/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_KLAWLY_MCP_SERVER } from './claudeTerminalRun.js';

/**
 * Claude changes Klawly settings when asked (issue 525). Two tools on Klawly's own
 * MCP server: `klawly_settings_find` reads settings, with their description and value,
 * and runs without a card; `klawly_settings_set` changes one, and every change asks
 * first on a permission card that names the setting and the new value. The window
 * that owns the chat applies it through its configuration service.
 */
export const CLAUDE_SETTINGS_FIND_TOOL = 'klawly_settings_find';
export const CLAUDE_SETTINGS_SET_TOOL = 'klawly_settings_set';
export const CLAUDE_SETTINGS_FIND_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_SETTINGS_FIND_TOOL}`;
export const CLAUDE_SETTINGS_SET_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_SETTINGS_SET_TOOL}`;

export const CLAUDE_SETTINGS_FIND_DESCRIPTION = 'Find Klawly and editor settings by words in their name or description, with their current value, default and allowed values. Use it before klawly_settings_set, to get the exact key.';
export const CLAUDE_SETTINGS_SET_DESCRIPTION = 'Change one Klawly or editor setting the user asked to change, at user scope (all windows) or workspace scope (this folder). The user approves each change. Settings that control permissions, the sandbox, trust, credentials or what leaves the machine cannot be changed here; the user changes those in Settings.';

/** Most settings one find returns. */
export const CLAUDE_SETTINGS_FIND_LIMIT = 20;

/**
 * Settings Claude may never change, only point the user to: permissions, the
 * sandbox and read rules, trust, which Claude Code runs, telemetry and what leaves
 * the machine, updates, extensions, and anything that runs a program.
 */
const BLOCKED_PREFIXES: readonly string[] = [
	'claude.agent.permissions',
	'claude.agent.defaultPermissionMode',
	'claude.agent.autoApprove',
	'claude.agent.allowEverything',
	'claude.agent.runtime',
	'claude.agent.autoMode',
	'claude.security',
	'claude.sandbox',
	'claude.network',
	'claude.readRules',
	'claude.telemetry',
	'claude.share',
	'claude.otel',
	'claude.instructions',
	'claude.automations',
	'security.',
	'telemetry.',
	'update.',
	'extensions.',
	'http.',
	'terminal.integrated.env',
	'terminal.integrated.profiles',
	'terminal.integrated.defaultProfile',
	'terminal.integrated.automationProfile',
	'terminal.integrated.shell',
	'git.path',
	'npm.',
	'task.',
	'remote.',
	'workbench.trust',
];

/** True for a setting Claude may not change (issue 525). */
export function isClaudeBlockedSetting(key: string): boolean {
	// A plain prefix: `claude.agent.runtime` also covers `claude.agent.runtimePath`.
	return BLOCKED_PREFIXES.some(prefix => key.startsWith(prefix));
}

export type ClaudeSettingsScope = 'user' | 'workspace';

export type ClaudeSettingsToolArgs =
	| { readonly action: 'find'; readonly query: string }
	| { readonly action: 'set'; readonly key: string; readonly value: unknown; readonly scope: ClaudeSettingsScope };

/** What the window that owns the chat is asked to do. */
export type ClaudeSettingsToolRequest = ClaudeSettingsToolArgs & {
	readonly sessionId: string;
	readonly requestId: string;
};

/** One setting as `find` reports it. */
export interface ClaudeSettingInfo {
	readonly key: string;
	readonly description: string;
	readonly value: unknown;
	readonly default: unknown;
	readonly type?: string;
	readonly allowed?: readonly unknown[];
	/** Claude may only point the user to it. */
	readonly blocked?: true;
}

export type ClaudeSettingsToolResult =
	| { readonly kind: 'found'; readonly settings: readonly ClaudeSettingInfo[] }
	| { readonly kind: 'set'; readonly key: string; readonly previous: unknown; readonly value: unknown; readonly scope: ClaudeSettingsScope }
	| { readonly kind: 'refused'; readonly message: string }
	| { readonly kind: 'failed'; readonly message: string };

/** What Claude reads back. A refusal or failure is an error result. */
export function claudeSettingsToolText(result: ClaudeSettingsToolResult): { readonly text: string; readonly isError: boolean } {
	switch (result.kind) {
		case 'found':
			return result.settings.length === 0
				? { text: 'No setting matches. Try other words.', isError: false }
				: { text: result.settings.map(setting => JSON.stringify(setting)).join('\n'), isError: false };
		case 'set':
			return { text: `Changed ${result.key} from ${JSON.stringify(result.previous)} to ${JSON.stringify(result.value)} (${result.scope} settings).`, isError: false };
		case 'refused':
		case 'failed':
			return { text: result.message, isError: true };
	}
}

/** The subject the permission card shows for a change: the key and the new value. */
export function claudeSettingsChangeSubject(input: Readonly<Record<string, unknown>>): string | undefined {
	const key = typeof input.key === 'string' ? input.key.trim() : '';
	if (!key) {
		return undefined;
	}
	const scope = input.scope === 'workspace' ? 'workspace' : 'user';
	return `${key} = ${JSON.stringify(input.value)} (${scope})`;
}
