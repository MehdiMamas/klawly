/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Files Claude can and cannot read (issue 458).
 *
 * Rules use gitignore syntax: a pattern blocks, `!pattern` lets a path through
 * again, the last rule that matches wins. `~/` starts at the home folder and an
 * absolute path names one place on disk. A path is blocked when it, or any
 * folder above it, is blocked, as in git.
 *
 * Layers merged by `mergeReadRules`:
 * - the user list, `~/.klawly/claude/read-rules` (patterns without a base);
 * - the project's `.claude/settings.json` and `settings.local.json`
 *   `permissions.deny` entries written `Read(pattern)`;
 *
 * The matcher is pure. The permission host runs it on every request, so a
 * block holds in every mode, Allow Everything included.
 */

/** Name of the user list in the user layer folder (`~/.klawly/claude`). */
export const CLAUDE_READ_RULES_FILE = 'read-rules';

/** Setting: show blocked files in the explorer. */
export const CLAUDE_PRIVACY_EXPLORER_DECORATIONS_SETTING = 'claude.privacy.explorerDecorations';

export type ClaudeReadRuleSource = 'user' | 'project';

export interface ClaudeReadRule {
	/** The line as written, without `!`. */
	readonly pattern: string;
	/** True for a `!pattern` rule that lets a path through. */
	readonly allow: boolean;
	readonly source: ClaudeReadRuleSource;
	/** The file the rule came from, for the explorer hover. */
	readonly origin?: string;
	/** Only a folder matches (`pattern/`). */
	readonly directoryOnly: boolean;
	/** Matched against an absolute path with `/` separators. */
	readonly regex: RegExp;
}

export interface ClaudeReadRuleOptions {
	readonly source: ClaudeReadRuleSource;
	readonly origin?: string;
	/** Absolute folder a relative pattern starts at. Without it a relative pattern matches at any depth. */
	readonly base?: string;
	/** Absolute home folder, for `~/`. */
	readonly home?: string;
	/** Case-insensitive matching. Defaults to true when the base, home or pattern is a drive path. */
	readonly caseInsensitive?: boolean;
}

export interface ClaudeReadVerdict {
	readonly blocked: boolean;
	/** The rule that decided, when one matched. */
	readonly rule?: ClaudeReadRule;
}

function toSlashes(path: string): string {
	return path.replace(/\\/g, '/');
}

function isDrivePath(path: string): boolean {
	return /^[a-zA-Z]:\//.test(path) || path.startsWith('//');
}

function trimSlashes(path: string): string {
	return path.replace(/\/+$/, '');
}

function escapeRegex(text: string): string {
	return text.replace(/[.+^${}()|\\[\]]/g, '\\$&');
}

/** Translates the glob part of a gitignore pattern. `**` crosses folders, `*` and `?` do not. */
function globToRegex(glob: string): string {
	let out = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				const atStart = i === 0 || glob[i - 1] === '/';
				if (atStart && glob[i + 2] === '/') {
					out += '(?:.*/)?';
					i += 2;
				} else if (atStart && i + 2 === glob.length) {
					out += '.*';
					i += 1;
				} else {
					out += '[^/]*';
					i += 1;
				}
			} else {
				out += '[^/]*';
			}
		} else if (c === '?') {
			out += '[^/]';
		} else if (c === '[') {
			const close = glob.indexOf(']', i + 2);
			if (close < 0) {
				out += '\\[';
			} else {
				let body = glob.slice(i + 1, close);
				if (body.startsWith('!')) {
					body = '^' + body.slice(1);
				}
				out += '[' + body.replace(/\\/g, '\\\\') + ']';
				i = close;
			}
		} else if (c === '\\' && i + 1 < glob.length) {
			out += escapeRegex(glob[i + 1]);
			i += 1;
		} else {
			out += escapeRegex(c);
		}
	}
	return out;
}

