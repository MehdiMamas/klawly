/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { join } from '../../../base/common/path.js';
import { scanClaudeSecrets } from '../common/claudeSecretScan.js';
import { ClaudeHistoryPreview, ClaudeHistoryProjectPreview } from '../common/claudeHistoryPreview.js';
import { klawlyProjectIdentitySlug } from '../common/klawlySyncProjectIdentity.js';
import { resolveClaudeProjectIdentity } from './claudeProjectMemory.js';

/** The folder under the user layer that Klawly Sync keeps in step for session transcripts (issue 448). */
export const CLAUDE_HISTORY_FOLDER = 'history';

export interface ClaudeHistoryExportOptions {
	/** The user layer (`~/.klawly/claude`). */
	readonly layer: string;
	/** The folder that holds `agent-sessions`. */
	readonly userDataPath: string;
	/** Newest sessions kept per project. */
	readonly maxSessions?: number;
	/** The most one project keeps in total: the newest whole lines that fit, newest session first. */
	readonly maxBytes?: number;
	/** Project identities (`github.com/owner/repo`) that are never synced. Compared without regard to case. */
	readonly excludedProjects?: readonly string[];
	/** This machine's name. When given, the export records which transcripts it wrote, so other machines can say where a session came from. */
	readonly machine?: string;
}

/** The folder under `history` that holds one small file per machine: the transcripts that machine exported. */
export const CLAUDE_HISTORY_MACHINES_FOLDER = 'machines';

/** What a machine says about its own export: `transcripts` are `<identity slug>/<session id>`. */
export interface ClaudeHistoryMachineManifest {
	readonly machine: string;
	readonly transcripts: readonly string[];
}

/** The file name for a machine's manifest: its name made safe, so two machines never share a file. */
function machineManifestName(machine: string): string {
	return machine.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'machine';
}

/** One session as the sync would carry it. */
export interface ClaudeHistoryCandidate {
	readonly identity: string;
	readonly id: string;
	readonly updatedAt: number;
	readonly text: string;
	readonly bytes: number;
	/** How many secrets the scanner found. A session with any is never written or uploaded. */
	readonly secrets: number;
	/** The first thing the person asked, cut short, so the preview shows what is in it. */
	readonly firstPrompt: string;
}

interface IndexedSession {
	readonly id: string;
	readonly updatedAt: number;
	readonly projectFolder?: string;
}

interface TranscriptLine {
	readonly role: 'user' | 'assistant';
	readonly ts: number;
	readonly text: string;
}

/** The file name part of a machine: letters, digits, dot, dash. Used by the memory view to name a computer. */
export function claudeHistoryMachineSlug(machine: string): string {
	return machine.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'machine';
}

/**
 * Reads a session's event log and keeps only what a person said and what Claude answered. Tool calls,
 * tool output and streaming deltas stay on the machine: they are large and the likeliest place for a secret.
 */
export function compactClaudeTranscript(eventsJsonl: string): TranscriptLine[] {
	const lines: TranscriptLine[] = [];
	for (const raw of eventsJsonl.split(/\r?\n/)) {
		if (!raw) {
			continue;
		}
		let parsed: { ts?: unknown; event?: { type?: unknown; text?: unknown } };
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		const ts = typeof parsed.ts === 'number' ? parsed.ts : 0;
		const event = parsed.event;
		if (typeof event?.text !== 'string' || !event.text.trim()) {
			continue;
		}
		if (event.type === 'turn.submitted') {
			lines.push({ role: 'user', ts, text: event.text });
		} else if (event.type === 'assistant.completed') {
			lines.push({ role: 'assistant', ts, text: event.text });
		}
	}
	return lines;
}

function serialize(lines: readonly TranscriptLine[], maxBytes: number): string {
	const kept: string[] = [];
	let size = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const text = JSON.stringify(lines[i]) + '\n';
		if (size + text.length > maxBytes) {
			break;
		}
		size += text.length;
		kept.unshift(text);
	}
	return kept.join('');
}

async function writeIfChanged(file: string, text: string): Promise<boolean> {
	if (await fs.readFile(file, 'utf8').catch(() => undefined) === text) {
		return false;
	}
	await fs.mkdir(join(file, '..'), { recursive: true });
	await fs.writeFile(file, text, 'utf8');
	return true;
}

