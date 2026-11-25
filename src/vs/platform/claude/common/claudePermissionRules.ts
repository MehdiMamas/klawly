/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { applyEdits, setProperty } from '../../../base/common/jsonEdit.js';
import { claudeSettingsFormatting, ClaudeHookScope, parseClaudeSettings } from './claudeHooks.js';
import { ClaudeNetworkEffect, JsonPath, removeAt, strings, valueAt, writable } from './claudeNetworkRules.js';

/*
 * Permission rules (issue 868) are Claude Code's own `permissions.allow` and
 * `permissions.deny` lists in its settings files: a rule is a tool name,
 * `Bash`, or a tool name with a specifier, `Bash(npm run test:*)`, the way
 * Claude Code reads them. Klawly keeps no list of its own and writes no other
 * key; `permissions.ask`, `defaultMode` and everything else in the file stay
 * as they are. A deny rule is never weakened here: nothing moves a rule from
 * deny to allow, a rule is never allowed while the same rule is denied, and
 * only the one list an entry is removed from changes.
 *
 * WebFetch(domain:...) rules belong to the network domains list (issue 432),
 * which writes the sandbox list alongside them, so they are not listed here.
 */

export type ClaudePermissionEffect = ClaudeNetworkEffect;

/** One rule a settings file allows or denies. */
export interface ClaudePermissionRule {
	readonly scope: ClaudeHookScope;
	readonly rule: string;
	readonly effect: ClaudePermissionEffect;
}

const MAX_RULE_LENGTH = 500;
const RULE = /^(?<tool>[A-Za-z_][A-Za-z0-9_\-.*]*)(?:\((?<specifier>[^\r\n]*)\))?$/;
const WEB_FETCH_DOMAIN_RULE = /^WebFetch\(domain:[^()\s]+\)$/;

function permissionPath(effect: ClaudePermissionEffect): JsonPath {
	return ['permissions', effect];
}

/** The rule as Claude Code reads it, or undefined when it is not shaped like one. */
export function normalizeClaudePermissionRule(value: string): string | undefined {
	const rule = value.trim();
	if (!rule || rule.length > MAX_RULE_LENGTH) {
		return undefined;
	}
	const match = RULE.exec(rule);
	if (!match) {
		return undefined;
	}
	const specifier = match.groups?.specifier;
	// `Bash()` and `Bash( )` are not rules; a specifier must say something and keep its brackets balanced.
	if (specifier !== undefined && (!specifier.trim() || !balanced(specifier))) {
		return undefined;
	}
	return rule;
}

export function isClaudePermissionRule(value: string): boolean {
	return normalizeClaudePermissionRule(value) !== undefined;
}

function balanced(specifier: string): boolean {
	let depth = 0;
	for (const character of specifier) {
		if (character === '(') {
			depth++;
		} else if (character === ')' && --depth < 0) {
			return false;
		}
	}
	return depth === 0;
}

/** Whether the network domains list owns the rule. */
function isNetworkDomainRule(rule: string): boolean {
	return WEB_FETCH_DOMAIN_RULE.test(rule);
}

/** Every allow and deny rule one settings file holds, allow first, in file order, except domain rules. */
export function readClaudePermissionRules(text: string, scope: ClaudeHookScope): ClaudePermissionRule[] {
	const settings = parseClaudeSettings(text);
	if (!settings) {
		return [];
	}
	const rules: ClaudePermissionRule[] = [];
	for (const effect of ['allow', 'deny'] as const) {
		for (const rule of new Set(strings(valueAt(settings, permissionPath(effect))))) {
			if (!isNetworkDomainRule(rule)) {
				rules.push({ scope, rule, effect });
			}
		}
	}
	return rules;
}

export type ClaudePermissionRuleWrite =
	| { readonly text: string }
	/** The file is not valid JSON, or `permissions` is not shaped the way Claude Code reads it. */
	| { readonly failure: 'file' }
	| { readonly failure: 'invalid' }
	/** The rule is denied, here or in another file, so allowing it would be dead or would weaken the deny. */
	| { readonly failure: 'denied' };

/**
 * The file with the rule added to its allow or deny list; a rule already there
 * is not repeated. `denied` is every rule the other files deny: allowing one of
 * them is refused. Nothing is written when a failure comes back.
 */
export function addClaudePermissionRule(text: string, value: string, effect: ClaudePermissionEffect, denied: ReadonlySet<string> = new Set()): ClaudePermissionRuleWrite {
	const rule = normalizeClaudePermissionRule(value);
	if (!rule || isNetworkDomainRule(rule)) {
		return { failure: 'invalid' };
	}
	const settings = parseClaudeSettings(text);
	if (!settings || !writable(settings, permissionPath(effect))) {
		return { failure: 'file' };
	}
	if (effect === 'allow' && (denied.has(rule) || strings(valueAt(settings, permissionPath('deny'))).includes(rule))) {
		return { failure: 'denied' };
	}
	if (strings(valueAt(settings, permissionPath(effect))).includes(rule)) {
		return { text };
	}
	const base = text.trim() ? text : '{}';
	return { text: applyEdits(base, setProperty(base, [...permissionPath(effect), -1], rule, claudeSettingsFormatting(base))) };
}

/**
 * The file without the rule in that one list. Undefined when the file no longer
 * has it, because it changed since the list was read. The other list is never
 * touched, so removing an allow rule cannot loosen a deny rule.
 */
export function removeClaudePermissionRule(text: string, rule: Pick<ClaudePermissionRule, 'rule' | 'effect'>): string | undefined {
	const path = permissionPath(rule.effect);
	const list = valueAt(parseClaudeSettings(text), path);
	if (!Array.isArray(list) || !list.includes(rule.rule)) {
		return undefined;
	}
	const rest = list.filter(item => item !== rule.rule);
	return rest.length ? applyEdits(text, setProperty(text, path, rest, claudeSettingsFormatting(text))) : removeAt(text, path);
}
