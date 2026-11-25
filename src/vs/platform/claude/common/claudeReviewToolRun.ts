/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { claudeFindingId, claudeReviewMarkAddressed, claudeReviewMcpFindings } from './claudeReviewCli.js';
import { applyClaudeReviewSuggestion, ClaudeReviewToolHost } from './claudeReviewTools.js';

type ToolText = { readonly text: string; readonly isError?: boolean };

/** `get_review_findings`. */
export async function runClaudeReviewFindingsTool(host: ClaudeReviewToolHost): Promise<ToolText> {
	const review = await host.read();
	return { text: JSON.stringify({ reviewedSha: review?.reviewedSha ?? null, findings: claudeReviewMcpFindings(review) }, undefined, 2) };
}

/** `mark_addressed`. */
export async function runClaudeReviewMarkTool(host: ClaudeReviewToolHost, ids: readonly unknown[]): Promise<ToolText> {
	const review = await host.read();
	if (!review) {
		return { text: 'There is no stored review for this checkout.', isError: true };
	}
	const result = claudeReviewMarkAddressed(review, ids);
	if (result.changed) {
		await host.write(result.review);
	}
	return { text: `${result.changed} finding(s) marked addressed.` };
}

/** `apply_suggestion`. */
export async function runClaudeReviewApplyTool(host: ClaudeReviewToolHost, id: string): Promise<ToolText> {
	const review = await host.read();
	const entry = review?.findings.find(item => item.status === 'open' && claudeFindingId(item.finding) === id);
	if (!review || !entry) {
		return { text: `No open finding has the id ${id}.`, isError: true };
	}
	const content = await host.readFile(entry.finding.file);
	if (content === undefined) {
		return { text: `${entry.finding.file} cannot be read inside this checkout.`, isError: true };
	}
	const applied = applyClaudeReviewSuggestion(content, entry.finding);
	if (!applied.ok) {
		return { text: applied.reason, isError: true };
	}
	if (!await host.writeFile(entry.finding.file, applied.content)) {
		return { text: `${entry.finding.file} cannot be written inside this checkout.`, isError: true };
	}
	await host.write(claudeReviewMarkAddressed(review, [id]).review);
	return { text: `Applied the suggestion to ${entry.finding.file}:${entry.finding.startLine}-${entry.finding.endLine} and marked it addressed.` };
}
