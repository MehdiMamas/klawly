/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A case the change has no test for, found by the review (issue 936). */
export interface ClaudeReviewTestGap {
	readonly file: string;
	readonly symbol: string;
	readonly caseDescription: string;
}

/** At most this many gaps are kept: a longer list is noise, not a to-do list. */
export const CLAUDE_REVIEW_TEST_GAPS_MAX = 10;

/** Where a requested test stands. Nothing is kept without Keep, so a failing test stays a proposed change. */
export type ClaudeReviewTestState = 'idle' | 'sent' | 'passed' | 'failed';

/** A status chip: a stable key for the label and a tone for the color. */
export interface ClaudeReviewReproduceChip {
	readonly key: 'sent' | 'reproduced' | 'unexpectedPass';
	readonly tone: 'info' | 'good' | 'bad';
}

export interface ClaudeReviewTestChip {
	readonly key: 'sent' | 'passed' | 'failed';
	readonly tone: 'info' | 'good' | 'bad';
}

/**
 * Reads the optional `testGaps` of a summary. Rows missing a file, a symbol or a case are
 * dropped, repeated rows are kept once, and the list is capped. Pure.
 */
export function readClaudeReviewTestGaps(value: unknown): readonly ClaudeReviewTestGap[] {
	const gaps: ClaudeReviewTestGap[] = [];
	const seen = new Set<string>();
	for (const row of Array.isArray(value) ? value : []) {
		const { file, symbol, caseDescription } = (typeof row === 'object' && row !== null ? row : {}) as { file?: unknown; symbol?: unknown; caseDescription?: unknown };
		if (typeof file !== 'string' || typeof symbol !== 'string' || typeof caseDescription !== 'string') {
			continue;
		}
		const gap = { file: file.trim(), symbol: symbol.trim(), caseDescription: caseDescription.trim() };
		const key = `${gap.file}\n${gap.symbol}\n${gap.caseDescription}`;
		if (gap.file && gap.symbol && gap.caseDescription && !seen.has(key)) {
			seen.add(key);
			gaps.push(gap);
			if (gaps.length === CLAUDE_REVIEW_TEST_GAPS_MAX) {
				break;
			}
		}
	}
	return gaps;
}

const COMMON_RULES = [
	'Write it in the style of the tests already in this repository, next to the code it covers.',
	'Use the narrow test command from the project instructions to run only that test, never the whole suite. Commands ask the person first.',
	'Then end your reply with one line, `Test result: passed` or `Test result: failed`, followed by the command you ran.',
	'Do not change the code under test. A test that fails stays as a proposed change for the person to Keep or discard.',
].join(' ');

/** The fixed turn the Write Test action sends for one gap. Pure. */
export function buildClaudeWriteTestPrompt(gap: ClaudeReviewTestGap): string {
	return `Write a test for \`${gap.symbol}\` in \`${gap.file}\`. Case: ${gap.caseDescription}\n\n${COMMON_RULES}`;
}

/** The fixed turn the Reproduce with a Test action sends for one finding. Pure. */
export function buildClaudeReproduceTestPrompt(finding: { readonly file: string; readonly startLine: number; readonly title: string; readonly body: string }): string {
	return `Write a failing test that shows this review finding is real: ${finding.title} (\`${finding.file}\` line ${finding.startLine}).\n\n${finding.body}\n\n${COMMON_RULES} It should fail now for the reason the finding names. End your reply with one line: \`Test result: failed\` when the test fails for that reason (the finding is real), or \`Test result: passed\` when it passes (the finding looks wrong).`;
}

/**
 * The outcome the agent reported on its closing `Test result:` line, or `undefined`
 * when the reply has none (the chip then stays on Sent). The last such line wins. Pure.
 */
export function parseClaudeReviewTestResult(reply: string): 'passed' | 'failed' | undefined {
	let result: 'passed' | 'failed' | undefined;
	for (const match of reply.matchAll(/^[\s>*_`-]*test result:[\s*_`]*(?<outcome>passed|failed)\b/gim)) {
		result = match.groups?.outcome.toLowerCase() === 'passed' ? 'passed' : 'failed';
	}
	return result;
}

/**
 * The chip of a finding's Reproduce with a Test (issue 1398). The test is meant to fail, so a
 * `failed` result reads Reproduced and a `passed` one reads Passes Unexpectedly. Pure.
 */
export function claudeReviewReproduceChip(state: ClaudeReviewTestState): ClaudeReviewReproduceChip | undefined {
	switch (state) {
		case 'sent': return { key: 'sent', tone: 'info' };
		case 'failed': return { key: 'reproduced', tone: 'good' };
		case 'passed': return { key: 'unexpectedPass', tone: 'bad' };
		default: return undefined;
	}
}

/** The chip for a state, or `undefined` while nothing was requested. */
export function claudeReviewTestChip(state: ClaudeReviewTestState): ClaudeReviewTestChip | undefined {
	switch (state) {
		case 'sent': return { key: 'sent', tone: 'info' };
		case 'passed': return { key: 'passed', tone: 'good' };
		case 'failed': return { key: 'failed', tone: 'bad' };
		default: return undefined;
	}
}

/** Markdown list of the gaps for the copied summary. */
export function formatClaudeReviewTestGaps(gaps: readonly ClaudeReviewTestGap[]): string {
	return ['## Test Gaps', '', ...gaps.map(gap => `- \`${gap.symbol}\` (\`${gap.file}\`): ${gap.caseDescription.replace(/\s*\r?\n\s*/g, ' ')}`)].join('\n');
}
