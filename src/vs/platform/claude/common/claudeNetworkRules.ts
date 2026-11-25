/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { applyEdits, setProperty } from '../../../base/common/jsonEdit.js';
import { claudeSettingsFormatting, ClaudeHookScope, parseClaudeSettings } from './claudeHooks.js';

/*
 * Allowed and denied network domains (issue 432) are Claude Code's own rules,
 * kept in its settings files: a `WebFetch(domain:...)` permission rule for the
 * WebFetch tool, and the sandbox's `network.allowedDomains` or `deniedDomains`
 * for sandboxed commands. Klawly keeps no list of its own; it writes both so
 * one domain rule covers both ways Claude reaches the network.
 */

export type ClaudeNetworkEffect = 'allow' | 'deny';

/** One domain a settings file allows or denies. */
export interface ClaudeNetworkRule {
	readonly scope: ClaudeHookScope;
	readonly domain: string;
	readonly effect: ClaudeNetworkEffect;
	/** A `WebFetch(domain:...)` permission rule carries it. */
	readonly webFetch: boolean;
	/** The sandbox network list carries it. */
	readonly sandbox: boolean;
}

export type JsonPath = (string | number)[];

const MAX_DOMAIN_LENGTH = 253;
const DOMAIN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const WEB_FETCH_RULE = /^WebFetch\(domain:(?<domain>[^()\s]+)\)$/;

/** A host name, optionally with a leading `*.` for its subdomains, as Claude Code matches domains. */
export function isClaudeNetworkDomain(value: string): boolean {
	const domain = value.trim();
	return domain.length > 0 && domain.length <= MAX_DOMAIN_LENGTH && DOMAIN.test(domain);
}

/** The permission rule that allows or denies WebFetch for a domain. */
export function claudeWebFetchRule(domain: string): string {
	return `WebFetch(domain:${domain})`;
}

function permissionPath(effect: ClaudeNetworkEffect): JsonPath {
	return ['permissions', effect];
}

function sandboxPath(effect: ClaudeNetworkEffect): JsonPath {
	return ['sandbox', 'network', effect === 'allow' ? 'allowedDomains' : 'deniedDomains'];
}

export function valueAt(settings: unknown, path: JsonPath): unknown {
	let value = settings;
	for (const key of path) {
		if (!value || typeof value !== 'object') {
			return undefined;
		}
		value = (value as Record<string | number, unknown>)[key];
	}
	return value;
}

export function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Every domain one settings file allows or denies, in file order, WebFetch rules first. */
export function readClaudeNetworkRules(text: string, scope: ClaudeHookScope): ClaudeNetworkRule[] {
	const settings = parseClaudeSettings(text);
	if (!settings) {
		return [];
	}
	const rules: ClaudeNetworkRule[] = [];
	for (const effect of ['allow', 'deny'] as const) {
		const fetched = strings(valueAt(settings, permissionPath(effect))).map(rule => WEB_FETCH_RULE.exec(rule)?.groups?.domain).filter((domain): domain is string => !!domain);
		const sandboxed = strings(valueAt(settings, sandboxPath(effect)));
		for (const domain of new Set([...fetched, ...sandboxed])) {
			rules.push({ scope, domain, effect, webFetch: fetched.includes(domain), sandbox: sandboxed.includes(domain) });
		}
	}
	return rules;
}

/** Whether every object on `path` (all but its last key) is an object or missing, and the last is an array or missing. */
export function writable(settings: Record<string, unknown>, path: JsonPath): boolean {
	let value: unknown = settings;
	for (let i = 0; i < path.length; i++) {
		value = (value as Record<string, unknown> | undefined)?.[path[i]];
		if (value === undefined) {
			return true;
		}
		const last = i === path.length - 1;
		if (last ? !Array.isArray(value) : (!value || typeof value !== 'object' || Array.isArray(value))) {
			return false;
		}
	}
	return true;
}

/**
 * The file with `domain` allowed or denied, as a WebFetch rule and in the
 * sandbox network list; an entry already there is not repeated. Undefined when
 * the file is not valid JSON, the domain is not one, or the keys are not shaped
 * the way Claude Code reads them; then nothing is written.
 */
export function addClaudeNetworkRule(text: string, domain: string, effect: ClaudeNetworkEffect): string | undefined {
	const settings = parseClaudeSettings(text);
	const wanted = domain.trim();
	if (!settings || !isClaudeNetworkDomain(wanted) || !writable(settings, permissionPath(effect)) || !writable(settings, sandboxPath(effect))) {
		return undefined;
	}
	let result = text.trim() ? text : '{}';
	const entries: [JsonPath, string][] = [[permissionPath(effect), claudeWebFetchRule(wanted)], [sandboxPath(effect), wanted]];
	for (const [path, entry] of entries) {
		if (!strings(valueAt(parseClaudeSettings(result), path)).includes(entry)) {
			result = applyEdits(result, setProperty(result, [...path, -1], entry, claudeSettingsFormatting(result)));
		}
	}
	return result;
}

/** The file without the key at `path`, dropping each object the removal leaves empty. */
export function removeAt(text: string, path: JsonPath): string {
	const settings = parseClaudeSettings(text);
	let cut = path;
	while (cut.length > 1) {
		const parent = valueAt(settings, cut.slice(0, -1));
		if (!parent || typeof parent !== 'object' || Object.keys(parent).length !== 1) {
			break;
		}
		cut = cut.slice(0, -1);
	}
	return applyEdits(text, setProperty(text, cut, undefined, claudeSettingsFormatting(text)));
}

/**
 * The file without the rule: its WebFetch rule and its sandbox list entry.
 * Undefined when the file no longer has either, because it changed since the
 * list was read.
 */
export function removeClaudeNetworkRule(text: string, rule: Pick<ClaudeNetworkRule, 'domain' | 'effect'>): string | undefined {
	let result = text;
	let removed = false;
	const entries: [JsonPath, string][] = [[permissionPath(rule.effect), claudeWebFetchRule(rule.domain)], [sandboxPath(rule.effect), rule.domain]];
	for (const [path, entry] of entries) {
		const list = valueAt(parseClaudeSettings(result), path);
		if (!Array.isArray(list) || !list.includes(entry)) {
			continue;
		}
		// The whole list is rewritten: removing one element in place breaks a list kept on one line.
		const rest = list.filter(item => item !== entry);
		result = rest.length ? applyEdits(result, setProperty(result, path, rest, claudeSettingsFormatting(result))) : removeAt(result, path);
		removed = true;
	}
	return removed ? result : undefined;
}
