/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_AUTO_CLASSIFIER_MODEL, CLAUDE_AUTO_MODEL_SCHEMA, ClaudeAutoModelClassification, ClaudeAutoModelRequest, claudeAutoModelPrompt, readClaudeAutoClassification } from '../common/claudeAutoModel.js';
import { ClaudeQueryFactory } from './claudeQuery.js';
import { runClaudeStructuredQuery } from './claudeStructuredQuery.js';

/** The classifier reads only the prompt: one answer, plus the SDK's structured-output retries. */
const CLASSIFIER_MAX_TURNS = 2;

export interface ClaudeAutoModelRun {
	readonly queryFactory: ClaudeQueryFactory;
	readonly request: ClaudeAutoModelRequest;
	readonly abort: AbortController;
	readonly env: Readonly<Record<string, string>>;
	readonly executablePath?: string;
}

/**
 * Auto model's classifier (issue 521): one structured query on Haiku with no
 * tools that rates how hard the prompt is. Never throws.
 */
export async function runClaudeAutoModelClassifier(run: ClaudeAutoModelRun): Promise<ClaudeAutoModelClassification> {
	const result = await runClaudeStructuredQuery({
		queryFactory: run.queryFactory,
		prompt: claudeAutoModelPrompt(run.request),
		cwd: run.request.cwd,
		schema: CLAUDE_AUTO_MODEL_SCHEMA,
		validate: readClaudeAutoClassification,
		model: CLAUDE_AUTO_CLASSIFIER_MODEL,
		tools: [],
		maxTurns: CLASSIFIER_MAX_TURNS,
		abort: run.abort,
		env: run.env,
		executablePath: run.executablePath,
	});
	if (result.ok) {
		return { ok: true, ...result.value };
	}
	switch (result.failure.kind) {
		case 'cancelled':
			return { ok: false, cancelled: true, message: 'Auto model was cancelled.' };
		case 'failed':
			return { ok: false, message: result.failure.message };
		case 'malformed':
			return { ok: false, message: 'Claude did not rate the prompt.' };
	}
}