function sample(text: string): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > 80 ? flat.slice(0, 79) + '\u2026' : flat;
}

async function readIndex(userDataPath: string): Promise<IndexedSession[]> {
	try {
		const parsed = JSON.parse(await fs.readFile(join(userDataPath, 'agent-sessions', 'index.json'), 'utf8')) as { sessions?: IndexedSession[] };
		return Array.isArray(parsed.sessions) ? parsed.sessions.filter(s => typeof s?.id === 'string' && /^[\w.-]+$/.test(s.id)) : [];
	} catch {
		return [];
	}
}

/**
 * The sessions of each project that fit the limits, newest first: at most `maxSessions`, and no more
 * than `maxBytes` per project. Every one is scanned for secrets. Excluded projects are not read at all.
 */
async function collect(options: ClaudeHistoryExportOptions): Promise<{ kept: Map<string, ClaudeHistoryCandidate[]>; dropped: Map<string, string[]>; excluded: Set<string> }> {
	const maxSessions = options.maxSessions ?? 20;
	const maxBytes = options.maxBytes ?? 256 * 1024;
	const excludedNames = new Set((options.excludedProjects ?? []).map(name => name.trim().toLowerCase()));
	const byProject = new Map<string, IndexedSession[]>();
	for (const session of await readIndex(options.userDataPath)) {
		const identity = session.projectFolder ? await resolveClaudeProjectIdentity(options.layer, session.projectFolder).catch(() => undefined) : undefined;
		if (identity) {
			byProject.set(identity, [...byProject.get(identity) ?? [], session]);
		}
	}
	const kept = new Map<string, ClaudeHistoryCandidate[]>();
	const dropped = new Map<string, string[]>();
	const excluded = new Set<string>();
	for (const [identity, list] of byProject) {
		const ordered = list.slice().sort((a, b) => b.updatedAt - a.updatedAt);
		const drop: string[] = [];
		const keep: ClaudeHistoryCandidate[] = [];
		if (excludedNames.has(identity.toLowerCase())) {
			excluded.add(identity);
			dropped.set(identity, ordered.map(s => s.id));
			kept.set(identity, keep);
			continue;
		}
		let budget = maxBytes;
		for (const session of ordered) {
			if (keep.length >= maxSessions || budget <= 0) {
				drop.push(session.id);
				continue;
			}
			const events = await fs.readFile(join(options.userDataPath, 'agent-sessions', session.id, 'events.jsonl'), 'utf8').catch(() => undefined);
			const lines = events === undefined ? [] : compactClaudeTranscript(events);
			if (!lines.length) {
				continue;
			}
			const text = serialize(lines, budget);
			if (!text) {
				drop.push(session.id);
				continue;
			}
			budget -= text.length;
			keep.push({ identity, id: session.id, updatedAt: session.updatedAt, text, bytes: text.length, secrets: scanClaudeSecrets(text).length, firstPrompt: sample(lines.find(l => l.role === 'user')?.text ?? '') });
		}
		kept.set(identity, keep);
		dropped.set(identity, drop);
	}
	return { kept, dropped, excluded };
}

/** What the sync would carry, for the person to look at before the first upload. Reads, never writes. */
export async function previewClaudeHistory(options: ClaudeHistoryExportOptions): Promise<ClaudeHistoryPreview> {
	const { kept, excluded } = await collect(options);
	const projects: ClaudeHistoryProjectPreview[] = [];
	for (const [identity, list] of kept) {
		const sendable = list.filter(c => c.secrets === 0);
		projects.push({ identity, excluded: excluded.has(identity), sessions: sendable.length, bytes: sendable.reduce((n, c) => n + c.bytes, 0), heldBack: list.length - sendable.length, samples: sendable.slice(0, 3).map(c => c.firstPrompt) });
	}
	return { projects, totalBytes: projects.reduce((n, p) => n + p.bytes, 0) };
}

/**
 * Copies this machine's recent transcripts into `<layer>/history`, filed by project identity, so the
 * sync engine can carry them (issue 448). A session that holds a secret, belongs to an excluded project
 * or fell outside the limits is not written, and an earlier copy of it is removed. It never deletes a
 * file another machine wrote: only transcripts of sessions in this machine's own index.
 */
