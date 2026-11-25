/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ClaudeGoalView } from '../../common/claudeGoalLoopService.js';
import { getWindow } from '../../../../../base/browser/dom.js';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MetadataConsts } from '../../../../../editor/common/encodedTokenAttributes.js';
import { EncodedTokenizationResult, TokenizationRegistry } from '../../../../../editor/common/languages.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { NullState } from '../../../../../editor/common/languages/nullTokenize.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { TestClipboardService } from '../../../../../platform/clipboard/test/common/testClipboardService.js';
import { NormalizedClaudeEvent, ToolCall } from '../../../../../platform/claude/common/claudeProtocol.js';
import { CLAUDE_TERMINAL_TOOL_ID } from '../../../../../platform/claude/common/claudeTerminalRun.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { AgentReducerEvent, AgentViewState, EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../../../services/claude/common/claudeAgentState.js';
import { buildTurnReview, TurnReview } from '../../../../services/claude/common/claudeReview.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ClaudeTendEnd, CLAUDE_TEND_PR_COMMAND_ID, IClaudeTendPullRequestService } from '../../browser/chat/claudeTendPullRequest.js';
import { ClaudeTimelineCallbacks, ClaudeTimelineRenderer } from '../../browser/chat/claudeTimelineRenderer.js';
import { ClaudeChangesBar } from '../../browser/review/claudeChangesBar.js';
import { ClaudeReviewCardController } from '../../browser/review/claudeChangesCard.js';

const FILE = URI.file('C:/repo/src/auth/middleware.ts');
const NEW_FILE = URI.file('C:/repo/src/auth/middleware.test.ts');
const BEFORE = 'import x;\n\nconst ROUTES = [\n\t\'/signup\',\n];\n';
const AFTER = 'import x;\n\nconst ROUTES = [\n\t\'/signup\',\n\t\'/login\',\n];\n';

