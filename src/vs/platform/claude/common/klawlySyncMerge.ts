/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Klawly Sync's three-way merge (issue 447). Local and remote are merged against the last
 * synced snapshot (the base). Nothing here reads a clock: only content decides.
 *
 * A snapshot maps a relative path to the file's text, or to `null` for a deleted file (a
 * tombstone), so a machine that was offline with an old copy cannot bring a deleted skill back.
 */
export type KlawlySyncSnapshot = Readonly<Record<string, string | null>>;

/** A file both sides changed in different ways. The local file stays as it is and the remote text is kept for Resolve. */
export interface KlawlySyncConflict {
	readonly path: string;
	readonly local: string | null;
	readonly remote: string | null;
}

export interface KlawlySyncMergeResult {
	readonly files: KlawlySyncSnapshot;
	readonly conflicts: readonly KlawlySyncConflict[];
}

/** The result of merging one text. */
export type KlawlyTextMerge = { readonly text: string } | { readonly conflict: true };

/** The result of merging one JSON value. `paths` names the keys both sides changed differently. */
export type KlawlyJsonMerge = { readonly value: unknown; readonly conflicts: readonly string[] };

/**
 * Three-way merge of lines (diff3). Changes in different places combine; the same change on both
 * sides counts once; different changes in the same place are a conflict.
 */
export function mergeKlawlyText(base: string, local: string, remote: string): KlawlyTextMerge {
	if (local === remote) {
		return { text: local };
	}
	if (local === base) {
		return { text: remote };
	}
	if (remote === base) {
		return { text: local };
	}
	const baseLines = splitLines(base);
	const localHunks = diffHunks(baseLines, splitLines(local));
	const remoteHunks = diffHunks(baseLines, splitLines(remote));
	const out: string[] = [];
	let position = 0;
	let li = 0;
	let ri = 0;
	while (li < localHunks.length || ri < remoteHunks.length) {
		const l = localHunks[li];
		const r = remoteHunks[ri];
		if (l && r && overlaps(l, r)) {
			if (l.start === r.start && l.end === r.end && sameLines(l.lines, r.lines)) {
				out.push(...baseLines.slice(position, l.start), ...l.lines);
				position = l.end;
				li++;
				ri++;
				continue;
			}
			return { conflict: true };
		}
		const takeLocal = !r || (l !== undefined && l.start <= r.start);
		const hunk = takeLocal ? l! : r!;
		out.push(...baseLines.slice(position, hunk.start), ...hunk.lines);
		position = hunk.end;
		if (takeLocal) {
			li++;
		} else {
			ri++;
		}
	}
	out.push(...baseLines.slice(position));
	return { text: out.join('') };
}

interface Hunk {
	/** First base line replaced. */
	readonly start: number;
	/** One past the last base line replaced. */
	readonly end: number;
	readonly lines: readonly string[];
}

function splitLines(text: string): string[] {
	return text.length === 0 ? [] : text.split(/(?<=\n)/);
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((line, i) => line === b[i]);
}

/** Two hunks collide when they touch the same base lines, or both insert at the same spot. */
function overlaps(a: Hunk, b: Hunk): boolean {
	if (a.start === a.end && b.start === b.end) {
		return a.start === b.start;
	}
	if (a.start === a.end) {
		return a.start > b.start && a.start < b.end;
	}
	if (b.start === b.end) {
		return b.start > a.start && b.start < a.end;
	}
	return a.start < b.end && b.start < a.end;
}

/** The regions of `base` that `changed` replaced, from a longest-common-subsequence match. */
function diffHunks(base: readonly string[], changed: readonly string[]): Hunk[] {
	const n = base.length;
	const m = changed.length;
	const table: Uint32Array[] = [];
	for (let i = 0; i <= n; i++) {
		table.push(new Uint32Array(m + 1));
	}
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i][j] = base[i] === changed[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}
	const hunks: Hunk[] = [];
	let i = 0;
	let j = 0;
	let open: { start: number; lines: string[] } | undefined;
	const close = (end: number) => {
		if (open) {
			hunks.push({ start: open.start, end, lines: open.lines });
			open = undefined;
		}
	};
	while (i < n || j < m) {
		if (i < n && j < m && base[i] === changed[j]) {
			close(i);
			i++;
			j++;
		} else if (j < m && (i === n || table[i][j + 1] >= table[i + 1][j])) {
			open ??= { start: i, lines: [] };
			open.lines.push(changed[j]);
			j++;
		} else {
			open ??= { start: i, lines: [] };
			i++;
		}
	}
	close(i);
	return hunks;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonical);
	}
	if (isPlainObject(value)) {
		return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
	}
	return value;
}

/**
 * Key-level merge of JSON. Objects merge key by key down to `leafDepth` levels; below that, and
 * for arrays and scalars, a value is one unit. `leafDepth` 1 makes every top-level key a unit,
 * which merges `mcpServers` by server name when called on its value with depth 1.
 */
