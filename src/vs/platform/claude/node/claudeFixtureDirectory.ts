/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises, readFileSync } from 'fs';
import { dirname, join } from '../../../base/common/path.js';
import { ClaudeModelInfo, ClaudeRuntimeState } from '../common/claude.js';
import { fsPathFromCheckpointUri } from '../common/claudeCheckpoints.js';
import { ClaudeCheckpointStore } from '../common/claudeCheckpointStore.js';
import { ClaudeFakeFileWrites, ClaudeFakeTurn, FakeClaudeRuntimeOptions } from '../common/fakeClaudeRuntimeService.js';
import { NodeCheckpointStorage } from './claudeCheckpointNodeStorage.js';

/**
 * Names a folder of fake-runtime scripts. Only `build/klawly/design-parity.ts` sets it, and only
 * a dev build reads it, so a shipped app never replays files from disk.
 */
export const CLAUDE_FAKE_FIXTURE_DIR_ENV = 'KLAWLY_FAKE_FIXTURE_DIR';

/** The script the fake runtime replays for a plain composer send. */
const PLAIN_SEND_FIXTURE = 'plain-answer';

/** Milliseconds between scripted events in a fixture folder run, so a screenshot sees each step land. */
const FIXTURE_DIR_STEP_DELAY_MS = 120;

export interface ClaudeFakeFixtures extends FakeClaudeRuntimeOptions {
	readonly fixtures: ReadonlyMap<string, string>;
}

/**
 * Fixtures for the fake runtime. When `isBuilt` is false and `KLAWLY_FAKE_FIXTURE_DIR` is set:
 * - a plain send replays `<dir>/<name>.jsonl`, where `<name>` is read from `<dir>/next.txt` at
 *   send time; a missing or unreadable file falls back to the built-in script;
 * - `<dir>/models.json`, when it holds a list, replaces the fake's models;
 * - a script's `file.beforeWrite` snapshots the file into the turn's checkpoint under
 *   `userDataPath` and `file.afterWrite` writes `after` to disk, as Claude Code and the runner
 *   would, so the turn leaves changes to review;
 * - a Tab completion answers with `<dir>/completion.txt`, read at request time; without the
 *   file it answers nothing;
 * - `<dir>/runtime.json`, read at every runtime-state request, overrides `installed` and
 *   `authenticated`, so the setup card can be shown with Claude Code missing (issue 797).
 */
export function claudeFakeFixtures(base: ReadonlyMap<string, string>, isBuilt: boolean, userDataPath: string, env: NodeJS.ProcessEnv = process.env): ClaudeFakeFixtures {
	const dir = isBuilt ? undefined : env[CLAUDE_FAKE_FIXTURE_DIR_ENV];
	if (!dir) {
		return { fixtures: base };
	}
	return {
		fixtures: new ClaudeFixtureDirectory(base, dir),
		stepDelayMs: FIXTURE_DIR_STEP_DELAY_MS,
		models: readFixtureModels(join(dir, 'models.json')),
		fileWrites: new ClaudeFixtureFileWrites(userDataPath),
		inlineCompletion: () => readFixtureText(join(dir, 'completion.txt')),
		runtimeState: () => readFixtureRuntimeState(join(dir, 'runtime.json')),
	};
}

/** The `installed` and `authenticated` flags in `path`, or undefined when it is missing or holds neither. */
function readFixtureRuntimeState(path: string): Partial<ClaudeRuntimeState> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}
	const { installed, authenticated } = parsed as Partial<Record<keyof ClaudeRuntimeState, unknown>>;
	const state: Partial<ClaudeRuntimeState> = {
		...(typeof installed === 'boolean' ? { installed } : {}),
		...(typeof authenticated === 'boolean' ? { authenticated } : {}),
	};
	return Object.keys(state).length > 0 ? state : undefined;
}

/** The text in `path` without its final newline, or undefined when it is missing or empty. */
function readFixtureText(path: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return undefined;
	}
	text = text.replace(/\r?\n$/, '');
	return text.length > 0 ? text : undefined;
}

/** The models in `path`, or undefined when it is missing or holds no model. */
function readFixtureModels(path: string): ClaudeModelInfo[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return undefined;
	}
	const models = Array.isArray(parsed) ? parsed.filter((model): model is ClaudeModelInfo => !!model && typeof model.id === 'string' && typeof model.displayName === 'string') : [];
	return models.length > 0 ? models : undefined;
}

/** Writes a script's files and records them in the turn's checkpoint, as the runner does for a real write. */
class ClaudeFixtureFileWrites implements ClaudeFakeFileWrites {
	private readonly _checkpoints: ClaudeCheckpointStore;

	constructor(userDataPath: string) {
		this._checkpoints = new ClaudeCheckpointStore(userDataPath, new NodeCheckpointStorage(), { pid: process.pid });
	}

	async beforeWrite(turn: ClaudeFakeTurn, uri: string): Promise<void> {
		await this._checkpoints.snapshotApprovedWrite({ sessionId: turn.checkpointSessionId, turnId: turn.turnId, cwd: turn.cwd, absolutePath: fsPathFromCheckpointUri(uri) });
	}

	async afterWrite(turn: ClaudeFakeTurn, uri: string, after: string | null): Promise<void> {
		const path = fsPathFromCheckpointUri(uri);
		if (after === null) {
			await promises.rm(path, { force: true });
		} else {
			await promises.mkdir(dirname(path), { recursive: true });
			await promises.writeFile(path, after);
		}
		await this._checkpoints.noteAfterWrite(turn.checkpointSessionId, path);
	}
}

/** The built-in scripts, with the plain-send script read from a folder on every lookup. */
class ClaudeFixtureDirectory extends Map<string, string> {
	constructor(base: ReadonlyMap<string, string>, private readonly dir: string) {
		super(base);
	}

	override get(name: string): string | undefined {
		if (name === PLAIN_SEND_FIXTURE) {
			try {
				const next = readFileSync(join(this.dir, 'next.txt'), 'utf8').trim();
				return readFileSync(join(this.dir, `${next}.jsonl`), 'utf8');
			} catch {
				// Fall back to the built-in script.
			}
		}
		return super.get(name);
	}
}
