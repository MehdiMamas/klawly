/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { match } from '../../../base/common/glob.js';
import { isAbsolute, resolve } from '../../../base/common/path.js';
import { CLAUDE_REVIEW_SEVERITIES, ClaudeReviewFinding, ClaudeReviewSeverity } from './claudeReviewLoop.js';

/**
 * Review rules (issue 922). `.claude/review.json`, and the same file in a
 * subfolder, holds ignore globs, scoped rules, rule IDs to turn off and a
 * minimum severity. The nearer folder wins. All of this is pure: the caller reads
 * the files and passes their text.
 */
export const CLAUDE_REVIEW_CONFIG_FILE_SETTING = 'claude.review.configFile';

/** Where a folder's review config lives by default. */
export const CLAUDE_REVIEW_CONFIG_FILE_DEFAULT = '.claude/review.json';

/** One rule: text for the reviewer, optionally limited to files matching `scope` (relative to the config's folder). */
export interface ClaudeReviewRule {
	readonly id: string;
	readonly text: string;
	readonly scope?: readonly string[];
}

/** What one review.json says. */
export interface ClaudeReviewConfigFile {
	readonly ignore: readonly string[];
	readonly rules: readonly ClaudeReviewRule[];
	readonly disabledRules: readonly string[];
	readonly minSeverity?: ClaudeReviewSeverity;
	/** Folders of related repositories the reviewer may read (issue 934); absolute, or relative to the config's repository. */
	readonly relatedRepos: readonly string[];
}

export interface ClaudeReviewConfigParse {
	readonly config: ClaudeReviewConfigFile;
	/** Plain-words problems; the parts that were fine are still in `config`. */
	readonly errors: readonly string[];
}

function strings(value: unknown, name: string, errors: string[]): string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item)) {
		errors.push(`"${name}" must be a list of non-empty strings.`);
		return [];
	}
	return value as string[];
}

/** The setting's value as a repository-relative path; the default when it is not a usable string. */
export function readClaudeReviewConfigFile(value: unknown): string {
	return typeof value === 'string' && value.trim() ? value.trim() : CLAUDE_REVIEW_CONFIG_FILE_DEFAULT;
}

