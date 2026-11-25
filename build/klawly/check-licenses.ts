/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks the licenses of production npm dependencies against an allowlist.
// Usage: node build/klawly/check-licenses.ts [folder ...]
// Each folder needs a package-lock.json (lockfile v2 or v3). The default is the repo root.
// The license comes from the lockfile, or from the installed package.json when the
// lockfile has none. Exit code 1 when a package has a license outside the allowlist,
// or no license at all, and is not listed in EXCEPTIONS. No dependencies.

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

interface LockEntry {
	readonly name?: string;
	readonly version?: string;
	readonly license?: unknown;
	readonly dev?: boolean;
	readonly optional?: boolean;
	readonly devOptional?: boolean;
	readonly link?: boolean;
}

interface CheckResult {
	readonly lockPath: string;
	readonly checked: number;
	readonly counts: Map<string, number>;
	readonly failures: string[];
	readonly excepted: string[];
	readonly notInstalled: string[];
}

/** SPDX ids allowed in shipped code: permissive licenses, plus MPL-2.0 (file-level copyleft). */
const ALLOWED = new Set<string>([
	'0BSD', 'Apache-2.0', 'BlueOak-1.0.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BSL-1.0', 'CC-BY-3.0', 'CC-BY-4.0',
	'CC0-1.0', 'ISC', 'MIT', 'MIT-0', 'MPL-2.0', 'OFL-1.1', 'Python-2.0', 'Unlicense', 'WTFPL', 'Zlib',
]);

/** Packages allowed despite their license, each with the reason. A trailing `*` matches a prefix. */
const EXCEPTIONS = new Map<string, string>([
	['jschardet', 'LGPL-2.1+ encoding detector inherited from Code - OSS, shipped unmodified as its own module, as upstream ships it.'],
]);

/** Common non-SPDX spellings found in older package.json files. */
const ALIASES = new Map<string, string>([
	['Apache 2.0', 'Apache-2.0'], ['Apache License 2.0', 'Apache-2.0'], ['Apache2', 'Apache-2.0'],
	['BSD', 'BSD-2-Clause'], ['MIT/X11', 'MIT'], ['Public Domain', 'Unlicense'],
]);

function exceptionFor(name: string): string | undefined {
	for (const [pattern, reason] of EXCEPTIONS) {
		if (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern) {
			return reason;
		}
	}
	return undefined;
}

function licenseText(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value.trim();
	}
	if (Array.isArray(value)) {
		const parts = value.map(licenseText).filter((part): part is string => !!part);
		return parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0];
	}
	const type = value && typeof value === 'object' ? (value as { type?: unknown }).type : undefined;
	if (typeof type === 'string') {
		return type.trim();
	}
	return undefined;
}

/** True when the SPDX expression can be satisfied with allowed licenses. */
function isAllowed(expression: string): boolean {
	const text = ALIASES.get(expression) ?? expression;
	const unwrapped = text.replace(/^\((.*)\)$/, '$1').trim();
	if (/\s+OR\s+/i.test(unwrapped)) {
		return unwrapped.split(/\s+OR\s+/i).some(part => isAllowed(part.trim()));
	}
	if (/\s+AND\s+/i.test(unwrapped)) {
		return unwrapped.split(/\s+AND\s+/i).every(part => isAllowed(part.trim()));
	}
	const base = unwrapped.replace(/\s+WITH\s+.*$/i, '').replace(/\+$/, '');
	return ALLOWED.has(ALIASES.get(base) ?? base);
}

function packageName(key: string): string {
	const index = key.lastIndexOf('node_modules/');
	return key.slice(index + 'node_modules/'.length);
}

function check(folder: string): CheckResult {
	const lockPath = join(folder, 'package-lock.json');
	const lock: { packages?: Record<string, LockEntry> } = JSON.parse(readFileSync(lockPath, 'utf8'));
	if (!lock.packages) {
		throw new Error(`${lockPath}: lockfile v2 or v3 expected`);
	}
	const counts = new Map<string, number>();
	const failures: string[] = [];
	const excepted: string[] = [];
	const notInstalled: string[] = [];
	let checked = 0;
	for (const [key, entry] of Object.entries(lock.packages)) {
		if (!key || entry.dev || entry.link) {
			continue;
		}
		const name = entry.name ?? packageName(key);
		const manifestPath = join(folder, key, 'package.json');
		let license = licenseText(entry.license);
		if (!license && existsSync(manifestPath)) {
			const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
			license = licenseText(manifest.license ?? manifest.licenses);
		}
		if (!license && (entry.optional || entry.devOptional) && !existsSync(manifestPath)) {
			notInstalled.push(`${name}@${entry.version}`);
			continue;
		}
		checked++;
		const label = license ?? 'UNKNOWN';
		counts.set(label, (counts.get(label) ?? 0) + 1);
		if (license && isAllowed(license)) {
			continue;
		}
		const reason = exceptionFor(name);
		if (reason) {
			excepted.push(`${name}@${entry.version} (${label}): ${reason}`);
		} else {
			failures.push(`${name}@${entry.version} (${label}) at ${key}`);
		}
	}
	return { lockPath, checked, counts, failures, excepted, notInstalled };
}

const folders = process.argv.slice(2);
let failed = false;
for (const folder of folders.length > 0 ? folders : ['.']) {
	const result = check(resolve(folder));
	console.log(`${result.lockPath}: ${result.checked} production packages checked`);
	for (const [license, count] of [...result.counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
		console.log(`  ${String(count).padStart(4)}  ${license}`);
	}
	if (result.notInstalled.length > 0) {
		console.log(`  Skipped ${result.notInstalled.length} optional packages that are not installed on this platform and have no license in the lockfile: ${result.notInstalled.join(', ')}`);
	}
	for (const line of result.excepted) {
		console.log(`  Allowed by exception: ${line}`);
	}
	for (const line of result.failures) {
		console.log(`  NOT ALLOWED: ${line}`);
	}
	failed ||= result.failures.length > 0;
}
console.log(failed ? 'License check failed.' : 'License check passed.');
process.exitCode = failed ? 1 : 0;
