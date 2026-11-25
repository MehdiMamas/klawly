/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { createTestCodeEditor } from '../../../../../editor/test/browser/testCodeEditor.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { CLAUDE_AGENT_ENABLED_SETTING, CLAUDE_SELECTION_TOOLBAR_SETTING } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { ICommandEvent, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { Event } from '../../../../../base/common/event.js';
import { ClaudeSelectionToolbar, SELECTION_TOOLBAR_SETTLE_MS, selectionToolbarAnchor } from '../../browser/inline/claudeSelectionToolbar.js';
import { CLAUDE_ADD_SELECTION_COMMAND_ID, CLAUDE_INLINE_EDIT_COMMAND_ID } from '../../common/claudeViews.js';

class RecordingCommandService implements ICommandService {
	declare readonly _serviceBrand: undefined;
	readonly onWillExecuteCommand: Event<ICommandEvent> = Event.None;
	readonly onDidExecuteCommand: Event<ICommandEvent> = Event.None;
	readonly ran: string[] = [];

	async executeCommand<R>(commandId: string): Promise<R | undefined> {
		this.ran.push(commandId);
		return undefined;
	}
}

suite('Claude selection toolbar', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const text = [
		'function add(a, b) {',
		'	return a + b;',
		'}',
		'   ',
		'',
		'add(1, 2);',
	].join('\n');

	function setup(options: { enabled?: boolean; agentEnabled?: boolean; readOnly?: boolean } = {}) {
		const configuration = new TestConfigurationService({
			[CLAUDE_SELECTION_TOOLBAR_SETTING]: options.enabled ?? true,
			[CLAUDE_AGENT_ENABLED_SETTING]: options.agentEnabled ?? true,
		});
		const commands = new RecordingCommandService();
		const services = new ServiceCollection([IConfigurationService, configuration], [ICommandService, commands]);
		const model = disposables.add(createTextModel(text));
		const editor = disposables.add(createTestCodeEditor(model, { serviceCollection: services, readOnly: options.readOnly }));
		const toolbar = editor.registerAndInstantiateContribution(ClaudeSelectionToolbar.ID, ClaudeSelectionToolbar);
		return { editor, toolbar, commands, model };
	}

	test('anchors at the start of the text on the first selected line', () => {
		const model = disposables.add(createTextModel(text));
		assert.deepStrictEqual([
			selectionToolbarAnchor(model, [new Selection(1, 1, 1, 1)]),
			selectionToolbarAnchor(model, [new Selection(4, 1, 4, 4)]),
			selectionToolbarAnchor(model, [new Selection(1, 1, 1, 3), new Selection(2, 1, 2, 3)]),
			selectionToolbarAnchor(model, [new Selection(1, 10, 2, 5)]),
			selectionToolbarAnchor(model, [new Selection(2, 1, 3, 2)]),
			selectionToolbarAnchor(model, [new Selection(1, 21, 3, 2)]),
			selectionToolbarAnchor(model, [new Selection(2, 14, 1, 1)]),
			selectionToolbarAnchor(model, [new Selection(5, 1, 6, 4)]),
			selectionToolbarAnchor(model, [new Selection(4, 2, 6, 4)]),
			selectionToolbarAnchor(model, [new Selection(1, 10, 2, 5)], 'below'),
			selectionToolbarAnchor(model, [new Selection(1, 10, 3, 1)], 'below'),
			selectionToolbarAnchor(model, [new Selection(2, 5, 2, 10)], 'below'),
		], [
			undefined,
			undefined,
			undefined,
			// Mid-line: at the selection start.
			{ lineNumber: 1, column: 10 },
			// From inside the indentation: at the text start.
			{ lineNumber: 2, column: 2 },
			// From the end of a line: at the next line's text start.
			{ lineNumber: 2, column: 2 },
			{ lineNumber: 1, column: 1 },
			// From an empty line: on the next line.
			{ lineNumber: 6, column: 1 },
			// From a whitespace-only line: at its indentation.
			{ lineNumber: 4, column: 4 },
			{ lineNumber: 2, column: 2 },
			{ lineNumber: 2, column: 2 },
			{ lineNumber: 2, column: 5 },
		]);
	});

	test('shows once a keyboard selection settles and hides on collapse or typing', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { editor, toolbar, model } = setup();
		editor.setSelection(new Selection(2, 2, 2, 14));
		const early = toolbar.position;
		await timeout(SELECTION_TOOLBAR_SETTLE_MS + 10);
		const shown = toolbar.position;
		editor.setSelection(new Selection(2, 2, 2, 2));
		const collapsed = toolbar.position;
		editor.setSelection(new Selection(1, 1, 2, 14));
		await timeout(SELECTION_TOOLBAR_SETTLE_MS + 10);
		const reshown = toolbar.position;
		model.applyEdits([{ range: new Selection(3, 2, 3, 2), text: '\n' }]);
		assert.deepStrictEqual({ early, shown, collapsed, reshown, typed: toolbar.position }, {
			early: undefined,
			shown: { lineNumber: 2, column: 2 },
			collapsed: undefined,
			// The test editor starts at the top, so there is no room above and the toolbar opens under the last line.
			reshown: { lineNumber: 2, column: 2 },
			typed: undefined,
		});
	}));

	test('stays hidden when the setting or the agent is off', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const off = setup({ enabled: false });
		const noAgent = setup({ agentEnabled: false });
		off.editor.setSelection(new Selection(1, 1, 1, 9));
		noAgent.editor.setSelection(new Selection(1, 1, 1, 9));
		await timeout(SELECTION_TOOLBAR_SETTLE_MS + 10);
		assert.deepStrictEqual([off.toolbar.position, noAgent.toolbar.position], [undefined, undefined]);
	}));

	test('buttons run their commands; a read-only editor has no Edit', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const writable = setup();
		const readOnly = setup({ readOnly: true });
		writable.editor.setSelection(new Selection(1, 1, 1, 9));
		readOnly.editor.setSelection(new Selection(1, 1, 1, 9));
		await timeout(SELECTION_TOOLBAR_SETTLE_MS + 10);
		const labels = (toolbar: ClaudeSelectionToolbar) => [...toolbar.domNode.querySelectorAll('.claude-selection-bar-label')].map(label => label.textContent);
		const shown = { writable: labels(writable.toolbar), readOnly: labels(readOnly.toolbar) };
		const buttons = writable.toolbar.domNode.querySelectorAll<HTMLElement>('.claude-selection-bar-action');
		buttons[1].click();
		const afterEdit = writable.toolbar.position;
		writable.editor.setSelection(new Selection(1, 1, 1, 12));
		await timeout(SELECTION_TOOLBAR_SETTLE_MS + 10);
		writable.toolbar.domNode.querySelector<HTMLElement>('.claude-selection-bar-action')!.click();
		assert.deepStrictEqual({ shown, afterEdit, ran: writable.commands.ran }, {
			shown: { writable: ['Add to Agent', 'Edit'], readOnly: ['Add to Agent'] },
			afterEdit: undefined,
			ran: [CLAUDE_INLINE_EDIT_COMMAND_ID, CLAUDE_ADD_SELECTION_COMMAND_ID],
		});
	}));

	test('each button leads with its icon; a separator sits between them', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const writable = setup();
		const readOnly = setup({ readOnly: true });
		writable.editor.setSelection(new Selection(1, 1, 1, 9));
		readOnly.editor.setSelection(new Selection(1, 1, 1, 9));
		await timeout(SELECTION_TOOLBAR_SETTLE_MS + 10);
		const parts = (toolbar: ClaudeSelectionToolbar) => [...toolbar.domNode.querySelector('.claude-selection-bar')!.children].map(child => child.classList.contains('claude-selection-bar-separator') ? '|' : child.firstElementChild!.className);
		assert.deepStrictEqual({ writable: parts(writable.toolbar), readOnly: parts(readOnly.toolbar) }, {
			writable: ['codicon codicon-comment-discussion', '|', 'codicon codicon-edit'],
			readOnly: ['codicon codicon-comment-discussion'],
		});
	}));
});
