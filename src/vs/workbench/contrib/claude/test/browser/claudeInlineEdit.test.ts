/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { KeyCodeChord } from '../../../../../base/common/keybindings.js';
import { URI } from '../../../../../base/common/uri.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditor, IViewZone, IViewZoneChangeAccessor } from '../../../../../editor/browser/editorBrowser.js';
import { IRange, Range } from '../../../../../editor/common/core/range.js';
import { EndOfLinePreference, IModelDeltaDecoration, ITextModel } from '../../../../../editor/common/model.js';
import { TestConfiguration } from '../../../../../editor/test/browser/config/testConfiguration.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { ClaudeModelInfo, IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { ContextAttachment } from '../../../../../platform/claude/common/claudeContext.js';
import { ClaudeSideQuestionRequest, ClaudeSideQuestionResult } from '../../../../../platform/claude/common/claudeSideQuestion.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CLAUDE_INLINE_EDIT_MODEL_SETTING, CLAUDE_INLINE_REJECT_ON_ESCAPE_SETTING, CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContext, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { ClaudeAcceptedSpan, ClaudeAttributionSource, ClaudeFileAttribution, hashAttributionLines, IClaudeAttributionService, recordKeptHunks } from '../../../../services/claude/common/claudeAttribution.js';
import { IClaudeInlineEditService, InlineEditOutcome, InlineEditRunRequest, acceptInlineEdit } from '../../../../services/claude/common/claudeInlineEdit.js';
import { collectReviewHunks, IClaudeReviewService } from '../../../../services/claude/common/claudeReview.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { CLAUDE_AGENT_VIEW_ID, CLAUDE_INLINE_EDIT_COMMAND_ID } from '../../common/claudeViews.js';
import { ClaudeChatWidget } from '../../browser/chat/claudeChatWidget.js';
import { ClaudeModelControls } from '../../browser/chat/claudeModelMenu.js';
import { ClaudeAgentViewPane } from '../../browser/chat/claudeViewPane.js';
import { ClaudeInlineAnswer, ClaudeInlineAnswerActions, claudeInlineAnswerDraft, claudeInlineQuestionRequest } from '../../browser/inline/claudeInlineAsk.js';
import { ClaudeInlineController, ClaudeInlineWidget, registerClaudeInlineContributions } from '../../browser/inline/claudeInlineController.js';
import { ClaudeInlineDiff } from '../../browser/inline/claudeInlineDiff.js';

