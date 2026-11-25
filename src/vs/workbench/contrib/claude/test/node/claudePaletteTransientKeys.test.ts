/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable local/code-no-unexternalized-strings, local/code-no-in-operator, local/code-ensure-no-disposables-leak-in-test -- source scan of plain strings, nothing disposable */

import assert from 'assert';
import { readClaudePaletteCommands } from './claudePaletteCommands.js';

/**
 * Issue 1504: the palette hides a command whose precondition is false, and then typing its name
 * lands on the closest other command, which Enter runs. So a Klawly palette command must not
 * depend on a state that changes while the user types: a running agent, a busy or pending
 * change, a selection or a cursor position. "Enabled" and feature flag keys are fine.
 */
const TRANSIENT = /running|busy|pending|selection|hunk|hasTurns|hasSubagents|hasOtherSessions|ActiveEditor|signedIn|available|tending|isOpen/i;

/** Commands that depend on a transient key on purpose. Each entry needs a one line reason. */
const ALLOWLIST: Readonly<Record<string, string>> = {
	'claude.restoreCheckpoint': "Destructive, and only valid while the agent is idle with a turn to rewind; a per-turn action (issue 1507)",
	'claude.editMessage': "Acts on one turn of the open chat (pick or hover target), so it is a per-turn action, not a feature typed by name (issue 1507)",
	'claude.referenceChat': "Needs another session to pick from; a context action in the composer (issue 1507)",
	'claude.addTerminalToAgent': "Acts on a terminal that is open or focused; a terminal context action (issue 1507)",
	'claude.importFromVSCode': "Offered only when a VS Code profile exists on this machine (capability, not a run state)",
	'claude.importFromCursor': "Offered only when a profile to import exists on this machine (capability, not a run state)",
	'claude.undoImport': "Offered only when an import can be undone (capability, not a run state)",
	'claude.preview.toggleDesignMode': "Acts on the active review, plan or preview editor and is meaningless elsewhere; an editor-toolbar action (issue 1507)",
	'klawly.plan.saveToWorkspace': "Acts on the active review, plan or preview editor and is meaningless elsewhere; an editor-toolbar action (issue 1507)",
	'klawly.plan.build': "Acts on the active review, plan or preview editor and is meaningless elsewhere; an editor-toolbar action (issue 1507)",
	'klawly.review.addComment': "Acts on the active review, plan or preview editor and is meaningless elsewhere; an editor-toolbar action (issue 1507)",
	'claude.review.exportMarkdown': "Acts on the active review, plan or preview editor and is meaningless elsewhere; an editor-toolbar action (issue 1507)",
	'claude.review.exportSarif': "Acts on the active review, plan or preview editor and is meaningless elsewhere; an editor-toolbar action (issue 1507)",
	'claude.review.copyPrComment': "Acts on the active review, plan or preview editor and is meaningless elsewhere; an editor-toolbar action (issue 1507)",
	'klawly.review.keepEditorFile': "Acts on the file open in the editor; an editor-toolbar action (issue 1507)",
	'klawly.review.keepHunkAtCursor': "Acts at the cursor's hunk; a cursor action (issue 1507)",
	'klawly.review.undoHunkAtCursor': "Acts at the cursor's hunk; a cursor action (issue 1507)",
	'KLAWLY_GITHUB_SIGN_IN_COMMAND_ID': "Sign In is hidden once signed in, by design",
	'KLAWLY_GITHUB_SIGN_OUT_COMMAND_ID': "Sign Out is hidden when signed out, by design",
};

suite('Klawly palette commands, transient keys (issue 1504)', () => {

	const { commands, unreadable } = readClaudePaletteCommands();

	test('the scan reads every Klawly f1 command', () => {
		assert.deepStrictEqual(unreadable, []);
		assert.ok(commands.length > 20, `expected many commands, read ${commands.length}`);
	});

	test('no palette command depends on a transient state key', () => {
		const offenders = commands
			.filter(c => !(c.id in ALLOWLIST))
			.map(c => ({ id: c.id, keys: c.keys.filter(k => TRANSIENT.test(k)) }))
			.filter(c => c.keys.length)
			.map(c => `${c.id}: ${c.keys.join(', ')}`);
		assert.deepStrictEqual(offenders, []);
	});

	test('every allowlist entry still names a command that needs it', () => {
		const stale = Object.keys(ALLOWLIST).filter(id => !commands.some(c => c.id === id && c.keys.some(k => TRANSIENT.test(k))));
		assert.deepStrictEqual(stale, []);
	});
});
