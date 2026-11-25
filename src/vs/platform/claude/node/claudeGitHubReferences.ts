/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeGitHubReference } from '../common/claudeProtocol.js';

/**
 * A pull request or issue URL on github.com: owner, repository, `pull` or
 * `issues`, and a number that is not followed by more word characters. A tail
 * such as `/files` or `#issuecomment-1` still names the same pull request or
 * issue; `pull/new/<branch>` (what `git push` prints) has no number and does
 * not match.
 */
const GITHUB_REFERENCE = /https?:\/\/(?:www\.)?github\.com\/(?<owner>[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/(?<repo>[A-Za-z0-9._-]{1,100})\/(?<kind>pull|issues)\/(?<number>[1-9]\d{0,9})(?![\w])/g;

/** `gh pr create` and `gh issue create`, anywhere in a shell command line. */
const GH_CREATE_COMMAND = /(?:^|[\s;&|(])gh\s+(?:pr|issue)\s+create\b/;

/** A GitHub MCP server's create tools, such as `mcp__github__create_pull_request`. */
const MCP_CREATE_TOOL = /^mcp__.+__(?:create_pull_request|create_issue)$/;

/**
 * The pull requests and issues `text` links to, in order, once each. Matching
 * is on the URL's shape only (issue 430): no network call.
 */
export function findGitHubReferences(text: string, createdBySession: boolean): ClaudeGitHubReference[] {
	const references = new Map<string, ClaudeGitHubReference>();
	for (const match of text.matchAll(GITHUB_REFERENCE)) {
		const groups = match.groups;
		if (!groups) {
			continue;
		}
		const number = Number(groups.number);
		const repo = groups.repo.replace(/\.git$/, '');
		if (!Number.isSafeInteger(number) || !repo || repo === '.' || repo === '..') {
			continue;
		}
		const kind = groups.kind === 'pull' ? 'pullRequest' : 'issue';
		const url = `https://github.com/${groups.owner}/${repo}/${groups.kind}/${number}`;
		if (!references.has(url)) {
			references.set(url, { url, owner: groups.owner, repo, number, kind, createdBySession });
		}
	}
	return [...references.values()];
}

/**
 * Whether a tool call creates a pull request or issue, so the URL its output
 * prints belongs to this session: `gh pr create` or `gh issue create` in a
 * Bash command, or a GitHub MCP server's create tool.
 */
export function createsGitHubReference(toolName: string, input: unknown): boolean {
	if (MCP_CREATE_TOOL.test(toolName)) {
		return true;
	}
	if (toolName !== 'Bash' || typeof input !== 'object' || input === null) {
		return false;
	}
	const command = (input as { command?: unknown }).command;
	return typeof command === 'string' && GH_CREATE_COMMAND.test(command);
}
