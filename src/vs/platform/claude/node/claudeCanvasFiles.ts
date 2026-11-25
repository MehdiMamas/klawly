/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { join } from '../../../base/common/path.js';
import { claudeCanvasArgsProblem, claudeCanvasFileName, claudeCanvasTitle, ClaudeCanvasToolArgs, ClaudeCanvasToolResult } from '../common/claudeCanvas.js';

/**
 * Saves one `klawly_canvas` page (issue 493) as `<root>/<session>/<name>.html`.
 * The session and the name are reduced to safe file names, so a page never lands
 * outside the canvases folder. Never throws: a failure becomes the message Claude reads.
 */
export async function saveClaudeCanvas(root: string, sessionId: string, args: ClaudeCanvasToolArgs): Promise<ClaudeCanvasToolResult> {
	const problem = claudeCanvasArgsProblem(args);
	const fileName = claudeCanvasFileName(args.name);
	const folderName = sessionId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
	if (problem || !fileName) {
		return { kind: 'failed', message: problem ?? 'Give the canvas a name.' };
	}
	if (!folderName) {
		return { kind: 'failed', message: 'The session has no id to save the canvas under.' };
	}
	const folder = join(root, folderName);
	const path = join(folder, fileName);
	try {
		await fs.mkdir(folder, { recursive: true });
		const updated = await fs.stat(path).then(() => true, () => false);
		await fs.writeFile(path, args.html, 'utf8');
		return { kind: 'saved', path, name: fileName.replace(/\.html$/, ''), title: claudeCanvasTitle(args), updated };
	} catch (error) {
		return { kind: 'failed', message: `Klawly could not save the canvas: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Canvases older than this are removed on the next canvas save (issue 683). */
export const CLAUDE_CANVAS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Removes canvas pages under `root` whose last write is older than `maxAgeMs`, then
 * any session folder left empty. Best effort: it never throws and never leaves `root`.
 */
export async function pruneClaudeCanvases(root: string, now: number, maxAgeMs: number = CLAUDE_CANVAS_MAX_AGE_MS): Promise<number> {
	let removed = 0;
	try {
		for (const folderEntry of await fs.readdir(root, { withFileTypes: true })) {
			if (!folderEntry.isDirectory()) {
				continue;
			}
			const folder = join(root, folderEntry.name);
			for (const name of await fs.readdir(folder)) {
				if (!name.endsWith('.html')) {
					continue;
				}
				const path = join(folder, name);
				const stat = await fs.stat(path).catch(() => undefined);
				if (stat && now - stat.mtimeMs > maxAgeMs && await fs.rm(path, { force: true }).then(() => true, () => false)) {
					removed++;
				}
			}
			await fs.rmdir(folder).catch(() => undefined);
		}
	} catch {
		// A missing or unreadable canvases folder has nothing to prune.
	}
	return removed;
}