suite('Claude timeline rendering', function () {
	// `until` can wait a few seconds for frames in the hidden test window on Windows.
	this.timeout(20_000);
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiationService: TestInstantiationService;
	let root: HTMLElement;
	let reviews: Map<string, TurnReview>;
	let reviewCalls: string[];

	setup(() => {
		instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IClipboardService, new TestClipboardService());
		instantiationService.stub(IClaudeTendPullRequestService, { onDidChange: Event.None, isTending: () => false, lastEnd: () => undefined } as unknown as IClaudeTendPullRequestService);
		root = document.createElement('div');
		root.style.width = '480px';
		document.body.appendChild(root);
		store.add({ dispose: () => root.remove() });
		const style = document.createElement('style');
		style.textContent = '.claude-terminal{max-height:180px;overflow:auto;line-height:17px;white-space:pre;font-family:monospace;font-size:11px}';
		document.head.appendChild(style);
		store.add({ dispose: () => style.remove() });
		reviews = new Map();
		reviewCalls = [];
	});

	function reviewController(): ClaudeReviewCardController {
		return {
			get: turnId => reviews.get(turnId),
			openFile: (turnId, uri) => reviewCalls.push(`open ${turnId} ${uri.path}`),
			acceptFile: (turnId, uri) => reviewCalls.push(`keep ${turnId} ${uri.path}`),
			rejectFile: (turnId, uri) => reviewCalls.push(`undo ${turnId} ${uri.path}`),
			acceptAll: turnId => reviewCalls.push(`keep all ${turnId}`),
			rejectAll: turnId => reviewCalls.push(`undo all ${turnId}`),
			reviewAll: turnId => reviewCalls.push(`review all ${turnId}`),
			openReview: turnId => reviewCalls.push(`review ${turnId}`),
			resolve: () => undefined,
			commitAccepted: () => { reviewCalls.push('commit'); },
		};
	}

	function renderer(extra?: Partial<ClaudeTimelineCallbacks>): ClaudeTimelineRenderer {
		const review = reviewController();
		const callbacks: ClaudeTimelineCallbacks = {
			retry: () => undefined,
			build: async () => undefined,
			respondPermission: async () => undefined,
			openSubagent: () => undefined,
			stopSubagent: () => undefined,
			copyCommand: () => undefined,
			openInTerminal: () => undefined,
			rerunCommand: () => undefined,
			openCommandLog: () => undefined,
			fixCommandError: () => undefined,
			review,
			...extra,
		};
		return store.add(instantiationService.createInstance(ClaudeTimelineRenderer, root, callbacks));
	}

	function part(key: string): HTMLElement | null {
		return root.querySelector(`[data-part="${key}"]`);
	}

	test('turn parts render in event order, so the answer ends the turn', () => {
		renderer().render(run([
			delta('Reading first.'),
			read('r1'), done('r1'),
			shell('b1'), done('b1'),
			delta('All done.'),
			{ type: 'session.completed', sessionId: 's' },
		]));
		assert.deepStrictEqual([...root.querySelectorAll('.claude-turn > .claude-part')].map(element => element.getAttribute('data-part')), ['user', 'work', 'text:t0', 'tool:r1', 'tool:b1', 'text:t3', 'meta']);
	});

	test('a turn that fell back to the chat model shows one muted line (issue 1009, DL-105)', () => {
		const state = run([delta('Working.')]);
		const turn = { ...state.turns[0], fallback: { time: 0, from: 'Haiku', to: 'Opus', cause: 'failed-calls' as const, count: 3 } };
		renderer().render({ ...state, turns: [turn] });
		const line = root.querySelector('.claude-auto-pick.is-fallback');
		assert.ok(line);
		assert.strictEqual(line.textContent?.includes('Went back to your model, Opus, after 3 failed calls in a row.'), true);
		renderer().render(state);
		assert.strictEqual(root.querySelector('.claude-auto-pick.is-fallback'), null);
	});

	test('tool calls are rows, a shell command too (issue 578), and a read names the file with its folder after it', () => {
		renderer().render(run([
			read('r1'), done('r1'),
			search('g1'), done('g1', 'src/a.ts:3'),
			shell('b1'), done('b1'),
			delta('Done.'),
		]));
		const read1 = root.querySelector('[data-tool-id="r1"] .claude-tool-row');
		assert.deepStrictEqual({
			rows: [...root.querySelectorAll('.claude-turn > .claude-part.is-row')].map(element => element.getAttribute('data-part')),
			read: [read1?.querySelector('.target')?.textContent, read1?.querySelector('.folder')?.textContent],
		}, { rows: ['tool:r1', 'tool:g1', 'tool:b1'], read: ['r1.ts', 'src'] });
	});

	test('streaming deltas keep the DOM of finished parts and re-render only the open segment', async () => {
		const timeline = renderer();
		let state = run([delta('First paragraph.'), completed('First paragraph.'), search('g1'), done('g1', 'src/a.ts:3\nsrc/b.ts:9'), delta('Second')]);
		timeline.render(state);
		const first = part('text:t0')?.firstElementChild;
		const card = part('tool:g1')?.firstElementChild;
		const user = part('user')?.firstElementChild;
		const open = part('text:t2')?.firstElementChild;
		for (const text of [' and', ' more', ' words.']) {
			state = reduceAgentState(state, delta(text));
			timeline.render(state);
		}
		// The open segment types the new words in over a few frames (issue 740).
		for (let frame = 0; frame < 60 && part('text:t2')?.textContent !== 'Second and more words.'; frame++) {
			await new Promise<void>(resolve => getWindow(root).requestAnimationFrame(() => resolve()));
		}
		assert.deepStrictEqual({
			first: part('text:t0')?.firstElementChild === first,
			card: part('tool:g1')?.firstElementChild === card,
			user: part('user')?.firstElementChild === user,
			openRebuilt: part('text:t2')?.firstElementChild !== open,
			openText: part('text:t2')?.textContent,
		}, { first: true, card: true, user: true, openRebuilt: true, openText: 'Second and more words.' });
	});

	test('an open card stays open while the turn streams, and a toggle patches only that card', () => {
		const timeline = renderer();
		const other = reduceAgentState(reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-0', text: 'Before' }), completed('Earlier answer.'));
		let state = reduceAgentState(other, { type: 'session.completed', sessionId: 's' });
		state = append(state, [{ type: 'turn.submitted', turnId: 'turn-1', text: 'Go' }, search('g1'), done('g1', 'src/a.ts:3\nsrc/b.ts:9\nsrc/a.ts:12')]);
		timeline.render(state);
		const earlier = root.querySelector('[data-turn-id="turn-0"] [data-part="text:t0"]')?.firstElementChild;
		const row = root.querySelector<HTMLButtonElement>('[data-tool-id="g1"] button.claude-tool-row');
		row?.click();
		state = append(state, [delta('Streaming'), delta(' on')]);
		timeline.render(state);
		const links = [...root.querySelectorAll('[data-tool-id="g1"] .claude-result-link')].map(link => link.textContent);
		assert.deepStrictEqual({
			expanded: root.querySelector('[data-tool-id="g1"] button.claude-tool-row')?.getAttribute('aria-expanded'),
			sameRow: root.querySelector('[data-tool-id="g1"] button.claude-tool-row') === row,
			earlierKept: root.querySelector('[data-turn-id="turn-0"] [data-part="text:t0"]')?.firstElementChild === earlier,
			links,
		}, { expanded: 'true', sameRow: true, earlierKept: true, links: ['a.ts:3, :12src', 'b.ts:9src'] });
	});

	test('a running command keeps its output element while lines stream, and wraps long lines', () => {
		const timeline = renderer();
		let state = run([shell('b1'), output('b1', 'x'.repeat(300))]);
		timeline.render(state);
		const scroller = root.querySelector('.claude-terminal');
		state = append(state, [output('b1', '\nline two')]);
		timeline.render(state);
		const rows = root.querySelector('.claude-terminal pre')?.textContent?.split('\n') ?? [];
		assert.deepStrictEqual({ same: root.querySelector('.claude-terminal') === scroller, wrapped: rows.length > 2, last: rows[rows.length - 1] }, { same: true, wrapped: true, last: 'line two' });
	});

	test('the activity line shows only when nothing else on screen shows progress', () => {
		const timeline = renderer();
		const activity = () => root.querySelector('.claude-activity')?.textContent ?? null;
		const states = {
			waiting: run([]),
			streaming: run([delta('Thinking out loud')]),
			reading: run([read('r1')]),
			between: run([read('r1'), done('r1')]),
			permission: run([{ type: 'permission.requested', sessionId: 's', request: { id: 'p1', toolName: 'Bash', category: 'shell', input: {}, command: 'npm test' } }]),
		};
		const seen: Record<string, string | null> = {};
		for (const [name, state] of Object.entries(states)) {
			timeline.reset();
			root.replaceChildren();
			timeline.render(state);
			seen[name] = activity();
			seen[`${name}Caret`] = root.querySelector('.claude-caret') ? 'caret' : null;
		}
		assert.deepStrictEqual(seen, {
			waiting: 'Working...', waitingCaret: null,
			streaming: null, streamingCaret: 'caret',
			reading: null, readingCaret: null,
			between: 'Working...', betweenCaret: null,
			permission: null, permissionCaret: null,
		});
	});

	test('a burst of streamed text types in from its start, and shows whole once the reply ends (issue 740)', () => {
		const timeline = renderer();
		const reply = 'The handler returns early when the token is missing, so the check never runs.';
		const text = () => root.querySelector('.claude-msg-assistant')?.textContent ?? '';
		let state = run([]);
		timeline.render(state);
		state = append(state, [delta(reply)]);
		timeline.render(state);
		const burst = text();
		state = append(state, [{ type: 'assistant.completed', sessionId: 's', text: reply }, { type: 'session.completed', sessionId: 's' }]);
		timeline.render(state);
		assert.deepStrictEqual({ typing: burst.length < reply.length && reply.startsWith(burst), ended: text() }, { typing: true, ended: reply });
	});

	test('the caret sits at the end of the last list item, not on its own line', () => {
		renderer().render(run([delta('Steps:\n\n- one\n- two')]));
		assert.strictEqual(root.querySelector('.claude-caret')?.parentElement?.tagName, 'LI');
	});

	test('a code block names its language with its file icon, offers Insert before Copy, and takes the editor token colors', async () => {
		store.add(instantiationService.get(ILanguageService).registerLanguage({ id: 'klawlytest', aliases: ['KlawlyTest', 'kt'] }));
		store.add(TokenizationRegistry.register('klawlytest', {
			getInitialState: () => NullState,
			tokenize: () => { throw new Error('not used'); },
			// `const` gets color 5, the rest of the line color 3.
			tokenizeEncoded: (line, _hasEOL, state) => new EncodedTokenizationResult(new Uint32Array(line.startsWith('const') ? [0, 5 << MetadataConsts.FOREGROUND_OFFSET, 5, 3 << MetadataConsts.FOREGROUND_OFFSET] : [0, 3 << MetadataConsts.FOREGROUND_OFFSET]), [], state),
		}));
		renderer().render(run([completed('Try:\n\n```kt\nconst a = 1;\na++;\n```')]));
		await timeout(0);
		const block = root.querySelector('.claude-codeblock');
		assert.deepStrictEqual({
			icon: block?.querySelector('.claude-codeblock-header.show-file-icons .monaco-icon-label.klawlytest-lang-file-icon')?.textContent,
			actions: [...block?.querySelectorAll('.claude-codeblock-header button') ?? []].map(button => button.getAttribute('aria-label')),
			code: block?.querySelector('pre code')?.textContent,
			runs: [...block?.querySelectorAll('pre code span') ?? []].map(span => `${span.className} ${span.textContent}`),
		}, {
			icon: 'kt',
			actions: ['Insert at cursor', 'Copy'],
			code: 'const a = 1;\na++;',
			runs: ['mtk5 const', 'mtk3  a = 1;', 'mtk3 a++;'],
		});
	});

	test('review data repaints its turn: edit rows get a diffstat and a mini-diff with Undo and Keep, and the changes card appears', () => {
		const timeline = renderer();
		const state = run([write('e1', 'Edit', 'src/auth/middleware.ts'), done('e1'), write('e2', 'Write', 'src/auth/middleware.test.ts'), done('e2'), { type: 'session.completed', sessionId: 's' }]);
		timeline.render(state);
		const before = { changes: root.querySelector('.claude-changes'), stat: root.querySelector('[data-tool-id="e1"] .claude-diffstat') };
		reviews.set('turn-1', buildTurnReview('s', 'turn-1', [
			{ uri: FILE, originalText: BEFORE, modifiedText: AFTER, existed: true },
			{ uri: NEW_FILE, originalText: '', modifiedText: 'test();\n', existed: false },
		]));
		timeline.render(state);
		root.querySelector<HTMLButtonElement>('[data-tool-id="e1"] button.claude-tool-row')?.click();
		const diff = [...root.querySelectorAll('[data-tool-id="e1"] .claude-mini-diff > div')].map(row => `${row.className}:${row.textContent}`);
		const footer = [...root.querySelectorAll('[data-tool-id="e1"] .claude-tool-footer button')].map(button => button.textContent || button.getAttribute('aria-label'));
		root.querySelector<HTMLButtonElement>('[data-tool-id="e1"] .claude-tool-footer button.claude-btn:not(.is-ghost)')?.click();
		const card = root.querySelector('.claude-changes');
		const head = [...(card?.querySelectorAll('.claude-changes-head button') ?? [])].map(button => button.textContent);
		const rows = [...(card?.querySelectorAll('.claude-file-row') ?? [])].map(row => [row.querySelector('.name')?.textContent, row.querySelector('.claude-new-pill')?.textContent ?? '', row.querySelector('.claude-diffstat')?.textContent].join('|'));
		const foot = [...(card?.querySelectorAll('.claude-changes-foot button') ?? [])].map(button => button.textContent);
		(card?.querySelectorAll<HTMLButtonElement>('.claude-changes-head button')[1])?.click();
		assert.deepStrictEqual({
			before,
			stat: root.querySelector('[data-tool-id="e1"] .claude-diffstat')?.textContent,
			newPill: root.querySelector('[data-tool-id="e2"] .claude-new-pill')?.textContent,
			diff,
			footer,
			head,
			rows,
			foot,
			calls: reviewCalls,
		}, {
			before: { changes: null, stat: null },
			stat: '+1',
			newPill: 'new',
			diff: ['fold:3 unchanged lines', 'ctx:4 \t\'/signup\',', 'ins:5+\t\'/login\',', 'ctx:6 ];'],
			footer: ['Undo', 'Keep', 'Open Diff'],
			head: ['Undo All', 'Keep All'],
			rows: ['middleware.ts||+1', 'middleware.test.ts|new|+1'],
			foot: ['Review All Changes', 'Review'],
			calls: [`keep turn-1 ${FILE.path}`, 'keep all turn-1'],
		});
	});

	test('the newest turn with changes docks above the composer: its card leaves the timeline, the bar opens to the files and keeps focus', () => {
		const footer = document.createElement('div');
		footer.className = 'claude-pane-footer';
		document.body.appendChild(footer);
		store.add({ dispose: () => footer.remove() });
		let resized = 0;
		const bar = store.add(new ClaudeChangesBar(footer, reviewController(), { folderOf: () => 'src/auth' }, () => resized++));
		const timeline = renderer({ dockedReview: () => bar.turnId });
		let state = run([write('e1', 'Edit', 'src/auth/middleware.ts'), done('e1'), { type: 'session.completed', sessionId: 's' }]);
		state = append(state, [{ type: 'turn.submitted', turnId: 'turn-2', text: 'Again' }, write('e2', 'Edit', 'src/auth/middleware.ts'), done('e2'), { type: 'session.completed', sessionId: 's' }]);
		for (const turnId of ['turn-1', 'turn-2']) {
			reviews.set(turnId, buildTurnReview('s', turnId, [{ uri: FILE, originalText: BEFORE, modifiedText: AFTER, existed: true }]));
		}
		keepAll(reviews.get('turn-1')!);
		const turnIds = state.turns.map(turn => turn.id);
		bar.update(turnIds);
		timeline.render(state);
		const labels = () => [...footer.querySelectorAll<HTMLButtonElement>('.claude-changes-bar-head button')].map(button => button.textContent || button.getAttribute('aria-label'));
		const toggle = () => footer.querySelector<HTMLButtonElement>('.claude-changes-bar-toggle');
		const collapsed = { labels: labels(), rows: footer.querySelectorAll('.claude-file-row').length };
		toggle()?.click();
		const expanded = {
			open: toggle()?.getAttribute('aria-expanded'),
			focused: document.activeElement === toggle(),
			rows: [...footer.querySelectorAll('.claude-file-row')].map(row => `${row.querySelector('.name')?.textContent}|${row.querySelector('.dir')?.textContent}`),
		};
		[...footer.querySelectorAll<HTMLButtonElement>('.claude-changes-bar-head button')].find(button => button.title === 'Keep All')?.click();
		keepAll(reviews.get('turn-2')!);
		bar.update(turnIds);
		const kept = labels();
		footer.querySelector<HTMLButtonElement>('.claude-changes-bar-head .claude-review-open')?.click();
		const later = [...turnIds, 'turn-3'];
		const undocked = { changed: bar.update(later), hidden: bar.element.hidden };
		assert.deepStrictEqual({
			docked: bar.turnId,
			cards: [...root.querySelectorAll('.claude-changes')].map(card => card.closest('[data-turn-id]')?.getAttribute('data-turn-id')),
			collapsed,
			expanded,
			kept,
			undocked,
			calls: reviewCalls,
			resized: resized > 0,
		}, {
			docked: undefined,
			cards: ['turn-1'],
			collapsed: { labels: ['1 File+1', 'Undo', 'Keep', 'Ask Claude to review every change in this turn', 'Review'], rows: 0 },
			expanded: { open: 'true', focused: true, rows: ['middleware.ts|src/auth'] },
			kept: ['1 of 1 reviewed+1', 'Commit', 'Ask Claude to review every change in this turn', 'Review'],
			undocked: { changed: true, hidden: true },
			calls: ['keep all turn-2', 'review turn-2'],
			resized: true,
		});
	});

	test('Keep on an edit card acts on the turn that shows it, and Review All Changes asks Claude about that turn', () => {
		const timeline = renderer();
		let state = run([write('e1', 'Edit', 'src/auth/middleware.ts'), done('e1'), { type: 'session.completed', sessionId: 's' }]);
		state = append(state, [{ type: 'turn.submitted', turnId: 'turn-2', text: 'Again' }, write('e2', 'Edit', 'src/auth/middleware.ts'), done('e2'), { type: 'session.completed', sessionId: 's' }]);
		for (const turnId of ['turn-1', 'turn-2']) {
			reviews.set(turnId, buildTurnReview('s', turnId, [{ uri: FILE, originalText: BEFORE, modifiedText: AFTER, existed: true }]));
		}
		timeline.render(state);
		root.querySelector<HTMLButtonElement>('[data-tool-id="e2"] button.claude-tool-row')?.click();
		const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-tool-id="e2"] .claude-tool-footer button')];
		buttons.find(button => button.textContent === 'Keep')?.click();
		buttons.find(button => button.textContent === 'Undo')?.click();
		buttons.find(button => (button.textContent || button.getAttribute('aria-label')) === 'Open Diff')?.click();
		root.querySelector<HTMLButtonElement>('[data-turn-id="turn-2"] .claude-changes-foot button.claude-review-all')?.click();
		assert.deepStrictEqual(reviewCalls, [`keep turn-2 ${FILE.path}`, `undo turn-2 ${FILE.path}`, `open turn-2 ${FILE.path}`, 'review all turn-2']);
	});

	test('a running edit cannot be expanded or kept before it lands, even with review data loaded', () => {
		const timeline = renderer();
		reviews.set('turn-1', buildTurnReview('s', 'turn-1', [{ uri: FILE, originalText: BEFORE, modifiedText: AFTER, existed: true }]));
		let state = run([write('e1', 'Edit', 'src/auth/middleware.ts')]);
		timeline.render(state);
		const row = root.querySelector<HTMLButtonElement>('[data-tool-id="e1"] button.claude-tool-row');
		row?.click();
		const running = { expanded: row?.getAttribute('aria-expanded') ?? null, buttons: root.querySelectorAll('[data-tool-id="e1"] .claude-tool-footer button').length };
		state = append(state, [done('e1')]);
		timeline.render(state);
		assert.deepStrictEqual({ running, landed: root.querySelector('[data-tool-id="e1"] button.claude-tool-row')?.getAttribute('aria-expanded') }, { running: { expanded: null, buttons: 0 }, landed: 'false' });
	});

	test('command output re-wraps when the pane is resized, without a new chunk', async () => {
		renderer().render(run([shell('b1'), output('b1', 'x'.repeat(300))]));
		const rows = () => root.querySelector('.claude-terminal pre')?.textContent?.split('\n').length ?? 0;
		const narrow = rows();
		root.style.width = '960px';
		await until(() => rows() < narrow);
		assert.deepStrictEqual({ wrapped: narrow > 2, fewer: rows() < narrow }, { wrapped: true, fewer: true });
	});

	test('a following command log stays pinned to the bottom when a narrower pane re-wraps it', async () => {
		root.style.width = '960px';
		renderer().render(run([shell('b1'), output('b1', Array.from({ length: 40 }, (_value, index) => `${index} ${'x'.repeat(150)}`).join('\n'))]));
		const scroller = root.querySelector<HTMLElement>('.claude-terminal');
		const height = () => scroller?.scrollHeight ?? 0;
		const pinned = () => !!scroller && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1;
		const wide = height();
		const before = pinned();
		root.style.width = '320px';
		await until(() => height() > wide && pinned());
		assert.deepStrictEqual({ before, taller: height() > wide, pinned: pinned() }, { before: true, taller: true, pinned: true });
	});

	test('a failed or cancelled edit shows its own error, not the review of another edit to the same file', () => {
		const timeline = renderer();
		const state = run([
			write('e1', 'Edit', 'src/auth/middleware.ts'),
			{ type: 'tool.completed', sessionId: 's', callId: 'e1', result: { ok: false, error: 'String to replace not found' } },
			write('e2', 'Edit', 'src/auth/middleware.ts'), done('e2'),
			write('e3', 'Edit', 'src/auth/middleware.ts'),
			{ type: 'session.completed', sessionId: 's' },
		]);
		reviews.set('turn-1', buildTurnReview('s', 'turn-1', [{ uri: FILE, originalText: BEFORE, modifiedText: AFTER, existed: true }]));
		timeline.render(state);
		const shape = (id: string) => {
			const row = root.querySelector<HTMLButtonElement>(`[data-tool-id="${id}"] button.claude-tool-row`);
			if (row?.getAttribute('aria-expanded') === 'false') {
				row.click();
			}
			return {
				expandable: row?.hasAttribute('aria-expanded') ?? false,
				stat: root.querySelector(`[data-tool-id="${id}"] .claude-diffstat`)?.textContent ?? null,
				miniDiff: !!root.querySelector(`[data-tool-id="${id}"] .claude-mini-diff`),
				body: root.querySelector(`[data-tool-id="${id}"] .claude-mini-diff`) ? null : root.querySelector(`[data-tool-id="${id}"] .claude-tool-body`)?.textContent ?? null,
				actions: root.querySelectorAll(`[data-tool-id="${id}"] .claude-tool-footer button`).length,
			};
		};
		assert.deepStrictEqual({ failed: shape('e1'), landed: shape('e2'), cancelled: shape('e3') }, {
			failed: { expandable: true, stat: null, miniDiff: false, body: 'String to replace not found', actions: 0 },
			landed: { expandable: true, stat: '+1', miniDiff: true, body: null, actions: 3 },
			cancelled: { expandable: false, stat: null, miniDiff: false, body: null, actions: 0 },
		});
	});

	test('the subagent elapsed timer stops once every subagent has ended', async () => {
		const timeline = renderer();
		let state = run([started('run-a')]);
		timeline.render(state);
		const running = timeline.elapsedTimerRunning;
		state = append(state, [{ type: 'subagent.finished', sessionId: 's', runId: 'run-a', state: 'success', endedAt: Date.now() }]);
		timeline.render(state);
		for (let waited = 0; waited < 2000 && timeline.elapsedTimerRunning; waited += 50) {
			await timeout(50);
		}
		assert.deepStrictEqual({ running, stopped: !timeline.elapsedTimerRunning }, { running: true, stopped: true });
	});

	test('a run_in_terminal call that waits for the user shows Open Terminal and Cancel under its row until it ends (issue 452)', () => {
		const changes = store.add(new Emitter<void>());
		const calls: string[] = [];
		let waiting: { requestId: string; reason?: string } | undefined;
		const timeline = renderer({
			terminalRuns: {
				onDidChange: changes.event,
				find: command => command === 'gh auth login' ? waiting : undefined,
				open: requestId => calls.push(`open ${requestId}`),
				cancel: requestId => calls.push(`cancel ${requestId}`),
			},
		});
		const terminalCall = call('t1', CLAUDE_TERMINAL_TOOL_ID, 'shell', { label: CLAUDE_TERMINAL_TOOL_ID, command: 'gh auth login' });
		const wait = () => {
			const row = root.querySelector('[data-tool-id="t1"] .claude-terminal-wait');
			return row ? {
				role: row.getAttribute('role'),
				underRow: !!row.previousElementSibling?.matches('button.claude-tool-row'),
				text: [...row.querySelectorAll('strong, .reason, button')].map(element => element.textContent),
				titles: [...row.querySelectorAll('button')].map(button => button.title),
			} : undefined;
		};
		timeline.render(run([terminalCall]));
		const before = wait();
		waiting = { requestId: 'r1', reason: 'Finish signing in to GitHub. I will continue when you are done.' };
		changes.fire();
		const shown = wait();
		root.querySelectorAll<HTMLButtonElement>('.claude-terminal-wait button').forEach(button => button.click());
		waiting = undefined;
		changes.fire();
		const answered = wait();
		waiting = { requestId: 'r2' };
		timeline.render(run([terminalCall, done('t1', '`gh auth login` ended with exit code 0.')]));
		changes.fire();
		assert.deepStrictEqual({ before, shown, calls, answered, ended: wait(), verb: root.querySelector('[data-tool-id="t1"] .claude-tool-row .verb')?.textContent }, {
			before: undefined,
			shown: {
				role: 'status',
				underRow: true,
				text: ['Waiting for you in the terminal', 'Finish signing in to GitHub. I will continue when you are done.', 'Open Terminal', 'Cancel'],
				titles: ['Show the terminal', 'Stop the command and tell Claude'],
			},
			calls: ['open r1', 'cancel r1'],
			answered: undefined,
			ended: undefined,
			verb: 'Ran',
		});
	});

	test('a failed command folds to "Ran" and "exit 2", opens to a quiet Fix this error, and the banner leads with Retry', () => {
		renderer().render(run([
			shell('b1'),
			output('b1', 'error TS2322'),
			{ type: 'tool.completed', sessionId: 's', callId: 'b1', result: { ok: false, error: 'Command failed with exit code 2' } },
			{ type: 'session.failed', sessionId: 's', message: 'ECONNRESET', kind: 'network' },
		]));
		const card = root.querySelector('[data-tool-id="b1"]');
		const banner = root.querySelector('.claude-banner.is-error');
		const folded = { expanded: card?.querySelector('button.claude-tool-row')?.getAttribute('aria-expanded'), output: !!card?.querySelector('.claude-terminal') };
		card?.querySelector<HTMLButtonElement>('button.claude-tool-row')?.click();
		const opened = root.querySelector('[data-tool-id="b1"]');
		assert.deepStrictEqual({
			folded,
			verb: opened?.querySelector('.claude-tool-row .verb')?.textContent,
			badge: opened?.querySelector('.claude-badge')?.textContent,
			failedOnce: (opened?.textContent?.match(/failed/gi) ?? []).length,
			fix: opened?.querySelector('button.claude-fix-error')?.classList.contains('is-primary'),
			footer: [...(opened?.querySelectorAll('.claude-tool-footer.is-command .actions button') ?? [])].map(button => button.getAttribute('aria-label')),
			primary: [...(banner?.querySelectorAll('button.is-primary') ?? [])].map(button => button.textContent),
			reassure: banner?.querySelector('.desc.is-reassure')?.textContent,
			nextConversation: banner?.textContent?.includes('new Claude conversation'),
		}, {
			folded: { expanded: 'false', output: false },
			verb: 'Ran',
			badge: 'exit 2',
			failedOnce: 1,
			fix: false,
			footer: ['Copy command', 'Re-run', 'Open in Terminal', 'Open full log'],
			primary: ['Retry'],
			reassure: 'Your files are safe. The partial answer is kept.',
			nextConversation: false,
		});
	});

	test('a turn stopped at its step limit is a quiet line with Continue, not an error banner (issues 696, 707)', () => {
		const continued: string[] = [];
		renderer({ continueTurn: () => continued.push('continue') }).render(run([
			shell('b1'),
			{ type: 'tool.completed', sessionId: 's', callId: 'b1', result: { ok: true, output: 'ok' } },
			{ type: 'session.failed', sessionId: 's', message: 'Claude stopped after 40 steps.', kind: 'turn-limit', turns: 40 },
		]));
		const line = root.querySelector('.claude-activity.is-turn-limit');
		line?.querySelector<HTMLButtonElement>('button.claude-continue')?.click();
		assert.deepStrictEqual({
			text: line?.querySelector('.text')?.textContent,
			button: line?.querySelector('button.claude-continue')?.textContent,
			banner: !!root.querySelector('.claude-banner.is-error'),
			continued,
		}, {
			text: 'Claude stopped after 40 steps.',
			button: 'Continue',
			banner: false,
			continued: ['continue'],
		});
	});

	test('a goal that hit its spend limit says why first, offers Edit Goal... and Start Goal Again, links the setting and can be dismissed (issue 1117)', () => {
		const calls: string[] = [];
		const view = { status: 'limit', reason: 'budget', turn: 2, maxTurns: 5, spentUsd: 5, maxBudgetUsd: 5, goal: { kind: 'goal', outcome: 'make npm test pass' } } as unknown as ClaudeGoalView;
		renderer({
			goalEnded: () => ({ view, cwd: '/w', afterTurnId: 'turn-1', at: 0 }),
			editGoal: () => calls.push('edit'),
			restartGoal: () => calls.push('restart'),
			openGoalSpendSetting: () => calls.push('setting'),
			dismissGoalEnded: () => calls.push('dismiss'),
		}).render(run([delta('Done')]));
		const line = root.querySelector('.is-goal-ended');
		const buttons = [...line!.querySelectorAll('button')];
		const labels = buttons.map(button => button.textContent);
		buttons.forEach(button => button.click());
		assert.deepStrictEqual({
			text: line!.querySelector('.text')!.textContent!.replace(/ at [^.]*\. /, ' at TIME. '),
			labels,
			calls,
			gone: !root.querySelector('.is-goal-ended'),
		}, {
			text: 'Goal not finished: reached the spend limit ($5.00) at TIME. make npm test pass',
			labels: ['Change Spend Limit', 'Edit Goal...', 'Start Goal Again', 'Dismiss'],
			calls: ['setting', 'edit', 'restart', 'dismiss'],
			gone: true,
		});
	});

	test('a goal that hit its turn limit links the turn limit setting, not the spend limit (issue 1150)', () => {
		const calls: string[] = [];
		const view = { status: 'limit', reason: 'max-turns', turn: 5, maxTurns: 5, spentUsd: 1, maxBudgetUsd: 5, goal: { kind: 'goal', outcome: 'make npm test pass' } } as unknown as ClaudeGoalView;
		renderer({
			goalEnded: () => ({ view, cwd: '/w', afterTurnId: 'turn-1', at: 0 }),
			editGoal: () => calls.push('edit'),
			openGoalSpendSetting: () => calls.push('spend'),
			openGoalTurnsSetting: () => calls.push('turns'),
		}).render(run([delta('Done')]));
		const buttons = [...root.querySelectorAll<HTMLButtonElement>('.is-goal-ended button')];
		const labels = buttons.map(button => button.textContent);
		buttons.forEach(button => button.click());
		assert.deepStrictEqual({ labels, calls }, { labels: ['Change Turn Limit', 'Edit Goal...'], calls: ['turns', 'edit'] });
	});

	test('a Tend This PR run that ended leaves a quiet line with its reason, Tend Again when tending can go on, and Dismiss (issue 1194)', () => {
		const commands: string[] = [];
		const onDidChange = store.add(new Emitter<{ sessionId: string }>());
		let end: ClaudeTendEnd | undefined = { reason: 'turnCap', number: 7, message: 'Stopped tending #7: it used all 20 turns.' };
		instantiationService.stub(IClaudeTendPullRequestService, { onDidChange: onDidChange.event, isTending: () => false, lastEnd: () => end } as unknown as IClaudeTendPullRequestService);
		instantiationService.stub(ICommandService, { executeCommand: async (id: string) => { commands.push(id); return undefined; } } as unknown as ICommandService);
		const timeline = renderer();
		timeline.setDragSession('s1');
		timeline.render(run([delta('Done')]));
		const line = root.querySelector('.is-tend-ended');
		const buttons = [...line!.querySelectorAll('button')];
		const labels = buttons.map(button => button.textContent);
		buttons.forEach(button => button.click());
		const dismissed = !root.querySelector('.is-tend-ended');
		end = { reason: 'clean', number: 7, message: 'Done tending #7: checks pass and no comments are left.' };
		onDidChange.fire({ sessionId: 's1' });
		assert.deepStrictEqual({
			text: line!.querySelector('.text')!.textContent,
			role: line!.getAttribute('role'),
			labels,
			commands,
			dismissed,
			cleanLabels: [...root.querySelectorAll('.is-tend-ended button')].map(button => button.textContent),
		}, {
			text: 'Stopped tending #7: it used all 20 turns.',
			role: 'status',
			labels: ['Tend Again', 'Dismiss'],
			commands: [CLAUDE_TEND_PR_COMMAND_ID],
			dismissed: true,
			cleanLabels: ['Dismiss'],
		});
	});

	test('a running command is open with "Running" and folds once it ends, unless the user chose', () => {
		const timeline = renderer();
		let state = run([shell('b1'), output('b1', 'one'), shell('b2'), output('b2', 'two')]);
		timeline.render(state);
		const expanded = (id: string) => root.querySelector(`[data-tool-id="${id}"] button.claude-tool-row`)?.getAttribute('aria-expanded');
		const running = { verb: root.querySelector('[data-tool-id="b1"] .claude-tool-row .verb')?.textContent, b1: expanded('b1'), b2: expanded('b2') };
		root.querySelector<HTMLButtonElement>('[data-tool-id="b2"] button.claude-tool-row')?.click();
		root.querySelector<HTMLButtonElement>('[data-tool-id="b2"] button.claude-tool-row')?.click();
		state = append(state, [done('b1'), done('b2')]);
		timeline.render(state);
		assert.deepStrictEqual({ running, done: { verb: root.querySelector('[data-tool-id="b1"] .claude-tool-row .verb')?.textContent, b1: expanded('b1'), b2: expanded('b2') } }, {
			running: { verb: 'Running', b1: 'true', b2: 'true' },
			done: { verb: 'Ran', b1: 'false', b2: 'true' },
		});
	});

	test('a subagent card shows its state by icon, a plural meta line and its latest step', () => {
		const state = run([
			started('run-a'),
			{ type: 'tool.started', sessionId: 's', parentRunId: 'run-a', call: { id: 'in1', name: 'Grep', category: 'search', input: {}, display: { label: 'Search', query: 'redirectTo' } } },
		]);
		renderer().render(state);
		const card = root.querySelector('.claude-subagent');
		assert.deepStrictEqual({
			running: card?.classList.contains('is-running'),
			spin: !!card?.querySelector('.status.codicon-modifier-spin'),
			meta: card?.querySelector('.meta')?.textContent,
			latest: card?.querySelector('.latest')?.textContent,
		}, { running: true, spin: true, meta: '1 tool · 0s', latest: 'Searching "redirectTo"' });
	});

	test('a finished subagent and command keep their card with their own kind word and icon (issue 1258)', () => {
		const command = { type: 'subagent.started' as const, sessionId: 's', run: { id: 'run-b', agentType: 'local_bash', description: 'npm test', background: true, state: 'running' as const, startedAt: Date.now(), toolCallCount: 0 } };
		const timeline = renderer();
		timeline.render(run([started('run-a'), command]));
		timeline.render(run([started('run-a'), command,
			{ type: 'subagent.finished', sessionId: 's', runId: 'run-a', state: 'success', resultText: 'Found 3 callers', endedAt: Date.now() },
			{ type: 'subagent.finished', sessionId: 's', runId: 'run-b', state: 'success', endedAt: Date.now() },
		]));
		assert.deepStrictEqual([...root.querySelectorAll('.claude-subagent')].map(card => ({
			done: card.classList.contains('is-success'),
			verb: card.querySelector('.verb')?.textContent,
			terminal: !!card.querySelector('.status.codicon-terminal'),
			latest: card.querySelector('.latest')?.textContent,
		})), [
			{ done: true, verb: 'Subagent (Explore)', terminal: false, latest: 'Found 3 callers' },
			{ done: true, verb: 'Background command', terminal: true, latest: undefined },
		]);
	});

	test('streamed subagent text leaves the group card alone, and a new tool patches it', () => {
		const timeline = renderer();
		let state = run([started('run-a')]);
		timeline.render(state);
		const card = root.querySelector('.claude-subagent');
		for (const text of ['Looking', ' at', ' callers.']) {
			state = reduceAgentState(state, { type: 'assistant.delta', sessionId: 's', parentRunId: 'run-a', text });
			timeline.render(state);
		}
		const keptOnDeltas = root.querySelector('.claude-subagent') === card;
		state = reduceAgentState(state, { type: 'tool.started', sessionId: 's', parentRunId: 'run-a', call: { id: 'in1', name: 'Grep', category: 'search', input: {}, display: { label: 'Search', query: 'login' } } });
		timeline.render(state);
		assert.deepStrictEqual({
			keptOnDeltas,
			rebuiltOnTool: root.querySelector('.claude-subagent') !== card,
			latest: root.querySelector('.claude-subagent .latest')?.textContent,
		}, { keptOnDeltas: true, rebuiltOnTool: true, latest: 'Searching "login"' });
	});

	test('a plan streams as a skeleton, then shows after the Read card with inline code and plural counts', () => {
		const timeline = renderer();
		let state = run([read('r1'), done('r1'), delta('Plan: fix login\n\n1. Add `/login` to `src/a.ts`\n2. Run tests')], 'plan');
		timeline.render(state);
		const draft = { skeleton: !!root.querySelector('.claude-plan.is-draft .is-skeleton'), raw: !!root.querySelector('.claude-msg-assistant') };
		state = append(state, [{ type: 'session.completed', sessionId: 's' }]);
		timeline.render(state);
		assert.deepStrictEqual({
			draft,
			order: [...root.querySelectorAll('.claude-turn > .claude-part')].map(element => element.getAttribute('data-part')),
			code: [...root.querySelectorAll('.claude-plan .claude-todo .title code')].map(code => code.textContent),
			eyebrow: root.querySelector('.claude-plan-head .eyebrow')?.textContent,
		}, {
			draft: { skeleton: true, raw: false },
			order: ['user', 'work', 'tool:r1', 'plan:t1', 'meta'],
			code: ['/login', 'src/a.ts'],
			eyebrow: 'Plan · 2 steps',
		});
	});

	test('a plan card has the lead above it, numbered steps with code in the detail, labeled buttons and a Plan-colored Build', () => {
		renderer({ openPlan: async () => undefined }).render(run([delta([
			'I read the cart. Here is the plan.',
			'',
			'# Add discount codes',
			'',
			'Codes ignore case.',
			'',
			'1. Add a `Discount` type',
			'   A `Discount` has a code and a percent.',
			'   Files: `cartTypes.ts`, `discounts.ts`',
			'2. Test an unknown code',
		].join('\n')), { type: 'session.completed', sessionId: 's' }], 'plan'));
		const card = root.querySelector('.claude-plan');
		assert.deepStrictEqual({
			lead: card?.previousElementSibling?.textContent?.trim(),
			eyebrow: card?.querySelector('.claude-plan-head .eyebrow')?.textContent,
			title: card?.querySelector('.claude-plan-head .title')?.textContent,
			summary: card?.querySelector('.claude-plan-summary')?.textContent,
			numbers: [...root.querySelectorAll('.claude-plan .claude-todo .state.number')].map(badge => badge.textContent),
			detail: [...root.querySelectorAll('.claude-plan .claude-todo .detail')].map(detail => detail.innerHTML),
			chips: [...root.querySelectorAll('.claude-plan .claude-chip .label')].map(label => label.textContent),
			buttons: [...root.querySelectorAll('.claude-plan-actions > .claude-btn')].map(button => button.textContent),
			build: !!root.querySelector('.claude-plan-actions > .claude-split.is-plan'),
		}, {
			lead: 'I read the cart. Here is the plan.',
			eyebrow: 'Plan · 2 steps',
			title: 'Add discount codes',
			summary: 'Codes ignore case.',
			numbers: ['1', '2'],
			detail: ['A <code>Discount</code> has a code and a percent.'],
			chips: ['cartTypes.ts', 'discounts.ts'],
			buttons: ['Edit Plan', 'Open Plan'],
			build: true,
		});
	});

	test('a plan card shows the details as Markdown above short steps (issue 317)', () => {
		renderer({ openPlan: async () => undefined }).render(run([delta([
			'# Restructure textstats',
			'',
			'Worth doing only where:',
			'',
			'- `report.js` reaches into both counters',
			'',
			'## To-dos',
			'',
			'1. Start on a branch',
			'2. Add one stats module',
		].join('\n')), { type: 'session.completed', sessionId: 's' }], 'plan'));
		const details = root.querySelector('.claude-plan .claude-plan-summary.is-details');
		assert.deepStrictEqual({
			paragraph: details?.querySelector('p')?.textContent,
			bullets: [...(details?.querySelectorAll('li') ?? [])].map(item => item.textContent),
			steps: [...root.querySelectorAll('.claude-plan .claude-todo .title')].map(title => title.textContent),
		}, {
			paragraph: 'Worth doing only where:',
			bullets: ['report.js reaches into both counters'],
			steps: ['Start on a branch', 'Add one stats module'],
		});
	});

	test('the user message has a hover toolbar with Copy and Show Sent Prompt', async () => {
		renderer().render(reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text: 'Fix it', sent: { compiled: 'Fix it with sk-ant-secretvalue', mode: 'agent' } }));
		const toolbar = root.querySelector('.claude-msg-user .claude-msg-toolbar');
		const buttons = [...(toolbar?.querySelectorAll('button') ?? [])];
		buttons[0]?.click();
		buttons[1]?.click();
		const detail = root.querySelector<HTMLElement>('.claude-sent-prompt');
		assert.deepStrictEqual({
			role: toolbar?.getAttribute('role'),
			labels: buttons.map(button => button.getAttribute('aria-label')),
			copied: await instantiationService.get(IClipboardService).readText(),
			open: detail?.hidden === false && buttons[1]?.getAttribute('aria-expanded') === 'true',
			redacted: detail?.textContent?.includes('[redacted]'),
			plainLink: [...root.querySelectorAll('.claude-msg-user > button')].length,
		}, { role: 'toolbar', labels: ['Copy', 'Hide Sent Prompt'], copied: 'Fix it', open: true, redacted: true, plainLink: 0 });
	});

	test('a drag on the prompt text selects it; a drag from the bubble edge still moves the prompt (issue 732)', () => {
		renderer().render(reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text: 'Run npm test', sent: undefined }));
		const bubble = root.querySelector<HTMLElement>('.claude-msg-user');
		const text = bubble?.querySelector<HTMLElement>('.text');
		const draggableAfter = (target: HTMLElement | null | undefined) => {
			target?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
			return bubble?.draggable;
		};
		assert.deepStrictEqual({ text: draggableAfter(text), edge: draggableAfter(bubble) }, { text: false, edge: true });
	});

	test('a finished turn folds its work under "Worked for" with a leading chevron, keeps the answer in view, and opens without a rebuild', () => {
		const timeline = renderer();
		let state = append(reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-0', text: 'Where?', startedAt: 1000 }), [
			delta('Checking.'), read('r1'), done('r1'), delta('In todo.ts.'),
			{ type: 'session.completed', sessionId: 's', endedAt: 6000 },
		]);
		timeline.render(state);
		const newest = { toggle: root.querySelector('[data-part="work"] button')?.getAttribute('aria-expanded'), hidden: part('tool:r1')?.hidden };
		state = append(state, [{ type: 'turn.submitted', turnId: 'turn-1', text: 'Next' }]);
		timeline.render(state);
		const earlier = (key: string) => root.querySelector<HTMLElement>(`[data-turn-id="turn-0"] [data-part="${key}"]`);
		const visible = () => [...root.querySelectorAll<HTMLElement>('[data-turn-id="turn-0"] > .claude-part')].filter(element => !element.hidden).map(element => element.getAttribute('data-part'));
		const toggle = () => earlier('work')?.querySelector<HTMLButtonElement>('button');
		const card = earlier('tool:r1')?.firstElementChild;
		const folded = { label: toggle()?.textContent, lead: toggle()?.firstElementChild?.className, expanded: toggle()?.getAttribute('aria-expanded'), visible: visible() };
		toggle()?.click();
		assert.deepStrictEqual({
			newest,
			folded,
			opened: { expanded: toggle()?.getAttribute('aria-expanded'), visible: visible(), sameCard: earlier('tool:r1')?.firstElementChild === card },
		}, {
			newest: { toggle: 'true', hidden: false },
			folded: { label: 'Worked for 5s', lead: 'codicon codicon-chevron-right chev', expanded: 'false', visible: ['user', 'work', 'text:t2', 'meta'] },
			opened: { expanded: 'true', visible: ['user', 'work', 'text:t0', 'tool:r1', 'text:t2', 'meta'], sameCard: true },
		});
	});

	test('the meta row under an answer copies only the answer and forks from that turn', async () => {
		const forks: string[] = [];
		renderer({ forkFrom: turnId => forks.push(turnId) }).render(run([
			delta('Checking.'), read('r1'), done('r1'), delta('The answer.'),
			{ type: 'session.completed', sessionId: 's', endedAt: Date.UTC(2026, 9, 6, 14, 30) },
		]));
		const buttons = [...root.querySelectorAll<HTMLButtonElement>('.claude-turn-meta button')];
		buttons.forEach(button => button.click());
		assert.deepStrictEqual({
			labels: buttons.map(button => button.getAttribute('aria-label')),
			copied: await instantiationService.get(IClipboardService).readText(),
			forks,
			time: !!root.querySelector('.claude-turn-meta .time')?.textContent,
			running: (renderer().render(run([delta('Still going')])), root.querySelectorAll('.claude-turn-meta').length),
		}, { labels: ['Copy Answer', 'Fork from Here'], copied: 'The answer.', forks: ['turn-1'], time: true, running: 0 });
	});

	test('a long prompt clamps under a fade and opens on click; Stop shows only while the turn runs', async () => {
		const style = document.createElement('style');
		style.textContent = '.claude-msg-user .text{display:block;line-height:22px;max-height:88px;overflow:hidden}.claude-msg-user.is-expanded .text{max-height:none}';
		document.head.appendChild(style);
		store.add({ dispose: () => style.remove() });
		let stops = 0;
		const timeline = renderer({ stop: () => stops++ });
		const text = Array.from({ length: 8 }, (_value, index) => `Line ${index + 1}`).join('\n');
		let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text });
		timeline.render(state);
		await until(() => !!root.querySelector('.claude-msg-user.is-clamped'));
		const user = root.querySelector<HTMLElement>('.claude-msg-user');
		const body = user?.querySelector<HTMLElement>('.text');
		const stop = user?.querySelector<HTMLButtonElement>('.claude-msg-stop');
		const clamped = { clamped: user?.classList.contains('is-clamped'), expanded: body?.getAttribute('aria-expanded'), height: body?.clientHeight, stop: stop?.hidden };
		stop?.click();
		body?.click();
		await timeout(50);
		const opened = { clamped: user?.classList.contains('is-clamped'), expanded: body?.getAttribute('aria-expanded'), taller: (body?.clientHeight ?? 0) > 88 };
		state = reduceAgentState(state, { type: 'session.completed', sessionId: 's' });
		timeline.render(state);
		assert.deepStrictEqual({
			clamped, opened, stops,
			finished: { stop: stop?.hidden, sameBubble: root.querySelector('.claude-msg-user') === user, expanded: user?.classList.contains('is-expanded') },
		}, {
			clamped: { clamped: true, expanded: 'false', height: 88, stop: false },
			opened: { clamped: false, expanded: 'true', taller: true },
			stops: 1,
			finished: { stop: true, sameBubble: true, expanded: true },
		});
	});

	test('thinking is one quiet line that a chevron leads and opens to its text, and keeps its row while it streams', () => {
		const timeline = renderer();
		let state = run([{ type: 'thinking.delta', sessionId: 's', text: '', at: 1000 }, { type: 'thinking.delta', sessionId: 's', text: 'Check the guard.', at: 1400 }]);
		timeline.render(state);
		const row = root.querySelector<HTMLElement>('.claude-thinking');
		const element = part('thinking:k0');
		const live = { text: row?.querySelector('.claude-thinking-line .text')?.textContent, live: row?.classList.contains('is-live'), streaming: row?.querySelector('.claude-thinking-body')?.textContent?.trim() };
		state = append(state, [{ type: 'thinking.delta', sessionId: 's', text: '', at: 4200, done: true }, delta('It returns early.')]);
		timeline.render(state);
		const line = root.querySelector<HTMLButtonElement>('button.claude-thinking-line');
		const closed = { text: line?.querySelector('.text')?.textContent, lead: line?.firstElementChild?.className, expanded: line?.getAttribute('aria-expanded'), samePart: !!element && part('thinking:k0') === element };
		line?.click();
		const body = root.querySelector('.claude-thinking-body');
		assert.deepStrictEqual({
			live, closed,
			opened: { expanded: root.querySelector('button.claude-thinking-line')?.getAttribute('aria-expanded'), body: body?.textContent?.trim(), controls: root.querySelector('button.claude-thinking-line')?.getAttribute('aria-controls') === body?.id },
		}, {
			live: { text: 'Thinking', live: true, streaming: 'Check the guard.' },
			closed: { text: 'Thought for 3s', lead: 'codicon codicon-chevron-right chev', expanded: 'false', samePart: true },
			opened: { expanded: 'true', body: 'Check the guard.', controls: true },
		});
	});

	test('Thought for opens only its own turn, at once, when every turn starts with thinking (issue 1179)', () => {
		const timeline = renderer();
		const think = (turnId: string, text: string, at: number): readonly AgentReducerEvent[] => [
			{ type: 'turn.submitted', turnId, text: 'Go' },
			{ type: 'thinking.delta', sessionId: 's', text, at },
			{ type: 'thinking.delta', sessionId: 's', text: '', at: at + 2000, done: true },
			completed(`Answer ${turnId}.`),
			{ type: 'session.completed', sessionId: 's' },
		];
		const state = append(EMPTY_AGENT_VIEW_STATE, [...think('turn-0', 'First thought.', 1000), ...think('turn-1', 'Second thought.', 9000)]);
		timeline.render(state);
		const line = (turnId: string) => root.querySelector<HTMLButtonElement>(`[data-turn-id="${turnId}"] button.claude-thinking-line`);
		const expanded = (turnId: string) => line(turnId)?.getAttribute('aria-expanded') ?? null;
		const before = { first: expanded('turn-0'), second: expanded('turn-1') };
		line('turn-1')?.click();
		const opened = { first: expanded('turn-0'), second: expanded('turn-1'), body: root.querySelector('[data-turn-id="turn-1"] .claude-thinking-body')?.textContent?.trim(), others: root.querySelectorAll('.claude-thinking-body').length };
		line('turn-1')?.click();
		assert.deepStrictEqual({ before, opened, closed: { first: expanded('turn-0'), second: expanded('turn-1') } }, {
			before: { first: 'false', second: 'false' },
			opened: { first: 'false', second: 'true', body: 'Second thought.', others: 1 },
			closed: { first: 'false', second: 'false' },
		});
	});

	test('Restore Checkpoint shows on a finished prompt that changed files and restores that turn', () => {
		const restores: string[] = [];
		const timeline = renderer({ restoreCheckpoint: turnId => restores.push(turnId) });
		let state = run([write('w1', 'Edit', FILE.fsPath), done('w1')]);
		timeline.render(state);
		const restore = root.querySelector<HTMLButtonElement>('.claude-msg-restore');
		const running = restore?.hidden;
		state = append(state, [{ type: 'session.completed', sessionId: 's' }]);
		timeline.render(state);
		const finished = { hidden: restore?.hidden, label: restore?.getAttribute('aria-label'), restorable: root.querySelector('.claude-msg-user')?.classList.contains('is-restorable') };
		restore?.click();
		timeline.render(append(run([delta('No edits.')]), [{ type: 'session.completed', sessionId: 's' }]));
		assert.deepStrictEqual({ running, finished, restores, untouched: root.querySelectorAll('.claude-msg-restore:not([hidden])').length }, {
			running: true,
			finished: { hidden: false, label: 'Restore Checkpoint', restorable: true },
			restores: ['turn-1'],
			untouched: 0,
		});
	});
});

