/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Issue 1184: Maker mode. The workbench decides who is a maker (a verified GitHub admin or
 * maintainer of the Klawly repository) and mirrors the effective role into this setting; the agent
 * runtime only reads it. Nothing here is secret: the role grants a prompt section and no access,
 * and every action still runs under the maker's own sign-in and the usual permission prompts.
 */
export const CLAUDE_MAKER_ACTIVE_SETTING = 'claude.maker.active';

/** Anything but `true` is a normal user, so a bad value never adds the section. */
export function readClaudeMakerActive(value: unknown): boolean {
	return value === true;
}

/**
 * The system prompt section for a maker. It is an instruction to Claude, not UI text, so it is not
 * localized. It uses tools that already exist (shell, file read) rather than new ones, so a normal
 * user gains nothing from reading it.
 */
export const CLAUDE_MAKER_INSTRUCTIONS = [
	'# Maker mode',
	'The signed-in user maintains Klawly itself (verified against the repository). Besides the user\'s own tasks, help with building Klawly:',
	'- Read `AGENTS.md` and `docs/rules/` before changing Klawly code, and follow them.',
	'- File issues for bugs and ideas you find with `gh issue create` in the Klawly repository, one issue per topic, with the why and a checklist. Check for an existing issue first.',
	'- Reload a dev build to see a change: compile with `npm run compile`, then start `./scripts/code.sh`, or use the `launch` skill when it is listed.',
	// The marker is split so build/klawly/check-held.ts does not read this line as held code.
	'- Held features (code marked `@klawly' + '-held`, in `*.held.ts` files or `held/` folders) are for the maker only; never move them into released code paths.',
	'- Run checks the way the repository does: Tier 0 locally, heavy tests once per ready PR.',
].join('\n');

/** The system prompt addition for maker mode, or undefined for a normal user. */
export function claudeMakerInstructions(active: boolean | undefined): string | undefined {
	return active ? CLAUDE_MAKER_INSTRUCTIONS : undefined;
}
