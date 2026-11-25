/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The review knowledge file (issue 933): a short Markdown file the person can edit, with the
 * modules, the glossary, the risky areas and the past reverts of the project. The reviewer reads
 * it so it does not rediscover the repository on every run. It never leaves the machine.
 */

/** Where the generated file lives, relative to the project folder. */
export const CLAUDE_REVIEW_KNOWLEDGE_FILE = '.claude/review-knowledge.md';

/** Most characters of the knowledge file a review reads; apart from the budget of the review notes. */
export const CLAUDE_REVIEW_KNOWLEDGE_BUDGET = 12_000;

/** Changed files since the file was written after which the reader suggests regenerating it. */
export const CLAUDE_REVIEW_KNOWLEDGE_STALE_FILES = 200;

/** The `git log` arguments that list revert commits: a record per commit, fields split by 0x1f, records by 0x1e. */
export const CLAUDE_REVIEW_REVERTS_LOG_ARGS: readonly string[] = ['log', '--no-color', '-i', '--grep=revert', '--grep=rollback', '-n', '200', '--format=%H%x1f%s%x1f%b%x1e'];

export interface ClaudeRevert {
	/** The reverting commit. */
	readonly sha: string;
	/** What it reverted: the quoted subject of a `Revert "..."` commit, else its own subject. */
	readonly subject: string;
	/** The commit it names as reverted ("This reverts commit <sha>"), when it does. */
	readonly revertedSha?: string;
}

/** Reads the output of `git log` with `CLAUDE_REVIEW_REVERTS_LOG_ARGS`; records that are not reverts are dropped. */
export function parseClaudeReverts(output: string): ClaudeRevert[] {
	const reverts: ClaudeRevert[] = [];
	for (const record of output.split('\x1e')) {
		const [sha, subject = '', body = ''] = record.trim().split('\x1f');
		if (!/^[0-9a-f]{40,64}$/.test(sha ?? '')) {
			continue;
		}
		const quoted = /^revert\s+"(?<what>.+)"$/i.exec(subject.trim());
		if (!quoted?.groups && !/\b(?:revert|rollback)\b/i.test(subject)) {
			continue;
		}
		const named = /this reverts commit (?<sha>[0-9a-f]{7,64})/i.exec(body);
		reverts.push({ sha, subject: (quoted?.groups?.what ?? subject).trim(), revertedSha: named?.groups?.sha });
	}
	return reverts;
}

/** The mined reverts as the prompt lines the generator is given, newest first, capped. */
export function claudeRevertLines(reverts: readonly ClaudeRevert[], limit = 30): string[] {
	return reverts.slice(0, limit).map(revert => `- ${revert.subject} (${revert.sha.slice(0, 9)}${revert.revertedSha ? `, reverted ${revert.revertedSha.slice(0, 9)}` : ''})`);
}

/** The prompt that asks the agent to write the knowledge file. */
export function claudeReviewKnowledgePrompt(reverts: readonly ClaudeRevert[]): string {
	const lines = claudeRevertLines(reverts);
	return [
		`Write the review knowledge file for this project to ${CLAUDE_REVIEW_KNOWLEDGE_FILE}. Read the repository first (README, AGENTS.md, the folder layout, the main entry points); do not change any other file.`,
		`Keep it under ${Math.floor(CLAUDE_REVIEW_KNOWLEDGE_BUDGET / 1000)} thousand characters of plain Markdown, with exactly these sections:`,
		'## Modules: one line per module or folder, what it owns and what depends on it.',
		'## Glossary: the domain words and abbreviations a reviewer needs.',
		'## Risk Areas: code where a mistake is expensive (security, data loss, concurrency, migrations) and why.',
		'## Past Reverts: what was reverted and why, so a reviewer can say "this was reverted before". Use the commits below, and read a commit with git show when the reason is unclear.',
		...(lines.length ? ['', 'Reverts found in the history:', ...lines] : ['', 'No reverts were found in the history; write "None found." in that section.']),
		'',
		'The person edits this file by hand, so write short, factual lines. Never put secrets, tokens or personal data in it.',
	].join('\n');
}

/** The text of the file a review reads: cut to the budget with a note. Empty text is no knowledge. */
export function claudeReviewKnowledgeText(text: string | undefined): string | undefined {
	const trimmed = text?.trim();
	if (!trimmed) {
		return undefined;
	}
	return trimmed.length > CLAUDE_REVIEW_KNOWLEDGE_BUDGET ? `${trimmed.slice(0, CLAUDE_REVIEW_KNOWLEDGE_BUDGET)}\n[The knowledge file is cut here.]` : trimmed;
}

/** The review instructions with the knowledge block after the project's notes; either may be missing. */
export function claudeReviewInstructionsWithKnowledge(instructions: string | undefined, knowledge: string | undefined): string | undefined {
	const block = claudeReviewKnowledgeText(knowledge);
	if (!block) {
		return instructions;
	}
	const section = ['Background on this project (modules, glossary, risk areas, past reverts). Use it to judge risk and to say when a change was reverted before:', '<project_knowledge>', block, '</project_knowledge>'].join('\n');
	return instructions?.trim() ? `${instructions}\n\n${section}` : section;
}

/** True when enough files changed since the knowledge file was written that it is worth regenerating. */
export function isClaudeReviewKnowledgeStale(changedFilesSinceWritten: number): boolean {
	return changedFilesSinceWritten >= CLAUDE_REVIEW_KNOWLEDGE_STALE_FILES;
}
