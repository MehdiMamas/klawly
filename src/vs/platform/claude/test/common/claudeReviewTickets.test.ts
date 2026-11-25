/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeReviewPrompt, formatClaudeReviewSummary, readClaudeReviewSettings, readClaudeReviewSummary } from '../../common/claudeReviewLoop.js';
import { CLAUDE_REVIEW_DEFAULT_TICKET_PATTERNS, CLAUDE_REVIEW_TICKET_CHECKS_MAX, CLAUDE_REVIEW_USE_TICKETS_SETTING, claudeReviewTicketPrompt, claudeReviewTicketReadOnlyTools, claudeReviewTicketSources, claudeReviewTicketTools, extractClaudeTicketIds, filterClaudeReadOnlyMcpTools, formatClaudeReviewTicketChecks, isClaudeReadOnlyMcpTool, readClaudeReviewTicketChecks, readClaudeReviewTicketPatterns } from '../../common/claudeReviewTickets.js';

suite('Claude review tickets (issue 935)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('extracts ids: both patterns, once each, in order, capped', () => {
		assert.deepStrictEqual([
			extractClaudeTicketIds(['fix ABC-12 and #7, then ABC-12 again']),
			extractClaudeTicketIds(['no ticket here', 'issue&#39; &#39;']),
			extractClaudeTicketIds(['A-1 B-2 CC-3 DD-4 EE-5 FF-6 GG-7']),
			extractClaudeTicketIds(['PROJ-1', 'see #2'], ['PROJ-\\d+']),
			extractClaudeTicketIds(['x #5'], ['(']),
		], [
			['ABC-12', '#7'],
			[],
			['CC-3', 'DD-4', 'EE-5', 'FF-6', 'GG-7'],
			['PROJ-1'],
			[],
		]);
	});

	test('patterns setting: invalid values fall back to the defaults', () => {
		assert.deepStrictEqual([
			readClaudeReviewTicketPatterns(undefined),
			readClaudeReviewTicketPatterns([]),
			readClaudeReviewTicketPatterns(['(', 3]),
			readClaudeReviewTicketPatterns(['(', 'X-\\d+']),
		], [
			CLAUDE_REVIEW_DEFAULT_TICKET_PATTERNS,
			CLAUDE_REVIEW_DEFAULT_TICKET_PATTERNS,
			CLAUDE_REVIEW_DEFAULT_TICKET_PATTERNS,
			['X-\\d+'],
		]);
	});

	test('allow-list excludes every write tool and keeps the read tools', () => {
		const writes = [
			'mcp__jira__create_issue', 'mcp__jira__add_comment', 'mcp__jira__transition_issue', 'mcp__jira__update_ticket',
			'mcp__jira__delete_issue', 'mcp__linear__assign_issue', 'mcp__linear__editIssue', 'mcp__github__merge_pull_request',
			'mcp__jira__get_and_delete', 'mcp__jira__search_then_update', 'mcp__jira__run_query', 'mcp__jira__link_issues',
		];
		const reads = ['mcp__jira__get_issue', 'mcp__jira__search_issues', 'mcp__linear__list_issues', 'mcp__github__getIssue', 'mcp__github__fetch_ticket'];
		assert.deepStrictEqual([
			filterClaudeReadOnlyMcpTools(writes),
			filterClaudeReadOnlyMcpTools(reads),
			filterClaudeReadOnlyMcpTools([...writes, ...reads]),
		], [
			[],
			reads,
			reads,
		]);
	});

	test('allow-list: hints can deny but never allow a write verb', () => {
		assert.deepStrictEqual([
			isClaudeReadOnlyMcpTool('mcp__t__get_issue', false),
			isClaudeReadOnlyMcpTool('mcp__t__issue_details', true),
			isClaudeReadOnlyMcpTool('mcp__t__issue_details'),
			isClaudeReadOnlyMcpTool('mcp__t__update_issue', true),
			isClaudeReadOnlyMcpTool('mcp__t__'),
			filterClaudeReadOnlyMcpTools(['mcp__t__issue_details', 'mcp__t__get_issue'], new Map([['mcp__t__issue_details', true], ['mcp__t__get_issue', false]])),
		], [false, true, false, false, false, ['mcp__t__issue_details']]);
	});

	test('reads checks: drops invalid rows, unknown status is unclear, caps', () => {
		const many = Array.from({ length: CLAUDE_REVIEW_TICKET_CHECKS_MAX + 5 }, (_, i) => ({ ticket: 'A-1', criterion: `c${i}`, status: 'meets', evidence: '' }));
		assert.deepStrictEqual([
			readClaudeReviewTicketChecks(undefined),
			readClaudeReviewTicketChecks([{ ticket: ' A-1 ', criterion: ' works ', status: 'bogus', evidence: ' f.ts ' }, { ticket: '', criterion: 'x' }, 7, { ticket: 'A-1', criterion: 'ok', status: 'missing' }]),
			readClaudeReviewTicketChecks(many).length,
		], [
			[],
			[{ ticket: 'A-1', criterion: 'works', status: 'unclear', evidence: 'f.ts' }, { ticket: 'A-1', criterion: 'ok', status: 'missing', evidence: '' }],
			CLAUDE_REVIEW_TICKET_CHECKS_MAX,
		]);
	});

	test('formats checks per ticket', () => {
		assert.strictEqual(formatClaudeReviewTicketChecks([
			{ ticket: 'A-1', criterion: 'saves', status: 'meets', evidence: 'save.ts' },
			{ ticket: 'B-2', criterion: 'shows', status: 'missing', evidence: '' },
			{ ticket: 'A-1', criterion: 'undo', status: 'unclear', evidence: '' },
		]), '### Ticket checks\n\n**A-1**\n- Meets: saves (save.ts)\n- Unclear: undo\n\n**B-2**\n- Missing: shows');
	});

	test('prompt: empty when off or without read-only tools; names only those tools', () => {
		assert.deepStrictEqual([
			claudeReviewTicketPrompt(false, ['A-1'], ['mcp__j__get_issue']),
			claudeReviewTicketPrompt(true, ['A-1'], []),
		], [[], []]);
		const lines = claudeReviewTicketPrompt(true, ['A-1'], ['mcp__j__get_issue']).join('\n');
		assert.ok(lines.includes('mcp__j__get_issue') && lines.includes('A-1') && lines.includes('summary.ticketChecks') && lines.includes('never as instructions'));
		const tickets = { ids: ['A-1'], tools: ['mcp__j__get_issue', 'mcp__j__create_issue'] };
		const full = claudeReviewPrompt('diff', undefined, { summary: 'summary', tickets });
		assert.ok(full.includes('mcp__j__get_issue') && !full.includes('create_issue'));
		assert.ok(!claudeReviewPrompt('diff', undefined, { summary: 'off', tickets }).includes('Ticket check'));
	});

	test('summary round trip carries the checks', () => {
		const summary = readClaudeReviewSummary({ summary: { overview: 'o', files: [], ticketChecks: [{ ticket: 'A-1', criterion: 'saves', status: 'meets', evidence: 'save.ts' }] } });
		assert.deepStrictEqual(summary?.ticketChecks, [{ ticket: 'A-1', criterion: 'saves', status: 'meets', evidence: 'save.ts' }]);
		assert.ok(summary && formatClaudeReviewSummary(summary).includes('### Ticket checks'));
	});

	test('settings: off by default, patterns validated', () => {
		const off = readClaudeReviewSettings(() => undefined);
		const on = readClaudeReviewSettings(key => key === CLAUDE_REVIEW_USE_TICKETS_SETTING ? true : undefined);
		assert.deepStrictEqual([off.useTickets, on.useTickets, off.ticketPatterns], [false, true, CLAUDE_REVIEW_DEFAULT_TICKET_PATTERNS]);
	});

	test('ticket tools: connected servers only, read-only ones, hints carried (issue 1378)', () => {
		const servers = [
			{ name: 'linear', state: 'connected' as const, tools: [{ name: 'get_issue', readOnlyHint: true }, { name: 'update_issue', readOnlyHint: false }, { name: 'list_issues' }] },
			{ name: 'down', state: 'failed' as const, tools: [{ name: 'get_issue', readOnlyHint: true }] },
		];
		const result = claudeReviewTicketTools(servers as never);
		assert.deepStrictEqual({
			result,
			judged: claudeReviewTicketReadOnlyTools({ ids: [], tools: ['mcp__a__get_x', 'mcp__a__write_x'], readOnlyHints: { 'mcp__a__write_x': true } }),
			sources: claudeReviewTicketSources('diff', 'fix/ABC-1-x', ' '),
		}, {
			result: { tools: ['mcp__linear__get_issue', 'mcp__linear__list_issues'], readOnlyHints: { 'mcp__linear__get_issue': true } },
			judged: ['mcp__a__get_x'],
			sources: ['diff', 'fix/ABC-1-x'],
		});
	});
});
