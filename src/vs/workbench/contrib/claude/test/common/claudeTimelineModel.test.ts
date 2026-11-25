/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parsePlanArtifact } from '../../../../../platform/claude/common/claudePlan.js';
import { NormalizedClaudeEvent, ToolCall } from '../../../../../platform/claude/common/claudeProtocol.js';
import { AgentReducerEvent, AgentViewState, EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../../../services/claude/common/claudeAgentState.js';
import { ClaudeDelegateCard } from '../../../../services/claude/common/claudeDelegationModel.js';
import { planStepSource } from '../../../../../platform/claude/common/claudePlanEdit.js';
import { describeMatchCount, describePlanSize, describeQuiet, describeSubagentMeta, describeThinking, hiddenCommandLines, inlineMarkdownRuns, matchesCardFile, miniDiffRows, searchResultRows, showsProgress, splitPath, TimelineBlock, timelineBlocks, turnWork, workspaceRelativeFolder, workspaceRelativePath, OutputRow, outputRows } from '../../common/claudeTimelineModel.js';

suite('Claude timeline model', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('blocks follow event order, group finished reads, and only the last open text has the caret', () => {
		const state = run([
			delta('Looking.'),
			read('r1'), done('r1'),
			read('r2'), done('r2'),
			search('g1'),
			delta('Still going'),
		]);
		assert.deepStrictEqual(describe(timelineBlocks(state.turns[0], state.subagents, undefined)), [
			'text:Looking.',
			'reads:r1,r2',
			'tool:g1:running',
			'text:Still going:caret',
		]);
	});

	test('a subagent request follows its subagent card; a request nothing shows comes last', () => {
		const state = run([
			started('run-a', undefined, 'Explore'),
			started('run-b', undefined, 'Review'),
			started('run-c', 'run-a', 'planner'),
			{ type: 'permission.requested', sessionId: 's', parentRunId: 'run-c', request: { id: 'p-inner', toolName: 'Bash', category: 'shell', input: {}, command: 'npm test' } },
			delta('Waiting.'),
		]);
		const blocks = timelineBlocks(state.turns[0], state.subagents, undefined);
		assert.deepStrictEqual(describe(blocks), ['subagents:run-a,run-b', 'permission:p-inner:pending', 'text:Waiting.:caret']);
		const legacy = { ...state.turns[0], parts: undefined, assistantText: '' };
		assert.deepStrictEqual(describe(timelineBlocks(legacy, state.subagents, undefined)), ['subagents:run-a,run-b', 'permission:p-inner:pending']);
	});

	test('a Plan-mode answer streams as a draft until it completes as the plan', () => {
		const streaming = run([delta('Plan: fix login\n\n1. Add `/login`')], 'plan');
		const narration = run([delta('Let me look first.')], 'plan');
		const answered = reduceAgentState(streaming, { type: 'assistant.completed', sessionId: 's', text: 'Plan: fix login\n\n1. Add `/login`' });
		const finished = reduceAgentState(answered, { type: 'session.completed', sessionId: 's' });
		assert.deepStrictEqual({
			streaming: describe(timelineBlocks(streaming.turns[0], [], undefined)),
			narration: describe(timelineBlocks(narration.turns[0], [], undefined)),
			answered: describe(timelineBlocks(answered.turns[0], [], undefined)),
			finished: describe(timelineBlocks(finished.turns[0], [], undefined)),
		}, {
			streaming: ['planDraft'],
			narration: ['text:Let me look first.:caret'],
			// Between the answer and the end of the session the plan stays a draft: no raw markdown flash.
			answered: ['planDraft'],
			finished: ['plan'],
		});
	});

	test('progress shows through the caret, a running card, a running subagent or a pending card', () => {
		const text: TimelineBlock = { kind: 'text', key: 'a', part: { kind: 'text', id: 't', text: 'x', open: false, completed: true }, caret: false };
		const caret: TimelineBlock = { ...text, caret: true };
		const ran = run([read('r1'), done('r1'), search('g1'), done('g1')]);
		const running = run([search('g1')]);
		assert.deepStrictEqual([
			showsProgress([text]),
			showsProgress([text, caret]),
			showsProgress(timelineBlocks(ran.turns[0], [], undefined)),
			showsProgress(timelineBlocks(running.turns[0], [], undefined)),
			showsProgress(timelineBlocks(run([started('run-a', undefined, 'Explore')]).turns[0], run([started('run-a', undefined, 'Explore')]).subagents, undefined)),
		], [false, true, false, true, true]);
	});

	test('a pull request card stays in view with the answer and never folds into the work', () => {
		const reference: NormalizedClaudeEvent = { type: 'github.referenceDetected', sessionId: 's', reference: { url: 'https://github.com/o/r/pull/3', owner: 'o', repo: 'r', number: 3, kind: 'pullRequest', createdBySession: true } };
		const state = reduceAgentState(run([read('r1'), done('r1'), reference, read('r2'), done('r2'), delta('Opened it.')]), { type: 'session.completed', sessionId: 's' });
		const blocks = timelineBlocks(state.turns[0], [], undefined);
		assert.deepStrictEqual({
			kinds: blocks.map(block => block.kind),
			work: turnWork(state.turns[0], blocks).work.map(key => blocks.find(block => block.key === key)?.kind),
		}, {
			kinds: ['tool', 'github', 'tool', 'text'],
			work: ['tool', 'tool'],
		});
	});

	test('a delegated chat\'s card shows progress while it works and stays in view with the answer (issue 693)', () => {
		const card: ClaudeDelegateCard = { id: 'd1', parentSessionId: 's', parentTurnId: 'turn-1', childSessionId: 'c1', task: 'Fix it', title: 'Fix it', modelLabel: 'Sonnet', auto: false, state: 'running', children: [], startedAt: 0 };
		const working = run([read('r1'), done('r1'), { type: 'turn.delegate', card }, read('r2'), done('r2')]);
		const finished = [{ type: 'turn.delegate', card: { ...card, state: 'done', result: 'Fixed.', endedAt: 5 } } as const, delta('It is fixed.'), { type: 'session.completed', sessionId: 's' } as const].reduce<AgentViewState>(reduceAgentState, working);
		const blocks = timelineBlocks(finished.turns[0], [], undefined);
		assert.deepStrictEqual({
			progress: showsProgress(timelineBlocks(working.turns[0], [], undefined)),
			kinds: blocks.map(block => block.kind),
			card: blocks.flatMap(block => block.kind === 'delegate' ? [block.card.state] : []),
			work: turnWork(finished.turns[0], blocks).work.map(key => blocks.find(block => block.key === key)?.kind),
		}, {
			progress: true,
			kinds: ['tool', 'delegate', 'tool', 'text'],
			card: ['done'],
			work: ['tool', 'tool'],
		});
	});

	test('thinking reads "Thinking" while it streams, then how long it took, and stays in view with the answer', () => {
		const live = run([thinking('', 1000), thinking('Check the guard.', 1400)]);
		const closed = run([thinking('', 1000), thinking('Check the guard.', 1400), thinking('', 4200, true), delta('It returns early.')]);
		const quick = run([thinking('', 1000, true)]);
		const worked = reduceAgentState(run([read('r1'), done('r1'), thinking('', 1000), thinking('', 2500, true), delta('Done.')]), { type: 'session.completed', sessionId: 's' });
		const label = (state: AgentViewState) => timelineBlocks(state.turns[0], [], undefined).flatMap(block => block.kind === 'thinking' ? [`${describeThinking(block.part, block.live)}|${block.part.text}|${block.live}`] : []);
		const blocks = timelineBlocks(worked.turns[0], [], undefined);
		assert.deepStrictEqual({
			live: label(live),
			liveProgress: showsProgress(timelineBlocks(live.turns[0], [], undefined)),
			closed: label(closed),
			quick: label(quick),
			work: turnWork(worked.turns[0], blocks).work,
			kinds: blocks.map(block => block.kind),
		}, {
			live: ['Thinking|Check the guard.|true'],
			liveProgress: true,
			closed: ['Thought for 3s|Check the guard.|false'],
			quick: ['Thought for a moment||false'],
			work: [blocks[0].key],
			kinds: ['tool', 'thinking', 'text'],
		});
	});

	test('thinking with no text shows the runtime token estimate, which never starts a block (issue 740)', () => {
		const sized = (text: string, at: number, tokens?: number, isDone?: boolean): NormalizedClaudeEvent => ({ type: 'thinking.delta', sessionId: 's', text, at, tokens, done: isDone });
		const live = run([sized('', 1000), sized('', 1200, 50), sized('', 1400, 1208)]);
		const closed = run([sized('', 1000), sized('', 1400, 208), sized('', 4200, undefined, true), sized('', 4300, 400), delta('Done.')]);
		const withText = run([sized('', 1000), sized('Check it.', 1100), sized('', 1200, 30)]);
		const label = (state: AgentViewState) => timelineBlocks(state.turns[0], [], undefined).flatMap(block => block.kind === 'thinking' ? [describeThinking(block.part, block.live)] : []);
		assert.deepStrictEqual({ live: label(live), closed: label(closed), withText: label(withText) }, {
			live: [`Thinking · ${(1208).toLocaleString()} tokens`],
			closed: ['Thought for 3s · 208 tokens'],
			withText: ['Thinking'],
		});
	});

	test('counts use plurals', () => {
		const one = parsePlanArtifact('1. Edit `src/a.ts`');
		const many = parsePlanArtifact('1. Edit `src/a.ts`\n2. Edit `src/b.ts`\n3. Test');
		assert.deepStrictEqual([
			describeSubagentMeta(1, '4s'),
			describeSubagentMeta(3, '1m 2s'),
			one ? describePlanSize(one) : '',
			many ? describePlanSize(many) : '',
		], ['1 tool · 4s', '3 tools · 1m 2s', '1 step · 1 file', '3 steps · 2 files']);
	});

	test('a running row says how long it has been silent once it passes ten seconds (issue 1258)', () => {
		assert.deepStrictEqual([
			describeQuiet(1_000, 9_000),
			describeQuiet(1_000, 13_000),
			describeSubagentMeta(2, '40s', describeQuiet(1_000, 13_000)),
		], [undefined, '12s', '2 tools · 40s · last output 12s ago']);
	});

	test('plan steps keep inline code and strong text, as text', () => {
		const markdown = '1. Add `/login` to **PUBLIC_ROUTES**\n2. Plain step';
		const source = planStepSource(markdown, 'Add /login to PUBLIC_ROUTES');
		assert.deepStrictEqual({
			source,
			runs: inlineMarkdownRuns(source ?? ''),
			edited: planStepSource(markdown, 'Renamed by the user'),
			html: inlineMarkdownRuns('<img src=x onerror=1> `code`'),
		}, {
			source: 'Add `/login` to **PUBLIC_ROUTES**',
			runs: [{ kind: 'text', text: 'Add ' }, { kind: 'code', text: '/login' }, { kind: 'text', text: ' to ' }, { kind: 'strong', text: 'PUBLIC_ROUTES' }],
			edited: undefined,
			html: [{ kind: 'text', text: '<img src=x onerror=1> ' }, { kind: 'code', text: 'code' }],
		});
	});

	test('search output becomes one row per file with its lines', () => {
		assert.deepStrictEqual(searchResultRows(['src/a.ts:31:const x', 'src/b.ts:4', 'src/a.ts:58:y', 'C:\\repo\\c.ts:2:z', 'src/only.ts', '']), [
			{ path: 'src/a.ts', lines: [31, 58] },
			{ path: 'src/b.ts', lines: [4] },
			{ path: 'C:\\repo\\c.ts', lines: [2] },
			{ path: 'src/only.ts', lines: [] },
		]);
		assert.deepStrictEqual({
			counts: searchResultRows(['src/a.ts:12', 'src/b.ts:1', 'C:\\repo\\c.ts:3'], true),
			files: searchResultRows(['Found 3 files', 'src/a.ts', 'Makefile', 'LICENSE']),
			none: searchResultRows(['No files found']),
			describe: [describeMatchCount(1), describeMatchCount(12)],
		}, {
			counts: [{ path: 'src/a.ts', lines: [], count: 12 }, { path: 'src/b.ts', lines: [], count: 1 }, { path: 'C:\\repo\\c.ts', lines: [], count: 3 }],
			files: [{ path: 'src/a.ts', lines: [] }, { path: 'Makefile', lines: [] }, { path: 'LICENSE', lines: [] }],
			none: [],
			describe: ['1 match', '12 matches'],
		});
		assert.deepStrictEqual([splitPath('src/auth/middleware.ts'), splitPath('a.ts'), splitPath('C:\\repo\\x.ts')], [
			{ name: 'middleware.ts', folder: 'src/auth' },
			{ name: 'a.ts', folder: '' },
			{ name: 'x.ts', folder: 'C:/repo' },
		]);
	});

	test('paths show relative to the workspace folder that holds them, on Windows drives and without case', () => {
		const roots = ['C:\\Repo', '/home/me/app/'];
		assert.deepStrictEqual({
			drive: workspaceRelativePath('c:\\repo\\src\\auth\\a.ts', roots, false),
			posix: workspaceRelativePath('/home/me/app/src/a.ts', roots, true),
			caseSensitive: workspaceRelativePath('/home/me/App/src/a.ts', roots, true),
			outside: workspaceRelativePath('D:\\other\\b.ts', roots, false),
			folder: workspaceRelativeFolder('C:\\Repo\\src\\auth', roots, false),
			rootFolder: workspaceRelativeFolder('c:\\repo', roots, false),
			driveRoot: workspaceRelativeFolder('E:\\', roots, false),
			posixRoot: workspaceRelativeFolder('/', roots, true),
		}, {
			drive: 'src/auth/a.ts',
			posix: 'src/a.ts',
			caseSensitive: '/home/me/App/src/a.ts',
			outside: 'D:/other/b.ts',
			folder: 'src/auth',
			rootFolder: '',
			driveRoot: '',
			posixRoot: '',
		});
	});

	test('a mini-diff shows a fold, one context line around each change, and caps its rows', () => {
		const original = 'import x;\n\nconst ROUTES = [\n\t\'/signup\',\n];\n';
		const rows = miniDiffRows(original, [{ originalStart: 5, originalLength: 0, modifiedStart: 5, modifiedLength: 2, originalText: '', modifiedText: '\t\'/login\',\n\t\'/auth\',\n' }]);
		const replaced = miniDiffRows('a\nb\nc', [{ originalStart: 2, originalLength: 1, modifiedStart: 2, modifiedLength: 1, originalText: 'b\n', modifiedText: 'B\n' }]);
		const created = miniDiffRows('', [{ originalStart: 1, originalLength: 1, modifiedStart: 1, modifiedLength: 2, originalText: '', modifiedText: 'one\ntwo' }]);
		const capped = miniDiffRows('', [{ originalStart: 1, originalLength: 0, modifiedStart: 1, modifiedLength: 20, originalText: '', modifiedText: Array.from({ length: 20 }, (_v, index) => `l${index}`).join('\n') }], 4);
		assert.deepStrictEqual({
			rows,
			replaced: replaced.map(row => `${row.kind}:${row.line ?? ''}:${row.text}`),
			created: created.map(row => `${row.kind}:${row.line ?? ''}:${row.text}`),
			capped: capped.map(row => `${row.kind}:${row.count ?? row.text}`),
		}, {
			rows: [
				{ kind: 'fold', text: '', count: 3 },
				{ kind: 'ctx', line: 4, text: '\t\'/signup\',' },
				{ kind: 'ins', line: 5, text: '\t\'/login\',' },
				{ kind: 'ins', line: 6, text: '\t\'/auth\',' },
				{ kind: 'ctx', line: 7, text: '];' },
			],
			replaced: ['ctx:1:a', 'del::b', 'ins:2:B', 'ctx:3:c'],
			created: ['ins:1:one', 'ins:2:two'],
			capped: ['ins:l0', 'ins:l1', 'ins:l2', 'ins:l3', 'fold:16'],
		});
	});

	test('command output wraps into fixed rows and an edit card finds its review file', () => {
		const plain = (rows: readonly OutputRow[]) => rows.map(row => row.map(segment => segment.text).join(''));
		assert.deepStrictEqual({
			wrapped: plain(outputRows(['abcdefghij', 'ab', '\tx'], 4)),
			unmeasured: plain(outputRows(['abcdefghij'], 0)),
			relative: matchesCardFile('/c:/repo/src/auth/middleware.ts', 'src/auth/middleware.ts'),
			absolute: matchesCardFile('/c:/repo/src/auth/middleware.ts', 'C:\\repo\\src\\auth\\middleware.ts'),
			partial: matchesCardFile('/c:/repo/src/auth/xmiddleware.ts', 'middleware.ts'),
		}, {
			wrapped: ['abcd', 'efgh', 'ij', 'ab', '    ', 'x'],
			unmeasured: ['abcdefghij'],
			relative: true,
			absolute: true,
			partial: false,
		});
	});

	test('command output keeps its ANSI colors across lines and wraps on the visible text (issue 745)', () => {
		assert.deepStrictEqual(outputRows(['\u001b[32m✓ cart\u001b[0m ok', '\u001b[1;31mFAIL', 'still red\u001b[39m done', '\u001b[2K'], 4), [
			[{ text: '✓ ca', color: 2 }],
			[{ text: 'rt', color: 2 }, { text: ' o' }],
			[{ text: 'k' }],
			[{ text: 'FAIL', color: 1, bold: true }],
			[{ text: 'stil', color: 1, bold: true }],
			[{ text: 'l re', color: 1, bold: true }],
			[{ text: 'd', color: 1, bold: true }, { text: ' do', bold: true }],
			[{ text: 'ne', bold: true }],
			[],
		]);
	});

	test('a running command hides the lines above its 5-line tail; a finished one only the dropped lines', () => {
		const lines = ['1', '2', '3', '4', '5', '6', '7', ''];
		assert.deepStrictEqual({
			running: hiddenCommandLines({ state: 'running', lines, droppedLines: 41 }),
			short: hiddenCommandLines({ state: 'running', lines: ['1', '2'], droppedLines: 0 }),
			finished: hiddenCommandLines({ state: 'success', lines, droppedLines: 41 }),
			failed: hiddenCommandLines({ state: 'failed', lines, droppedLines: 0 }),
		}, {
			running: 43,
			short: 0,
			finished: 41,
			failed: 0,
		});
	});
});