/**
 * Polls on short timers until `check` holds or 4 s pass, and leaves the verdict to the assertion after it.
 * The prompt clamp is measured in a ResizeObserver callback, and the command log re-wraps on the
 * animation frame after one. The hidden test window on Windows delivers both about once a second once
 * it has been open a moment, so the fixed 50 ms and 1 s waits these tests had ended before they ran.
 */
async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 4000;
	while (!check() && Date.now() < deadline) {
		await timeout(20);
	}
}

/** Marks every file and hunk of `review` kept, as the review service would. */
function keepAll(review: TurnReview): void {
	for (const file of review.files) {
		file.state = 'accepted';
		for (const hunk of file.hunks) {
			hunk.state = 'accepted';
		}
	}
}

function run(events: readonly AgentReducerEvent[], mode?: 'plan'): AgentViewState {
	return append(reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text: 'Go', sent: mode ? { compiled: 'Go', mode } : undefined }), events);
}

function append(state: AgentViewState, events: readonly AgentReducerEvent[]): AgentViewState {
	for (const event of events) {
		state = reduceAgentState(state, event);
	}
	return state;
}

function delta(text: string): NormalizedClaudeEvent {
	return { type: 'assistant.delta', sessionId: 's', text };
}

function completed(text: string): NormalizedClaudeEvent {
	return { type: 'assistant.completed', sessionId: 's', text };
}

