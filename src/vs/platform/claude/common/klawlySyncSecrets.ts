/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { scanClaudeSecrets } from './claudeSecretScan.js';
import { KlawlySyncSnapshot } from './klawlySyncMerge.js';

/**
 * Klawly Sync's safety net (issue 447). Before a push, MCP `env` and `headers` values become
 * `${secret:NAME}` placeholders (the real values stay in the local secret store), and the
 * secret scanner checks what is left. A file the scanner still flags blocks the push.
 */
const PLACEHOLDER = /^\$\{secret:(?<name>[A-Za-z0-9_.-]+)\}$/;
const PLACEHOLDER_ANYWHERE = /\$\{secret:(?<name>[A-Za-z0-9_.-]+)\}/g;

export function klawlySecretPlaceholder(name: string): string {
	return '${secret:' + name + '}';
}

/** A file the scanner flagged: its path and how many secrets, never the secrets themselves. */
export interface KlawlySyncSecretFinding {
	readonly path: string;
	readonly count: number;
}

export interface KlawlyPortableSnapshot {
	/** The snapshot to push: secrets replaced by placeholders. */
	readonly files: KlawlySyncSnapshot;
	/** The secret values the placeholders stand for, to store locally by name. */
	readonly secrets: Readonly<Record<string, string>>;
	/** Files that still carry a secret after the placeholders. Non-empty means: do not push. */
	readonly findings: readonly KlawlySyncSecretFinding[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function placeholderName(server: string, kind: 'env' | 'headers', key: string): string {
	return `MCP_${server}_${kind === 'env' ? '' : 'HEADER_'}${key}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

/** `.mcp.json` text with every `env` and `headers` value of every server replaced by a placeholder. */
function placeholdMcp(text: string, secrets: Record<string, string>): string {
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		return text;
	}
	if (!isPlainObject(doc) || !isPlainObject(doc.mcpServers)) {
		return text;
	}
	for (const [server, config] of Object.entries(doc.mcpServers)) {
		if (!isPlainObject(config)) {
			continue;
		}
		for (const kind of ['env', 'headers'] as const) {
			const values = config[kind];
			if (!isPlainObject(values)) {
				continue;
			}
			for (const [key, value] of Object.entries(values)) {
				if (typeof value !== 'string' || PLACEHOLDER.test(value) || value === '') {
					continue;
				}
				const name = placeholderName(server, kind, key);
				secrets[name] = value;
				values[key] = klawlySecretPlaceholder(name);
			}
		}
	}
	return JSON.stringify(doc, undefined, '\t') + '\n';
}

/** Makes `files` safe to push. See {@link KlawlyPortableSnapshot}. */
export function makeKlawlySnapshotPortable(files: KlawlySyncSnapshot): KlawlyPortableSnapshot {
	const secrets: Record<string, string> = {};
	const portable: Record<string, string | null> = {};
	const findings: KlawlySyncSecretFinding[] = [];
	for (const [path, text] of Object.entries(files)) {
		if (text === null) {
			portable[path] = null;
			continue;
		}
		const out = (path.split('/').pop() === '.mcp.json') ? placeholdMcp(text, secrets) : text;
		portable[path] = out;
		// A placeholder is what a secret was replaced with; the key-value rule flags it by its key name.
		const count = scanClaudeSecrets(out).filter(span => !PLACEHOLDER.test(out.slice(span.start, span.end))).length;
		if (count > 0) {
			findings.push({ path, count });
		}
	}
	return { files: portable, secrets, findings };
}

export interface KlawlyRestoredSnapshot {
	readonly files: KlawlySyncSnapshot;
	/** Placeholder names this machine has no value for. It asks for them. */
	readonly missing: readonly string[];
}

/** Puts local secret values back for the placeholders in `files`. A missing value keeps its placeholder. */
export function restoreKlawlySnapshotSecrets(files: KlawlySyncSnapshot, lookup: (name: string) => string | undefined): KlawlyRestoredSnapshot {
	const missing = new Set<string>();
	const restored: Record<string, string | null> = {};
	for (const [path, text] of Object.entries(files)) {
		if (text === null || path.split('/').pop() !== '.mcp.json') {
			restored[path] = text;
			continue;
		}
		restored[path] = restoreMcp(text, lookup, missing);
	}
	return { files: restored, missing: [...missing].sort() };
}

function restoreMcp(text: string, lookup: (name: string) => string | undefined, missing: Set<string>): string {
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		return text;
	}
	if (!isPlainObject(doc) || !isPlainObject(doc.mcpServers)) {
		return text;
	}
	for (const config of Object.values(doc.mcpServers)) {
		if (!isPlainObject(config)) {
			continue;
		}
		for (const kind of ['env', 'headers'] as const) {
			const values = config[kind];
			if (!isPlainObject(values)) {
				continue;
			}
			for (const [key, value] of Object.entries(values)) {
				if (typeof value !== 'string') {
					continue;
				}
				values[key] = value.replace(PLACEHOLDER_ANYWHERE, (whole, name: string) => {
					const real = lookup(name);
					if (real === undefined) {
						missing.add(name);
						return whole;
					}
					return real;
				});
			}
		}
	}
	return JSON.stringify(doc, undefined, '\t') + '\n';
}
