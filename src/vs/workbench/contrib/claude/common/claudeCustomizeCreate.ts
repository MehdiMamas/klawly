/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { claudeUserLayerLabel } from '../../../../platform/claude/common/claudeUserLayer.js';

/** The kinds Customize's add forms write as files Claude Code reads (issue 500). */
export type ClaudeCreateKind = 'skills' | 'subagents' | 'commands' | 'rules';

/** The add forms Customize can open from outside (issue 680): the four create forms and the hook form. */
export type ClaudeOpenForm = ClaudeCreateKind | 'hooks';

export const CLAUDE_CREATE_KINDS: readonly ClaudeCreateKind[] = ['skills', 'subagents', 'commands', 'rules'];

export function isClaudeCreateKind(kind: string): kind is ClaudeCreateKind {
	return (CLAUDE_CREATE_KINDS as readonly string[]).includes(kind);
}

/** Which folder a file goes in: the project's `.claude`, or Klawly's user layer `~/.klawly/claude` (issue 455). */
export type ClaudeCreateScope = 'project' | 'user';

/** Claude Code's model value that keeps a subagent on the main conversation's model. */
export const CLAUDE_SUBAGENT_INHERIT_MODEL = 'inherit';

/** What an add form collects. Fields a kind does not use are ignored. */
export interface ClaudeCreateDraft {
	name: string;
	description: string;
	scope: ClaudeCreateScope;
	/** A subagent's model: `inherit`, an alias such as `sonnet`, or a model id. */
	model: string;
	/** A subagent's tools, comma separated. Empty gives it every tool. */
	tools: string;
	/** A rule's globs, comma separated. Empty loads the rule in every session. */
	paths: string;
}

/** A `.claude/rules` file, with the globs its `paths:` frontmatter scopes it to. */
export interface ClaudeRuleFile {
	/** A string the editor resolves back to the file. */
	readonly id: string;
	/** The path under `rules/` without `.md`, such as `frontend/react`. */
	readonly name: string;
	/** `claudeCode` is a rule in Claude Code's own `~/.claude/rules`: listed read only, never written (issue 807). */
	readonly scope: ClaudeCreateScope | 'claudeCode';
	/** Empty when the rule loads in every session. */
	readonly paths: readonly string[];
}

/** A skill, subagent or command written here that no session has reported yet. */
export interface ClaudeCreatedFile {
	readonly kind: Exclude<ClaudeCreateKind, 'rules'>;
	readonly name: string;
	readonly description: string;
	readonly scope: ClaudeCreateScope;
	/** A string the editor resolves back to the file. */
	readonly id: string;
}

export function emptyClaudeCreateDraft(scope: ClaudeCreateScope): ClaudeCreateDraft {
	return { name: '', description: '', scope, model: CLAUDE_SUBAGENT_INHERIT_MODEL, tools: '', paths: '' };
}

/** Claude Code's naming rule for skills and subagents, which the form applies to every kind: lowercase letters, digits and dashes. */
export function isClaudeCreateName(name: string): boolean {
	return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}

/** Whether Claude Code needs a description for the kind: it picks skills and subagents by it. */
export function claudeCreateNeedsDescription(kind: ClaudeCreateKind): boolean {
	return kind === 'skills' || kind === 'subagents';
}

/** Where the file goes, as path segments under the scope's `.claude` folder. */
export function claudeCreatePath(kind: ClaudeCreateKind, name: string): string[] {
	switch (kind) {
		case 'skills': return ['skills', name, 'SKILL.md'];
		case 'subagents': return ['agents', `${name}.md`];
		case 'commands': return ['commands', `${name}.md`];
		case 'rules': return ['rules', `${name}.md`];
	}
}

/** The path as the form and the prompt show it, such as `.claude/skills/review/SKILL.md` or `~/.klawly/claude/agents/`. */
export function claudeCreatePathLabel(kind: ClaudeCreateKind, scope: ClaudeCreateScope, name?: string, dataFolderName = '.klawly'): string {
	const root = scope === 'user' ? claudeUserLayerLabel(dataFolderName) : '.claude';
	return name ? [root, ...claudeCreatePath(kind, name)].join('/') : `${root}/${claudeCreatePath(kind, 'x')[0]}/`;
}

/** Splits on commas outside braces, so `src/**\/*.{ts,tsx}, lib/**` is two globs. */
export function splitClaudeList(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const char of text) {
		if (char === '{') {
			depth++;
		} else if (char === '}') {
			depth = Math.max(0, depth - 1);
		}
		if ((char === ',' || char === '\n') && depth === 0) {
			parts.push(current);
			current = '';
		} else {
			current += char;
		}
	}
	parts.push(current);
	return parts.map(part => part.trim()).filter(part => part.length > 0);
}