function run(events: readonly AgentReducerEvent[], mode?: 'plan'): AgentViewState {
	let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text: 'Go', sent: mode ? { compiled: 'Go', mode } : undefined });
	for (const event of events) {
		state = reduceAgentState(state, event);
	}
	return state;
}

function describe(blocks: readonly TimelineBlock[]): string[] {
	return blocks.map(block => {
		switch (block.kind) {
			case 'text': return `text:${block.part.text}${block.caret ? ':caret' : ''}`;
			case 'tool': return `tool:${block.card.id}:${block.card.state}`;
			case 'reads': return `reads:${block.cards.map(card => card.id).join(',')}`;
			case 'subagents': return `subagents:${block.subagents.map(subagent => subagent.run.id).join(',')}`;
			case 'permission': return `permission:${block.entry.id}:${block.entry.state}`;
			default: return block.kind;
		}
	});
}

function delta(text: string): NormalizedClaudeEvent {
	return { type: 'assistant.delta', sessionId: 's', text };
}

function thinking(text: string, at: number, isDone?: boolean): NormalizedClaudeEvent {
	return { type: 'thinking.delta', sessionId: 's', text, at, done: isDone };
}

function read(id: string): NormalizedClaudeEvent {
	const call: ToolCall = { id, name: 'Read', category: 'read', input: {}, display: { label: 'Read', file: `src/${id}.ts` } };
	return { type: 'tool.started', sessionId: 's', call };
}

function search(id: string): NormalizedClaudeEvent {
	const call: ToolCall = { id, name: 'Grep', category: 'search', input: {}, display: { label: 'Search', query: 'x' } };
	return { type: 'tool.started', sessionId: 's', call };
}

function done(id: string): NormalizedClaudeEvent {
	return { type: 'tool.completed', sessionId: 's', callId: id, result: { ok: true } };
}

function started(id: string, parent: string | undefined, agentType: string): NormalizedClaudeEvent {
	return {
		type: 'subagent.started',
		sessionId: 's',
		parentRunId: parent,
		run: { id, parentRunId: parent, agentType, description: id, background: false, state: 'running', startedAt: 1, toolCallCount: 0 },
	};
}
