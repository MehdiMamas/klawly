/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { tmpdir } from 'os';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NormalizedClaudeEvent } from '../../common/claudeProtocol.js';
import { CLAUDE_QUESTION_DECLINED, claudeQuestionResult, readClaudeQuestions } from '../../common/claudeQuestion.js';
import { ClaudeAgentRunner } from '../../node/claudeAgentRunner.js';
import { ClaudeElicitationBridge } from '../../node/claudeElicitationBridge.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery, ClaudeQueryStart } from '../../node/claudeQuery.js';
import { runClaudeQuestion } from '../../node/claudeQuestionRequest.js';

/** An `AskUserQuestion` input as Claude Code sends it. */
const INPUT = {
	questions: [
		{
			question: 'Which layout should the settings page use?',
			header: 'Layout',
			multiSelect: false,
			options: [
				{ label: 'Tabs', description: 'One tab per section.', preview: '[General] [Editor]' },
				{ label: 'One page', description: 'Every section on one scrolling page.' },
			],
		},
		{
			question: 'Which checks should run before a commit?',
			header: 'Checks',
			multiSelect: true,
			options: [
				{ label: 'Lint', description: 'ESLint on changed files.' },
				{ label: 'Unit tests', description: 'Node unit tests.' },
				{ label: 'Types', description: 'A type check.' },
			],
		},
	],
};

const QUESTIONS = readClaudeQuestions(INPUT)!;
const LAYOUT = INPUT.questions[0].question;
const CHECKS = INPUT.questions[1].question;

/**
 * Issue 477: Claude's `AskUserQuestion` reaches the card as a `question`
 * elicitation, and the answers go back as the tool's `updatedInput` in the
 * shape the SDK reads (labels joined by ", ", a preview as an annotation). A
 * decline, a timeout or a stopped session denies the call, so the turn goes on.
 */
