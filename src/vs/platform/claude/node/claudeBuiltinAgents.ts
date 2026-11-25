/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from '../../../base/common/path.js';
import { KLAWLY_GUIDE_AGENT } from '../common/claudeGuide.js';
import { KLAWLY_GUIDE_DOCS } from '../common/klawlyGuideText.js';

export interface ClaudeBuiltinAgent {
	readonly description: string;
	readonly prompt: string;
	readonly tools?: readonly string[];
	readonly disallowedTools?: readonly string[];
	readonly model?: string;
}

/**
 * Definitions passed in the SDK `agents` option. A user agent file with the
 * same name is left out so the user's definition wins.
 */
export const KLAWLY_BUILTIN_AGENTS: Readonly<Record<string, ClaudeBuiltinAgent>> = {
	reviewer: {
		description: 'Read-only review of the current changes.',
		prompt: 'Review the code the user is working on. Report findings. Do not edit files or run commands that change the project.',
		tools: ['Read', 'Grep', 'Glob'],
		disallowedTools: ['Write', 'Edit', 'MultiEdit', 'Bash'],
	},
	explorer: {
		description: 'Read-only exploration of the project.',
		prompt: 'Explore the codebase and report what you find. Do not edit files.',
		tools: ['Read', 'Grep', 'Glob'],
		disallowedTools: ['Write', 'Edit', 'MultiEdit', 'Bash'],
		model: 'haiku',
	},
	// Issue 524: answers how Klawly works from its own docs, with no tools.
	[KLAWLY_GUIDE_AGENT]: {
		description: 'Answers questions about how Klawly, this IDE, works: its features, settings, commands and choices. Use it when the user asks how to do something in Klawly.',
		prompt: [
			'You answer questions about Klawly, a desktop IDE built on Code - OSS with Claude Code built in. Answer only from the Klawly documentation below.',
			'Be brief and concrete: name the menu, button, command or setting, as the documentation does. When the documentation does not cover the question, say so plainly and do not guess.',
			'Questions about Claude Code itself are answered from what you know about Claude Code.',
			'',
			'<klawly_documentation>',
			KLAWLY_GUIDE_DOCS,
			'</klawly_documentation>',
		].join('\n'),
		tools: [],
		disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch'],
		model: 'haiku',
	},
};

export function selectBuiltinAgents(cwd: string, enabled: boolean, homeDirectory: string = homedir(), configDirectory?: string): Record<string, ClaudeBuiltinAgent> | undefined {
	if (!enabled) {
		return undefined;
	}
	const userRoot = configDirectory && configDirectory.trim().length > 0 ? configDirectory : join(homeDirectory, '.claude');
	const userNames = new Set<string>([
		...agentNames(join(cwd, '.claude', 'agents')),
		...agentNames(join(userRoot, 'agents')),
	]);
	const selected: Record<string, ClaudeBuiltinAgent> = {};
	for (const [name, definition] of Object.entries(KLAWLY_BUILTIN_AGENTS)) {
		if (!userNames.has(name)) {
			selected[name] = definition;
		}
	}
	return Object.keys(selected).length > 0 ? selected : undefined;
}

function agentNames(directory: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch {
		return [];
	}
	const names: string[] = [];
	for (const entry of entries) {
		if (!entry.endsWith('.md')) {
			continue;
		}
		names.push(agentName(join(directory, entry), entry.slice(0, -3)));
	}
	return names;
}

function agentName(file: string, fallback: string): string {
	let text = '';
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		return fallback;
	}
	if (!text.startsWith('---')) {
		return fallback;
	}
	const end = text.indexOf('\n---', 3);
	if (end < 0) {
		return fallback;
	}
	const frontmatter = text.slice(3, end);
	for (const line of frontmatter.split('\n')) {
		const match = /^name:\s*([A-Za-z0-9_-]+)\s*$/.exec(line.trim());
		if (match) {
			return match[1];
		}
	}
	return fallback;
}

