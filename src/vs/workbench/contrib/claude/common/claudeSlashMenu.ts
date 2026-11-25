/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ClaudeCommandInfo, ClaudeCommandSource, ClaudeSubagentInfo } from '../../../../platform/claude/common/claudeCommands.js';
import { AgentActionId } from '../../../../platform/claude/common/claudeActions.js';
import { ClaudeOpenForm } from './claudeCustomizeCreate.js';
import { rankContextCandidate } from '../../../../platform/claude/common/claudePrompt.js';

/** The `/` menu's groups, in the order the menu shows them. */
export type ClaudeSlashGroupId = 'builtin' | 'skill' | 'project' | 'user' | 'plugin' | 'other' | 'subagent' | 'ide';

const GROUP_ORDER: readonly ClaudeSlashGroupId[] = ['builtin', 'skill', 'project', 'user', 'plugin', 'other', 'subagent', 'ide'];

/** How many rows a group shows before its "Show N more" row. */
export const CLAUDE_SLASH_GROUP_CAP = 4;

/** An IDE action the `/` menu offers next to Claude Code's own commands (master plan 34a). */
export interface ClaudeSlashAction {
	readonly id: AgentActionId;
	/** The name typed after the slash, such as `review-changes`. */
	readonly name: string;
	readonly description: string;
}

/** A `/create-*` row: it opens the same add form as Customize (issue 680). */
export interface ClaudeSlashForm {
	/** The name typed after the slash, such as `create-skill`. */
	readonly name: string;
	readonly form: ClaudeOpenForm;
	readonly description: string;
}

/** A `/` row that runs a workbench command, such as `/review-branch`. */
export interface ClaudeSlashCommand {
	/** The name typed after the slash. */
	readonly name: string;
	/** The command id it runs. */
	readonly command: string;
	readonly description: string;
}

/** A Klawly prompt the `/` menu offers, such as `/visualize`; Klawly expands it on send. */
export interface ClaudeSlashPrompt {
	/** The name typed after the slash. */
	readonly name: string;
	readonly hint?: string;
	readonly description: string;
}

export interface ClaudeSlashRow {
	readonly id: string;
	readonly group: ClaudeSlashGroupId;
	/** What the row shows first: `/compact` or `@agent-code-reviewer`. */
	readonly label: string;
	/** Claude Code's argument hint, shown in grey after the label. */
	readonly hint?: string;
	readonly description: string;
	/** The text that replaces the typed `/query`. Undefined for IDE actions. */
	readonly insert?: string;
	readonly action?: AgentActionId;
	/** The Customize add form this row opens. */
	readonly form?: ClaudeOpenForm;
	/** The workbench command this row runs. */
	readonly command?: string;
}

export interface ClaudeSlashGroup {
	readonly id: ClaudeSlashGroupId;
	readonly label: string;
	readonly rows: readonly ClaudeSlashRow[];
	/** Rows the cap hides; the menu offers them as "Show N more". */
	readonly hidden: number;
}

export interface ClaudeSlashCatalog {
	readonly commands: readonly ClaudeCommandInfo[];
	readonly agents: readonly ClaudeSubagentInfo[];
	readonly actions: readonly ClaudeSlashAction[];
	readonly prompts?: readonly ClaudeSlashPrompt[];
	readonly forms?: readonly ClaudeSlashForm[];
	readonly workbenchCommands?: readonly ClaudeSlashCommand[];
}

export function claudeSlashGroupLabel(id: ClaudeSlashGroupId): string {
	switch (id) {
		case 'builtin': return localize('claudeSlashBuiltin', "Claude Code");
		case 'skill': return localize('claudeSlashSkills', "Skills");
		case 'project': return localize('claudeSlashProject', "Project commands");
		case 'user': return localize('claudeSlashUser', "User commands");
		case 'plugin': return localize('claudeSlashPlugin', "Plugins and MCP");
		case 'other': return localize('claudeSlashOther', "Commands");
		case 'subagent': return localize('claudeSlashSubagents', "Subagents");
		case 'ide': return localize('claudeSlashIde', "IDE actions");
	}
}

function commandGroup(source: ClaudeCommandSource): ClaudeSlashGroupId {
	return source === 'mcp' ? 'plugin' : source;
}

