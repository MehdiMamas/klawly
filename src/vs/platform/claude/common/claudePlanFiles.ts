/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { posix, win32 } from '../../../base/common/path.js';

/**
 * Plan files are the only files Plan mode may write (Phase 27):
 * - `*.plan.md` anywhere inside a workspace folder;
 * - anything under `<workspace folder>/.claude/plans/` (or the legacy `.klawly/plans/`, until it is migrated);
 * - a `*.md` file under Klawly's own plan folder for this user (see `klawlyPlanDirectory`);
 * - a `*.md` file under Claude Code's own plan folder.
 *
 * Claude Code keeps its plans in `plans` under its config folder: `~/.claude/plans/`,
 * or `$CLAUDE_CONFIG_DIR/plans/` when that variable is set. The SDK's `Settings`
 * type documents the default of its `plansDirectory` setting as `~/.claude/plans/`,
 * and the Claude Code binary builds the path as `join(configHome, 'plans')`.
 * A project that sets `plansDirectory` keeps its plans in the workspace, where a
 * `*.plan.md` name or the `.claude/plans/` folder covers them.
 *
 * `planFileLocation` in `claudeToolPolicy.ts` applies these rules to a path.
 */
export const KLAWLY_PLANS_FOLDER = '.claude/plans';

/** Where a workspace's saved plans lived before issue 973. Still a plan folder for the policy, and migrated into `KLAWLY_PLANS_FOLDER`. */
export const LEGACY_KLAWLY_PLANS_FOLDER = '.klawly/plans';

/**
 * Where Klawly keeps the plan files it writes, by default (issue 322): `plans`
 * under the product's per-user data folder, `~/.klawly/plans/` (`~/.klawly-dev/plans/`
 * when running from sources), next to `~/.klawly/extensions/`. This mirrors Claude
 * Code's `~/.claude/plans/`, so plans stay out of the project unless the user
 * saves one into the workspace's `.claude/plans/` folder.
 */
export function klawlyPlanDirectory(homeDirectory: string, dataFolderName: string): string {
	return styleFor(homeDirectory).join(homeDirectory, dataFolderName, 'plans');
}

/** File name suffix of a plan file inside the workspace. */
export const PLAN_FILE_SUFFIX = '.plan.md';

/** Claude Code's folder for this user: `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
export function claudeConfigDirectory(homeDirectory: string, configDirectory?: string): string {
	return configDirectory && configDirectory.trim().length > 0 ? configDirectory.trim() : styleFor(homeDirectory).join(homeDirectory, '.claude');
}

/** Where Claude Code writes plan files for this user. */
export function claudePlanDirectory(homeDirectory: string, configDirectory?: string): string {
	const root = claudeConfigDirectory(homeDirectory, configDirectory);
	return styleFor(root).join(root, 'plans');
}

function styleFor(path: string) {
	return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\') ? win32 : posix;
}
