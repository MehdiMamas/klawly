/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Issue 467: whether the agent runs the app and checks a changed screen in the agent browser. */
export const CLAUDE_VERIFY_UI_SETTING = 'claude.agent.verifyUiChanges';

export type ClaudeVerifyUi = 'off' | 'ask' | 'always';

/** Anything but `ask` or `always` is off, so a bad value never changes the prompt. */
export function readClaudeVerifyUi(value: unknown): ClaudeVerifyUi {
	return value === 'ask' || value === 'always' ? value : 'off';
}

const VERIFY_STEPS = [
	'- Start the app\'s dev server. In a worktree or background session, start your own server on a free port (ask the OS for port 0 or pick an unused one); never reuse a port another agent may hold, and stop the server when you are done.',
	'- Open the changed screen with the browser tool and capture a "before" screenshot (from the base branch or before your edit when you can) and an "after" screenshot.',
	'- Drive the change: click, type and scroll through the new behaviour, and make a short recording of it.',
	'- Read the console and report every error or warning it logged.',
	'- Put the before and after screenshots, the recording and the console errors in your turn summary, so the Review editor shows them next to the diff.',
];

/** An instruction to Claude, not UI text, so it is not localized. */
export const CLAUDE_VERIFY_UI_ALWAYS_INSTRUCTIONS = [
	'# Verify UI changes',
	'After you change anything the user can see (a screen, component, style or layout), verify it in the running app before you call the work done:',
	...VERIFY_STEPS,
	'Skip this only when the change has no visible effect, and say so.',
].join('\n');

export const CLAUDE_VERIFY_UI_ASK_INSTRUCTIONS = [
	'# Verify UI changes',
	'After you change anything the user can see (a screen, component, style or layout), ask the user once whether you should verify it in the running app. Only if they agree:',
	...VERIFY_STEPS,
].join('\n');

/** The system prompt addition for the setting, or undefined when it is off. */
export function claudeVerifyUiInstructions(mode: ClaudeVerifyUi | undefined): string | undefined {
	return mode === 'always' ? CLAUDE_VERIFY_UI_ALWAYS_INSTRUCTIONS : mode === 'ask' ? CLAUDE_VERIFY_UI_ASK_INSTRUCTIONS : undefined;
}
