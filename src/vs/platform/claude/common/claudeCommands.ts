/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Where a slash command comes from. The `/` menu groups commands by this. */
export type ClaudeCommandSource = 'builtin' | 'skill' | 'project' | 'user' | 'plugin' | 'mcp' | 'other';

/** One slash command as Claude Code lists it, with its source. */
export interface ClaudeCommandInfo {
	/** The name without the leading slash. */
	readonly name: string;
	readonly description: string;
	/** The arguments Claude Code shows after the name, such as `[file]`. */
	readonly argumentHint?: string;
	/** Other names that run the same command. */
	readonly aliases?: readonly string[];
	readonly source: ClaudeCommandSource;
}

/** A subagent the session can hand work to with `@agent-<name>`. */
export interface ClaudeSubagentInfo {
	readonly name: string;
	readonly description: string;
	/** The model the subagent runs on, when its definition names one. */
	readonly model?: string;
}

/** The `/` menu catalog: commands with their sources, and the subagents `@agent-` can name. */
export interface ClaudeCommandListing {
	readonly commands: readonly ClaudeCommandInfo[];
	readonly agents: readonly ClaudeSubagentInfo[];
}

/** The facts {@link classifyClaudeCommand} needs beyond the command itself. */
export interface ClaudeCommandFacts {
	readonly skills: ReadonlySet<string>;
	/** Command names with a file under `<cwd>/.claude/commands`. */
	readonly project: ReadonlySet<string>;
	/** Command names with a file under the user's Claude config `commands` folder. */
	readonly user: ReadonlySet<string>;
}

/**
 * Where a command comes from. Skills and built-ins are what Claude Code says they
 * are; a file on disk decides project and user commands; MCP prompts and plugin
 * commands are told apart by their names.
 */
export function classifyClaudeCommand(command: { readonly name: string; readonly builtin?: boolean }, facts: ClaudeCommandFacts): ClaudeCommandSource {
	if (facts.skills.has(command.name)) {
		return 'skill';
	}
	if (command.builtin) {
		return 'builtin';
	}
	if (command.name.startsWith('mcp__')) {
		return 'mcp';
	}
	if (facts.project.has(command.name)) {
		return 'project';
	}
	if (facts.user.has(command.name)) {
		return 'user';
	}
	return command.name.includes(':') ? 'plugin' : 'other';
}

/**
 * The relative path segments of a custom command's Markdown file: `frontend:button`
 * lives in `frontend/button.md`. Undefined for a name that is not a safe file name.
 */
export function claudeCommandFileSegments(name: string): readonly string[] | undefined {
	const segments = name.split(':');
	if (segments.some(segment => !/^[\w][\w.-]*$/.test(segment) || segment.includes('..'))) {
		return undefined;
	}
	const last = segments.length - 1;
	return segments.map((segment, index) => index === last ? `${segment}.md` : segment);
}

/**
 * The catalog `session.started` already gives by name, before Claude Code lists the
 * commands in full: skills are known, everything else is unsorted.
 */
export function claudeCommandsFromNames(slashCommands: readonly string[], skills: readonly string[]): ClaudeCommandInfo[] {
	const skillSet = new Set(skills);
	const commands: ClaudeCommandInfo[] = slashCommands.map(name => ({ name, description: '', source: skillSet.has(name) ? 'skill' : 'other' }));
	const listed = new Set(slashCommands);
	for (const skill of skills) {
		if (!listed.has(skill)) {
			commands.push({ name: skill, description: '', source: 'skill' });
		}
	}
	return commands;
}
