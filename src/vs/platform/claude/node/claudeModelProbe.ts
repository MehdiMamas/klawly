/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_AUTOCOMPLETE_DISALLOWED_TOOLS } from './claudeAutocompleteQuery.js';
import { ClaudeUsageWindow } from '../common/claudeAccount.js';
import { ClaudePromptMessage, ClaudeQuery, ClaudeQueryAgent, ClaudeQueryCommand, ClaudeQueryFactory, ClaudeQueryModel, ClaudeQueryOptions } from './claudeQuery.js';

/** How long the model list may take before the probe gives up. */
export const CLAUDE_MODEL_PROBE_TIMEOUT_MS = 30_000;

/**
 * Ids Claude Code is asked about besides its own lineup: every
 * `claude-<family>-<major>[-<minor>]` from 5.9 down to 4.0, newest first. This
 * is not a model list: Claude Code drops the ones it no longer runs, names the
 * ones it knows, and an id it does not know comes back named by itself, which
 * the probe leaves out.
 */
export const CLAUDE_OLDER_MODEL_CANDIDATES: readonly string[] = ['opus', 'sonnet', 'fable', 'haiku'].flatMap(family => [5, 4].flatMap(major => [
	...[9, 8, 7, 6, 5, 4, 3, 2, 1].map(minor => `claude-${family}-${major}-${minor}`),
	`claude-${family}-${major}`,
]));

/** What the probe found: Claude Code's own lineup, and the older models it still runs. */
export interface ClaudeModelListing {
	readonly lineup: readonly ClaudeQueryModel[];
	readonly older: readonly ClaudeQueryModel[];
}

export interface ClaudeModelProbe {
	readonly queryFactory: ClaudeQueryFactory;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly executablePath?: string;
	readonly timeoutMs?: number;
}

/**
 * Asks Claude Code for its models before any session runs. The query's prompt
 * never sends a message, so no turn runs and no transcript is written; the
 * listing only needs the query to be up. The query closes when the list
 * arrives, fails, or the timeout passes.
 */
export async function probeClaudeModels(probe: ClaudeModelProbe): Promise<ClaudeModelListing> {
	return splitClaudeModels(await askProbeQuery(probe, CLAUDE_OLDER_MODEL_CANDIDATES, query => query.supportedModels(), 'Claude Code did not list its models in time.'));
}

/**
 * Asks Claude Code for the plan limits while no session runs (issue 704), with
 * the same kind of query as the model probe: it runs no turn and closes once
 * the limits arrive. `undefined` when the sign-in has no plan limits or this
 * Claude Code cannot report them.
 */
export async function probeClaudeUsage(probe: ClaudeModelProbe): Promise<readonly ClaudeUsageWindow[] | undefined> {
	return askProbeQuery(probe, undefined, async query => query.usageLimits?.(), 'Claude Code did not report the plan limits in time.');
}

/**
 * Asks Claude Code for its slash commands and subagents while no session runs
 * (issue 968), so the `/` menu lists skills in a chat that has sent nothing. The
 * same kind of query as the model probe: it runs no turn and closes once both
 * lists arrive. A runtime that cannot list subagents offers none.
 */
export async function probeClaudeCommands(probe: ClaudeModelProbe): Promise<{ readonly commands: readonly ClaudeQueryCommand[]; readonly agents: readonly ClaudeQueryAgent[] }> {
	return askProbeQuery(probe, undefined, async query => {
		const [commands, agents] = await Promise.all([query.supportedCommands(), query.supportedAgents?.().catch(() => []) ?? []]);
		return { commands, agents };
	}, 'Claude Code did not list its commands in time.');
}

async function askProbeQuery<T>(probe: ClaudeModelProbe, modelPicker: readonly string[] | undefined, ask: (query: ClaudeQuery) => Promise<T>, timeoutMessage: string): Promise<T> {
	const abort = new AbortController();
	let query: ClaudeQuery | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		query = await probe.queryFactory({ prompt: silentPrompt(abort.signal), options: probeQueryOptions(probe, abort, modelPicker) });
		const answer = ask(query);
		const timedOut = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(timeoutMessage)), probe.timeoutMs ?? CLAUDE_MODEL_PROBE_TIMEOUT_MS);
		});
		return await Promise.race([answer, timedOut]);
	} finally {
		clearTimeout(timer);
		try {
			query?.close();
		} catch {
			// The query may already have closed itself.
		}
		abort.abort();
	}
}

function probeQueryOptions(probe: ClaudeModelProbe, abort: AbortController, modelPicker: readonly string[] | undefined): ClaudeQueryOptions {
	return {
		cwd: probe.cwd,
		allowedTools: [],
		disallowedTools: CLAUDE_AUTOCOMPLETE_DISALLOWED_TOOLS,
		maxTurns: 1,
		modelPicker,
		permissionMode: 'default',
		pathToClaudeCodeExecutable: probe.executablePath,
		env: probe.env,
		abortController: abort,
		canUseTool: async () => ({ behavior: 'deny', message: 'Asking Claude Code about itself cannot use tools.' }),
		screenTool: async () => ({ decision: 'deny', message: 'Asking Claude Code about itself cannot use tools.' }),
	};
}

/**
 * Splits the listing into Claude Code's lineup and the candidates it named. A
 * candidate the lineup already runs (`haiku` runs `claude-haiku-4-5-20251001`)
 * is left out.
 */
function splitClaudeModels(models: readonly ClaudeQueryModel[]): ClaudeModelListing {
	const candidates = new Set(CLAUDE_OLDER_MODEL_CANDIDATES);
	const lineup = models.filter(model => !candidates.has(model.id));
	const running = new Set(lineup.map(model => model.resolvedModel?.replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '')));
	const older = models.filter(model => candidates.has(model.id) && !!model.displayName && model.displayName !== model.id && !running.has(model.id));
	return { lineup, older };
}

/** A prompt that sends nothing and ends when the probe is done. */
async function* silentPrompt(signal: AbortSignal): AsyncGenerator<ClaudePromptMessage> {
	if (!signal.aborted) {
		await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
	}
}
