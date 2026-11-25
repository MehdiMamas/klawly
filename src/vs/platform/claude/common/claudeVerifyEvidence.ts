/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeBrowserImage } from './claudeBrowserTool.js';

/** Most screenshots one turn keeps; the oldest steps drop first, the first and the last stay. */
export const CLAUDE_VERIFY_MAX_SHOTS = 12;

/** Most console lines one turn keeps; the oldest drop first. */
export const CLAUDE_VERIFY_MAX_CONSOLE = 50;

/** Fewest frames that count as a recording; fewer are just screenshots. */
export const CLAUDE_VERIFY_MIN_RECORDING_FRAMES = 3;

/** Where a screenshot sits in a verification: `before` the change, `after` it, or a `step` between. */
export type ClaudeVerifyShotLabel = 'before' | 'after' | 'step';

/** One screenshot the Agent Browser took while verifying a UI change. */
export interface ClaudeVerifyShot extends ClaudeBrowserImage {
	readonly label: ClaudeVerifyShotLabel;
	/** When it was taken, in milliseconds since the epoch. */
	readonly at: number;
}

/** What one turn collected while it verified a UI change (issue 1495). */
export interface ClaudeVerifyEvidence {
	readonly shots: readonly ClaudeVerifyShot[];
	/** Console errors, warnings and uncaught page errors, oldest first, without repeats. */
	readonly consoleErrors: readonly string[];
}

/** No evidence yet. */
export const EMPTY_CLAUDE_VERIFY_EVIDENCE: ClaudeVerifyEvidence = { shots: [], consoleErrors: [] };

/** True when nothing was collected, so the Review editor shows no card. */
export function isClaudeVerifyEvidenceEmpty(evidence: ClaudeVerifyEvidence): boolean {
	return evidence.shots.length === 0 && evidence.consoleErrors.length === 0;
}

/**
 * Adds a screenshot. The first one is `before`, the newest is `after` and the ones in
 * between are `step`s. Past the cap the oldest step drops, never the first or the last.
 */
export function addClaudeVerifyShot(evidence: ClaudeVerifyEvidence, image: ClaudeBrowserImage, at: number): ClaudeVerifyEvidence {
	const previous = evidence.shots.map((shot, index) => index === 0 ? shot : { ...shot, label: 'step' as const });
	const shots: ClaudeVerifyShot[] = [...previous, { ...image, label: previous.length === 0 ? 'before' : 'after', at }];
	while (shots.length > CLAUDE_VERIFY_MAX_SHOTS) {
		shots.splice(1, 1);
	}
	return { ...evidence, shots };
}

/** True for a console line the browser tool wrote for an error, a warning or an uncaught page error. */
export function isClaudeVerifyConsoleProblem(line: string): boolean {
	return /^\[(error|warning|pageerror)\]/.test(line);
}

/** Adds the problem lines of a `console` read (one line each) and ignores logs, info and debug lines. */
export function addClaudeVerifyConsole(evidence: ClaudeVerifyEvidence, text: string): ClaudeVerifyEvidence {
	const seen = new Set(evidence.consoleErrors);
	const consoleErrors = [...evidence.consoleErrors];
	for (const line of text.split(/\r?\n/)) {
		if (isClaudeVerifyConsoleProblem(line) && !seen.has(line)) {
			seen.add(line);
			consoleErrors.push(line);
		}
	}
	return consoleErrors.length === evidence.consoleErrors.length ? evidence : { ...evidence, consoleErrors: consoleErrors.slice(-CLAUDE_VERIFY_MAX_CONSOLE) };
}

/**
 * The frames of the recording, oldest first, or none. The Agent Browser has no video
 * capture, so a recording is the screenshots of the turn played in order.
 */
export function claudeVerifyRecording(evidence: ClaudeVerifyEvidence): readonly ClaudeVerifyShot[] {
	return evidence.shots.length >= CLAUDE_VERIFY_MIN_RECORDING_FRAMES ? evidence.shots : [];
}
