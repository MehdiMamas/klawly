/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Inclusive range checked against Claude Code 2.1.296. An older version warns; a newer one
 * is only noted in the log, since Claude Code updates itself (issues 696, 707).
 * Only `knownBad` versions hard-block.
 */
export const TESTED_CLAUDE_RUNTIME_MIN = '2.1.0';
export const TESTED_CLAUDE_RUNTIME_MAX = '2.1.296';

/**
 * The first Claude Code that streams summarized thinking text (issue 740).
 */
export const CLAUDE_THINKING_DISPLAY_MIN = '2.1.281';

/** True when `version` takes `--thinking-display`. An unknown version is not asked. */
export function claudeSupportsThinkingDisplay(version: string | undefined): boolean {
	return version !== undefined && compareClaudeVersions(version, CLAUDE_THINKING_DISPLAY_MIN) >= 0;
}

export type ClaudeVersionDisposition = 'ok' | 'newer' | 'warn' | 'block';

export interface ClaudeVersionAssessment {
	readonly disposition: ClaudeVersionDisposition;
	readonly version: string;
	readonly message?: string;
}

export function parseClaudeVersion(stdout: string): string | undefined {
	const match = /(\d+\.\d+\.\d+)/.exec(stdout);
	return match?.[1];
}

export function compareClaudeVersions(left: string, right: string): number {
	const a = left.split('.').map(part => Number.parseInt(part, 10));
	const b = right.split('.').map(part => Number.parseInt(part, 10));
	const length = Math.max(a.length, b.length);
	for (let index = 0; index < length; index++) {
		const av = a[index] ?? 0;
		const bv = b[index] ?? 0;
		if (Number.isNaN(av) || Number.isNaN(bv)) {
			return 0;
		}
		if (av !== bv) {
			return av < bv ? -1 : 1;
		}
	}
	return 0;
}

export function assessClaudeRuntimeVersion(version: string, options?: { readonly knownBad?: readonly string[]; readonly min?: string; readonly max?: string }): ClaudeVersionAssessment {
	const knownBad = options?.knownBad ?? [];
	const min = options?.min ?? TESTED_CLAUDE_RUNTIME_MIN;
	const max = options?.max ?? TESTED_CLAUDE_RUNTIME_MAX;
	if (knownBad.includes(version)) {
		return {
			disposition: 'block',
			version,
			message: `Claude Code ${version} is a known incompatible runtime.`,
		};
	}
	if (compareClaudeVersions(version, min) < 0) {
		return {
			disposition: 'warn',
			version,
			message: `Claude Code ${version} is older than the tested range ${min}-${max}. Klawly will keep running it.`,
		};
	}
	if (compareClaudeVersions(version, max) > 0) {
		return {
			disposition: 'newer',
			version,
			message: `Claude Code ${version} is newer than the last version tested with Klawly (${max}).`,
		};
	}
	return { disposition: 'ok', version };
}
