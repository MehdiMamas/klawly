/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The file, in the user's `.klawly` folder per repository, that keeps the dismissed findings (issue 871). */
export const CLAUDE_FINDINGS_FILE_NAME = '.klawly-findings.json';

/** How every security finding is written, so the findings list can read them later. */
export const CLAUDE_SECURITY_FINDING_FORMAT = '`path:line [critical|high|medium|low] category: what an attacker could do, and how to fix it`';

/** True when an automation's prompt asks for findings in that format: a security run (issue 1076). */
export function isClaudeSecurityAutomationPrompt(prompt: string): boolean {
	return prompt.includes(CLAUDE_SECURITY_FINDING_FORMAT);
}

export type ClaudeSecuritySeverity = 'critical' | 'high' | 'medium' | 'low';

/** One finding of a security run: `path:line [severity] category: detail`. */
export interface ClaudeSecurityFinding {
	/** Stable across runs: the same file, line, severity and category give the same key. */
	readonly key: string;
	readonly file: string;
	readonly line: number;
	readonly severity: ClaudeSecuritySeverity;
	readonly category: string;
	readonly detail: string;
}

const SEVERITY_RANK: Readonly<Record<ClaudeSecuritySeverity, number>> = { critical: 0, high: 1, medium: 2, low: 3 };

const FINDING_LINE = /^\s*(?:[-*]\s+)?`?(?<file>[^\s:`[\]][^:`[\]]*?):(?<line>\d+)\s+\[(?<severity>critical|high|medium|low)\]\s+(?<category>[^:`]+?):\s*(?<detail>.+?)`?\s*$/i;

/** The key a finding is dismissed by. */
export function claudeSecurityFindingKey(file: string, line: number, severity: ClaudeSecuritySeverity, category: string): string {
	return `${file.replace(/\\/g, '/')}:${line}:${severity}:${category.trim().toLowerCase()}`;
}

/**
 * Reads the findings out of a run's answer. Lines that are not in the format
 * (the intro, "No findings.", a summary) are skipped; a repeated finding counts once.
 * Worst first, then by file and line.
 */
export function parseClaudeSecurityFindings(text: string): readonly ClaudeSecurityFinding[] {
	const seen = new Set<string>();
	const findings: ClaudeSecurityFinding[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const groups = FINDING_LINE.exec(raw)?.groups;
		if (!groups) {
			continue;
		}
		const severity = groups.severity.toLowerCase() as ClaudeSecuritySeverity;
		const file = groups.file.trim().replace(/\\/g, '/');
		const line = Number(groups.line);
		const category = groups.category.trim();
		const key = claudeSecurityFindingKey(file, line, severity, category);
		if (line < 1 || seen.has(key)) {
			continue;
		}
		seen.add(key);
		findings.push({ key, file, line, severity, category, detail: groups.detail.trim() });
	}
	return findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
}

/** A dismissed finding and why. */
export interface ClaudeDismissedFinding {
	readonly key: string;
	readonly reason: string;
	readonly at: number;
}

export interface ClaudeFindingsFile {
	readonly dismissed: readonly ClaudeDismissedFinding[];
}

/** Reads `.klawly-findings.json`. A missing, broken or foreign file is an empty one. */
export function parseClaudeFindingsFile(text: string): ClaudeFindingsFile {
	let value: { dismissed?: unknown } | null;
	try {
		value = JSON.parse(text);
	} catch {
		return { dismissed: [] };
	}
	const list = value?.dismissed;
	if (!Array.isArray(list)) {
		return { dismissed: [] };
	}
	const dismissed: ClaudeDismissedFinding[] = [];
	for (const entry of list as readonly Partial<ClaudeDismissedFinding>[]) {
		if (entry && typeof entry.key === 'string' && typeof entry.reason === 'string' && typeof entry.at === 'number') {
			dismissed.push({ key: entry.key, reason: entry.reason, at: entry.at });
		}
	}
	return { dismissed };
}

export function stringifyClaudeFindingsFile(file: ClaudeFindingsFile): string {
	return JSON.stringify(file, undefined, '\t') + '\n';
}

/** Dismisses a finding; dismissing it again replaces the reason. */
export function dismissClaudeFinding(file: ClaudeFindingsFile, key: string, reason: string, at: number): ClaudeFindingsFile {
	return { dismissed: [...file.dismissed.filter(entry => entry.key !== key), { key, reason: reason.trim(), at }] };
}

/** Dismisses every finding in `keys` with one reason (issue 1076, Dismiss All). */
export function dismissClaudeFindings(file: ClaudeFindingsFile, keys: readonly string[], reason: string, at: number): ClaudeFindingsFile {
	return keys.reduce((next, key) => dismissClaudeFinding(next, key, reason, at), file);
}

/** Brings a dismissed finding back. */
export function restoreClaudeFinding(file: ClaudeFindingsFile, key: string): ClaudeFindingsFile {
	return { dismissed: file.dismissed.filter(entry => entry.key !== key) };
}

/** The findings that are still open: not dismissed. */
export function openClaudeSecurityFindings(findings: readonly ClaudeSecurityFinding[], file: ClaudeFindingsFile): readonly ClaudeSecurityFinding[] {
	const dismissed = new Set(file.dismissed.map(entry => entry.key));
	return findings.filter(finding => !dismissed.has(finding.key));
}

/** What Fix with Agent sends to the background agent. */
export function claudeSecurityFixPrompt(finding: ClaudeSecurityFinding): string {
	return [
		`Fix this security finding in ${finding.file} at line ${finding.line} (${finding.severity}, ${finding.category}):`,
		'',
		finding.detail,
		'',
		'Change only what the fix needs, keep the behavior the code has for valid input, and add or update a test that fails without the fix. Do not commit or push.',
	].join('\n');
}