suite('Claude inline edit widget', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	if (!CommandsRegistry.getCommand('klawly.inlineEdit.reject')) {
		registerClaudeInlineContributions();
	}

	test('the prompt opens over the selection and Enter submits', async () => {
		const { editor, zones } = fakeEditor();
		const widget = disposables.add(new ClaudeInlineWidget(editor, { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 8 }, agent(), views(), keybindings(), ...modelServices().services));
		const prompt = widget.prompt();
		assert.strictEqual(zones.length, 1);
		const root = zones[0].zone.domNode.querySelector('.claude-inline')!;
		assert.strictEqual(root.getAttribute('role'), 'dialog');
		assert.strictEqual(root.getAttribute('aria-label'), 'Edit selection');
		const field = root.getElementsByTagName('textarea')[0];
		field.value = 'make this async';
		field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		assert.strictEqual(await prompt, 'make this async');
	});

	test('Alt+Enter asks about the selection and answers in the card without editing (issue 491)', async () => {
		const text = 'export function add(a: number, b: number) {\n\treturn a + b;\n}\n';
		const model = disposables.add(createTextModel(text, null, undefined, URI.file('C:/repo/src/add.ts')));
		const { editor, zones } = fakeEditor(model);
		const asked: ClaudeSideQuestionRequest[] = [];
		const sent: AgentHandoffs = { drafts: [], attachments: [] };
		const fakes = modelServices([], async request => {
			asked.push(request);
			return { kind: 'answer', text: 'It returns `a + b`.' };
		});
		disposables.add(new ClaudeInlineWidget(editor, { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 2 }, agent(sent), views(), keybindings(), ...fakes.services));
		const host = zones[0].zone.domNode;
		mainWindow.document.body.appendChild(host);
		disposables.add({ dispose: () => host.remove() });
		const field = host.getElementsByTagName('textarea')[0];
		field.value = 'what does this return?';
		const key = new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true });
		field.dispatchEvent(key);
		await timeout(0);
		const answer = host.querySelector<HTMLElement>('.claude-inline-answer')!;
		const shown = { answer: answer.querySelector('.claude-inline-answer-body')?.textContent?.trim(), buttons: buttons(answer), taken: key.defaultPrevented, height: (zones[0].zone.heightInPx ?? 0) > 72 };
		findButton(zones, 'Send to Agent')!.click();
		await timeout(0);
		assert.deepStrictEqual({ asked: asked.map(request => ({ question: request.question, cwd: request.cwd, claudeSessionId: request.claudeSessionId, selection: request.selection })), shown, draft: sent.drafts, text: model.getValue(EndOfLinePreference.LF) }, {
			asked: [{
				question: 'what does this return?',
				cwd: URI.file('C:/repo').fsPath,
				claudeSessionId: undefined,
				selection: { path: 'src/add.ts', languageId: 'plaintext', startLine: 1, endLine: 3, text: text.replace(/\n$/, '') },
			}],
			shown: { answer: 'It returns a + b.', buttons: ['Copy', 'Send to Agent', 'Edit Instead'], taken: true, height: true },
			draft: ['what does this return?\n\n> It returns `a + b`.\n\n'],
			// Asking never edits the file.
			text,
		});
	});

	test('a question about a bare cursor sends its line, and needs a folder to run in (issue 491)', () => {
		const text = 'one\ntwo\nthree\n';
		const input = { question: ' why? ', path: 'a.ts', languageId: 'typescript', text, range: { startLineNumber: 2, startColumn: 2, endLineNumber: 2, endColumn: 2 }, workspaceFolders: [] };
		assert.deepStrictEqual({
			cursor: claudeInlineQuestionRequest('q1', { ...input, cwd: 'C:/repo' }),
			noFolder: claudeInlineQuestionRequest('q2', { ...input, cwd: undefined }),
			noQuestion: claudeInlineQuestionRequest('q3', { ...input, question: '  ', cwd: 'C:/repo' }),
			draft: claudeInlineAnswerDraft(' why? ', 'Because.'),
		}, {
			cursor: { id: 'q1', question: 'why?', cwd: 'C:/repo', workspaceFolders: ['C:/repo'], model: undefined, selection: { path: 'a.ts', languageId: 'typescript', startLine: 2, endLine: 2, text: 'two' } },
			noFolder: undefined,
			noQuestion: undefined,
			draft: 'why?\n\n> Because.\n\n',
		});
	});

	test('the footer names the resolved model and its chevron opens the model menu', async () => {
		const { editor, zones } = fakeEditor();
		const models: ClaudeModelInfo[] = [
			{ id: 'default', displayName: 'Default (recommended)', source: 'runtime', resolvedModel: 'claude-sonnet-5-5' },
			{ id: 'opus', displayName: 'Opus', source: 'runtime', resolvedModel: 'claude-opus-5-5' },
			{ id: 'sonnet', displayName: 'Sonnet', source: 'runtime', resolvedModel: 'claude-sonnet-5-5' },
		];
		const fakes = modelServices(models);
		disposables.add(new ClaudeInlineWidget(editor, null, agent(), views(), keybindings(), ...fakes.services));
		const button = zones[0].zone.domNode.querySelector<HTMLButtonElement>('.claude-inline-model')!;
		const before = button.style.display;
		await timeout(0);
		const named = { label: button.querySelector('.label')?.textContent, chevron: !!button.querySelector('.codicon-chevron-down'), aria: button.getAttribute('aria-label') };
		button.click();
		await timeout(0);
		const shown = fakes.shown[0];
		shown.pickModel('opus');
		await timeout(0);
		assert.deepStrictEqual({ before, named, currentId: shown.currentId, models: shown.models.map(model => model.id), picked: fakes.updates, after: button.querySelector('.label')?.textContent }, {
			// Nothing is named until Claude Code reports its models.
			before: 'none',
			named: { label: 'Sonnet 5.5', chevron: true, aria: 'Model: Sonnet 5.5' },
			currentId: 'claude-sonnet-5-5',
			models: ['opus', 'sonnet'],
			picked: [[CLAUDE_INLINE_EDIT_MODEL_SETTING, 'opus']],
			after: 'Opus 5.5',
		});
	});

	test('the card starts at the text column whatever the indent, then holds Reject and Accept above the diff', async () => {
		const original = ['class Cart {', '\t\ttotal() {', '\t\treturn 1;', '\t}', '}', ''].join('\n');
		const modified = original.replace('return 1', 'return 2');
		const uri = URI.file('C:/repo/src/cart.ts');
		const model = disposables.add(createTextModel(original, null, undefined, uri));
		const hunks = collectReviewHunks(uri, original, modified);
		const { controller, zones, editor } = mount(disposables, model, async () => ({ kind: 'inline', sessionId: 'session', turnId: 'turn', original, modified, hunks }));
		editor.getSelection = () => ({ startLineNumber: 2, startColumn: 3, endLineNumber: 3, endColumn: 12 }) as never;
		const pending = controller.start();
		const host = zones[0].zone.domNode;
		// Attached so the stylesheet decides what is shown, not only the hidden attribute.
		mainWindow.document.body.appendChild(host);
		disposables.add({ dispose: () => host.remove() });
		const prompt = { indent: host.style.paddingLeft, height: zones[0].zone.heightInPx, buttons: buttons(host) };
		typeInstruction(zones, 'return two');
		await pending;
		const card = host.querySelector<HTMLElement>('.claude-inline')!;
		const result = {
			label: card.getAttribute('aria-label'),
			title: card.querySelector('.claude-inline-title')?.textContent,
			accept: card.querySelector('.claude-inline-head .is-keep')?.textContent,
			height: zones[0].zone.heightInPx,
			buttons: buttons(card),
			diffToolbars: zones.filter(entry => entry.zone.domNode.classList.contains('claude-hunk-actions')).length,
			active: controller.active,
		};
		findButton(zones, 'Accept')!.click();
		assert.deepStrictEqual({ prompt, result, after: { zones: zones.length, active: controller.active, text: model.getValue(EndOfLinePreference.LF) } }, {
			// The first selected line is indented two tabs; the card still starts at the text column.
			prompt: { indent: '', height: 72, buttons: ['Close (Escape)', 'AskAltEnter', 'Send to Agent', 'Submit'] },
			result: { label: 'Review inline edit', title: 'Editing cart.ts', accept: 'AcceptCtrlEnter', height: 96, buttons: ['RejectEscape', 'AcceptCtrlEnter', 'Send to Agent', 'Submit'], diffToolbars: 0, active: true },
			after: { zones: 0, active: false, text: modified },
		});
	});

	test('inline diff shows removed lines, accept keeps the edit, and undo restores it', () => {
		const original = 'function applyCoupon(code: string) {\n  return 1;\n}\n';
		const modified = 'async function applyCoupon(code: string) {\n  return 1;\n}\n';
		const uri = URI.file('C:/repo/src/cart.ts');
		const model = disposables.add(createTextModel(original, null, undefined, uri));
		replaceAll(model, modified);
		const { editor, zones, decorations } = fakeEditor(model);
		const diff = disposables.add(new ClaudeInlineDiff(editor));
		const hunks = collectReviewHunks(uri, original, modified);
		let accepted = false;
		diff.show(original, modified, hunks, { onAccept: () => { accepted = true; }, onReject: () => undefined, onConflict: () => undefined });
		const deleted = zones.find(entry => entry.zone.domNode.classList.contains('claude-inline-deleted'))?.zone;
		// Full-size editor rows: the removed text as the editor renders it, and a minus for each row in the gutter.
		assert.deepStrictEqual({
			text: deleted?.domNode.textContent?.replace(/\u00a0/g, ' '),
			rows: deleted?.domNode.querySelectorAll('.view-line').length,
			signs: deleted?.marginDomNode?.textContent,
			lines: deleted?.heightInLines,
		}, { text: 'function applyCoupon(code: string) {', rows: 1, signs: '\u2212', lines: 1 });
		assert.ok(decorations().some(decoration => decoration.options.marginClassName === 'claude-inline-inserted-margin'));
		assert.ok(decorations().some(decoration => decoration.options.className?.includes('claude-inline-inserted')));
		const accept = findButton(zones, 'Accept');
		assert.ok(accept);
		accept!.click();
		assert.strictEqual(accepted, true);
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), modified);
		acceptInlineEdit(model);
		void model.undo();
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), original);
	});

	test('the inserted highlight and toolbar end at the last changed line, not the line after it', () => {
		const original = 'function total() {\n  return 1;\n}\n\nfunction tax() {\n  return 0;\n}';
		const modified = 'function total() {\n  const sum = 1;\n  return sum;\n}\n\nfunction tax() {\n  return 0.2;\n}';
		const uri = URI.file('C:/repo/src/cart.ts');
		const model = disposables.add(createTextModel(modified, null, undefined, uri));
		const { editor, zones, decorations } = fakeEditor(model);
		const diff = disposables.add(new ClaudeInlineDiff(editor));
		diff.show(original, modified, collectReviewHunks(uri, original, modified), { onAccept: () => undefined, onReject: () => undefined, onConflict: () => undefined });
		const lines = (range: IRange) => Array.from({ length: range.endLineNumber - range.startLineNumber + 1 }, (_, index) => model.getLineContent(range.startLineNumber + index));
		assert.deepStrictEqual({
			highlighted: decorations().map(decoration => lines(decoration.range)),
			toolbarAfter: zones.filter(entry => entry.zone.domNode.classList.contains('claude-hunk-actions')).map(entry => model.getLineContent(entry.zone.afterLineNumber)),
		}, {
			highlighted: [['  const sum = 1;', '  return sum;'], ['  return 0.2;']],
			toolbarAfter: ['  return 0.2;'],
		});
	});

	test('hunk navigation moves between separated regions', () => {
		const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`);
		const original = lines.join('\n');
		const modified = original.replace('line 0', 'LINE 0').replace('line 19', 'LINE 19');
		const uri = URI.file('C:/repo/src/cart.ts');
		const model = disposables.add(createTextModel(modified, null, undefined, uri));
		const revealed: number[] = [];
		const { editor } = fakeEditor(model, line => revealed.push(line));
		const diff = disposables.add(new ClaudeInlineDiff(editor));
		const hunks = collectReviewHunks(uri, original, modified);
		assert.ok(hunks.length > 1);
		diff.show(original, modified, hunks, { onAccept: () => undefined, onReject: () => undefined, onConflict: () => undefined });
		const first = revealed[revealed.length - 1];
		diff.next();
		const second = revealed[revealed.length - 1];
		assert.notStrictEqual(second, first);
		diff.previous();
		assert.strictEqual(revealed[revealed.length - 1], first);
	});

	test('the hand-off banner names the warning and opens review', () => {
		const { editor, zones } = fakeEditor();
		const diff = disposables.add(new ClaudeInlineDiff(editor));
		let opened = false;
		diff.showHandoff('This edit also changed 1 other file', 'Moved to the full review so nothing changes without you seeing it.', () => { opened = true; });
		const text = zones.map(entry => entry.zone.domNode.textContent ?? '').join('\n');
		assert.ok(text.includes('1 other file'), text);
		assert.ok(text.includes('Open review'), text);
		findButton(zones, 'Open review')!.click();
		assert.strictEqual(opened, true);
	});

	test('the controller runs an edit, shows the diff, accepts, and undo restores it', async () => {
		const original = 'function applyCoupon(code: string) {\n  return 1;\n}\n';
		const modified = 'async function applyCoupon(code: string) {\n  return 1;\n}\n';
		const uri = URI.file('C:/repo/src/cart.ts');
		const model = disposables.add(createTextModel(original, null, undefined, uri));
		const hunks = collectReviewHunks(uri, original, modified);
		let seen: InlineEditRunRequest | undefined;
		const { controller, zones } = mount(disposables, model, async request => {
			seen = request;
			assert.strictEqual(typeof request.waitForText, 'function');
			return { kind: 'inline', sessionId: 'session', turnId: 'turn', original, modified, hunks };
		});
		const pending = controller.start();
		typeInstruction(zones, 'make this async');
		await pending;
		assert.strictEqual(seen?.instruction, 'make this async');
		assert.ok(seen?.checkpointPath);
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), modified);
		assert.ok(zones.some(entry => (entry.zone.domNode.textContent ?? '').replace(/\u00a0/g, ' ').includes('function applyCoupon')));
		findButton(zones, 'Accept')!.click();
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), modified);
		void model.undo();
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), original);
	});

	test('accepting an inline edit attributes the lines it wrote, and lines typed during the review stay the user\'s', async () => {
		const original = 'function applyCoupon(code: string) {\n  return 1;\n}\n';
		const modified = 'async function applyCoupon(code: string) {\n  const off = 1;\n  return off;\n}\n';
		const uri = URI.file('C:/repo/src/cart.ts');
		const owners = async (typed: boolean) => {
			const model = disposables.add(createTextModel(original, null, undefined, uri));
			const hunks = collectReviewHunks(uri, original, modified);
			let record: ClaudeFileAttribution | undefined;
			const attribution = {
				recordAccepted: (_uri: URI, source: ClaudeAttributionSource, lines: readonly string[], spans: readonly ClaudeAcceptedSpan[]) => {
					record = recordKeptHunks(undefined, hashAttributionLines(lines), spans.map(span => ({ ...span, key: '', source })), 0);
				},
			} as unknown as IClaudeAttributionService;
			const { controller, zones } = mount(disposables, model, async () => ({ kind: 'inline', sessionId: 'session', turnId: 'turn', original, modified, hunks }), [], [], [], [], async () => undefined, undefined, undefined, attribution);
			const pending = controller.start();
			typeInstruction(zones, 'make this async');
			await pending;
			if (typed) {
				model.applyEdits([{ range: new Range(3, 1, 3, 1), text: '  // checked\n' }]);
			}
			controller.accept();
			return record && { origin: record.sources.map(source => source.origin), owners: record.owners };
		};
		assert.deepStrictEqual({ untouched: await owners(false), typed: await owners(true) }, {
			untouched: { origin: ['inline'], owners: [0, 0, 0, -1, -1] },
			typed: { origin: ['inline'], owners: [0, 0, -2, 0, -1, -1] },
		});
	});

	test('the Reject button restores the buffer and saves it', async () => {
		const original = 'function applyCoupon(code: string) {\n  return 1;\n}\n';
		const modified = 'async function applyCoupon(code: string) {\n  return 1;\n}\n';
		const uri = URI.file('C:/repo/src/cart.ts');
		const model = disposables.add(createTextModel(original, null, undefined, uri));
		const hunks = collectReviewHunks(uri, original, modified);
		const saved: URI[] = [];
		const { controller, zones } = mount(disposables, model, async () => ({ kind: 'inline', sessionId: 'session', turnId: 'turn', original, modified, hunks }), [], saved);
		const pending = controller.start();
		typeInstruction(zones, 'make this async');
		await pending;
		findButton(zones, 'Reject')!.click();
		await Promise.resolve();
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), original);
		assert.strictEqual(saved.length, 1);
		assert.strictEqual(saved[0].toString(), uri.toString());
		void model.undo();
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), modified);
	});

	test('Ctrl/Cmd+K and Ctrl/Cmd+Alt+K start an inline edit in a notebook cell editor', () => {
		const bindings = KeybindingsRegistry.getDefaultKeybindings().filter(item => item.command === CLAUDE_INLINE_EDIT_COMMAND_ID && item.when?.keys().includes('editorTextFocus'));
		const chord = (item: typeof bindings[number]) => item.keybinding?.chords[0];
		const klawlyKey = bindings.find(item => chord(item) instanceof KeyCodeChord && !(chord(item) as KeyCodeChord).altKey);
		const defaultKey = bindings.find(item => chord(item) instanceof KeyCodeChord && (chord(item) as KeyCodeChord).altKey);
		assert.ok(klawlyKey?.when && defaultKey?.when);
		// The keys a focused cell editor sets: it is a code editor with text focus inside the notebook.
		const cell = { editorTextFocus: true, editorFocus: true, textInputFocus: true, inputFocus: true, notebookEditorFocused: true, notebookCellEditorFocused: true, 'claude.agentDisabled': false };
		const klawlyKeys = `config.${CLAUDE_KEYBINDINGS_KLAWLY_KEYS_SETTING}`;
		assert.strictEqual(klawlyKey!.when!.evaluate(context({ ...cell, [klawlyKeys]: true })), true);
		assert.strictEqual(defaultKey!.when!.evaluate(context({ ...cell, [klawlyKeys]: false })), true);
		assert.strictEqual(klawlyKey!.when!.evaluate(context({ ...cell, [klawlyKeys]: true, 'claude.agentDisabled': true })), false);
	});

	test('Escape rejects when the setting is on, and a conflict releases Escape', async () => {
		const binding = KeybindingsRegistry.getDefaultKeybindings().find(item => item.command === 'klawly.inlineEdit.reject');
		assert.ok(binding?.when);
		const chord = binding!.keybinding?.chords[0];
		assert.ok(chord instanceof KeyCodeChord);
		assert.strictEqual(chord.keyCode, KeyCode.Escape);
		const reviewing = 'klawly.inlineEdit.reviewing';
		const setting = `config.${CLAUDE_INLINE_REJECT_ON_ESCAPE_SETTING}`;
		assert.strictEqual(binding!.when!.evaluate(context({ [reviewing]: true, [setting]: true })), true);
		assert.strictEqual(binding!.when!.evaluate(context({ [reviewing]: true, [setting]: false })), false);

		const original = 'function applyCoupon(code: string) {\n  return 1;\n}\n';
		const modified = 'async function applyCoupon(code: string) {\n  return 1;\n}\n';
		const uri = URI.file('C:/repo/src/cart.ts');
		const model = disposables.add(createTextModel(original, null, undefined, uri));
		const hunks = collectReviewHunks(uri, original, modified);
		const saved: URI[] = [];
		const { controller, keys, zones } = mount(disposables, model, async () => ({ kind: 'inline', sessionId: 'session', turnId: 'turn', original, modified, hunks }), [], saved);
		const pending = controller.start();
		typeInstruction(zones, 'make this async');
		await pending;
		assert.strictEqual(keys.get(reviewing), true);
		await invoke('klawly.inlineEdit.reject');
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), original);
		assert.strictEqual(saved.length, 1);
		assert.strictEqual(keys.get(reviewing), false);

		const drifted = disposables.add(createTextModel(original, null, undefined, URI.file('C:/repo/src/other.ts')));
		const warnings: string[] = [];
		const conflict = mount(disposables, drifted, async () => ({ kind: 'inline', sessionId: 'session-2', turnId: 'turn-2', original, modified, hunks }), warnings, []);
		const again = conflict.controller.start();
		typeInstruction(conflict.zones, 'make this async');
		await again;
		drifted.setValue('mine\n');
		await invoke('klawly.inlineEdit.reject');
		assert.strictEqual(drifted.getValue(EndOfLinePreference.LF), 'mine\n');
		assert.strictEqual(conflict.keys.get(reviewing), false);
		assert.ok(warnings.some(message => message.includes('changed')));
		assert.strictEqual(binding!.when!.evaluate(context({ [reviewing]: conflict.keys.get(reviewing) === true, [setting]: true })), false);
	});

	test('a multi-file edit shows the hand-off and opens review', async () => {
		const model = disposables.add(createTextModel('function apply() {\n}\n', null, undefined, URI.file('C:/repo/src/cart.ts')));
		const opened: string[] = [];
		const focused: string[] = [];
		const { controller, zones } = mount(disposables, model, async () => ({
			kind: 'review',
			sessionId: 'session',
			turnId: 'turn',
			warning: 'This edit also changed 1 other file',
			detail: 'Moved to the full review so nothing changes without you seeing it.',
			otherFiles: 1,
		}), [], [], opened, focused);
		const pending = controller.start();
		typeInstruction(zones, 'make this async');
		await pending;
		const text = zones.map(entry => entry.zone.domNode.textContent ?? '').join('\n');
		assert.ok(text.includes('1 other file'), text);
		assert.ok(text.includes('Open review'), text);
		assert.deepStrictEqual(opened, [CLAUDE_AGENT_VIEW_ID]);
		assert.deepStrictEqual(focused, ['session', 'turn']);
	});

	test('an unreadable edit warns with the path and does not open review', async () => {
		const model = disposables.add(createTextModel('function apply() {\n}\n', null, undefined, URI.file('C:/repo/src/cart.ts')));
		const notes: string[] = [];
		const opened: string[] = [];
		const { controller, zones } = mount(disposables, model, async () => ({
			kind: 'warning',
			message: 'Could not read the changed file to review it: missing.ts',
		}), notes, [], opened);
		const pending = controller.start();
		typeInstruction(zones, 'make this async');
		await pending;
		assert.deepStrictEqual(opened, []);
		assert.ok(notes.some(message => message.includes('missing.ts')));
	});

	test('dismiss and dispose cancel a running edit', async () => {
		const model = disposables.add(createTextModel('function apply() {\n}\n', null, undefined, URI.file('C:/repo/src/cart.ts')));
		let release: ((outcome: InlineEditOutcome) => void) | undefined;
		let cancelled = 0;
		const inline = async () => new Promise<InlineEditOutcome>(resolve => { release = resolve; });
		const cancel = async () => {
			cancelled++;
			release?.({ kind: 'cancelled' });
		};
		const first = mount(disposables, model, inline, [], [], [], [], cancel);
		const pending = first.controller.start();
		typeInstruction(first.zones, 'make this async');
		await Promise.resolve();
		assert.strictEqual(typeof release, 'function');
		first.changeModel();
		assert.strictEqual(cancelled, 1);
		await pending;

		const secondModel = disposables.add(createTextModel('function apply() {\n}\n', null, undefined, URI.file('C:/repo/src/other.ts')));
		release = undefined;
		const second = mount(disposables, secondModel, inline, [], [], [], [], cancel);
		const again = second.controller.start();
		typeInstruction(second.zones, 'make this async');
		await Promise.resolve();
		second.controller.dispose();
		assert.strictEqual(cancelled, 2);
		await again;
	});

	test('a failed save keeps the diff so Reject can retry', async () => {
		const original = 'function applyCoupon(code: string) {\n  return 1;\n}\n';
		const modified = 'async function applyCoupon(code: string) {\n  return 1;\n}\n';
		const uri = URI.file('C:/repo/src/cart.ts');
		const model = disposables.add(createTextModel(original, null, undefined, uri));
		const hunks = collectReviewHunks(uri, original, modified);
		const notes: string[] = [];
		const saved: URI[] = [];
		let failSave = true;
		const { controller, zones, keys } = mount(disposables, model, async () => ({ kind: 'inline', sessionId: 'session', turnId: 'turn', original, modified, hunks }), notes, saved, [], [], async () => undefined, {
			save: async resource => {
				saved.push(resource);
				if (failSave) {
					throw new Error('disk full');
				}
				return resource;
			},
		});
		const pending = controller.start();
		typeInstruction(zones, 'make this async');
		await pending;
		assert.strictEqual(keys.get('klawly.inlineEdit.reviewing'), true);
		await invoke('klawly.inlineEdit.reject');
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), original);
		assert.strictEqual(saved.length, 1);
		assert.ok(notes.some(message => message.includes('disk full')));
		assert.strictEqual(keys.get('klawly.inlineEdit.reviewing'), true);
		assert.ok(findButton(zones, 'Reject'));
		failSave = false;
		findButton(zones, 'Reject')!.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), original);
		assert.strictEqual(saved.length, 2);
		assert.strictEqual(keys.get('klawly.inlineEdit.reviewing'), false);
		assert.strictEqual(findButton(zones, 'Reject'), undefined);
		void model.undo();
		assert.strictEqual(model.getValue(EndOfLinePreference.LF), modified);
	});

	test('unsaved edits are saved before the edit and a drifted buffer is kept', async () => {
		const original = 'function apply() {\n}\n';
		const modified = 'async function apply() {\n}\n';
		const hunks = collectReviewHunks(URI.file('C:/repo/src/cart.ts'), original, modified);
		const notes: string[] = [];
		const refused = disposables.add(createTextModel(original, null, undefined, URI.file('C:/repo/src/cart.ts')));
		let ran = false;
		const refusedMount = mount(disposables, refused, async () => {
			ran = true;
			return { kind: 'inline', sessionId: 'session', turnId: 'turn', original, modified, hunks };
		}, notes, [], [], [], async () => undefined, {
			isDirty: () => true,
			save: async () => undefined,
		});
		const refusedRun = refusedMount.controller.start();
		typeInstruction(refusedMount.zones, 'make this async');
		await refusedRun;
		assert.strictEqual(ran, false);
		assert.ok(notes.some(message => message.includes('Save this file')));
		assert.strictEqual(refused.getValue(EndOfLinePreference.LF), original);

		const drifted = disposables.add(createTextModel(original, null, undefined, URI.file('C:/repo/src/other.ts')));
		const saved: URI[] = [];
		let dirty = true;
		const driftMount = mount(disposables, drifted, async request => {
			assert.strictEqual(request.text, original);
			assert.ok(saved.some(item => item.toString() === drifted.uri.toString()));
			drifted.setValue('typed during edit\n');
			return { kind: 'inline', sessionId: 'session-2', turnId: 'turn-2', original, modified, hunks };
		}, [], saved, [], [], async () => undefined, {
			isDirty: () => dirty,
			save: async resource => {
				saved.push(resource);
				dirty = false;
				return resource;
			},
		});
		const driftRun = driftMount.controller.start();
		typeInstruction(driftMount.zones, 'make this async');
		await driftRun;
		assert.strictEqual(saved.length, 1);
		assert.strictEqual(drifted.getValue(EndOfLinePreference.LF), 'typed during edit\n');

		const applied = disposables.add(createTextModel(original, null, undefined, URI.file('C:/repo/src/third.ts')));
		const appliedSaved: URI[] = [];
		let appliedDirty = true;
		const appliedMount = mount(disposables, applied, async () => ({ kind: 'inline', sessionId: 'session-3', turnId: 'turn-3', original, modified, hunks }), [], appliedSaved, [], [], async () => undefined, {
			isDirty: () => appliedDirty,
			save: async resource => {
				appliedSaved.push(resource);
				appliedDirty = false;
				return resource;
			},
		});
		const appliedRun = appliedMount.controller.start();
		typeInstruction(appliedMount.zones, 'make this async');
		await appliedRun;
		assert.strictEqual(appliedSaved.length, 1);
		assert.strictEqual(applied.getValue(EndOfLinePreference.LF), modified);
	});

	test('a follow-up edits the changed lines, and Reject goes back to before the first edit', async () => {
		const original = 'function applyCoupon(code: string) {\n  return 1;\n}\n';
		const first = 'async function applyCoupon(code: string) {\n  return 1;\n}\n';
		const second = 'async function applyCoupon(code: string): Promise<number> {\n  return 1;\n}\n';
		const uri = URI.file('C:/repo/src/cart.ts');
		const model = disposables.add(createTextModel(original, null, undefined, uri));
		const seen: InlineEditRunRequest[] = [];
		const { controller, zones } = mount(disposables, model, async request => {
			seen.push(request);
			const [before, after] = seen.length === 1 ? [original, first] : [first, second];
			return { kind: 'inline', sessionId: 'session', turnId: `turn-${seen.length}`, original: before, modified: after, hunks: collectReviewHunks(uri, before, after) };
		});
		const pending = controller.start();
		typeInstruction(zones, 'make this async');
		await pending;
		const field = findField(zones)!;
		const ready = { value: field.value, placeholder: field.placeholder, label: field.getAttribute('aria-label'), readOnly: field.readOnly };
		// Ctrl+Enter is Accept, so it does not send the follow-up.
		field.value = 'add a return type';
		field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
		const afterCtrlEnter = seen.length;
		typeInstruction(zones, 'add a return type');
		await timeout(0);
		const card = zones[0].zone.domNode.querySelector<HTMLElement>('.claude-inline')!;
		const result = {
			title: card.querySelector('.claude-inline-title')?.textContent,
			field: findField(zones)?.value,
			height: zones[0].zone.heightInPx,
			text: model.getValue(EndOfLinePreference.LF),
			active: controller.active,
		};
		findButton(zones, 'Reject')!.click();
		await timeout(0);
		assert.deepStrictEqual({
			ready,
			afterCtrlEnter,
			sent: seen.map(request => ({ instruction: request.instruction, text: request.text, lines: [request.selection.startLine, request.selection.endLine] })),
			result,
			rejected: { text: model.getValue(EndOfLinePreference.LF), active: controller.active },
		}, {
			ready: { value: '', placeholder: 'Ask for a change on top of this edit', label: 'Follow-up instruction', readOnly: false },
			afterCtrlEnter: 1,
			sent: [
				{ instruction: 'make this async', text: original, lines: [1, 1] },
				{ instruction: 'Already applied: make this async\nNow: add a return type', text: first, lines: [1, 1] },
			],
			result: { title: 'Editing cart.ts', field: '', height: 96, text: second, active: true },
			rejected: { text: original, active: false },
		});
	});

	test('a follow-up that changes nothing puts the first review back', async () => {
		const original = 'function applyCoupon(code: string) {\n  return 1;\n}\n';
		const first = 'async function applyCoupon(code: string) {\n  return 1;\n}\n';
		const uri = URI.file('C:/repo/src/cart.ts');
		const model = disposables.add(createTextModel(original, null, undefined, uri));
		const notes: string[] = [];
		let runs = 0;
		const { controller, zones } = mount(disposables, model, async () => {
			runs++;
			return runs === 1
				? { kind: 'inline', sessionId: 'session', turnId: 'turn-1', original, modified: first, hunks: collectReviewHunks(uri, original, first) }
				: { kind: 'unchanged' };
		}, notes);
		const pending = controller.start();
		typeInstruction(zones, 'make this async');
		await pending;
		await controller.followUp('rename it');
		const card = zones[0].zone.domNode.querySelector<HTMLElement>('.claude-inline')!;
		const state = { title: card.querySelector('.claude-inline-title')?.textContent, active: controller.active, notes: notes.length };
		findButton(zones, 'Reject')!.click();
		await timeout(0);
		assert.deepStrictEqual({ state, text: model.getValue(EndOfLinePreference.LF) }, {
			state: { title: 'Editing cart.ts', active: true, notes: 1 },
			text: original,
		});
	});

	test('Send to Agent in the result card hands the edit to the Agent with or without a follow-up, and keeps it under review', async () => {
		const original = 'function applyCoupon(code: string) {\n  return 1;\n}\n';
		const first = 'async function applyCoupon(code: string) {\n  return 1;\n}\n';
		const uri = URI.file('C:/repo/src/cart.ts');
		const model = disposables.add(createTextModel(original, null, undefined, uri));
		const opened: string[] = [];
		const sent: AgentHandoffs = { drafts: [], attachments: [] };
		const { controller, zones } = mount(disposables, model, async () => ({ kind: 'inline', sessionId: 'session', turnId: 'turn', original, modified: first, hunks: collectReviewHunks(uri, original, first) }), [], [], opened, [], undefined, undefined, sent);
		const pending = controller.start();
		typeInstruction(zones, 'make this async');
		await pending;
		// An empty follow-up still moves the edit over (issue 341).
		findButton(zones, 'Send to Agent')!.click();
		await timeout(0);
		findField(zones)!.value = 'also add a test';
		findButton(zones, 'Send to Agent')!.click();
		await timeout(0);
		const edited: ContextAttachment = { kind: 'selection', uri: uri.toString(), range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 43 }, versionId: model.getVersionId() };
		assert.deepStrictEqual({ sent, opened, field: findField(zones)?.value, active: controller.active, text: model.getValue(EndOfLinePreference.LF) }, {
			sent: {
				// No composer shows the chat, so each hand-off goes after the saved draft.
				drafts: [
					'Inline edit in src/cart.ts, line 1, not accepted yet.\nAsked: make this async\n\n',
					'Inline edit in src/cart.ts, line 1, not accepted yet.\nAsked: make this async\n\nInline edit in src/cart.ts, line 1, not accepted yet.\nAsked: make this async\n\nalso add a test',
				],
				attachments: [[edited], [edited]],
				saved: sent.drafts[1],
			},
			opened: [CLAUDE_AGENT_VIEW_ID, CLAUDE_AGENT_VIEW_ID],
			field: '',
			active: true,
			text: first,
		});
	});

	test('Send to Agent in the prompt card hands the selection over even with an empty field', async () => {
		const uri = URI.file('C:/repo/src/cart.ts');
		const model = disposables.add(createTextModel('a\nb\nc\nconst total = 1;\n', null, undefined, uri));
		const { editor, zones } = fakeEditor(model);
		const opened: string[] = [];
		const sent: AgentHandoffs = { drafts: [], attachments: [] };
		const widget = disposables.add(new ClaudeInlineWidget(editor, { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 12 }, agent(sent), views(opened), keybindings(), ...modelServices().services));
		const prompt = widget.prompt();
		findButton(zones, 'Send to Agent')!.click();
		const asked = await prompt;
		await timeout(0);
		assert.deepStrictEqual({ asked, sent, opened }, {
			asked: undefined,
			sent: {
				drafts: [],
				attachments: [[{ kind: 'selection', uri: uri.toString(), range: { startLine: 4, startColumn: 1, endLine: 4, endColumn: 12 }, versionId: model.getVersionId() }]],
			},
			opened: [CLAUDE_AGENT_VIEW_ID],
		});
	});

	test('Send to Agent adds its text after what an open composer holds, and after the saved draft when no composer shows the chat', async () => {
		const uri = URI.file('C:/repo/src/cart.ts');
		const model = disposables.add(createTextModel('a\nb\nc\nconst total = 1;\n', null, undefined, uri));
		const selection = { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 12 };
		const send = async (chat: Pick<ClaudeChatWidget, 'appendDraft'>, sent: AgentHandoffs) => {
			const { editor, zones } = fakeEditor(model);
			const widget = disposables.add(new ClaudeInlineWidget(editor, selection, agent(sent), views(undefined, chat), keybindings(), ...modelServices().services));
			const prompt = widget.prompt();
			findField(zones)!.value = 'explain this';
			findButton(zones, 'Send to Agent')!.click();
			await prompt;
			await timeout(0);
		};
		const appended: string[][] = [];
		const open: AgentHandoffs = { drafts: [], attachments: [], saved: 'typed in the composer' };
		await send({ appendDraft: (sessionId, text) => appended.push([sessionId, text]) > 0 }, open);
		const elsewhere: AgentHandoffs = { drafts: [], attachments: [], saved: 'my notes' };
		await send({ appendDraft: () => false }, elsewhere);
		assert.deepStrictEqual({ appended, open: open.drafts, elsewhere: elsewhere.drafts }, {
			appended: [['session', 'explain this']],
			open: [],
			elsewhere: ['my notes\n\nexplain this'],
		});
	});

	test('a failed turn reports the error and a stopped turn stays quiet', async () => {
		const model = disposables.add(createTextModel('function apply() {\n}\n', null, undefined, URI.file('C:/repo/src/cart.ts')));
		const notes: string[] = [];
		const failed = mount(disposables, model, async () => ({ kind: 'failed', message: 'disk full' }), notes);
		const pending = failed.controller.start();
		typeInstruction(failed.zones, 'make this async');
		await pending;
		assert.ok(notes.some(message => message.includes('disk full')));

		const quiet: string[] = [];
		const stopped = mount(disposables, model, async () => ({ kind: 'cancelled' }), quiet);
		const again = stopped.controller.start();
		typeInstruction(stopped.zones, 'make this async');
		await again;
		assert.deepStrictEqual(quiet, []);
	});
});

function mount(
	store: { add<T extends { dispose(): void }>(value: T): T },
	model: ITextModel,
	run: (request: InlineEditRunRequest) => Promise<InlineEditOutcome>,
	notes: string[] = [],
	saved: URI[] = [],
	opened: string[] = [],
	focused: string[] = [],
	cancel: () => Promise<void> = async () => undefined,
	files?: { isDirty?: (resource: URI) => boolean; save?: (resource: URI) => Promise<URI | undefined> },
	sent?: AgentHandoffs,
	attribution?: IClaudeAttributionService,
): { controller: ClaudeInlineController; editor: ICodeEditor; zones: { id: string; zone: IViewZone }[]; keys: Map<string, unknown>; changeModel: () => void } {
	const { editor, zones, changeModel } = fakeEditor(model);
	const keys = new Map<string, unknown>();
	const contextKeys = {
		createKey: (key: string, defaultValue: unknown) => {
			keys.set(key, defaultValue);
			return {
				set: (value: unknown) => { keys.set(key, value); },
				reset: () => { keys.set(key, defaultValue); },
				get: () => keys.get(key),
			};
		},
	};
	const notifications = {
		error: (message: string) => { notes.push(String(message)); },
		warn: (message: string) => { notes.push(String(message)); },
		info: (message: string) => { notes.push(String(message)); },
	};
	const textFiles = {
		isDirty: (resource: URI) => files?.isDirty?.(resource) ?? false,
		save: async (resource: URI) => {
			if (files?.save) {
				return files.save(resource);
			}
			saved.push(resource);
			return resource;
		},
	};
	const review = {
		focus: (sessionId: string, turnId: string) => { focused.push(sessionId, turnId); },
		next: () => undefined,
	};
	const pane = views(opened);
	const inline = { run, cancel } as IClaudeInlineEditService;
	const controller = store.add(new ClaudeInlineController(
		editor,
		{ createInstance: (_ctor: unknown, codeEditor: ICodeEditor, selection: IRange | null) => new ClaudeInlineWidget(codeEditor, selection, agent(sent), pane, keybindings(), ...modelServices().services) } as never,
		inline,
		review as unknown as IClaudeReviewService,
		pane,
		{ getWorkspaceFolder: () => ({ uri: URI.file('C:/repo') }) } as unknown as IWorkspaceContextService,
		notifications as unknown as INotificationService,
		textFiles as unknown as ITextFileService,
		contextKeys as unknown as IContextKeyService,
		attribution ?? { recordAccepted: () => undefined } as unknown as IClaudeAttributionService,
	));
	return { controller, editor, zones, keys, changeModel };
}

function typeInstruction(zones: { zone: IViewZone }[], text: string): void {
	const field = findField(zones);
	assert.ok(field, 'inline prompt should be open');
	field.value = text;
	field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

function findField(zones: { zone: IViewZone }[]): HTMLTextAreaElement | undefined {
	for (const entry of zones) {
		const fields = entry.zone.domNode.getElementsByTagName('textarea');
		if (fields.length > 0) {
			return fields[0];
		}
	}
	return undefined;
}

async function invoke(id: string): Promise<void> {
	const command = CommandsRegistry.getCommand(id);
	assert.ok(command);
	await Promise.resolve(command.handler({} as ServicesAccessor));
}

function context(values: Record<string, boolean>): IContext {
	return { getValue: key => values[key] as never };
}

function fakeEditor(model?: ITextModel, reveal?: (line: number) => void): { editor: ICodeEditor; zones: { id: string; zone: IViewZone }[]; decorations: () => IModelDeltaDecoration[]; changeModel: () => void } {
	const zones: { id: string; zone: IViewZone }[] = [];
	let decorationList: IModelDeltaDecoration[] = [];
	let next = 0;
	let onModel: (() => void) | undefined;
	// The removed-lines zone renders with the editor's real computed options.
	const configuration = new TestConfiguration({});
	const options = configuration.options;
	configuration.dispose();
	const editor = {
		getModel: () => model ?? null,
		getDomNode: () => null,
		getSelection: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }),
		getPosition: () => ({ lineNumber: model?.getLineCount() ?? 1, column: 1 }),
		onDidChangeModel: (listener: () => void) => {
			onModel = listener;
			return { dispose: () => { if (onModel === listener) { onModel = undefined; } } };
		},
		getLayoutInfo: () => ({ contentWidth: 600 }),
		onDidLayoutChange: () => ({ dispose: () => undefined }),
		revealLine: (line: number) => reveal?.(line),
		focus: () => undefined,
		getOption: () => ({ spaceWidth: 8 }),
		getOptions: () => options,
		createDecorationsCollection: () => ({
			set: (nextDecorations: IModelDeltaDecoration[]) => { decorationList = nextDecorations; },
			clear: () => { decorationList = []; },
		}),
		changeViewZones: (callback: (accessor: IViewZoneChangeAccessor) => void) => {
			callback({
				addZone: zone => {
					const id = String(++next);
					zones.push({ id, zone });
					return id;
				},
				removeZone: id => {
					const index = zones.findIndex(entry => entry.id === id);
					if (index >= 0) {
						zones.splice(index, 1);
					}
				},
				layoutZone: () => undefined,
			});
		},
	};
	return { editor: editor as unknown as ICodeEditor, zones, decorations: () => decorationList, changeModel: () => onModel?.() };
}

/** What Send to Agent put in the Agent's composer, one entry per click; `saved` is the session's draft. */
interface AgentHandoffs {
	drafts: string[];
	attachments: (readonly ContextAttachment[])[];
	saved?: string;
}

function agent(sent?: AgentHandoffs): IClaudeAgentService {
	return {
		getCurrentSession: () => undefined,
		createSession: () => ({ id: 'session', attachments: [], draft: '' }),
		getSessions: () => [{ id: 'session', attachments: [], draft: sent?.saved ?? '' }],
		setDraft: (_sessionId: string, text: string) => {
			sent?.drafts.push(text);
			if (sent) {
				sent.saved = text;
			}
		},
		setAttachments: (_sessionId: string, attachments: readonly ContextAttachment[]) => { sent?.attachments.push(attachments); },
	} as unknown as IClaudeAgentService;
}

/** The model services the card's footer uses; the menu records what it was asked to show. */
function modelServices(models: readonly ClaudeModelInfo[] = [], askSideQuestion?: (request: ClaudeSideQuestionRequest) => Promise<ClaudeSideQuestionResult>) {
	const shown: ClaudeModelControls[] = [];
	const updates: [string, unknown][] = [];
	const values = new Map<string, unknown>();
	const runtime = { listModels: async () => models, askSideQuestion } as unknown as IClaudeRuntimeService;
	const configuration = {
		getValue: (key: string) => values.get(key),
		updateValue: async (key: string, value: unknown) => {
			updates.push([key, value]);
			values.set(key, value);
		},
	} as unknown as IConfigurationService;
	const menu = { isOpen: false, show: (_anchor: HTMLElement, controls: ClaudeModelControls) => { shown.push(controls); }, close: () => undefined, dispose: () => undefined };
	// The answer renders its Markdown as plain text here.
	const markdown = { render: (value: { value: string }) => ({ element: Object.assign(mainWindow.document.createElement('div'), { textContent: value.value.replace(/`/g, '') }), dispose: () => undefined }) };
	const instantiation = {
		createInstance: (ctor: unknown, actions: ClaudeInlineAnswerActions) => ctor === ClaudeInlineAnswer ? new ClaudeInlineAnswer(actions, markdown as never, { writeText: async () => undefined } as never) : menu,
	} as unknown as IInstantiationService;
	// No chat tab is open, so Send to Agent reveals the Agent view.
	const services: [IClaudeRuntimeService, IConfigurationService, ICommandService, INotificationService, IInstantiationService, IEditorService, IWorkspaceContextService] = [
		runtime,
		configuration,
		{ executeCommand: async () => undefined } as unknown as ICommandService,
		{ error: () => undefined } as unknown as INotificationService,
		instantiation,
		{ findEditors: () => [] } as unknown as IEditorService,
		{
			getWorkspaceFolder: () => ({ uri: URI.file('C:/repo') }),
			getWorkspace: () => ({ folders: [{ uri: URI.file('C:/repo') }] }),
		} as unknown as IWorkspaceContextService,
	];
	return { services, shown, updates };
}