function started(id: string): NormalizedClaudeEvent {
	return { type: 'subagent.started', sessionId: 's', run: { id, agentType: 'Explore', description: 'Find callers', background: false, state: 'running', startedAt: Date.now(), toolCallCount: 0 } };
}

function call(id: string, name: string, category: ToolCall['category'], display: ToolCall['display']): NormalizedClaudeEvent {
	return { type: 'tool.started', sessionId: 's', call: { id, name, category, input: {}, display } };
}

function read(id: string): NormalizedClaudeEvent {
	return call(id, 'Read', 'read', { label: 'Read', file: `src/${id}.ts` });
}

function search(id: string): NormalizedClaudeEvent {
	return call(id, 'Grep', 'search', { label: 'Search', query: 'redirectTo' });
}

function shell(id: string): NormalizedClaudeEvent {
	return call(id, 'Bash', 'shell', { label: 'Run', command: 'npm run build' });
}

function write(id: string, name: string, file: string): NormalizedClaudeEvent {
	return call(id, name, 'write', { label: name, file });
}

function output(id: string, text: string): NormalizedClaudeEvent {
	return { type: 'tool.updated', sessionId: 's', callId: id, update: { stdout: text } };
}

function done(id: string, text?: string): NormalizedClaudeEvent {
	return { type: 'tool.completed', sessionId: 's', callId: id, result: { ok: true, output: text } };
}
