/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Issue 682: asks Claude to mark which to-dos wait on others, so Build in Parallel can start the
 * independent ones together. An instruction to Claude, not UI text, so it is not localized.
 */
export const CLAUDE_PLAN_DEPENDS_INSTRUCTIONS = [
	'# Plans: mark what waits on what',
	'When you write a plan as a checklist of to-dos, put a detail line under any to-do that needs an earlier one finished first:',
	'- `Depends: 1, 3` (the numbers are the to-dos\' positions in the list, counting from 1; only earlier to-dos).',
	'- Leave the line out for a to-do that can start right away, so independent to-dos can be built at the same time.',
	'Keep the dependencies real: do not chain to-dos that touch different files and do not need each other\'s result.',
].join('\n');

/** The system prompt addition for plan mode, or undefined in any other mode. */
export function claudePlanDependsInstructions(mode: string | undefined): string | undefined {
	return mode === 'plan' ? CLAUDE_PLAN_DEPENDS_INSTRUCTIONS : undefined;
}
