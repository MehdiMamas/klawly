/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse, ParseError } from '../../../base/common/json.js';
import { applyEdits, setProperty } from '../../../base/common/jsonEdit.js';
import { FormattingOptions } from '../../../base/common/jsonFormatter.js';

/**
 * The Claude Code settings file a hook lives in: `user` is
 * `~/.claude/settings.json`, `project` is `.claude/settings.json` in the
 * repository, and `local` is `.claude/settings.local.json`, which git ignores.
 */
export type ClaudeHookScope = 'user' | 'project' | 'local';

export const CLAUDE_HOOK_SCOPES: readonly ClaudeHookScope[] = ['project', 'local', 'user'];

/** Each scope's settings file, from its folder: the workspace folder, or the user's home for `user`. */
export const CLAUDE_SETTINGS_FILES: Readonly<Record<ClaudeHookScope, readonly string[]>> = {
	project: ['.claude', 'settings.json'],
	local: ['.claude', 'settings.local.json'],
	user: ['.claude', 'settings.json'],
};

/** The events the Add Hook form offers. Hooks on other events still list. */
export const CLAUDE_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Notification', 'Stop', 'SubagentStop', 'SessionStart', 'SessionEnd', 'PreCompact', 'PermissionRequest',
	// Klawly runs these itself, for Tab, inline edit and workspace open (issue 514). Claude Code ignores them.
	'KlawlyTabRead', 'KlawlyInlineEdit', 'KlawlyWorkspaceOpen'] as const;

export type ClaudeHookEvent = typeof CLAUDE_HOOK_EVENTS[number];

/** The events whose hooks take a tool-name matcher. */
const MATCHER_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);

export function claudeHookTakesMatcher(event: string): boolean {
	return MATCHER_EVENTS.has(event);
}

/** One hook in a settings file. `group` and `index` find it again for removal. */
export interface ClaudeHookEntry {
	readonly scope: ClaudeHookScope;
	readonly event: string;
	/** The tool-name pattern, when the hook has one. */
	readonly matcher?: string;
	/** The shell command, or another hook type's name, such as `prompt`. */
	readonly command: string;
	readonly group: number;
	readonly index: number;
}

/** Where a hook is in a settings file. */
export interface ClaudeHookLocation {
	readonly event: string;
	readonly group: number;
	readonly index: number;
	/** The command the hook had when listed, so a file changed since is not edited blind. */
	readonly command: string;
}

const MAX_COMMAND_LENGTH = 4096;

/** A Claude Code settings file, parsed as Claude Code reads it: `{}` when empty, undefined when not a JSON object. */
export function parseClaudeSettings(text: string): Record<string, unknown> | undefined {
	if (!text.trim()) {
		return {};
	}
	const errors: ParseError[] = [];
	const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
	return errors.length === 0 && value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function hookCommand(hook: unknown): string | undefined {
	if (!hook || typeof hook !== 'object') {
		return undefined;
	}
	const { type, command } = hook as Record<string, unknown>;
	if (type === 'command') {
		return typeof command === 'string' ? command : undefined;
	}
	return typeof type === 'string' ? type : undefined;
}

/** Every hook in one settings file, in file order. Empty when the file is not valid JSON. */
export function readClaudeHooks(text: string, scope: ClaudeHookScope): ClaudeHookEntry[] {
	const hooks = parseClaudeSettings(text)?.hooks;
	if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
		return [];
	}
	const entries: ClaudeHookEntry[] = [];
	for (const [event, groups] of Object.entries(hooks)) {
		if (!Array.isArray(groups)) {
			continue;
		}
		groups.forEach((group: unknown, groupIndex) => {
			if (!group || typeof group !== 'object' || !Array.isArray((group as Record<string, unknown>).hooks)) {
				return;
			}
			const { matcher, hooks: list } = group as { matcher?: unknown; hooks: unknown[] };
			list.forEach((hook, index) => {
				const command = hookCommand(hook);
				if (command !== undefined) {
					entries.push({ scope, event, matcher: typeof matcher === 'string' && matcher ? matcher : undefined, command, group: groupIndex, index });
				}
			});
		});
	}
	return entries;
}

/** A command the form may save: one line, not empty, not too long. */
export function isClaudeHookCommand(value: string): boolean {
	const command = value.trim();
	return command.length > 0 && command.length <= MAX_COMMAND_LENGTH && !/[\r\n]/.test(command);
}

/** Edits keep the file's line ends, with the two-space indent Claude Code writes. */
export function claudeSettingsFormatting(text: string): FormattingOptions {
	return { tabSize: 2, insertSpaces: true, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

/**
 * The file with a command hook added on `event`, in the group with the same
 * matcher, or a new group. Undefined when the file is not valid JSON or its
 * hooks are not shaped the way Claude Code reads them; then nothing is written.
 */
export function addClaudeHook(text: string, event: string, matcher: string | undefined, command: string): string | undefined {
	const settings = parseClaudeSettings(text);
	if (!settings || !isClaudeHookCommand(command) || !/^[A-Za-z]+$/.test(event)) {
		return undefined;
	}
	const hooks = settings.hooks;
	if (hooks !== undefined && (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))) {
		return undefined;
	}
	const groups = (hooks as Record<string, unknown> | undefined)?.[event];
	if (groups !== undefined && !Array.isArray(groups)) {
		return undefined;
	}
	const hook = { type: 'command', command: command.trim() };
	const wanted = matcher?.trim() || undefined;
	const options = claudeSettingsFormatting(text);
	const source = text.trim() ? text : '{}';
	const existing = (groups ?? []).findIndex((group: unknown) => {
		if (!group || typeof group !== 'object') {
			return false;
		}
		const value = group as Record<string, unknown>;
		return Array.isArray(value.hooks) && (typeof value.matcher === 'string' && value.matcher ? value.matcher : undefined) === wanted;
	});
	const edits = existing >= 0
		? setProperty(source, ['hooks', event, existing, 'hooks', -1], hook, options)
		: setProperty(source, ['hooks', event, -1], wanted ? { matcher: wanted, hooks: [hook] } : { hooks: [hook] }, options);
	return applyEdits(source, edits);
}

/**
 * The file without the hook at `location`, dropping a group, event or `hooks`
 * key it leaves empty. Undefined when the hook there is no longer the one
 * listed, because the file changed since.
 */
export function removeClaudeHook(text: string, location: ClaudeHookLocation): string | undefined {
	const settings = parseClaudeSettings(text);
	const hooks = settings?.hooks as Record<string, unknown> | undefined;
	const groups = hooks?.[location.event];
	const group = Array.isArray(groups) ? groups[location.group] as Record<string, unknown> | undefined : undefined;
	const list = group && Array.isArray(group.hooks) ? group.hooks : undefined;
	if (!hooks || !Array.isArray(groups) || !list || hookCommand(list[location.index]) !== location.command) {
		return undefined;
	}
	const options = claudeSettingsFormatting(text);
	let path: (string | number)[] = ['hooks', location.event, location.group, 'hooks', location.index];
	if (list.length === 1) {
		path = ['hooks', location.event, location.group];
		if (groups.length === 1) {
			path = ['hooks', location.event];
			if (Object.keys(hooks).length === 1) {
				path = ['hooks'];
			}
		}
	}
	return applyEdits(text, setProperty(text, path, undefined, options));
}
