/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Git merge driver `klawly-design-sync` for design/sync.json (see .gitattributes and
// docs/rules/36-design-prototype.md). design/sync.json is generated, so two branches that both
// ran design-sync never merge by hand: the driver keeps our side, then regenerates the file with
// `design-sync --accept-all`, written straight into git's result file.
//
// Usage (git runs it): node build/klawly/merge-design-sync.ts <ancestor> <ours> <theirs> [<path>]
//        node build/klawly/merge-design-sync.ts --install   set merge.klawly-design-sync.driver (idempotent)
// While git runs the driver the working tree still holds the old files, so the regeneration there
// cannot see pages the merge adds. A detached `--finish` process therefore waits for the merge
// commit, regenerates against the merged tree and amends that merge commit with design/sync.json.
// Always exits 0, so a merge never stops on this file; `npm run compile` regenerates it again.
// --install does nothing outside a git checkout (CI tarballs, packaged sources). No dependencies.

import { execFileSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '../..');
const DRIVER = 'merge.klawly-design-sync.driver';
const COMMAND = 'node build/klawly/merge-design-sync.ts %O %A %B %P';

function git(args: readonly string[]): string {
	return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
}

export function install(): void {
	if (!existsSync(join(ROOT, '.git'))) {
		return;
	}
	try {
		if (git(['config', '--get', DRIVER]) === COMMAND) {
			return;
		}
	} catch {
		// Not set yet.
	}
	try {
		git(['config', DRIVER, COMMAND]);
		git(['config', 'merge.klawly-design-sync.name', 'Regenerate design/sync.json']);
	} catch {
		// No git on PATH: harmless, the merge is then a normal text merge.
	}
}

function regenerate(ours: string): void {
	try {
		// Run from the checkout that is merging; %A is relative to it.
		execFileSync(process.execPath, [join(ROOT, 'build/klawly/design-sync.ts'), '--accept-all', '--sync-file', resolve(ours)], { cwd: dirname(resolve(ours)), stdio: 'inherit', windowsHide: true });
	} catch (error) {
		console.warn(`merge-design-sync: kept our side (${error instanceof Error ? error.message : String(error)})`);
	}
}

/**
 * Waits for the merge commit, then regenerates design/sync.json in the merged tree and amends it in.
 * Polls once a second for at most two minutes. Every git call passes windowsHide: this process is
 * detached and has no console, so on Windows each unhidden child would open a terminal window.
 */
async function finish(before: string): Promise<void> {
	for (let i = 0; i < 120; i++) {
		await new Promise(done => setTimeout(done, 1000));
		let head = '';
		try {
			head = git(['rev-parse', 'HEAD']);
		} catch {
			return;
		}
		if (head === before) {
			continue;
		}
		const isMerge = git(['rev-list', '--parents', '-n', '1', head]).split(' ').length === 3;
		if (!isMerge || git(['status', '--porcelain', '--untracked-files=no'])) {
			return;
		}
		execFileSync(process.execPath, [join(ROOT, 'build/klawly/design-sync.ts'), '--accept-all', '--sync-file', join(ROOT, 'design/sync.json')], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
		if (git(['status', '--porcelain', '--', 'design/sync.json'])) {
			git(['add', 'design/sync.json']);
			git(['commit', '--amend', '--no-edit', '--no-verify', '-q']);
		}
		return;
	}
}

if (process.argv[2] === '--install') {
	install();
} else if (process.argv[2] === '--finish') {
	finish(process.argv[3]).catch(() => undefined);
} else if (process.argv[3]) {
	regenerate(process.argv[3]);
	try {
		spawn(process.execPath, [join(ROOT, 'build/klawly/merge-design-sync.ts'), '--finish', git(['rev-parse', 'HEAD'])], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref();
	} catch {
		// Not a merge of a checkout: the regeneration above stands.
	}
}
