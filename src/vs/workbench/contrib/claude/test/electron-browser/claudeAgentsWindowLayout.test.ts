/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Parts } from '../../../../services/layout/browser/layoutService.js';
import { CLAUDE_AGENTS_WINDOW_PARTS, claudeAgentsQuitPrompt, claudeAgentsWindowTitleTemplate, claudeAgentsWindowLayoutChanges, claudeAgentsWindowNextLayoutStep } from '../../electron-browser/claudeAgentsWindowLayout.js';

suite('Claude agents window layout', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('hides the IDE parts of a default layout and shows the agent parts', () => {
		const visible = new Set([Parts.EDITOR_PART, Parts.ACTIVITYBAR_PART, Parts.STATUSBAR_PART, Parts.SIDEBAR_PART]);
		assert.deepStrictEqual(claudeAgentsWindowLayoutChanges(p => visible.has(p)), [
			[Parts.EDITOR_PART, true],
			[Parts.ACTIVITYBAR_PART, true],
			[Parts.STATUSBAR_PART, true],
			[Parts.SIDEBAR_PART, true],
			[Parts.AUXILIARYBAR_PART, false],
		]);
	});

	test('changes nothing once the layout is the agents layout', () => {
		const visible = new Set([Parts.AUXILIARYBAR_PART]);
		assert.deepStrictEqual(claudeAgentsWindowLayoutChanges(p => visible.has(p)), []);
	});

	test('applies the editor before the panel, never the status bar, re-reading visibility after each step', () => {
		// Panel hidden, editor shown: hiding the editor brings the panel back (upstream), so it is hidden again after.
		const visible = new Set([Parts.EDITOR_PART, Parts.STATUSBAR_PART, Parts.AUXILIARYBAR_PART]);
		const steps: ([Parts, boolean] | undefined)[] = [];
		steps.push(claudeAgentsWindowNextLayoutStep(p => visible.has(p)));
		visible.delete(Parts.EDITOR_PART);
		visible.add(Parts.PANEL_PART);
		steps.push(claudeAgentsWindowNextLayoutStep(p => visible.has(p)));
		visible.delete(Parts.PANEL_PART);
		steps.push(claudeAgentsWindowNextLayoutStep(p => visible.has(p)));
		assert.deepStrictEqual(steps, [[Parts.EDITOR_PART, true], [Parts.PANEL_PART, true], undefined]);
	});

	test('quit prompt names how many agents are running', () => {
		assert.deepStrictEqual(
			[claudeAgentsQuitPrompt(1).message, claudeAgentsQuitPrompt(3).message],
			['An agent is still running. Quit anyway?', '3 agents are still running. Quit anyway?'],
		);
	});

	test('hides the editor part and the sidebar and keeps the Agent pane (auxiliary bar) visible (#1522)', () => {
		assert.strictEqual(CLAUDE_AGENTS_WINDOW_PARTS.get(Parts.EDITOR_PART), false);
		assert.strictEqual(CLAUDE_AGENTS_WINDOW_PARTS.get(Parts.PANEL_PART), false);
		assert.strictEqual(CLAUDE_AGENTS_WINDOW_PARTS.get(Parts.SIDEBAR_PART), false);
		assert.strictEqual(CLAUDE_AGENTS_WINDOW_PARTS.get(Parts.AUXILIARYBAR_PART), true);
		// With the panel hidden, hiding the editor leaves the panel hidden (layout.ts allows it in the agents layout): one step, then done.
		const visible = new Set([Parts.EDITOR_PART, Parts.AUXILIARYBAR_PART]);
		assert.deepStrictEqual(claudeAgentsWindowNextLayoutStep(p => visible.has(p)), [Parts.EDITOR_PART, true]);
		visible.delete(Parts.EDITOR_PART);
		assert.strictEqual(claudeAgentsWindowNextLayoutStep(p => visible.has(p)), undefined);
	});

	test('window title is the Agents window title, not the folder name (#1522)', () => {
		assert.strictEqual(claudeAgentsWindowTitleTemplate(), 'Agents Window${separator}${appName}');
	});
});
