/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DEFAULT_PERMISSION_POLICY } from '../../../../../platform/claude/common/claudePermissions.js';
import { ToolPolicyContext } from '../../../../../platform/claude/common/claudeToolPolicy.js';
import { classifyTool, NormalizedClaudeEvent, ToolCall } from '../../../../../platform/claude/common/claudeProtocol.js';
import { CLAUDE_TERMINAL_TOOL_ID, claudeTerminalToolResult } from '../../../../../platform/claude/common/claudeTerminalRun.js';
import { AgentViewState, describePermissionPrompt, EMPTY_AGENT_VIEW_STATE, permissionsForTimeline, reduceAgentState } from '../../common/claudeAgentState.js';
import { buildInspectorRows, InspectorFilter, inspectorFilterLabel, inspectorJson } from '../../common/claudeSessionInspector.js';
import { COMMAND_OUTPUT_LINE_CAP, completedOutputDelta, completeToolCard, nextCommandScroll, planCommandRerun, projectToolCard, unstreamedCommandOutput, visibleLineWindow } from '../../common/claudeToolCards.js';
import { appendCapped } from '../../common/claudeAgentService.js';

suite('Claude tool cards', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps read, search, edit, command, skill, mcp, web, and generic tools without raw input', () => {
		let state = submit('Look');
		state = reduceAgentState(state, tool('Read', 'read', { id: 'r', file: 'src/auth.ts', input: { file_path: 'src/auth.ts', offset: 1, limit: 84, secret: 'sk-ant-secretvalue' } }));
		state = reduceAgentState(state, tool('Grep', 'search', { id: 'g', query: 'redirectTo', input: { pattern: 'redirectTo' } }));
		state = reduceAgentState(state, done('g', true, 'middleware.ts:31\nlogin.tsx:12'));
		state = reduceAgentState(state, tool('Edit', 'write', { id: 'e', file: 'src/auth/middleware.ts' }));
		state = reduceAgentState(state, tool('Bash', 'shell', { id: 'b', command: 'npm test', input: { command: 'npm test', cwd: '/repo' } }));
		state = reduceAgentState(state, { type: 'tool.updated', sessionId: 's', callId: 'b', update: { stdout: 'PASS auth\n' } });
		state = reduceAgentState(state, done('b', true, 'exit code 0'));
		state = reduceAgentState(state, tool('Skill', 'skill', { id: 'sk', input: { skill: 'code-review' } }));
		state = reduceAgentState(state, tool('mcp__linear__get_issue', 'mcp', { id: 'm', input: { id: 'ENG-412' } }));
		state = reduceAgentState(state, tool('WebFetch', 'web', { id: 'w', input: { url: 'https://nextjs.org/docs' } }));
		state = reduceAgentState(state, tool('NotebookEdit', 'other', { id: 'n', label: 'NotebookEdit' }));
		const kinds = state.turns[0].cards.map(card => card.kind);
		assert.deepStrictEqual(kinds, ['file', 'search', 'edit', 'command', 'skill', 'mcp', 'web', 'generic']);
		const command = state.turns[0].cards.find(card => card.kind === 'command');
		assert.strictEqual(command?.exitCode, 0);
		assert.strictEqual(command?.cwd, '/repo');
		assert.ok(command?.lines.some(line => line.includes('PASS')));
		assert.strictEqual(state.turns[0].cards.find(card => card.kind === 'search')?.count, 2);
		assert.strictEqual(state.turns[0].cards.find(card => card.kind === 'file')?.range, 'L1-84');
		assert.strictEqual(state.turns[0].cards.find(card => card.kind === 'edit')?.review, 'pending');
		assert.strictEqual(JSON.stringify(state).includes('sk-ant-secretvalue'), false);
	});

	test('an MCP card keeps the images and structured content of its result, other cards do not', () => {
		let state = submit('Look');
		state = reduceAgentState(state, tool('mcp__weather__forecast', 'mcp', { id: 'm', input: { city: 'Paris' } }));
		state = reduceAgentState(state, tool('Bash', 'shell', { id: 'b', command: 'ls' }));
		const extras = { images: [{ mimeType: 'image/png', data: 'AAAA' }], structuredContent: { temp: 21 } };
		state = reduceAgentState(state, { type: 'tool.completed', sessionId: 's', callId: 'm', result: { ok: true, output: 'ok', ...extras } });
		state = reduceAgentState(state, { type: 'tool.completed', sessionId: 's', callId: 'b', result: { ok: true, output: 'ok', ...extras } });
		const [mcp, command] = state.turns[0].cards;
		assert.deepStrictEqual({ images: mcp.mcpImages, structured: mcp.mcpStructured, other: command.mcpImages ?? command.mcpStructured }, { images: extras.images, structured: extras.structuredContent, other: undefined });
	});

	test('command output keeps a capped tail', () => {
		let state = submit('Run');
		state = reduceAgentState(state, tool('Bash', 'shell', { id: 'b', command: 'npm test' }));
		const lines = Array.from({ length: COMMAND_OUTPUT_LINE_CAP + 3 }, (_value, index) => `line ${index}`).join('\n');
		state = reduceAgentState(state, { type: 'tool.updated', sessionId: 's', callId: 'b', update: lines });
		const card = state.turns[0].cards[0];
		assert.strictEqual(card.lines.length, COMMAND_OUTPUT_LINE_CAP);
		assert.strictEqual(card.droppedLines, 3);
		assert.strictEqual(card.lines[0], 'line 3');
		const window = visibleLineWindow(card.lines.length, 34, 51, 17);
		assert.deepStrictEqual(window, { start: 2, end: 5 });
	});

	test('re-run follows the permission policy', async () => {
		const base = context();
		let asked = 0;
		const denied = await planCommandRerun('rm -rf /repo', { ...base, policy: { ...base.policy, shellDestructive: 'deny' } }, async () => {
			asked++;
			return true;
		});
		assert.strictEqual(denied.run, false);
		assert.strictEqual(asked, 0);

		const askedRun = await planCommandRerun('npm test', base, async () => true);
		assert.strictEqual(askedRun.run, true);

		const declined = await planCommandRerun('npm test', base, async () => false);
		assert.strictEqual(declined.run, false);

		const allowed = await planCommandRerun('git status', base, async () => {
			asked++;
			return false;
		});
		assert.strictEqual(allowed.run, true);
		assert.strictEqual(asked, 0);
	});

	test('parallel subagents stay out of the parent text, group together, and keep a background run alive', () => {
		let state = submit('Investigate');
		state = reduceAgentState(state, started('run-a', 'Explore', 'Find login', false));
		state = reduceAgentState(state, inner('run-a', tool('Read', 'read', { id: 'read-a', file: 'src/login.ts' })));
		state = reduceAgentState(state, started('run-b', 'general-purpose', 'Review auth', false));
		state = reduceAgentState(state, inner('run-b', tool('Grep', 'search', { id: 'grep-b', query: 'session' })));
		state = reduceAgentState(state, delta('Parent continues'));
		assert.strictEqual(state.turns[0].assistantText, 'Parent continues');
		assert.strictEqual(state.turns[0].cards.length, 0);
		assert.strictEqual(state.subagents.length, 2);
		assert.strictEqual(state.subagents[0].groupId, state.subagents[1].groupId);
		assert.strictEqual(state.subagents[0].run.toolCallCount, 1);
		assert.strictEqual(state.subagents[0].latestTool, 'Reading src/login.ts');
		assert.strictEqual(state.subagents[0].chat.cards[0].kind, 'file');
		assert.strictEqual(state.subagents[0].chat.assistantText, '');
		assert.deepStrictEqual(state.subagents[0].chat.steered, []);
		const permission = inner('run-b', {
			type: 'permission.requested',
			sessionId: 's',
			request: { id: 'perm-1', toolName: 'Bash', category: 'shell', input: {}, command: 'npm test' },
		});
		state = reduceAgentState(state, permission);
		const entry = state.subagents[1].chat.permissions[0];
		assert.strictEqual(entry.askedBy, 'general-purpose');
		assert.strictEqual(describePermissionPrompt(entry), 'general-purpose wants to run `npm test`');

		state = reduceAgentState(state, { type: 'subagent.finished', sessionId: 's', runId: 'run-a', state: 'success', resultText: 'Found the login form.' });
		state = reduceAgentState(state, started('run-c', 'Explore', 'Keep watching', true));
		state = reduceAgentState(state, { type: 'session.completed', sessionId: 's' });
		assert.strictEqual(state.turns[0].status, 'complete');
		assert.strictEqual(state.subagents.find(subagent => subagent.run.id === 'run-a')?.run.state, 'success');
		assert.strictEqual(state.subagents.find(subagent => subagent.run.id === 'run-a')?.run.resultText, 'Found the login form.');
		assert.strictEqual(state.subagents.find(subagent => subagent.run.id === 'run-b')?.run.state, 'success');
		assert.strictEqual(state.subagents.find(subagent => subagent.run.id === 'run-c')?.run.state, 'running');
		assert.strictEqual(JSON.stringify(state).includes('parent_tool_use_id'), false);
	});

	test('stopping a subagent records the parent-turn interruption', () => {
		let state = submit('Look');
		state = reduceAgentState(state, started('run-a', 'Explore', 'Find login', false));
		state = reduceAgentState(state, { type: 'subagent.finished', sessionId: 's', runId: 'run-a', state: 'stopped', resultText: 'Stopped by interrupting the parent turn.' });
		assert.strictEqual(state.subagents[0].run.state, 'stopped');
		assert.strictEqual(state.subagents[0].run.resultText, 'Stopped by interrupting the parent turn.');
	});

	test('the session inspector lists normalized events, filters them, redacts secrets, and hides raw messages', () => {
		const events = [
			{ type: 'turn.submitted' as const, turnId: 't', text: 'token sk-ant-secretvalue' },
			{ type: 'assistant.completed' as const, sessionId: 's', text: 'done' },
			{ type: 'tool.started' as const, sessionId: 's', call: { id: 'b', name: 'Bash', category: 'shell' as const, input: {}, display: { label: 'Run' } } },
			{ type: 'permission.resolved' as const, sessionId: 's', outcome: { requestId: 'p', toolName: 'Bash', decision: 'deny' as const, source: 'user' as const } },
			{ type: 'session.failed' as const, sessionId: 's', message: 'boom' },
		];
		const all = buildInspectorRows({ events, rawMessages: [{ raw: 'sk-ant-secretvalue' }], retainRaw: false, filter: 'all' });
		assert.strictEqual(all.some(row => row.kind === 'raw'), false);
		assert.strictEqual(all.map(row => row.label).join(','), 'Sent,Assistant,Tool,Permission,Error');
		assert.strictEqual(JSON.stringify(all).includes('sk-ant-secretvalue'), false);
		assert.strictEqual(JSON.stringify(all).includes('[redacted]'), true);
		const tools = buildInspectorRows({ events, rawMessages: [], retainRaw: false, filter: 'tool' });
		assert.strictEqual(tools.length, 1);
		const raw = buildInspectorRows({ events: [], rawMessages: [{ type: 'sdk' }], retainRaw: true, filter: 'all' });
		assert.strictEqual(raw.length, 1);
		assert.strictEqual(raw[0].kind, 'raw');
		const hidden = buildInspectorRows({ events: [], rawMessages: [{ type: 'sdk' }], retainRaw: true, filter: 'tool' });
		assert.strictEqual(hidden.length, 0);
		const copied = JSON.parse(inspectorJson(all)) as { event: unknown }[];
		assert.strictEqual(typeof copied[0].event, 'object');
		assert.strictEqual(typeof (copied[0].event as { text?: string }).text, 'string');
		const filters: InspectorFilter[] = ['all', 'input', 'output', 'tool', 'permission', 'error'];
		assert.deepStrictEqual(filters.map(inspectorFilterLabel), ['All', 'Input', 'Output', 'Tools', 'Permissions', 'Errors']);
	});

	test('the session inspector says when a session was sent AGENTS.md or .agents/skills', () => {
		const events: NormalizedClaudeEvent[] = [
			{ type: 'session.started', sessionId: 's', model: 'opus', instructions: [{ kind: 'agentsMd', path: 'AGENTS.md' }, { kind: 'agentsMd', path: 'pkg/AGENTS.md', nested: true }, { kind: 'agentsSkills', path: '.agents/skills' }] },
			{ type: 'session.started', sessionId: 's', model: 'opus' },
		];
		assert.deepStrictEqual(buildInspectorRows({ events, rawMessages: [], retainRaw: false, filter: 'input' }).map(row => row.summary), [
			'opus | from AGENTS.md, from .agents/skills',
			'opus',
		]);
	});

	test('a full-output completion past the line cap adds only the unstreamed tail, with secrets redacted', () => {
		let state = submit('Run');
		state = reduceAgentState(state, tool('Bash', 'shell', { id: 'b', command: 'npm test' }));
		const streamed = Array.from({ length: COMMAND_OUTPUT_LINE_CAP + 1 }, (_value, index) => `line ${index}`).join('\n');
		state = reduceAgentState(state, { type: 'tool.updated', sessionId: 's', callId: 'b', update: { stdout: streamed } });
		const secret = 'sk-ant-api03-testsecretvalue';
		const full = `${streamed}\n${secret}`;
		state = reduceAgentState(state, done('b', true, full));
		const card = state.turns[0].cards[0];
		assert.strictEqual(card.lines.length, COMMAND_OUTPUT_LINE_CAP);
		assert.strictEqual(card.droppedLines, 2);
		assert.strictEqual(card.lines.filter(line => line === 'line 200').length, 1);
		assert.strictEqual(card.lines[card.lines.length - 1], '[redacted]');
		assert.strictEqual(JSON.stringify(card).includes(secret), false);
		assert.strictEqual(completedOutputDelta(card.lines, full, card.streamedChars), '');
		assert.strictEqual(unstreamedCommandOutput(streamed.replace(secret, '[redacted]'), full), '\n[redacted]');
	});

	test('an unknown parentRunId shows the permission on the parent turn', () => {
		let state = submit('Look');
		state = reduceAgentState(state, {
			type: 'permission.requested',
			sessionId: 's',
			parentRunId: 'missing-run',
			request: { id: 'perm-x', toolName: 'Bash', category: 'shell', input: {}, command: 'npm test' },
		});
		assert.strictEqual(state.subagents.length, 0);
		assert.strictEqual(state.turns[0].permissions[0]?.id, 'perm-x');
		state = reduceAgentState(state, {
			type: 'permission.resolved',
			sessionId: 's',
			parentRunId: 'missing-run',
			outcome: { requestId: 'perm-x', toolName: 'Bash', decision: 'deny', source: 'user' },
		});
		assert.strictEqual(state.turns[0].permissions[0].state, 'denied');
		assert.strictEqual(state.turns[0].permissions[0].source, 'user');
	});

	test('a full-output completion does not repeat streamed lines, and exit text inside the command is ignored', () => {
		let state = submit('Run');
		state = reduceAgentState(state, tool('Bash', 'shell', { id: 'b', command: 'echo exit code 7' }));
		state = reduceAgentState(state, { type: 'tool.updated', sessionId: 's', callId: 'b', update: { stdout: 'PASS auth\n' } });
		state = reduceAgentState(state, done('b', true, 'PASS auth\n48 tests passed'));
		const lines = state.turns[0].cards[0].lines;
		assert.strictEqual(lines.filter(line => line.includes('PASS auth')).length, 1);
		assert.ok(lines.some(line => line.includes('48 tests passed')));
		assert.strictEqual(state.turns[0].cards[0].exitCode, 0);

		let failed = submit('Run');
		failed = reduceAgentState(failed, tool('Bash', 'shell', { id: 'b', command: 'npm test' }));
		failed = reduceAgentState(failed, done('b', false, 'echo exit code 7\nexit code: 2'));
		assert.strictEqual(failed.turns[0].cards[0].exitCode, 2);
	});

	test('a failed Bash call reads its exit code from the error, so the card says "exit 2" once', () => {
		let state = submit('Run');
		state = reduceAgentState(state, tool('Bash', 'shell', { id: 'b', command: 'npm run build' }));
		state = reduceAgentState(state, { type: 'tool.completed', sessionId: 's', callId: 'b', result: { ok: false, error: 'Command failed with exit code 2' } });
		const card = state.turns[0].cards[0];
		assert.deepStrictEqual({ exitCode: card.exitCode, meta: card.meta }, { exitCode: 2, meta: 'exit 2' });
	});

	test('a running command preview stays on the tail until the user scrolls', () => {
		const tail = nextCommandScroll(1000, 180, { scrollTop: 10, follow: true }, true, false, 10);
		assert.deepStrictEqual(tail, { scrollTop: 820, follow: true });
		const kept = nextCommandScroll(1000, 180, { scrollTop: 40, follow: false }, true, false, 40);
		assert.deepStrictEqual(kept, { scrollTop: 40, follow: false });
		const released = nextCommandScroll(1000, 180, undefined, true, true, 12);
		assert.strictEqual(released.follow, false);
		assert.strictEqual(released.scrollTop, 12);
	});

	test('subagent end times come from the event, so a replay is the same view', () => {
		const startedEvent = started('run-a', 'Explore', 'Find login', false);
		const finished = { type: 'subagent.finished' as const, sessionId: 's', runId: 'run-a', state: 'success' as const, resultText: 'done', endedAt: 40 };
		const events = [
			{ type: 'turn.submitted' as const, turnId: 'turn-1', text: 'Look' },
			startedEvent,
			finished,
		];
		const once = events.reduce(reduceAgentState, EMPTY_AGENT_VIEW_STATE);
		const twice = events.reduce(reduceAgentState, EMPTY_AGENT_VIEW_STATE);
		assert.strictEqual(once.subagents[0].run.endedAt, 40);
		assert.deepStrictEqual(once, twice);

		let unsettled = submit('Look');
		unsettled = reduceAgentState(unsettled, started('run-a', 'Explore', 'Find login', false));
		unsettled = reduceAgentState(unsettled, { type: 'subagent.finished', sessionId: 's', runId: 'run-a', state: 'success' });
		assert.strictEqual(unsettled.subagents[0].run.endedAt, undefined);

		let settled = submit('Look');
		settled = reduceAgentState(settled, started('run-b', 'Explore', 'Still going', false));
		settled = reduceAgentState(settled, { type: 'session.completed', sessionId: 's', endedAt: 90 });
		assert.strictEqual(settled.subagents[0].run.endedAt, 90);
		assert.strictEqual(settled.subagents[0].run.state, 'success');
	});

	test('a subagent can start after the parent turn is complete', () => {
		let state = submit('Look');
		state = reduceAgentState(state, { type: 'session.completed', sessionId: 's' });
		state = reduceAgentState(state, started('run-late', 'Explore', 'Keep watching', true));
		assert.strictEqual(state.turns[0].status, 'complete');
		assert.strictEqual(state.subagents[0].parentTurnId, 'turn-1');
		assert.strictEqual(state.subagents[0].run.state, 'running');
	});

	test('a nested subagent permission stays on that run and on the parent cards', () => {
		let state = submit('Look');
		state = reduceAgentState(state, started('run-outer', 'Explore', 'Outer', false));
		state = reduceAgentState(state, inner('run-outer', started('run-inner', 'reviewer', 'Inner', false)));
		state = reduceAgentState(state, inner('run-inner', {
			type: 'permission.requested',
			sessionId: 's',
			request: { id: 'perm-nested', toolName: 'Bash', category: 'shell', input: {}, command: 'rm -rf dist', risk: 'destructive' },
		}));
		const entry = state.subagents.find(subagent => subagent.run.id === 'run-inner')?.chat.permissions[0];
		assert.ok(entry);
		assert.strictEqual(entry.askedBy, 'reviewer');
		assert.strictEqual(describePermissionPrompt(entry), 'reviewer: this command can delete data');
		assert.ok(permissionsForTimeline(state.turns[0], state.subagents, undefined).some(candidate => candidate.id === 'perm-nested'));
		const outer = state.subagents.find(subagent => subagent.run.id === 'run-outer');
		assert.ok(outer);
		assert.ok(permissionsForTimeline(outer.chat, state.subagents, 'run-outer').some(candidate => candidate.id === 'perm-nested'));
	});

	test('a destructive prompt still names the risk when a subagent asked', () => {
		const credentials = describePermissionPrompt({
			id: 'c', toolName: 'Read', canRemember: false, state: 'pending', askedBy: 'reviewer', risk: 'credentials', targetPath: '/repo/.env',
		});
		assert.strictEqual(credentials, 'reviewer: this touches credentials');
	});

	test('re-run writes a permission history entry on a finished turn', () => {
		let state = submit('Run');
		state = reduceAgentState(state, { type: 'session.completed', sessionId: 's' });
		state = reduceAgentState(state, { type: 'command.rerun', command: 'git status', cwd: '/repo', allowed: true, source: 'policy', reason: 'Allowed.' });
		const entry = state.turns[0].permissions[0];
		assert.strictEqual(entry.command, 'git status');
		assert.strictEqual(entry.state, 'allowed');
		assert.strictEqual(entry.source, 'policy');
		state = reduceAgentState(state, { type: 'command.rerun', command: 'npm test', allowed: false, source: 'user', reason: 'Denied.' });
		assert.strictEqual(state.turns[0].permissions[1].state, 'denied');
		assert.strictEqual(state.turns[0].permissions[1].source, 'user');
	});

	test('the inspector and command logs drop the oldest entries past the cap', () => {
		const events: string[] = [];
		for (let index = 0; index < 5; index++) {
			appendCapped(events, `e${index}`, 3);
		}
		assert.deepStrictEqual(events, ['e2', 'e3', 'e4']);
	});
	test('run_in_terminal draws as a command card and reads its exit code from the result (issue 452)', () => {
		const card = projectToolCard({ id: 't1', name: CLAUDE_TERMINAL_TOOL_ID, category: classifyTool(CLAUDE_TERMINAL_TOOL_ID), input: { command: 'gh auth login', reason: 'Sign in' }, display: { label: CLAUDE_TERMINAL_TOOL_ID, command: 'gh auth login' } });
		const failed = claudeTerminalToolResult('gh auth login', { kind: 'exited', exitCode: 1, lastOutput: 'error connecting to github.com' });
		const ended = completeToolCard(card, { ok: false, error: failed.text });
		assert.deepStrictEqual({ kind: card.kind, verb: card.verb, target: card.target, exitCode: ended.exitCode, meta: ended.meta }, { kind: 'command', verb: 'Running', target: 'gh auth login', exitCode: 1, meta: 'exit 1' });
	});

	test('a command card keeps what the command does in words, redacted, beside the full command (issue 745)', () => {
		const bash = (input: Record<string, unknown>) => projectToolCard({ id: 'b', name: 'Bash', category: classifyTool('Bash'), input, display: { label: 'Bash', command: String(input.command) } });
		const described = bash({ command: 'pids=$(lsof -ti tcp:3001); kill $pids', description: ' Free port 3001 with token sk-ant-secretvalue ' });
		const plain = bash({ command: 'npm test' });
		assert.deepStrictEqual({ described: [described.target, described.description?.includes('sk-ant-secretvalue'), described.description?.startsWith('Free port 3001')], plain: plain.description }, { described: ['pids=$(lsof -ti tcp:3001); kill $pids', false, true], plain: undefined });
	});

	test('NotebookEdit draws as an edit card that names the cell and keeps its source (issue 526)', () => {
		const notebook = (id: string, input: Record<string, unknown>) => completeToolCard(projectToolCard({ id, name: 'NotebookEdit', category: classifyTool('NotebookEdit'), input: { notebook_path: '/repo/analysis.ipynb', ...input }, display: { label: 'NotebookEdit', file: '/repo/analysis.ipynb' } }), { ok: true, output: 'Updated cell' });
		const longSource = Array.from({ length: 15 }, (_, index) => `print(${index})`).join('\r\n');
		const cards = [
			notebook('n1', { edit_mode: 'insert', cell_type: 'markdown', new_source: '## Sales by region\n\nTotals per region.\n' }),
			notebook('n2', { cell_id: 'cell-3', new_source: longSource }),
			notebook('n3', { edit_mode: 'delete', cell_number: 7 }),
			notebook('n4', { edit_mode: 'insert', cell_type: 'code', new_source: 'key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"' }),
		];
		assert.deepStrictEqual(cards.map(card => ({ kind: card.kind, review: card.review, meta: card.meta, notebook: card.notebook })), [
			{ kind: 'edit', review: 'pending', meta: 'New Markdown cell', notebook: { mode: 'insert', cellType: 'markdown', cell: undefined, lines: ['## Sales by region', '', 'Totals per region.'], droppedLines: 0 } },
			{ kind: 'edit', review: 'pending', meta: 'Cell cell-3', notebook: { mode: 'replace', cellType: undefined, cell: 'cell-3', lines: Array.from({ length: 12 }, (_, index) => `print(${index})`), droppedLines: 3 } },
			{ kind: 'edit', review: 'pending', meta: 'Deleted cell 7', notebook: { mode: 'delete', cellType: undefined, cell: '7', lines: [], droppedLines: 0 } },
			{ kind: 'edit', review: 'pending', meta: 'New code cell', notebook: { mode: 'insert', cellType: 'code', cell: undefined, lines: [cards[3].notebook?.lines[0] ?? ''], droppedLines: 0 } },
		]);
		assert.ok(!cards[3].notebook?.lines[0].includes('abcdefghijklmnop'));
	});
});

