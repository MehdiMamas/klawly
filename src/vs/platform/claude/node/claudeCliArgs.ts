/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeBuiltinAgent } from './claudeBuiltinAgents.js';
import { ClaudeQueryOptions, ClaudeQueryPermissionMode } from './claudeQuery.js';
import { claudeSecurityOptions } from './claudeSecurityOptions.js';

/** The MCP server that answers permission prompts for Claude Code (`--permission-prompt-tool`). */
export const CLAUDE_PERMISSION_MCP_SERVER = 'klawly_permission';
export const CLAUDE_PERMISSION_TOOL = 'approve';

/** What the args builder needs besides the options: the parts only a running bridge knows. */
export interface ClaudeCliArgumentContext {
	/** `--mcp-config` entries for the servers the bridge hosts, by name. */
	readonly bridgeMcpServers: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	/** The `hooks` settings for the bridge's hook routes. Absent when there is no bridge. */
	readonly hooks?: Readonly<Record<string, unknown>>;
	/** True when the bridge answers permission prompts. Without it, Claude Code is told to prompt no one. */
	readonly permissionBridge: boolean;
}

/** The `--permission-mode` value for Klawly's mode. Absent means Claude Code's default. */
export function claudePermissionModeFlag(mode: ClaudeQueryPermissionMode | undefined): 'bypassPermissions' | 'plan' | undefined {
	return mode === 'unasked' ? 'bypassPermissions' : mode === 'plan' ? 'plan' : undefined;
}

/**
 * The settings JSON for `--settings`: the user layer under Klawly's own flag
 * settings, then the deny rules, the model picker, the sandbox, the hooks and
 * last the organization policy.
 */
export function claudeCliSettings(options: ClaudeQueryOptions, hooks?: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
	const security = claudeSecurityOptions(options.security, options.sandboxDenyRead);
	let settings: Record<string, unknown> = { ...options.userSettings ? structuredClone(options.userSettings) : {}, ...options.flagSettings ? structuredClone(options.flagSettings) : {} };
	if (options.readDenyRules && options.readDenyRules.length > 0) {
		const permissions = (settings.permissions ?? {}) as { deny?: string[] };
		settings = { ...settings, permissions: { ...permissions, deny: [...permissions.deny ?? [], ...options.readDenyRules] } };
	}
	if (options.modelPicker) {
		settings = { ...settings, modelPicker: { options: options.modelPicker.map(model => ({ model })) } };
	}
	if (security.sandbox) {
		settings = { ...settings, sandbox: security.sandbox };
	}
	if (hooks) {
		settings = { ...settings, hooks };
	}
	if (security.managedSettings) {
		settings = { ...settings, ...structuredClone(security.managedSettings) };
	}
	return Object.keys(settings).length > 0 ? settings : undefined;
}

function agentsJson(agents: Readonly<Record<string, ClaudeBuiltinAgent>>): string {
	const copy: Record<string, unknown> = {};
	for (const [name, agent] of Object.entries(agents)) {
		copy[name] = {
			description: agent.description,
			prompt: agent.prompt,
			...agent.tools ? { tools: [...agent.tools] } : {},
			...agent.disallowedTools ? { disallowedTools: [...agent.disallowedTools] } : {},
			...agent.model ? { model: agent.model } : {},
		};
	}
	return JSON.stringify(copy);
}

/**
 * Claude Code's command line for one query, from documented flags only
 * (https://code.claude.com/docs/en/cli-reference). The conversation runs over
 * stdin and stdout as stream-json.
 *
 * `sessionId` is the conversation to continue: the query's own `resume`, or the
 * id seen so far when a flag change restarts the process.
 */
export function buildClaudeCliArguments(options: ClaudeQueryOptions, context: ClaudeCliArgumentContext, sessionId?: string): string[] {
	const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
	const flag = (name: string, value: string | undefined) => {
		if (value !== undefined && value !== '') {
			args.push(name, value);
		}
	};
	const list = (name: string, values: readonly string[] | undefined) => {
		if (values && values.length > 0) {
			args.push(name, values.join(','));
		}
	};
	// A completion turn sends an empty list so it loads no settings file.
	args.push('--setting-sources', (options.settingSources ?? []).join(','));
	if (options.strictMcpConfig) {
		args.push('--strict-mcp-config');
	}
	if (sessionId) {
		args.push('--resume', sessionId);
		if (options.forkSession && sessionId === options.resume) {
			args.push('--fork-session');
		}
	}
	if (options.persistSession === false) {
		args.push('--no-session-persistence');
	}
	list('--tools', options.tools);
	if (options.skills === false) {
		args.push('--disable-slash-commands');
	}
	list('--allowedTools', options.allowedTools);
	list('--disallowedTools', options.disallowedTools);
	for (const directory of options.additionalDirectories ?? []) {
		flag('--add-dir', directory);
	}
	for (const plugin of options.plugins ?? []) {
		flag('--plugin-dir', plugin);
	}
	// Appended, so the turn keeps Claude Code's own prompt and gains only this text.
	flag('--append-system-prompt', options.systemPrompt);
	flag('--max-turns', options.maxTurns?.toString());
	flag('--max-budget-usd', options.maxBudgetUsd?.toString());
	flag('--model', options.model);
	flag('--effort', options.effort);
	const settings = claudeCliSettings(options, context.hooks);
	flag('--settings', settings ? JSON.stringify(settings) : undefined);
	flag('--permission-mode', claudePermissionModeFlag(options.permissionMode));
	if (options.allowUnasked === true || options.permissionMode === 'unasked') {
		args.push('--allow-dangerously-skip-permissions');
	}
	if (context.permissionBridge) {
		flag('--permission-prompt-tool', `mcp__${CLAUDE_PERMISSION_MCP_SERVER}__${CLAUDE_PERMISSION_TOOL}`);
	} else {
		args.push('--permission-prompts', 'none');
	}
	flag('--json-schema', options.outputFormat ? JSON.stringify(options.outputFormat.schema) : undefined);
	if (options.includePartialMessages) {
		args.push('--include-partial-messages');
	}
	if (options.forwardSubagentText) {
		args.push('--forward-subagent-text');
	}
	const mcpServers = { ...structuredCloneRecord(options.userMcpServers), ...context.bridgeMcpServers };
	if (Object.keys(mcpServers).length > 0) {
		flag('--mcp-config', JSON.stringify({ mcpServers }));
	}
	flag('--agents', options.agents ? agentsJson(options.agents) : undefined);
	return args;
}

function structuredCloneRecord(servers: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined): Record<string, Readonly<Record<string, unknown>>> {
	return servers ? structuredClone(servers) as Record<string, Readonly<Record<string, unknown>>> : {};
}