function keybindings(): IKeybindingService {
	// A space, not "+": appendClaudeKbd splits "Ctrl+Enter" into two keys off macOS only, but splits on spaces everywhere.
	return {
		lookupKeybinding: (id: string) => ({ getLabel: () => id === 'klawly.inlineEdit.reject' ? 'Escape' : 'Ctrl Enter' }),
		resolveKeybinding: () => [{ getLabel: () => 'Alt Enter' }],
	} as unknown as IKeybindingService;
}

/** The Agent view; with `chat`, it shows that chat widget the way a rendered view would. */
function views(opened?: string[], chat?: Pick<ClaudeChatWidget, 'appendDraft'>): IViewsService {
	const pane: ClaudeAgentViewPane | undefined = chat ? Object.defineProperty(Object.create(ClaudeAgentViewPane.prototype), 'widget', { value: chat }) : undefined;
	return { openView: async (id: string) => { opened?.push(id); return pane; } } as unknown as IViewsService;
}

/** The labels of the buttons the card renders; the root must be in the document. */
function buttons(root: HTMLElement): string[] {
	return [...root.querySelectorAll('button')].filter(button => button.getClientRects().length > 0).map(button => button.getAttribute('aria-label') ?? button.textContent ?? '');
}

function findButton(zones: { zone: IViewZone }[], label: string): HTMLButtonElement | undefined {
	for (const entry of zones) {
		const buttons = entry.zone.domNode.getElementsByTagName('button');
		for (const button of buttons) {
			// A hidden part of the card (the answer before Claude answers) holds buttons too.
			if (button.textContent?.includes(label) && !button.closest('[hidden]')) {
				return button;
			}
		}
	}
	return undefined;
}

function replaceAll(model: ITextModel, value: string): void {
	const text = value.replace(/\n/g, model.getEOL());
	model.pushStackElement();
	model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
	model.pushStackElement();
}