/** Parses one rule line. Returns undefined for a blank line, a comment or an unusable pattern. */
export function parseReadRule(line: string, options: ClaudeReadRuleOptions): ClaudeReadRule | undefined {
	let text = line.replace(/\r$/, '').replace(/(?<!\\)\s+$/, '');
	if (text.length === 0 || text.startsWith('#')) {
		return undefined;
	}
	let allow = false;
	if (text.startsWith('!')) {
		allow = true;
		text = text.slice(1);
	} else if (text.startsWith('\\!') || text.startsWith('\\#')) {
		text = text.slice(1);
	}
	text = toSlashes(text);
	const directoryOnly = text.length > 1 && text.endsWith('/');
	text = trimSlashes(text);
	if (text.length === 0) {
		return undefined;
	}
	const home = options.home ? trimSlashes(toSlashes(options.home)) : undefined;
	const base = options.base ? trimSlashes(toSlashes(options.base)) : undefined;

	let prefix: string;
	let body: string;
	if (text === '~' || text.startsWith('~/')) {
		if (!home) {
			return undefined;
		}
		prefix = escapeRegex(home) + '/';
		body = text.slice(2);
	} else if (isDrivePath(text) || (text.startsWith('/') && !base)) {
		prefix = '';
		body = text;
	} else {
		const anchored = text.startsWith('/') || text.startsWith('./') || text.includes('/');
		body = text.replace(/^\.?\//, '');
		if (base) {
			prefix = escapeRegex(base) + '/' + (anchored ? '' : '(?:.*/)?');
		} else {
			prefix = '(?:.*/)?';
		}
	}
	const caseInsensitive = options.caseInsensitive ?? [base, home, text].some(p => p !== undefined && isDrivePath(p));
	try {
		const regex = new RegExp('^' + prefix + globToRegex(body) + '$', caseInsensitive ? 'i' : '');
		return { pattern: text + (directoryOnly ? '/' : ''), allow, source: options.source, origin: options.origin, directoryOnly, regex };
	} catch {
		return undefined;
	}
}

/** Parses a rules file. */
export function parseReadRules(text: string, options: ClaudeReadRuleOptions): ClaudeReadRule[] {
	const rules: ClaudeReadRule[] = [];
	for (const line of text.split('\n')) {
		const rule = parseReadRule(line, options);
		if (rule) {
			rules.push(rule);
		}
	}
	return rules;
}

/**
 * Reads the `Read(...)` entries of a settings file's `permissions.deny`. Claude
 * Code spells a path: `//abs/path` absolute, `~/x` from home, `/x` and `./x`
 * from the project folder, anything else as gitignore does.
 */
export function readRulesFromSettings(settings: unknown, options: ClaudeReadRuleOptions): ClaudeReadRule[] {
	const permissions = typeof settings === 'object' && settings !== null ? (settings as { permissions?: unknown }).permissions : undefined;
	const deny = typeof permissions === 'object' && permissions !== null ? (permissions as { deny?: unknown }).deny : undefined;
	if (!Array.isArray(deny)) {
		return [];
	}
	const rules: ClaudeReadRule[] = [];
	for (const entry of deny) {
		const match = typeof entry === 'string' ? /^Read\((.*)\)$/.exec(entry.trim()) : null;
		if (!match) {
			continue;
		}
		const spec = match[1].trim();
		const rule = spec.startsWith('//')
			? parseReadRule(spec.slice(1), { ...options, base: undefined })
			: parseReadRule(spec, options);
		if (rule) {
			rules.push(rule);
		}
	}
	return rules;
}

/** Layers in order: later rules win, so project rules come after the user list. */
export function mergeReadRules(...layers: readonly (readonly ClaudeReadRule[])[]): ClaudeReadRule[] {
	return layers.flat();
}

function lastMatch(rules: readonly ClaudeReadRule[], path: string, isDirectory: boolean | undefined): ClaudeReadRule | undefined {
	let found: ClaudeReadRule | undefined;
	for (const rule of rules) {
		if (rule.directoryOnly && isDirectory === false) {
			continue;
		}
		if (rule.regex.test(path)) {
			found = rule;
		}
	}
	return found;
}

/**
 * Whether an absolute path is blocked: it or a folder above it matches a
 * blocking rule and no later `!` rule lets that level through. `isDirectory` is
 * unknown for a path that may not exist; a folder-only rule then counts.
 */
export function evaluateReadRules(rules: readonly ClaudeReadRule[], path: string, isDirectory?: boolean): ClaudeReadVerdict {
	if (rules.length === 0) {
		return { blocked: false };
	}
	const parts = trimSlashes(toSlashes(path)).split('/');
	let current = '';
	let decisive: ClaudeReadRule | undefined;
	for (let i = 0; i < parts.length; i++) {
		current = i === 0 ? parts[0] : current + '/' + parts[i];
		if (current === '' || /^[a-zA-Z]:$/.test(current)) {
			continue;
		}
		const last = i === parts.length - 1;
		const match = lastMatch(rules, current, last ? isDirectory : true);
		if (match && !match.allow) {
			return { blocked: true, rule: match };
		}
		if (match && last) {
			decisive = match;
		}
	}
	return { blocked: false, rule: decisive };
}

/** Blocked when the path as written or after symlinks is blocked. */
export function isReadBlocked(rules: readonly ClaudeReadRule[], paths: { readonly absolute: string; readonly real?: string }, isDirectory?: boolean): ClaudeReadVerdict {
	const first = evaluateReadRules(rules, paths.absolute, isDirectory);
	if (first.blocked || paths.real === undefined || paths.real === paths.absolute) {
		return first;
	}
	return evaluateReadRules(rules, paths.real, isDirectory);
}

function permissionSpec(rule: ClaudeReadRule): string {
	const text = trimSlashes(rule.pattern);
	if (text.startsWith('~/')) {
		return text;
	}
	if (isDrivePath(text) || text.startsWith('/')) {
		return '/' + text;
	}
	return text.includes('/') ? '**/' + text.replace(/^\.?\//, '') : '**/' + text;
}

/**
 * `Read(...)` and `Edit(...)` deny entries for Claude Code's own permission
 * rules, from the user list's blocking rules. A `!` rule cannot be said in that
 * form; the host still honors it for what it judges.
 */
export function claudeReadDenyRules(rules: readonly ClaudeReadRule[]): string[] {
	const out = new Set<string>();
	for (const rule of rules) {
		if (rule.allow || rule.source !== 'user') {
			continue;
		}
		const spec = permissionSpec(rule);
		out.add(`Read(${spec})`);
		out.add(`Edit(${spec})`);
	}
	return [...out];
}

/** Absolute and home paths of the user list's blocking rules, for the sandbox's `denyRead`. */
export function claudeSandboxDenyRead(rules: readonly ClaudeReadRule[]): string[] {
	const out = new Set<string>();
	for (const rule of rules) {
		if (rule.allow || rule.source !== 'user') {
			continue;
		}
		const text = trimSlashes(rule.pattern);
		if ((text.startsWith('~/') || isDrivePath(text) || text.startsWith('/')) && !/[*?[]/.test(text)) {
			out.add(text);
		}
	}
	return [...out];
}
