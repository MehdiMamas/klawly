/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Worker profiles (issue 843). A lean worker starts with the file and shell
 * tools plus the delegation tools, and with no MCP servers, plugins, skills or
 * slash commands, so it starts on a much smaller context. A full worker starts
 * like its parent chat. Pure, so the service, the runner, the settings and the
 * tests share it.
 */

export type ClaudeWorkerProfile = 'lean' | 'full';

export const CLAUDE_WORKER_PROFILES: readonly ClaudeWorkerProfile[] = ['lean', 'full'];

export const CLAUDE_WORKER_PROFILE_SETTING = 'klawly.delegation.workerProfile';

export const CLAUDE_WORKER_PROFILE_DEFAULT: ClaudeWorkerProfile = 'lean';

/** The profile a setting value or tool argument names, or the default. */
export function readClaudeWorkerProfile(value: unknown, fallback: ClaudeWorkerProfile = CLAUDE_WORKER_PROFILE_DEFAULT): ClaudeWorkerProfile {
	return value === 'lean' || value === 'full' ? value : fallback;
}

/** Claude Code's file, search and shell tools a lean worker keeps. Everything else built in is left out. */
export const CLAUDE_LEAN_WORKER_BUILTIN_TOOLS: readonly string[] = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'Bash', 'BashOutput', 'KillShell', 'TodoWrite'];

/** What a profile changes about the query a worker opens. */
export interface ClaudeWorkerProfileShape {
	/** Built-in tool allow-list for the SDK's `tools` option. Absent keeps every tool. */
	readonly builtinTools?: readonly string[];
	/** False leaves out plugins (their slash commands, skills, agents and MCP servers). */
	readonly plugins: boolean;
	/** False leaves out MCP servers from `.mcp.json`, the user layer and Klawly's settings, debug and canvas tools. The delegation tools and the terminal stay. */
	readonly mcpServers: boolean;
	/** False passes `skills: []`, so no skill is listed to the model. */
	readonly skills: boolean;
	/** False loads only project settings (CLAUDE.md, AGENTS.md rules), not the user's Claude Code setup. */
	readonly userSettings: boolean;
}

export function claudeWorkerProfileShape(profile: ClaudeWorkerProfile): ClaudeWorkerProfileShape {
	return profile === 'lean'
		? { builtinTools: CLAUDE_LEAN_WORKER_BUILTIN_TOOLS, plugins: false, mcpServers: false, skills: false, userSettings: false }
		: { plugins: true, mcpServers: true, skills: true, userSettings: true };
}

/** The setting sources a worker loads, given the ones its parent chat would. */
export function claudeWorkerSettingSources(profile: ClaudeWorkerProfile, sources: readonly ('user' | 'project')[]): readonly ('user' | 'project')[] {
	return claudeWorkerProfileShape(profile).userSettings ? sources : sources.filter(source => source !== 'user');
}

/**
 * Words that mean a task needs the browser or an MCP server, which a lean
 * worker does not have. The parent picks `profile: full` for those; this only
 * warns when it did not.
 */
const NEEDS_FULL = /\b(browser|chrome|playwright|puppeteer|screenshot|mcp|figma|slack|notion|linear|jira|sentry)\b/i;

export function claudeTaskNeedsFullProfile(task: string): boolean {
	return NEEDS_FULL.test(task);
}

/** One line for the delegated chat's card and the Workers view. */
export function claudeWorkerProfileLabel(profile: ClaudeWorkerProfile): string {
	return profile === 'lean' ? 'Lean' : 'Full';
}

/**
 * Rough start-context size in tokens, at four characters a token, from the
 * characters each part adds. A lean worker leaves the optional parts out.
 */
export interface ClaudeStartContextParts {
	/** Claude Code's own prompt and built-in tool definitions the profile keeps. */
	readonly baseChars: number;
	/** Built-in tool definitions a lean worker drops. */
	readonly droppableBuiltinChars: number;
	/** Definitions of MCP tools other than the delegation and terminal tools. */
	readonly mcpChars: number;
	/** Skill, slash command and agent listings from plugins and settings. */
	readonly listingChars: number;
}

export function estimateClaudeStartTokens(profile: ClaudeWorkerProfile, parts: ClaudeStartContextParts): number {
	const shape = claudeWorkerProfileShape(profile);
	let chars = parts.baseChars;
	if (shape.builtinTools === undefined) {
		chars += parts.droppableBuiltinChars;
	}
	if (shape.mcpServers) {
		chars += parts.mcpChars;
	}
	if (shape.plugins || shape.skills) {
		chars += parts.listingChars;
	}
	return Math.ceil(chars / 4);
}