/** Parses one file's text. Bad JSON gives an empty config and one error; bad parts are skipped with an error each. */
export function parseClaudeReviewConfig(text: string): ClaudeReviewConfigParse {
	const errors: string[] = [];
	const empty: ClaudeReviewConfigFile = { ignore: [], rules: [], disabledRules: [], relatedRepos: [] };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return { config: empty, errors: [`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { config: empty, errors: ['The file must hold a JSON object.'] };
	}
	const object = raw as Record<string, unknown>;
	const rules: ClaudeReviewRule[] = [];
	if (object.rules !== undefined) {
		if (!Array.isArray(object.rules)) {
			errors.push('"rules" must be a list.');
		} else {
			object.rules.forEach((entry: unknown, index) => {
				const rule = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : undefined;
				if (!rule || typeof rule.id !== 'string' || !rule.id || typeof rule.text !== 'string' || !rule.text.trim()) {
					errors.push(`Rule ${index + 1} needs an "id" and a "text".`);
					return;
				}
				const scope = strings(rule.scope, `rules[${index}].scope`, errors);
				rules.push({ id: rule.id, text: rule.text.trim(), scope: scope.length ? scope : undefined });
			});
		}
	}
	let minSeverity: ClaudeReviewSeverity | undefined;
	if (object.minSeverity !== undefined) {
		minSeverity = CLAUDE_REVIEW_SEVERITIES.find(severity => severity === object.minSeverity);
		if (!minSeverity) {
			errors.push(`"minSeverity" must be one of ${CLAUDE_REVIEW_SEVERITIES.join(', ')}.`);
		}
	}
	return { config: { ignore: strings(object.ignore, 'ignore', errors), rules, disabledRules: strings(object.disabledRules, 'disabledRules', errors), minSeverity, relatedRepos: strings(object.relatedRepos, 'relatedRepos', errors) }, errors };
}

/**
 * Returns the file's text with `edit` applied to its rules, every other key kept as written (issue 923).
 * Empty or missing text starts a new file. Text that is not a JSON object gives `undefined`: it is never overwritten.
 */
export function editClaudeReviewConfigRules(text: string | undefined, edit: (rules: readonly ClaudeReviewRule[]) => readonly ClaudeReviewRule[]): string | undefined {
	let object: Record<string, unknown> = {};
	if (text?.trim()) {
		try {
			const raw: unknown = JSON.parse(text);
			if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
				return undefined;
			}
			object = raw as Record<string, unknown>;
		} catch {
			return undefined;
		}
	}
	const rules = parseClaudeReviewConfig(JSON.stringify({ rules: object.rules })).config.rules;
	const next = edit(rules).map(rule => rule.scope?.length ? { id: rule.id, text: rule.text, scope: rule.scope } : { id: rule.id, text: rule.text });
	return JSON.stringify({ ...object, rules: next }, undefined, '\t') + '\n';
}

/** Adds a rule, or replaces the one with the same id. */
export function addClaudeReviewRule(text: string | undefined, rule: ClaudeReviewRule): string | undefined {
	return editClaudeReviewConfigRules(text, rules => rules.some(existing => existing.id === rule.id) ? rules.map(existing => existing.id === rule.id ? rule : existing) : [...rules, rule]);
}

/** Removes the rule with this id. */
export function removeClaudeReviewRule(text: string | undefined, id: string): string | undefined {
	return editClaudeReviewConfigRules(text, rules => rules.filter(rule => rule.id !== id));
}

/** One config file found in a folder (`''` is the repository root; otherwise a relative path like `src/api`). */
export interface ClaudeReviewConfigLayer {
	readonly folder: string;
	readonly text: string;
}

/** What applies to one file after the cascade. */
export interface ClaudeEffectiveFileConfig {
	readonly ignored: boolean;
	readonly rules: readonly ClaudeReviewRule[];
	readonly disabledRules: readonly string[];
	readonly minSeverity?: ClaudeReviewSeverity;
}

function normalize(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
}

function depth(folder: string): number {
	return folder ? folder.split('/').length : 0;
}

function relativeTo(folder: string, file: string): string | undefined {
	if (!folder) {
		return file;
	}
	return file.startsWith(folder + '/') ? file.slice(folder.length + 1) : undefined;
}

function matchesAny(patterns: readonly string[], path: string): boolean {
	return patterns.some(pattern => match(pattern, path));
}

/**
 * The config for one file: the layers whose folder contains it, root first. A nearer
 * layer's `minSeverity` replaces a farther one's; a rule with the same ID replaces
 * the farther rule (and turns it back on if a farther layer disabled it); ignore
 * and disabled lists add up. Patterns are relative to their own layer's folder.
 */
export function resolveClaudeReviewConfigForFile(layers: readonly ClaudeReviewConfigLayer[], filePath: string): ClaudeEffectiveFileConfig {
	const file = normalize(filePath);
	const ordered = layers.map(layer => ({ folder: normalize(layer.folder), text: layer.text })).sort((a, b) => depth(a.folder) - depth(b.folder));
	let ignored = false;
	let minSeverity: ClaudeReviewSeverity | undefined;
	const disabled = new Set<string>();
	const rules = new Map<string, ClaudeReviewRule>();
	for (const { folder, text } of ordered) {
		const relative = relativeTo(folder, file);
		if (relative === undefined) {
			continue;
		}
		const { config } = parseClaudeReviewConfig(text);
		ignored ||= matchesAny(config.ignore, relative);
		minSeverity = config.minSeverity ?? minSeverity;
		for (const rule of config.rules) {
			if (!rule.scope || matchesAny(rule.scope, relative)) {
				rules.set(rule.id, rule);
				disabled.delete(rule.id);
			} else {
				rules.delete(rule.id);
			}
		}
		for (const id of config.disabledRules) {
			disabled.add(id);
			rules.delete(id);
		}
	}
	return { ignored, rules: [...rules.values()], disabledRules: [...disabled], minSeverity };
}

/** The config across all the changed files. */
export interface ClaudeResolvedReviewConfig {
	readonly ignoredFiles: readonly string[];
	readonly keptFiles: readonly string[];
	/** Rules that apply to at least one kept file and are not turned off. */
	readonly rules: readonly ClaudeReviewRule[];
	readonly disabledRules: readonly string[];
	/** Per kept file; absent when no layer sets one. */
	readonly minSeverity: ReadonlyMap<string, ClaudeReviewSeverity>;
}

export function resolveClaudeReviewConfig(layers: readonly ClaudeReviewConfigLayer[], files: readonly string[]): ClaudeResolvedReviewConfig {
	const ignoredFiles: string[] = [];
	const keptFiles: string[] = [];
	const rules = new Map<string, ClaudeReviewRule>();
	const disabled = new Set<string>();
	const minSeverity = new Map<string, ClaudeReviewSeverity>();
	for (const file of files) {
		const effective = resolveClaudeReviewConfigForFile(layers, file);
		if (effective.ignored) {
			ignoredFiles.push(file);
			continue;
		}
		keptFiles.push(file);
		effective.rules.forEach(rule => rules.set(rule.id, rule));
		effective.disabledRules.forEach(id => disabled.add(id));
		if (effective.minSeverity) {
			minSeverity.set(normalize(file), effective.minSeverity);
		}
	}
	return { ignoredFiles, keptFiles, rules: [...rules.values()].filter(rule => !disabled.has(rule.id)), disabledRules: [...disabled], minSeverity };
}

/** The folders a file's config layers could live in, root first: `['', 'src', 'src/api']` for `src/api/x.ts`. */
export function claudeReviewConfigFolders(filePath: string): string[] {
	const parts = normalize(filePath).split('/').slice(0, -1);
	return ['', ...parts.map((_, index) => parts.slice(0, index + 1).join('/'))];
}

/**
 * Reads the config layers that can apply to the given files. `read` returns a file's
 * text by repository-relative path, or `undefined` when it is not there.
 */
export async function readClaudeReviewConfigLayers(files: readonly string[], configFile: string, read: (relativePath: string) => Promise<string | undefined>): Promise<ClaudeReviewConfigLayer[]> {
	const layers: ClaudeReviewConfigLayer[] = [];
	for (const folder of new Set(files.flatMap(file => claudeReviewConfigFolders(file)))) {
		const text = await read(folder ? `${folder}/${configFile}` : configFile);
		if (text !== undefined) {
			layers.push({ folder, text });
		}
	}
	return layers;
}

/** The notes block the prompt gets: the project's REVIEW.md, then the rules that apply to these files. */
export function claudeReviewInstructionsWithRules(notes: string | undefined, resolved: ClaudeResolvedReviewConfig): string | undefined {
	const lines: string[] = [];
	if (resolved.rules.length) {
		lines.push('Also check these rules. When a finding comes from a rule, start its title with the rule ID in square brackets, like [rule-id].');
		for (const rule of resolved.rules) {
			lines.push(`- [${rule.id}]${rule.scope ? ` (only for ${rule.scope.join(', ')})` : ''}: ${rule.text}`);
		}
	}
	if (resolved.disabledRules.length) {
		lines.push(`Do not report problems for these rule IDs: ${resolved.disabledRules.join(', ')}.`);
	}
	if (!lines.length) {
		return notes;
	}
	return [notes?.trim(), lines.join('\n')].filter(Boolean).join('\n\n');
}

/**
 * Drops findings tagged with a disabled rule ID (`[id]` at the start of the title)
 * and findings below their file's own `minSeverity`. Critical findings stay.
 */
export function filterClaudeFindingsByConfig(findings: readonly ClaudeReviewFinding[], resolved: ClaudeResolvedReviewConfig): readonly ClaudeReviewFinding[] {
	const rank = (severity: ClaudeReviewSeverity) => CLAUDE_REVIEW_SEVERITIES.indexOf(severity);
	return findings.filter(finding => {
		const tag = /^\[(?<id>[^\]]+)\]/.exec(finding.title.trim())?.groups?.id;
		if (tag && resolved.disabledRules.includes(tag)) {
			return false;
		}
		const limit = resolved.minSeverity.get(normalize(finding.file));
		return !limit || finding.severity === 'critical' || rank(finding.severity) <= rank(limit);
	});
}

/** Plain-words listing for the "Show Effective Review Config for This File" command. */
export function describeClaudeEffectiveReviewConfig(layers: readonly ClaudeReviewConfigLayer[], filePath: string): string {
	const effective = resolveClaudeReviewConfigForFile(layers, filePath);
	const lines = [`Review config for ${normalize(filePath)}`];
	if (effective.ignored) {
		lines.push('This file is ignored by the review.');
	}
	lines.push(`Minimum severity: ${effective.minSeverity ?? 'not set'}`);
	lines.push(effective.rules.length ? 'Rules:' : 'Rules: none');
	effective.rules.forEach(rule => lines.push(`- ${rule.id}: ${rule.text}`));
	lines.push(`Turned off: ${effective.disabledRules.length ? effective.disabledRules.join(', ') : 'none'}`);
	for (const layer of layers) {
		parseClaudeReviewConfig(layer.text).errors.forEach(error => lines.push(`Problem in ${layer.folder || 'the root'} config: ${error}`));
	}
	return lines.join('\n');
}

/** Why a related repository was not used. */
export type ClaudeRelatedRepoRefusal = 'untrusted' | 'missing' | 'workspace' | 'duplicate';

export interface ClaudeRelatedReposResolution {
	/** Canonical absolute folders to pass as read-only extra directories. */
	readonly directories: readonly string[];
	readonly refused: readonly { readonly entry: string; readonly reason: ClaudeRelatedRepoRefusal }[];
}

/**
 * Turns the `relatedRepos` entries of the layers into canonical folders (issue 934, rule 40).
 * Relative entries resolve against the workspace folder. In an untrusted workspace nothing
 * is used. `canonical` returns the real path of an existing folder (symlinks followed), or
 * `undefined` when it does not exist or is not a folder. The workspace itself and repeats
 * are dropped; a path compare ignores case on Windows and macOS (`ignoreCase`).
 */
export function resolveClaudeRelatedRepos(entries: readonly string[], workspaceFolder: string, trusted: boolean, canonical: (path: string) => string | undefined, ignoreCase: boolean): ClaudeRelatedReposResolution {
	const key = (path: string) => (ignoreCase ? path.toLowerCase() : path).replace(/[\/]+$/, '');
	const directories: string[] = [];
	const refused: { entry: string; reason: ClaudeRelatedRepoRefusal }[] = [];
	if (!trusted) {
		return { directories, refused: entries.map(entry => ({ entry, reason: 'untrusted' as const })) };
	}
	const seen = new Set<string>([key(canonical(workspaceFolder) ?? workspaceFolder)]);
	for (const entry of entries) {
		const absolute = isAbsolute(entry) ? entry : resolve(workspaceFolder, entry);
		const real = canonical(absolute);
		if (!real) {
			refused.push({ entry, reason: 'missing' });
		} else if (key(real) === key(canonical(workspaceFolder) ?? workspaceFolder)) {
			refused.push({ entry, reason: 'workspace' });
		} else if (seen.has(key(real))) {
			refused.push({ entry, reason: 'duplicate' });
		} else {
			seen.add(key(real));
			directories.push(real);
		}
	}
	return { directories, refused };
}

/** The related repositories the layers list, in layer order, without repeats. */
export function claudeReviewRelatedRepoEntries(layers: readonly ClaudeReviewConfigLayer[]): string[] {
	return [...new Set(layers.flatMap(layer => parseClaudeReviewConfig(layer.text).config.relatedRepos))];
}

/** The review header line listing the repositories that were consulted; `undefined` when none. */
export function claudeRelatedReposHeader(directories: readonly string[]): string | undefined {
	return directories.length ? `Also read: ${directories.join(', ')}` : undefined;
}
