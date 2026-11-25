/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Schemas } from '../../../../../base/common/network.js';
import { extUriBiasedIgnorePathCase } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EndOfLinePreference, ITextModel } from '../../../../../editor/common/model.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { BeginClaudeRequest, ClaudeRunHandle } from '../../../../../platform/claude/common/claude.js';
import { ClaudeSideQuestionRequest } from '../../../../../platform/claude/common/claudeSideQuestion.js';
import { FakeClaudeRuntimeService } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { IOutputService } from '../../../output/common/output.js';
import { ClaudeAgentService, mergeCheckpointBuffers } from '../../common/claudeAgentService.js';
import { CheckpointOriginal, IClaudeCheckpointService } from '../../common/claudeCheckpointService.js';
import { ClaudeInlineEditService, INLINE_EDIT_KLAWLY_KEY, INLINE_EDIT_DEFAULT_KEY, acceptInlineEdit, cellEditQuestion, cellEditReplacement, appendAgentDraft, compileInlineEditPrompt, decideInlineEdit, followUpInstruction, followUpLines, inlineAgentDraft, rejectInlineEdit, rejectInlineEditAndSave, replaceInlineSelection, resolveInlineSelection } from '../../common/claudeInlineEdit.js';
import { IClaudeKlawlyHooksService } from '../../common/claudeKlawlyHooksService.js';
import { IClaudeReviewService, ReviewConflictError, ReviewFileText, buildTurnReview, collectReviewHunks } from '../../common/claudeReview.js';
import { agentWorkspaceStubs } from './claudeAgentTestUtils.js';