function unquote(value: string): string {
	const quoted = /^(?<quote>["'])(?<inner>.*)\k<quote>$/.exec(value.trim());
	return quoted?.groups ? quoted.groups.inner : value.trim();
}

/** A one-line YAML value, double-quoted when YAML would read it as something else. */
function yamlValue(value: string): string {
	const line = value.replace(/\s+/g, ' ').trim();
	const plain = line.length > 0 && !/[:#\[\]{}&*!|>'"%@`,\\]/.test(line) && !/^[-?]/.test(line) && !/^(true|false|null|yes|no|on|off|~|[-+.\d][\d.eE+-]*)$/i.test(line);
	return plain ? line : JSON.stringify(line);
}

function title(name: string): string {
	return name.split('-').filter(word => word.length > 0).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
}

/** The file's text in Claude Code's format: frontmatter, then a body to fill in. */
export function claudeCreateContent(kind: ClaudeCreateKind, draft: ClaudeCreateDraft): string {
	const name = draft.name.trim();
	const description = draft.description.trim();
	const lines: string[] = [];
	switch (kind) {
		case 'skills':
			lines.push('---', `name: ${name}`, `description: ${yamlValue(description)}`, '---', '', `# ${title(name)}`, '', localize('claudeCreateSkillBody', "Write the steps Claude follows when this skill applies."));
			break;
		case 'subagents': {
			const tools = splitClaudeList(draft.tools);
			lines.push('---', `name: ${name}`, `description: ${yamlValue(description)}`);
			if (tools.length) {
				lines.push(`tools: ${tools.join(', ')}`);
			}
			lines.push(`model: ${yamlValue(draft.model.trim() || CLAUDE_SUBAGENT_INHERIT_MODEL)}`, '---', '', localize('claudeCreateSubagentBody', "Write the system prompt of this subagent: its role, how it works and what it reports back."));
			break;
		}
		case 'commands':
			if (description) {
				lines.push('---', `description: ${yamlValue(description)}`, '---', '');
			}
			lines.push(localize('claudeCreateCommandBody', "Write the prompt this command sends. $ARGUMENTS stands for what follows the command."));
			break;
		case 'rules': {
			const paths = splitClaudeList(draft.paths);
			if (paths.length) {
				lines.push('---', 'paths:', ...paths.map(path => `  - ${JSON.stringify(path)}`), '---', '');
			}
			lines.push(`# ${title(name)}`, '', localize('claudeCreateRuleBody', "Write the instructions Claude follows in the files this rule covers."));
			break;
		}
	}
	return `${lines.join('\n')}\n`;
}

/**
 * The globs of a rule's `paths:` frontmatter, as a YAML list or an inline
 * value (`paths: src/**`, `paths: ["a", "b"]`). Empty when the rule has none.
 */
export function readClaudeRulePaths(text: string): string[] {
	const head = /^\uFEFF?---\r?\n(?<head>[\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text)?.groups?.head;
	if (head === undefined) {
		return [];
	}
	const lines = head.split(/\r?\n/);
	const at = lines.findIndex(line => /^paths\s*:/.test(line));
	if (at < 0) {
		return [];
	}
	const inline = lines[at].replace(/^paths\s*:/, '').trim();
	if (inline) {
		const list = inline.startsWith('[') && inline.endsWith(']') ? inline.slice(1, -1) : inline;
		return splitClaudeList(list).map(unquote).filter(path => path.length > 0);
	}
	const paths: string[] = [];
	for (const line of lines.slice(at + 1)) {
		const item = /^\s*-\s*(?<value>.*)$/.exec(line)?.groups?.value;
		if (item === undefined) {
			if (line.trim() === '' || /^\s*#/.test(line)) {
				continue;
			}
			break;
		}
		const path = unquote(item);
		if (path) {
			paths.push(path);
		}
	}
	return paths;
}

/** The label of the kind's Add button and of its form's submit button. */
export function claudeCreateAddLabel(kind: ClaudeCreateKind): string {
	switch (kind) {
		case 'skills': return localize('claudeCreateAddSkill', "Add Skill");
		case 'subagents': return localize('claudeCreateAddSubagent', "Add Subagent");
		case 'commands': return localize('claudeCreateAddCommand', "Add Command");
		case 'rules': return localize('claudeCreateAddRule', "Add Rule");
	}
}

/**
 * The prompt Create with Claude starts a chat with: what to make, the name
 * and description typed so far, and the file and format Claude Code reads.
 */
export function claudeCreatePrompt(kind: ClaudeCreateKind, draft: ClaudeCreateDraft, dataFolderName = '.klawly'): string {
	const name = draft.name.trim();
	const description = draft.description.replace(/\s+/g, ' ').trim();
	const path = claudeCreatePathLabel(kind, draft.scope, isClaudeCreateName(name) ? name : undefined, dataFolderName);
	// A skill is a folder: name the folder its SKILL.md goes in.
	const where = kind === 'skills' ? path.replace(/SKILL\.md$/, '') : path;
	const parts: string[] = [];
	switch (kind) {
		case 'skills': parts.push(localize('claudeCreatePromptSkill', "Help me create a Claude Code skill.")); break;
		case 'subagents': parts.push(localize('claudeCreatePromptSubagent', "Help me create a Claude Code subagent.")); break;
		case 'commands': parts.push(localize('claudeCreatePromptCommand', "Help me create a Claude Code slash command.")); break;
		case 'rules': parts.push(localize('claudeCreatePromptRule', "Help me create a Claude Code rule.")); break;
	}
	if (name) {
		parts.push(localize('claudeCreatePromptName', "Name it {0}.", name));
	}
	if (description) {
		parts.push(localize('claudeCreatePromptDescription', "What it is for: {0}", /[.!?]$/.test(description) ? description : `${description}.`));
	}
	switch (kind) {
		case 'skills': parts.push(localize('claudeCreatePromptSkillFormat', "Ask me what it should do and when you should use it until that is clear, then write its SKILL.md with name and description frontmatter in {0}.", where)); break;
		case 'subagents': parts.push(localize('claudeCreatePromptSubagentFormat', "Ask me what it should do, which tools it needs and which model it should use until that is clear, then write it to {0} with name, description, tools and model frontmatter and its system prompt as the body.", where)); break;
		case 'commands': parts.push(localize('claudeCreatePromptCommandFormat', "Ask me what it should do until that is clear, then write it to {0} with description frontmatter and the prompt as the body, using $ARGUMENTS for what follows the command.", where)); break;
		case 'rules': parts.push(localize('claudeCreatePromptRuleFormat', "Ask me what it should say and which files it applies to until that is clear, then write it to {0}, with paths frontmatter listing the globs it is scoped to, or none if it always applies.", where)); break;
	}
	return parts.join(' ');
}