export async function exportClaudeHistory(options: ClaudeHistoryExportOptions): Promise<{ written: number; heldBack: number }> {
	const { kept, dropped } = await collect(options);
	const base = transcriptsFolder(options.layer);
	let written = 0;
	let heldBack = 0;
	const exported: string[] = [];
	for (const [identity, list] of kept) {
		const directory = join(base, klawlyProjectIdentitySlug(identity));
		for (const candidate of list) {
			const file = join(directory, `${candidate.id}.jsonl`);
			if (candidate.secrets > 0) {
				heldBack++;
				await fs.rm(file, { force: true });
			} else {
				exported.push(`${klawlyProjectIdentitySlug(identity)}/${candidate.id}`);
				if (await writeIfChanged(file, candidate.text)) {
					written++;
				}
			}
		}
		for (const id of dropped.get(identity) ?? []) {
			await fs.rm(join(directory, `${id}.jsonl`), { force: true });
		}
	}
	const machine = options.machine?.trim();
	if (machine) {
		const manifest: ClaudeHistoryMachineManifest = { machine, transcripts: exported.sort() };
		await writeIfChanged(join(options.layer, CLAUDE_HISTORY_FOLDER, CLAUDE_HISTORY_MACHINES_FOLDER, `${machineManifestName(machine)}.json`), JSON.stringify(manifest, undefined, '\t') + '\n');
	}
	return { written, heldBack };
}

/** A transcript another machine synced, with the machine it came from. */
export interface ClaudeImportedSession {
	/** The machine that exported it. */
	readonly machine: string;
	readonly identitySlug: string;
	readonly id: string;
	/** When the transcript file last changed. */
	readonly updatedAt: number;
	/** The first thing the person asked, cut short. */
	readonly firstPrompt: string;
	/** The transcript file. */
	readonly file: string;
}

/**
 * Lists the transcripts other machines synced into `<layer>/history`, newest first. A transcript counts when
 * another machine's manifest names it and the file is there; this machine's own manifest is skipped, since
 * its sessions are already local. A manifest that is missing or broken lists nothing.
 */
export async function readImportedClaudeHistory(layer: string, ownMachine: string | undefined): Promise<ClaudeImportedSession[]> {
	const folder = join(layer, CLAUDE_HISTORY_FOLDER, CLAUDE_HISTORY_MACHINES_FOLDER);
	const own = ownMachine?.trim().toLowerCase();
	const found = new Map<string, ClaudeImportedSession>();
	for (const name of (await fs.readdir(folder).catch(() => [])).sort()) {
		if (!name.endsWith('.json')) {
			continue;
		}
		let manifest: Partial<ClaudeHistoryMachineManifest>;
		try {
			manifest = JSON.parse(await fs.readFile(join(folder, name), 'utf8'));
		} catch {
			continue;
		}
		if (typeof manifest.machine !== 'string' || !Array.isArray(manifest.transcripts) || manifest.machine.trim().toLowerCase() === own) {
			continue;
		}
		for (const entry of manifest.transcripts) {
			const match = typeof entry === 'string' ? /^(?<slug>[\w.-]+)\/(?<id>[\w.-]+)$/.exec(entry) : null;
			if (!match?.groups) {
				continue;
			}
			const { slug, id } = match.groups;
			const file = join(transcriptsFolder(layer), slug, `${id}.jsonl`);
			const [stat, text] = await Promise.all([fs.stat(file).catch(() => undefined), fs.readFile(file, 'utf8').catch(() => undefined)]);
			if (!stat || text === undefined) {
				continue;
			}
			const first = text.split(/\r?\n/).map(raw => { try { return JSON.parse(raw) as Partial<TranscriptLine>; } catch { return undefined; } }).find(l => l?.role === 'user');
			found.set(`${slug}/${id}`, { machine: manifest.machine, identitySlug: slug, id, updatedAt: stat.mtimeMs, firstPrompt: sample(first?.text ?? ''), file });
		}
	}
	return [...found.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function transcriptsFolder(layer: string): string {
	return join(layer, CLAUDE_HISTORY_FOLDER, 'transcripts');
}