suite('Claude questions (issue 477)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the input maps to questions; a malformed one is left to the permission path', () => {
		assert.deepStrictEqual({
			questions: QUESTIONS,
			rejected: [
				undefined,
				{},
				{ questions: [] },
				{ questions: [{ question: '', options: [{ label: 'A' }] }] },
				{ questions: [{ question: 'Q?', options: [] }] },
				{ questions: [{ question: 'Q?', options: [{ description: 'no label' }] }] },
				{ questions: [{ question: 'Q?', options: [{ label: 'A' }] }, { question: 'Q?', options: [{ label: 'B' }] }] },
			].map(readClaudeQuestions),
		}, {
			questions: [
				{
					question: LAYOUT, header: 'Layout', multiSelect: false,
					options: [{ label: 'Tabs', description: 'One tab per section.', preview: '[General] [Editor]' }, { label: 'One page', description: 'Every section on one scrolling page.' }],
				},
				{
					question: CHECKS, header: 'Checks', multiSelect: true,
					options: [{ label: 'Lint', description: 'ESLint on changed files.' }, { label: 'Unit tests', description: 'Node unit tests.' }, { label: 'Types', description: 'A type check.' }],
				},
			],
			rejected: [undefined, undefined, undefined, undefined, undefined, undefined, undefined],
		});
	});

	test('answers join multi-select labels, keep Other text, annotate a chosen preview and need every question', () => {
		assert.deepStrictEqual([
			claudeQuestionResult(QUESTIONS, { [LAYOUT]: 'Tabs', [CHECKS]: ['Lint', 'Types'] }),
			claudeQuestionResult(QUESTIONS, { [LAYOUT]: '  A sidebar  ', [CHECKS]: ['Unit tests', 'Spell check'] }),
			claudeQuestionResult(QUESTIONS, { [LAYOUT]: 'One page' }),
			claudeQuestionResult(QUESTIONS, { [LAYOUT]: 'One page', [CHECKS]: [' '] }),
		], [
			{ answers: { [LAYOUT]: 'Tabs', [CHECKS]: 'Lint, Types' }, annotations: { [LAYOUT]: { preview: '[General] [Editor]' } } },
			{ answers: { [LAYOUT]: 'A sidebar', [CHECKS]: 'Unit tests, Spell check' } },
			undefined,
			undefined,
		]);
	});

	test('an answer allows the call with the answers; a decline, a partial answer or a timeout denies it', async () => {
		const bridge = new ClaudeElicitationBridge();
		const seen: NormalizedClaudeEvent[] = [];
		const context = { bridge, sessionId: 's', push: (event: NormalizedClaudeEvent) => seen.push(event), now: () => 1000, timeoutMs: 60_000 };
		const signal = new AbortController().signal;

		const answered = runClaudeQuestion(context, 'tool-1', QUESTIONS, INPUT, signal);
		bridge.resolve('s', 'tool-1', { action: 'accept', content: { [LAYOUT]: 'One page', [CHECKS]: ['Lint'] } });
		const declined = runClaudeQuestion(context, 'tool-2', QUESTIONS, INPUT, signal);
		bridge.resolve('s', 'tool-2', { action: 'decline' });
		const partial = runClaudeQuestion(context, 'tool-3', QUESTIONS, INPUT, signal);
		bridge.resolve('s', 'tool-3', { action: 'accept', content: { [LAYOUT]: 'Tabs' } });
		const timedOut = await runClaudeQuestion({ ...context, timeoutMs: 1 }, 'tool-4', QUESTIONS, INPUT, signal);

		assert.deepStrictEqual({
			results: [await answered, await declined, await partial, timedOut],
			events: seen.map(event => event.type === 'elicitation.requested'
				? [event.type, event.request.id, event.request.server, event.request.mode, event.request.message, event.request.questions === QUESTIONS]
				: event.type === 'elicitation.resolved' ? [event.type, event.outcome.id, event.outcome.action, event.outcome.source, event.outcome.answers] : [event.type]),
		}, {
			results: [
				{ behavior: 'allow', updatedInput: { ...INPUT, answers: { [LAYOUT]: 'One page', [CHECKS]: 'Lint' } } },
				{ behavior: 'deny', message: CLAUDE_QUESTION_DECLINED },
				{ behavior: 'deny', message: CLAUDE_QUESTION_DECLINED },
				{ behavior: 'deny', message: 'The user did not answer the questions in time.' },
			],
			events: [
				['elicitation.requested', 'tool-1', 'Claude', 'question', LAYOUT, true],
				['elicitation.requested', 'tool-2', 'Claude', 'question', LAYOUT, true],
				['elicitation.requested', 'tool-3', 'Claude', 'question', LAYOUT, true],
				// Each card shows before any answer is read back, so the fourth comes before the first answer.
				['elicitation.requested', 'tool-4', 'Claude', 'question', LAYOUT, true],
				['elicitation.resolved', 'tool-1', 'accept', 'user', { [LAYOUT]: 'One page', [CHECKS]: 'Lint' }],
				['elicitation.resolved', 'tool-2', 'decline', 'user', undefined],
				['elicitation.resolved', 'tool-3', 'decline', 'user', undefined],
				['elicitation.resolved', 'tool-4', 'cancel', 'timeout', undefined],
			],
		});
	});

	test('a reply in place of answers allows the call with the SDK\'s response, and a note goes beside its answer', async () => {
		const bridge = new ClaudeElicitationBridge();
		const seen: NormalizedClaudeEvent[] = [];
		const context = { bridge, sessionId: 's', push: (event: NormalizedClaudeEvent) => seen.push(event), now: () => 1000, timeoutMs: 60_000 };
		const signal = new AbortController().signal;

		const replied = runClaudeQuestion(context, 'tool-1', QUESTIONS, INPUT, signal);
		bridge.resolve('s', 'tool-1', { action: 'accept', reply: '  Neither, we already run MongoDB  ' });
		const noted = runClaudeQuestion(context, 'tool-2', QUESTIONS, INPUT, signal);
		bridge.resolve('s', 'tool-2', { action: 'accept', content: { [LAYOUT]: 'Tabs', [CHECKS]: ['Lint'] }, notes: { [LAYOUT]: ' Only for the API ', [CHECKS]: ' ' } });
		const blank = runClaudeQuestion(context, 'tool-3', QUESTIONS, INPUT, signal);
		bridge.resolve('s', 'tool-3', { action: 'accept', reply: '   ' });

		assert.deepStrictEqual({
			results: [await replied, await noted, await blank],
			outcomes: seen.flatMap(event => event.type === 'elicitation.resolved' ? [{ ...event.outcome }] : []),
		}, {
			results: [
				{ behavior: 'allow', updatedInput: { ...INPUT, answers: {}, response: 'Neither, we already run MongoDB' } },
				{ behavior: 'allow', updatedInput: { ...INPUT, answers: { [LAYOUT]: 'Tabs', [CHECKS]: 'Lint' }, annotations: { [LAYOUT]: { preview: '[General] [Editor]', notes: 'Only for the API' } } } },
				{ behavior: 'deny', message: CLAUDE_QUESTION_DECLINED },
			],
			outcomes: [
				{ id: 'tool-1', server: 'Claude', mode: 'question', action: 'accept', source: 'user', reply: 'Neither, we already run MongoDB' },
				{ id: 'tool-2', server: 'Claude', mode: 'question', action: 'accept', source: 'user', answers: { [LAYOUT]: 'Tabs', [CHECKS]: 'Lint' }, notes: { [LAYOUT]: 'Only for the API' } },
				{ id: 'tool-3', server: 'Claude', mode: 'question', action: 'decline', source: 'user' },
			],
		});
	});

	test('the runner sends AskUserQuestion to the card and screens it as ask, so a settings rule cannot skip the card', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		const bridge = new ClaudeElicitationBridge();
		const starts: ClaudeQueryStart[] = [];
		let release: (() => void) | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			elicitations: bridge,
			queryFactory: async start => {
				starts.push(start);
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(() => release, fn => { release = fn; });
			},
		}));
		const seen: NormalizedClaudeEvent[] = [];
		const done = (async () => {
			for await (const event of runner.start({ sessionId: 's', prompt: 'hi', cwd: tmpdir() })) {
				seen.push(event);
			}
		})();
		await waitFor(() => seen.some(event => event.type === 'session.started'));
		const options = starts[0].options;
		const screen = await options.screenTool('AskUserQuestion', INPUT, 'tool-1');
		const pending = options.canUseTool('AskUserQuestion', INPUT, { signal: new AbortController().signal, toolUseID: 'tool-1' });
		await waitFor(() => bridge.hasPending('s'));
		bridge.resolve('s', 'tool-1', { action: 'accept', content: { [LAYOUT]: 'Tabs', [CHECKS]: ['Lint', 'Unit tests'] } });
		const answer = await pending;
		runner.disposeSession('s');
		release?.();
		await done;
		assert.deepStrictEqual({
			screen,
			answer,
			events: seen.filter(event => event.type.startsWith('elicitation.')).map(event => event.type),
		}, {
			screen: { decision: 'ask' },
			answer: {
				behavior: 'allow',
				updatedInput: { ...INPUT, answers: { [LAYOUT]: 'Tabs', [CHECKS]: 'Lint, Unit tests' }, annotations: { [LAYOUT]: { preview: '[General] [Editor]' } } },
			},
			events: ['elicitation.requested', 'elicitation.resolved'],
		});
	});
});

function idleQuery(getRelease: () => (() => void) | undefined, setRelease: (release: () => void) => void): ClaudeQuery {
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: 'system', subtype: 'init', slash_commands: [], skills: [], session_id: 'sdk-session' };
			await new Promise<void>(resolve => setRelease(resolve));
		},
		interrupt: async () => getRelease()?.(),
		setModel: async () => undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => getRelease()?.(),
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > 5000) {
			assert.fail('condition was not met');
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}