function submit(text: string): AgentViewState {
	return reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text });
}

function delta(text: string): NormalizedClaudeEvent {
	return { type: 'assistant.delta', sessionId: 's', text };
}

function tool(name: string, category: ToolCall['category'], options: { id: string; file?: string; query?: string; command?: string; label?: string; input?: unknown }): NormalizedClaudeEvent {
	return {
		type: 'tool.started',
		sessionId: 's',
		call: {
			id: options.id,
			name,
			category,
			input: options.input ?? {},
			display: { label: options.label ?? name, file: options.file, query: options.query, command: options.command },
		},
	};
}

function done(callId: string, ok: boolean, output: string): NormalizedClaudeEvent {
	return { type: 'tool.completed', sessionId: 's', callId, result: { ok, output } };
}

function started(id: string, agentType: string, description: string, background: boolean): NormalizedClaudeEvent {
	return {
		type: 'subagent.started',
		sessionId: 's',
		run: { id, agentType, description, background, state: 'running', startedAt: 1, toolCallCount: 0 },
	};
}

function inner(parentRunId: string, event: NormalizedClaudeEvent): NormalizedClaudeEvent {
	if (event.type === 'subagent.started') {
		return { ...event, parentRunId, run: { ...event.run, parentRunId } };
	}
	return { ...event, parentRunId };
}

function context(): ToolPolicyContext {
	return {
		cwd: '/repo',
		workspaceFolders: ['/repo'],
		additionalDirectories: [],
		trusted: true,
		policy: DEFAULT_PERMISSION_POLICY,
	};
}