suite('Claude inline edit', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('selection, instruction, checkpoint, inline diff, accept, and undo', async () => {
		const original = 'function applyCoupon(code: string) {\n  return 1;\n}\n';
		const modified = 'async function applyCoupon(code: string) {\n  return 1;\n}\n';
		const uri = URI.file('C:/repo/src/cart.ts');
		const model = disposables.add(createTextModel(original, null, undefined, uri));
		const order: string[] = [];
		let live = original;
		const { service } = harness(disposables, order, async request => {
			order.push('begin');
			assert.strictEqual(request.dirtyBuffers?.[0]?.text, original);
			assert.ok(request.prompt?.includes('<task>'));
			assert.ok(request.prompt?.includes('<file '));
			assert.ok(request.prompt?.includes('<selection '));
			assert.ok(request.prompt?.includes('<instruction>'));
			assert.ok(request.prompt?.includes('make this async'));
			assert.ok(request.prompt?.includes('editing tools'));
			live = modified;
		});

		const outcome = await service.run({
			uri,
			languageId: 'typescript',
			relativePath: 'src/cart.ts',
			text: original,
			selection: resolveInlineSelection(original, 1, 1, 1, 1),
			instruction: 'make this async',
			cwd: 'C:/repo',
			checkpointPath: uri.fsPath,
			readLive: () => live,
		});

		assert.deepStrictEqual(order, ['checkpoint', 'begin']);
		assert.strictEqual(outcome.kind, 'inline');
		if (outcome.kind !== 'inline') {
			return;
		}
		assert.strictEqual(outcome.hunks.length, 1);
		replaceAll(model, modified);
		acceptInlineEdit(model);
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), modified);
		await Promise.resolve(model.undo());
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), original);
	});

	test('reject restores the snapshot and undo brings the edit back', () => {
		const original = 'function applyCoupon(code: string) {\n  return 1;\n}\n';
		const modified = 'async function applyCoupon(code: string) {\n  return 1;\n}\n';
		const model = disposables.add(createTextModel(original));
		replaceAll(model, modified);
		rejectInlineEdit(model, original, modified);
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), original);
		void model.undo();
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), modified);
	});

	test('reject leaves a drifted edit in place', () => {
		const original = 'alpha\n';
		const modified = 'beta\n';
		const model = disposables.add(createTextModel(modified));
		model.setValue('mine\n');
		assert.throws(() => rejectInlineEdit(model, original, modified), error => error instanceof ReviewConflictError);
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), 'mine\n');
	});

	test('a cursor selects the current line and nearby context stays bounded', () => {
		const lines = Array.from({ length: 90 }, (_, index) => index === 0 ? 'FAR_MARKER' : `line ${index}`);
		const text = lines.join('\n');
		const selection = resolveInlineSelection(text, 80, 3, 80, 3);
		assert.strictEqual(selection.startLine, 80);
		assert.strictEqual(selection.startColumn, 1);
		assert.strictEqual(selection.text, 'line 79');
		const prompt = compileInlineEditPrompt({
			relativePath: 'src/cart.ts',
			languageId: 'typescript',
			text,
			selection,
			instruction: 'make this async <now>',
		});
		assert.ok(prompt.includes('start="80:1"'));
		assert.ok(prompt.includes('make this async &lt;now>'));
		assert.ok(!prompt.includes('FAR_MARKER'));
	});

	test('a follow-up targets the changed lines and sends earlier requests as context', () => {
		const uri = URI.file('C:/repo/src/cart.ts');
		const original = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n');
		const modified = ['a', 'B', 'B2', 'c', 'd', 'E', 'f'].join('\n');
		const deleted = ['a', 'b', 'c'].join('\n');
		assert.deepStrictEqual({
			lines: followUpLines(collectReviewHunks(uri, original, modified), 7),
			deletion: followUpLines(collectReviewHunks(uri, deleted, 'a\nb'), 2),
			none: followUpLines([], 7),
			first: followUpInstruction([], ' add types '),
			later: followUpInstruction(['make it async', ' '], 'name it load'),
		}, {
			lines: { startLine: 2, endLine: 6 },
			deletion: { startLine: 2, endLine: 2 },
			none: undefined,
			first: 'add types',
			later: 'Already applied: make it async\nNow: name it load',
		});
	});

	test('the Agent draft names the edited lines and every instruction asked', () => {
		assert.deepStrictEqual({
			one: inlineAgentDraft('src/cart.ts', { startLine: 3, endLine: 3 }, ['make it async']),
			many: inlineAgentDraft('src/cart.ts', { startLine: 2, endLine: 6 }, ['make it async', ' ', ' name it load ']),
		}, {
			one: 'Inline edit in src/cart.ts, line 3, not accepted yet.\nAsked: make it async\n\n',
			many: 'Inline edit in src/cart.ts, lines 2-6, not accepted yet.\nAsked: make it async\nAsked: name it load\n\n',
		});
	});

	test('a hand-off goes after the composer text, one blank line apart, and keeps a blank composer as is', () => {
		assert.deepStrictEqual([
			appendAgentDraft('', 'Asked: x\n\n'),
			appendAgentDraft(' ', 'explain this'),
			appendAgentDraft('my notes\n', 'explain this'),
		], ['Asked: x\n\n', 'explain this', 'my notes\n\nexplain this']);
	});

	test('several regions or another file go to review', async () => {
		const original = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
		const modified = original.replace('line 0', 'LINE 0').replace('line 19', 'LINE 19');
		const uri = URI.file('C:/repo/src/cart.ts');
		const hunks = collectReviewHunks(uri, original, modified);
		assert.ok(hunks.length > 1);
		const decision = decideInlineEdit(uri, [{ uri, originalText: original, modifiedText: modified, existed: true, hunks }], []);
		assert.strictEqual(decision.kind, 'review');
		if (decision.kind === 'review') {
			assert.ok(decision.warning.includes('multiple regions'));
		}

		const other = URI.file('C:/repo/src/other.ts');
		const replaced: ReviewFileText[][] = [];
		const { service } = harness(disposables, [], undefined, [{
			uri: other.toString(),
			text: 'old\n',
			existed: true,
			capturedAs: 'write',
			afterHash: 'abc',
			afterText: 'new\n',
		}], replaced);
		const outcome = await service.run({
			uri,
			languageId: 'typescript',
			relativePath: 'src/cart.ts',
			text: 'function apply() {\n}\n',
			selection: resolveInlineSelection('function apply() {\n}\n', 1, 1, 1, 1),
			instruction: 'make this async',
			cwd: 'C:/repo',
			checkpointPath: uri.fsPath,
			readLive: () => 'async function apply() {\n}\n',
		});
		assert.strictEqual(outcome.kind, 'review');
		if (outcome.kind === 'review') {
			assert.strictEqual(outcome.otherFiles, 1);
			assert.ok(outcome.warning.includes('1 other file'));
		}
		assert.strictEqual(replaced.length, 1);
		assert.strictEqual(replaced[0].length, 2);
	});

	test('the default binding is not the Ctrl/Cmd+K chord prefix', () => {
		assert.notStrictEqual(INLINE_EDIT_DEFAULT_KEY, KeyMod.CtrlCmd | KeyCode.KeyK);
		assert.strictEqual(INLINE_EDIT_KLAWLY_KEY, KeyMod.CtrlCmd | KeyCode.KeyK);
		assert.strictEqual(INLINE_EDIT_DEFAULT_KEY, KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyK);
		const merged = mergeCheckpointBuffers(
			[{ path: 'C:/repo/src/cart.ts', text: 'snapshot' }],
			[{ path: 'C:/repo/src/cart.ts', text: 'dirty' }, { path: 'C:/repo/src/other.ts', text: 'other' }],
		);
		assert.deepStrictEqual(merged, [
			{ path: 'C:/repo/src/cart.ts', text: 'snapshot' },
			{ path: 'C:/repo/src/other.ts', text: 'other' },
		]);
		const left = 'C:/repo/src/cart.ts';
		const right = 'C:/repo/src/Cart.ts';
		const cased = mergeCheckpointBuffers([{ path: left, text: 'snapshot' }], [{ path: right, text: 'dirty' }]);
		const samePath = extUriBiasedIgnorePathCase.isEqual(URI.file(left), URI.file(right));
		assert.strictEqual(cased.length, samePath ? 1 : 2);
		if (samePath) {
			assert.strictEqual(cased[0].text, 'snapshot');
		}
	});

	test('live text that arrives after the turn still becomes the inline diff', async () => {
		const original = 'function applyCoupon(code: string) {\n  return 1;\n}\n';
		const modified = 'async function applyCoupon(code: string) {\n  return 1;\n}\n';
		const uri = URI.file('C:/repo/src/cart.ts');
		let live = original;
		const { service } = harness(disposables, []);
		const outcome = await service.run(request(uri, original, () => live, {
			waitForText: async () => { live = modified; },
		}));
		assert.strictEqual(outcome.kind, 'inline');
		if (outcome.kind === 'inline') {
			assert.strictEqual(outcome.modified, modified);
			assert.strictEqual(outcome.hunks.length, 1);
		}
	});

	test('checkpoint afterText is the edit when the buffer never updates', async () => {
		const original = 'function applyCoupon(code: string) {\n  return 1;\n}\n';
		const modified = 'async function applyCoupon(code: string) {\n  return 1;\n}\n';
		const uri = URI.file('C:/repo/src/cart.ts');
		const { service } = harness(disposables, [], undefined, [{
			uri: uri.toString(),
			text: original,
			existed: true,
			capturedAs: 'write',
			afterText: modified,
		}]);
		const outcome = await service.run(request(uri, original, () => original));
		assert.strictEqual(outcome.kind, 'inline');
		if (outcome.kind === 'inline') {
			assert.strictEqual(outcome.modified, modified);
			assert.strictEqual(outcome.hunks.length, 1);
		}
	});

	test('reject writes the restored buffer', async () => {
		const original = 'function applyCoupon(code: string) {\n  return 1;\n}\n';
		const modified = 'async function applyCoupon(code: string) {\n  return 1;\n}\n';
		const uri = URI.file('C:/repo/src/cart.ts');
		const model = disposables.add(createTextModel(original, null, undefined, uri));
		replaceAll(model, modified);
		const disk = new Map<string, string>([[uri.toString(), modified]]);
		await rejectInlineEditAndSave(model, original, modified, async (resource, text) => {
			disk.set(resource.toString(), text);
		});
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), original);
		assert.strictEqual(disk.get(uri.toString()), original);
		void model.undo();
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), modified);
	});

	test('a drifted reject does not write the file', async () => {
		const uri = URI.file('C:/repo/src/cart.ts');
		const model = disposables.add(createTextModel('mine\n', null, undefined, uri));
		let saved = false;
		await assert.rejects(
			() => rejectInlineEditAndSave(model, 'alpha\n', 'beta\n', async () => { saved = true; }),
			error => error instanceof ReviewConflictError,
		);
		assert.strictEqual(saved, false);
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), 'mine\n');
	});

	test('a running chat turn is not reused', async () => {
		const { service, agent } = harness(disposables, []);
		const chat = agent.createSession();
		await agent.submit(chat.id, 'earlier question', 'C:/repo');
		assert.strictEqual(agent.getViewState(chat.id).turns[0].status, 'running');
		const uri = URI.file('C:/repo/src/cart.ts');
		const original = 'function apply() {\n}\n';
		const modified = 'async function apply() {\n}\n';
		const outcome = await service.run(request(uri, original, () => modified));
		assert.strictEqual(outcome.kind, 'inline');
		if (outcome.kind !== 'inline') {
			return;
		}
		assert.notStrictEqual(outcome.sessionId, chat.id);
		assert.notStrictEqual(outcome.turnId, agent.getViewState(chat.id).turns[0].id);
		assert.strictEqual(agent.getCurrentSession()?.id, chat.id);
		const editTurn = agent.getViewState(outcome.sessionId).turns.find(turn => turn.id === outcome.turnId);
		assert.strictEqual(editTurn?.user.text, 'make this async');
	});

	test('an idle session reports the new turn, not an earlier one', async () => {
		const { service, agent } = harness(disposables, []);
		const chat = agent.createSession();
		await agent.submit(chat.id, 'earlier question', 'C:/repo');
		await settle(agent, chat.id);
		const earlier = agent.getViewState(chat.id).turns[0].id;
		const uri = URI.file('C:/repo/src/cart.ts');
		const outcome = await service.run(request(uri, 'function apply() {\n}\n', () => 'async function apply() {\n}\n'));
		assert.strictEqual(outcome.kind, 'inline');
		if (outcome.kind !== 'inline') {
			return;
		}
		assert.notStrictEqual(outcome.turnId, earlier);
		assert.strictEqual(agent.getViewState(chat.id).turns.find(turn => turn.id === outcome.turnId)?.user.text, 'make this async');
	});

	test('stopping the edit before it changes the file cancels', async () => {
		const built = harness(disposables, [], () => {
			setTimeout(() => { void built.service.cancel(); }, 0);
		}, [], undefined, { stepDelayMs: 60_000 });
		const uri = URI.file('C:/repo/src/cart.ts');
		const original = 'function apply() {\n}\n';
		const outcome = await built.service.run(request(uri, original, () => original));
		assert.strictEqual(outcome.kind, 'cancelled');
	});

	test('a failed turn reports the failure', async () => {
		const { service } = harness(disposables, [], () => {
			throw new Error('disk full');
		});
		const outcome = await service.run(request(URI.file('C:/repo/src/cart.ts'), 'function apply() {\n}\n', () => 'function apply() {\n}\n'));
		assert.strictEqual(outcome.kind, 'failed');
		if (outcome.kind === 'failed') {
			assert.ok(outcome.message.includes('disk full'));
		}
	});

	test('closing the session ends the wait', async () => {
		const built = harness(disposables, [], () => {
			setTimeout(() => {
				const id = built.agent.getCurrentSession()?.id;
				if (id) {
					built.agent.closeSession(id);
				}
			}, 0);
		});
		const outcome = await built.service.run(request(URI.file('C:/repo/src/cart.ts'), 'function apply() {\n}\n', () => 'function apply() {\n}\n'));
		assert.strictEqual(outcome.kind, 'cancelled');
	});

	test('disposing the service ends the wait', async () => {
		const built = harness(disposables, [], () => {
			built.service.dispose();
		});
		const outcome = await built.service.run(request(URI.file('C:/repo/src/cart.ts'), 'function apply() {\n}\n', () => 'function apply() {\n}\n'));
		assert.strictEqual(outcome.kind, 'cancelled');
	});

	test('an unreadable other file is a warning, not an empty review', async () => {
		const replaced: ReviewFileText[][] = [];
		const { service } = harness(disposables, [], undefined, [], replaced, {
			script: [
				'{"type":"session.started","sessionId":"$session","model":"fixture-sonnet"}',
				'{"type":"file.afterWrite","sessionId":"$session","uri":"file:///C:/repo/src/missing.ts","after":null}',
				'{"type":"session.completed","sessionId":"$session"}',
			].join('\n'),
		});
		const outcome = await service.run(request(URI.file('C:/repo/src/cart.ts'), 'function apply() {\n}\n', () => 'function apply() {\n}\n'));
		assert.strictEqual(outcome.kind, 'warning');
		if (outcome.kind === 'warning') {
			assert.ok(outcome.message.includes('missing.ts'), outcome.message);
		}
		assert.strictEqual(replaced.length, 0);
	});

	test('readable files are handed to review and unreadable paths stay in the warning', async () => {
		const replaced: ReviewFileText[][] = [];
		const other = URI.file('C:/repo/src/other.ts');
		const { service } = harness(disposables, [], undefined, [{
			uri: other.toString(),
			text: 'old\n',
			existed: true,
			capturedAs: 'write',
			afterHash: 'abc',
			afterText: 'new\n',
		}], replaced, {
			script: [
				'{"type":"session.started","sessionId":"$session","model":"fixture-sonnet"}',
				'{"type":"file.afterWrite","sessionId":"$session","uri":"file:///C:/repo/src/missing.ts","after":null}',
				'{"type":"session.completed","sessionId":"$session"}',
			].join('\n'),
		});
		const uri = URI.file('C:/repo/src/cart.ts');
		const outcome = await service.run(request(uri, 'function apply() {\n}\n', () => 'async function apply() {\n}\n'));
		assert.strictEqual(outcome.kind, 'review');
		if (outcome.kind === 'review') {
			assert.ok(outcome.detail.includes('missing.ts'), outcome.detail);
		}
		assert.strictEqual(replaced.length, 1);
		assert.strictEqual(replaced[0].length, 2);
		assert.ok(replaced[0].some(file => file.uri.toString() === uri.toString()));
		assert.ok(replaced[0].some(file => file.uri.toString() === other.toString()));
	});

	test('a follow-up that goes to review reviews the target from before the first edit', async () => {
		const uri = URI.file('C:/repo/src/cart.ts');
		const other = URI.file('C:/repo/src/other.ts');
		const otherWrite: CheckpointOriginal = { uri: other.toString(), text: 'old\n', existed: true, capturedAs: 'write', afterHash: 'abc', afterText: 'new\n' };
		const baseline = 'function apply() {\n}\n';
		const first = 'async function apply() {\n}\n';
		const second = 'async function apply(): Promise<void> {\n}\n';
		const reviewed = async (live: string) => {
			const replaced: ReviewFileText[][] = [];
			const { service } = harness(disposables, [], undefined, [otherWrite], replaced);
			const outcome = await service.run({ ...request(uri, first, () => live), baseline });
			return { kind: outcome.kind, files: replaced.flat().map(file => [file.uri.path.split('/').pop(), file.originalText, file.modifiedText]) };
		};
		assert.deepStrictEqual({ onlyOther: await reviewed(first), both: await reviewed(second) }, {
			// The follow-up changed only the other file; the first edit still shows.
			onlyOther: { kind: 'review', files: [['cart.ts', baseline, first], ['other.ts', 'old\n', 'new\n']] },
			both: { kind: 'review', files: [['cart.ts', baseline, second], ['other.ts', 'old\n', 'new\n']] },
		});
	});

	test('a notebook cell is edited in its model, in one undo step, without a turn', async () => {
		const original = 'import pandas as pd\ndf = pd.read_csv("a.csv")\nprint(df)\n';
		const uri = URI.from({ scheme: Schemas.vscodeNotebookCell, path: '/repo/analysis.ipynb', fragment: 'W0sZmlsZQ==' });
		const model = disposables.add(createTextModel(original, 'python', undefined, uri));
		const order: string[] = [];
		const { service, runtime } = harness(disposables, order);
		let asked: ClaudeSideQuestionRequest | undefined;
		runtime.askSideQuestion = async question => {
			asked = question;
			return { kind: 'answer', text: 'Here it is:\n```python\ndf = pd.read_csv("a.csv", sep=";")\n```\n' };
		};
		const selection = resolveInlineSelection(original, 2, 1, 2, 1);
		const outcome = await service.run({ ...request(uri, original, () => model.getValue(EndOfLinePreference.LF)), languageId: 'python', relativePath: 'analysis.ipynb', selection, model, instruction: 'use ; as the separator' });

		assert.strictEqual(outcome.kind, 'inline');
		assert.deepStrictEqual(order, [], 'no agent turn runs for a cell');
		assert.strictEqual(asked?.selection?.text, 'df = pd.read_csv("a.csv")');
		assert.strictEqual(asked?.selection?.path, 'analysis.ipynb');
		assert.ok(asked?.question.includes('use ; as the separator'));
		const edited = 'import pandas as pd\ndf = pd.read_csv("a.csv", sep=";")\nprint(df)\n';
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), edited);
		if (outcome.kind === 'inline') {
			assert.strictEqual(outcome.original, original);
			assert.strictEqual(outcome.modified, edited);
			assert.strictEqual(outcome.hunks.length, 1);
		}
		model.undo();
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), original);
	});

	test('a notebook cell reply without code, a cancel, or a changed cell leaves the cell alone', async () => {
		const original = 'x = 1\n';
		const uri = URI.from({ scheme: Schemas.vscodeNotebookCell, path: '/repo/analysis.ipynb', fragment: 'W0sZmlsZQ==' });
		const model = disposables.add(createTextModel(original, 'python', undefined, uri));
		const { service, runtime } = harness(disposables, []);
		const cellRequest = { ...request(uri, original, () => model.getValue(EndOfLinePreference.LF)), model };

		runtime.askSideQuestion = async () => ({ kind: 'answer', text: 'I would set x to 2.' });
		assert.strictEqual((await service.run(cellRequest)).kind, 'failed');

		let cancelled: string | undefined;
		runtime.cancelSideQuestion = async id => { cancelled = id; };
		runtime.askSideQuestion = async question => {
			await service.cancel();
			assert.strictEqual(cancelled, question.id);
			return { kind: 'cancelled' };
		};
		assert.strictEqual((await service.run(cellRequest)).kind, 'cancelled');

		runtime.askSideQuestion = async () => {
			replaceAll(model, 'x = 5\n');
			return { kind: 'answer', text: '```\nx = 2\n```' };
		};
		assert.strictEqual((await service.run(cellRequest)).kind, 'warning');
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), 'x = 5\n');

		assert.strictEqual((await service.run({ ...cellRequest, cwd: '' })).kind, 'failed');
	});

	test('cell replies: the first fenced block, and the selection replaced by lines and columns', () => {
		assert.strictEqual(cellEditReplacement('```py\na = 1\nb = 2\n```\nmore\n```\nc\n```'), 'a = 1\nb = 2');
		assert.strictEqual(cellEditReplacement('~~~\n  y\n~~~'), '  y');
		assert.strictEqual(cellEditReplacement('```\n```'), '');
		assert.strictEqual(cellEditReplacement('no code'), undefined);
		const text = 'one\ntwo three\nfour\n';
		assert.strictEqual(replaceInlineSelection(text, { startLine: 2, startColumn: 5, endLine: 2, endColumn: 10, text: 'three' }, '3'), 'one\ntwo 3\nfour\n');
		assert.strictEqual(replaceInlineSelection(text, { startLine: 1, startColumn: 1, endLine: 3, endColumn: 5, text: '' }, 'all'), 'all\n');
		assert.ok(cellEditQuestion(' rename x ').endsWith('\nrename x'));
	});
});

