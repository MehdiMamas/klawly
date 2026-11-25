/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readdir, stat } from 'fs/promises';
import { join } from '../../../base/common/path.js';
import { classifyClaudeCommand, ClaudeCommandInfo, claudeCommandFileSegments, ClaudeSubagentInfo } from '../common/claudeCommands.js';
import { ClaudeQueryAgent, ClaudeQueryCommand } from './claudeQuery.js';

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

/**
 * Gives each listed command its source. A command that is not a skill, a built-in
 * or an MCP prompt is a project command when `<cwd>/.claude/commands` has its file,
 * else a user command when the Claude config folder has it.
 */
export async function readClaudeCommandCatalog(
	commands: readonly ClaudeQueryCommand[],
	skills: readonly string[],
	cwd: string,
	configDirectory: string,
	exists: (path: string) => Promise<boolean> = isFile,
): Promise<ClaudeCommandInfo[]> {
	const skillSet = new Set(skills);
	const project = new Set<string>();
	const user = new Set<string>();
	await Promise.all(commands.map(async command => {
		if (skillSet.has(command.name) || command.builtin || command.name.startsWith('mcp__')) {
			return;
		}
		const segments = claudeCommandFileSegments(command.name);
		if (!segments) {
			return;
		}
		if (await exists(join(cwd, '.claude', 'commands', ...segments))) {
			project.add(command.name);
		} else if (await exists(join(configDirectory, 'commands', ...segments))) {
			user.add(command.name);
		}
	}));
	const facts = { skills: skillSet, project, user };
	return commands.map(command => ({
		name: command.name,
		description: command.description,
		argumentHint: command.argumentHint || undefined,
		aliases: command.aliases?.length ? [...command.aliases] : undefined,
		source: classifyClaudeCommand(command, facts),
	}));
}

/**
 * The names of the skills on disk: a folder with a `SKILL.md` under the project's
 * `.claude/skills` or the Claude config folder's `skills`. A probe query has no
 * `session.started` to name the skills, so this tells them from other commands.
 * Plugin skills are not listed here; their names carry a `:` and sort as plugin commands.
 */
export async function readClaudeSkillNames(
	cwd: string,
	configDirectory: string,
	exists: (path: string) => Promise<boolean> = isFile,
	list: (path: string) => Promise<readonly string[]> = path => readdir(path),
): Promise<string[]> {
	const names = new Set<string>();
	for (const root of [join(cwd, '.claude', 'skills'), join(configDirectory, 'skills')]) {
		let entries: readonly string[];
		try {
			entries = await list(root);
		} catch {
			continue;
		}
		await Promise.all(entries.map(async entry => {
			if (await exists(join(root, entry, 'SKILL.md'))) {
				names.add(entry);
			}
		}));
	}
	return [...names];
}

export function toClaudeSubagentInfo(agent: ClaudeQueryAgent): ClaudeSubagentInfo {
	return agent.model ? { name: agent.name, description: agent.description, model: agent.model } : { name: agent.name, description: agent.description };
}
