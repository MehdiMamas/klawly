/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { join } from '../../../base/common/path.js';
import { KlawlySyncMachine, KlawlySyncMemoryNote, KlawlySyncMemoryOverview, KlawlySyncMemoryProject } from '../common/klawlySyncService.js';
import { ClaudeHistoryMachineManifest, claudeHistoryMachineSlug, CLAUDE_HISTORY_FOLDER, CLAUDE_HISTORY_MACHINES_FOLDER } from './claudeHistoryExport.js';

async function folders(directory: string): Promise<string[]> {
	const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
	return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
}

/**
 * What the synced memory and history folders hold, for the memory view (issue 448): per project its notes
 * and transcripts, and per computer the sessions it exported (from its manifest, never prompt text). Reads files only; a missing folder reads as empty.
 */
export async function listKlawlySyncMemory(layer: string, machine: string): Promise<KlawlySyncMemoryOverview> {
	const memoryRoot = join(layer, 'memory');
	const transcriptRoot = join(layer, CLAUDE_HISTORY_FOLDER, 'transcripts');
	const slugs = [...new Set([...await folders(memoryRoot), ...await folders(transcriptRoot)])].sort();
	const projects: KlawlySyncMemoryProject[] = [];
	for (const slug of slugs) {
		const notes: KlawlySyncMemoryNote[] = [];
		const directory = join(memoryRoot, slug);
		for (const name of (await fs.readdir(directory).catch(() => [] as string[])).filter(n => n.endsWith('.md')).sort()) {
			const stat = await fs.stat(join(directory, name)).catch(() => undefined);
			if (stat?.isFile()) {
				notes.push({ name, path: join(directory, name), bytes: stat.size, updatedAt: stat.mtimeMs });
			}
		}
		const transcripts = (await fs.readdir(join(transcriptRoot, slug)).catch(() => [] as string[])).filter(n => n.endsWith('.jsonl')).length;
		projects.push({ slug, notes, transcripts });
	}
	const current = claudeHistoryMachineSlug(machine);
	const machines: KlawlySyncMachine[] = [];
	const manifestRoot = join(layer, CLAUDE_HISTORY_FOLDER, CLAUDE_HISTORY_MACHINES_FOLDER);
	for (const file of (await fs.readdir(manifestRoot).catch(() => [] as string[])).filter(n => n.endsWith('.json')).sort()) {
		try {
			const manifest: Partial<ClaudeHistoryMachineManifest> = JSON.parse(await fs.readFile(join(manifestRoot, file), 'utf8'));
			if (typeof manifest.machine === 'string' && Array.isArray(manifest.transcripts)) {
				machines.push({ name: manifest.machine, sessions: manifest.transcripts.length, current: claudeHistoryMachineSlug(manifest.machine) === current });
			}
		} catch {
			// a broken manifest lists nothing
		}
	}
	return { projects, machines };
}