interface Candidate {
	readonly row: ClaudeSlashRow;
	/** The names the filter matches: the name and its aliases. */
	readonly names: readonly string[];
}

function candidates(catalog: ClaudeSlashCatalog): Candidate[] {
	const result: Candidate[] = [];
	const seen = new Set<string>();
	for (const command of catalog.commands) {
		if (seen.has(command.name)) {
			continue;
		}
		seen.add(command.name);
		const aliases = command.aliases ?? [];
		result.push({
			row: {
				id: `cmd:${command.name}`,
				group: commandGroup(command.source),
				label: `/${command.name}`,
				hint: command.argumentHint,
				description: aliases.length > 0
					? joinDescription(command.description, localize('claudeSlashAliases', "Also /{0}", aliases.join(', /')))
					: command.description,
				insert: `/${command.name} `,
			},
			names: [command.name, ...aliases],
		});
	}
	for (const agent of catalog.agents) {
		result.push({
			row: {
				id: `agent:${agent.name}`,
				group: 'subagent',
				label: `@agent-${agent.name}`,
				hint: agent.model,
				description: agent.description,
				insert: `@agent-${agent.name} `,
			},
			names: [agent.name, `agent-${agent.name}`],
		});
	}
	for (const action of catalog.actions) {
		result.push({
			row: { id: `ide:${action.id}`, group: 'ide', label: `/${action.name}`, description: action.description, action: action.id },
			names: [action.name],
		});
	}
	for (const entry of catalog.workbenchCommands ?? []) {
		result.push({
			row: { id: `command:${entry.name}`, group: 'ide', label: `/${entry.name}`, description: entry.description, command: entry.command },
			names: [entry.name],
		});
	}
	for (const form of catalog.forms ?? []) {
		if (seen.has(form.name)) {
			continue;
		}
		result.push({
			row: { id: `form:${form.name}`, group: 'ide', label: `/${form.name}`, description: form.description, form: form.form },
			names: [form.name],
		});
	}
	for (const prompt of catalog.prompts ?? []) {
		// Claude Code's own command of the same name wins; Klawly does not expand it then.
		if (seen.has(prompt.name)) {
			continue;
		}
		result.push({
			row: { id: `prompt:${prompt.name}`, group: 'ide', label: `/${prompt.name}`, hint: prompt.hint, description: prompt.description, insert: `/${prompt.name} ` },
			names: [prompt.name],
		});
	}
	return result;
}

function joinDescription(description: string, extra: string): string {
	return description ? `${description} · ${extra}` : extra;
}

/**
 * The `/` menu: rows grouped by where they come from, filtered by name or alias,
 * best match first while a query is typed. Each group shows {@link CLAUDE_SLASH_GROUP_CAP}
 * rows unless it is in `expanded`.
 */
/**
 * With no folder open there is no editor selection, no uncommitted change and no branch, so the IDE actions and workbench
 * commands (which all need one) are left out of the menu instead of failing when picked (issue 997, DL-12, DL-14).
 */
export function claudeSlashCatalogForFolder(catalog: ClaudeSlashCatalog, hasFolder: boolean): ClaudeSlashCatalog {
	return hasFolder ? catalog : { ...catalog, actions: [], workbenchCommands: [] };
}

export function claudeSlashGroups(catalog: ClaudeSlashCatalog, query: string, expanded: ReadonlySet<ClaudeSlashGroupId> = new Set()): ClaudeSlashGroup[] {
	const needle = query.trim().toLowerCase();
	const scored = candidates(catalog)
		.map((candidate, order) => ({ candidate, order, score: Math.max(...candidate.names.map(name => rankContextCandidate(needle, name))) }))
		.filter(entry => entry.score > 0);
	const groups: ClaudeSlashGroup[] = [];
	for (const id of GROUP_ORDER) {
		const rows = scored
			.filter(entry => entry.candidate.row.group === id)
			.sort((a, b) => needle ? b.score - a.score || a.order - b.order : a.order - b.order)
			.map(entry => entry.candidate.row);
		if (rows.length === 0) {
			continue;
		}
		const shown = expanded.has(id) ? rows : rows.slice(0, CLAUDE_SLASH_GROUP_CAP);
		groups.push({ id, label: claudeSlashGroupLabel(id), rows: shown, hidden: rows.length - shown.length });
	}
	return groups;
}