export function mergeKlawlyJson(base: unknown, local: unknown, remote: unknown, leafDepth = Infinity, path = ''): KlawlyJsonMerge {
	if (sameJson(local, remote)) {
		return { value: local, conflicts: [] };
	}
	if (sameJson(local, base)) {
		return { value: remote, conflicts: [] };
	}
	if (sameJson(remote, base)) {
		return { value: local, conflicts: [] };
	}
	if (leafDepth > 0 && isPlainObject(local) && isPlainObject(remote)) {
		const baseObject = isPlainObject(base) ? base : {};
		const result: Record<string, unknown> = {};
		const conflicts: string[] = [];
		const keys = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(baseObject)]);
		for (const key of keys) {
			const merged = mergeKlawlyJson(baseObject[key], local[key], remote[key], leafDepth - 1, path ? `${path}.${key}` : key);
			conflicts.push(...merged.conflicts);
			if (merged.value !== undefined) {
				result[key] = merged.value;
			}
		}
		return { value: result, conflicts };
	}
	return { value: local, conflicts: [path || '(root)'] };
}

function parseJson(text: string | null | undefined): unknown {
	if (text === null || text === undefined || text.trim() === '') {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** How a path merges: `.mcp.json` per server, other `.json` per key, Markdown and the rest as lines. */
function mergeFile(path: string, base: string | null | undefined, local: string, remote: string): string | undefined {
	const name = path.split('/').pop() ?? path;
	if (name.endsWith('.json')) {
		const parsedLocal = parseJson(local);
		const parsedRemote = parseJson(remote);
		if (parsedLocal === undefined || parsedRemote === undefined) {
			return undefined;
		}
		// `.mcp.json` keeps each server whole: two machines editing one server's env is a conflict, not a blend.
		const merged = name === '.mcp.json'
			? mergeMcpDocument(parseJson(base), parsedLocal, parsedRemote)
			: mergeKlawlyJson(parseJson(base), parsedLocal, parsedRemote);
		return merged.conflicts.length === 0 ? JSON.stringify(merged.value, undefined, '\t') + '\n' : undefined;
	}
	const merged = mergeKlawlyText(base ?? '', local, remote);
	return Object.hasOwn(merged, 'conflict') ? undefined : (merged as { readonly text: string }).text;
}

function mergeMcpDocument(base: unknown, local: unknown, remote: unknown): KlawlyJsonMerge {
	const get = (doc: unknown) => (isPlainObject(doc) && isPlainObject(doc.mcpServers) ? doc.mcpServers : undefined);
	const servers = mergeKlawlyJson(get(base) ?? {}, get(local) ?? {}, get(remote) ?? {}, 1);
	return { value: { ...(isPlainObject(local) ? local : {}), mcpServers: servers.value }, conflicts: servers.conflicts };
}

/**
 * Merges two snapshots against their base, file by file.
 * - Only one side changed: take it.
 * - Deleted on one side and untouched on the other: the delete wins (a tombstone).
 * - Deleted on one side and edited on the other: a conflict, never a resurrection.
 * - Both changed: merge by file type, and a conflict when the changes collide.
 * A conflicting file keeps its local content in `files`.
 */
export function mergeKlawlySnapshots(base: KlawlySyncSnapshot, local: KlawlySyncSnapshot, remote: KlawlySyncSnapshot): KlawlySyncMergeResult {
	const files: Record<string, string | null> = {};
	const conflicts: KlawlySyncConflict[] = [];
	const paths = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
	for (const path of [...paths].sort()) {
		const b = base[path];
		const l = local[path];
		const r = remote[path];
		const setValue = (value: string | null | undefined) => {
			if (value !== undefined) {
				files[path] = value;
			}
		};
		if (l === r) {
			setValue(l);
		} else if (l === b) {
			setValue(r);
		} else if (r === b) {
			setValue(l);
		} else if (l !== null && l !== undefined && r !== null && r !== undefined) {
			const merged = mergeFile(path, b, l, r);
			if (merged === undefined) {
				conflicts.push({ path, local: l, remote: r });
				files[path] = l;
			} else {
				files[path] = merged;
			}
		} else {
			conflicts.push({ path, local: l ?? null, remote: r ?? null });
			setValue(l);
		}
	}
	return { files, conflicts };
}

/** Marks every path that the base has and `files` lacks as deleted, so a local delete travels as a tombstone. */
export function withKlawlyTombstones(files: KlawlySyncSnapshot, base: KlawlySyncSnapshot): KlawlySyncSnapshot {
	const result: Record<string, string | null> = { ...files };
	for (const path of Object.keys(base)) {
		if (result[path] === undefined) {
			result[path] = null;
		}
	}
	return result;
}

/** The files a snapshot really holds, without tombstones. */
export function klawlyLiveFiles(snapshot: KlawlySyncSnapshot): Record<string, string> {
	const live: Record<string, string> = {};
	for (const [path, text] of Object.entries(snapshot)) {
		if (text !== null) {
			live[path] = text;
		}
	}
	return live;
}

export function sameKlawlySnapshot(a: KlawlySyncSnapshot, b: KlawlySyncSnapshot): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) {
		if (a[key] !== b[key]) {
			return false;
		}
	}
	return true;
}