function request(uri: URI, text: string, readLive: () => string, extra?: { waitForText?: () => Promise<void> }) {
	return {
		uri,
		languageId: 'typescript',
		relativePath: 'src/cart.ts',
		text,
		selection: resolveInlineSelection(text, 1, 1, 1, 1),
		instruction: 'make this async',
		cwd: 'C:/repo',
		checkpointPath: uri.fsPath,
		readLive,
		waitForText: extra?.waitForText,
	};
}

async function settle(agent: ClaudeAgentService, sessionId: string): Promise<void> {
	const done = () => {
		const turns = agent.getViewState(sessionId).turns;
		const turn = turns[turns.length - 1];
		return !!turn && turn.status !== 'running';
	};
	if (done()) {
		return;
	}
	await new Promise<void>(resolve => {
		const listener = agent.onDidChangeViewState(event => {
			if (event.sessionId === sessionId && done()) {
				listener.dispose();
				resolve();
			}
		});
	});
}

function harness(store: { add<T extends { dispose(): void }>(value: T): T }, order: string[], onBegin?: (request: BeginClaudeRequest) => void | Promise<void>, originals: readonly CheckpointOriginal[] = [], replaced?: ReviewFileText[][], options?: { script?: string; stepDelayMs?: number }) {
	const runtime = store.add(new FakeClaudeRuntimeService(new Map([
		['plain-answer', options?.script ?? [
			'{"type":"session.started","sessionId":"$session","model":"fixture-sonnet"}',
			'{"type":"assistant.completed","sessionId":"$session","text":"Edited."}',
			'{"type":"session.completed","sessionId":"$session"}',
		].join('\n')],
	]), options?.stepDelayMs === undefined ? undefined : { stepDelayMs: options.stepDelayMs }));
	const originalBegin = runtime.begin.bind(runtime);
	runtime.begin = async (request: BeginClaudeRequest): Promise<ClaudeRunHandle> => {
		await onBegin?.(request);
		return originalBegin(request);
	};
	const checkpoints: IClaudeCheckpointService = {
		_serviceBrand: undefined,
		captureDirtyBuffers: async () => {
			order.push('checkpoint');
			return [];
		},
		restore: async () => false,
		readCheckpointOriginals: async () => originals,
		readTurnsChanges: async () => [],
		readOtherChatPaths: async () => new Set<string>(), readHelperTurnIds: async () => [], readTurnGitHead: async () => undefined,
		restoreTurns: async () => true,
	};
	const [workspace, trust, , files, configuration, storage] = agentWorkspaceStubs({ folders: ['C:/repo'] });
	const agent = store.add(new ClaudeAgentService(runtime, output(), workspace, trust, checkpoints, files, configuration, storage));
	const review = {
		replaceTurn: (sessionId: string, turnId: string, files: readonly ReviewFileText[]) => {
			replaced?.push(files.slice());
			return buildTurnReview(sessionId, turnId, files);
		},
		focus: () => undefined,
	} as unknown as IClaudeReviewService;
	const hooks = {
		checkInlineEdit: async () => ({ allowed: true }),
	} as unknown as IClaudeKlawlyHooksService;
	const service = store.add(new ClaudeInlineEditService(agent, checkpoints, review, hooks, runtime));
	return { service, agent, runtime };
}

function replaceAll(model: ITextModel, value: string): void {
	const text = value.replace(/\n/g, model.getEOL());
	model.pushStackElement();
	model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
	model.pushStackElement();
}

function output(): IOutputService {
	return {
		_serviceBrand: undefined,
		getChannel: () => ({ append: () => undefined }),
	} as unknown as IOutputService;
}
